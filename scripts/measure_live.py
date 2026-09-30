#!/usr/bin/env python
"""Measure the REAL pipeline: boot + report latency (NFR-1) and ranking accuracy against
the hidden xBD ground truth, with the live LLM.

    cd backend && ./.venv/Scripts/python ../scripts/measure_live.py

Spends roughly 10-15k Groq tokens. Uses the bundled real-xBD snapshot (no Kaggle calls).
"""
import asyncio
import statistics
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from missionsync import llm  # noqa: E402  (loads backend/.env)
from missionsync import xbd  # noqa: E402
from missionsync.models import IncomingReport  # noqa: E402
from missionsync.orchestrator import Orchestrator  # noqa: E402

xbd.load_xbd_records = lambda *a, **k: []          # snapshot only: no Kaggle traffic

REPORTS = [
    "Fire spreading near the University lab block, three students trapped",
    "Missing child last seen near the Riverfront levee, wearing a red jacket",
    "Ammonia vapor cloud at Industrial Park gate 3, three workers down",
]


async def main() -> int:
    if not llm.API_KEY:
        print("GROQ_API_KEY is not set")
        return 2
    o = Orchestrator()
    t0 = time.perf_counter()
    await o.bootstrap()
    boot_s = time.perf_counter() - t0
    snap = o.snapshot()
    print(f"boot (5 incidents, 5 agent stages, batched): {boot_s:.1f}s | mode={snap.metrics['mode']} sources={snap.metrics['scoring_sources']}")
    print("ranking accuracy vs hidden xBD truth:", snap.metrics["ranking_accuracy"])
    for rank, inc in enumerate(snap.incidents, 1):
        print(f"  #{rank} {inc.risk.tier} {inc.risk.urgency:5.1f} gt={o.sim.ground_truth.get(inc.id)} {inc.risk.source:<6} {inc.type.value:<20} {inc.risk.breakdown.rationale[:70]}")

    times = []
    for text in REPORTS:
        t = time.perf_counter()
        outcome, _ = await o.inject_report(IncomingReport(text=text))
        times.append(time.perf_counter() - t)
        print(f"inject {times[-1]:5.1f}s -> {outcome.kind} {outcome.tier} {outcome.urgency} | {text[:50]}")
    print(f"report -> ranked picture: median {statistics.median(times):.1f}s, max {max(times):.1f}s (NFR-1 target: p95 < 3s)")

    t = time.perf_counter()
    for _ in range(5):
        async with o._lock:
            await o._tick_once()
    print(f"5 idle/scripted ticks: {time.perf_counter() - t:.1f}s")
    st = llm.llm_stats()
    print("final mode:", st["mode"], "| avg LLM call ms:", st["avg_latency_ms"], "| tokens:", st["quota"]["tokens_used"])
    return 0


sys.exit(asyncio.run(main()))
