"""xBD damage dataset loader — the scenario dataset for MissionSync.

Replaces the hand-written fictional incident list with real records from the
Kaggle dataset ``rayanhossain239/damageactu-xbd-full`` (xBD: building damage
assessment from pre/post-disaster satellite imagery, Gupta et al. 2019).

The dataset is loaded through ``kagglehub`` exactly as documented:

    pip install kagglehub[pandas-datasets]

    df = kagglehub.load_dataset(
        KaggleDatasetAdapter.PANDAS,
        "rayanhossain239/damageactu-xbd-full",
        file_path,
    )

Each xBD record carries a disaster event, an ordinal damage grade
(0 = no damage … 3 = destroyed, the Joint Damage Scale) and coordinates for
the assessed building. We turn those into incident seeds:

    damage grade ──► hidden ground-truth urgency   (graded, deterministic)
    disaster type ─► IncidentType                  (earthquake → collapse, …)
    row cohort   ─► 5 initial seeds + 5 wave seeds (deterministic sampling)

If the dataset (or kagglehub itself) is unavailable — no Kaggle credentials,
offline judge machine — a small deterministic fallback cohort derived from the
same conversion rules keeps the demo alive. This mirrors the system-wide
"LLM down ⇒ fallback twin" philosophy: no external dependency can stall a
drill.
"""
from __future__ import annotations

import hashlib
import os
import random
import time
from typing import Any

from .models import IncidentType

KAGGLE_SLUG = "rayanhossain239/damageactu-xbd-full"

# Where in the dataset repo the tabular file lives. Override with XBD_FILE_PATH
# if the dataset ships a different filename (see .env.example).
DEFAULT_FILE_PATH = "xbd_full.csv"
FILE_PATH_ENV = "XBD_FILE_PATH"

# Damage grade → hidden ground-truth urgency. The ordinal Joint Damage Scale
# maps onto the 0–100 urgency axis the risk agent is evaluated against.
# 'no damage' rows still carry structural/impact context, hence the floor at 10.
_GRADE_URGENCY = {0: 10.0, 1: 40.0, 2: 70.0, 3: 90.0}

# xBD disaster-event names → MissionSync incident types.
_TYPE_KEYWORDS: list[tuple[str, IncidentType]] = [
    ("earthquake", IncidentType.STRUCTURAL_COLLAPSE),
    ("tsunami", IncidentType.FLOOD),
    ("flood", IncidentType.FLOOD),
    ("hurricane", IncidentType.FLOOD),
    ("typhoon", IncidentType.FLOOD),
    ("storm", IncidentType.FLOOD),
    ("wildfire", IncidentType.FIRE),
    ("wildfire-forest", IncidentType.FIRE),
    ("fire", IncidentType.FIRE),
    ("volcano", IncidentType.LANDSLIDE),
    ("landslide", IncidentType.LANDSLIDE),
    ("mudslide", IncidentType.LANDSLIDE),
]

_CACHE: tuple[float, list[dict[str, Any]]] | None = None
_CACHE_TTL_S = 3600.0


def _resolve_file_path(file_path: str | None = None) -> str:
    """User-supplied path > env var > default."""
    return file_path or os.environ.get(FILE_PATH_ENV, "").strip() or DEFAULT_FILE_PATH


def _norm(s: Any) -> str:
    return str(s or "").strip().lower()


def _match_type(event: str) -> IncidentType:
    for kw, itype in _TYPE_KEYWORDS:
        if kw in event:
            return itype
    return IncidentType.STRUCTURAL_COLLAPSE


def _grade_word(urgency: float) -> str:
    return {
        10.0: "no visible damage",
        40.0: "minor damage",
        70.0: "major damage",
        90.0: "destroyed",
    }.get(urgency, "assessed")


def _urgency_for_grade(grade: Any) -> float:
    """Grade may arrive as 0-3 int, word form, or a coordinate-ish string."""
    if grade is None:
        return 40.0
    g = _norm(grade)
    # Robust ordinal extraction: prefer any digit 0-3 in the value.
    for ch in g:
        if ch.isdigit() and int(ch) <= 3:
            return _GRADE_URGENCY[int(ch)]
    words = {"no damage": 0, "minor": 1, "major": 2, "destroyed": 3}
    for word, val in words.items():
        if word in g:
            return _GRADE_URGENCY[val]
    return 40.0


def row_to_seed(row: dict[str, Any]) -> dict[str, Any] | None:
    """One xBD row → one MissionSync signal seed. Returns None if unusable.

    Output shape matches what simulator._signal_from_seed() consumes:
    text / zone / type / population / injuries / gt_urgency / confidence.
    """
    text = str(
        row.get("raw_text")
        # common xBD tabular column names, tried in order
        or row.get("damage_description")
        or row.get("caption")
        or row.get("notes")
        or ""
    ).strip()
    event = _norm(row.get("disaster") or row.get("disaster_type") or row.get("event") or row.get("event_name"))
    grade = row.get("damage_grade") if row.get("damage_grade") is not None else row.get("damage")
    lat = row.get("latitude") or row.get("lat")
    lon = row.get("longitude") or row.get("lon") or row.get("lng")

    try:
        lat_f, lon_f = float(lat), float(lon)
    except (TypeError, ValueError):
        return None

    itype = _match_type(event) if event else IncidentType.STRUCTURAL_COLLAPSE
    urgency = _urgency_for_grade(grade)

    grade_word = _grade_word(urgency)
    if not text:
        text = (
            f"Satellite damage assessment ({event or 'unclassified event'}): building "
            f"{grade_word}, post-disaster pass over ({lat_f:.4f}, {lon_f:.4f})."
        )

    return {
        "text": text[:280],
        "zone": "",  # resolved by the simulator to the nearest fictional sector
        "type": itype,
        "population": max(1, int(round(urgency / 5))),  # crude but deterministic proxy
        "injuries": 3 if urgency >= 70 else (1 if urgency >= 40 else 0),
        "gt_urgency": urgency,
        "confidence": 0.75,
        "lat": lat_f,
        "lon": lon_f,
        "event": event,
        "grade": grade,
    }


def load_xbd_records(file_path: str | None = None, max_rows: int | None = None) -> list[dict[str, Any]]:
    """Load the xBD dataset via kagglehub as normalized seed rows.

    Cached for an hour so the sim loop never re-downloads. Raises nothing:
    on any failure returns [] and callers fall back.
    """
    global _CACHE
    if _CACHE is not None and (time.time() - _CACHE[0]) < _CACHE_TTL_S:
        return _CACHE[1]

    try:
        import kagglehub  # type: ignore[import-not-found]
        from kagglehub import KaggleDatasetAdapter  # type: ignore[import-not-found]

        df = kagglehub.load_dataset(
            KaggleDatasetAdapter.PANDAS,
            KAGGLE_SLUG,
            _resolve_file_path(file_path),
        )
        if max_rows is not None:
            df = df.head(max_rows)
        records = [
            seed
            for seed in (row_to_seed(rec) for rec in df.to_dict("records"))
            if seed is not None
        ]
        _CACHE = (time.time(), records)
        return records
    except Exception:  # noqa: BLE001 — any loader failure must not kill the demo
        _CACHE = (time.time(), [])
        return []


def _fallback_records(count: int = 10) -> list[dict[str, Any]]:
    """Deterministic stand-in when kagglehub/dataset is unavailable.

    Same shape and conversion rules as the real rows, so downstream behavior
    (seeding, waves, ground truth) is identical — only the source differs.
    """
    rng = random.Random(hashlib.sha256(KAGGLE_SLUG.encode()).digest())
    events = ["earthquake", "wildfire", "flood", "hurricane", "volcano"]
    return [
        {
            "text": (
                f"[offline fallback] Satellite damage assessment ({event}): building "
                f"{_grade_word(u)}, post-disaster pass over ({34.0 + 0.02 * i:.4f}, {-118.3 + 0.02 * i:.4f})."
            ),
            "zone": "",
            "type": _match_type(event),
            "population": max(1, int(u / 5)),
            "injuries": 3 if u >= 70 else (1 if u >= 40 else 0),
            "gt_urgency": u,
            "confidence": 0.75,
            "lat": 34.0 + 0.02 * i,
            "lon": -118.3 + 0.02 * i,
            "event": event,
            "grade": {10.0: 0, 40.0: 1, 70.0: 2, 90.0: 3}.get(u, 1),
        }
        for i, (event, u) in enumerate(
            (events[i % len(events)], [90.0, 70.0, 40.0, 10.0, 90.0][i % 5]) for i in range(count)
        )
    ]


def load_seeds(file_path: str | None = None) -> list[dict[str, Any]]:
    """Primary entry point for the simulator: real rows or deterministic fallback."""
    records = load_xbd_records(file_path)
    if records:
        return records
    return _fallback_records()


def pick_seeds(records: list[dict[str, Any]], count: int, salt: str) -> list[dict[str, Any]]:
    """Deterministically sample `count` seeds from the dataset.

    ``salt`` (e.g. "seed" or "wave") keeps the two cohorts disjoint and stable
    across runs — same dataset, same demo, every time.
    """
    if not records:
        return []
    if len(records) <= count:
        return [dict(r) for r in records]  # copies — callers may annotate zones

    def _key(idx: int) -> bytes:
        rec = records[idx]
        basis = f"{salt}:{rec.get('lat')}:{rec.get('lon')}:{rec.get('gt_urgency')}:{idx}"
        return hashlib.sha256(basis.encode()).digest()

    order = sorted(range(len(records)), key=_key)
    return [dict(records[i]) for i in order[:count]]
