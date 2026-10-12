"""Create, read, update and delete your own drills."""
import time

import pytest
from sqlalchemy import func, select

from missionsync.db.schema import audit_events, drills, reports
from .helpers import app_client, signed_in


@pytest.fixture
def api(tmp_path):
    client, svc = app_client(tmp_path)
    with client:
        signed_in(client)
        yield client, svc


def err(resp, status, code):
    assert resp.status_code == status, resp.text
    body = resp.json()
    assert isinstance(body["error"], str) and body["code"] == code
    return body


def test_create_then_list_and_read(api) -> None:
    c, _ = api
    assert c.get("/api/drills").json()["drills"] == []                                       # empty state for a new user
    r = c.post("/api/drills", json={"name": "  Campus   drill ", "notes": "Saturday exercise"})
    assert r.status_code == 201
    d = r.json()["drill"]
    assert d["name"] == "Campus drill" and d["notes"] == "Saturday exercise" and d["status"] == "new"
    assert c.get("/api/drills").json()["drills"][0]["id"] == d["id"]
    assert c.get(f"/api/drills/{d['id']}").json()["drill"]["name"] == "Campus drill"


@pytest.mark.parametrize("body", [{}, {"name": ""}, {"name": "   "}, {"name": "x" * 81}, {"name": "ok", "notes": "n" * 501}, {"name": 5}])
def test_create_validates_on_the_server(api, body) -> None:
    c, _ = api
    err(c.post("/api/drills", json=body), 400, "validation_error")
    assert c.get("/api/drills").json()["drills"] == []


def test_update_renames_and_edits_notes(api) -> None:
    c, _ = api
    d = c.post("/api/drills", json={"name": "A"}).json()["drill"]
    r = c.patch(f"/api/drills/{d['id']}", json={"name": "Renamed", "notes": "n"})
    assert r.status_code == 200 and r.json()["drill"]["name"] == "Renamed" and r.json()["drill"]["notes"] == "n"
    only_notes = c.patch(f"/api/drills/{d['id']}", json={"notes": "just notes"}).json()["drill"]
    assert only_notes["name"] == "Renamed" and only_notes["notes"] == "just notes"
    err(c.patch(f"/api/drills/{d['id']}", json={}), 400, "validation_error")
    err(c.patch(f"/api/drills/{d['id']}", json={"name": " "}), 400, "validation_error")
    err(c.patch("/api/drills/9999", json={"name": "x"}), 404, "not_found")


def test_delete_removes_the_drill_and_everything_in_it(api) -> None:
    c, svc = api
    d = c.post("/api/drills", json={"name": "Doomed"}).json()["drill"]
    base = f"/api/drills/{d['id']}"
    deadline = time.time() + 20
    while c.get(f"{base}/snapshot").json()["status"] != "live":
        assert time.time() < deadline
        time.sleep(0.05)
    c.post(f"{base}/report", json={"text": "Ammonia leak at Industrial Park depot, 4 workers hurt"})
    c.get(f"{base}/export.csv")                                                                # flushes the audit trail
    with svc.engine.connect() as conn:
        assert conn.execute(select(func.count()).select_from(audit_events)).scalar_one() > 0
        assert conn.execute(select(func.count()).select_from(reports)).scalar_one() == 1
    assert svc.manager.live_count == 1

    gone = c.delete(base)
    assert gone.status_code == 204 and gone.content == b""
    err(c.get(base), 404, "not_found")
    err(c.delete(base), 404, "not_found")                                                      # deleting twice is a clean 404
    assert c.get("/api/drills").json()["drills"] == []
    assert svc.manager.live_count == 0                                                         # its simulation was stopped
    with svc.engine.connect() as conn:
        for t in (audit_events, reports):
            assert conn.execute(select(func.count()).select_from(t)).scalar_one() == 0
        assert conn.execute(select(func.count()).select_from(drills)).scalar_one() == 0


def test_a_user_can_keep_only_so_many_drills(tmp_path) -> None:
    client, _ = app_client(tmp_path, max_drills_per_user=2)
    with client:
        signed_in(client)
        assert client.post("/api/drills", json={"name": "1"}).status_code == 201
        assert client.post("/api/drills", json={"name": "2"}).status_code == 201
        body = err(client.post("/api/drills", json={"name": "3"}), 409, "conflict")
        assert "up to 2" in body["error"]
        first = client.get("/api/drills").json()["drills"][0]["id"]
        client.delete(f"/api/drills/{first}")
        assert client.post("/api/drills", json={"name": "3"}).status_code == 201                # deleting makes room


def test_opening_a_drill_boots_it_and_it_survives_being_unloaded(api) -> None:
    c, svc = api
    d = c.post("/api/drills", json={"name": "Persistent"}).json()["drill"]
    base = f"/api/drills/{d['id']}"
    deadline = time.time() + 20
    while c.get(f"{base}/snapshot").json()["status"] != "live":
        assert time.time() < deadline
        time.sleep(0.05)
    c.post(f"{base}/report", json={"text": "Ammonia leak at Industrial Park depot, 4 workers hurt"})
    before = c.get(f"{base}/snapshot").json()
    # Simulate a server restart: a brand-new app on the same database finds the same drill and state.
    from missionsync.main import create_app
    from fastapi.testclient import TestClient
    from missionsync.services import build_services
    from .helpers import settings
    c2 = TestClient(create_app(build_services(settings(database_url=str(svc.engine.url)), svc.engine)))
    with c2:
        c2.cookies.set("ms_session", c.cookies.get("ms_session"))                                # the same browser session
        deadline = time.time() + 20
        while True:
            after = c2.get(f"{base}/snapshot").json()
            if after["status"] == "live" and after["incidents"]:
                break
            assert time.time() < deadline
            time.sleep(0.05)
        assert {i["id"] for i in after["incidents"]} == {i["id"] for i in before["incidents"]}
