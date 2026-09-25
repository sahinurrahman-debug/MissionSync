"""The five MissionSync agents.

Each agent = one LLM call (Groq, JSON mode) with a deterministic rule-based
twin that takes over if the LLM is unavailable. The interfaces are identical,
so the orchestrator and the dashboard never know (or care) which ran.
"""
from __future__ import annotations

import math
import re
from typing import Any, Optional

from .llm import llm_json
from .models import (
    Deployment,
    IncomingReport,
    Incident,
    IncidentType,
    Resource,
    ResourceType,
    RiskBreakdown,
    RiskScore,
    TerrainCell,
    WeatherCell,
)


def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


# ---------------------------------------------------------------------------
# 1. Surveillance agent — parse raw signals into structured incidents
# ---------------------------------------------------------------------------

SURVEILLANCE_SYSTEM = """You are the Surveillance Agent in a disaster-response coordination system.
You receive raw field signals (drone observations, radio calls, ground reports, sensor pings) and must convert them into structured incident records.

Return ONLY JSON with exactly this shape:
{
  "incidents": [
    {
      "type": "fire|flood|structural_collapse|medical|hazmat|landslide|missing_persons|roadside_casualties",
      "title": "short operational title",
      "description": "one sentence",
      "lat": <number>, "lon": <number>,
      "zone": "sector name if mentioned, else inferred from nearest known zone",
      "affected_population": <int>,
      "injuries": <int>,
      "confidence": <0-1 float>,
      "linked_incident_id": "existing incident id if this signal belongs to it, else null"
    }
  ]
}

Rules:
- Merge signals that clearly describe the same ongoing incident (use linked_incident_id).
- Never invent coordinates: if the signal gives none, use the provided lat/lon hint.
- affected_population and injuries must be conservative if unreported (estimate from incident type).
"""

async def run_surveillance(
    new_signals: list[dict[str, Any]],
    existing_incidents: list[Incident],
    latlon_hint: tuple[float, float] | None = None,
) -> tuple[list[dict[str, Any]], int]:
    """Returns list of parsed incident dicts + latency. Each dict may carry
    'linked_incident_id' to merge into an existing incident."""
    hint = latlon_hint or (0.0, 0.0)
    known = [
        {"id": inc.id, "type": inc.type.value, "title": inc.title, "status": inc.status.value}
        for inc in existing_incidents
        if inc.status not in ("closed",)
    ]
    user = {
        "signals": new_signals,
        "location_hint": {"lat": hint[0], "lon": hint[1]},
        "known_incidents": known,
    }
    parsed, latency = await llm_json(
        SURVEILLANCE_SYSTEM,
        str(user),
        agent="surveillance",
        max_tokens=900,
    )
    if parsed is None:
        parsed = _surveillance_fallback(new_signals, hint)
    return parsed.get("incidents", []), latency


def _surveillance_fallback(
    signals: list[dict[str, Any]], hint: tuple[float, float]
) -> dict[str, Any]:
    """Regex-based parsing when the LLM is unavailable.

    Extracts casualty counts (numbers followed by casualty words) and
    affected-population counts (numbers followed by people words) instead of
    naively grabbing any digit — "last seen 40 minutes ago" is not 40 injuries.
    """
    keyword_map = {
        "fire": IncidentType.FIRE, "smoke": IncidentType.FIRE, "burning": IncidentType.FIRE,
        "flood": IncidentType.FLOOD, "drowning": IncidentType.FLOOD, "levee": IncidentType.FLOOD,
        "collapse": IncidentType.STRUCTURAL_COLLAPSE, "rubble": IncidentType.STRUCTURAL_COLLAPSE,
        "trapped": IncidentType.STRUCTURAL_COLLAPSE,
        "chemical": IncidentType.HAZMAT, "hazmat": IncidentType.HAZMAT, "spill": IncidentType.HAZMAT,
        "ammonia": IncidentType.HAZMAT, "leak": IncidentType.HAZMAT,
        "landslide": IncidentType.LANDSLIDE, "mudslide": IncidentType.LANDSLIDE,
        "missing": IncidentType.MISSING_PERSONS,
        "crash": IncidentType.ROADSIDE_CASUALTIES, "pileup": IncidentType.ROADSIDE_CASUALTIES,
    }
    word_num = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6,
                "seven": 7, "eight": 8, "nine": 9, "ten": 10, "several": 4, "multiple": 4}
    injury_re = re.compile(
        r"(\d+|one|two|three|four|five|six|seven|eight|nine|ten|several|multiple)\s+"
        r"(injur\w*|trapped|dead|killed|casualt\w*|missing|hurt|unconscious|victims)", re.I)
    pop_re = re.compile(
        r"(\d+|one|two|three|four|five|six|seven|eight|nine|ten|several|multiple)\s+"
        r"(people|persons|workers|residents|students|employees|families|elderly|passengers)", re.I)

    default_pop = {
        IncidentType.FIRE: 40, IncidentType.FLOOD: 100, IncidentType.STRUCTURAL_COLLAPSE: 15,
        IncidentType.HAZMAT: 80, IncidentType.MEDICAL: 30, IncidentType.MISSING_PERSONS: 1,
        IncidentType.LANDSLIDE: 5, IncidentType.ROADSIDE_CASUALTIES: 12,
    }
    default_inj = {
        IncidentType.STRUCTURAL_COLLAPSE: 4, IncidentType.HAZMAT: 2, IncidentType.FLOOD: 2,
        IncidentType.ROADSIDE_CASUALTIES: 3, IncidentType.MEDICAL: 1,
    }

    def _count(match: re.Match) -> int:
        token = match.group(1).lower()
        return int(token) if token.isdigit() else word_num.get(token, 1)

    incidents: list[dict[str, Any]] = []
    for sig in signals:
        text = str(sig.get("raw_text", ""))
        low = text.lower()
        itype = next((v for k, v in keyword_map.items() if k in low), IncidentType.MEDICAL)
        inj_match = injury_re.search(low)
        pop_match = pop_re.search(low)
        injuries = _count(inj_match) if inj_match else default_inj.get(itype, 0)
        population = _count(pop_match) if pop_match else default_pop.get(itype, 10)
        incidents.append(
            {
                "type": itype.value,
                "title": text[:60].capitalize() or "Unverified signal",
                "description": text[:200],
                "lat": sig.get("lat") or hint[0],
                "lon": sig.get("lon") or hint[1],
                "zone": str(sig.get("zone", "")),
                "affected_population": population,
                "injuries": injuries,
                "confidence": float(sig.get("confidence", 0.7)),
                "linked_incident_id": None,
            }
        )
    return {"incidents": incidents}


# ---------------------------------------------------------------------------
# 2. Terrain agent — geographic feasibility overlay
# ---------------------------------------------------------------------------

TERRAIN_SYSTEM = """You are the Terrain Agent. Given incident info plus local terrain and weather cells, assess geographic difficulty for responders.

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
        parts.append(f"Weather: wind={w.wind_kph}kph@{w.wind_direction_deg}deg precip={w.precipitation_mm_h}mm/h temp={w.temperature_c}C alert={w.alert}")
    return "\n".join(parts)


async def run_terrain(incident: Incident) -> tuple[dict[str, Any], int]:
    parsed, latency = await llm_json(
        TERRAIN_SYSTEM, terrain_context(incident), agent="terrain", max_tokens=400
    )
    if parsed is None:
        parsed = _terrain_fallback(incident)
    return parsed, latency


def _terrain_fallback(incident: Incident) -> dict[str, Any]:
    t, w = incident.terrain, incident.weather
    access = {"good": 20, "degraded": 55, "blocked": 85}.get(t.road_access if t else "good", 40)
    access += min(int((t.slope_deg if t else 0) * 1.5), 15)
    escalation = 30
    if w and incident.type in (IncidentType.FIRE,):
        escalation += min(int(w.wind_kph * 2), 40)
    if w and incident.type in (IncidentType.FLOOD,):
        escalation += min(int(w.precipitation_mm_h * 3), 40)
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

Also give a short rationale (<= 40 words) an incident commander can act on.
Be consistent: identical inputs should get identical scores. Critical multi-casualty events with trapped persons are 85-100; single minor injuries with clear access are 15-30.

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


async def run_risk(incident: Incident, terrain_assessment: dict[str, Any]) -> tuple[RiskScore, int]:
    user = terrain_context(incident) + (
        f"\naffected_population={incident.affected_population} injuries={incident.injuries} "
        f"terrain_difficulty={terrain_assessment.get('access_difficulty')} "
        f"escalation_risk={terrain_assessment.get('escalation_risk')} "
        f"hazards={terrain_assessment.get('hazards')}"
    )
    parsed, latency = await llm_json(RISK_SYSTEM, user, agent="risk", max_tokens=350)
    if parsed is None:
        parsed = _risk_fallback(incident, terrain_assessment)

    try:
        breakdown = RiskBreakdown(
            severity=float(parsed["severity"]),
            population=float(parsed["population"]),
            spread=float(parsed["spread"]),
            time_criticality=float(parsed["time_criticality"]),
            confidence=int(incident.confidence * 100),
            rationale=str(parsed.get("rationale", ""))[:300],
        )
    except (KeyError, TypeError, ValueError):
        breakdown = _risk_fallback(incident, terrain_assessment, as_breakdown=True)

    urgency = composite_urgency(breakdown)
    return RiskScore(
        incident_id=incident.id,
        urgency=urgency,
        breakdown=breakdown,
        tier=tier_for(urgency),
        scoring_latency_ms=latency,
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
        rationale="Rule-based fallback scoring (LLM unavailable).",
    )
    return breakdown if as_breakdown else breakdown.model_dump()


# ---------------------------------------------------------------------------
# 4. Logistics agent — resource matching
# ---------------------------------------------------------------------------

LOGISTICS_SYSTEM = """You are the Logistics Agent. Match available resources to the top-priority incidents.

Given: ranked incident list (with required capabilities) and available resources (with type, personnel, distance, capabilities).
Produce an assignment maximizing life saved per minute, respecting that each resource serves exactly one incident at a time, and closer + more capable resources go to higher-priority incidents.

Return ONLY JSON:
{
  "assignments": [
    {
      "incident_id": "...", "resource_id": "...",
      "role": "short role like 'primary suppression' or 'triage & evac'",
      "rationale": "<= 25 words why this pair"
    }
  ]
}

Never assign the same resource twice. Do not assign resources to P3/P4 incidents while P1/P2 remain uncovered. Fewer, well-justified assignments beat exhaustive ones.
"""

async def run_logistics(
    ranked: list[tuple[int, Incident]], available: list[Resource]
) -> tuple[list[dict[str, Any]], int]:
    inc_view = []
    for rank, inc in ranked:
        need = {
            IncidentType.FIRE: ["fire_unit"],
            IncidentType.FLOOD: ["swift_water", "rescue_team"],
            IncidentType.STRUCTURAL_COLLAPSE: ["rescue_team", "engineering", "ambulance"],
            IncidentType.MEDICAL: ["ambulance"],
            IncidentType.HAZMAT: ["hazmat_unit", "fire_unit"],
            IncidentType.LANDSLIDE: ["rescue_team", "engineering"],
            IncidentType.MISSING_PERSONS: ["drone", "rescue_team"],
            IncidentType.ROADSIDE_CASUALTIES: ["ambulance", "fire_unit"],
        }.get(inc.type, ["rescue_team"])
        inc_view.append({
            "priority": rank, "incident_id": inc.id, "type": inc.type.value,
            "title": inc.title, "required": need,
            "population": inc.affected_population, "injuries": inc.injuries,
        })
    res_view = [{
        "resource_id": r.id, "type": r.type.value, "name": r.name,
        "personnel": r.personnel, "distance_km": round(_haversine_km(
            r.current_lat or r.base_lat, r.current_lon or r.base_lon, inc.lat, inc.lon
        ) if ranked else 0, 1),
        "ref_distance_incident_id": ranked[0][1].id if ranked else None,
    } for r in available]
    parsed, latency = await llm_json(
        LOGISTICS_SYSTEM, str({"incidents": inc_view, "resources": res_view}),
        agent="logistics", max_tokens=900,
    )
    if parsed is None:
        parsed = _logistics_fallback(ranked, available)
    return parsed.get("assignments", []), latency


def _required_for(itype: IncidentType) -> list[ResourceType]:
    return {
        IncidentType.FIRE: [ResourceType.FIRE_UNIT],
        IncidentType.FLOOD: [ResourceType.SWIFT_WATER, ResourceType.RESCUE_TEAM],
        IncidentType.STRUCTURAL_COLLAPSE: [ResourceType.RESCUE_TEAM, ResourceType.AMBULANCE],
        IncidentType.MEDICAL: [ResourceType.AMBULANCE],
        IncidentType.HAZMAT: [ResourceType.HAZMAT_UNIT, ResourceType.FIRE_UNIT],
        IncidentType.LANDSLIDE: [ResourceType.RESCUE_TEAM, ResourceType.ENGINEERING],
        IncidentType.MISSING_PERSONS: [ResourceType.DRONE, ResourceType.RESCUE_TEAM],
        IncidentType.ROADSIDE_CASUALTIES: [ResourceType.AMBULANCE, ResourceType.FIRE_UNIT],
    }.get(itype, [ResourceType.RESCUE_TEAM])


def _logistics_fallback(
    ranked: list[tuple[int, Incident]], available: list[Resource]
) -> dict[str, Any]:
    """Greedy nearest-capable matcher: P1 gets best pick, then P2, ...

    Conservative by design: only capable unit types are assigned (drones are
    the one universal resource — size-up/recon helps every incident), and at
    most 2 units go to any single incident per cycle. A P3 incident never
    strips an ambulance from an uncovered P1.
    """
    assignments: list[dict[str, Any]] = []
    used: set[str] = set()
    per_incident: dict[str, int] = {}
    for rank, inc in ranked:
        required = _required_for(inc.type)
        candidates = [
            r for r in available
            if r.id not in used
            and r.type in required
            and per_incident.get(inc.id, 0) < 2
        ]
        if not candidates:
            # Drones are universally useful (recon/size-up); nothing else.
            candidates = [
                r for r in available
                if r.id not in used
                and r.type == ResourceType.DRONE
                and per_incident.get(inc.id, 0) < 2
            ]
        if not candidates:
            continue
        best = min(candidates, key=lambda r: _haversine_km(
            r.current_lat or r.base_lat, r.current_lon or r.base_lon, inc.lat, inc.lon))
        used.add(best.id)
        per_incident[inc.id] = per_incident.get(inc.id, 0) + 1
        assignments.append({
            "incident_id": inc.id, "resource_id": best.id,
            "role": f"{best.type.value} for {inc.type.value}",
            "rationale": "Nearest capable unit (fallback matcher).",
        })
    return {"assignments": assignments}


# ---------------------------------------------------------------------------
# 5. Command agent — coordinated recommendations for the commander
# ---------------------------------------------------------------------------

COMMAND_SYSTEM = """You are the Command Recommendation Agent advising an incident commander.
Given ranked incidents (with risk breakdowns), planned deployments, and active weather alerts, write the operational recommendation for the top incidents.

For each incident produce: a headline order, 2-4 concrete action bullets, and any warnings.
Tone: crisp, operational, no fluff. Reference terrain/weather conditions where they change the plan.

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
Include at most 4 recommendations, highest priority first.
"""

async def run_command(
    ranked: list[tuple[int, Incident]],
    deployments: list[Deployment],
    weather: list[WeatherCell],
) -> tuple[list[dict[str, Any]], int]:
    inc_view = []
    dep_by_inc: dict[str, list[Deployment]] = {}
    for d in deployments:
        dep_by_inc.setdefault(d.incident_id, []).append(d)
    for rank, inc in ranked[:4]:
        b = inc.risk.breakdown if inc.risk else None
        inc_view.append({
            "priority": rank, "incident_id": inc.id, "type": inc.type.value,
            "title": inc.title, "status": inc.status.value,
            "population": inc.affected_population, "injuries": inc.injuries,
            "urgency": inc.risk.urgency if inc.risk else None,
            "rationale": b.rationale if b else "",
            "planned_deployments": [
                {"resource": d.resource_name, "type": d.resource_type.value, "eta_min": d.eta_minutes, "role": d.role}
                for d in dep_by_inc.get(inc.id, [])
            ],
        })
    alerts = [w.model_dump() for w in weather if w.alert]
    parsed, latency = await llm_json(
        COMMAND_SYSTEM, str({"incidents": inc_view, "weather_alerts": alerts}),
        agent="command", max_tokens=1000,
    )
    if parsed is None:
        parsed = _command_fallback(ranked)
    return parsed.get("recommendations", []), latency


def _command_fallback(ranked: list[tuple[int, Incident]]) -> dict[str, Any]:
    recs = []
    for rank, inc in ranked[:4]:
        recs.append({
            "incident_id": inc.id,
            "headline": f"[{inc.risk.tier if inc.risk else 'P?'}] Deploy to {inc.title}",
            "actions": [
                "Confirm scene size-up via nearest drone",
                "Stage resources at safe approach point",
                "Establish incident command perimeter",
            ],
            "warnings": ["LLM unavailable — generic protocol actions only"],
        })
    return {"recommendations": recs}


def eta_minutes(resource: Resource, incident: Incident) -> float:
    dist = _haversine_km(
        resource.current_lat or resource.base_lat,
        resource.current_lon or resource.base_lon,
        incident.lat, incident.lon,
    )
    return round(dist / max(resource.speed_kph, 1.0) * 60.0, 1)
