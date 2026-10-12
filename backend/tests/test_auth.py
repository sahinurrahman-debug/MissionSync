"""Sign up, sign in, sign out and sessions: validation, security properties and error shape."""
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import text

from missionsync.db.schema import sessions, users
from .helpers import PASSWORD, app_client, signed_in

from sqlalchemy import select, update


@pytest.fixture
def api(tmp_path):
    client, svc = app_client(tmp_path)
    with client:
        yield client, svc


def signup_body(**over):
    return {"email": "ann@example.com", "password": PASSWORD, "display_name": "Ann", **over}


def err(resp, status, code):
    assert resp.status_code == status, resp.text
    body = resp.json()
    assert isinstance(body["error"], str) and body["code"] == code
    assert "Traceback" not in resp.text and "sqlalchemy" not in resp.text.lower()
    return body


def test_signup_signs_you_in_and_the_session_persists_across_requests(api) -> None:
    c, _ = api
    r = c.post("/api/auth/signup", json=signup_body())
    assert r.status_code == 201
    assert r.json()["user"]["email"] == "ann@example.com" and "password" not in r.text and "hash" not in r.text
    me = c.get("/api/auth/me")                              # the cookie alone identifies the user — no client-side state
    assert me.status_code == 200 and me.json()["user"]["display_name"] == "Ann"
    assert c.get("/api/auth/me").status_code == 200


def test_the_session_cookie_is_httponly_samesite_and_opaque(api) -> None:
    c, svc = api
    cookie = c.post("/api/auth/signup", json=signup_body()).headers["set-cookie"].lower()
    assert "httponly" in cookie and "samesite=lax" in cookie and "path=/" in cookie and "max-age=" in cookie
    token = c.cookies.get("ms_session")
    assert token and len(token) >= 40
    with svc.engine.connect() as conn:
        stored = conn.execute(select(sessions.c.id)).scalars().all()
    assert stored and token not in stored                    # only a hash of the token is kept server-side


def test_cookies_are_secure_when_configured(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("COOKIE_SECURE", "1")
    client, _ = app_client(tmp_path)
    with client:
        r = client.post("/api/auth/signup", json=signup_body())
        assert "secure" in r.headers["set-cookie"].lower()


def test_production_refuses_to_run_on_a_throwaway_database(tmp_path) -> None:
    with pytest.raises(RuntimeError, match="DATABASE_URL"):
        app_client(tmp_path, env="production")


def test_passwords_are_hashed_with_argon2_and_never_stored_or_returned(api) -> None:
    c, svc = api
    c.post("/api/auth/signup", json=signup_body())
    with svc.engine.connect() as conn:
        row = conn.execute(select(users)).mappings().one()
        dump = " ".join(str(v) for v in conn.execute(text("select * from users")).all())
    assert row["password_hash"].startswith("$argon2id$") and PASSWORD not in dump


@pytest.mark.parametrize("body,field", [
    (dict(email="not-an-email"), "email"),
    (dict(email=""), "email"),
    (dict(display_name="   "), "display_name"),
    (dict(password="short"), "password"),
    (dict(password="password"), "password"),
    (dict(password="aaaaaaaaaaaa"), "password"),
    (dict(password="x" * 300), "password"),
])
def test_signup_rejects_bad_input_with_a_field_level_message(api, body, field) -> None:
    c, _ = api
    r = c.post("/api/auth/signup", json=signup_body(**body))
    b = err(r, 400, "validation_error")
    assert any(d["field"] == field for d in b["details"])
    assert not any("Value error" in d["issue"] for d in b["details"])
    assert c.get("/api/auth/me").status_code == 401           # and nobody was signed in


def test_email_is_unique_case_insensitively(api) -> None:
    c, _ = api
    c.post("/api/auth/signup", json=signup_body())
    err(c.post("/api/auth/signup", json=signup_body(email="ANN@Example.com")), 409, "conflict")


def test_login_logout_roundtrip(api) -> None:
    c, _ = api
    c.post("/api/auth/signup", json=signup_body())
    assert c.post("/api/auth/logout").status_code == 204
    err(c.get("/api/auth/me"), 401, "unauthorized")
    bad = err(c.post("/api/auth/login", json={"email": "ann@example.com", "password": "wrong password!"}), 401, "unauthorized")
    err(c.post("/api/auth/login", json={"email": "nobody@example.com", "password": PASSWORD}), 401, "unauthorized")
    assert bad["error"] == "That email and password do not match."           # same sentence: no account enumeration by login
    ok = c.post("/api/auth/login", json={"email": " ANN@example.com ", "password": PASSWORD})
    assert ok.status_code == 200 and c.get("/api/auth/me").status_code == 200


def test_logout_revokes_the_session_server_side(api) -> None:
    c, _ = api
    c.post("/api/auth/signup", json=signup_body())
    stolen = c.cookies.get("ms_session")
    c.post("/api/auth/logout")
    c.cookies.set("ms_session", stolen)                       # replay the old cookie
    err(c.get("/api/auth/me"), 401, "unauthorized")


def test_expired_sessions_are_rejected_and_removed(api) -> None:
    c, svc = api
    c.post("/api/auth/signup", json=signup_body())
    with svc.engine.begin() as conn:
        conn.execute(update(sessions).values(expires_at=datetime.now(timezone.utc) - timedelta(minutes=1)))
    err(c.get("/api/auth/me"), 401, "unauthorized")
    with svc.engine.connect() as conn:
        assert conn.execute(select(sessions.c.id)).first() is None


def test_forged_and_garbage_cookies_are_rejected(api) -> None:
    c, _ = api
    for value in ("", "x", "a" * 500, "../../etc/passwd", "' OR 1=1 --"):
        c.cookies.set("ms_session", value)
        err(c.get("/api/auth/me"), 401, "unauthorized")


def test_brute_force_logins_are_rate_limited(api) -> None:
    c, _ = api
    c.post("/api/auth/signup", json=signup_body())
    c.post("/api/auth/logout")
    codes = [c.post("/api/auth/login", json={"email": "ann@example.com", "password": f"guess number {i}"}).status_code for i in range(14)]
    assert codes[0] == 401 and 429 in codes
    limited = c.post("/api/auth/login", json={"email": "ann@example.com", "password": PASSWORD})
    assert limited.status_code == 429 and int(limited.headers["Retry-After"]) >= 1      # even the right password waits


def test_signup_can_be_closed(tmp_path) -> None:
    client, _ = app_client(tmp_path, allow_signup=False)
    with client:
        err(client.post("/api/auth/signup", json=signup_body()), 403, "forbidden")


def test_foreign_origins_cannot_make_a_signed_in_browser_act(api) -> None:
    c, _ = api
    signed_in(c)
    evil = c.post("/api/drills", json={"name": "Hijack"}, headers={"Origin": "https://evil.example"})
    err(evil, 403, "forbidden")
    ok = c.post("/api/drills", json={"name": "Mine"}, headers={"Origin": "http://localhost:5173"})
    assert ok.status_code == 201


def test_api_errors_are_a_plain_error_string_without_internals(api) -> None:
    c, _ = api
    r = c.get("/api/drills/not-a-number")
    assert r.status_code in (400, 401) and isinstance(r.json()["error"], str)
    assert c.get("/api/nope").status_code in (401, 404)
