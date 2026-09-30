"""MissionSync orchestrator — the live-update pipeline.

Owns the world state and runs the agent pipeline on every cycle:
    signals ─► surveillance ─► terrain ─► risk ─► logistics ─► command
New signals (including judge injections) merge into state *in place* —
no restart, no manual re-run.

Concurrency: every mutation of world state happens under one asyncio.Lock, so
a report injected mid-tick can never interleave with the sim heartbeat (two
pipelines racing on the same free units would double-book them).

LLM budget: idle ticks are free. Terrain/risk results are cached until their
inputs materially change, logistics is only consulted when an incident needs
units, and command is only re-drafted when the top picture changes.
"""
from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Optional

from . import agents, simulator as sim, xbd
from .llm import llm_stats
from .persistence import Store
from .models import (
    Deployment,
    EventLine,
    Incident,
    IncidentStatus,
    IncidentType,
    IncomingReport,
    Pipeline,
    RecommendedAction,
    ReportOutcome,
    Resource,
    WorldSnapshot,
    utcnow,
)

logger = logging.getLogger(__name__)
Simulator = sim.Simulator

TICK_SECONDS = 6.0
LOG_CAP = 300
# Ticks a crew works on scene before the incident is contained (6 s per tick).
WORK_TICKS = {"P1": 24, "P2": 20, "P3": 12, "P4": 8}
ACTIVE_STATUSES = (
    IncidentStatus.NEW, IncidentStatus.TRIAGED, IncidentStatus.UNITS_EN_ROUTE, IncidentStatus.ON_SCENE,
)


def _clock() -> str:
    d = datetime.now(timezone.utc)
    return f"{d.hour:02d}:{d.minute:02d}:{d.second:02d}Z"


class Orchestrator:
    def __init__(self, store: Optional[Store] = None) -> None:
        self.store = store or Store(None)          # disabled store = pure in-memory
        self.drill_id: Optional[int] = None
        self._unsaved: list[EventLine] = []
        self._broadcast: Optional[Callable[[WorldSnapshot], Awaitable[None]]] = None
        self._lock = asyncio.Lock()
        self._records: Optional[list[dict[str, Any]]] = None   # xBD seeds, loaded once
        self.dataset_source = "not_loaded"
        self._reset_state()

    def _reset_state(self) -> None:
        self.sim = Simulator()
        self.incidents: dict[str, Incident] = {}
        self.resources: list[Resource] = sim.build_resources()
        self.event_log: list[EventLine] = []
        self._unsaved = []
        self.drill_id = None
        self._seq = 0
        self.tick = 0
        self.status = "booting"
        self.stage = "idle"
        self.origin = "boot"
        self.cycle_latency_ms = 0
        self.last_pipeline: dict[str, int] = {}
        self._injection_count = 0
        self._resolved = 0
        self._on_scene_ticks: dict[str, int] = {}
        self._pop_baseline: dict[str, int] = {}
        self._command_raw: list[dict[str, Any]] = []
        self._command_sig: Optional[tuple] = None
        self.recommendations: list[RecommendedAction] = []
        agents.clear_caches()

    # -- lifecycle ---------------------------------------------------------

    def on_broadcast(self, cb: Callable[[WorldSnapshot], Awaitable[None]]) -> None:
        self._broadcast = cb

    async def _persist(self) -> None:
        """Flush new audit lines to the database (a no-op without one; never raises)."""
        if not self.store.enabled or not self._unsaved:
            return
        batch, self._unsaved = self._unsaved, []
        await asyncio.to_thread(self.store.add_events, self.drill_id, [(e.seq, e.t, e.msg) for e in batch])

    def _log(self, msg: str) -> None:
        self._seq += 1
        line = EventLine(seq=self._seq, t=_clock(), msg=msg)
        self.event_log.append(line)
        if self.store.enabled:
            self._unsaved.append(line)
        if len(self.event_log) > LOG_CAP:
            del self.event_log[: len(self.event_log) - LOG_CAP]

    async def run(self, interval_s: float = TICK_SECONDS) -> None:
        """Bootstrap the scenario, then run the heartbeat forever."""
        try:
            await self.bootstrap()
        except Exception as exc:  # the server must stay up even if the seed cycle fails
            logger.exception("bootstrap failed")
            self._log(f"❗ bootstrap error: {exc}")
            self.status = "live"
            await self._push()
        await self.run_forever(interval_s)

    async def bootstrap(self) -> None:
        """Seed the scenario so the dashboard has something on first paint."""
        async with self._lock:
            await self._bootstrap_locked()

    async def _bootstrap_locked(self) -> None:
        self.status = "booting"
        self.origin = "boot"
        await self._push()
        if self._records is None:
            # kagglehub does blocking network I/O — keep it off the event loop.
            self._records = await asyncio.to_thread(xbd.load_seeds)
        self.dataset_source = xbd.DATA_SOURCE
        self.sim.configure_dataset(self._records)
        source = {
            "kaggle": f"real xBD data via Kaggle ({xbd.KAGGLE_SLUG})",
            "xbd_snapshot": "bundled real xBD snapshot",
        }.get(self.dataset_source, "synthetic offline cohort")
        self.drill_id = await asyncio.to_thread(self.store.start_drill, self.dataset_source)
        signals = self.sim.seed_events()
        self._log(f"🟢 Scenario loaded: {len(signals)} initial incidents, {len(self.resources)} resources — dataset: {source}")
        await self._ingest(signals, origin="boot")     # one batch = one pass through the 5 agents
        self.status = "live"
        await self._persist()
        await self._push()

    async def reset(self) -> WorldSnapshot:
        """Start the drill over (same scenario, fresh state)."""
        async with self._lock:
            self._reset_state()
            self.origin = "reset"
            await self._bootstrap_locked()
            return self.snapshot()

    # -- signal ingestion (the no-restart live path) ------------------------

    async def ingest_signals(self, signals: list[dict[str, Any]], label: str = "signal") -> list[dict[str, Any]]:
        """Full pipeline over a batch of raw signals. Safe to call any time."""
        async with self._lock:
            return await self._ingest(signals, origin="sim")

    async def _stage(self, stage: str) -> None:
        self.stage = stage
        await self._push()

    async def _ingest(self, signals: list[dict[str, Any]], origin: str) -> list[dict[str, Any]]:
        started = time.perf_counter()
        stage_times: dict[str, int] = {}
        self.origin = origin

        # 1. Surveillance: parse signals into incidents
        await self._stage("surveillance")
        t0 = time.perf_counter()
        parsed, lat = await agents.run_surveillance(signals, list(self.incidents.values()))
        stage_times["surveillance_ms"] = int((time.perf_counter() - t0) * 1000)
        self._log(f"🛰 Surveillance parsed {len(parsed)} incident(s) from {len(signals)} signal(s) [{lat}ms]")

        # 2. Merge or create
        touched: list[Incident] = []
        outcomes: list[dict[str, Any]] = []
        for p in parsed:
            sig = self._signal_for(p, signals)
            located = bool(sig.get("location_known", True)) if sig else True
            target = self._resolve_target(p, located)
            if target is not None:
                inc, kind = self._merge_into(target, p), "merged"
            else:
                inc, kind = self._create_incident(p, located), "created"
                gt = sig.get("_ground_truth_urgency") if sig else None
                if gt is not None:
                    self.sim.register_ground_truth(inc.id, float(gt))
            if inc not in touched:
                touched.append(inc)
            outcomes.append({"kind": kind, "incident": inc})

        # 3. Terrain, then risk, per touched incident (concurrent, cache-aware)
        if touched:
            t0 = time.perf_counter()
            await self._stage("terrain")
            terrain_results = await asyncio.gather(*(agents.run_terrain(i) for i in touched))
            stage_times["terrain_ms"] = int((time.perf_counter() - t0) * 1000)
            t0 = time.perf_counter()
            await self._stage("risk")
            risk_results = await asyncio.gather(
                *(agents.run_risk(inc, t_res[0]) for inc, t_res in zip(touched, terrain_results))
            )
            stage_times["risk_ms"] = int((time.perf_counter() - t0) * 1000)
            for inc, (risk, _) in zip(touched, risk_results):
                inc.risk = risk
                inc.updated_at = risk.scored_at

        # 4. Logistics + command on the full ranked picture
        await self._stage("logistics")
        t0 = time.perf_counter()
        n_assigned, lat_log = await self._assign()
        stage_times["logistics_ms"] = int((time.perf_counter() - t0) * 1000)

        await self._stage("command")
        t0 = time.perf_counter()
        n_recs, lat_cmd = await self._command(force=True)
        stage_times["command_ms"] = int((time.perf_counter() - t0) * 1000)
        self._log(f"🚁 Logistics assigned {n_assigned} unit(s) [{lat_log}ms] · Command issued {n_recs} recommendation(s) [{lat_cmd}ms]")

        self.cycle_latency_ms = int((time.perf_counter() - started) * 1000)
        self.last_pipeline = stage_times
        self._log(f"⚡ Pipeline cycle complete in {self.cycle_latency_ms}ms")
        await self._stage("idle")
        return outcomes

    async def inject_report(self, report: IncomingReport) -> tuple[ReportOutcome, WorldSnapshot]:
        """Judge stress test: arbitrary free-text report mid-demo, no restart."""
        async with self._lock:
            self._injection_count += 1
            text = report.text
            signal: dict[str, Any] = {
                "source": report.source, "raw_text": text, "confidence": report.confidence,
                "_injected": True,
            }
            if report.lat is not None and report.lon is not None:
                signal.update(lat=report.lat, lon=report.lon, location_known=True)
            elif (place := sim.locate_text(text)) is not None:
                signal.update(lat=place[1], lon=place[2], zone=place[0], location_known=True)
            else:
                signal.update(lat=sim.CITY_CENTER[0], lon=sim.CITY_CENTER[1], location_known=False)
            self._log(f"🔥 INJECTED REPORT #{self._injection_count}: “{text[:70]}{'…' if len(text) > 70 else ''}”")
            outcomes = await self._ingest([signal], origin="inject")
            if not outcomes:
                self._log("🚫 No emergency recognised in that report — nothing logged")
                outcome = ReportOutcome(
                    kind="rejected",
                    message="No emergency recognised. Say what is happening and where "
                            "(e.g. “smoke from the University chemistry lab, two people coughing”).",
                )
            else:
                last = outcomes[-1]
                inc: Incident = last["incident"]
                outcome = ReportOutcome(
                    kind=last["kind"], incident_id=inc.id, title=inc.title,
                    tier=inc.risk.tier if inc.risk else None,
                    urgency=inc.risk.urgency if inc.risk else None,
                )
            await asyncio.to_thread(
                self.store.add_report, self.drill_id, text, report.source, outcome.kind,
                outcome.title, outcome.tier, outcome.urgency)
            await self._persist()
            await self._push()
            return outcome, self.snapshot()

    # -- simulation heartbeat ------------------------------------------------

    async def run_forever(self, interval_s: float = TICK_SECONDS) -> None:
        """Main loop: sim ticks + refresh cycles, broadcasting every interval."""
        while True:
            await asyncio.sleep(interval_s)
            try:
                async with self._lock:
                    await self._tick_once()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # keep the loop alive no matter what
                logger.exception("cycle error")
                self._log(f"❗ cycle error (recovered): {exc}")
                self.stage = "idle"
                await self._push()

    async def _tick_once(self) -> None:
        signals, log = self.sim.tick()
        for line in log:
            self._log(line)
        self.tick += 1
        self._advance_resources()
        self._drift_unresolved()
        if signals:
            await self._ingest(signals, origin="sim")
        else:
            await self._refresh()
        await self._persist()
        await self._push()

    async def _refresh(self) -> None:
        """Idle-tick refresh. Free while nothing changed: risk/terrain come from the
        cache, logistics is skipped when no incident needs a unit."""
        active = [inc for _, inc in self._ranked()]
        if not active:
            return
        terrain_results = await asyncio.gather(*(agents.run_terrain(i) for i in active))
        risk_results = await asyncio.gather(
            *(agents.run_risk(inc, t[0]) for inc, t in zip(active, terrain_results))
        )
        for inc, (risk, _) in zip(active, risk_results):
            inc.risk = risk
        await self._assign()
        await self._command(force=False)

    # -- merging / creation ---------------------------------------------------

    @staticmethod
    def _signal_for(p: dict[str, Any], signals: list[dict[str, Any]]) -> Optional[dict[str, Any]]:
        """The input signal a parsed incident came from (nearest by coordinates)."""
        if not signals:
            return None
        best = min(
            signals,
            key=lambda s: abs(float(s.get("lat", 0)) - float(p.get("lat") or 0))
            + abs(float(s.get("lon", 0)) - float(p.get("lon") or 0)),
        )
        near = abs(float(best.get("lat", 0)) - float(p.get("lat") or 0)) < 0.02 \
            and abs(float(best.get("lon", 0)) - float(p.get("lon") or 0)) < 0.02
        return best if near or len(signals) == 1 else None

    def _resolve_target(self, p: dict[str, Any], located: bool) -> Optional[Incident]:
        linked = p.get("linked_incident_id")
        if linked:
            inc = self.incidents.get(linked)
            if inc and inc.status in ACTIVE_STATUSES:
                return inc
        # The geospatial safety net needs a real location: an unlocated report is
        # pinned to the city centre, which says nothing about where it happened.
        return self._fuzzy_match(p) if located else None

    def _create_incident(self, p: dict[str, Any], located: bool = True) -> Incident:
        lat = float(p.get("lat") or sim.CITY_CENTER[0])
        lon = float(p.get("lon") or sim.CITY_CENTER[1])
        zone = str(p.get("zone") or "")
        if zone not in sim.SECTORS:
            zone = self.sim.nearest_zone(lat, lon)
        inc = Incident(
            type=IncidentType(p.get("type", "medical")),
            title=str(p.get("title", "Untitled incident"))[:120],
            description=str(p.get("description", ""))[:500],
            lat=lat, lon=lon,
            zone=zone if located else "Unlocated",
            affected_population=int(p.get("affected_population") or 0),
            injuries=int(p.get("injuries") or 0),
            confidence=float(p.get("confidence") or 0.8),
            terrain=self.sim.terrain_for(lat, lon),
            weather=self.sim.weather_for(lat, lon),
            location_known=located,
        )
        self.incidents[inc.id] = inc
        self._log(f"🆕 New incident: [{inc.zone}] {inc.title}")
        return inc

    def _merge_into(self, inc: Incident, p: dict[str, Any]) -> Incident:
        # Counts only ratchet up when the report actually *states* numbers; a type
        # default ("collapses have ~15 people") must not overwrite what we know.
        if p.get("counts_reported"):
            inc.affected_population = max(inc.affected_population, int(p.get("affected_population") or 0))
            inc.injuries = max(inc.injuries, int(p.get("injuries") or 0))
        inc.confidence = max(inc.confidence, float(p.get("confidence") or 0))
        text = str(p.get("description") or "")
        if text and text not in inc.description:
            inc.description = (inc.description + " | " + text)[:500]
        inc.merged_reports += 1
        if inc.status == IncidentStatus.NEW:
            inc.status = IncidentStatus.TRIAGED
        self._log(f"🔗 Report merged into: {inc.title}")
        return inc

    def _fuzzy_match(self, p: dict[str, Any]) -> Optional[Incident]:
        """Same type + within ~1.5 km ⇒ same incident (safety net when the LLM
        didn't link explicitly)."""
        lat, lon = float(p.get("lat") or 0), float(p.get("lon") or 0)
        for inc in self.incidents.values():
            if inc.status not in ACTIVE_STATUSES:
                continue
            if inc.type.value == p.get("type") and agents._haversine_km(lat, lon, inc.lat, inc.lon) < 1.5:
                return inc
        return None

    # -- ranking, assignment, command ------------------------------------------

    def _ranked(self) -> list[tuple[int, Incident]]:
        live = [inc for inc in self.incidents.values() if inc.risk and inc.status in ACTIVE_STATUSES]
        live.sort(key=lambda inc: inc.risk.urgency, reverse=True)  # type: ignore[union-attr]
        return [(rank + 1, inc) for rank, inc in enumerate(live)]

    def _assigned_counts(self) -> dict[str, int]:
        counts: dict[str, int] = {}
        for r in self.resources:
            if r.assigned_incident:
                counts[r.assigned_incident] = counts.get(r.assigned_incident, 0) + 1
        return counts

    @property
    def _deployments(self) -> list[Deployment]:
        rank_by_id = {inc.id: rank for rank, inc in self._ranked()}
        deps: list[Deployment] = []
        for r in self.resources:
            inc = self.incidents.get(r.assigned_incident or "")
            if inc and inc.id in rank_by_id:
                deps.append(Deployment(
                    id=f"dep_{r.id}_{inc.id}",
                    incident_id=inc.id, incident_title=inc.title,
                    resource_id=r.id, resource_name=r.name, resource_type=r.type,
                    eta_minutes=agents.eta_minutes(r, inc), role=r.role or "assigned",
                    priority=rank_by_id[inc.id],
                ))
        return deps

    async def _assign(self) -> tuple[int, int]:
        ranked = self._ranked()
        available = [r for r in self.resources if r.status == "available"]
        assignments, latency = await agents.run_logistics(ranked, available, self._assigned_counts())
        return self._apply_assignments(assignments, ranked), latency

    def _apply_assignments(self, assignments: list[dict[str, Any]], ranked: list[tuple[int, Incident]]) -> int:
        """Final gate: whatever proposed the pair, the rules are enforced here."""
        rank_by_id = {inc.id: rank for rank, inc in ranked}
        inc_by_id = {inc.id: inc for _, inc in ranked}
        res_by_id = {r.id: r for r in self.resources}
        counts = self._assigned_counts()
        applied = 0
        for a in assignments:
            inc = inc_by_id.get(str(a.get("incident_id")))
            res = res_by_id.get(str(a.get("resource_id")))
            if not inc or not res or res.status != "available" or not agents.is_capable(res, inc):
                continue
            if counts.get(inc.id, 0) >= agents.CREW_CAP[agents.tier_of(inc)]:
                continue
            res.status = "en_route"
            res.assigned_incident = inc.id
            res.current_lat = res.current_lat if res.current_lat is not None else res.base_lat
            res.current_lon = res.current_lon if res.current_lon is not None else res.base_lon
            res.role = str(a.get("role") or agents.role_for(res, inc))
            counts[inc.id] = counts.get(inc.id, 0) + 1
            if inc.status in (IncidentStatus.NEW, IncidentStatus.TRIAGED):
                inc.status = IncidentStatus.UNITS_EN_ROUTE
            applied += 1
            self._log(
                f"🚨 Deploy {res.name} → [#{rank_by_id.get(inc.id, '?')}] {inc.title[:50]} "
                f"(ETA {agents.eta_minutes(res, inc):.0f} min): {str(a.get('rationale') or '')[:60]}"
            )
        return applied

    def _command_signature(self, ranked: list[tuple[int, Incident]]) -> tuple:
        top = tuple((inc.id, agents.tier_of(inc), inc.status.value) for _, inc in ranked[:agents.TOP_N])
        deps = tuple(sorted((d.resource_id, d.incident_id) for d in self._deployments))
        alerts = tuple(sorted((w.zone, w.alert) for w in self.sim.weather.values() if w.alert))
        return (top, deps, alerts)

    async def _command(self, force: bool) -> tuple[int, int]:
        ranked = self._ranked()
        sig = self._command_signature(ranked)
        latency = 0
        if force or sig != self._command_sig:
            self._command_raw, latency = await agents.run_command(
                ranked, self._deployments, list(self.sim.weather.values())
            )
            self._command_sig = sig
        self._apply_command(latency)
        return len(self.recommendations), latency

    def _apply_command(self, latency: int) -> None:
        """Rebuild the cards from stored orders + *live* urgency/deployments."""
        rank_by_id = {inc.id: (rank, inc) for rank, inc in self._ranked()}
        deps = self._deployments
        parsed: list[RecommendedAction] = []
        for r in self._command_raw:
            entry = rank_by_id.get(str(r.get("incident_id")))
            if not entry:
                continue
            rank, inc = entry
            parsed.append(RecommendedAction(
                incident_id=inc.id, incident_title=inc.title, priority=rank,
                urgency=inc.risk.urgency if inc.risk else 0,
                headline=str(r.get("headline", ""))[:200],
                details=[str(x) for x in r.get("actions", [])][:5],
                warnings=[str(x) for x in r.get("warnings", [])][:4],
                deployments=[d for d in deps if d.incident_id == inc.id],
                latency_ms=latency,
            ))
        parsed.sort(key=lambda a: a.priority)
        self.recommendations = parsed

    # -- world evolution --------------------------------------------------------

    def _advance_resources(self) -> None:
        """Move units, and run the incident lifecycle: en route → on scene → work →
        contained → units return to base and become available again."""
        for r in self.resources:
            inc = self.incidents.get(r.assigned_incident or "")
            if r.status == "en_route":
                if inc is None or inc.status not in ACTIVE_STATUSES:
                    r.status, r.assigned_incident, r.role = "returning", None, ""
                    continue
                if self._step_toward(r, inc.lat, inc.lon):
                    r.status = "on_scene"
                    inc.status = IncidentStatus.ON_SCENE
                    self._log(f"✅ {r.name} on scene at {inc.title[:50]}")
            elif r.status == "returning":
                if self._step_toward(r, r.base_lat, r.base_lon):
                    r.status, r.current_lat, r.current_lon = "available", None, None
                    self._log(f"🏁 {r.name} back at base, available")

        for inc in list(self.incidents.values()):
            if inc.status != IncidentStatus.ON_SCENE:
                continue
            ticks = self._on_scene_ticks.get(inc.id, 0) + 1
            self._on_scene_ticks[inc.id] = ticks
            if ticks >= WORK_TICKS[agents.tier_of(inc)]:
                self._contain(inc)

    def _step_toward(self, r: Resource, lat: float, lon: float) -> bool:
        """Advance one tick toward a point; True on arrival."""
        cur_lat = r.current_lat if r.current_lat is not None else r.base_lat
        cur_lon = r.current_lon if r.current_lon is not None else r.base_lon
        step = r.speed_kph / 3600.0 * TICK_SECONDS
        dist = agents._haversine_km(cur_lat, cur_lon, lat, lon)
        if dist <= max(step, 0.15):
            r.current_lat, r.current_lon = lat, lon
            return True
        frac = step / max(dist, 1e-6)
        r.current_lat = cur_lat + (lat - cur_lat) * frac
        r.current_lon = cur_lon + (lon - cur_lon) * frac
        return False

    def _contain(self, inc: Incident) -> None:
        inc.status = IncidentStatus.CONTAINED
        self._resolved += 1
        released = 0
        for r in self.resources:
            if r.assigned_incident == inc.id:
                r.status, r.assigned_incident, r.role = "returning", None, ""
                released += 1
        self._log(f"🛡 Contained: {inc.title[:60]} — {released} unit(s) released")

    def _drift_unresolved(self) -> None:
        """Unaddressed incidents get worse — this is what forces the ranking to
        legitimately change over time."""
        assigned = {r.assigned_incident for r in self.resources}
        for inc in self.incidents.values():
            if inc.id in assigned or inc.status not in (IncidentStatus.NEW, IncidentStatus.TRIAGED):
                continue
            if inc.injuries <= 0:
                continue        # nobody is hurt: waiting doesn't multiply the people at risk
            baseline = self._pop_baseline.setdefault(inc.id, max(inc.affected_population, 1))
            inc.affected_population = min(int(inc.affected_population * 1.08) + 2, baseline * 3)

    # -- snapshot & metrics ------------------------------------------------------

    def snapshot(self) -> WorldSnapshot:
        ranked = self._ranked()
        for _rank, inc in ranked:
            if inc.risk:
                inc.risk.tier = agents.tier_for(inc.risk.urgency)  # type: ignore[assignment]
        return WorldSnapshot(
            status=self.status,  # type: ignore[arg-type]
            tick=self.tick,
            sim_time=utcnow().isoformat(),
            incidents=[inc for _, inc in ranked],
            resources=self.resources,
            weather=list(self.sim.weather.values()),
            actions=self.recommendations,
            metrics=self.metrics(ranked),
            event_log=self.event_log[-40:],
            pipeline=Pipeline(stage=self.stage, origin=self.origin),  # type: ignore[arg-type]
        )

    def metrics(self, ranked: list[tuple[int, Incident]]) -> dict[str, Any]:
        # Ground truth only exists for dataset-seeded incidents, so injected
        # reports can never move the accuracy number.
        pairs = [
            (inc.risk.urgency, self.sim.ground_truth[inc.id])
            for inc in self.incidents.values()
            if inc.risk and inc.id in self.sim.ground_truth
        ]
        spearman = _spearman([p[0] for p in pairs], [p[1] for p in pairs]) if len(pairs) >= 3 else None

        p12 = [inc for _, inc in ranked if inc.risk and inc.risk.tier in ("P1", "P2")]
        assigned = {r.assigned_incident for r in self.resources if r.assigned_incident}
        covered = [inc for inc in p12 if inc.id in assigned]
        deps = self._deployments
        by_res = {r.id: r for r in self.resources}
        matched = sum(
            1 for d in deps
            if (inc := self.incidents.get(d.incident_id)) and (res := by_res.get(d.resource_id))
            and agents.is_capable(res, inc)
        )
        p1_etas = [d.eta_minutes for d in deps if d.priority == 1]
        sources: dict[str, int] = {}
        for _, inc in ranked:
            if inc.risk:
                sources[inc.risk.source] = sources.get(inc.risk.source, 0) + 1
        stats = llm_stats()

        return {
            "mode": stats["mode"],
            "model": stats["model"],
            "scenario_dataset": self.dataset_source,
            "ranking_accuracy": {
                "spearman": spearman,
                "evaluated_incidents": len(pairs),
                "note": "Spearman rank correlation vs hidden xBD ground truth (seeded incidents only)",
            },
            "latency": {
                "last_cycle_ms": self.cycle_latency_ms,
                "pipeline": self.last_pipeline,
                "llm": stats,
            },
            "scoring_sources": sources,
            "drill_id": self.drill_id,
            "database": self.store.status(),
            "recommendation_quality": {
                "p1p2_count": len(p12),
                "p1p2_covered": len(covered),
                "coverage": round(len(covered) / len(p12), 2) if p12 else 1.0,
                "capability_match": round(matched / len(deps), 2) if deps else 1.0,
                "p1_best_eta_min": min(p1_etas) if p1_etas else None,
                "injections_processed": self._injection_count,
                "resolved_incidents": self._resolved,
            },
        }

    async def _push(self) -> None:
        if self._broadcast:
            try:
                await self._broadcast(self.snapshot())
            except Exception as exc:
                logger.warning("broadcast error: %s", exc)


def _spearman(xs: list[float], ys: list[float]) -> Optional[float]:
    """Spearman rank correlation with average ranks for ties."""
    if len(xs) != len(ys) or len(xs) < 2:
        return None

    def _ranks(vals: list[float]) -> list[float]:
        order = sorted(range(len(vals)), key=lambda i: vals[i])
        ranks = [0.0] * len(vals)
        i = 0
        while i < len(order):
            j = i
            while j + 1 < len(order) and vals[order[j + 1]] == vals[order[i]]:
                j += 1
            avg = (i + j) / 2 + 1
            for k in range(i, j + 1):
                ranks[order[k]] = avg
            i = j + 1
        return ranks

    rx, ry = _ranks(xs), _ranks(ys)
    n = len(xs)
    mx, my = sum(rx) / n, sum(ry) / n
    num = sum((a - mx) * (b - my) for a, b in zip(rx, ry))
    dx = sum((a - mx) ** 2 for a in rx) ** 0.5
    dy = sum((b - my) ** 2 for b in ry) ** 0.5
    if dx == 0 or dy == 0:
        return None
    return round(num / (dx * dy), 3)
