"""The audit fixes: proxy headers, ids, text hygiene, sockets that follow their session, limits that hold."""
from __future__ import annotations

import asyncio
import time

import pytest

from missionsync.routers import live
from missionsync.textutil import clean_line, strip_controls

from .helpers import PASSWORD, app_client, make_services, make_store, signed_in


# -- who is calling -----------------------------------------------------------------------------

def test_a_forged_forwarded_for_header_cannot_dodge_the_rate_limit(tmp_path) -> None:
    client, _ = app_client(tmp_path, trusted_proxy_hops=1)
    with client:
        codes = []
        for i in range(8):                                               # each attempt claims to come from a different address
            r = client.post("/api/auth/signup", json={"email": f"x{i}@example.com", "password": PASSWORD, "display_name": "X"},
                            headers={"X-Forwarded-For": f"6.6.6.{i}, 203.0.113.9"})
            codes.append(r.status_code)
            client.cookies.clear()
    assert 429 in codes                                                  # the proxy-added (rightmost) address is what counts


def test_without_a_trusted_proxy_the_header_is_ignored(tmp_path) -> None:
    client, _ = app_client(tmp_path)                                     # trusted_proxy_hops=0
    with client:
        for i in range(8):
            client.post("/api/auth/signup", json={"email": f"y{i}@example.com", "password": PASSWORD, "display_name": "Y"},
                        headers={"X-Forwarded-For": f"9.9.9.{i}"})
            client.cookies.clear()
        assert client.post("/api/auth/signup", json={"email": "z@example.com", "password": PASSWORD, "display_name": "Z"},
                           headers={"X-Forwarded-For": "1.2.3.4"}).status_code == 429


# -- ids and text -------------------------------------------------------------------------------

def test_an_impossible_drill_id_is_a_404_not_a_server_error(tmp_path) -> None:
    client, _ = app_client(tmp_path)
    with client:
        signed_in(client)
        for bad in ("99999999999999999999", "2147483648", "0", "-5"):
            r = client.get(f"/api/drills/{bad}")
            assert r.status_code == 404 and r.json()["code"] == "not_found", bad
        with pytest.raises(Exception):
            with client.websocket_connect("/ws/drills/99999999999999999999") as ws:
                ws.receive_json()


def test_control_and_direction_characters_never_reach_the_database(tmp_path) -> None:
    assert strip_controls("a\x00b‮c​d\te\n") == "abcd\te\n"
    assert clean_line("  Ann\x00  ‮Lee ") == "Ann Lee"
    client, _ = app_client(tmp_path)
    with client:
        signed_in(client)
        d = client.post("/api/drills", json={"name": "Dril\x00l ‮one", "notes": "line1\nli\x00ne2"}).json()["drill"]
        assert d["name"] == "Drill one" and d["notes"] == "line1\nline2"
        assert client.post("/api/drills", json={"name": "\x00‮"}).status_code == 400          # nothing left after cleaning
        assert client.post("/api/auth/signup", json={"email": "a\x00@example.com", "password": PASSWORD, "display_name": "A"}).status_code == 400


def test_an_audit_line_the_database_refuses_does_not_block_the_rest(tmp_path) -> None:
    from sqlalchemy.exc import DataError

    store, drill_id, svc = make_store(tmp_path)
    real_insert = store._engine.begin
    seen = {"batch_refused": False}

    class Refusing:
        """Wraps a connection: refuses any multi-row insert and any row whose message is 'poison'."""
        def __init__(self, ctx):
            self.ctx = ctx

        def __enter__(self):
            conn = self.ctx.__enter__()
            original = conn.execute

            def execute(stmt, params=None, *a, **k):
                rows = params if isinstance(params, list) else []
                if len(rows) > 1 or any(r.get("msg") == "poison" for r in rows):
                    seen["batch_refused"] = True
                    raise DataError("insert", {}, Exception("refused"))
                return original(stmt, params, *a, **k) if params is not None else original(stmt)

            conn.execute = execute
            return conn

        def __exit__(self, *a):
            return self.ctx.__exit__(*a)

    store._engine.begin = lambda: Refusing(real_insert())
    ok = store.add_events(drill_id, [(1, "00:00:01", "fine"), (2, "00:00:02", "poison"), (3, "00:00:03", "also fine")])
    store._engine.begin = real_insert
    assert ok is True and seen["batch_refused"]
    assert [e["msg"] for e in svc.drills.events(drill_id)] == ["fine", "also fine"]


# -- sessions -----------------------------------------------------------------------------------

def test_a_socket_is_closed_when_its_session_is_signed_out(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(live, "RECHECK_S", 0.2)
    client, _ = app_client(tmp_path)
    with client:
        signed_in(client)
        drill = client.post("/api/drills", json={"name": "x"}).json()["drill"]
        with client.websocket_connect(f"/ws/drills/{drill['id']}") as ws:
            assert ws.receive_json()["type"] == "snapshot"
            client.post("/api/auth/logout")
            closed = None
            for _ in range(60):
                try:
                    ws.receive_json()
                except Exception as e:                                   # the server closed it: 4401
                    closed = e
                    break
            assert closed is not None and getattr(closed, "code", None) == 4401


def test_logout_all_ends_every_session_and_the_oldest_is_dropped_past_the_cap(tmp_path) -> None:
    client, _ = app_client(tmp_path, max_sessions_per_user=3)
    with client:
        signed_in(client)
        tokens = []
        for _ in range(4):
            client.cookies.clear()
            r = client.post("/api/auth/login", json={"email": "ann@example.com", "password": PASSWORD})
            tokens.append(r.cookies.get("ms_session"))
        alive = []
        for t in tokens:
            client.cookies.clear()
            client.cookies.set("ms_session", t)
            alive.append(client.get("/api/auth/me").status_code == 200)
        assert alive.count(True) == 3                                    # the sign-up session and the first login were pushed out
        client.cookies.clear()
        client.cookies.set("ms_session", tokens[-1])
        assert client.post("/api/auth/logout-all").status_code == 204
        for t in tokens:
            client.cookies.clear()
            client.cookies.set("ms_session", t)
            assert client.get("/api/auth/me").status_code == 401


def test_deleting_an_account_needs_the_password_and_removes_everything(tmp_path) -> None:
    client, svc = app_client(tmp_path)
    with client:
        signed_in(client)
        client.post("/api/drills", json={"name": "mine"})
        assert client.request("DELETE", "/api/auth/me", json={"password": "wrong password 1"}).status_code == 401
        assert client.get("/api/auth/me").status_code == 200
        assert client.request("DELETE", "/api/auth/me", json={"password": PASSWORD}).status_code == 204
        assert client.get("/api/auth/me").status_code == 401
        assert svc.users.by_email("ann@example.com") is None
        with svc.engine.connect() as conn:
            assert conn.exec_driver_sql("SELECT count(*) FROM drills").scalar() == 0


def test_a_stranger_cannot_lock_you_out_of_your_own_sign_in(tmp_path) -> None:
    client, _ = app_client(tmp_path, trusted_proxy_hops=1)
    with client:
        signed_in(client)
        client.cookies.clear()
        for _ in range(12):                                              # someone else hammers your email from their address
            client.post("/api/auth/login", json={"email": "ann@example.com", "password": "nope nope 1"},
                        headers={"X-Forwarded-For": "7.7.7.7"})
        client.cookies.clear()
        mine = client.post("/api/auth/login", json={"email": "ann@example.com", "password": PASSWORD},
                           headers={"X-Forwarded-For": "8.8.8.8"})
        assert mine.status_code == 200


# -- the demo -----------------------------------------------------------------------------------

def test_demo_and_sign_up_have_separate_allowances(tmp_path) -> None:
    client, _ = app_client(tmp_path)
    with client:
        statuses = []
        for _ in range(5):
            statuses.append(client.post("/api/auth/demo").status_code)
            client.cookies.clear()
        assert statuses[:3] == [201, 201, 201] and statuses[3] == 429
        assert client.post("/api/auth/signup", json={"email": "real@example.com", "password": PASSWORD, "display_name": "Real"}).status_code == 201


def test_expired_guests_free_their_places_when_the_demo_is_full(tmp_path) -> None:
    from datetime import datetime, timedelta, timezone

    from sqlalchemy import update

    from missionsync.db.schema import users

    client, svc = app_client(tmp_path, max_guests=1)
    with client:
        assert client.post("/api/auth/demo").status_code == 201
        client.cookies.clear()
        assert client.post("/api/auth/demo").status_code == 503          # full
        with svc.engine.begin() as c:
            c.execute(update(users).values(created_at=datetime.now(timezone.utc) - timedelta(hours=30)))
        client.cookies.clear()
        assert client.post("/api/auth/demo").status_code == 201          # the old guest was cleared out first


# -- requests and responses ---------------------------------------------------------------------

def test_oversized_bodies_are_refused_and_every_refusal_still_has_the_security_headers(tmp_path) -> None:
    client, _ = app_client(tmp_path, max_body_bytes=2000)
    with client:
        r = client.post("/api/auth/login", content=b"{" + b" " * 5000 + b"}", headers={"Content-Type": "application/json"})
        assert r.status_code == 413 and r.json()["code"] == "too_large"
        assert r.headers["x-content-type-options"] == "nosniff"
        foreign = client.post("/api/auth/login", json={"email": "a@b.co", "password": "x"}, headers={"Origin": "https://evil.example"})
        assert foreign.status_code == 403 and foreign.headers["x-frame-options"] == "DENY" and "content-security-policy" in foreign.headers


def test_the_policy_names_this_host_for_sockets_and_only_openstreetmap_for_tiles(tmp_path) -> None:
    client, _ = app_client(tmp_path)
    with client:
        csp = client.get("/api/health", headers={"Host": "drills.example.com"}).headers["content-security-policy"]
        assert "wss://drills.example.com" in csp and "https://*.tile.openstreetmap.org" in csp
        assert "ws:;" not in csp and "img-src 'self' data: https:;" not in csp
        evil = client.get("/api/health", headers={"Host": "x; script-src *"}).headers["content-security-policy"]
        assert "script-src" not in evil


def test_health_reports_a_broken_database_with_a_503(tmp_path, monkeypatch) -> None:
    from missionsync.routers import system

    client, svc = app_client(tmp_path)
    with client:
        assert client.get("/api/health").status_code == 200
        monkeypatch.setattr(type(svc.engine), "connect", lambda self, *a, **k: (_ for _ in ()).throw(RuntimeError("down")))
        r = client.get("/api/health")
    assert system and r.status_code == 503 and r.json()["status"] == "degraded"


def test_a_missing_script_is_a_404_but_app_routes_still_get_the_app(tmp_path, monkeypatch) -> None:
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<!doctype html><title>MissionSync</title>")
    monkeypatch.setenv("STATIC_DIR", str(dist))
    client, _ = app_client(tmp_path)
    with client:
        assert client.get("/assets/old-hash.js").status_code == 404
        assert client.get("/drills/3").status_code == 200


# -- the drills themselves ----------------------------------------------------------------------

def test_the_live_drill_limit_holds_even_when_everyone_opens_at_once(tmp_path) -> None:
    svc = make_services(tmp_path, max_live_drills=2)
    user = svc.users.create("a@b.co", "A", "x")
    ids = [svc.drills.create(user.id, f"d{i}").id for i in range(6)]

    async def go():
        svc.manager.start()
        results = await asyncio.gather(*(svc.manager.get(i) for i in ids), return_exceptions=True)
        count = svc.manager.live_count
        await svc.manager.shutdown()
        return count, results

    count, results = asyncio.run(go())
    assert count <= 2
    assert any(isinstance(r, Exception) for r in results)               # the rest were told to try again, not squeezed in


def test_a_drill_nobody_watches_stands_still(tmp_path) -> None:
    svc = make_services(tmp_path)
    user = svc.users.create("a@b.co", "A", "x")
    drill = svc.drills.create(user.id, "quiet")

    async def go():
        rt = await svc.manager.get(drill.id)
        await asyncio.sleep(0.3)                                         # let it boot
        orch = rt.orch
        assert orch.pause_when_unwatched is True and orch.viewers == 0
        before = orch.tick
        rt.task.cancel()
        task = asyncio.create_task(orch.run_forever(interval_s=0.05))
        await asyncio.sleep(0.4)
        after = orch.tick
        task.cancel()
        await svc.manager.shutdown()
        return before, after

    before, after = asyncio.run(go())
    assert after == before


def test_the_drill_clock_survives_an_unload(tmp_path) -> None:
    from missionsync.orchestrator import Orchestrator

    store, drill_id, _ = make_store(tmp_path)
    a = Orchestrator(store, drill_id=drill_id)
    a.started_at = time.time() - 120
    state = a.export_state()
    b = Orchestrator(store, drill_id=drill_id)
    state["saved_at"] = time.time() - 86400
    state["started_at"] = time.time() - 86400 - 120                      # the old wall-clock value would read a whole day
    b.import_state(state)
    assert 115 <= b.elapsed_s() <= 130                                   # two minutes of drilling, not a day


def test_a_finished_drill_does_not_take_a_dispatch_mode_change(tmp_path) -> None:
    client, _ = app_client(tmp_path)
    with client:
        signed_in(client)
        d = client.post("/api/drills", json={"name": "x"}).json()["drill"]
        for _ in range(100):                                             # wait for the drill to finish booting
            if client.get(f"/api/drills/{d['id']}/snapshot").json()["status"] == "live":
                break
            time.sleep(0.1)
        assert client.post(f"/api/drills/{d['id']}/end").status_code == 200
        assert client.post(f"/api/drills/{d['id']}/settings", json={"auto_dispatch": True}).status_code == 409


def test_the_drill_list_counts_with_two_queries_not_two_per_drill(tmp_path) -> None:
    from sqlalchemy import event

    client, svc = app_client(tmp_path)
    with client:
        signed_in(client)
        for i in range(4):
            client.post("/api/drills", json={"name": f"d{i}"})
        statements: list[str] = []
        event.listen(svc.engine, "before_cursor_execute", lambda c, cur, stmt, *a: statements.append(stmt))
        listing = client.get("/api/drills").json()["drills"]
        assert len(listing) == 4 and all({"events", "reports"} <= set(d) for d in listing)
        assert len([s for s in statements if s.lstrip().upper().startswith("SELECT")]) <= 5    # session, drills, two counts (+1 spare)
