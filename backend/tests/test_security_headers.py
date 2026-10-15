"""Browser-side defences: Content-Security-Policy, HSTS and friends — and that the policy does not break the app."""
from pathlib import Path

from .helpers import app_client

INDEX = Path(__file__).resolve().parents[2] / "frontend" / "index.html"


def test_every_response_carries_the_hardening_headers(tmp_path) -> None:
    client, _ = app_client(tmp_path)
    with client:
        h = client.get("/api/health").headers
    assert h["x-content-type-options"] == "nosniff" and h["x-frame-options"] == "DENY"
    assert h["referrer-policy"] == "same-origin" and "camera=()" in h["permissions-policy"]
    assert h["cross-origin-opener-policy"] == "same-origin"
    csp = h["content-security-policy"]
    assert "default-src 'self'" in csp and "frame-ancestors 'none'" in csp
    assert "script-src" not in csp and "'unsafe-inline'" in csp.split("style-src")[1]      # scripts: own origin only; inline styles: React needs them
    assert "strict-transport-security" not in h                                           # only over HTTPS in production


def test_hsts_is_sent_in_production(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("APP_ENV", "production")
    from missionsync.main import create_app
    from fastapi.testclient import TestClient
    from .helpers import make_services

    svc = make_services(tmp_path, env="test")
    with TestClient(create_app(svc)) as client:
        assert "max-age=31536000" in client.get("/api/health").headers["strict-transport-security"]


def test_the_api_docs_pages_get_a_policy_that_lets_swagger_load(tmp_path) -> None:
    client, _ = app_client(tmp_path)
    with client:
        docs = client.get("/docs")
        app_page = client.get("/api/health")
    assert docs.status_code == 200 and "cdn.jsdelivr.net" in docs.headers["content-security-policy"]
    assert "cdn.jsdelivr.net" not in app_page.headers["content-security-policy"]          # the app itself never trusts the CDN


def test_the_page_has_no_inline_script_the_policy_would_block() -> None:
    """index.html is served under script-src 'self': an inline <script> would be silently refused in the browser."""
    html = INDEX.read_text(encoding="utf-8")
    import re

    inline = [m for m in re.findall(r"<script\b([^>]*)>", html) if "src=" not in m]
    assert inline == [], "inline <script> found in frontend/index.html — move it to /public and load it with src="
    assert 'src="/theme-init.js"' in html
    assert (INDEX.parent / "public" / "theme-init.js").is_file()
