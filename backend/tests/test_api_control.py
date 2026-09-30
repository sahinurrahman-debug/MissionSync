"""The net-control endpoints, admin protection, WebSocket guards and structured logging."""
import json
import logging
import time

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from missionsync import main
from missionsync.orchestrator import Orchestrator


@pytest.fixture
def client(monkeypatch):
    monkeypatch.delenv("ADMIN_KEY", raising=False)
    fresh = Orchestrator(auto_dispatch=False)
    fresh.on_broadcast(main.hub.broadcast)
    main.orch = fresh
    main.report_limiter = main.RateLimiter()
    main.ops_limiter = main.RateLimiter(burst=30, refill_per_s=3)
    with TestClient(main.app) as c:
        deadline = time.time() + 20
        while c.get("/api/snapshot").json()["status"] != "live":
            assert time.time() < deadline
            time.sleep(0.05)
        yield c


def envelope(resp, status, code):
    assert resp.status_code == status, resp.text
    err = resp.json()["error"]
    assert err["code"] == code and err["request_id"].startswith("req_")
    return err


# -- human-commit actions ----------------------------------------------------------------

def test_the_snapshot_carries_proposals_settings_and_the_clock(client) -> None:
    snap = client.get("/api/snapshot").json()
    assert snap["settings"] == {"auto_dispatch": False, "dispatch_mode": "manual", "llm_available": False}
    assert len(snap["proposals"]) >= 5 and snap["elapsed_s"] >= 0
    p = snap["proposals"][0]
    assert {"id", "incident_id", "resource_id", "resource_name", "eta_minutes", "role", "source", "priority"} <= set(p)
    assert all(r["status"] == "available" for r in snap["resources"])
    assert client.get("/api/health").json()["auto_dispatch"] is False


def test_approve_all_then_a_single_stale_proposal(client) -> None:
    before = client.get("/api/snapshot").json()["proposals"]
    one = client.post("/api/dispatch/approve", json={"proposal_ids": [before[0]["id"]]}).json()
    assert sum(1 for r in one["snapshot"]["resources"] if r["assigned_incident"]) == 1
    everything = client.post("/api/dispatch/approve").json()
    assert {r["status"] for r in everything["snapshot"]["resources"]} & {"en_route"}
    envelope(client.post("/api/dispatch/approve", json={"proposal_ids": ["inc_x:res_x"]}), 404, "not_found")


def test_reject_and_validation(client) -> None:
    p = client.get("/api/snapshot").json()["proposals"][0]
    snap = client.post("/api/dispatch/reject", json={"proposal_id": p["id"]}).json()["snapshot"]
    assert p["id"] not in {x["id"] for x in snap["proposals"]}
    envelope(client.post("/api/dispatch/reject", json={"proposal_id": p["id"]}), 404, "not_found")
    envelope(client.post("/api/dispatch/reject", json={}), 400, "validation_error")


def test_manual_dispatch_recall_and_incident_status(client) -> None:
    snap = client.get("/api/snapshot").json()
    inc = snap["incidents"][0]
    unit = next(r for r in snap["resources"] if r["type"] == "drone")                 # drones serve anything
    ok = client.post("/api/dispatch/manual", json={"incident_id": inc["id"], "resource_id": unit["id"], "role": "recon"})
    assert ok.status_code == 200
    assert next(r for r in ok.json()["snapshot"]["resources"] if r["id"] == unit["id"])["status"] == "en_route"
    envelope(client.post("/api/dispatch/manual", json={"incident_id": inc["id"], "resource_id": unit["id"]}), 409, "conflict")
    envelope(client.post("/api/dispatch/manual", json={"incident_id": "inc_x", "resource_id": unit["id"]}), 404, "not_found")

    recalled = client.post(f"/api/units/{unit['id']}/recall").json()["snapshot"]
    assert next(r for r in recalled["resources"] if r["id"] == unit["id"])["status"] == "returning"
    envelope(client.post(f"/api/units/{unit['id']}/recall"), 409, "conflict")
    envelope(client.post("/api/units/res_ghost/recall"), 404, "not_found")

    done = client.patch(f"/api/incidents/{inc['id']}", json={"status": "contained"}).json()["snapshot"]
    assert inc["id"] not in {i["id"] for i in done["incidents"]} and done["metrics"]["recommendation_quality"]["resolved_incidents"] == 1
    envelope(client.patch(f"/api/incidents/{inc['id']}", json={"status": "contained"}), 409, "conflict")
    envelope(client.patch(f"/api/incidents/{inc['id']}", json={"status": "weird"}), 400, "validation_error")
    envelope(client.patch("/api/incidents/inc_ghost", json={"status": "closed"}), 404, "not_found")


def test_ops_are_rate_limited_with_a_retry_hint(client) -> None:
    codes = [client.post("/api/units/res_ghost/recall").status_code for _ in range(40)]
    assert 429 in codes
    limited = client.post("/api/units/res_ghost/recall")
    assert limited.status_code == 429 and int(limited.headers["Retry-After"]) >= 1


def test_ending_the_drill_freezes_it_and_reports_conflict(client) -> None:
    ended = client.post("/api/drill/end").json()["snapshot"]
    assert ended["status"] == "ended"
    envelope(client.post("/api/report", json={"text": "Fire at the University lab"}), 409, "conflict")
    envelope(client.post("/api/drill/end"), 409, "conflict")
    envelope(client.post("/api/dispatch/approve"), 409, "conflict")
    assert client.post("/api/reset").json()["snapshot"]["status"] == "live"


def test_settings_toggle_auto_dispatch(client) -> None:
    on = client.post("/api/settings", json={"auto_dispatch": True}).json()["snapshot"]
    assert on["settings"]["auto_dispatch"] is True and {r["status"] for r in on["resources"]} & {"en_route"}
    envelope(client.post("/api/settings", json={"auto_dispatch": "maybe"}), 400, "validation_error")


def test_report_nonce_makes_a_retry_idempotent(client) -> None:
    body = {"text": "Ammonia leak at Industrial Park depot, 4 workers hurt", "client_nonce": "n-1"}
    a = client.post("/api/report", json=body).json()
    b = client.post("/api/report", json=body).json()
    assert a["outcome"] == b["outcome"] and b["injections"] == 1
    assert "provisional" in a["outcome"]


# -- admin key --------------------------------------------------------------------------------

def test_destructive_actions_need_the_admin_key_when_one_is_configured(client, monkeypatch) -> None:
    monkeypatch.setenv("ADMIN_KEY", "s3cret")
    assert client.get("/api/health").json()["admin_protected"] is True
    for method, url, body in (("post", "/api/reset", None), ("post", "/api/drill/end", None),
                              ("post", "/api/settings", {"auto_dispatch": True})):
        kwargs = {"json": body} if body is not None else {}
        envelope(getattr(client, method)(url, **kwargs), 401, "unauthorized")
        envelope(getattr(client, method)(url, headers={"X-Admin-Key": "wrong"}, **kwargs), 401, "unauthorized")
    assert client.post("/api/settings", json={"auto_dispatch": True}, headers={"X-Admin-Key": "s3cret"}).status_code == 200
    assert client.post("/api/reset", headers={"X-Admin-Key": "s3cret"}).status_code == 200
    # everyday net-control actions and report intake stay open
    assert client.post("/api/dispatch/approve").status_code == 200
    assert client.post("/api/report", json={"text": "Fire at the University lab"}).status_code == 200


# -- WebSocket guards ------------------------------------------------------------------------------

def test_websocket_rejects_foreign_origins_and_allows_known_ones(client) -> None:
    with pytest.raises(WebSocketDisconnect) as e:
        with client.websocket_connect("/ws", headers={"origin": "https://evil.example"}):
            pass
    assert e.value.code == 4403
    with client.websocket_connect("/ws", headers={"origin": "http://localhost:5173"}) as ws:
        assert ws.receive_json()["type"] == "snapshot"
    with client.websocket_connect("/ws") as ws:                                     # non-browser clients send no Origin
        assert ws.receive_json()["type"] == "snapshot"


def test_websocket_connections_are_capped_and_viewers_are_counted(client, monkeypatch) -> None:
    with client.websocket_connect("/ws") as a:
        a.receive_json()
        assert client.get("/api/health").json()["viewers"] == 1
        with client.websocket_connect("/ws") as b:
            b.receive_json()
            health = client.get("/api/health").json()
            assert health["viewers"] == 2 and health["peak_viewers"] >= 2
        monkeypatch.setattr(main, "MAX_WS_CLIENTS", 1)
        with pytest.raises(WebSocketDisconnect) as e:
            with client.websocket_connect("/ws"):
                pass
        assert e.value.code == 1013
    assert client.get("/api/health").json()["viewers"] == 0


# -- structured logging --------------------------------------------------------------------------------

def test_json_log_lines_carry_the_request_id_and_request_fields() -> None:
    record = logging.LogRecord("missionsync", logging.INFO, __file__, 1, "request", (), None)
    record.method, record.path, record.status, record.ms = "POST", "/api/report", 200, 12
    token = main._request_id.set("req_deadbeef")
    try:
        line = json.loads(main.JsonFormatter().format(record))
    finally:
        main._request_id.reset(token)
    assert line["request_id"] == "req_deadbeef" and line["method"] == "POST" and line["status"] == 200
    assert line["level"] == "INFO" and line["ts"].endswith("Z")


def test_every_response_carries_a_request_id_header(client) -> None:
    resp = client.get("/api/snapshot")
    assert resp.headers["X-Request-ID"].startswith("req_")


def test_a_stuck_websocket_client_never_blocks_the_broadcast(monkeypatch) -> None:
    """A dashboard that stops reading must not stall the drill: broadcast returns at once and the
    stuck client is dropped after the send timeout while a healthy one keeps receiving."""
    import asyncio
    import time

    from missionsync import main
    from missionsync.models import WorldSnapshot

    class Stuck:
        async def send_text(self, _t: str) -> None:
            await asyncio.sleep(3600)

        async def close(self) -> None:
            pass

    class Healthy:
        def __init__(self) -> None:
            self.got: list[str] = []

        async def send_text(self, t: str) -> None:
            self.got.append(t)

        async def close(self) -> None:
            pass

    async def scenario() -> tuple[float, int, int]:
        hub = main.Hub()
        hub.SEND_TIMEOUT_S = 0.2
        stuck, ok = Stuck(), Healthy()
        for ws in (stuck, ok):
            sink = main._Sink(ws)                      # type: ignore[arg-type]
            sink.task = asyncio.create_task(hub._pump(sink))
            hub.clients[ws] = sink                     # type: ignore[index]
        snap = WorldSnapshot.model_validate(main.orch.snapshot().model_dump())
        t0 = time.perf_counter()
        for _ in range(5):
            await hub.broadcast(snap)
        took = time.perf_counter() - t0
        await asyncio.sleep(0.6)
        return took, len(hub.clients), len(ok.got)

    took, remaining, received = asyncio.run(scenario())
    assert took < 0.05                                 # the drill never waits on a viewer
    assert remaining == 1                              # the stuck one was dropped
    assert received == 5                               # the healthy one got every frame
