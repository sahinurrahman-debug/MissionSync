import time

import pytest
from fastapi.testclient import TestClient

from missionsync import main
from missionsync.orchestrator import Orchestrator


@pytest.fixture
def client():
    fresh = Orchestrator()
    fresh.on_broadcast(main.hub.broadcast)
    main.orch = fresh
    main.report_limiter = main.RateLimiter()
    with TestClient(main.app) as c:
        deadline = time.time() + 20
        while c.get("/api/snapshot").json()["status"] != "live":
            assert time.time() < deadline, "scenario never finished booting"
            time.sleep(0.05)
        yield c


def assert_envelope(resp, status, code):
    assert resp.status_code == status
    err = resp.json()["error"]
    assert err["code"] == code and err["message"] and isinstance(err["details"], list)
    assert err["request_id"].startswith("req_") and resp.headers["X-Request-ID"] == err["request_id"]
    return err


def test_health(client) -> None:
    body = client.get("/api/health").json()
    assert body["status"] == "ok" and body["state"] == "live" and body["mode"] == "fallback"
    assert body["dataset"] == "xbd_snapshot" and body["incidents"] == 5 and body["llm_configured"] is False
    assert set(body["agents"]) == {"surveillance", "terrain", "risk", "logistics", "command"}
    assert client.get("/api/health").headers["X-Request-ID"]


def test_snapshot_contract(client) -> None:
    snap = client.get("/api/snapshot").json()
    assert snap["status"] == "live" and len(snap["incidents"]) == 5 and len(snap["resources"]) == 12
    assert {"stage", "origin"} <= set(snap["pipeline"]) and snap["event_log"][0].keys() == {"seq", "t", "msg"}
    inc = snap["incidents"][0]
    assert inc["risk"]["tier"] in ("P1", "P2", "P3", "P4") and inc["type"] in ("flood", "fire", "landslide", "structural_collapse")
    assert snap["metrics"]["ranking_accuracy"]["evaluated_incidents"] == 5


def test_report_creates_then_merges_and_returns_the_outcome(client) -> None:
    r = client.post("/api/report", json={"text": "Ammonia leak at Industrial Park depot, 4 workers hurt"}).json()
    assert r["status"] == "processed" and r["outcome"]["kind"] == "created" and r["injections"] == 1
    assert r["outcome"]["tier"] and r["snapshot"]["metrics"]["recommendation_quality"]["injections_processed"] == 1
    again = client.post("/api/report", json={"text": "Industrial Park ammonia leak spreading, 6 workers hurt"}).json()
    assert again["outcome"]["kind"] == "merged" and again["outcome"]["incident_id"] == r["outcome"]["incident_id"]
    rejected = client.post("/api/report", json={"text": "hello there"}).json()
    assert rejected["outcome"]["kind"] == "rejected"


@pytest.mark.parametrize("payload,field", [
    ({"text": ""}, "text"),
    ({"text": "   "}, "text"),
    ({"text": "x" * 2001}, "text"),
    ({"text": "fire", "lat": 123}, "lat"),
    ({"text": "fire", "confidence": 2}, "confidence"),
    ({"text": "fire", "source": "carrier pigeon"}, "source"),
    ({}, "text"),
])
def test_invalid_reports_use_the_standard_error_envelope(client, payload, field) -> None:
    err = assert_envelope(client.post("/api/report", json=payload), 400, "validation_error")
    assert any(d["field"] == field for d in err["details"])


def test_a_report_flood_is_rate_limited_with_a_retry_hint(client) -> None:
    codes = [client.post("/api/report", json={"text": "hello there"}).status_code for _ in range(7)]
    assert codes[:5] == [200] * 5 and 429 in codes[5:]
    limited = client.post("/api/report", json={"text": "hello there"})
    err = assert_envelope(limited, 429, "rate_limited")
    assert int(limited.headers["Retry-After"]) >= 1 and err["details"][0]["field"] == "retry_after_seconds"


def test_unknown_routes_and_wrong_methods_are_enveloped_too(client) -> None:
    assert_envelope(client.get("/api/nope"), 404, "not_found")
    assert_envelope(client.get("/api/report"), 405, "method_not_allowed")


def test_unhandled_errors_never_leak_internals(client, monkeypatch) -> None:
    async def boom(_report):
        raise RuntimeError("secret internal detail")

    monkeypatch.setattr(main.orch, "inject_report", boom)
    quiet = TestClient(main.app, raise_server_exceptions=False)
    err = assert_envelope(quiet.post("/api/report", json={"text": "fire at downtown"}), 500, "internal_error")
    assert "secret" not in err["message"]


def test_reset_and_audit(client) -> None:
    client.post("/api/report", json={"text": "Fire in the University chemistry lab, 5 people hurt"})
    audit = client.get("/api/audit").json()
    assert audit["count"] == len(audit["events"]) > 5 and any("INJECTED" in e["msg"] for e in audit["events"])
    reset = client.post("/api/reset").json()
    assert reset["status"] == "reset" and len(reset["snapshot"]["incidents"]) == 5
    assert not any("INJECTED" in e["msg"] for e in client.get("/api/audit").json()["events"])


def test_websocket_pushes_snapshots_and_answers_pings(client) -> None:
    with client.websocket_connect("/ws") as ws:
        first = ws.receive_json()
        assert first["type"] == "snapshot" and first["data"]["status"] == "live"
        ws.send_text("ping")
        assert ws.receive_json() == {"type": "pong"}
        client.post("/api/report", json={"text": "Fire in the University chemistry lab, 5 people hurt"})
        seen_stages, injected = set(), False
        for _ in range(30):                       # stage-by-stage pushes, ending in the finished picture
            msg = ws.receive_json()
            seen_stages.add(msg["data"]["pipeline"]["stage"])
            if msg["data"]["pipeline"]["stage"] == "idle" and msg["data"]["metrics"]["recommendation_quality"]["injections_processed"] == 1:
                injected = True
                break
        assert injected and {"surveillance", "terrain", "risk", "logistics", "command"} <= seen_stages


def test_cors_allows_the_dev_frontend_only(client) -> None:
    ok = client.options("/api/report", headers={"Origin": "http://localhost:5173", "Access-Control-Request-Method": "POST"})
    assert ok.headers.get("access-control-allow-origin") == "http://localhost:5173"
    bad = client.options("/api/report", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"})
    assert "access-control-allow-origin" not in bad.headers
