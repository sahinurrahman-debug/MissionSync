"""MissionSync API.

    /api/auth/*                      sign up, sign in, sign out, who am I        (routers/auth.py)
    /api/drills[/{id}]               create, list, read, rename, delete YOUR drills (routers/drills.py)
    /api/drills/{id}/...             run a drill: reports, dispatch, end, reset    (routers/play.py)
    /ws/drills/{id}                  live snapshots of one drill                   (routers/live.py)
    /api/health, /*                  health check and the built dashboard          (routers/system.py)

Every non-2xx response is {"error": "<sentence>", "code": "...", "details": [...], "request_id": "..."}.
"""
from __future__ import annotations

import contextlib
import logging
import os
import time
import uuid
from typing import Optional
from urllib.parse import urlparse

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

from .errors import error_response, install_error_handlers
from .logging_setup import configure_logging, request_id_var
from .routers import auth, drills, live, play, system
from .services import Services, build_services

configure_logging()
logger = logging.getLogger("missionsync")

if os.getenv("SENTRY_DSN"):                     # optional error tracking; no dependency unless used
    try:
        import sentry_sdk

        sentry_sdk.init(dsn=os.environ["SENTRY_DSN"], traces_sample_rate=0.0)
    except Exception:  # pragma: no cover
        logger.warning("SENTRY_DSN is set but sentry-sdk is not installed")

DEV_ORIGINS = "http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173"
UNSAFE = {"POST", "PUT", "PATCH", "DELETE"}


def create_app(services: Optional[Services] = None) -> FastAPI:
    production = os.getenv("APP_ENV", "development").strip().lower() == "production"
    # Dev servers (Vite) are trusted only outside production; in production the page and API share one origin
    # and anything else must be listed explicitly in CORS_ORIGINS.
    origins = [o.strip() for o in os.getenv("CORS_ORIGINS", "" if production else DEV_ORIGINS).split(",") if o.strip()]

    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI):
        if not hasattr(app.state, "services"):
            app.state.services = build_services()
        app.state.services.manager.start()
        yield
        await app.state.services.manager.shutdown()

    app = FastAPI(title="MissionSync", version="4.0", lifespan=lifespan,
                  description="Real-time emergency-drill dashboard: accounts, private drills, AI agents that propose and humans that approve.")

    if services is not None:
        app.state.services = services

    app.add_middleware(
        CORSMiddleware, allow_origins=origins, allow_credentials=True,
        allow_methods=["GET", "POST", "PATCH", "DELETE"], allow_headers=["Content-Type"],
        expose_headers=["X-Request-ID", "Retry-After"],
    )

    @app.middleware("http")
    async def request_middleware(request: Request, call_next):
        rid = f"req_{uuid.uuid4().hex[:8]}"
        request.state.request_id = rid
        token = request_id_var.set(rid)
        started = time.perf_counter()
        try:
            if request.method in UNSAFE and request.url.path.startswith("/api/"):
                origin = request.headers.get("origin")
                if origin and origin not in origins and urlparse(origin).netloc != request.headers.get("host", ""):
                    # Belt and braces next to SameSite=Lax: a foreign site cannot make a signed-in browser act.
                    return error_response(request, 403, "forbidden", "Requests from other websites are not allowed.")
            response = await call_next(request)
        finally:
            request_id_var.reset(token)
        response.headers["X-Request-ID"] = rid
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("Referrer-Policy", "same-origin")
        if request.url.path.startswith("/api/") and request.url.path != "/api/health":
            logger.info("request", extra={
                "method": request.method, "path": request.url.path, "status": response.status_code,
                "ms": int((time.perf_counter() - started) * 1000), "ip": request.client.host if request.client else "?",
                "user": getattr(request.state, "user_id", None)})
            if request.url.path.startswith("/api/auth/"):
                response.headers["Cache-Control"] = "no-store"
        return response

    install_error_handlers(app)
    for r in (auth.router, drills.router, play.router, live.router, system.router):
        app.include_router(r)
    system.mount_dashboard(app)               # last: its catch-all must not shadow any API route
    return app


app = create_app()
