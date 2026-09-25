"""MissionSync orchestrator — the live-update pipeline.

Owns the world state and runs the agent pipeline on every cycle:
    signals ─► surveillance ─► terrain ─► risk ─► logistics ─► command
New signals (including judge injections) merge into state *in place* —
no restart, no manual re-run. Ranking and recommendations refresh every
cycle whether or not anything changed.
"""
from __future__ import annotations

import asyncio
import time
from typing import Any, Awaitable, Callable, Optional

from . import agents, simulator as sim
from .llm import LLM_AVAILABILITY, llm_stats
from .models import (
    Deployment,
    IncidentType,
    IncomingReport,
    Incident,
    IncidentStatus,
    RecommendedAction,
    utcnow,
    WorldSnapshot,
)

Simulator = sim.Simulator


class Orchestrator:
    def __init__(self) -> None:
        self.sim = Simulator()
        self.incidents: dict[str, Incident] = {}
        self.resources: list[Any] = sim.build_resources()
        self.event_log: list[str] = []
        self.tick = 0
        self.cycle_latency_ms = 0
        self.last_pipeline: dict[str, int] = {}
        self._broadcast: Optional[Callable[[WorldSnapshot], Awaitable[None]]] = None
        self._injection_count = 0
        self.recommendations: list[RecommendedAction] = []

    # -- lifecycle ---------------------------------------------------------

    def on_broadcast(self, cb: Callable[[WorldSnapshot], Awaitable[None]]) -> None:
        self._broadcast = cb

    async def bootstrap(self) -> None:
        """Seed the scenario so the dashboard has something on first paint."""
        for signal in self.sim.seed_events():
            await self.ingest_signals([signal], label="scenario-seed")
        self.event_log.insert(0, "🟢 Scenario loaded: 5 initial incidents, 12 resources")
        await self._push()

    # -- signal ingestion (the no-restart live path) ------------------------

    async def ingest_signals(self, signals: list[dict[str, Any]], label: str = "signal") -> None:
        """Full pipeline over a batch of raw signals. Safe to call any time."""
        started = time.perf_counter()
        stage_times: dict[str, int] = {}

        # 1. Surveillance: parse signals into incidents
        t0 = time.perf_counter()
        parsed_incidents, lat = await agents.run_surveillance(
            signals, list(self.incidents.values()), latlon_hint=None
        )
        stage_times["surveillance_ms"] = int((time.perf_counter() - t0) * 1000)
        self.event_log.append(f"🛰 Surveillance parsed {len(parsed_incidents)} incident(s) from {len(signals)} signal(s) [{lat}ms]")

        # 2. Merge or create
        touched: list[Incident] = []
        for p in parsed_incidents:
            linked = p.get("linked_incident_id")
            if linked and linked in self.incidents:
                inc = self._merge_into(linked, p)
            else:
                match = self._fuzzy_match(p)
                inc = self._merge_into(match.id, p) if match else self._create_incident(p)
            touched.append(inc)

        # 3. Terrain + risk per touched incident (concurrently)
        t0 = time.perf_counter()
        terrain_results = await asyncio.gather(*(agents.run_terrain(i) for i in touched))
        risk_results = await asyncio.gather(
            *(
                agents.run_risk(inc, t_res[0])
                for inc, t_res in zip(touched, terrain_results)
            )
        )
        stage_times["terrain_ms"] = stage_times["risk_ms"] = int((time.perf_counter() - t0) * 1000)

        for (t_res, _), (risk, _), inc in zip(terrain_results, risk_results, touched):
            inc.risk = risk
            inc.updated_at = inc.risk.scored_at
            gt = None
            for s in signals:
                if abs(s.get("lat", 0) - inc.lat) < 0.02 and abs(s.get("lon", 0) - inc.lon) < 0.02:
                    if s.get("_ground_truth_urgency"):
                        gt = float(s["_ground_truth_urgency"])
            if gt is not None and inc.id not in self.sim.ground_truth:
                self.sim.register_ground_truth(inc.id, gt)
        stage_times["risk_stage_total_ms"] = int((time.perf_counter() - t0) * 1000)

        # 4. Logistics + command on the full ranked picture
        ranked = self._ranked()
        available = [r for r in self.resources if r.status == "available"]
        t0 = time.perf_counter()
        assignments, lat = await agents.run_logistics(ranked, available)
        stage_times["logistics_ms"] = int((time.perf_counter() - t0) * 1000)

        t0 = time.perf_counter()
        command_out, lat_cmd = await agents.run_command(ranked, self._deployments, list(sim.WEATHER.values()))
        stage_times["command_ms"] = int((time.perf_counter() - t0) * 1000)

        self._apply_assignments(assignments, ranked)
        self._apply_command(command_out, ranked, stage_times.get("command_ms", 0))
        self.event_log.append(f"🚁 Logistics assigned {len(assignments)} unit(s) [{lat}ms] · Command issued {len(command_out)} recommendation(s) [{lat_cmd}ms]")

        self.cycle_latency_ms = int((time.perf_counter() - started) * 1000)
        self.last_pipeline = stage_times
        self.event_log.append(f"⚡ Pipeline cycle complete in {self.cycle_latency_ms}ms")

    async def inject_report(self, report: IncomingReport) -> WorldSnapshot:
        """Judge stress test: arbitrary free-text report mid-demo, no restart."""
        self._injection_count += 1
        signal: dict[str, Any] = {
            "source": report.source,
            "lat": report.lat if report.lat is not None else 34.055,
            "lon": report.lon if report.lon is not None else -118.24,
            "raw_text": report.text,
            "confidence": report.confidence,
            "_injected": True,
        }
        self.event_log.append(f"🔥 INJECTED REPORT #{self._injection_count}: “{report.text[:70]}…”")
        await self.ingest_signals([signal], label="judge-injection")
        await self._push()
        return self.snapshot()

    # -- simulation heartbeat ------------------------------------------------

    async def run_forever(self, interval_s: float = 6.0) -> None:
        """Main loop: sim ticks + refresh cycles, broadcasting every interval."""
        while True:
            await asyncio.sleep(interval_s)
            try:
                signals, log = self.sim.tick()
                self.event_log.extend(log)
                self.tick += 1
                self._advance_resources()
                self._drift_unresolved()
                if signals:
                    await self.ingest_signals(signals, label="sim-tick")
                else:
                    # Light refresh so ranking stays honest as resources move
                    await self._refresh_rankings()
                await self._push()
            except Exception as exc:  # keep the loop alive no matter what
                self.event_log.append(f"❗ cycle error (recovered): {exc}")

    async def _refresh_rankings(self) -> None:
        ranked = self._ranked()
        if not ranked:
            return
        active = [inc for _, inc in ranked[:5] if inc.status not in ("closed",)]
        if not active:
            return
        terrain_results = await asyncio.gather(*(agents.run_terrain(i) for i in active))
        risk_results = await asyncio.gather(
            *(agents.run_risk(inc, t[0]) for inc, t in zip(active, terrain_results))
        )
        for inc, (risk, _) in zip(active, risk_results):
            inc.risk = risk
        ranked = self._ranked()
        available = [r for r in self.resources if r.status == "available"]
        assignments, _ = await agents.run_logistics(ranked, available)
        self._apply_assignments(assignments, ranked)
        command_out, _ = await agents.run_command(ranked, self._deployments, list(sim.WEATHER.values()))
        self._apply_command(command_out, ranked, 0)

    # -- merging / creation ---------------------------------------------------

    def _create_incident(self, p: dict[str, Any]) -> Incident:
        lat = float(p.get("lat") or 34.055)
        lon = float(p.get("lon") or -118.24)
        inc = Incident(
            type=IncidentType(p.get("type", "medical")),
            title=str(p.get("title", "Untitled incident"))[:120],
            description=str(p.get("description", ""))[:500],
            lat=lat, lon=lon,
            zone=str(p.get("zone") or self.sim.nearest_zone(lat, lon)),
            affected_population=int(p.get("affected_population") or 0),
            injuries=int(p.get("injuries") or 0),
            confidence=float(p.get("confidence") or 0.8),
            terrain=self.sim.terrain_for(lat, lon),
            weather=self.sim.weather_for(lat, lon),
        )
        self.incidents[inc.id] = inc
        self.event_log.append(f"🆕 New incident: [{inc.zone}] {inc.title}")
        return inc

    def _merge_into(self, incident_id: str, p: dict[str, Any]) -> Incident:
        inc = self.incidents[incident_id]
        inc.affected_population = max(inc.affected_population, int(p.get("affected_population") or 0))
        inc.injuries = max(inc.injuries, int(p.get("injuries") or 0))
        inc.confidence = max(inc.confidence, float(p.get("confidence") or 0))
        if p.get("description"):
            inc.description = (inc.description + " | " + str(p["description"]))[:500]
        inc.status = IncidentStatus.TRIAGED if inc.status == IncidentStatus.NEW else inc.status
        inc.updated_at = inc.risk.scored_at if inc.risk else inc.updated_at
        self.event_log.append(f"🔗 Signal merged into: {inc.title}")
        return inc

    def _fuzzy_match(self, p: dict[str, Any]) -> Optional[Incident]:
        """Same type + within ~1.5km ⇒ same incident (fallback when LLM
        didn't link explicitly)."""
        lat, lon = float(p.get("lat") or 0), float(p.get("lon") or 0)
        for inc in self.incidents.values():
            if inc.status == IncidentStatus.CLOSED:
                continue
            same_type = inc.type.value == p.get("type")
            near = agents._haversine_km(lat, lon, inc.lat, inc.lon) < 1.5
            if same_type and near:
                return inc
        return None

    # -- ranking, assignment, command ------------------------------------------

    def _ranked(self) -> list[tuple[int, Incident]]:
        with_risk = [(i, inc) for i, inc in self.incidents.items() if inc.risk and inc.status != IncidentStatus.CLOSED]
        with_risk.sort(key=lambda pair: pair[1].risk.urgency, reverse=True)  # type: ignore[union-attr]
        return [(rank + 1, inc) for rank, (i, inc) in enumerate(with_risk)]

    @property
    def _deployments(self) -> list[Deployment]:
        deps: list[Deployment] = []
        for r in self.resources:
            if r.assigned_incident and r.assigned_incident in self.incidents:
                inc = self.incidents[r.assigned_incident]
                rank = next((rank for rank, i in self._ranked() if i.id == inc.id), 99)
                deps.append(Deployment(
                    incident_id=inc.id, incident_title=inc.title,
                    resource_id=r.id, resource_name=r.name, resource_type=r.type,
                    eta_minutes=self._eta(r, inc), role=getattr(r, "role", "assigned"),
                    priority=rank,
                ))
        return deps

    def _eta(self, r: Any, inc: Incident) -> float:
        return agents.eta_minutes(r, inc)

    def _apply_assignments(self, assignments: list[dict[str, Any]], ranked: list[tuple[int, Incident]]) -> None:
        rank_by_id = {inc.id: rank for rank, inc in ranked}
        inc_by_id = {inc.id: inc for _, inc in ranked}
        # Total units already committed per incident (across all cycles) —
        # prevents the top incident from absorbing the entire fleet.
        assigned_counts: dict[str, int] = {}
        for r in self.resources:
            if r.assigned_incident:
                assigned_counts[r.assigned_incident] = assigned_counts.get(r.assigned_incident, 0) + 1
        for a in assignments:
            inc = inc_by_id.get(str(a.get("incident_id")))
            res = next((r for r in self.resources if r.id == a.get("resource_id")), None)
            if not inc or not res:
                continue
            cap = 4 if (inc.risk and inc.risk.tier in ("P1", "P2")) else 2
            if assigned_counts.get(inc.id, 0) >= cap:
                continue
            res.status = "en_route"
            res.assigned_incident = inc.id
            res.current_lat = res.current_lat or res.base_lat
            res.current_lon = res.current_lon or res.base_lon
            res.role = str(a.get("role", "assigned"))
            assigned_counts[inc.id] = assigned_counts.get(inc.id, 0) + 1
            if inc.status == IncidentStatus.NEW:
                inc.status = IncidentStatus.UNITS_EN_ROUTE
            self.event_log.append(
                f"🚨 Deploy {res.name} → [{rank_by_id.get(inc.id, '?')}] {inc.title} "
                f"(ETA {self._eta(res, inc):.0f} min): {a.get('rationale', '')[:60]}"
            )

    def _apply_command(self, recs: list[dict[str, Any]], ranked: list[tuple[int, Incident]], latency: int) -> None:
        rank_by_id = {inc.id: (rank, inc) for rank, inc in ranked}
        parsed: list[RecommendedAction] = []
        for r in recs:
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
                deployments=[d for d in self._deployments if d.incident_id == inc.id],
                latency_ms=latency,
            ))
        parsed.sort(key=lambda a: a.priority)
        self.recommendations = parsed

    # -- world evolution --------------------------------------------------------

    def _advance_resources(self) -> None:
        """Move en_route resources toward their incidents; arrive when close."""
        for r in self.resources:
            if r.status == "en_route" and r.assigned_incident in self.incidents:
                inc = self.incidents[r.assigned_incident]
                tlat, tlon = r.current_lat or r.base_lat, r.current_lon or r.base_lon
                step = r.speed_kph / 3600.0 * 6.0  # ~6 s per tick in sim-km
                dist = agents._haversine_km(tlat, tlon, inc.lat, inc.lon)
                if dist <= max(step, 0.15):
                    r.current_lat, r.current_lon = inc.lat, inc.lon
                    r.status = "on_scene"
                    inc.status = IncidentStatus.ON_SCENE
                    self.event_log.append(f"✅ {r.name} on scene at {inc.title}")
                else:
                    frac = step / max(dist, 1e-6)
                    r.current_lat = tlat + (inc.lat - tlat) * frac
                    r.current_lon = tlon + (inc.lon - tlon) * frac

    def _drift_unresolved(self) -> None:
        """Unaddressed P1/P2 incidents get worse — this is what forces the
        ranking to legitimately change over time."""
        assigned = {r.assigned_incident for r in self.resources}
        for inc in self.incidents.values():
            if inc.id not in assigned and inc.status in (IncidentStatus.NEW, IncidentStatus.TRIAGED):
                inc.affected_population = int(inc.affected_population * 1.08) + 2

    # -- snapshot & metrics ------------------------------------------------------

    def snapshot(self) -> WorldSnapshot:
        ranked = self._ranked()
        for rank, inc in ranked:
            if inc.risk:
                inc.risk.tier = agents.tier_for(inc.risk.urgency)
        return WorldSnapshot(
            tick=self.tick,
            sim_time=utcnow().isoformat(),
            incidents=[inc for _, inc in ranked],
            resources=self.resources,
            weather=list(sim.WEATHER.values()),
            actions=self.recommendations,
            metrics=self.metrics(ranked),
            event_log=self.event_log[-25:],
        )

    def metrics(self, ranked: list[tuple[int, Incident]]) -> dict[str, Any]:
        pairs = [
            (inc.risk.urgency, self.sim.ground_truth[inc.id])
            for _, inc in ranked
            if inc.risk and inc.id in self.sim.ground_truth
        ]
        spearman = _spearman([p[0] for p in pairs], [p[1] for p in pairs]) if len(pairs) >= 3 else None

        p12 = [inc for _, inc in ranked if inc.risk and inc.risk.tier in ("P1", "P2")]
        covered = [inc for inc in p12 if any(r.assigned_incident == inc.id for r in self.resources)]
        deps = self._deployments
        matched = 0
        for d in deps:
            inc = self.incidents.get(d.incident_id)
            res = next((r for r in self.resources if r.id == d.resource_id), None)
            if inc and res and res.type in agents._required_for(inc.type):
                matched += 1
        p1_etas = [d.eta_minutes for d in deps if d.priority == 1]

        return {
            "mode": "llm" if LLM_AVAILABILITY else "fallback",
            "ranking_accuracy": {
                "spearman": spearman,
                "evaluated_incidents": len(pairs),
                "note": "Spearman rank correlation vs simulator ground truth",
            },
            "latency": {
                "last_cycle_ms": self.cycle_latency_ms,
                "pipeline": self.last_pipeline,
                "llm": llm_stats(),
            },
            "recommendation_quality": {
                "p1p2_count": len(p12),
                "p1p2_covered": len(covered),
                "coverage": round(len(covered) / len(p12), 2) if p12 else 1.0,
                "capability_match": round(matched / len(deps), 2) if deps else 1.0,
                "p1_best_eta_min": min(p1_etas) if p1_etas else None,
                "injections_processed": self._injection_count,
            },
        }

    async def _push(self) -> None:
        if self._broadcast:
            try:
                await self._broadcast(self.snapshot())
            except Exception as exc:
                self.event_log.append(f"broadcast error: {exc}")


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
