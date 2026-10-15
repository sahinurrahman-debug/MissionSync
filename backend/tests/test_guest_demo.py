"""The one-click demo: a temporary guest account that owns its own drill (real scenario, real agents) and cleans up after itself."""
import asyncio
import time
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import func, select, update

from missionsync.db.schema import drills, sessions, users
from missionsync.services import housekeeping
from .helpers import Who, app_client, signed_in


def wait_live(who, drill_id):
    deadline = time.time() + 20
    while who.get(f"/api/drills/{drill_id}/snapshot").json()["status"] != "live":
        assert time.time() < deadline, "the demo drill did not boot"
        time.sleep(0.05)


@pytest.fixture
def api(tmp_path):
    client, svc = app_client(tmp_path)
    with client:
        yield client, svc


def test_one_click_creates_a_guest_with_a_ready_drill_and_signs_it_in(api) -> None:
    c, svc = api
    r = c.post("/api/auth/demo")
    assert r.status_code == 201
    body = r.json()
    assert body["user"]["is_guest"] is True and body["user"]["email"].endswith("@guest.missionsync.invalid")
    assert body["drill"]["name"] == "Demo drill" and "deleted after 24 hours" in body["drill"]["notes"]
    cookie = r.headers["set-cookie"].lower()
    assert "httponly" in cookie and "samesite=lax" in cookie and f"max-age={24 * 3600}" in cookie
    assert c.get("/api/auth/session").json()["user"]["is_guest"] is True            # signed in straight away
    assert [d["id"] for d in c.get("/api/drills").json()["drills"]] == [body["drill"]["id"]]


def test_the_demo_drill_is_the_real_thing_not_a_stub(api) -> None:
    c, _ = api
    drill_id = c.post("/api/auth/demo").json()["drill"]["id"]
    who = Who(c, c.cookies.get("ms_session"))
    wait_live(who, drill_id)
    snap = who.get(f"/api/drills/{drill_id}/snapshot").json()
    assert len(snap["incidents"]) >= 5 and len(snap["proposals"]) >= 5            # xBD-seeded incidents, proposals waiting for approval
    assert snap["settings"]["auto_dispatch"] is False
    approved = who.post(f"/api/drills/{drill_id}/dispatch/approve").json()["snapshot"]
    assert {r["status"] for r in approved["resources"]} & {"en_route"}              # the full approve flow works for a guest


def test_a_guest_account_cannot_be_signed_in_to_again(api) -> None:
    c, _ = api
    email = c.post("/api/auth/demo").json()["user"]["email"]
    c.post("/api/auth/logout")
    for guess in ("password", "guest", "correct horse 9", ""):
        r = c.post("/api/auth/login", json={"email": email, "password": guess or "x"})
        assert r.status_code == 401


def test_two_guests_never_see_each_others_drills(api) -> None:
    c, _ = api
    a = c.post("/api/auth/demo").json()["drill"]["id"]
    who_a = Who(c, c.cookies.get("ms_session"))
    c.cookies.clear()
    b = c.post("/api/auth/demo").json()["drill"]["id"]
    who_b = Who(c, c.cookies.get("ms_session"))
    assert a != b
    assert who_b.get(f"/api/drills/{a}").status_code == 404 and who_a.get(f"/api/drills/{b}").status_code == 404
    assert [d["id"] for d in who_a.get("/api/drills").json()["drills"]] == [a]


def test_a_guest_keeps_fewer_drills(api) -> None:
    c, _ = api
    c.post("/api/auth/demo")                                                         # already owns the "Demo drill"
    assert c.post("/api/drills", json={"name": "Second"}).status_code == 201
    r = c.post("/api/drills", json={"name": "Third"})
    assert r.status_code == 409 and "demo account can keep up to 2" in r.json()["error"]
    assert c.get("/api/drills").json()["limit"] == 2


def test_the_button_cannot_be_hammered(tmp_path) -> None:
    client, _ = app_client(tmp_path)
    with client:
        codes = []
        for _ in range(7):
            client.cookies.clear()
            codes.append(client.post("/api/auth/demo").status_code)
        assert codes[:3] == [201, 201, 201] and 429 in codes


def test_the_demo_can_be_switched_off_or_capped(tmp_path) -> None:
    off, _ = app_client(tmp_path, allow_demo=False)
    with off:
        r = off.post("/api/auth/demo")
        assert r.status_code == 403 and "switched off" in r.json()["error"]
    (tmp_path / "cap").mkdir()
    capped, svc = app_client(tmp_path / "cap", max_guests=1)
    with capped:
        assert capped.post("/api/auth/demo").status_code == 201
        capped.cookies.clear()
        r = capped.post("/api/auth/demo")
        assert r.status_code == 503 and "busy" in r.json()["error"]


def test_expired_guests_are_deleted_with_their_drills_and_real_users_never_are(api) -> None:
    c, svc = api
    stale_drill = c.post("/api/auth/demo").json()["drill"]["id"]
    stale = Who(c, c.cookies.get("ms_session"))
    wait_live(stale, stale_drill)
    assert svc.manager.live_count == 1
    c.cookies.clear()
    fresh_drill = c.post("/api/auth/demo").json()["drill"]["id"]
    c.cookies.clear()
    member = signed_in(c, "member@example.com", "Member")
    c.post("/api/drills", json={"name": "Mine"})

    old = datetime.now(timezone.utc) - timedelta(hours=25)
    with svc.engine.begin() as conn:                                                   # age the first guest and the real member
        guest_ids = conn.execute(select(users.c.id).where(users.c.is_guest.is_(True)).order_by(users.c.id)).scalars().all()
        conn.execute(update(users).where(users.c.id == guest_ids[0]).values(created_at=old))
        conn.execute(update(users).where(users.c.email == "member@example.com").values(created_at=old))

    result = asyncio.run(housekeeping(svc))
    assert result["guests"] == 1
    with svc.engine.connect() as conn:
        remaining = conn.execute(select(users.c.email, users.c.is_guest)).all()
        assert not conn.execute(select(drills.c.id).where(drills.c.id == stale_drill)).first()      # its drill went with it
        assert conn.execute(select(drills.c.id).where(drills.c.id == fresh_drill)).first()          # a young guest's drill stays
        assert conn.execute(select(func.count()).select_from(sessions)).scalar_one() == 2           # fresh guest + member
    assert ("member@example.com", False) in [(e, g) for e, g in remaining]                          # old, but a real account: untouched
    assert len(remaining) == 2
    assert member["email"] == "member@example.com"
