#!/usr/bin/env python
"""Rebuild backend/missionsync/data/xbd_seeds.json from the real Kaggle dataset.

    cd backend && ./.venv/Scripts/python ../scripts/build_xbd_snapshot.py

Needs KAGGLE_API_TOKEN in backend/.env. The snapshot lets the app run on
real xBD-derived scenarios (no synthetic data) on machines without Kaggle
credentials, e.g. a production host.
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "backend"
sys.path.insert(0, str(ROOT))

from missionsync import llm  # noqa: E402,F401  (loads backend/.env)
from missionsync import xbd  # noqa: E402

records = xbd.load_xbd_records()
if not records:
    sys.exit("No records loaded from Kaggle - check KAGGLE_API_TOKEN and network access.")
xbd.dump_snapshot(records)
by_type: dict[str, int] = {}
for r in records:
    by_type[r["type"].value] = by_type.get(r["type"].value, 0) + 1
print(f"wrote {len(records)} real xBD seeds to {xbd.SNAPSHOT_PATH} {by_type}")
