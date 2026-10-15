"""Runs the live drills. Every drill is its own Orchestrator (its own world, ticks and WebSocket hub), loaded on
demand from the database and unloaded — saved first — after it has been idle with no viewers for a while, so a
small server can serve many accounts.
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Optional

from .config import Settings
from .hub import Hub
from .orchestrator import DomainError, Orchestrator
from .persistence import Store

logger = logging.getLogger(__name__)


@dataclass
class DrillRuntime:
    drill_id: int
    orch: Orchestrator
    hub: Hub
    task: asyncio.Task
    last_active: float = field(default_factory=time.monotonic)

    def touch(self) -> None:
        self.last_active = time.monotonic()

    @property
    def idle_s(self) -> float:
        return time.monotonic() - self.last_active


class DrillManager:
    def __init__(self, store: Store, settings: Settings, sessions: Optional[Any] = None) -> None:
        self.store = store
        self.settings = settings
        self.sessions = sessions
        self._runtimes: dict[int, DrillRuntime] = {}
        self._loading: dict[int, asyncio.Lock] = {}
        self._reaper: Optional[asyncio.Task] = None

    # -- lifecycle ------------------------------------------------------------------------

    def start(self) -> None:
        if self._reaper is None or self._reaper.done():
            self._reaper = asyncio.create_task(self._reap_forever())

    async def shutdown(self) -> None:
        if self._reaper:
            self._reaper.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._reaper
        for drill_id in list(self._runtimes):
            await self.unload(drill_id)

    # -- access ---------------------------------------------------------------------------

    @property
    def live_count(self) -> int:
        return len(self._runtimes)

    def peek(self, drill_id: int) -> Optional[DrillRuntime]:
        return self._runtimes.get(drill_id)

    async def get(self, drill_id: int) -> DrillRuntime:
        """The running drill, loading (restoring or booting) it first when needed. Ownership is checked by the caller."""
        rt = self._runtimes.get(drill_id)
        if rt is None:
            lock = self._loading.setdefault(drill_id, asyncio.Lock())
            async with lock:
                rt = self._runtimes.get(drill_id)
                if rt is None:
                    await self._make_room()
                    rt = self._spawn(drill_id)
            self._loading.pop(drill_id, None)
        rt.touch()
        return rt

    def _spawn(self, drill_id: int) -> DrillRuntime:
        orch = Orchestrator(self.store, drill_id=drill_id)
        hub = Hub(orch)
        orch.on_broadcast(hub.broadcast)
        task = asyncio.create_task(orch.run())
        rt = DrillRuntime(drill_id=drill_id, orch=orch, hub=hub, task=task)
        self._runtimes[drill_id] = rt
        logger.info("drill %s loaded (%s running)", drill_id, len(self._runtimes))
        return rt

    async def _make_room(self) -> None:
        if len(self._runtimes) < self.settings.max_live_drills:
            return
        idle = sorted((r for r in self._runtimes.values() if r.hub.viewers == 0), key=lambda r: r.last_active)
        if not idle:
            raise DomainError(503, "degraded", "The server is running its maximum number of drills right now. Try again in a minute.")
        await self.unload(idle[0].drill_id)

    async def unload(self, drill_id: int, save: bool = True) -> None:
        rt = self._runtimes.pop(drill_id, None)
        if rt is None:
            return
        await rt.hub.close_all()
        rt.task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await rt.task
        if save and rt.orch.status in ("live", "ended"):
            await rt.orch._persist()
        logger.info("drill %s unloaded (%s running)", drill_id, len(self._runtimes))

    async def _reap_forever(self) -> None:
        while True:
            await asyncio.sleep(30)
            try:
                if self.sessions is not None:
                    await asyncio.to_thread(self.sessions.purge_expired)
                for rt in list(self._runtimes.values()):
                    if rt.hub.viewers == 0 and rt.idle_s > self.settings.idle_unload_s:
                        await self.unload(rt.drill_id)
            except Exception:
                logger.exception("reaper pass failed")
