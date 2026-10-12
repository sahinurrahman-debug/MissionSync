"""Health check and serving the built dashboard from the same origin."""
from .helpers import app_client


def test_health_is_public_and_says_what_it_is_running_on(tmp_path) -> None:
    client, _ = app_client(tmp_path)
    with client:
        h = client.get("/api/health").json()
    assert h["status"] == "ok" and h["database"] == "sqlite" and h["version"] == "4.0"
    assert {"mode", "model", "quota", "live_drills", "uptime_s", "signup_open"} <= set(h)
    assert "email" not in str(h) and "owner" not in str(h)              # nothing about any account


def test_the_dashboard_is_served_with_a_fallback_for_client_side_routes(tmp_path, monkeypatch) -> None:
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<!doctype html><title>MissionSync</title><div id=root></div>")
    (dist / "assets" / "app-abc123.js").write_text("console.log('hi')")
    (dist / "robots.txt").write_text("User-agent: *")
    monkeypatch.setenv("STATIC_DIR", str(dist))
    client, _ = app_client(tmp_path)
    with client:
        home = client.get("/")
        assert home.status_code == 200 and "MissionSync" in home.text and home.headers["cache-control"] == "no-cache"
        deep = client.get("/drills/7")                                   # a React-router URL opened directly
        assert deep.status_code == 200 and "MissionSync" in deep.text
        asset = client.get("/assets/app-abc123.js")
        assert asset.status_code == 200 and "immutable" in asset.headers["cache-control"]
        assert client.get("/robots.txt").text.startswith("User-agent")
        gone = client.get("/api/does-not-exist")                          # API typos are JSON errors, never the HTML shell
        assert gone.status_code == 404 and gone.json()["code"] == "not_found"
        assert "root:" not in client.get("/..%2f..%2f..%2fetc/passwd").text   # path traversal cannot escape the folder


def test_security_headers_are_set(tmp_path) -> None:
    client, _ = app_client(tmp_path)
    with client:
        r = client.get("/api/health")
    assert r.headers["x-content-type-options"] == "nosniff" and r.headers["x-frame-options"] == "DENY"
    assert r.headers["x-request-id"].startswith("req_")
