"""Human-approved dispatch, the incident/unit controls, ending a drill, idempotency,
provisional-then-refined scoring, continuous waves and restart recovery."""
import asyncio
import json
import time

import pytest

from missionsync import agents, llm
from missionsync.models import IncidentStatus, IncomingReport
from missionsync.orchestrator import DomainError, Orchestrator
from missionsync.persistence import Store

from .fakes import FakeGroq
from .test_orchestrator import booted, inject, run, settle, tick


def unit(o, name):
    return next(r for r in o.resources if r.name == name)


# -- the PRD rule: agents recommend, a human commits ---------------------------------------

def test_by_default_nothing_moves_until_a_human_approves() -> None:
    async def go():
        o = await booted(auto=False)
        snap = o.snapshot()
        assert snap.settings["dispatch_mode"] == "manual"
        assert len(snap.proposals) >= 5 and all(r.status == "available" for r in snap.resources)
        assert snap.metrics["recommendation_quality"]["pending_proposals"] == len(snap.proposals)
        await tick(o, 3)
        assert all(r.status == "available" for r in o.resources)              # still waiting for a person

        before = len(o.proposals)
        await o.approve()
        assert not o.proposals or all(p.id not in {x.id for x in snap.proposals} for p in o.proposals.values())
        assert {r.status for r in o.resources} & {"en_route"} and before > 0
        assert any("Net control approved" in e.msg for e in o.event_log)
    run(go())


def test_approving_one_proposal_commits_only_that_pair() -> None:
    async def go():
        o = await booted(auto=False)
        first = sorted(o.proposals.values(), key=lambda p: p.priority)[0]
        await o.approve([first.id])
        assert next(r for r in o.resources if r.id == first.resource_id).assigned_incident == first.incident_id
        assert sum(1 for r in o.resources if r.assigned_incident) == 1
        with pytest.raises(DomainError) as e:
            await o.approve(["inc_ghost:res_ghost"])
        assert e.value.status == 404
    run(go())


def test_a_rejected_pair_is_never_proposed_again() -> None:
    async def go():
        o = await booted(auto=False)
        p = sorted(o.proposals.values(), key=lambda x: x.priority)[0]
        await o.reject(p.id)
        assert (p.incident_id, p.resource_id) in o.rejected
        assert p.id not in o.proposals
        assert all((x.incident_id, x.resource_id) != (p.incident_id, p.resource_id) for x in o.proposals.values())
        await tick(o, 4)
        assert p.id not in o.proposals
        with pytest.raises(DomainError):
            await o.reject(p.id)
    run(go())


def test_manual_dispatch_overrides_and_is_fully_validated() -> None:
    async def go():
        o = await booted(auto=False)
        inc = o._ranked()[0][1]
        needed = agents.required_for(inc.type)[0]
        capable = next(r for r in o.resources if r.type == needed)
        snap = await o.manual_dispatch(inc.id, capable.id, "my call")
        assert capable.assigned_incident == inc.id and capable.role == "my call" and capable.status == "en_route"
        assert any("Net control dispatched" in e.msg for e in o.event_log)

        with pytest.raises(DomainError) as busy:
            await o.manual_dispatch(inc.id, capable.id)
        assert busy.value.status == 409 and "not available" in busy.value.message
        swift = unit(o, "Swift Water 1")
        fire = next((i for _, i in o._ranked() if i.type.value == "fire"), None)
        if fire:
            with pytest.raises(DomainError) as incapable:
                await o.manual_dispatch(fire.id, swift.id)
            assert incapable.value.status == 409
        with pytest.raises(DomainError) as e:
            await o.manual_dispatch("inc_ghost", swift.id)
        assert e.value.status == 404
        with pytest.raises(DomainError) as e2:
            await o.manual_dispatch(inc.id, "res_ghost")
        assert e2.value.status == 404
    run(go())


def test_recall_releases_a_unit_and_the_incident_status_follows() -> None:
    async def go():
        o = await booted(auto=True)
        busy = next(r for r in o.resources if r.status == "en_route")
        inc = o.incidents[busy.assigned_incident]
        await o.recall(busy.id)
        assert busy.status == "returning" and busy.assigned_incident is None
        assert inc.status in (IncidentStatus.TRIAGED, IncidentStatus.UNITS_EN_ROUTE, IncidentStatus.ON_SCENE)
        with pytest.raises(DomainError) as e:
            await o.recall(busy.id)                                              # already returning
        assert e.value.status == 409
        with pytest.raises(DomainError):
            await o.recall("res_ghost")
    run(go())


def test_net_control_can_contain_or_close_an_incident() -> None:
    async def go():
        o = await booted(auto=True)
        (_, a), (_, b) = o._ranked()[0], o._ranked()[1]
        await o.set_incident_status(a.id, "contained")
        await o.set_incident_status(b.id, "closed")
        assert a.status == IncidentStatus.CONTAINED and b.status == IncidentStatus.CLOSED
        assert not any(r.assigned_incident in (a.id, b.id) for r in o.resources)
        assert not any(p.incident_id in (a.id, b.id) for p in o.proposals.values())
        assert o._resolved == 2
        assert a.id not in {i.id for i in o.snapshot().incidents}
        with pytest.raises(DomainError) as e:
            await o.set_incident_status(a.id, "closed")
        assert e.value.status == 409
        with pytest.raises(DomainError) as bad:
            await o.set_incident_status(o._ranked()[0][1].id, "exploded")
        assert bad.value.status == 400
    run(go())


def test_toggling_auto_dispatch_commits_the_pending_recommendations() -> None:
    async def go():
        o = await booted(auto=False)
        assert o.proposals
        await o.set_auto_dispatch(True)
        assert o.auto_dispatch and {r.status for r in o.resources} & {"en_route"}
        await o.set_auto_dispatch(False)
        assert o.snapshot().settings["auto_dispatch"] is False
    run(go())


# -- ending a drill, idempotency -------------------------------------------------------------

def test_an_ended_drill_is_frozen_and_refuses_new_work() -> None:
    async def go():
        o = await booted(auto=True)
        snap = await o.end_drill()
        assert snap.status == "ended" and any("Drill ended" in e.msg for e in o.event_log)
        t = o.tick
        await tick(o, 5)
        assert o.tick == t                                                     # the world does not advance
        for call in (lambda: inject(o, "Fire at Downtown"), lambda: o.approve(), lambda: o.end_drill(),
                     lambda: o.recall("res_fire1")):
            with pytest.raises(DomainError) as e:
                await call()
            assert e.value.status == 409
        e1 = o.elapsed_s(); time.sleep(1.1)
        assert o.elapsed_s() == e1                                             # the clock stops with the drill
        revived = await o.reset()
        assert revived.status == "live"
    run(go())


def test_a_retried_report_with_the_same_nonce_is_processed_once() -> None:
    async def go():
        o = await booted()
        n = len(o.incidents)
        a, _ = await inject(o, "Ammonia leak at Industrial Park depot, 4 workers hurt", client_nonce="abc-123")
        b, _ = await inject(o, "Ammonia leak at Industrial Park depot, 4 workers hurt", client_nonce="abc-123")
        assert a.kind == "created" and b == a
        assert len(o.incidents) == n + 1 and o._injection_count == 1
        c, _ = await inject(o, "Ammonia leak at Industrial Park depot, 4 workers hurt", client_nonce="other")
        assert c.kind == "merged"                                              # a different nonce is a new report
    run(go())


# -- provisional first, AI refinement after ---------------------------------------------------

def test_reports_rank_instantly_then_the_llm_refines_them_without_blocking_the_next_report(monkeypatch) -> None:
    fake = FakeGroq(delay=0.4)                                                  # every LLM call takes 0.4 s
    monkeypatch.setattr(llm, "_client", fake)

    async def go():
        o = await booted(auto=False)
        o._refine_task = asyncio.create_task(o._refine_loop())
        t = time.perf_counter()
        first, _ = await inject(o, "Fire spreading near the University lab block, three students trapped")
        fast1 = time.perf_counter() - t
        t = time.perf_counter()
        second, _ = await inject(o, "Flood at Riverfront marina, 3 people trapped on a boat")
        fast2 = time.perf_counter() - t
        assert first.kind == second.kind == "created" and first.provisional and second.provisional
        assert first.tier and first.urgency is not None                        # a real tier, immediately
        assert fast1 < 0.35 and fast2 < 0.35, f"intake blocked on the LLM ({fast1:.2f}s, {fast2:.2f}s)"
        inc = o.incidents[first.incident_id]
        assert inc.provisional and inc.risk.source == "rules"
        assert o.snapshot().metrics["provisional_incidents"] >= 2

        await settle(o, timeout=15)
        assert not inc.provisional and inc.risk.source in ("llm", "cached")
        assert inc.risk.breakdown.rationale == "llm rationale"
        assert any("AI refinement complete" in e.msg for e in o.event_log)
        o._refine_task.cancel()
    run(go())


def test_without_an_llm_reports_are_final_not_provisional() -> None:
    async def go():
        o = await booted()
        out, _ = await inject(o, "Fire spreading near the University lab block, three students trapped")
        assert out.provisional is False and not o.incidents[out.incident_id].provisional
    run(go())


def test_text_the_rules_cannot_classify_waits_for_the_llm_to_decide(monkeypatch) -> None:
    collapse = {"type": "structural_collapse", "title": "Building shaking, people screaming", "description": "x",
                "lat": 34.058, "lon": -118.245, "zone": "Downtown", "affected_population": 30, "injuries": 5,
                "counts_reported": True, "confidence": 0.8, "linked_incident_id": None}
    # The fake finds nothing in text the rules can't classify; the "LLM" understands it.
    fake = FakeGroq(hooks={"surveillance": lambda p: p if p["incidents"] else {"incidents": [collapse]}})
    monkeypatch.setattr(llm, "_client", fake)

    async def go():
        o = await booted()
        out, _ = await inject(o, "the building is shaking and everyone is screaming downtown")
        assert out.kind == "created" and o.incidents[out.incident_id].type.value == "structural_collapse"
        assert out.provisional is False                                         # the LLM scored it inline
    run(go())


def test_llm_scores_are_reused_across_a_reset_so_a_restart_costs_no_tokens(monkeypatch) -> None:
    fake = FakeGroq()
    monkeypatch.setattr(llm, "_client", fake)

    async def go():
        o = await booted()
        terrain, risk = fake.count("terrain"), fake.count("risk")
        assert terrain >= 5 and risk >= 5
        await o.reset()
        assert fake.count("terrain") == terrain and fake.count("risk") == risk   # 0 new terrain/risk calls
        assert all(i.risk.source == "cached" for i in o.snapshot().incidents)
    run(go())


def test_idle_ticks_never_call_the_llm_directly(monkeypatch) -> None:
    fake = FakeGroq()
    monkeypatch.setattr(llm, "_client", fake)

    async def go():
        o = await booted()
        await tick(o, 12)
        await settle(o, timeout=10)
        n = len(fake.calls)
        await tick(o, 10)                                                       # quiet world: unchanged inputs
        await asyncio.sleep(0.2)
        return len(fake.calls) - n
    assert run(go()) <= 4


# -- a drill that lasts hours, not minutes ----------------------------------------------------------

def test_reports_keep_arriving_after_the_scripted_opening() -> None:
    async def go():
        o = await booted()
        await tick(o, 75)
        arrivals = [e for e in o.event_log if "New incoming signal" in e.msg]
        assert len(arrivals) >= 6                                                # 4 scripted waves + recycled ones
        assert o.tick == 75
    run(go())


# -- restart recovery ----------------------------------------------------------------------------------

def test_world_state_round_trips_through_json() -> None:
    async def go():
        o = await booted(auto=False)
        await inject(o, "Fire spreading near the University lab block, three students trapped")
        await o.approve()
        await tick(o, 6)
        state = json.loads(json.dumps(o.export_state()))
        r = Orchestrator(auto_dispatch=True)
        r.import_state(state)
        assert r.tick == o.tick and r.status == o.status and r.auto_dispatch == o.auto_dispatch
        assert {i.id: round(i.risk.urgency, 1) for i in r.incidents.values() if i.risk} == \
               {i.id: round(i.risk.urgency, 1) for i in o.incidents.values() if i.risk}
        assert [(x.id, x.status, x.assigned_incident) for x in r.resources] == [(x.id, x.status, x.assigned_incident) for x in o.resources]
        assert set(r.proposals) == set(o.proposals) and r._seq == o._seq and r._resolved == o._resolved
        # live weather cells are re-linked, not copies
        inc = next(iter(r.incidents.values()))
        assert inc.weather is r.sim.weather_for(inc.lat, inc.lon)
        await tick(r, 1), await tick(o, 1)
        assert [(e.msg) for e in r.event_log[-3:]] == [(e.msg) for e in o.event_log[-3:]]    # same next tick
    run(go())


def test_a_restarted_server_resumes_the_saved_drill(tmp_path) -> None:
    async def go():
        url = f"sqlite:///{tmp_path / 'r.db'}"
        a = await booted(auto=True, store=Store(url))
        await inject(a, "Ammonia leak at Industrial Park depot, 4 workers hurt")
        await tick(a, 4)
        snap_a = a.snapshot()

        b = Orchestrator(Store(url), auto_dispatch=False)
        assert await b._try_restore() is True
        snap_b = b.snapshot()
        assert snap_b.status == "live" and b.tick == a.tick and b.drill_id == a.drill_id
        assert [i.id for i in snap_b.incidents] == [i.id for i in snap_a.incidents]
        assert any("restored from the database" in e.msg for e in b.event_log)
        assert snap_b.metrics["injections"] if "injections" in snap_b.metrics else True
        await tick(b, 2)                                                        # and it keeps running
        assert b.tick == a.tick + 2

        fresh = Orchestrator(Store(f"sqlite:///{tmp_path / 'empty.db'}"))
        assert await fresh._try_restore() is False                              # nothing saved → bootstrap instead
        assert await Orchestrator()._try_restore() is False                     # no database at all
    run(go())


def test_a_stale_saved_drill_is_not_resumed(tmp_path, monkeypatch) -> None:
    async def go():
        url = f"sqlite:///{tmp_path / 's.db'}"
        await booted(store=Store(url))
        from missionsync import orchestrator
        monkeypatch.setattr(orchestrator, "STATE_MAX_AGE_S", -1)                # anything is "too old"
        assert await Orchestrator(Store(url))._try_restore() is False
    run(go())


def test_llm_cache_survives_json_and_a_fresh_process(tmp_path) -> None:
    async def go():
        fake = FakeGroq()
        llm._client = fake
        o = await booted()
        inc = next(iter(o.incidents.values()))
        assert agents.has_cached_risk(inc)
        dump = json.loads(json.dumps(agents.export_caches()))
        agents.clear_caches()
        assert not agents.has_cached_risk(inc)
        assert agents.import_caches(dump) >= 10
        assert agents.has_cached_risk(inc)
    run(go())


def test_audit_events_are_not_lost_when_the_database_hiccups(tmp_path, monkeypatch) -> None:
    async def go():
        store = Store(f"sqlite:///{tmp_path / 'e.db'}")
        o = await booted(store=store)
        real = store.add_events
        calls = {"n": 0}

        def flaky(drill_id, events):
            calls["n"] += 1
            return False if calls["n"] == 1 else real(drill_id, events)

        monkeypatch.setattr(store, "add_events", flaky)
        o._log("first line written while the database is down")
        await o._persist()
        assert any("first line" in e.msg for e in o._unsaved)                   # re-queued, not dropped
        o._log("second line")
        await o._persist()
        stored = [e["msg"] for e in store.drill_events(o.drill_id)]
        assert any("first line" in m for m in stored) and any("second line" in m for m in stored)
        assert not o._unsaved
    run(go())
