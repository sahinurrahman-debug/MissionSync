"""Health check, and serving the built dashboard so the whole app lives on ONE origin — which is what lets the
session cookie be SameSite and httpOnly without any cross-site tricks."""
from __future__ import annotations

import asyncio
import os
import time
from pathlib import Path

from fastapi import APIRouter, Depends, FastAPI, Response
from fastapi.responses import FileResponse
from sqlalchemy import text

from ..deps import get_services
from ..errors import ApiError
from ..llm import llm_stats
from ..services import Services

router = APIRouter()
STARTED_AT = time.time()


@router.get("/api/health", tags=["system"])
async def health(svc: Services = Depends(get_services)) -> dict:
    def ping() -> bool:
        with svc.engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        return True

    try:
        db_ok = await asyncio.to_thread(ping)
    except Exception:
        db_ok = False
    llm = llm_stats()
    return {
        "status": "ok" if db_ok else "degraded",
        "database": svc.engine.dialect.name if db_ok else "error",
        "mode": llm["mode"],
        "model": llm["model"],
        "llm_configured": llm["configured"],
        "quota": llm["quota"],
        "agents": llm["agents"],
        "live_drills": svc.manager.live_count,
        "signup_open": svc.settings.allow_signup,
        "uptime_s": int(time.time() - STARTED_AT),
        "version": "4.0",
    }


def _static_dir() -> Path | None:
    candidates = [os.getenv("STATIC_DIR", ""), str(Path(__file__).resolve().parents[2] / "static"), str(Path(__file__).resolve().parents[3] / "frontend" / "dist")]
    for c in candidates:
        if c and (Path(c) / "index.html").is_file():
            return Path(c)
    return None


def mount_dashboard(app: FastAPI) -> None:
    """Serve the compiled React app (if it has been built) with a history-API fallback for client-side routes."""
    root = _static_dir()
    if root is None:
        return
    root = root.resolve()

    @app.get("/{path:path}", include_in_schema=False)
    async def spa(path: str) -> Response:
        if path.startswith(("api/", "ws/")) or path in ("api", "ws"):
            raise ApiError(404, "not_found", "No such endpoint.")
        target = (root / path).resolve()
        if path and target.is_file() and root in target.parents:
            immutable = path.startswith("assets/")
            return FileResponse(target, headers={"Cache-Control": "public, max-age=31536000, immutable" if immutable else "no-cache"})
        return FileResponse(root / "index.html", headers={"Cache-Control": "no-cache"})
