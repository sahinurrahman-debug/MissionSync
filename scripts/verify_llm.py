#!/usr/bin/env python
"""Prove the five agents really run on Groq (no rule-based fallback) — cheaply.

    cd backend && ./.venv/Scripts/python ../scripts/verify_llm.py

Makes ONE small real call per agent (about 5k tokens in total) using the real
agent code paths, retries while Groq's daily quota is recovering, and exits 0 only
if every agent answered from the LLM. Run it after stopping any other backend that
is using the same key (a stale server can burn the whole daily quota by itself).
"""
import asyncio
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from missionsync import agents, llm  # noqa: E402  (loads backend/.env)
from missionsync.models import Incident, IncidentType, RiskBreakdown, RiskScore  # noqa: E402
from missionsync.simulator import TERRAIN, build_resources, initial_weather  # noqa: E402

WAIT_MINUTES = 12


def incident(itype, desc, zone, lat, lon, pop, inj, tier="P2") -> Incident:
    inc = Incident(type=itype, title=desc[:60], lat=lat, lon=lon, zone=zone, description=desc,
                   affected_population=pop, injuries=inj, terrain=TERRAIN[zone], weather=initial_weather()[zone])
    inc.risk = RiskScore(incident_id=inc.id, urgency=62.0, tier=tier, breakdown=RiskBreakdown(
        severity=1, population=1, spread=1, time_criticality=1, confidence=80, rationale="x"))
    return inc


async def until_llm(label, agent, call):
    """Retry while the quota recovers; True once `agent` has answered from the LLM."""
    deadline = time.time() + WAIT_MINUTES * 60
    while time.time() < deadline:
        llm._exhausted_until.clear()
        result = await call()
        if llm._agent_runs[agent]["last_mode"] == "llm":
            print(f"  ✔ {label}: answered by {llm.active_model() or llm.PRIMARY_MODEL}", flush=True)
            return result
        print(f"  … {label}: rate-limited, retrying in 60 s", flush=True)
        await asyncio.sleep(60)
    print(f"  ✘ {label}: no LLM answer within {WAIT_MINUTES} min", flush=True)
    return None


async def main() -> int:
    if not llm.API_KEY:
        print("GROQ_API_KEY is not set in backend/.env")
        return 2
    heavy = incident(IncidentType.STRUCTURAL_COLLAPSE,
                     "Downtown sector — Structural damage survey: 6 structures assessed — 2 collapsed or gutted, "
                     "2 severely damaged, 2 lightly damaged. Roughly 16 people in the affected footprint, 3 injured.",
                     "Downtown", 34.058, -118.245, 16, 3)
    quiet = incident(IncidentType.FIRE,
                     "Industrial Park sector — Fire damage survey: 8 structures assessed — 8 intact. About 1 person in the affected footprint, 0 injured.",
                     "Industrial Park", 34.035, -118.259, 1, 0, "P4")
    ok = True

    print("Surveillance", flush=True)
    s = await until_llm("surveillance", "surveillance", lambda: agents.run_surveillance(
        [{"source": "radio", "lat": 34.043, "lon": -118.238, "raw_text": "Missing child last seen near the Riverfront levee, wearing a red jacket"},
         {"source": "radio", "lat": 34.055, "lon": -118.24, "raw_text": "asdf qwerty nothing"}], []))
    if s:
        kinds = [i["type"] for i in s[0]]
        print(f"    parsed {kinds} (expect one missing_persons; gibberish dropped)")
    ok &= s is not None

    print("Terrain", flush=True)
    t = await until_llm("terrain", "terrain", lambda: agents.run_terrain(heavy))
    ok &= t is not None

    print("Risk", flush=True)
    r1 = await until_llm("risk (collapse)", "risk", lambda: agents.run_risk(heavy, t[0] if t else {"access_difficulty": 20, "escalation_risk": 30}))
    r2 = await agents.run_risk(quiet, {"access_difficulty": 20, "escalation_risk": 30, "hazards": []}) if r1 else None
    if r1 and r2 and r2[0].source == "llm":
        print(f"    collapse urgency {r1[0].urgency} vs all-intact scene {r2[0].urgency} (expect collapse ≫ intact)")
        ok &= r1[0].urgency > r2[0].urgency
    ok &= r1 is not None

    print("Logistics", flush=True)
    res = build_resources()
    lg = await until_llm("logistics", "logistics", lambda: agents.run_logistics([(1, heavy), (2, quiet)], res, {}))
    if lg:
        print("    assignments:", [(a["source"], next(x.name for x in res if x.id == a["resource_id"])) for a in lg[0]])
    ok &= lg is not None

    print("Command", flush=True)
    cm = await until_llm("command", "command", lambda: agents.run_command([(1, heavy), (2, quiet)], [], list(initial_weather().values())))
    if cm:
        print("    orders:", [(c["source"], c["headline"][:60]) for c in cm[0]])
    ok &= cm is not None

    st = llm.llm_stats()
    print("\nmode:", st["mode"], "| tokens used:", st["quota"]["tokens_used"])
    print("RESULT:", "PASS — all five agents ran on the LLM" if ok else "FAIL — see above")
    return 0 if ok else 1


sys.exit(asyncio.run(main()))
