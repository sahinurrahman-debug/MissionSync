"""xBD damage dataset loader — the scenario dataset for MissionSync.

Replaces the hand-written fictional incident list with real records from the
Kaggle dataset ``rayanhossain239/damageactu-xbd-full`` (xBD: building damage
assessment from pre/post-disaster satellite imagery, Gupta et al. 2019).

The native xBD GeoJSON annotation files are downloaded individually through
``kagglehub.dataset_download``; the large satellite images are not needed.
Each file contains building features with an ordinal damage subtype
(no-damage through destroyed). We turn those into incident seeds:

    damage grade ──► hidden ground-truth urgency   (graded, deterministic)
    disaster type ─► IncidentType                  (earthquake → collapse, …)
    annotation files ─► initial seeds + wave seeds (deterministic sampling)

If the dataset (or kagglehub itself) is unavailable — no Kaggle credentials,
offline judge machine — a small deterministic fallback cohort derived from the
same conversion rules keeps the demo alive. This mirrors the system-wide
"LLM down ⇒ fallback twin" philosophy: no external dependency can stall a
drill.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import time
from pathlib import Path
from typing import Any

from .models import IncidentType

KAGGLE_SLUG = "rayanhossain239/damageactu-xbd-full"

# A small, deterministic sample of native xBD post-disaster annotations.
# Fetching individual label JSON files avoids downloading the 33 GB image set.
DEFAULT_LABEL_FILES = (
    "xbd_full/hold/labels/guatemala-volcano_00000004_post_disaster.json",
    "xbd_full/hold/labels/guatemala-volcano_00000012_post_disaster.json",
    "xbd_full/hold/labels/guatemala-volcano_00000014_post_disaster.json",
    "xbd_full/hold/labels/guatemala-volcano_00000020_post_disaster.json",
    "xbd_full/hold/labels/guatemala-volcano_00000022_post_disaster.json",
    "xbd_full/hold/labels/hurricane-florence_00000006_post_disaster.json",
    "xbd_full/hold/labels/hurricane-florence_00000009_post_disaster.json",
    "xbd_full/hold/labels/hurricane-florence_00000010_post_disaster.json",
    "xbd_full/hold/labels/hurricane-florence_00000011_post_disaster.json",
)
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

logger = logging.getLogger(__name__)
_CACHE: tuple[float, str, list[dict[str, Any]]] | None = None
_CACHE_TTL_S = 3600.0
DATA_SOURCE = "not_loaded"


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
    lat = next((row[key] for key in ("latitude", "lat") if row.get(key) is not None), None)
    lon = next((row[key] for key in ("longitude", "lon", "lng") if row.get(key) is not None), None)

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


def geojson_to_seed(document: dict[str, Any], file_path: str) -> dict[str, Any] | None:
    """Convert one native xBD post-disaster GeoJSON file into a scenario seed."""
    features = document.get("features")
    if not isinstance(features, list):
        return None

    buildings = [
        feature.get("properties", {})
        for feature in features
        if isinstance(feature, dict)
        and isinstance(feature.get("properties"), dict)
        and feature["properties"].get("feature_type", "building") == "building"
    ]
    if not buildings:
        return None

    damage = [prop.get("subtype") or prop.get("damage_grade") or prop.get("damage") for prop in buildings]
    worst = max(damage, key=_urgency_for_grade)
    event = Path(file_path).name.split("_")[0].replace("-", " ")
    urgency = _urgency_for_grade(worst)
    seed = row_to_seed({
        "disaster": event,
        "damage_grade": worst,
        "raw_text": f"xBD {event} assessment: {len(buildings)} building footprints identified.",
        # xBD annotation geometry is image-pixel space, not latitude/longitude.
        # The simulator assigns a fictional operational-sector location.
        "lat": 0.0,
        "lon": 0.0,
    })
    return seed


def _read_kaggle_file(kagglehub: Any, path: str) -> list[dict[str, Any]]:
    """Read a native xBD annotation JSON or a configured tabular file."""
    if Path(path).suffix.lower() in {".json", ".geojson"}:
        local_path = kagglehub.dataset_download(KAGGLE_SLUG, path=path)
        with open(local_path, encoding="utf-8") as annotation_file:
            document = json.load(annotation_file)
        if not isinstance(document, dict):
            return []
        seed = geojson_to_seed(document, path)
        return [seed] if seed else []

    from kagglehub import KaggleDatasetAdapter

    dataframe = kagglehub.dataset_load(KaggleDatasetAdapter.PANDAS, KAGGLE_SLUG, path)
    return [
        seed
        for seed in (row_to_seed(record) for record in dataframe.to_dict("records"))
        if seed is not None
    ]


def load_xbd_records(file_path: str | None = None, max_rows: int | None = None) -> list[dict[str, Any]]:
    """Load native xBD annotations from Kaggle via kagglehub.

    By default, only a deterministic sample of small annotation JSON files is
    downloaded, never the dataset's large satellite imagery. XBD_FILE_PATH can
    instead select one JSON, GeoJSON, or tabular file from the Kaggle dataset.
    """
    global _CACHE, DATA_SOURCE
    configured_path = file_path or os.environ.get(FILE_PATH_ENV, "").strip()
    cache_key = configured_path or "|".join(DEFAULT_LABEL_FILES)
    if _CACHE is not None and _CACHE[1] == cache_key and (time.time() - _CACHE[0]) < _CACHE_TTL_S:
        if _CACHE[2]:
            DATA_SOURCE = "kaggle"
        return _CACHE[2][:max_rows] if max_rows is not None else _CACHE[2]

    DATA_SOURCE = "unavailable"
    try:
        import kagglehub  # type: ignore[import-not-found]

        paths = [configured_path] if configured_path else list(DEFAULT_LABEL_FILES)
        records: list[dict[str, Any]] = []
        failures: list[str] = []
        for path in paths:
            try:
                records.extend(_read_kaggle_file(kagglehub, path))
            except Exception as exc:
                failures.append(f"{path}: {exc}")
        if failures:
            logger.warning(
                "Some xBD Kaggle annotation files could not be loaded: %s",
                "; ".join(failures),
            )
        if records:
            DATA_SOURCE = "kaggle"
        _CACHE = (time.time(), cache_key, records)
        return records[:max_rows] if max_rows is not None else records
    except Exception:
        DATA_SOURCE = "unavailable"
        logger.exception("Could not initialize the Kaggle xBD dataset loader")
        _CACHE = (time.time(), cache_key, [])
        return []


def _fallback_records(count: int = 10) -> list[dict[str, Any]]:
    """Deterministic stand-in when kagglehub/dataset is unavailable.

    Same shape and conversion rules as the real rows, so downstream behavior
    (seeding, waves, ground truth) is identical — only the source differs.
    """
    events = ["earthquake", "wildfire", "flood", "hurricane", "volcano"]
    return [
        {
            "text": (
                f"[offline fallback] Satellite assessment ({event}): "
                "post-disaster building survey."
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
    global DATA_SOURCE
    records = load_xbd_records(file_path)
    if records:
        return records
    DATA_SOURCE = "offline_fallback"
    logger.warning("Using deterministic offline xBD cohort; Kaggle annotation data was unavailable")
    return _fallback_records()


def pick_seeds(records: list[dict[str, Any]], count: int, salt: str) -> list[dict[str, Any]]:
    """Deterministically sample `count` seeds from the dataset.

    ``salt`` provides a stable ordering; the simulator partitions one combined
    sample into disjoint initial and wave cohorts.
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
