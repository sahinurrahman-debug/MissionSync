"""The five MissionSync agents.

Each agent = one LLM call (Groq, JSON mode) with a deterministic rule-based
twin that takes over if the LLM is unavailable. The interfaces are identical,
so the orchestrator and the dashboard never know (or care) which ran.

Principle: agents propose, deterministic code decides. Everything an LLM
returns is validated and clamped here before it can touch world state:
incident types must be in the enum, scores are clamped to 0-100, assignments
must name an available, capable unit within the per-incident caps.
"""
from __future__ import annotations

import json
import math
import re
import time
from typing import Any, Optional

from .llm import llm_json
from .models import (
    Deployment,
    Incident,
    IncidentType,
    Resource,
    ResourceType,
    RiskBreakdown,
    RiskScore,
    WeatherCell,
)


def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def _clamp(x: Any, lo: float, hi: float, default: float) -> float:
    try:
        v = float(x)
    except (TypeError, ValueError):
        return default
    if math.isnan(v):
        return default
    return max(lo, min(hi, v))


def _as_int(x: Any, default: int = 0, hi: int = 1_000_000) -> int:
    try:
        return max(0, min(hi, int(float(x))))
    except (TypeError, ValueError, OverflowError):
        return default


# ---------------------------------------------------------------------------
# Capability matrix — the single source of truth (LLM prompts, matcher, metrics)
# ---------------------------------------------------------------------------

REQUIRED_TYPES: dict[IncidentType, list[ResourceType]] = {
    IncidentType.FIRE: [ResourceType.FIRE_UNIT],
    IncidentType.FLOOD: [ResourceType.SWIFT_WATER, ResourceType.RESCUE_TEAM],
    IncidentType.STRUCTURAL_COLLAPSE: [ResourceType.RESCUE_TEAM, ResourceType.AMBULANCE, ResourceType.ENGINEERING],
    IncidentType.MEDICAL: [ResourceType.AMBULANCE],
    IncidentType.HAZMAT: [ResourceType.HAZMAT_UNIT, ResourceType.FIRE_UNIT],
    IncidentType.LANDSLIDE: [ResourceType.RESCUE_TEAM, ResourceType.ENGINEERING],
    IncidentType.MISSING_PERSONS: [ResourceType.DRONE, ResourceType.RESCUE_TEAM],
    IncidentType.ROADSIDE_CASUALTIES: [ResourceType.AMBULANCE, ResourceType.FIRE_UNIT],
}


def required_for(itype: IncidentType) -> list[ResourceType]:
    return REQUIRED_TYPES.get(itype, [ResourceType.RESCUE_TEAM])


_required_for = required_for  # back-compat alias


def is_capable(resource: Resource, incident: Incident) -> bool:
    """Capable = in the incident's capability matrix, or a drone (universal recon)."""
    return resource.type in required_for(incident.type) or resource.type == ResourceType.DRONE


# Crew sizing: how many units an incident of each tier should get, and the hard cap.
TARGET_CREW = {"P1": 3, "P2": 2, "P3": 1, "P4": 1}
CREW_CAP = {"P1": 4, "P2": 4, "P3": 2, "P4": 2}


def tier_of(incident: Incident) -> str:
    return incident.risk.tier if incident.risk else "P4"


def eta_minutes(resource: Resource, incident: Incident) -> float:
    dist = _haversine_km(
        resource.current_lat if resource.current_lat is not None else resource.base_lat,
        resource.current_lon if resource.current_lon is not None else resource.base_lon,
        incident.lat, incident.lon,
    )
    return round(dist / max(resource.speed_kph, 1.0) * 60.0, 1)


def role_for(resource: Resource, incident: Incident) -> str:
    t = resource.type
    if t == ResourceType.FIRE_UNIT:
        return "primary suppression" if incident.type == IncidentType.FIRE else "support & extinguish"
    if t == ResourceType.AMBULANCE:
        return "triage & evac"
    if t == ResourceType.RESCUE_TEAM:
        return "search & extrication" if incident.type == IncidentType.STRUCTURAL_COLLAPSE else "search & rescue"
    if t == ResourceType.SWIFT_WATER:
        return "boat rescue"
    if t == ResourceType.ENGINEERING:
        return "shoring & access"
    if t == ResourceType.DRONE:
        return "recon & size-up"
    if t == ResourceType.HAZMAT_UNIT:
        return "containment & decon"
    return "assigned"


# ---------------------------------------------------------------------------
# 1. Surveillance agent — parse raw signals into structured incidents
# ---------------------------------------------------------------------------

SURVEILLANCE_SYSTEM = """You are the Surveillance Agent in a disaster-response coordination system.
You receive raw field signals (drone observations, radio calls, ground reports, sensor pings, satellite damage surveys) and convert them into structured incident records.

Return ONLY JSON with exactly this shape:
{
  "incidents": [
    {
      "type": "fire|flood|structural_collapse|medical|hazmat|landslide|missing_persons|roadside_casualties",
      "title": "short operational title",
      "description": "one sentence",
      "lat": <number>, "lon": <number>,
      "zone": "sector name if mentioned, else empty",
      "affected_population": <int>,
      "injuries": <int>,
      "counts_reported": <true if the signal itself states people/injury numbers, else false>,
      "confidence": <0-1 float>,
      "linked_incident_id": "existing incident id if this signal belongs to it, else null"
    }
  ]
}

Rules:
- One record per real-world incident. Merge signals describing the same ongoing incident (linked_incident_id).
- If a signal is not an emergency report (gibberish, chatter, a question), return no record for it.
- Never invent coordinates: use the signal's own lat/lon.
- If counts are not stated, keep affected_population and injuries conservative (estimate from the incident type) and set counts_reported=false.
"""

_TYPE_ALIASES = {
    "collapse": IncidentType.STRUCTURAL_COLLAPSE,
    "building_collapse": IncidentType.STRUCTURAL_COLLAPSE,
    "structural collapse": IncidentType.STRUCTURAL_COLLAPSE,
    "wildfire": IncidentType.FIRE,
    "chemical": IncidentType.HAZMAT,
    "hazardous_materials": IncidentType.HAZMAT,
    "mudslide": IncidentType.LANDSLIDE,
    "flooding": IncidentType.FLOOD,
    "missing_person": IncidentType.MISSING_PERSONS,
    "road_accident": IncidentType.ROADSIDE_CASUALTIES,
    "traffic_accident": IncidentType.ROADSIDE_CASUALTIES,
}


def coerce_incident_type(value: Any) -> Optional[IncidentType]:
    key = str(value or "").strip().lower()
    if key in IncidentType._value2member_map_:
        return IncidentType(key)
    return _TYPE_ALIASES.get(key)


_VISIBLE_SIGNAL_KEYS = ("source", "lat", "lon", "observed_at", "raw_text", "confidence", "zone", "location_known")


async def run_surveillance(
    new_signals: list[dict[str, Any]],
    existing_incidents: list[Incident],
    latlon_hint: tuple[float, float] | None = None,
) -> tuple[list[dict[str, Any]], int]:
    """Returns list of validated incident dicts + latency. Each dict may carry
    'linked_incident_id' to merge into an existing incident."""
    hint = latlon_hint or (0.0, 0.0)
    known = [
        {"id": inc.id, "type": inc.type.value, "title": inc.title, "zone": inc.zone,
         "lat": round(inc.lat, 4), "lon": round(inc.lon, 4), "status": inc.status.value}
        for inc in existing_incidents
        if inc.status not in ("closed", "contained")
    ]
    visible_signals = [
        {key: signal[key] for key in _VISIBLE_SIGNAL_KEYS if key in signal}
        for signal in new_signals
    ]
    user = {"signals": visible_signals, "known_incidents": known}
    parsed, latency = await llm_json(
        SURVEILLANCE_SYSTEM,
        json.dumps(user, ensure_ascii=False),
        agent="surveillance",
        max_tokens=1500,
    )
    raw_items = parsed.get("incidents") if parsed is not None else None
    if not isinstance(raw_items, list):
        return _surveillance_fallback(new_signals, hint)["incidents"], latency
    fallback_xy = (
        (float(new_signals[0].get("lat", hint[0])), float(new_signals[0].get("lon", hint[1])))
        if new_signals else hint
    )
    cleaned = [c for c in (clean_incident(p, fallback_xy) for p in raw_items) if c]
    return cleaned, latency


def clean_incident(p: Any, fallback_xy: tuple[float, float]) -> Optional[dict[str, Any]]:
    """Validate one LLM incident record; None if it is unusable."""
    if not isinstance(p, dict):
        return None
    itype = coerce_incident_type(p.get("type"))
    if itype is None:
        return None
    if p.get("lat") is None or p.get("lon") is None:
        lat, lon = fallback_xy
    else:
        lat = _clamp(p.get("lat"), -90, 90, fallback_xy[0])
        lon = _clamp(p.get("lon"), -180, 180, fallback_xy[1])
    title = str(p.get("title") or "").strip() or f"{itype.value.replace('_', ' ').title()} incident"
    linked = p.get("linked_incident_id")
    return {
        "type": itype.value,
        "title": title[:120],
        "description": str(p.get("description") or "")[:300],
        "lat": lat,
        "lon": lon,
        "zone": str(p.get("zone") or "")[:60],
        "affected_population": _as_int(p.get("affected_population")),
        "injuries": _as_int(p.get("injuries")),
        "counts_reported": bool(p.get("counts_reported", False)),
        "confidence": _clamp(p.get("confidence"), 0.0, 1.0, 0.8),
        "linked_incident_id": str(linked) if linked not in (None, "", "null") else None,
    }


# Keyword → type. The EARLIEST mention in the text wins, so "Missing child near the
# levee" is a missing-persons case, not a flood. Weak cues only count when no strong
# cue appears anywhere.
_STRONG_KEYWORDS: list[tuple[str, IncidentType]] = [
    ("fire", IncidentType.FIRE), ("smoke", IncidentType.FIRE), ("burning", IncidentType.FIRE), ("blaze", IncidentType.FIRE),
    ("flood", IncidentType.FLOOD), ("drowning", IncidentType.FLOOD), ("levee", IncidentType.FLOOD),
    ("rising water", IncidentType.FLOOD), ("swept away", IncidentType.FLOOD),
    ("collapse", IncidentType.STRUCTURAL_COLLAPSE), ("rubble", IncidentType.STRUCTURAL_COLLAPSE),
    ("chemical", IncidentType.HAZMAT), ("hazmat", IncidentType.HAZMAT), ("spill", IncidentType.HAZMAT),
    ("ammonia", IncidentType.HAZMAT), ("leak", IncidentType.HAZMAT), ("gas smell", IncidentType.HAZMAT),
    ("toxic", IncidentType.HAZMAT), ("fumes", IncidentType.HAZMAT),
    ("landslide", IncidentType.LANDSLIDE), ("mudslide", IncidentType.LANDSLIDE), ("rockslide", IncidentType.LANDSLIDE),
    ("missing", IncidentType.MISSING_PERSONS), ("lost child", IncidentType.MISSING_PERSONS),
    ("crash", IncidentType.ROADSIDE_CASUALTIES), ("pileup", IncidentType.ROADSIDE_CASUALTIES),
    ("collision", IncidentType.ROADSIDE_CASUALTIES), ("overturned", IncidentType.ROADSIDE_CASUALTIES),
]
_WEAK_KEYWORDS: list[tuple[str, IncidentType]] = [
    ("trapped", IncidentType.STRUCTURAL_COLLAPSE),
    ("unconscious", IncidentType.MEDICAL), ("cardiac", IncidentType.MEDICAL), ("heart attack", IncidentType.MEDICAL),
    ("seizure", IncidentType.MEDICAL), ("injur", IncidentType.MEDICAL), ("medical", IncidentType.MEDICAL),
    ("not breathing", IncidentType.MEDICAL),
]

_NUM = r"(\d+|one|two|three|four|five|six|seven|eight|nine|ten|several|multiple|dozens?)"
_WORD_NUM = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7,
             "eight": 8, "nine": 9, "ten": 10, "several": 4, "multiple": 4, "dozen": 24, "dozens": 24}
_INJURY_RE = re.compile(_NUM + r"\s+(?:more\s+)?(?:\w+\s+)?(injur\w*|trapped|dead|killed|casualt\w*|missing|hurt|unconscious|victims|coughing|down)\b", re.I)
_POP_RE = re.compile(_NUM + r"\s+(?:more\s+)?(?:\w+\s+)?(people|person|persons|workers|residents|students|employees|families|elderly|passengers|occupants|kayakers|children|kids)", re.I)

_DEFAULT_POP = {
    IncidentType.FIRE: 40, IncidentType.FLOOD: 100, IncidentType.STRUCTURAL_COLLAPSE: 15,
    IncidentType.HAZMAT: 80, IncidentType.MEDICAL: 30, IncidentType.MISSING_PERSONS: 1,
    IncidentType.LANDSLIDE: 5, IncidentType.ROADSIDE_CASUALTIES: 12,
}
_DEFAULT_INJ = {
    IncidentType.STRUCTURAL_COLLAPSE: 4, IncidentType.HAZMAT: 2, IncidentType.FLOOD: 2,
    IncidentType.ROADSIDE_CASUALTIES: 3, IncidentType.MEDICAL: 1,
}


def classify_text(text: str) -> Optional[IncidentType]:
    """Incident type from free text by earliest keyword; None if it's not an emergency."""
    low = text.lower()
    for keywords in (_STRONG_KEYWORDS, _WEAK_KEYWORDS):
        best: Optional[tuple[int, IncidentType]] = None
        for kw, itype in keywords:
            pos = low.find(kw)
            if pos != -1 and (best is None or pos < best[0]):
                best = (pos, itype)
        if best:
            return best[1]
    return None


def _count(match: re.Match) -> int:
    token = match.group(1).lower()
    return int(token) if token.isdigit() else _WORD_NUM.get(token, 1)


def _headline(text: str, limit: int = 70) -> str:
    text = " ".join(text.split())
    text = text if len(text) <= limit else text[: limit - 1].rstrip() + "…"
    return text[:1].upper() + text[1:]


def _surveillance_fallback(
    signals: list[dict[str, Any]], hint: tuple[float, float]
) -> dict[str, Any]:
    """Regex-based parsing when the LLM is unavailable.

    Extracts casualty counts (numbers followed by casualty words) and
    affected-population counts (numbers followed by people words) instead of
    naively grabbing any digit — "last seen 40 minutes ago" is not 40 injuries.
    Text that names no emergency yields no incident.
    """
    incidents: list[dict[str, Any]] = []
    for sig in signals:
        text = str(sig.get("raw_text", ""))
        type_hint = sig.get("_type_hint")     # dataset-derived hint for simulator seeds
        itype = coerce_incident_type(type_hint) or classify_text(text)
        if itype is None:
            continue
        inj_match = _INJURY_RE.search(text)
        pop_match = _POP_RE.search(text)
        injuries = _count(inj_match) if inj_match else _DEFAULT_INJ.get(itype, 0)
        population = _count(pop_match) if pop_match else _DEFAULT_POP.get(itype, 10)
        if inj_match and not pop_match:
            population = max(injuries, 1)
        lat = sig.get("lat")
        lon = sig.get("lon")
        incidents.append(
            {
                "type": itype.value,
                "title": _headline(text),
                "description": text[:300],
                "lat": float(lat) if lat is not None else hint[0],
                "lon": float(lon) if lon is not None else hint[1],
                "zone": str(sig.get("zone") or sig.get("_zone") or ""),
                "affected_population": population,
                "injuries": injuries,
                "counts_reported": bool(inj_match or pop_match),
                "confidence": _clamp(sig.get("confidence"), 0.0, 1.0, 0.7),
                "linked_incident_id": None,
            }
        )
    return {"incidents": incidents}


# ---------------------------------------------------------------------------
# Shared assessment cache — the LLM budget is finite (Groq's free tier is
# ~200k tokens/day/model), so unchanged inputs must not be re-scored.
# ---------------------------------------------------------------------------

CACHE_TTL_S = 900.0
_terrain_cache: dict[str, tuple[tuple, dict[str, Any], float]] = {}
_risk_cache: dict[str, tuple[tuple, dict[str, Any], float]] = {}


def clear_caches() -> None:
    _terrain_cache.clear()
    _risk_cache.clear()


def terrain_signature(incident: Incident) -> tuple:
    """Terrain inputs that matter for THIS incident type, coarsely bucketed so a
    random-walking wind or drizzle doesn't trigger a fresh LLM call every tick."""
    w, t = incident.weather, incident.terrain
    wind = int((w.wind_kph if w else 0) // 20) if incident.type in (IncidentType.FIRE, IncidentType.HAZMAT) else 0
    rain = int((w.precipitation_mm_h if w else 0) // 8) if incident.type in (IncidentType.FLOOD, IncidentType.LANDSLIDE) else 0
    return (incident.type.value, wind, rain, (w.alert if w else None), (t.road_access if t else None))


def scoring_signature(incident: Incident) -> tuple:
    """Everything that would change a risk score enough to be worth a new LLM call."""
    return terrain_signature(incident) + (
        int(math.log(max(incident.affected_population, 1), 1.5)),    # ±50% population steps
        incident.injuries,
        hash(incident.description) & 0xFFFF,
    )


def _cache_get(cache: dict, incident: Incident, signature: tuple) -> Optional[dict[str, Any]]:
    entry = cache.get(incident.id)
    if entry and entry[0] == signature and time.time() - entry[2] < CACHE_TTL_S:
        return entry[1]
    return None


# ---------------------------------------------------------------------------
# 2. Terrain agent — geographic feasibility overlay
# ---------------------------------------------------------------------------

TERRAIN_SYSTEM = """You are the Terrain Agent. Given incident info plus local terrain and weather, assess geographic difficulty for responders.

Return ONLY JSON:
{
  "access_difficulty": 0-100,
  "escalation_risk": 0-100,
  "hazards": ["short hazard strings"],
  "notes": "one or two sentences, operational tone"
}

Consider: slope, road_access (good/degraded/blocked), landcover, wind speed/direction relative to fire spread, precipitation relative to flood, and proximity of water/forest/industrial features.
"""


def terrain_context(incident: Incident) -> str:
    t = incident.terrain
    w = incident.weather
    parts = [f"Incident: {incident.type.value} at ({incident.lat:.4f},{incident.lon:.4f}) zone={incident.zone}"]
    if t:
        parts.append(f"Terrain: elev={t.elevation_m}m slope={t.slope_deg}deg landcover={t.landcover} roads={t.road_access} notes={t.notes}")
    if w:
        parts.append(f"Weather: wind={w.wind_kph:.0f}kph@{w.wind_direction_deg:.0f}deg precip={w.precipitation_mm_h:.1f}mm/h temp={w.temperature_c:.0f}C alert={w.alert}")
    return "\n".join(parts)


def _clean_terrain(parsed: Any) -> Optional[dict[str, Any]]:
    if not isinstance(parsed, dict):
        return None
    try:
        access = float(parsed["access_difficulty"])
        escalation = float(parsed["escalation_risk"])
    except (KeyError, TypeError, ValueError):
        return None
    hazards = parsed.get("hazards")
    return {
        "access_difficulty": _clamp(access, 0, 100, 40),
        "escalation_risk": _clamp(escalation, 0, 100, 40),
        "hazards": [str(h)[:120] for h in hazards[:5]] if isinstance(hazards, list) else [],
        "notes": str(parsed.get("notes") or "")[:240],
    }


async def run_terrain(incident: Incident) -> tuple[dict[str, Any], int]:
    cached = _cache_get(_terrain_cache, incident, terrain_signature(incident))
    if cached is not None:
        return {**cached, "source": "cached"}, 0
    parsed, latency = await llm_json(
        TERRAIN_SYSTEM, terrain_context(incident), agent="terrain", max_tokens=700
    )
    result = _clean_terrain(parsed)
    if result is None:
        return {**_terrain_fallback(incident), "source": "rules"}, latency
    _terrain_cache[incident.id] = (terrain_signature(incident), result, time.time())
    return {**result, "source": "llm"}, latency


def _terrain_fallback(incident: Incident) -> dict[str, Any]:
    t, w = incident.terrain, incident.weather
    access = {"good": 20, "degraded": 55, "blocked": 85}.get(t.road_access if t else "good", 40)
    access += min(int((t.slope_deg if t else 0) * 1.5), 15)
    escalation = 30
    if w and incident.type in (IncidentType.FIRE,):
        escalation += min(int(w.wind_kph * 2), 40)
    if w and incident.type in (IncidentType.FLOOD,):
        escalation += min(int(w.precipitation_mm_h * 3), 40)
    if w and incident.type in (IncidentType.LANDSLIDE,):
        escalation += min(int(w.precipitation_mm_h * 2), 30)
    hazards: list[str] = []
    if t and t.road_access == "blocked":
        hazards.append("road access blocked — plan alternate route")
    if w and w.wind_kph > 30:
        hazards.append("high wind — aerial ops limited")
    if w and w.precipitation_mm_h > 10:
        hazards.append("heavy rain — flash flood watch")
    return {
        "access_difficulty": min(access, 100),
        "escalation_risk": min(escalation, 100),
        "hazards": hazards,
        "notes": "Rule-based terrain assessment (LLM unavailable).",
    }


# ---------------------------------------------------------------------------
# 3. Risk-scoring agent — the ranking engine
# ---------------------------------------------------------------------------

RISK_SYSTEM = """You are the Risk-Scoring Agent for a disaster-response command system.
Score this incident on four components, each 0-100:

- severity: how bad is the incident itself (life safety, property, environment)
- population: how many people are affected or immediately at risk
- spread: probability the situation escalates or spills into nearby areas in the next hour
- time_criticality: how fast the response window closes (minutes matter vs hours)

Calibration: critical multi-casualty events with trapped persons are 85-100; large structural damage with dozens injured is 60-80; a handful of minor injuries with clear access is 15-30; scenes where every structure is intact and nobody is hurt are 5-20.
Use the reported counts (structures, people, injuries) — they are the evidence. Give a short rationale (<= 40 words) an incident commander can act on.

Return ONLY JSON:
{
  "severity": <0-100>, "population": <0-100>, "spread": <0-100>,
  "time_criticality": <0-100>, "rationale": "..."
}
"""

# Weighted composite — the "methodology" from Round 1 deliverable 3.
WEIGHTS = {"severity": 0.35, "population": 0.25, "spread": 0.20, "time_criticality": 0.20}


def composite_urgency(b: RiskBreakdown) -> float:
    return round(
        b.severity * WEIGHTS["severity"]
        + b.population * WEIGHTS["population"]
        + b.spread * WEIGHTS["spread"]
        + b.time_criticality * WEIGHTS["time_criticality"],
        1,
    )


def tier_for(urgency: float) -> str:
    if urgency >= 75: return "P1"
    if urgency >= 55: return "P2"
    if urgency >= 35: return "P3"
    return "P4"


def _clean_components(parsed: Any) -> Optional[dict[str, Any]]:
    if not isinstance(parsed, dict):
        return None
    try:
        comps = {k: float(parsed[k]) for k in ("severity", "population", "spread", "time_criticality")}
    except (KeyError, TypeError, ValueError):
        return None
    if any(math.isnan(v) for v in comps.values()):
        return None
    out: dict[str, Any] = {k: _clamp(v, 0, 100, 50) for k, v in comps.items()}   # 0-100, always
    out["rationale"] = str(parsed.get("rationale") or "")[:300]
    return out


async def run_risk(incident: Incident, terrain_assessment: dict[str, Any]) -> tuple[RiskScore, int]:
    latency = 0
    source = "cached"
    parsed = _cache_get(_risk_cache, incident, scoring_signature(incident))
    if parsed is None:
        user = terrain_context(incident) + (
            f"\nreport: {incident.description[:300]}"
            f"\naffected_population={incident.affected_population} injuries={incident.injuries} "
            f"terrain_difficulty={terrain_assessment.get('access_difficulty')} "
            f"escalation_risk={terrain_assessment.get('escalation_risk')} "
            f"hazards={terrain_assessment.get('hazards')}"
        )
        raw, latency = await llm_json(RISK_SYSTEM, user, agent="risk", max_tokens=700)
        parsed = _clean_components(raw)
        if parsed is not None:
            _risk_cache[incident.id] = (scoring_signature(incident), parsed, time.time())
            source = "llm"
    if parsed is None:
        breakdown = _risk_fallback(incident, terrain_assessment, as_breakdown=True)
        source = "rules"
    else:
        breakdown = RiskBreakdown(
            severity=parsed["severity"], population=parsed["population"],
            spread=parsed["spread"], time_criticality=parsed["time_criticality"],
            confidence=int(incident.confidence * 100), rationale=parsed["rationale"],
        )
    urgency = composite_urgency(breakdown)
    return RiskScore(
        incident_id=incident.id,
        urgency=urgency,
        breakdown=breakdown,
        tier=tier_for(urgency),
        scoring_latency_ms=latency,
        source=source,  # type: ignore[arg-type]
    ), latency


def _risk_fallback(
    incident: Incident, terrain_assessment: dict[str, Any], as_breakdown: bool = False
) -> Any:
    desc = (incident.description or "").lower() + " " + incident.title.lower()
    trapped_bonus = 15 if "trapped" in desc else 0
    type_severity = {
        IncidentType.FIRE: 78, IncidentType.HAZMAT: 82,
        IncidentType.STRUCTURAL_COLLAPSE: 90, IncidentType.FLOOD: 70,
        IncidentType.LANDSLIDE: 65, IncidentType.MEDICAL: 48,
        IncidentType.MISSING_PERSONS: 55, IncidentType.ROADSIDE_CASUALTIES: 62,
    }.get(incident.type, 50)
    type_severity = min(type_severity + (5 if trapped_bonus else 0), 100)
    pop = min(100.0, math.sqrt(max(incident.affected_population, 1)) * 10)
    spread = 20 + 0.6 * float(terrain_assessment.get("escalation_risk", 40))
    tc = 55 + (10 if incident.injuries > 2 else 0) + trapped_bonus \
        + (10 if terrain_assessment.get("access_difficulty", 0) > 60 else 0)
    breakdown = RiskBreakdown(
        severity=min(type_severity, 100.0), population=pop, spread=min(spread, 100.0),
        time_criticality=min(tc, 100.0), confidence=int(incident.confidence * 100),
        rationale="Rule-based scoring (LLM unavailable).",
    )
    return breakdown if as_breakdown else breakdown.model_dump()


# ---------------------------------------------------------------------------
# 4. Logistics agent — resource matching
# ---------------------------------------------------------------------------

LOGISTICS_SYSTEM = """You are the Logistics Agent. For each incident, choose which candidate units to send.

Each incident lists how many more units it "needs" and the "candidates" that can serve it (with ETA in minutes). Maximize life saved per minute: higher-priority incidents (lower "priority" number) get first pick, closer and more capable units go to the most serious incidents. Each unit serves exactly one incident. Choose at most "needs" units per incident, only from that incident's candidates, and never the same unit twice. Fewer, well-justified assignments beat exhaustive ones.

Return ONLY JSON:
{
  "assignments": [
    {"incident_id": "...", "resource_id": "...", "role": "short role like 'primary suppression' or 'triage & evac'", "rationale": "<= 25 words why this pair"}
  ]
}
"""


def _current_position(r: Resource) -> tuple[float, float]:
    return (
        r.current_lat if r.current_lat is not None else r.base_lat,
        r.current_lon if r.current_lon is not None else r.base_lon,
    )


def _distance_km(r: Resource, inc: Incident) -> float:
    lat, lon = _current_position(r)
    return _haversine_km(lat, lon, inc.lat, inc.lon)


def crew_needed(incident: Incident, assigned_counts: dict[str, int]) -> int:
    """How many more units this incident should receive."""
    return max(0, TARGET_CREW[tier_of(incident)] - assigned_counts.get(incident.id, 0))


def _candidates(incident: Incident, available: list[Resource], exclude: set[str]) -> list[Resource]:
    required = required_for(incident.type)
    capable = [r for r in available if r.id not in exclude and r.type in required]
    if not capable:   # drones are the one universal resource (recon / size-up)
        capable = [r for r in available if r.id not in exclude and r.type == ResourceType.DRONE]
    return sorted(capable, key=lambda r: _distance_km(r, incident))


async def run_logistics(
    ranked: list[tuple[int, Incident]],
    available: list[Resource],
    assigned_counts: Optional[dict[str, int]] = None,
) -> tuple[list[dict[str, Any]], int]:
    """LLM proposes pairs; code validates them and guarantees P1/P2 coverage."""
    counts = assigned_counts or {}
    needy = [(rank, inc) for rank, inc in ranked if crew_needed(inc, counts) > 0]
    if not needy or not available:
        return [], 0

    inc_view = []
    for rank, inc in needy[:8]:
        cands = sorted((r for r in available if is_capable(r, inc)), key=lambda r: _distance_km(r, inc))[:5]
        if not cands:
            continue                                   # nothing free can serve it: don't ask the LLM
        inc_view.append({
            "priority": rank, "incident_id": inc.id, "type": inc.type.value, "tier": tier_of(inc),
            "title": inc.title[:80], "population": inc.affected_population, "injuries": inc.injuries,
            "needs": crew_needed(inc, counts),
            "candidates": [
                {"resource_id": r.id, "name": r.name, "type": r.type.value, "eta_min": eta_minutes(r, inc)}
                for r in cands
            ],
        })
    if not inc_view:
        return [], 0
    parsed, latency = await llm_json(
        LOGISTICS_SYSTEM, json.dumps({"incidents": inc_view}), agent="logistics", max_tokens=1200,
    )
    raw = parsed.get("assignments") if isinstance(parsed, dict) else None
    if not isinstance(raw, list):
        return greedy_match(ranked, available, counts), latency
    valid = sanitize_assignments(raw, ranked, available, counts)
    return coverage_guard(valid, ranked, available, counts), latency


def sanitize_assignments(
    raw: list[Any],
    ranked: list[tuple[int, Incident]],
    available: list[Resource],
    assigned_counts: dict[str, int],
) -> list[dict[str, Any]]:
    """Keep only assignments the rules allow: known incident, available + capable
    unit, one unit one incident, within crew size and per-incident cap."""
    inc_by_id = {inc.id: inc for _, inc in ranked}
    res_by_id = {r.id: r for r in available}
    order = {inc.id: rank for rank, inc in ranked}
    used: set[str] = set()
    added: dict[str, int] = {}
    out: list[dict[str, Any]] = []
    items = [a for a in raw if isinstance(a, dict)]
    items.sort(key=lambda a: order.get(str(a.get("incident_id")), 10_000))
    for a in items:
        inc = inc_by_id.get(str(a.get("incident_id")))
        res = res_by_id.get(str(a.get("resource_id")))
        if not inc or not res or res.id in used:
            continue
        if inc.status.value in ("closed", "contained") or not is_capable(res, inc):
            continue
        have = assigned_counts.get(inc.id, 0) + added.get(inc.id, 0)
        if have >= CREW_CAP[tier_of(inc)] or added.get(inc.id, 0) >= crew_needed(inc, assigned_counts):
            continue
        used.add(res.id)
        added[inc.id] = added.get(inc.id, 0) + 1
        out.append({
            "incident_id": inc.id, "resource_id": res.id,
            "role": str(a.get("role") or role_for(res, inc))[:60],
            "rationale": str(a.get("rationale") or "")[:160],
            "source": "llm",
        })
    return out


def coverage_guard(
    assignments: list[dict[str, Any]],
    ranked: list[tuple[int, Incident]],
    available: list[Resource],
    assigned_counts: dict[str, int],
) -> list[dict[str, Any]]:
    """Deterministic safety net: no P1/P2 incident is left without a unit while a
    capable one is free, whatever the LLM proposed."""
    used = {a["resource_id"] for a in assignments}
    covered = {a["incident_id"] for a in assignments}
    result = list(assignments)
    for _rank, inc in ranked:
        if tier_of(inc) not in ("P1", "P2") or inc.id in covered or assigned_counts.get(inc.id, 0) > 0:
            continue
        cands = _candidates(inc, available, used)
        if not cands:
            continue
        best = cands[0]
        used.add(best.id)
        result.append({
            "incident_id": inc.id, "resource_id": best.id, "role": role_for(best, inc),
            "rationale": "Coverage guard: nearest capable unit for an uncovered P1/P2.",
            "source": "rules",
        })
    return result


def greedy_match(
    ranked: list[tuple[int, Incident]],
    available: list[Resource],
    assigned_counts: dict[str, int],
) -> list[dict[str, Any]]:
    """Greedy nearest-capable matcher (the rule-based twin): P1 gets the best pick,
    then P2, … up to each incident's target crew size."""
    assignments: list[dict[str, Any]] = []
    used: set[str] = set()
    for rank, inc in ranked:
        if inc.status.value in ("closed", "contained"):
            continue
        for _ in range(crew_needed(inc, assigned_counts)):
            cands = _candidates(inc, available, used)
            if not cands:
                break
            best = cands[0]
            used.add(best.id)
            assignments.append({
                "incident_id": inc.id, "resource_id": best.id, "role": role_for(best, inc),
                "rationale": f"Nearest capable unit (rank #{rank}, rule-based matcher).",
                "source": "rules",
            })
            assigned_counts = {**assigned_counts, inc.id: assigned_counts.get(inc.id, 0) + 1}
    return assignments


# ---------------------------------------------------------------------------
# 5. Command agent — coordinated recommendations for the commander
# ---------------------------------------------------------------------------

COMMAND_SYSTEM = """You are the Command Recommendation Agent advising an incident commander.
Given ranked incidents (with risk rationale), the units actually deployed, and active weather alerts, write the operational recommendation for each listed incident.

For each incident produce: a headline order, 2-4 concrete action bullets, and any warnings.
Tone: crisp, operational, no fluff. Reference terrain/weather conditions where they change the plan. If an incident has no units deployed, say so in a warning.

Return ONLY JSON:
{
  "recommendations": [
    {
      "incident_id": "...",
      "headline": "imperative one-liner, e.g. 'Commit two engines to Sector-4 fire, attack from the east'",
      "actions": ["action 1", "action 2", "action 3"],
      "warnings": ["e.g. wind shift expected within 30 min"]
    }
  ]
}
Include one recommendation per listed incident, highest priority first.
"""

TOP_N = 4


def command_view(
    ranked: list[tuple[int, Incident]], deployments: list[Deployment], weather: list[WeatherCell]
) -> dict[str, Any]:
    dep_by_inc: dict[str, list[Deployment]] = {}
    for d in deployments:
        dep_by_inc.setdefault(d.incident_id, []).append(d)
    inc_view = []
    for rank, inc in ranked[:TOP_N]:
        b = inc.risk.breakdown if inc.risk else None
        inc_view.append({
            "priority": rank, "incident_id": inc.id, "type": inc.type.value,
            "title": inc.title[:80], "zone": inc.zone, "status": inc.status.value,
            "tier": tier_of(inc),
            "population": inc.affected_population, "injuries": inc.injuries,
            "urgency": inc.risk.urgency if inc.risk else None,
            "rationale": (b.rationale if b else "")[:200],
            "deployed": [
                {"resource": d.resource_name, "type": d.resource_type.value, "eta_min": d.eta_minutes, "role": d.role}
                for d in dep_by_inc.get(inc.id, [])
            ],
        })
    alerts = [
        {"zone": w.zone, "alert": w.alert, "wind_kph": round(w.wind_kph), "note": w.forecast_note}
        for w in weather if w.alert
    ]
    return {"incidents": inc_view, "weather_alerts": alerts}


async def run_command(
    ranked: list[tuple[int, Incident]],
    deployments: list[Deployment],
    weather: list[WeatherCell],
) -> tuple[list[dict[str, Any]], int]:
    view = command_view(ranked, deployments, weather)
    if not view["incidents"]:
        return [], 0
    parsed, latency = await llm_json(
        COMMAND_SYSTEM, json.dumps(view), agent="command", max_tokens=1800,
    )
    raw = parsed.get("recommendations") if isinstance(parsed, dict) else None
    if not isinstance(raw, list):
        return _command_fallback(ranked, deployments, weather)["recommendations"], latency
    known = {inc.id for _, inc in ranked[:TOP_N]}
    cleaned: dict[str, dict[str, Any]] = {}
    for r in raw:
        if not isinstance(r, dict) or str(r.get("incident_id")) not in known:
            continue
        headline = str(r.get("headline") or "").strip()
        if not headline:
            continue
        actions = r.get("actions")
        warnings = r.get("warnings")
        cleaned[str(r["incident_id"])] = {
            "incident_id": str(r["incident_id"]),
            "headline": headline[:200],
            "actions": [str(x)[:200] for x in actions[:4]] if isinstance(actions, list) else [],
            "warnings": [str(x)[:200] for x in warnings[:3]] if isinstance(warnings, list) else [],
            "source": "llm",
        }
    # An incident the LLM skipped still gets a card, from the rule-based twin.
    fill = {
        r["incident_id"]: r
        for r in _command_fallback(ranked, deployments, weather)["recommendations"]
        if r["incident_id"] not in cleaned
    }
    merged = {**cleaned, **fill}
    return [merged[inc.id] for _, inc in ranked[:TOP_N] if inc.id in merged], latency


_COMMAND_DETAILS: dict[IncidentType, tuple[str, list[str]]] = {
    IncidentType.FIRE: ("Commit engines to the {zone} fire — attack from the upwind side",
                        ["Attack from upslope/upwind; establish an anchor point", "Protect exposures before extinguishing the main body"]),
    IncidentType.FLOOD: ("Push boat crews into {zone} flooding; clear the low ground",
                         ["Boat-based rescue only; no wading in moving water", "Stage swift-water team upstream of the debris line"]),
    IncidentType.STRUCTURAL_COLLAPSE: ("Start search & extrication at the {zone} collapse",
                                       ["Mark collapse zones; shore before interior search", "Use canine/acoustic search before heavy equipment"]),
    IncidentType.HAZMAT: ("Contain the {zone} release; upwind approach only",
                          ["Stage upwind; identify plume direction before approach", "Set up a decon corridor before crew rotation"]),
    IncidentType.LANDSLIDE: ("Open an access route into {zone} before extraction",
                             ["Assess slope stability before committing crews", "Engineering to clear and shore the access route"]),
    IncidentType.MISSING_PERSONS: ("Sweep the {zone} grid with drone and ground team",
                                   ["Establish last-known point and search sectors", "Drone thermal pass first, then ground teams"]),
    IncidentType.ROADSIDE_CASUALTIES: ("Triage and extricate at the {zone} crash site",
                                       ["Secure the scene and block traffic", "Triage by severity; stage ambulances clear of the wreck"]),
    IncidentType.MEDICAL: ("Send medical response to {zone}", ["Confirm patient condition and access", "Prepare for transport"]),
}


def _command_fallback(
    ranked: list[tuple[int, Incident]],
    deployments: list[Deployment],
    weather: list[WeatherCell],
) -> dict[str, Any]:
    dep_by_inc: dict[str, list[Deployment]] = {}
    for d in deployments:
        dep_by_inc.setdefault(d.incident_id, []).append(d)
    recs = []
    for _rank, inc in ranked[:TOP_N]:
        headline, details = _COMMAND_DETAILS.get(inc.type, ("Respond to the {zone} incident", ["Confirm scene size-up"]))
        deps = dep_by_inc.get(inc.id, [])
        actions = list(details) + ["Establish an incident command perimeter"]
        warnings: list[str] = []
        zone_wx = next((w for w in weather if w.zone == inc.zone), None)
        if zone_wx and zone_wx.wind_kph > 30 and inc.type == IncidentType.FIRE:
            warnings.append(f"Wind {round(zone_wx.wind_kph)} kph — spot fires likely, aerial ops limited")
        if zone_wx and zone_wx.alert == "flood_watch" and inc.type == IncidentType.FLOOD:
            warnings.append("Flood watch in effect — river still rising")
        if not deps:
            warnings.append("No units deployed yet — coverage gap at this priority")
        elif min(d.eta_minutes for d in deps) > 0:
            actions.append(f"First unit ETA ~{round(min(d.eta_minutes for d in deps))} min")
        recs.append({
            "incident_id": inc.id,
            "headline": f"[{tier_of(inc)}] " + headline.format(zone=inc.zone or "scene"),
            "actions": actions[:4],
            "warnings": warnings[:3],
            "source": "rules",
        })
    return {"recommendations": recs}
