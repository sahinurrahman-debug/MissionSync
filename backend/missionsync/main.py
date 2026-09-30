"""MissionSync API — FastAPI app with WebSocket live push.

Read:
    GET  /api/health                     liveness, engine mode, LLM quota, database, viewers
    GET  /api/snapshot                   full world state
    GET  /api/audit                      full timestamped event log (current drill)
    GET  /api/drills                     past drills (needs DATABASE_URL)
    GET  /api/drills/{id}/audit          a stored drill's audit trail
    GET  /api/drills/{id}/export.csv     after-action export: reports + audit trail
    WS   /ws                             live world snapshots, every pipeline stage, no polling
Net control (recommend → human commits):
    POST /api/report                     inject a free-text report (idempotent via client_nonce)
    POST /api/dispatch/approve           approve proposals (all, or a list of ids)
    POST /api/dispatch/reject            reject one proposal
    POST /api/dispatch/manual            override: send a specific unit to a specific incident
    POST /api/units/{id}/recall          recall a unit
    PATCH /api/incidents/{id}            mark an incident contained / closed
Admin (X-Admin-Key when ADMIN_KEY is set):
    POST /api/reset                      start the drill over
    POST /api/drill/end                  end the drill and freeze the picture
    POST /api/settings                   auto-dispatch (demo) on/off

Every non-2xx response uses the standard envelope from docs/API_SPEC.md:
    {"error": {"code", "message", "details", "request_id"}}
"""
from __future__ import annotations

import asyncio
import collections
import contextlib
import contextvars
import hmac
import json
import logging
import os
import sys
import time
import uuid
from typing import Literal, Optional
from urllib.parse import urlparse

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field
from starlette.exceptions import HTTPException as StarletteHTTPException

from .llm import llm_stats
from .models import IncomingReport, WorldSnapshot
from .orchestrator import DomainError, Orchestrator
from .persistence import Store

logger = logging.getLogger("missionsync")
STARTED_AT = time.time()
_request_id: contextvars.ContextVar[str] = contextvars.ContextVar("request_id", default="-")


# --------------------------------------------------------------------------
# Structured logging (LOG_FORMAT=json for log aggregators; Render reads stdout)
# --------------------------------------------------------------------------

class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        entry = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(record.created)) + f".{int(record.msecs):03d}Z",
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
            "request_id": _request_id.get(),
        }
        for key in ("method", "path", "status", "ms", "ip"):
            if hasattr(record, key):
                entry[key] = getattr(record, key)
        if record.exc_info:
            entry["exc"] = self.formatException(record.exc_info)
        return json.dumps(entry, ensure_ascii=False)


def configure_logging() -> None:
    root = logging.getLogger()
    if getattr(root, "_ms_configured", False):
        return
    handler = logging.StreamHandler(sys.stdout)
    if os.getenv("LOG_FORMAT", "text").lower() == "json":
        handler.setFormatter(JsonFormatter())
    else:
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s"))
    root.handlers[:] = [handler]
    root.setLevel(os.getenv("LOG_LEVEL", "INFO").upper())
    root._ms_configured = True  # type: ignore[attr-defined]


configure_logging()

if os.getenv("SENTRY_DSN"):                     # optional error tracking; no dependency unless used
    try:
        import sentry_sdk

        sentry_sdk.init(dsn=os.environ["SENTRY_DSN"], traces_sample_rate=0.0)
    except Exception:  # pragma: no cover
        logger.warning("SENTRY_DSN is set but sentry-sdk is not installed")

orch = Orchestrator(Store(os.getenv("DATABASE_URL")))

_origins = [o.strip() for o in os.getenv(
    "CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173"
).split(",") if o.strip()]
MAX_WS_CLIENTS = int(os.getenv("MAX_WS_CLIENTS", "200"))


def _snapshot_json(snapshot: WorldSnapshot) -> dict:
    return snapshot.model_dump(mode="json")


class _Sink:
    """One dashboard's outbox: a short queue (every pipeline stage reaches a healthy client), and a
    slow client loses its oldest frames instead of making the drill — or anyone else — wait."""

    MAX_QUEUED = 8

    def __init__(self, ws: WebSocket) -> None:
        self.ws = ws
        self.queue: collections.deque[str] = collections.deque(maxlen=self.MAX_QUEUED)
        self.event = asyncio.Event()
        self.task: asyncio.Task | None = None


class Hub:
    """Fan-out of snapshots to every connected dashboard."""

    SEND_TIMEOUT_S = 5.0

    def __init__(self) -> None:
        self.clients: dict[WebSocket, _Sink] = {}

    def _count(self) -> None:
        orch.viewers = len(self.clients)
        orch.peak_viewers = max(orch.peak_viewers, orch.viewers)

    @staticmethod
    def origin_allowed(ws: WebSocket) -> bool:
        """Browsers always send Origin on a WebSocket handshake; reject foreign sites (cross-site
        WebSocket hijacking). Non-browser clients send none and are allowed."""
        origin = ws.headers.get("origin")
        if not origin or "*" in _origins or origin in _origins:
            return True
        return urlparse(origin).netloc == ws.headers.get("host", "")   # same-origin deployments

    async def join(self, ws: WebSocket) -> bool:
        if not self.origin_allowed(ws):
            await ws.close(code=4403)
            return False
        if len(self.clients) >= MAX_WS_CLIENTS:
            await ws.close(code=1013)                                    # try again later
            return False
        await ws.accept()
        await ws.send_text(json.dumps({"type": "snapshot", "data": _snapshot_json(orch.snapshot())}))
        sink = _Sink(ws)
        sink.task = asyncio.create_task(self._pump(sink))
        self.clients[ws] = sink
        self._count()
        return True

    def leave(self, ws: WebSocket) -> None:
        sink = self.clients.pop(ws, None)
        if sink and sink.task and sink.task is not asyncio.current_task():
            sink.task.cancel()
        self._count()

    async def _pump(self, sink: _Sink) -> None:
        while True:
            await sink.event.wait()
            sink.event.clear()
            while sink.queue:
                payload = sink.queue.popleft()
                try:
                    await asyncio.wait_for(sink.ws.send_text(payload), timeout=self.SEND_TIMEOUT_S)
                except asyncio.CancelledError:
                    raise
                except Exception:
                    self.leave(sink.ws)                                  # stuck or dead client: drop it
                    with contextlib.suppress(Exception):
                        await sink.ws.close()
                    return

    async def broadcast(self, snapshot: WorldSnapshot) -> None:
        """Serialise once and hand the frame to every outbox; returns immediately."""
        if not self.clients:
            return
        payload = json.dumps({"type": "snapshot", "data": _snapshot_json(snapshot)})
        for sink in list(self.clients.values()):
            sink.queue.append(payload)
            sink.event.set()


hub = Hub()
orch.on_broadcast(hub.broadcast)


@contextlib.asynccontextmanager
async def lifespan(_app: FastAPI):
    # The drill is restored from the database (or bootstrapped) in the background, so the API
    # answers immediately; clients see status "booting" until the first pipeline cycle completes.
    task = asyncio.create_task(orch.run())
    yield
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task


app = FastAPI(title="MissionSync", version="3.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Request-ID", "Retry-After"],
)


# --------------------------------------------------------------------------
# Request ids, access log, and the standard error envelope
# --------------------------------------------------------------------------

@app.middleware("http")
async def request_middleware(request: Request, call_next):
    rid = f"req_{uuid.uuid4().hex[:8]}"
    request.state.request_id = rid
    token = _request_id.set(rid)
    started = time.perf_counter()
    try:
        response = await call_next(request)
    finally:
        _request_id.reset(token)
    response.headers["X-Request-ID"] = rid
    if request.url.path.startswith("/api/") and request.url.path != "/api/health":
        logger.info("request", extra={
            "method": request.method, "path": request.url.path, "status": response.status_code,
            "ms": int((time.perf_counter() - started) * 1000), "ip": request.client.host if request.client else "?"})
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


@app.exception_handler(DomainError)
async def on_domain_error(request: Request, exc: DomainError) -> JSONResponse:
    return error_response(request, exc.status, exc.code, exc.message)


@app.exception_handler(Exception)
async def on_unhandled(request: Request, exc: Exception) -> JSONResponse:
    logger.exception("unhandled error")
    return error_response(request, 500, "internal_error", "Something went wrong on the server.")


# --------------------------------------------------------------------------
# Rate limits and admin access
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


report_limiter = RateLimiter()                       # report flood: burst 5, then 1 per 2 s
ops_limiter = RateLimiter(burst=30, refill_per_s=3)  # dispatch/recall/etc.


def _client_key(request: Request) -> str:
    # Behind a proxy uvicorn (--forwarded-allow-ips) has already replaced this with the real client.
    return request.client.host if request.client else "unknown"


def _limited(request: Request, limiter: RateLimiter) -> JSONResponse | None:
    wait = limiter.check(_client_key(request))
    if wait <= 0:
        return None
    retry = max(1, int(wait + 0.999))
    response = error_response(
        request, 429, "rate_limited", "Too many requests — slow down.",
        [{"field": "retry_after_seconds", "issue": str(retry)}],
    )
    response.headers["Retry-After"] = str(retry)
    return response


def require_admin(request: Request) -> None:
    """Destructive, drill-wide actions need the admin key whenever ADMIN_KEY is configured."""
    expected = os.getenv("ADMIN_KEY", "")
    if not expected:
        return
    provided = request.headers.get("x-admin-key", "")
    if not hmac.compare_digest(provided.encode(), expected.encode()):
        raise StarletteHTTPException(401, "An admin key is required for this action.")


# --------------------------------------------------------------------------
# Read routes
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
        "auto_dispatch": orch.auto_dispatch,
        "admin_protected": bool(os.getenv("ADMIN_KEY")),
        "incidents": len(orch.incidents),
        "viewers": orch.viewers,
        "peak_viewers": orch.peak_viewers,
        "uptime_s": int(time.time() - STARTED_AT),
        "version": app.version,
    }


@app.get("/api/snapshot")
async def snapshot() -> dict:
    return _snapshot_json(orch.snapshot())


@app.get("/api/audit")
async def audit() -> dict:
    return {"events": [e.model_dump(mode="json") for e in orch.event_log], "count": len(orch.event_log)}


def _require_db() -> None:
    if not orch.store.enabled:
        raise StarletteHTTPException(404, "Drill history needs a database (set DATABASE_URL).")


@app.get("/api/drills")
async def list_drills() -> dict:
    return {
        "database": orch.store.status(),
        "current": orch.drill_id,
        "drills": await asyncio.to_thread(orch.store.list_drills) if orch.store.enabled else [],
    }


@app.get("/api/drills/{drill_id}/audit")
async def drill_audit(drill_id: int) -> dict:
    _require_db()
    if not await asyncio.to_thread(orch.store.drill_exists, drill_id):
        raise StarletteHTTPException(404, f"Drill {drill_id} does not exist.")
    events = await asyncio.to_thread(orch.store.drill_events, drill_id)
    reports = await asyncio.to_thread(orch.store.drill_reports, drill_id)
    return {"drill_id": drill_id, "events": events, "reports": reports}


@app.get("/api/drills/{drill_id}/export.csv")
async def drill_export(drill_id: int) -> Response:
    _require_db()
    if not await asyncio.to_thread(orch.store.drill_exists, drill_id):
        raise StarletteHTTPException(404, f"Drill {drill_id} does not exist.")
    body = await asyncio.to_thread(orch.store.export_csv, drill_id)
    return Response(
        content=body, media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="missionsync-drill-{drill_id}.csv"'},
    )


# --------------------------------------------------------------------------
# Net control: report intake and the human-commit actions
# --------------------------------------------------------------------------

def _ok(snap: WorldSnapshot, **extra) -> dict:
    return {"status": "ok", **extra, "snapshot": _snapshot_json(snap)}


@app.post("/api/report")
async def inject_report(report: IncomingReport, request: Request):
    """Accepts free text and answers fast: recognised reports are ranked immediately (rules) and
    refined by the LLM in the background (watch the WebSocket)."""
    limited = _limited(request, report_limiter)
    if limited is not None:
        return limited
    outcome, snap = await orch.inject_report(report)
    return {
        "status": "processed",
        "outcome": outcome.model_dump(mode="json"),
        "injections": orch._injection_count,
        "snapshot": _snapshot_json(snap),
    }


class ApproveBody(BaseModel):
    proposal_ids: Optional[list[str]] = Field(default=None, max_length=50)


class RejectBody(BaseModel):
    proposal_id: str = Field(min_length=1, max_length=120)


class ManualDispatchBody(BaseModel):
    incident_id: str = Field(min_length=1, max_length=64)
    resource_id: str = Field(min_length=1, max_length=64)
    role: str = Field(default="", max_length=60)


class IncidentPatch(BaseModel):
    status: Literal["contained", "closed"]


class SettingsBody(BaseModel):
    auto_dispatch: bool


@app.post("/api/dispatch/approve")
async def dispatch_approve(request: Request, body: Optional[ApproveBody] = None):
    limited = _limited(request, ops_limiter)
    if limited is not None:
        return limited
    return _ok(await orch.approve(body.proposal_ids if body else None))


@app.post("/api/dispatch/reject")
async def dispatch_reject(body: RejectBody, request: Request):
    limited = _limited(request, ops_limiter)
    if limited is not None:
        return limited
    return _ok(await orch.reject(body.proposal_id))


@app.post("/api/dispatch/manual")
async def dispatch_manual(body: ManualDispatchBody, request: Request):
    limited = _limited(request, ops_limiter)
    if limited is not None:
        return limited
    return _ok(await orch.manual_dispatch(body.incident_id, body.resource_id, body.role))


@app.post("/api/units/{unit_id}/recall")
async def unit_recall(unit_id: str, request: Request):
    limited = _limited(request, ops_limiter)
    if limited is not None:
        return limited
    return _ok(await orch.recall(unit_id))


@app.patch("/api/incidents/{incident_id}")
async def incident_patch(incident_id: str, body: IncidentPatch, request: Request):
    limited = _limited(request, ops_limiter)
    if limited is not None:
        return limited
    return _ok(await orch.set_incident_status(incident_id, body.status))


# --------------------------------------------------------------------------
# Admin
# --------------------------------------------------------------------------

@app.post("/api/reset")
async def reset(request: Request):
    require_admin(request)
    limited = _limited(request, report_limiter)
    if limited is not None:
        return limited
    return {"status": "reset", "snapshot": _snapshot_json(await orch.reset())}


@app.post("/api/drill/end")
async def drill_end(request: Request):
    require_admin(request)
    return _ok(await orch.end_drill())


@app.post("/api/settings")
async def settings(body: SettingsBody, request: Request):
    require_admin(request)
    return _ok(await orch.set_auto_dispatch(body.auto_dispatch))


# --------------------------------------------------------------------------
# WebSocket
# --------------------------------------------------------------------------

@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket) -> None:
    if not await hub.join(ws):
        return
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
