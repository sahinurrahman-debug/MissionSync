#!/usr/bin/env python
"""Regenerate the frontend's test fixtures from the REAL backend, so component tests run against exactly what the
API sends (and a backend test fails if the shape drifts).

    cd backend && .venv/Scripts/python ../scripts/make_frontend_fixtures.py

Writes frontend/src/test-utils/fixtures/snapshot.manual.json (dispatches waiting for approval) and
snapshot.auto.json (auto-dispatch: units already on their way). Uses the rule-based agents (no network, no key).
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

os.environ["GROQ_API_KEY"] = ""                       # force the deterministic rule-based agents
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from missionsync.hub import snapshot_json            # noqa: E402
from missionsync.orchestrator import Orchestrator    # noqa: E402

OUT = Path(__file__).resolve().parents[1] / "frontend" / "src" / "test-utils" / "fixtures"


async def build(auto: bool) -> dict:
    o = Orchestrator(auto_dispatch=auto)
    await o.bootstrap()
    for _ in range(3 if auto else 0):
        async with o._lock:
            await o._tick_once()
    return snapshot_json(o.snapshot())


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for name, auto in (("manual", False), ("auto", True)):
        snap = asyncio.run(build(auto))
        (OUT / f"snapshot.{name}.json").write_text(json.dumps(snap, indent=1, sort_keys=True) + "\n", encoding="utf-8")
        print(f"wrote snapshot.{name}.json  ({len(snap['incidents'])} incidents, {len(snap['proposals'])} proposals, "
              f"{sum(1 for r in snap['resources'] if r['status'] != 'available')} units out)")


if __name__ == "__main__":
    main()
