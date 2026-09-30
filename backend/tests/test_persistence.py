import asyncio
import time

import pytest
from fastapi.testclient import TestClient

from missionsync import main
from missionsync.models import IncomingReport
from missionsync.orchestrator import Orchestrator
from missionsync.persistence import Store, csv_safe, normalize_url


@pytest.fixture
def store(tmp_path):
    s = Store(f"sqlite:///{tmp_path / 'ms.db'}")
    assert s.enabled and s.backend == "sqlite"
    return s


def test_render_style_urls_are_normalised_for_psycopg3() -> None:
    assert normalize_url("postgres://u:p@h/db") == "postgresql+psycopg://u:p@h/db"
    assert normalize_url("postgresql://u:p@h/db") == "postgresql+psycopg://u:p@h/db"
    assert normalize_url("sqlite:///x.db") == "sqlite:///x.db"


def test_without_a_url_everything_is_a_harmless_no_op() -> None:
    s = Store(None)
    assert not s.enabled and s.status() == "disabled"
    assert s.start_drill("x") is None and s.list_drills() == [] and s.drill_events(1) == []
    assert s.add_events(1, [(1, "t", "m")]) is False and s.add_report(1, "t", "radio", "created") is False


def test_a_bad_database_disables_persistence_instead_of_crashing() -> None:
    s = Store("postgresql://nobody:x@127.0.0.1:1/none")          # nothing listens on port 1
    assert not s.enabled and s.status() == "error" and s.error


def test_round_trip(store) -> None:
    drill = store.start_drill("kaggle")
    store.add_events(drill, [(1, "09:00:00Z", "first"), (2, "09:00:01Z", "second")])
    store.add_report(drill, "fire at downtown", "radio", "created", "Fire at downtown", "P2", 61.5)
    assert store.drill_exists(drill) and not store.drill_exists(999)
    assert [e["msg"] for e in store.drill_events(drill)] == ["first", "second"]
    assert store.drill_reports(drill)[0]["urgency"] == 61.5
    (row,) = store.list_drills()
    assert row["id"] == drill and row["events"] == 2 and row["reports"] == 1 and row["dataset"] == "kaggle"


def test_csv_export_neutralises_spreadsheet_formulas(store) -> None:
    drill = store.start_drill("x")
    store.add_report(drill, '=HYPERLINK("http://evil.example","click")', "radio", "rejected")
    store.add_events(drill, [(1, "t", "+cmd|' /C calc'!A0")])
    csv_text = store.export_csv(drill)
    assert "# submitted reports" in csv_text and "# audit trail" in csv_text
    assert "\n=HYPERLINK" not in csv_text and "'=HYPERLINK" in csv_text and "'+cmd" in csv_text
    assert csv_safe("=1+1") == "'=1+1" and csv_safe("plain") == "plain" and csv_safe(5) == 5


def test_a_failing_database_never_breaks_a_drill(store, monkeypatch) -> None:
    def boom(*a, **k):
        raise RuntimeError("db down")

    monkeypatch.setattr(store._engine, "begin", boom)
    monkeypatch.setattr(store._engine, "connect", boom)

    async def go():
        o = Orchestrator(store)
        await o.bootstrap()
        outcome, snap = await o.inject_report(IncomingReport(text="Fire in the University chemistry lab, 5 people hurt"))
        assert outcome.kind == "created" and len(snap.incidents) >= 5
    asyncio.run(go())


def test_the_orchestrator_records_the_drill_reports_and_audit_trail(store) -> None:
    async def go():
        o = Orchestrator(store)
        await o.bootstrap()
        first = o.drill_id
        assert first is not None
        await o.inject_report(IncomingReport(text="Fire in the University chemistry lab, 5 people hurt"))
        await o.inject_report(IncomingReport(text="asdf qwerty nothing"))
        async with o._lock:
            await o._tick_once()
        events = store.drill_events(first)
        assert any("Scenario loaded" in e["msg"] for e in events) and any("INJECTED REPORT #1" in e["msg"] for e in events)
        assert [e["seq"] for e in events] == sorted(e["seq"] for e in events)
        assert [r["kind"] for r in store.drill_reports(first)] == ["created", "rejected"]
        assert o.snapshot().metrics["database"] == "sqlite" and o.snapshot().metrics["drill_id"] == first

        await o.reset()                                    # a restart is a NEW drill; the old one is kept
        assert o.drill_id != first
        assert {d["id"] for d in store.list_drills()} == {first, o.drill_id}
        assert store.drill_reports(first) and not store.drill_reports(o.drill_id)
    asyncio.run(go())


@pytest.fixture
def db_client(tmp_path):
    fresh = Orchestrator(Store(f"sqlite:///{tmp_path / 'api.db'}"))
    fresh.on_broadcast(main.hub.broadcast)
    main.orch = fresh
    main.report_limiter = main.RateLimiter()
    with TestClient(main.app) as c:
        deadline = time.time() + 20
        while c.get("/api/snapshot").json()["status"] != "live":
            assert time.time() < deadline
            time.sleep(0.05)
        yield c


def test_history_and_export_endpoints(db_client) -> None:
    health = db_client.get("/api/health").json()
    assert health["database"] == "sqlite" and health["drill_id"] == 1
    db_client.post("/api/report", json={"text": "Fire in the University chemistry lab, 5 people hurt"})

    drills = db_client.get("/api/drills").json()
    assert drills["database"] == "sqlite" and drills["current"] == 1 and drills["drills"][0]["reports"] == 1

    audit = db_client.get("/api/drills/1/audit").json()
    assert audit["reports"][0]["kind"] == "created" and any("INJECTED" in e["msg"] for e in audit["events"])

    export = db_client.get("/api/drills/1/export.csv")
    assert export.status_code == 200 and export.headers["content-type"].startswith("text/csv")
    assert 'filename="missionsync-drill-1.csv"' in export.headers["content-disposition"]
    assert "Fire in the University chemistry lab" in export.text

    err = db_client.get("/api/drills/999/audit")
    assert err.status_code == 404 and err.json()["error"]["code"] == "not_found"
    assert db_client.get("/api/drills/abc/audit").status_code == 400


def test_history_routes_say_so_when_there_is_no_database() -> None:
    fresh = Orchestrator()
    fresh.on_broadcast(main.hub.broadcast)
    main.orch = fresh
    with TestClient(main.app) as c:
        assert c.get("/api/drills").json() == {"database": "disabled", "current": None, "drills": []}
        err = c.get("/api/drills/1/audit")
        assert err.status_code == 404 and "DATABASE_URL" in err.json()["error"]["message"]
        assert c.get("/api/health").json()["database"] == "disabled"
