"""WebSocket fan-out, per-drill isolation of live updates, and structured logging."""
import asyncio
import json
import logging
import time

from missionsync import logging_setup
from missionsync.hub import Hub, _Sink
from missionsync.models import WorldSnapshot
from missionsync.orchestrator import Orchestrator


class Stuck:
    async def send_text(self, _t: str) -> None:
        await asyncio.sleep(3600)

    async def close(self, code: int = 1000) -> None:
        pass


class Healthy:
    def __init__(self) -> None:
        self.got: list[str] = []

    async def send_text(self, t: str) -> None:
        self.got.append(t)

    async def close(self, code: int = 1000) -> None:
        pass


def attach(hub: Hub, ws) -> None:
    sink = _Sink(ws)                                    # type: ignore[arg-type]
    sink.task = asyncio.create_task(hub._pump(sink))
    hub.clients[ws] = sink                              # type: ignore[index]


def test_a_stuck_client_never_blocks_the_broadcast() -> None:
    async def scenario():
        orch = Orchestrator()
        hub = Hub(orch)
        hub.SEND_TIMEOUT_S = 0.2
        stuck, ok = Stuck(), Healthy()
        attach(hub, stuck)
        attach(hub, ok)
        snap = WorldSnapshot.model_validate(orch.snapshot().model_dump())
        t0 = time.perf_counter()
        for _ in range(5):
            await hub.broadcast(snap)
        took = time.perf_counter() - t0
        await asyncio.sleep(0.6)
        return took, hub.viewers, len(ok.got)

    took, remaining, received = asyncio.run(scenario())
    assert took < 0.05 and remaining == 1 and received == 5


def test_each_drill_has_its_own_hub_so_updates_never_cross() -> None:
    async def scenario():
        a, b = Orchestrator(), Orchestrator()
        hub_a, hub_b = Hub(a), Hub(b)
        watcher_a, watcher_b = Healthy(), Healthy()
        attach(hub_a, watcher_a)
        attach(hub_b, watcher_b)
        await hub_a.broadcast(a.snapshot())
        await asyncio.sleep(0.05)
        return len(watcher_a.got), len(watcher_b.got)

    assert asyncio.run(scenario()) == (1, 0)


def test_the_hub_counts_viewers_on_its_own_drill() -> None:
    async def scenario():
        orch = Orchestrator()
        hub = Hub(orch)
        for _ in range(3):
            attach(hub, Healthy())
        hub._count()
        return orch.viewers, orch.peak_viewers

    assert asyncio.run(scenario()) == (3, 3)


def test_log_lines_are_json_with_the_request_id() -> None:
    record = logging.LogRecord("missionsync", logging.INFO, __file__, 1, "request", None, None)
    record.method, record.path, record.status = "POST", "/api/drills", 201
    token = logging_setup.request_id_var.set("req_deadbeef")
    try:
        line = json.loads(logging_setup.JsonFormatter().format(record))
    finally:
        logging_setup.request_id_var.reset(token)
    assert line["request_id"] == "req_deadbeef" and line["status"] == 201 and line["level"] == "INFO"
