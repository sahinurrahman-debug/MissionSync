"""The rubric's hardest rule: one account must never read or change another account's data.

Two users, A and B. A owns a drill with reports; every route that touches it is tried as B, as an anonymous
visitor and with forged ids. B must always get 404 (never even a hint that the drill exists) and A's data must
stay exactly as it was."""
import time

import pytest
from starlette.websockets import WebSocketDisconnect

from .helpers import Who, app_client


@pytest.fixture
def world(tmp_path):
    client, svc = app_client(tmp_path)
    with client:
        a = Who.signup(client, "alice@example.com", "Alice")
        b = Who.signup(client, "bob@example.com", "Bob")
        anon = Who(client, None)
        drill = a.post("/api/drills", json={"name": "Alice's drill", "notes": "private"}).json()["drill"]
        base = f"/api/drills/{drill['id']}"
        deadline = time.time() + 20
        while a.get(f"{base}/snapshot").json()["status"] != "live":
            assert time.time() < deadline
            time.sleep(0.05)
        a.post(f"{base}/report", json={"text": "Ammonia leak at Industrial Park depot, 4 workers hurt"})
        yield a, b, anon, base, drill, svc


def is_404(resp):
    assert resp.status_code == 404, f"{resp.request.method} {resp.request.url.path} → {resp.status_code}: {resp.text[:120]}"
    assert resp.json()["code"] == "not_found" and "Alice" not in resp.text and "private" not in resp.text


# method, path suffix, json body
ROUTES = [
    ("GET", "", None),
    ("PATCH", "", {"name": "Hijacked"}),
    ("DELETE", "", None),
    ("GET", "/snapshot", None),
    ("GET", "/audit", None),
    ("GET", "/export.csv", None),
    ("POST", "/report", {"text": "Fire at the University lab"}),
    ("POST", "/dispatch/approve", None),
    ("POST", "/dispatch/reject", {"proposal_id": "x"}),
    ("POST", "/dispatch/manual", {"incident_id": "x", "resource_id": "y"}),
    ("POST", "/units/res_1/recall", None),
    ("PATCH", "/incidents/inc_1", {"status": "closed"}),
    ("POST", "/end", None),
    ("POST", "/reset", None),
    ("POST", "/settings", {"auto_dispatch": True}),
]


@pytest.mark.parametrize("method,suffix,body", ROUTES, ids=[f"{m} {s or '/'}" for m, s, _ in ROUTES])
def test_another_user_gets_404_on_every_route(world, method, suffix, body) -> None:
    _, b, _, base, _, _ = world
    is_404(b.request(method, base + suffix, json=body))


@pytest.mark.parametrize("method,suffix,body", ROUTES, ids=[f"{m} {s or '/'}" for m, s, _ in ROUTES])
def test_anonymous_visitors_get_401_on_every_route(world, method, suffix, body) -> None:
    _, _, anon, base, _, _ = world
    r = anon.request(method, base + suffix, json=body)
    assert r.status_code == 401 and r.json()["code"] == "unauthorized" and "private" not in r.text
    assert anon.get("/api/drills").status_code == 401
    assert anon.post("/api/drills", json={"name": "x"}).status_code == 401


def test_the_attacks_changed_nothing(world) -> None:
    a, b, _, base, drill, _ = world
    before = a.get(f"{base}/snapshot").json()
    for method, suffix, body in ROUTES:
        b.request(method, base + suffix, json=body)
    after = a.get(f"{base}/snapshot").json()
    assert a.get(base).json()["drill"]["name"] == "Alice's drill"
    assert after["status"] == "live" and len(after["incidents"]) == len(before["incidents"])
    assert after["settings"]["auto_dispatch"] is False


def test_listings_only_ever_contain_your_own_drills(world) -> None:
    a, b, _, _, drill, _ = world
    b.post("/api/drills", json={"name": "Bob's drill"})
    assert [d["name"] for d in a.get("/api/drills").json()["drills"]] == ["Alice's drill"]
    assert [d["name"] for d in b.get("/api/drills").json()["drills"]] == ["Bob's drill"]
    assert drill["id"] not in [d["id"] for d in b.get("/api/drills").json()["drills"]]


def test_guessing_ids_never_leaks_existence(world) -> None:
    _, b, _, base, drill, _ = world
    real = b.get(base)
    missing = b.get("/api/drills/987654")
    assert real.status_code == missing.status_code == 404
    assert real.json()["error"] == missing.json()["error"]              # identical answer for "not yours" and "not there"


def test_websocket_is_refused_for_strangers_and_visitors(world) -> None:
    a, b, anon, base, drill, _ = world
    path = f"/ws/drills/{drill['id']}"
    for who, code in ((b, 4404), (anon, 4401)):
        with who.websocket_connect(path) as ws:
            with pytest.raises(WebSocketDisconnect) as stop:
                ws.receive_text()
            assert stop.value.code == code
    with a.websocket_connect(path) as ws:                                # the owner is let in and sees the live picture
        first = ws.receive_json()
        assert first["type"] == "snapshot" and first["data"]["incidents"]


def test_websocket_from_a_foreign_site_is_refused_even_with_a_valid_session(world) -> None:
    a, _, _, _, drill, _ = world
    with a.websocket_connect(f"/ws/drills/{drill['id']}", headers={"origin": "https://evil.example"}) as ws:
        with pytest.raises(WebSocketDisconnect) as stop:
            ws.receive_text()
        assert stop.value.code == 4403


def test_deleting_an_account_session_does_not_touch_others(world) -> None:
    a, b, _, base, _, _ = world
    b.post("/api/auth/logout")
    assert b.get("/api/auth/me").status_code == 401
    assert a.get("/api/auth/me").status_code == 200 and a.get(base).status_code == 200
