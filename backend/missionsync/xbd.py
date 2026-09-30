"""xBD damage dataset loader — the scenario dataset for MissionSync.

Real records from the Kaggle dataset ``rayanhossain239/damageactu-xbd-full``
(xBD: building damage assessment from pre/post-disaster satellite imagery,
Gupta et al. 2019; CC BY-NC-SA 4.0).

The native xBD GeoJSON annotation files are downloaded individually through
``kagglehub.dataset_download``; the large satellite images are not needed.
Each file lists building footprints with an ordinal damage subtype. One file
becomes one incident seed:

    building subtypes ─► counts (intact / light / severe / collapsed)
    counts            ─► observable scene report (what the agents may read)
    counts            ─► hidden ground-truth urgency (mean of the Joint Damage
                         Scale grades 0→10, 1→40, 2→70, 3→90; the agents never see it)
    disaster type     ─► IncidentType (volcano → landslide, flooding → flood, …)

Source (``DATA_SOURCE``; ``XBD_SOURCE=snapshot|kaggle`` picks the order, default snapshot):
    ``xbd_snapshot``  bundled snapshot of the same real records (data/xbd_seeds.json)
    ``kaggle``        live download via kagglehub (needs KAGGLE_API_TOKEN)
    ``offline_fallback``  small synthetic cohort built by the same rules
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from .models import IncidentType

KAGGLE_SLUG = "rayanhossain239/damageactu-xbd-full"
SNAPSHOT_PATH = Path(__file__).resolve().parent / "data" / "xbd_seeds.json"

# A deterministic sample of native xBD post-disaster annotations spanning four
# hazard types. Fetching individual label JSON files avoids the 33 GB image set.
_HOLD = "xbd_full/hold/labels/"
DEFAULT_LABEL_FILES = tuple(
    _HOLD + name + "_post_disaster.json"
    for name in (
        "guatemala-volcano_00000004", "guatemala-volcano_00000012",
        "hurricane-florence_00000006", "hurricane-florence_00000009",
        "hurricane-florence_00000010", "hurricane-florence_00000011",
        "hurricane-harvey_00000004", "hurricane-harvey_00000005",
        "hurricane-matthew_00000012",
        "hurricane-michael_00000002", "hurricane-michael_00000006", "hurricane-michael_00000007",
        "socal-fire_00000005", "socal-fire_00000007", "socal-fire_00000011",
        "socal-fire_00000017", "socal-fire_00000023",
    )
) + tuple(
    "xbd_full/train/labels/socal-fire_%08d_post_disaster.json" % n
    for n in (1, 2, 3, 4, 6, 8, 10, 12, 13, 14, 15, 19, 22, 24, 25, 27, 28, 29)
)
FILE_PATH_ENV = "XBD_FILE_PATH"

# Joint Damage Scale grade → hidden ground-truth urgency on the 0–100 axis.
_GRADE_URGENCY = {0: 10.0, 1: 40.0, 2: 70.0, 3: 90.0}
_SUBTYPE_GRADE = {"no-damage": 0, "minor-damage": 1, "major-damage": 2, "destroyed": 3}

# xBD metadata ``disaster_type`` → MissionSync incident type.
_DISASTER_TYPE = {
    "volcano": IncidentType.LANDSLIDE,
    "flooding": IncidentType.FLOOD,
    "flood": IncidentType.FLOOD,
    "tsunami": IncidentType.FLOOD,
    "fire": IncidentType.FIRE,
    "wind": IncidentType.STRUCTURAL_COLLAPSE,
    "tornado": IncidentType.STRUCTURAL_COLLAPSE,
    "earthquake": IncidentType.STRUCTURAL_COLLAPSE,
}

# Event-name keywords, used when a file has no metadata.
_TYPE_KEYWORDS: list[tuple[str, IncidentType]] = [
    ("earthquake", IncidentType.STRUCTURAL_COLLAPSE),
    ("tornado", IncidentType.STRUCTURAL_COLLAPSE),
    ("tsunami", IncidentType.FLOOD),
    ("flood", IncidentType.FLOOD),
    ("hurricane", IncidentType.FLOOD),
    ("typhoon", IncidentType.FLOOD),
    ("storm", IncidentType.FLOOD),
    ("wildfire", IncidentType.FIRE),
    ("fire", IncidentType.FIRE),
    ("volcano", IncidentType.LANDSLIDE),
    ("landslide", IncidentType.LANDSLIDE),
    ("mudslide", IncidentType.LANDSLIDE),
]

# What the scene report calls each hazard (the agents classify from this text).
_SURVEY_CUE = {
    IncidentType.LANDSLIDE: "Landslide and debris-flow damage survey",
    IncidentType.FLOOD: "Floodwater damage survey",
    IncidentType.STRUCTURAL_COLLAPSE: "Structural damage survey",
    IncidentType.FIRE: "Fire damage survey",
}

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


def _grade_of(value: Any) -> int | None:
    """Damage grade 0–3 from a subtype word or digit; None for unclassified."""
    if value is None:
        return None
    g = _norm(value).replace("_", "-").replace(" ", "-")
    if g in _SUBTYPE_GRADE:
        return _SUBTYPE_GRADE[g]
    for ch in g:
        if ch.isdigit() and int(ch) <= 3:
            return int(ch)
    for word, val in (("no-damage", 0), ("minor", 1), ("major", 2), ("destroyed", 3)):
        if word in g:
            return val
    return None


def _urgency_for_grade(grade: Any) -> float:
    """Grade → urgency (kept for tabular rows). Unknown → 40."""
    g = _grade_of(grade)
    return _GRADE_URGENCY[g] if g is not None else 40.0


def count_grades(subtypes: list[Any]) -> dict[int, int]:
    counts = {0: 0, 1: 0, 2: 0, 3: 0}
    for s in subtypes:
        g = _grade_of(s)
        if g is not None:
            counts[g] += 1
    return counts


def ground_truth_urgency(counts: dict[int, int]) -> float | None:
    """Mean grade urgency over classified buildings (the hidden truth)."""
    total = sum(counts.values())
    if total == 0:
        return None
    return round(sum(_GRADE_URGENCY[g] * n for g, n in counts.items()) / total, 1)


def _people_and_injuries(counts: dict[int, int]) -> tuple[int, int]:
    """Crude but deterministic proxy for people exposed / hurt."""
    pop = counts[3] * 5 + counts[2] * 3 + counts[1]
    inj = round(counts[3] * 1.0 + counts[2] * 0.5)
    return max(1, pop), inj


def describe_scene(itype: IncidentType, counts: dict[int, int]) -> str:
    """Observable scene report. Deliberately never uses the grade labels."""
    total = sum(counts.values())
    cue = _SURVEY_CUE.get(itype, "Damage survey")
    parts = []
    if counts[3]:
        parts.append(f"{counts[3]} collapsed or gutted")
    if counts[2]:
        parts.append(f"{counts[2]} severely damaged")
    if counts[1]:
        parts.append(f"{counts[1]} lightly damaged")
    if counts[0]:
        parts.append(f"{counts[0]} intact")
    pop, inj = _people_and_injuries(counts)
    people = f"Roughly {pop} people" if pop > 1 else "About 1 person"
    return (
        f"{cue}: {total} structures assessed — {', '.join(parts)}. "
        f"{people} in the affected footprint, {inj} injured."
    )[:280]


def _seed(itype: IncidentType, counts: dict[int, int], lat: float, lon: float,
          event: str, source_file: str = "") -> dict[str, Any] | None:
    gt = ground_truth_urgency(counts)
    if gt is None:
        return None
    pop, inj = _people_and_injuries(counts)
    worst = max((g for g, n in counts.items() if n), default=0)
    return {
        "text": describe_scene(itype, counts),
        "zone": "",  # resolved by the simulator to a fictional sector
        "type": itype,
        "population": pop,
        "injuries": inj,
        "gt_urgency": gt,
        "confidence": 0.75,
        "lat": lat,
        "lon": lon,
        "event": event,
        "grade": worst,
        "counts": {str(k): v for k, v in counts.items()},
        "source_file": source_file,
    }


def row_to_seed(row: dict[str, Any]) -> dict[str, Any] | None:
    """One tabular row (single building) → one seed. None if unusable."""
    event = _norm(row.get("disaster") or row.get("disaster_type") or row.get("event") or row.get("event_name"))
    grade = row.get("damage_grade") if row.get("damage_grade") is not None else row.get("damage")
    lat = next((row[key] for key in ("latitude", "lat") if row.get(key) is not None), None)
    lon = next((row[key] for key in ("longitude", "lon", "lng") if row.get(key) is not None), None)
    try:
        lat_f, lon_f = float(lat), float(lon)
    except (TypeError, ValueError):
        return None
    g = _grade_of(grade)
    counts = {0: 0, 1: 0, 2: 0, 3: 0}
    counts[g if g is not None else 1] = 1
    itype = _match_type(event) if event else IncidentType.STRUCTURAL_COLLAPSE
    seed = _seed(itype, counts, lat_f, lon_f, event)
    custom = str(row.get("raw_text") or row.get("damage_description") or row.get("caption") or row.get("notes") or "").strip()
    if seed and custom:
        seed["text"] = custom[:280]
    return seed


def _features_of(document: dict[str, Any]) -> list[dict[str, Any]]:
    """Flatten a GeoJSON FeatureCollection into a plain feature list.

    Native xBD annotation files nest features under a dict keyed by
    coordinate space (``{"lng_lat": [...], "xy": [...]}``); ``lng_lat``
    features carry real lon/lat WKT polygons. Standard GeoJSON uses a
    plain list, which some older xBD exports also use.
    """
    features = document.get("features")
    if isinstance(features, list):
        return [f for f in features if isinstance(f, dict)]
    if isinstance(features, dict):
        for key in ("lng_lat", "xy"):
            coll = features.get(key)
            if isinstance(coll, list):
                return [f for f in coll if isinstance(f, dict)]
    return []


def _wkt_point(wkt: str) -> tuple[float, float] | None:
    """Representative (lon, lat) from the first coordinates of a WKT polygon."""
    nums = re.findall(r"-?\d+(?:\.\d+)?", wkt or "")
    if len(nums) >= 2:
        lon, lat = float(nums[0]), float(nums[1])
        if -180 <= lon <= 180 and -90 <= lat <= 90:
            return lon, lat
    return None


def geojson_to_seed(document: dict[str, Any], file_path: str) -> dict[str, Any] | None:
    """Convert one native xBD post-disaster GeoJSON file into a scenario seed."""
    features = _features_of(document)
    buildings = [
        f for f in features
        if isinstance(f.get("properties"), dict)
        and f["properties"].get("feature_type", "building") == "building"
    ]
    if not buildings:
        return None

    counts = count_grades([f["properties"].get("subtype") or f["properties"].get("damage_grade") for f in buildings])
    metadata = document.get("metadata") if isinstance(document.get("metadata"), dict) else {}
    event = _norm(metadata.get("disaster")) or Path(file_path).name.split("_")[0]
    dtype = _norm(metadata.get("disaster_type"))
    itype = _DISASTER_TYPE.get(dtype) or _match_type(event.replace("-", " "))
    point = _wkt_point(str(buildings[0].get("wkt", "")))
    return _seed(itype, counts, point[1] if point else 0.0, point[0] if point else 0.0,
                 event.replace("-", " "), Path(file_path).name)


def _cached_file(path: str) -> str | None:
    """A previously downloaded file from kagglehub's local cache (no API call)."""
    root = Path(os.environ.get("KAGGLEHUB_CACHE") or Path.home() / ".cache" / "kagglehub")
    base = root / "datasets" / KAGGLE_SLUG.replace("/", os.sep) / "versions"
    if not base.exists():
        return None
    for version in sorted(base.iterdir(), reverse=True):
        candidate = version / path
        if candidate.is_file():
            return str(candidate)
    return None


def _download_with_backoff(kagglehub: Any, path: str) -> str:
    """Cache first; otherwise download, backing off when Kaggle answers 429."""
    cached = _cached_file(path)
    if cached:
        return cached
    delay = 2.0
    for attempt in range(4):
        try:
            return kagglehub.dataset_download(KAGGLE_SLUG, path=path)
        except Exception as exc:
            if "429" not in str(exc) or attempt == 3:
                raise
            time.sleep(delay)
            delay *= 2
    raise RuntimeError("unreachable")


def _read_kaggle_file(kagglehub: Any, path: str) -> list[dict[str, Any]]:
    """Read a native xBD annotation JSON or a configured tabular file."""
    if Path(path).suffix.lower() in {".json", ".geojson"}:
        local_path = _download_with_backoff(kagglehub, path)
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
    """Load native xBD annotations from Kaggle via kagglehub (blocking I/O).

    By default only a deterministic sample of small annotation JSON files is
    downloaded (in parallel), never the satellite imagery. XBD_FILE_PATH can
    instead select one JSON, GeoJSON, or tabular file from the dataset.
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
        failures: list[str] = []

        def fetch(path: str) -> list[dict[str, Any]]:
            try:
                return _read_kaggle_file(kagglehub, path)
            except Exception as exc:
                failures.append(f"{path}: {exc}")
                return []

        with ThreadPoolExecutor(max_workers=min(2, len(paths))) as pool:
            records = [seed for chunk in pool.map(fetch, paths) for seed in chunk]
        if failures:
            logger.warning(
                "Some xBD Kaggle annotation files could not be loaded: %s", "; ".join(failures[:3])
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


def dump_snapshot(records: list[dict[str, Any]], path: Path = SNAPSHOT_PATH) -> None:
    """Persist real records so the app can run without Kaggle credentials."""
    path.parent.mkdir(parents=True, exist_ok=True)
    serial = [{**r, "type": r["type"].value} for r in records]
    path.write_text(json.dumps(serial, indent=1), encoding="utf-8")


def load_snapshot(path: Path = SNAPSHOT_PATH) -> list[dict[str, Any]]:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        return [{**r, "type": IncidentType(r["type"])} for r in raw]
    except Exception:
        return []


def _fallback_records(count: int = 10) -> list[dict[str, Any]]:
    """Deterministic synthetic stand-in of last resort (same shape and rules)."""
    templates = [
        (IncidentType.STRUCTURAL_COLLAPSE, "earthquake", {0: 4, 1: 6, 2: 8, 3: 6}),
        (IncidentType.FIRE, "wildfire", {0: 6, 1: 4, 2: 5, 3: 9}),
        (IncidentType.FLOOD, "flood", {0: 20, 1: 9, 2: 3, 3: 0}),
        (IncidentType.LANDSLIDE, "volcano", {0: 12, 1: 2, 2: 0, 3: 0}),
        (IncidentType.FLOOD, "hurricane", {0: 3, 1: 5, 2: 12, 3: 4}),
    ]
    out = []
    for i in range(count):
        itype, event, counts = templates[i % len(templates)]
        counts = {g: n + (i // len(templates)) * (1 if g in (0, 1) else 0) for g, n in counts.items()}
        seed = _seed(itype, counts, 34.0 + 0.02 * i, -118.3 + 0.02 * i, event, "synthetic")
        if seed:
            out.append(seed)
    return out


def load_seeds(file_path: str | None = None) -> list[dict[str, Any]]:
    """Primary entry point for the simulator.

    ``XBD_SOURCE`` picks the order (default ``snapshot``):
      snapshot  bundled real-xBD snapshot → Kaggle → synthetic   (instant, no rate limits)
      kaggle    live Kaggle download       → snapshot → synthetic (fresh files; needs a token)
    A specific ``file_path`` / ``XBD_FILE_PATH`` always goes to Kaggle first.
    """
    global DATA_SOURCE
    mode = os.environ.get("XBD_SOURCE", "snapshot").strip().lower()
    want_live = mode in ("kaggle", "auto") or bool(file_path or os.environ.get(FILE_PATH_ENV, "").strip())

    if not want_live:
        snapshot = load_snapshot()
        if snapshot:
            DATA_SOURCE = "xbd_snapshot"
            return snapshot

    records = load_xbd_records(file_path)
    if records:
        return records
    snapshot = load_snapshot()
    if snapshot:
        DATA_SOURCE = "xbd_snapshot"
        logger.warning("Kaggle unavailable; using the bundled real-xBD snapshot")
        return snapshot
    DATA_SOURCE = "offline_fallback"
    logger.warning("Using the synthetic offline cohort; no xBD data was available")
    return _fallback_records()


def pick_seeds(records: list[dict[str, Any]], count: int, salt: str) -> list[dict[str, Any]]:
    """Deterministically sample ``count`` seeds, spread across hazard types.

    Records are ordered by a salted hash (stable, order-independent), then dealt
    round-robin across incident types so the drill isn't five identical
    incidents. ``salt`` provides a stable ordering; the simulator partitions one
    combined sample into disjoint initial and wave cohorts.
    """
    if not records:
        return []

    def _key(rec: dict[str, Any]) -> bytes:
        basis = f"{salt}:{rec.get('source_file')}:{rec.get('lat')}:{rec.get('lon')}:{rec.get('gt_urgency')}:{rec.get('event')}"
        return hashlib.sha256(basis.encode()).digest()

    ordered = sorted(records, key=_key)
    # xBD is dominated by "no damage" scenes. Keep the informative ones plus at
    # most four quiet scenes (minor incidents belong in a drill, a board full of
    # them doesn't).
    quiet = [r for r in ordered if (r.get("gt_urgency") or 0) <= 10.0]
    informative = [r for r in ordered if (r.get("gt_urgency") or 0) > 10.0]
    ordered = informative + quiet[:4]
    by_type: dict[str, list[dict[str, Any]]] = {}
    for rec in ordered:
        by_type.setdefault(rec["type"].value, []).append(rec)
    picked: list[dict[str, Any]] = []
    while len(picked) < min(count, len(ordered)):
        for bucket in list(by_type.values()):
            if bucket and len(picked) < count:
                picked.append(dict(bucket.pop(0)))  # copies — callers annotate zones
    return picked
