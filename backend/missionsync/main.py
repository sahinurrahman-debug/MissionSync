"""MissionSync API — FastAPI app with WebSocket live push.

Endpoints:
    GET  /api/health    readiness + mode (llm / fallback)
    GET  /api/snapshot  full world state
    POST /api/report    inject a free-text report (judge stress test)
    WS   /ws            live world snapshots, no polling
"""
from __future__ import annotations

import asyncio
import contextlib
import json

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from .llm import PRIMARY_MODEL, llm_stats
from .models import IncomingReport, WorldSnapshot
from .orchestrator import Orchestrator

orch = Orchestrator()


class Hub:
    """Fan-out of snapshots to every connected dashboard."""

    def __init__(self) -> None:
        self.clients: set[WebSocket] = set()

    async def join(self, ws: WebSocket) -> None:
        await ws.accept()
        self.clients.add(ws)
        await ws.send_text(json.dumps({"type": "snapshot", "data": _jsonable(orch.snapshot())}))

    def leave(self, ws: WebSocket) -> None:
        self.clients.discard(ws)

    async def broadcast(self, snapshot: WorldSnapshot) -> None:
        if not self.clients:
            return
        payload = json.dumps({"type": "snapshot", "data": _jsonable(snapshot)})
        dead: list[WebSocket] = []
        for ws in list(self.clients):
            try:
                await ws.send_text(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.leave(ws)


def _jsonable(obj: object) -> object:
    if hasattr(obj, "model_dump"):
        return obj.model_dump()
    return obj


hub = Hub()
orch.on_broadcast(hub.broadcast)


@contextlib.asynccontextmanager
async def lifespan(_app: FastAPI):
    await orch.bootstrap()
    loop_task = asyncio.create_task(orch.run_forever(interval_s=6.0))
    yield
    loop_task.cancel()


app = FastAPI(title="MissionSync", version="1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # demo dashboard on :5173
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
async def health() -> dict:
    llm = llm_stats()
    return {
        "status": "ok",
        "mode": llm["mode"],
        "model": PRIMARY_MODEL if llm["mode"] == "llm" else None,
        "agents": llm["agents"],
        "dataset": orch.dataset_source,
        "incidents": len(orch.incidents),
    }


@app.get("/api/snapshot")
async def snapshot() -> dict:
    return _jsonable(orch.snapshot())


@app.post("/api/report")
async def inject_report(report: IncomingReport) -> dict:
    """Judge stress test endpoint — accepts free text, triggers full pipeline."""
    snap = await orch.inject_report(report)
    return {"status": "processed", "injections": orch._injection_count, "snapshot": _jsonable(snap)}


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket) -> None:
    await hub.join(ws)
    try:
        while True:
            # Keepalive; dashboard doesn't send data
            await ws.receive_text()
    except WebSocketDisconnect:
        hub.leave(ws)
