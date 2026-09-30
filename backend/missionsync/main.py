"""MissionSync API — FastAPI app with WebSocket live push.

Endpoints:
    GET  /api/health    liveness + mode (llm / fallback / quota_exhausted) + LLM quota
    GET  /api/snapshot  full world state
    POST /api/report    inject a free-text report (the judge stress test)
    POST /api/reset     start the drill over
    GET  /api/audit     full timestamped event log (current drill)
    GET  /api/drills                     past drills (needs DATABASE_URL)
    GET  /api/drills/{id}/audit          a stored drill's audit trail
    GET  /api/drills/{id}/export.csv     after-action export: reports + audit trail
    WS   /ws            live world snapshots, no polling

Every non-2xx response uses the standard envelope from docs/API_SPEC.md:
    {"error": {"code", "message", "details", "request_id"}}
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import time
import uuid

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from starlette.exceptions import HTTPException as StarletteHTTPException

from .llm import llm_stats
from .models import IncomingReport, WorldSnapshot
from .orchestrator import Orchestrator
from .persistence import Store

logger = logging.getLogger("missionsync")
STARTED_AT = time.time()

orch = Orchestrator(Store(os.getenv("DATABASE_URL")))


def _snapshot_json(snapshot: WorldSnapshot) -> dict:
    return snapshot.model_dump(mode="json")


class Hub:
    """Fan-out of snapshots to every connected dashboard."""

    SEND_TIMEOUT_S = 5.0

    def __init__(self) -> None:
        self.clients: set[WebSocket] = set()

    async def join(self, ws: WebSocket) -> None:
        await ws.accept()
        self.clients.add(ws)
        await ws.send_text(json.dumps({"type": "snapshot", "data": _snapshot_json(orch.snapshot())}))

    def leave(self, ws: WebSocket) -> None:
        self.clients.discard(ws)

    async def broadcast(self, snapshot: WorldSnapshot) -> None:
        if not self.clients:
            return
        payload = json.dumps({"type": "snapshot", "data": _snapshot_json(snapshot)})

        async def send(ws: WebSocket) -> None:
            try:
                await asyncio.wait_for(ws.send_text(payload), timeout=self.SEND_TIMEOUT_S)
            except Exception:
                self.leave(ws)   # slow or dead client: drop it, never block the rest

        await asyncio.gather(*(send(ws) for ws in list(self.clients)))


hub = Hub()
orch.on_broadcast(hub.broadcast)


@contextlib.asynccontextmanager
async def lifespan(_app: FastAPI):
    # Bootstrap runs in the background so the API answers immediately; clients see
    # status "booting" until the first pipeline cycle completes.
    task = asyncio.create_task(orch.run())
    yield
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task


app = FastAPI(title="MissionSync", version="2.0", lifespan=lifespan)

_origins = [o.strip() for o in os.getenv(
    "CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173"
).split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Request-ID"],
)


# --------------------------------------------------------------------------
# Request ids + the standard error envelope
# --------------------------------------------------------------------------

@app.middleware("http")
async def request_id_middleware(request: Request, call_next):
    request.state.request_id = f"req_{uuid.uuid4().hex[:8]}"
    response = await call_next(request)
    response.headers["X-Request-ID"] = request.state.request_id
    return response


def _rid(request: Request) -> str:
    return getattr(request.state, "request_id", "req_unknown")


def error_response(request: Request, status: int, code: str, message: str, details: list | None = None) -> JSONResponse:
    body = {"error": {"code": code, "message": message, "details": details or [], "request_id": _rid(request)}}
    return JSONResponse(status_code=status, content=body, headers={"X-Request-ID": _rid(request)})


_CODES = {400: "validation_error", 401: "unauthorized", 403: "forbidden", 404: "not_found",
          405: "method_not_allowed", 409: "conflict", 429: "rate_limited", 503: "degraded"}


@app.exception_handler(RequestValidationError)
async def on_validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
    details = [
        {"field": ".".join(str(p) for p in e["loc"] if p != "body"), "issue": e["msg"]}
        for e in exc.errors()
    ]
    fields = ", ".join(d["field"] for d in details if d["field"]) or "request"
    return error_response(request, 400, "validation_error", f"Invalid {fields}.", details)


@app.exception_handler(StarletteHTTPException)
async def on_http_error(request: Request, exc: StarletteHTTPException) -> JSONResponse:
    code = _CODES.get(exc.status_code, "internal_error" if exc.status_code >= 500 else "error")
    return error_response(request, exc.status_code, code, str(exc.detail))


@app.exception_handler(Exception)
async def on_unhandled(request: Request, exc: Exception) -> JSONResponse:
    logger.exception("unhandled error [%s]", _rid(request))
    return error_response(request, 500, "internal_error", "Something went wrong on the server.")


# --------------------------------------------------------------------------
# Rate limit: burst of 5, then one every 2 s, per client (protects the LLM budget)
# --------------------------------------------------------------------------

class RateLimiter:
    def __init__(self, burst: int = 5, refill_per_s: float = 0.5) -> None:
        self.burst, self.refill = burst, refill_per_s
        self._buckets: dict[str, tuple[float, float]] = {}

    def check(self, key: str) -> float:
        """0.0 when allowed, otherwise seconds until the next token."""
        now = time.monotonic()
        tokens, last = self._buckets.get(key, (float(self.burst), now))
        tokens = min(float(self.burst), tokens + (now - last) * self.refill)
        if tokens >= 1.0:
            self._buckets[key] = (tokens - 1.0, now)
            return 0.0
        self._buckets[key] = (tokens, now)
        return (1.0 - tokens) / self.refill


report_limiter = RateLimiter()


def _client_key(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def _enforce_rate_limit(request: Request) -> JSONResponse | None:
    wait = report_limiter.check(_client_key(request))
    if wait <= 0:
        return None
    retry = max(1, int(wait + 0.999))
    response = error_response(
        request, 429, "rate_limited", "Too many reports — slow down.",
        [{"field": "retry_after_seconds", "issue": str(retry)}],
    )
    response.headers["Retry-After"] = str(retry)
    return response


# --------------------------------------------------------------------------
# Routes
# --------------------------------------------------------------------------

@app.get("/api/health")
async def health() -> dict:
    llm = llm_stats()
    return {
        "status": "ok",
        "state": orch.status,
        "mode": llm["mode"],
        "model": llm["model"],
        "llm_configured": llm["configured"],
        "quota": llm["quota"],
        "agents": llm["agents"],
        "dataset": orch.dataset_source,
        "database": orch.store.status(),
        "drill_id": orch.drill_id,
        "incidents": len(orch.incidents),
        "uptime_s": int(time.time() - STARTED_AT),
        "version": app.version,
    }


@app.get("/api/snapshot")
async def snapshot() -> dict:
    return _snapshot_json(orch.snapshot())


@app.post("/api/report")
async def inject_report(report: IncomingReport, request: Request):
    """Judge stress test endpoint — accepts free text, triggers the full pipeline."""
    limited = _enforce_rate_limit(request)
    if limited is not None:
        return limited
    outcome, snap = await orch.inject_report(report)
    return {
        "status": "processed",
        "outcome": outcome.model_dump(mode="json"),
        "injections": orch._injection_count,
        "snapshot": _snapshot_json(snap),
    }


@app.post("/api/reset")
async def reset(request: Request):
    limited = _enforce_rate_limit(request)
    if limited is not None:
        return limited
    snap = await orch.reset()
    return {"status": "reset", "snapshot": _snapshot_json(snap)}


@app.get("/api/audit")
async def audit() -> dict:
    return {"events": [e.model_dump(mode="json") for e in orch.event_log], "count": len(orch.event_log)}


def _require_db(request: Request) -> None:
    if not orch.store.enabled:
        raise StarletteHTTPException(404, "Drill history needs a database (set DATABASE_URL).")


@app.get("/api/drills")
async def list_drills(request: Request) -> dict:
    return {
        "database": orch.store.status(),
        "current": orch.drill_id,
        "drills": await asyncio.to_thread(orch.store.list_drills) if orch.store.enabled else [],
    }


@app.get("/api/drills/{drill_id}/audit")
async def drill_audit(drill_id: int, request: Request) -> dict:
    _require_db(request)
    if not await asyncio.to_thread(orch.store.drill_exists, drill_id):
        raise StarletteHTTPException(404, f"Drill {drill_id} does not exist.")
    events = await asyncio.to_thread(orch.store.drill_events, drill_id)
    reports = await asyncio.to_thread(orch.store.drill_reports, drill_id)
    return {"drill_id": drill_id, "events": events, "reports": reports}


@app.get("/api/drills/{drill_id}/export.csv")
async def drill_export(drill_id: int, request: Request) -> Response:
    _require_db(request)
    if not await asyncio.to_thread(orch.store.drill_exists, drill_id):
        raise StarletteHTTPException(404, f"Drill {drill_id} does not exist.")
    body = await asyncio.to_thread(orch.store.export_csv, drill_id)
    return Response(
        content=body, media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="missionsync-drill-{drill_id}.csv"'},
    )


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket) -> None:
    await hub.join(ws)
    try:
        while True:
            message = await ws.receive()
            if message.get("type") == "websocket.disconnect":
                break
            if message.get("text") == "ping":
                await ws.send_text(json.dumps({"type": "pong"}))
    except WebSocketDisconnect:
        pass
    finally:
        hub.leave(ws)
