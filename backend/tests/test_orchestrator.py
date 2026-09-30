import asyncio

import pytest

from missionsync import agents, llm, orchestrator
from missionsync.models import IncidentStatus, IncomingReport
from missionsync.orchestrator import Orchestrator, _spearman

from .fakes import FakeGroq


def run(coro):
    return asyncio.run(coro)


async def booted() -> Orchestrator:
    o = Orchestrator()
    await o.bootstrap()
    return o


async def tick(o: Orchestrator, n: int = 1) -> None:
    for _ in range(n):
        async with o._lock:
            await o._tick_once()


def inject(o: Orchestrator, text: str, **kw):
    return o.inject_report(IncomingReport(text=text, **kw))


# -- boot ---------------------------------------------------------------------------

def test_bootstrap_seeds_real_incidents_ranks_them_and_deploys_units() -> None:
    async def go():
        o = await booted()
        snap = o.snapshot()
        assert snap.status == "live" and o.dataset_source == "xbd_snapshot"
        assert len(snap.incidents) == 5
        urgencies = [i.risk.urgency for i in snap.incidents]
        assert urgencies == sorted(urgencies, reverse=True)
        assert all(i.risk.tier == agents.tier_for(i.risk.urgency) for i in snap.incidents)
        assert {r.status for r in snap.resources} & {"en_route"}
        assert set(o.sim.ground_truth) == {i.id for i in snap.incidents}
        assert snap.metrics["ranking_accuracy"]["evaluated_incidents"] == 5
        assert snap.event_log[0].seq < snap.event_log[-1].seq and snap.event_log[-1].t.endswith("Z")
    run(go())


# -- reports: location, merging, rejection --------------------------------------------

def test_a_report_naming_a_place_lands_there_and_does_not_merge_into_a_neighbour() -> None:
    async def go():
        o = await booted()
        await tick(o, 2)                                   # a wave fire may already exist elsewhere
        before = len(o.incidents)
        outcome, snap = await inject(o, "fire spreading near the University lab block, three students trapped")
        inc = o.incidents[outcome.incident_id]
        assert outcome.kind == "created" and inc.zone == "University" and inc.location_known
        assert len(o.incidents) == before + 1
        assert outcome.tier in ("P1", "P2", "P3", "P4") and outcome.urgency is not None      # toast data is real
        assert inc.affected_population == 3 and inc.injuries == 3
    run(go())


def test_two_reports_about_the_same_place_and_type_merge() -> None:
    async def go():
        o = await booted()
        first, _ = await inject(o, "Ammonia leak at Industrial Park depot, fumes everywhere")
        second, _ = await inject(o, "Industrial Park ammonia leak now reaching the neighbouring depot, 6 workers evacuated")
        assert (first.kind, second.kind) == ("created", "merged") and first.incident_id == second.incident_id
        inc = o.incidents[first.incident_id]
        assert inc.merged_reports == 1 and inc.status == IncidentStatus.TRIAGED or inc.status.value.startswith("units")
    run(go())


def test_unlocated_reports_are_not_guessed_into_an_incident_by_geography() -> None:
    async def go():
        o = await booted()
        a, _ = await inject(o, "smoke from Building C, two people coughing")
        b, _ = await inject(o, "fire alarm and smoke in another building, three people coughing")
        assert a.kind == b.kind == "created" and a.incident_id != b.incident_id
        assert o.incidents[a.incident_id].zone == "Unlocated" and not o.incidents[a.incident_id].location_known
    run(go())


def test_merging_a_report_without_numbers_does_not_inflate_the_population() -> None:
    async def go():
        o = await booted()
        first, _ = await inject(o, "Collapse at Downtown storefront, 4 people trapped")
        pop = o.incidents[first.incident_id].affected_population
        second, _ = await inject(o, "Downtown collapse: rescuers hearing tapping under the rubble")
        assert second.kind == "merged"
        assert o.incidents[first.incident_id].affected_population == pop == 4      # not bumped to the type default (15)
        third, _ = await inject(o, "Downtown collapse update: now 9 people trapped")
        assert o.incidents[first.incident_id].affected_population == 9
    run(go())


def test_gibberish_is_rejected_and_creates_nothing() -> None:
    async def go():
        o = await booted()
        n, units = len(o.incidents), [r.status for r in o.resources]
        outcome, _ = await inject(o, "asdf qwerty nothing")
        assert outcome.kind == "rejected" and "No emergency recognised" in outcome.message
        assert len(o.incidents) == n and [r.status for r in o.resources] == units
    run(go())


def test_explicit_coordinates_are_respected() -> None:
    async def go():
        o = await booted()
        outcome, _ = await inject(o, "Crash on the arterial, two injured", lat=34.052, lon=-118.221)
        inc = o.incidents[outcome.incident_id]
        assert (inc.lat, inc.lon) == (34.052, -118.221) and inc.zone == "Eastside" and inc.location_known
    run(go())


# -- the seeded follow-up must merge, never duplicate ---------------------------------------

def test_the_follow_up_report_folds_into_the_incident_it_is_about() -> None:
    async def go():
        o = await booted()
        seeded = len(o.incidents)
        await tick(o, 3)                                                         # tick 2 wave, tick 3 follow-up
        assert len(o.incidents) == seeded + 1                                   # the wave only; follow-up merged
        assert any(i.merged_reports >= 1 for i in o.incidents.values())
        assert any("Follow-up report" in e.msg for e in o.event_log) and any("merged into" in e.msg for e in o.event_log)
    run(go())


# -- lifecycle -----------------------------------------------------------------------------

def test_incidents_are_worked_contained_and_units_return_to_base() -> None:
    async def go():
        o = await booted()
        await tick(o, 90)
        assert o._resolved > 0
        contained = [i for i in o.incidents.values() if i.status == IncidentStatus.CONTAINED]
        assert contained and all(i.id not in {x.id for x in o.snapshot().incidents} for i in contained)
        assert any("Contained" in e.msg for e in o.event_log) and any("back at base" in e.msg for e in o.event_log)
        for r in o.resources:                       # no unit is stranded on a contained/closed incident
            if r.assigned_incident:
                assert o.incidents[r.assigned_incident].status in orchestrator.ACTIVE_STATUSES
        assert o.snapshot().metrics["recommendation_quality"]["resolved_incidents"] == o._resolved
    run(go())


def test_uninjured_scenes_do_not_grow_and_injured_ones_are_capped() -> None:
    async def go():
        o = await booted()
        quiet = next(i for i in o.incidents.values() if i.injuries == 0)
        pop = quiet.affected_population
        for r in o.resources:                        # take every unit out of play so nothing is addressed
            r.status = "on_scene"
        await tick(o, 30)
        assert quiet.affected_population == pop
        hurt = [i for i in o.incidents.values() if i.injuries > 0 and i.status == IncidentStatus.NEW]
        for i in hurt:
            assert i.affected_population <= 3 * o._pop_baseline[i.id]
    run(go())


# -- concurrency & rules ----------------------------------------------------------------------

def test_concurrent_injections_and_ticks_never_double_book_a_unit() -> None:
    async def go():
        o = await booted()
        texts = [f"Fire reported in {z}, several people hurt" for z in
                 ("Downtown", "Riverfront", "North Hills", "Eastside", "University", "Industrial Park")]
        await asyncio.gather(*(inject(o, t) for t in texts), tick(o, 3), tick(o, 3))
        counts = {}
        for r in o.resources:
            if r.assigned_incident:
                counts[r.assigned_incident] = counts.get(r.assigned_incident, 0) + 1
                assert r.status in ("en_route", "on_scene")
        for inc_id, n in counts.items():
            assert n <= agents.CREW_CAP[agents.tier_of(o.incidents[inc_id])]
    run(go())


def test_ground_truth_metric_ignores_injected_reports() -> None:
    async def go():
        o = await booted()
        before = o.snapshot().metrics["ranking_accuracy"]
        for t in ("Fire in the University chemistry lab, 5 people hurt", "Flood at Riverfront marina, 3 people trapped"):
            await inject(o, t)
        after = o.snapshot().metrics["ranking_accuracy"]
        assert after["evaluated_incidents"] == before["evaluated_incidents"] == 5
        assert after["spearman"] == before["spearman"]
    run(go())


def test_reset_restores_a_clean_drill() -> None:
    async def go():
        o = await booted()
        await inject(o, "Fire in the University chemistry lab, 5 people hurt")
        await tick(o, 5)
        snap = await o.reset()
        assert snap.status == "live" and len(snap.incidents) == 5 and snap.tick == 0
        assert snap.metrics["recommendation_quality"]["injections_processed"] == 0
        assert not any("INJECTED" in e.msg for e in snap.event_log)
    run(go())


def test_apply_assignments_is_the_last_gate_even_for_a_bad_proposal() -> None:
    async def go():
        o = await booted()
        ranked = o._ranked()
        inc = ranked[0][1]
        busy = next(r for r in o.resources if r.status == "en_route")
        swift = next(r for r in o.resources if r.name == "Swift Water 1")
        swift.status, swift.assigned_incident = "available", None
        bad = [{"incident_id": inc.id, "resource_id": busy.id},                          # not available
               {"incident_id": inc.id, "resource_id": swift.id},                         # wrong capability for a fire?
               {"incident_id": "inc_nope", "resource_id": swift.id}]
        before = busy.assigned_incident
        o._apply_assignments(bad, ranked)
        assert busy.assigned_incident == before
        assert swift.assigned_incident in (None, inc.id) and (swift.assigned_incident is None or agents.is_capable(swift, inc))
    run(go())


# -- pure LLM mode: the pipeline with a live-shaped model and NO rule-based fallback ---------------

def test_full_pipeline_runs_in_pure_llm_mode(monkeypatch) -> None:
    fake = FakeGroq()
    monkeypatch.setattr(llm, "_client", fake)

    async def go():
        o = await booted()
        outcome, snap = await inject(o, "Fire spreading near the University lab block, three students trapped")
        assert outcome.kind == "created"
        stats = llm.llm_stats()
        assert stats["mode"] == "llm" and stats["success_rate"] == 1.0
        assert all(a["fallbacks"] == 0 and a["llm_successes"] > 0 for a in stats["agents"].values())
        assert snap.metrics["scoring_sources"].get("rules", 0) == 0
        assert all(i.risk.source in ("llm", "cached") and i.risk.breakdown.rationale == "llm rationale" for i in snap.incidents)
        assert all(a.headline.startswith("LLM order") for a in snap.actions)
        await tick(o, 9)                                     # scripted waves + follow-up are over after tick 8
        calls_before = len(fake.calls)
        await tick(o, 5)                                     # idle ticks must be (nearly) free
        return len(fake.calls) - calls_before
    idle_calls = run(go())
    assert idle_calls <= 10, f"5 idle ticks burned {idle_calls} LLM calls"          # the old code made ~12 *per tick*


def test_bad_llm_proposals_never_reach_world_state(monkeypatch) -> None:
    def corrupt_logistics(payload):
        return {"assignments": payload["assignments"] + [
            {"incident_id": "inc_ghost", "resource_id": "res_fire1", "role": "x"},
            {"incident_id": "inc_ghost2", "resource_id": "res_ghost", "role": "y"}]}

    def corrupt_surveillance(payload):
        payload["incidents"].append({"type": "earthquake", "title": "bad type", "lat": 34.05, "lon": -118.24})
        return payload

    monkeypatch.setattr(llm, "_client", FakeGroq(hooks={"logistics": corrupt_logistics, "surveillance": corrupt_surveillance}))

    async def go():
        o = await booted()
        assert len(o.incidents) == 5                                # the invalid 'earthquake' record was dropped
        for r in o.resources:
            if r.assigned_incident:
                assert r.assigned_incident in o.incidents
    run(go())


def test_quota_exhaustion_degrades_visibly_instead_of_silently(monkeypatch) -> None:
    class Quota(Exception):
        status_code = 429

    async def create(**kw):
        raise Quota("Rate limit ... on tokens per day (TPD): Limit 200000 ... try again in 7m0s")

    from types import SimpleNamespace
    monkeypatch.setattr(llm, "_client", SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create))))

    async def go():
        o = await booted()
        snap = o.snapshot()
        assert len(snap.incidents) == 5                              # the board still works (rule-based twins)
        assert snap.metrics["mode"] == "quota_exhausted" and snap.metrics["model"] is None
        assert snap.metrics["scoring_sources"] == {"rules": 5}
    run(go())


# -- math ---------------------------------------------------------------------------------------

def test_spearman() -> None:
    assert _spearman([1, 2, 3, 4], [10, 20, 30, 40]) == 1.0
    assert _spearman([1, 2, 3, 4], [40, 30, 20, 10]) == -1.0
    assert _spearman([1, 1, 1], [1, 2, 3]) is None
    assert _spearman([1], [1]) is None
    assert _spearman([1, 2, 2, 4], [1, 2, 3, 4]) == pytest.approx(0.949, abs=1e-3)
