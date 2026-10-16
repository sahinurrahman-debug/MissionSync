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
from .llm import Budget
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
    EVICT_AFTER_S = 20.0

    def __init__(self, store: Store, settings: Settings, sessions: Optional[Any] = None) -> None:
        self.store = store
        self.settings = settings
        self.sessions = sessions
        #: Optional async callable run about every ten minutes (expired sessions, expired guest accounts).
        self.housekeeping: Optional[Any] = None
        #: Optional callable `drill_id -> bool`: is this a demo account's drill (it gets a smaller AI allowance).
        self.is_guest_drill: Optional[Any] = None
        self._runtimes: dict[int, DrillRuntime] = {}
        self._admission = asyncio.Lock()          # loading is one at a time, so the live-drill limit is a real limit
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
            async with self._admission:
                rt = self._runtimes.get(drill_id)
                if rt is None:
                    await self._make_room()
                    rt = self._spawn(drill_id)
        rt.touch()
        return rt

    def _spawn(self, drill_id: int) -> DrillRuntime:
        orch = Orchestrator(self.store, drill_id=drill_id)
        orch.pause_when_unwatched = True            # nobody watching → no ticks, no AI calls, no writes
        guest = bool(self.is_guest_drill(drill_id)) if self.is_guest_drill else False
        orch.budget = Budget(self.settings.ai_tokens_per_guest_drill if guest else self.settings.ai_tokens_per_drill)
        orch.refine_min_interval_s = self.settings.refine_min_interval_s
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
        # A drill opened a moment ago has no viewer yet (the page connects its socket right after loading), so only
        # drills that have really been left alone are candidates.
        idle = sorted((r for r in self._runtimes.values() if r.hub.viewers == 0 and r.idle_s > self.EVICT_AFTER_S), key=lambda r: r.last_active)
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
        passes = 0
        while True:
            await asyncio.sleep(30)
            passes += 1
            try:
                if passes % 20 == 0:                                    # every ~10 minutes: lets a serverless database sleep
                    if self.housekeeping is not None:
                        await self.housekeeping()
                    elif self.sessions is not None:
                        await asyncio.to_thread(self.sessions.purge_expired)
                for rt in list(self._runtimes.values()):
                    if rt.hub.viewers == 0 and rt.idle_s > self.settings.idle_unload_s:
                        await self.unload(rt.drill_id)
            except Exception:
                logger.exception("reaper pass failed")
