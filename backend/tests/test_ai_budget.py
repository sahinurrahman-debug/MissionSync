"""The free AI plan is a small daily allowance shared by everyone, so each drill gets a share and AI passes are batched."""
from __future__ import annotations

import asyncio

from missionsync import llm
from missionsync.orchestrator import Orchestrator

from .fakes import FakeGroq
from .helpers import make_services


def test_a_drill_that_has_spent_its_share_carries_on_with_the_rules(monkeypatch) -> None:
    fake = FakeGroq()                                                   # every fake call reports 100 tokens used
    monkeypatch.setattr(llm, "_client", fake)

    async def go():
        o = Orchestrator()
        o.budget = llm.Budget(250)
        llm.use_budget(o.budget)
        await o.bootstrap()                                              # boot asks the LLM several times
        used_at_boot = o.budget.used
        calls_at_boot = len(fake.calls)
        parsed, _ = await llm.llm_json("system", "user", agent="terrain")  # over budget: no call is made at all
        return o, used_at_boot, calls_at_boot, parsed, len(fake.calls)

    o, used, calls, parsed, calls_after = asyncio.run(go())
    assert o.budget.spent and used >= 250                               # it stopped at (just past) its share
    assert parsed is None and calls_after == calls                       # nothing more is sent to Groq
    assert o._llm_available() is False                                   # so the drill schedules no more AI passes


def test_metrics_name_the_budget_state_and_unlimited_means_unlimited(monkeypatch) -> None:
    monkeypatch.setattr(llm, "_client", FakeGroq())
    o = Orchestrator()
    assert o.budget.limit == 0 and not o.budget.spent                    # tests and paid keys: no limit
    o.budget = llm.Budget(100)
    o.budget.used = 100
    snap = o.snapshot()
    assert snap.metrics["mode"] == "budget_spent"
    assert snap.metrics["ai_tokens"] == {"used": 100, "limit": 100}


def test_ai_passes_are_batched_so_a_busy_drill_does_not_drain_the_allowance(monkeypatch) -> None:
    fake = FakeGroq()
    monkeypatch.setattr(llm, "_client", fake)

    async def go(interval: float) -> int:
        fake.calls.clear()
        o = Orchestrator()
        o.refine_min_interval_s = interval
        task = asyncio.create_task(o.run(interval_s=0.02))
        await asyncio.sleep(1.0)
        for _ in range(6):                                               # six changes, one after another
            o._command_dirty = True
            o._enqueue_refine([])
            await asyncio.sleep(0.15)
        await asyncio.sleep(0.3)
        passes = fake.count("command")
        task.cancel()
        return passes

    unbatched = asyncio.run(go(0.0))
    batched = asyncio.run(go(0.6))
    assert batched < unbatched


def test_demo_drills_get_the_smaller_share_and_everyone_gets_batching(tmp_path) -> None:
    svc = make_services(tmp_path, ai_tokens_per_drill=80000, ai_tokens_per_guest_drill=30000, refine_min_interval_s=45.0)
    owner = svc.users.create("a@b.co", "A", "x")
    guest = svc.users.create("guest-1@guest.missionsync.invalid", "Demo guest", "!x", True)
    mine = svc.drills.create(owner.id, "mine")
    theirs = svc.drills.create(guest.id, "demo", limit=2)

    async def go():
        a = await svc.manager.get(mine.id)
        b = await svc.manager.get(theirs.id)
        out = (a.orch.budget.limit, b.orch.budget.limit, a.orch.refine_min_interval_s)
        await svc.manager.shutdown()
        return out

    regular, demo, interval = asyncio.run(go())
    assert (regular, demo, interval) == (80000, 30000, 45.0)
