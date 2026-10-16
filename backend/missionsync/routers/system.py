"""Health check, and serving the built dashboard so the whole app lives on ONE origin — which is what lets the
session cookie be SameSite and httpOnly without any cross-site tricks."""
from __future__ import annotations

import asyncio
import os
from pathlib import Path

from fastapi import APIRouter, Depends, FastAPI, Response
from fastapi.responses import FileResponse, JSONResponse
from sqlalchemy import text

from ..deps import get_services
from ..errors import ApiError
from ..services import Services

router = APIRouter()


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
    body = {"status": "ok" if db_ok else "degraded", "database": svc.engine.dialect.name if db_ok else "error", "version": "4.0"}
    if not db_ok:
        return JSONResponse(status_code=503, content=body)       # so a host's health check sees a broken database
    return JSONResponse(content=body)


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
        if "." in path.rsplit("/", 1)[-1] and not (root / path).resolve().is_file():
            raise ApiError(404, "not_found", "No such file.")           # a missing script or image is a 404, not the app page
        target = (root / path).resolve()
        if path and target.is_file() and root in target.parents:
            immutable = path.startswith("assets/")
            return FileResponse(target, headers={"Cache-Control": "public, max-age=31536000, immutable" if immutable else "no-cache"})
        return FileResponse(root / "index.html", headers={"Cache-Control": "no-cache"})
