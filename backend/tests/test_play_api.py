"""Running a drill through the API: reports, the human-commit actions, ending and restarting."""
import time

import pytest

from .helpers import app_client, signed_in


@pytest.fixture
def play(tmp_path):
    """(client, base) — a signed-in user with one booted drill, base = '/api/drills/<id>'."""
    client, _ = app_client(tmp_path)
    with client:
        signed_in(client)
        drill = client.post("/api/drills", json={"name": "Campus drill"}).json()["drill"]
        base = f"/api/drills/{drill['id']}"
        deadline = time.time() + 20
        while client.get(f"{base}/snapshot").json()["status"] != "live":
            assert time.time() < deadline, "drill did not boot"
            time.sleep(0.05)
        yield client, base


def err(resp, status, code):
    assert resp.status_code == status, resp.text
    body = resp.json()
    assert isinstance(body["error"], str) and body["code"] == code and body["request_id"].startswith("req_")
    assert "Traceback" not in resp.text
    return body


def test_the_snapshot_carries_proposals_settings_and_the_clock(play) -> None:
    c, base = play
    snap = c.get(f"{base}/snapshot").json()
    assert snap["settings"]["auto_dispatch"] is False and snap["settings"]["dispatch_mode"] == "manual"
    assert len(snap["proposals"]) >= 5 and snap["elapsed_s"] >= 0
    p = snap["proposals"][0]
    assert {"id", "incident_id", "resource_id", "resource_name", "eta_minutes", "role", "source", "priority"} <= set(p)
    assert all(r["status"] == "available" for r in snap["resources"])


def test_report_creates_an_incident_and_a_retry_with_the_same_nonce_is_processed_once(play) -> None:
    c, base = play
    body = {"text": "Ammonia leak at Industrial Park depot, 4 workers hurt", "client_nonce": "n-1"}
    a = c.post(f"{base}/report", json=body)
    assert a.status_code == 200 and a.json()["outcome"]["kind"] in ("created", "merged")
    b = c.post(f"{base}/report", json=body).json()
    assert a.json()["outcome"] == b["outcome"] and b["injections"] == 1
    assert "provisional" in a.json()["outcome"]
    assert any("Ammonia" in i["description"] for i in b["snapshot"]["incidents"])


def test_report_validation_is_server_side(play) -> None:
    c, base = play
    err(c.post(f"{base}/report", json={}), 400, "validation_error")
    err(c.post(f"{base}/report", json={"text": ""}), 400, "validation_error")
    err(c.post(f"{base}/report", json={"text": "x" * 2001}), 400, "validation_error")
    err(c.post(f"{base}/report", json={"text": "fire", "confidence": 5}), 400, "validation_error")


def test_reports_are_rate_limited_with_a_retry_hint(play) -> None:
    c, base = play
    codes = [c.post(f"{base}/report", json={"text": f"Fire at the University lab {i}"}).status_code for i in range(8)]
    assert 429 in codes
    limited = c.post(f"{base}/report", json={"text": "Fire at the University lab again"})
    assert limited.status_code == 429 and int(limited.headers["Retry-After"]) >= 1
    assert limited.json()["code"] == "rate_limited"


def test_approve_all_then_a_single_stale_proposal(play) -> None:
    c, base = play
    before = c.get(f"{base}/snapshot").json()["proposals"]
    one = c.post(f"{base}/dispatch/approve", json={"proposal_ids": [before[0]["id"]]}).json()
    assert sum(1 for r in one["snapshot"]["resources"] if r["assigned_incident"]) == 1
    everything = c.post(f"{base}/dispatch/approve").json()
    assert {r["status"] for r in everything["snapshot"]["resources"]} & {"en_route"}
    err(c.post(f"{base}/dispatch/approve", json={"proposal_ids": ["inc_x:res_x"]}), 404, "not_found")


def test_reject_and_validation(play) -> None:
    c, base = play
    p = c.get(f"{base}/snapshot").json()["proposals"][0]
    snap = c.post(f"{base}/dispatch/reject", json={"proposal_id": p["id"]}).json()["snapshot"]
    assert p["id"] not in {x["id"] for x in snap["proposals"]}
    err(c.post(f"{base}/dispatch/reject", json={"proposal_id": p["id"]}), 404, "not_found")
    err(c.post(f"{base}/dispatch/reject", json={}), 400, "validation_error")


def test_manual_dispatch_recall_and_incident_status(play) -> None:
    c, base = play
    snap = c.get(f"{base}/snapshot").json()
    inc = snap["incidents"][0]
    unit = next(r for r in snap["resources"] if r["type"] == "drone")                 # drones serve anything
    ok = c.post(f"{base}/dispatch/manual", json={"incident_id": inc["id"], "resource_id": unit["id"], "role": "recon"})
    assert ok.status_code == 200
    assert next(r for r in ok.json()["snapshot"]["resources"] if r["id"] == unit["id"])["status"] == "en_route"
    err(c.post(f"{base}/dispatch/manual", json={"incident_id": inc["id"], "resource_id": unit["id"]}), 409, "conflict")
    err(c.post(f"{base}/dispatch/manual", json={"incident_id": "inc_x", "resource_id": unit["id"]}), 404, "not_found")

    recalled = c.post(f"{base}/units/{unit['id']}/recall").json()["snapshot"]
    assert next(r for r in recalled["resources"] if r["id"] == unit["id"])["status"] == "returning"
    err(c.post(f"{base}/units/{unit['id']}/recall"), 409, "conflict")
    err(c.post(f"{base}/units/res_ghost/recall"), 404, "not_found")

    done = c.patch(f"{base}/incidents/{inc['id']}", json={"status": "contained"}).json()["snapshot"]
    assert inc["id"] not in {i["id"] for i in done["incidents"]} and done["metrics"]["recommendation_quality"]["resolved_incidents"] == 1
    err(c.patch(f"{base}/incidents/{inc['id']}", json={"status": "contained"}), 409, "conflict")
    err(c.patch(f"{base}/incidents/{inc['id']}", json={"status": "weird"}), 400, "validation_error")
    err(c.patch(f"{base}/incidents/inc_ghost", json={"status": "closed"}), 404, "not_found")


def test_ending_the_drill_freezes_it_and_restarting_reopens_it(play) -> None:
    c, base = play
    ended = c.post(f"{base}/end").json()["snapshot"]
    assert ended["status"] == "ended"
    err(c.post(f"{base}/report", json={"text": "Fire at the University lab"}), 409, "conflict")
    err(c.post(f"{base}/end"), 409, "conflict")
    err(c.post(f"{base}/dispatch/approve"), 409, "conflict")
    assert c.post(f"{base}/reset").json()["snapshot"]["status"] == "live"


def test_settings_toggle_auto_dispatch(play) -> None:
    c, base = play
    on = c.post(f"{base}/settings", json={"auto_dispatch": True}).json()["snapshot"]
    assert on["settings"]["auto_dispatch"] is True and {r["status"] for r in on["resources"]} & {"en_route"}
    err(c.post(f"{base}/settings", json={"auto_dispatch": "maybe"}), 400, "validation_error")


def test_ops_are_rate_limited(play) -> None:
    c, base = play
    codes = [c.post(f"{base}/units/res_ghost/recall").status_code for _ in range(40)]
    assert 429 in codes


def test_audit_trail_and_csv_belong_to_the_drill(play) -> None:
    c, base = play
    c.post(f"{base}/report", json={"text": "=cmd|' /C calc'!A0 fire at the University chemistry lab"})
    audit = c.get(f"{base}/audit").json()
    assert audit["events"] and audit["reports"][0]["kind"] in ("created", "merged", "rejected")
    csv = c.get(f"{base}/export.csv")
    assert csv.status_code == 200 and csv.headers["content-type"].startswith("text/csv")
    assert "'=cmd" in csv.text and "\n=cmd" not in csv.text                               # formula injection neutralised
