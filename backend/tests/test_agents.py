import asyncio
import json

import pytest

from missionsync import agents
from missionsync.models import (
    Incident, IncidentType, Resource, ResourceType, RiskBreakdown, RiskScore,
)
from missionsync.simulator import build_resources


def make_incident(itype=IncidentType.FIRE, tier="P2", pop=40, injuries=0, lat=34.058, lon=-118.245, **kw) -> Incident:
    inc = Incident(type=itype, title="t", description=kw.pop("description", "d"), lat=lat, lon=lon,
                   affected_population=pop, injuries=injuries, **kw)
    urgency = {"P1": 80, "P2": 60, "P3": 40, "P4": 20}[tier]
    inc.risk = RiskScore(incident_id=inc.id, urgency=urgency, tier=tier,
                         breakdown=RiskBreakdown(severity=1, population=1, spread=1, time_criticality=1, confidence=80))
    return inc


def ranked_of(*incidents):
    return [(i + 1, inc) for i, inc in enumerate(incidents)]


# -- surveillance ---------------------------------------------------------------

def test_surveillance_does_not_send_hidden_dataset_metadata(monkeypatch) -> None:
    received = {}

    async def fake_llm_json(system, user, **kwargs):
        received.update(json.loads(user))
        return {"incidents": []}, 0

    monkeypatch.setattr(agents, "llm_json", fake_llm_json)
    asyncio.run(agents.run_surveillance(
        [{"source": "drone", "lat": 34.0, "lon": -118.0, "raw_text": "Damaged building reported",
          "confidence": 0.8, "_ground_truth_urgency": 90, "_damage_grade": 3,
          "_type_hint": "structural_collapse", "_dataset_lat": 40.0, "_dataset_lon": -70.0,
          "_injected": True, "_zone": "Downtown"}],
        [],
    ))
    assert received["signals"] == [
        {"source": "drone", "lat": 34.0, "lon": -118.0, "raw_text": "Damaged building reported", "confidence": 0.8}
    ]


@pytest.mark.parametrize("text,expected", [
    ("Missing child last seen near the Riverfront levee, wearing a red jacket", IncidentType.MISSING_PERSONS),
    ("Floodwater closing on the Riverfront footbridge, two kayakers missing downstream", IncidentType.FLOOD),
    ("Gas smell in Industrial Park block B, workers reporting dizziness", IncidentType.HAZMAT),
    ("Mudslide across the North Hills access road, a car partially buried", IncidentType.LANDSLIDE),
    ("New fire in the chemistry building, heavy smoke on the third floor", IncidentType.FIRE),
    ("Two people trapped in the stairwell", IncidentType.STRUCTURAL_COLLAPSE),
    ("Man unconscious near the fountain", IncidentType.MEDICAL),
    ("asdf qwerty nothing", None),
    ("what time is the drill over?", None),
])
def test_classifier_uses_earliest_mention(text, expected) -> None:
    assert agents.classify_text(text) == expected


def test_fallback_ignores_non_emergencies_and_reports_whether_counts_were_stated() -> None:
    out = agents._surveillance_fallback(
        [{"raw_text": "asdf qwerty", "lat": 34.0, "lon": -118.0},
         {"raw_text": "Smoke from Building C, two people coughing", "lat": 34.0, "lon": -118.0},
         {"raw_text": "Warehouse fire spreading", "lat": 34.0, "lon": -118.0}],
        (0.0, 0.0),
    )["incidents"]
    assert len(out) == 2
    assert out[0]["counts_reported"] is True and out[0]["affected_population"] == 2
    assert out[1]["counts_reported"] is False           # population is a type default, not evidence


def test_fallback_survives_signals_without_coordinates_when_a_type_hint_is_present() -> None:
    out = agents._surveillance_fallback([{"raw_text": "smoke", "_type_hint": "fire"}], (34.0, -118.0))
    assert (out["incidents"][0]["lat"], out["incidents"][0]["lon"]) == (34.0, -118.0)


def test_clean_incident_validates_llm_records() -> None:
    xy = (34.0, -118.0)
    assert agents.clean_incident({"type": "earthquake"}, xy) is None          # not in the enum
    assert agents.clean_incident("nope", xy) is None
    ok = agents.clean_incident({"type": "Wildfire", "lat": "x", "lon": 999, "affected_population": "17.6",
                                "injuries": -4, "confidence": 7, "linked_incident_id": "null"}, xy)
    assert ok["type"] == "fire"
    assert (ok["lat"], ok["lon"]) == xy or ok["lon"] == 180      # bad coordinates never escape
    assert ok["affected_population"] == 17 and ok["injuries"] == 0
    assert ok["confidence"] == 1.0 and ok["linked_incident_id"] is None


def test_llm_output_without_an_incidents_list_falls_back(monkeypatch) -> None:
    async def bad(*a, **k):
        return {"nope": 1}, 5

    monkeypatch.setattr(agents, "llm_json", bad)
    out, _ = asyncio.run(agents.run_surveillance([{"raw_text": "big fire", "lat": 1.0, "lon": 2.0}], []))
    assert out and out[0]["type"] == "fire"


# -- risk -----------------------------------------------------------------------

def test_composite_and_tier_boundaries() -> None:
    b = RiskBreakdown(severity=100, population=100, spread=100, time_criticality=100, confidence=90)
    assert agents.composite_urgency(b) == 100.0
    b = RiskBreakdown(severity=80, population=60, spread=40, time_criticality=20, confidence=90)
    assert agents.composite_urgency(b) == 0.35 * 80 + 0.25 * 60 + 0.2 * 40 + 0.2 * 20
    assert [agents.tier_for(u) for u in (75, 74.9, 55, 54.9, 35, 34.9)] == ["P1", "P2", "P2", "P3", "P3", "P4"]


def test_out_of_range_llm_components_are_clamped(monkeypatch) -> None:
    async def wild(*a, **k):
        return {"severity": 150, "population": -20, "spread": "70", "time_criticality": 1e9, "rationale": "x" * 999}, 3

    monkeypatch.setattr(agents, "llm_json", wild)
    score, _ = asyncio.run(agents.run_risk(make_incident(), {"access_difficulty": 10, "escalation_risk": 10}))
    b = score.breakdown
    assert (b.severity, b.population, b.spread, b.time_criticality) == (100, 0, 70, 100)
    assert 0 <= score.urgency <= 100 and score.source == "llm" and len(b.rationale) <= 300


def test_unchanged_incident_is_not_rescored_by_the_llm(monkeypatch) -> None:
    calls = []

    async def counting(system, user, **k):
        calls.append(k["agent"])
        if k["agent"] == "terrain":
            return {"access_difficulty": 30, "escalation_risk": 40, "hazards": [], "notes": ""}, 1
        return {"severity": 60, "population": 60, "spread": 60, "time_criticality": 60, "rationale": "r"}, 1

    monkeypatch.setattr(agents, "llm_json", counting)
    inc = make_incident()

    async def cycle():
        t, _ = await agents.run_terrain(inc)
        return await agents.run_risk(inc, t)

    first, _ = asyncio.run(cycle())
    second, _ = asyncio.run(cycle())
    assert calls == ["terrain", "risk"]                    # second pass: zero LLM calls
    assert first.source == "llm" and second.source == "cached"
    assert first.urgency == second.urgency

    inc.affected_population *= 3                           # people changed ⇒ re-score risk, not terrain
    asyncio.run(cycle())
    assert calls == ["terrain", "risk", "risk"]


# -- capability matrix / logistics ------------------------------------------------

def test_capability_matrix_is_the_single_source_of_truth() -> None:
    assert ResourceType.ENGINEERING in agents.required_for(IncidentType.STRUCTURAL_COLLAPSE)
    res = {r.type: r for r in build_resources()}
    fire = make_incident(IncidentType.FIRE)
    assert agents.is_capable(res[ResourceType.FIRE_UNIT], fire)
    assert agents.is_capable(res[ResourceType.DRONE], fire)                # universal recon
    assert not agents.is_capable(res[ResourceType.SWIFT_WATER], fire)


def test_sanitize_rejects_everything_the_rules_forbid() -> None:
    resources = build_resources()
    by_name = {r.name: r for r in resources}
    fire = make_incident(IncidentType.FIRE, "P2")
    flood = make_incident(IncidentType.FLOOD, "P3")
    ranked = ranked_of(fire, flood)
    available = [r for r in resources if r.name != "Engine 2"]              # Engine 2 is busy
    raw = [
        {"incident_id": fire.id, "resource_id": by_name["Engine 1"].id, "role": "ok"},
        {"incident_id": fire.id, "resource_id": by_name["Engine 1"].id, "role": "dup"},        # same unit twice
        {"incident_id": fire.id, "resource_id": by_name["Engine 2"].id, "role": "busy"},       # not available
        {"incident_id": fire.id, "resource_id": by_name["Swift Water 1"].id, "role": "wrong"}, # incapable
        {"incident_id": fire.id, "resource_id": "res_ghost", "role": "ghost"},                 # unknown unit
        {"incident_id": "inc_ghost", "resource_id": by_name["Drone D1"].id, "role": "ghost"},  # unknown incident
        {"incident_id": flood.id, "resource_id": by_name["Swift Water 1"].id, "role": "ok"},
        {"incident_id": flood.id, "resource_id": by_name["Rescue 2"].id, "role": "too many"},  # P3 crew size is 1
        "garbage",
    ]
    out = agents.sanitize_assignments(raw, ranked, available, {})
    assert [(a["incident_id"], a["resource_id"]) for a in out] == [
        (fire.id, by_name["Engine 1"].id), (flood.id, by_name["Swift Water 1"].id)]


def test_crew_size_follows_tier() -> None:
    assert [agents.crew_needed(make_incident(tier=t), {}) for t in ("P1", "P2", "P3", "P4")] == [3, 2, 1, 1]
    inc = make_incident(tier="P1")
    assert agents.crew_needed(inc, {inc.id: 2}) == 1


def test_coverage_guard_never_leaves_a_p1_uncovered() -> None:
    resources = build_resources()
    p1 = make_incident(IncidentType.HAZMAT, "P1", lat=34.035, lon=-118.259)
    out = agents.coverage_guard([], ranked_of(p1), resources, {})
    assert len(out) == 1 and out[0]["source"] == "rules"
    assert next(r for r in resources if r.id == out[0]["resource_id"]).type in agents.required_for(IncidentType.HAZMAT)
    # ...but not when the incident already has a unit.
    assert agents.coverage_guard([], ranked_of(p1), resources, {p1.id: 1}) == []


def test_greedy_matcher_is_nearest_capable_and_respects_crew_size() -> None:
    resources = build_resources()
    inc = make_incident(IncidentType.FIRE, "P1", lat=34.035, lon=-118.259)     # Industrial Park
    out = agents.greedy_match(ranked_of(inc), resources, {})
    names = [next(r.name for r in resources if r.id == a["resource_id"]) for a in out]
    assert names[0] == "Engine 2"                                             # based at Industrial Park
    assert len(out) == 3                                                       # P1 crew = 3 (2 engines + a drone)


def test_logistics_prompt_measures_distance_per_incident(monkeypatch) -> None:
    captured = {}

    async def capture(system, user, **k):
        captured.update(json.loads(user))
        return {"assignments": []}, 1

    monkeypatch.setattr(agents, "llm_json", capture)
    near = make_incident(IncidentType.FIRE, "P2", lat=34.0580, lon=-118.2450)       # Downtown
    far = make_incident(IncidentType.FIRE, "P2", lat=34.0350, lon=-118.2590)        # Industrial Park
    asyncio.run(agents.run_logistics(ranked_of(near, far), build_resources(), {}))
    first = {c["name"]: c["eta_min"] for c in captured["incidents"][0]["candidates"]}
    second = {c["name"]: c["eta_min"] for c in captured["incidents"][1]["candidates"]}
    assert first["Engine 1"] < first["Engine 2"] and second["Engine 2"] < second["Engine 1"]


def test_logistics_skips_the_llm_when_nobody_needs_units(monkeypatch) -> None:
    async def boom(*a, **k):
        raise AssertionError("LLM must not be called")

    monkeypatch.setattr(agents, "llm_json", boom)
    inc = make_incident(tier="P2")
    out, latency = asyncio.run(agents.run_logistics(ranked_of(inc), build_resources(), {inc.id: 2}))
    assert out == [] and latency == 0


# -- command ---------------------------------------------------------------------

def test_command_gives_every_top_incident_a_card_even_if_the_llm_skips_one(monkeypatch) -> None:
    a, b = make_incident(IncidentType.FIRE, "P1"), make_incident(IncidentType.FLOOD, "P2")

    async def only_first(system, user, **k):
        return {"recommendations": [{"incident_id": a.id, "headline": "LLM order", "actions": ["x"], "warnings": []},
                                    {"incident_id": "inc_ghost", "headline": "ghost"}]}, 2

    monkeypatch.setattr(agents, "llm_json", only_first)
    recs, _ = asyncio.run(agents.run_command(ranked_of(a, b), [], []))
    assert [r["incident_id"] for r in recs] == [a.id, b.id]
    assert recs[0]["source"] == "llm" and recs[1]["source"] == "rules"
    assert any("No units deployed" in w for w in recs[1]["warnings"])
