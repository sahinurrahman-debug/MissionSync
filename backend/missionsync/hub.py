"""WebSocket fan-out for ONE drill: every dashboard watching it gets each snapshot, and nobody else does."""
from __future__ import annotations

import asyncio
import collections
import contextlib
import json
from typing import TYPE_CHECKING

from fastapi import WebSocket

from .models import WorldSnapshot

if TYPE_CHECKING:  # pragma: no cover
    from .orchestrator import Orchestrator


def snapshot_json(snapshot: WorldSnapshot) -> dict:
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
    SEND_TIMEOUT_S = 5.0

    def __init__(self, orch: "Orchestrator", max_clients: int = 50) -> None:
        self.orch = orch
        self.max_clients = max_clients
        self.clients: dict[WebSocket, _Sink] = {}

    def _count(self) -> None:
        self.orch.viewers = len(self.clients)
        self.orch.peak_viewers = max(self.orch.peak_viewers, self.orch.viewers)

    @property
    def viewers(self) -> int:
        return len(self.clients)

    async def join(self, ws: WebSocket) -> bool:
        """Accept an already-authorised socket and send the current picture."""
        if len(self.clients) >= self.max_clients:
            await ws.close(code=1013)                                    # try again later
            return False
        await ws.accept()
        await ws.send_text(json.dumps({"type": "snapshot", "data": snapshot_json(self.orch.snapshot())}))
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
        payload = json.dumps({"type": "snapshot", "data": snapshot_json(snapshot)})
        for sink in list(self.clients.values()):
            sink.queue.append(payload)
            sink.event.set()

    async def close_all(self, code: int = 1001) -> None:
        for ws in list(self.clients):
            self.leave(ws)
            with contextlib.suppress(Exception):
                await ws.close(code=code)
