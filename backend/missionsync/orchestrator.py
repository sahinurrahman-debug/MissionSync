"""MissionSync orchestrator — the live-update pipeline.

Owns the world state and runs the agent pipeline:
    signals ─► surveillance ─► terrain ─► risk ─► logistics ─► command

Three design rules shape this file:

1. **Provisional, then refined.** A typed report reaches the ranked board within
   milliseconds, scored by the deterministic rules and tagged "AI scoring…". The real
   LLM agents then refine it in the background — *off the lock* — and the picture
   updates stage by stage over the WebSocket. (Measured on the live LLM, the five
   sequential calls take ~30 s; the operator must not wait for them.) Only boot,
   and reports the rules cannot classify, wait for the LLM.

2. **Agents propose, a human commits.** Unit assignments are *proposals* awaiting
   approval (PRD: "recommendations a human approves, never automatic dispatch").
   Auto-dispatch is an explicit demo setting. The net-control lead can approve,
   reject, hand-dispatch, recall a unit, or mark an incident contained/closed.

3. **One lock for state.** Every mutation of world state happens under a single
   asyncio.Lock, so a report injected mid-tick can never race the heartbeat. LLM
   calls run on copies, outside the lock, and their results are re-validated when
   applied.
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
from collections import OrderedDict
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Optional

from . import agents, llm as llm_mod, simulator as sim, xbd
from .llm import llm_stats
from .models import (
    Deployment,
    EventLine,
    Incident,
    IncidentStatus,
    IncidentType,
    IncomingReport,
    Pipeline,
    Proposal,
    RecommendedAction,
    ReportOutcome,
    Resource,
    WorldSnapshot,
    utcnow,
)
from .persistence import Store

logger = logging.getLogger(__name__)
Simulator = sim.Simulator

TICK_SECONDS = 6.0
LOG_CAP = 300
UNSAVED_CAP = 2000
NONCE_CAP = 200
STATE_VERSION = 1
STATE_MAX_AGE_S = 6 * 3600            # a saved drill older than this is not resumed
# Ticks a crew works on scene before the incident is contained (6 s per tick).
WORK_TICKS = {"P1": 24, "P2": 20, "P3": 12, "P4": 8}
ACTIVE_STATUSES = (
    IncidentStatus.NEW, IncidentStatus.TRIAGED, IncidentStatus.UNITS_EN_ROUTE, IncidentStatus.ON_SCENE,
)


class DomainError(Exception):
    """A request the current state cannot honour; the API maps it to the standard envelope."""

    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def _clock() -> str:
    d = datetime.now(timezone.utc)
    return f"{d.hour:02d}:{d.minute:02d}:{d.second:02d}Z"


def _env_flag(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    return default if raw is None else raw.strip().lower() in ("1", "true", "yes", "on")


class Orchestrator:
    def __init__(self, store: Optional[Store] = None, auto_dispatch: Optional[bool] = None) -> None:
        self.store = store or Store(None)          # disabled store = pure in-memory
        self.auto_dispatch = _env_flag("AUTO_DISPATCH") if auto_dispatch is None else auto_dispatch
        self.viewers = 0                            # maintained by the WebSocket hub
        self.peak_viewers = 0
        self.drill_id: Optional[int] = None
        self._unsaved: list[EventLine] = []
        self._broadcast: Optional[Callable[[WorldSnapshot], Awaitable[None]]] = None
        self._lock = asyncio.Lock()
        self._refine_event = asyncio.Event()
        self._refine_pending: set[str] = set()
        self._refine_task: Optional[asyncio.Task] = None
        self._saved_cache_version = -1
        self._records: Optional[list[dict[str, Any]]] = None   # xBD seeds, loaded once
        self.dataset_source = "not_loaded"
        self._nonces: "OrderedDict[str, dict[str, Any]]" = OrderedDict()
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
        self.started_at = time.time()
        self.ended_at: Optional[float] = None
        self.cycle_latency_ms = 0
        self.last_pipeline: dict[str, int] = {}
        self._injection_count = 0
        self._resolved = 0
        self._on_scene_ticks: dict[str, int] = {}
        self._pop_baseline: dict[str, int] = {}
        self._command_raw: list[dict[str, Any]] = []
        self._command_sig: Optional[tuple] = None
        self._command_dirty = False
        self.recommendations: list[RecommendedAction] = []
        self.proposals: dict[str, Proposal] = {}
        self.rejected: set[tuple[str, str]] = set()
        self._refine_pending.clear()
        self._nonces.clear()
        # NOTE: the LLM caches are deliberately NOT cleared — they are keyed by report
        # content, so a reset re-uses every score already paid for.

    # -- plumbing ----------------------------------------------------------

    def on_broadcast(self, cb: Callable[[WorldSnapshot], Awaitable[None]]) -> None:
        self._broadcast = cb

    def _log(self, msg: str) -> None:
        self._seq += 1
        line = EventLine(seq=self._seq, t=_clock(), msg=msg)
        self.event_log.append(line)
        if self.store.enabled:
            self._unsaved.append(line)
            if len(self._unsaved) > UNSAVED_CAP:
                del self._unsaved[: len(self._unsaved) - UNSAVED_CAP]
        if len(self.event_log) > LOG_CAP:
            del self.event_log[: len(self.event_log) - LOG_CAP]

    def _llm_available(self) -> bool:
        return llm_mod.active_model() is not None

    async def _persist(self) -> None:
        """Flush the audit trail, the restorable world state and the LLM cache (no-ops
        without a database; never raises). Failed event writes are re-queued."""
        if not self.store.enabled:
            return
        if self._unsaved and self.drill_id is not None:
            batch, self._unsaved = self._unsaved, []
            ok = await asyncio.to_thread(
                self.store.add_events, self.drill_id, [(e.seq, e.t, e.msg) for e in batch])
            if not ok:
                self._unsaved = (batch + self._unsaved)[-UNSAVED_CAP:]
        await asyncio.to_thread(self.store.set_kv, "drill_state", self.export_state())
        if agents.cache_version != self._saved_cache_version:
            version = agents.cache_version
            if await asyncio.to_thread(self.store.set_kv, "llm_cache", agents.export_caches()):
                self._saved_cache_version = version

    async def _push(self) -> None:
        if self._broadcast:
            try:
                await self._broadcast(self.snapshot())
            except Exception as exc:
                logger.warning("broadcast error: %s", exc)

    async def _stage(self, stage: str) -> None:
        self.stage = stage
        await self._push()

    # -- lifecycle ---------------------------------------------------------

    async def run(self, interval_s: float = TICK_SECONDS) -> None:
        """Restore or bootstrap the drill, then run the heartbeat forever."""
        self._refine_task = asyncio.create_task(self._refine_loop())
        try:
            if not await self._try_restore():
                await self.bootstrap()
        except Exception as exc:  # the server must stay up even if the seed cycle fails
            logger.exception("bootstrap failed")
            self._log(f"❗ bootstrap error: {exc}")
            self.status = "live"
            await self._push()
        try:
            await self.run_forever(interval_s)
        finally:
            self._refine_task.cancel()

    async def bootstrap(self) -> None:
        """Seed the scenario so the dashboard has something on first paint."""
        async with self._lock:
            await self._bootstrap_locked()

    async def _bootstrap_locked(self) -> None:
        self.status = "booting"
        self.origin = "boot"
        self.started_at = time.time()
        await self._push()
        if self._records is None:
            # kagglehub (when enabled) does blocking network I/O — keep it off the event loop.
            self._records = await asyncio.to_thread(xbd.load_seeds)
        self.dataset_source = xbd.DATA_SOURCE
        self.sim.configure_dataset(self._records)
        source = {
            "kaggle": f"real xBD data via Kaggle ({xbd.KAGGLE_SLUG})",
            "xbd_snapshot": "bundled real xBD snapshot",
        }.get(self.dataset_source, "synthetic offline cohort")
        self.drill_id = await asyncio.to_thread(self.store.start_drill, self.dataset_source)
        signals = self.sim.seed_events()
        mode = "auto-dispatch" if self.auto_dispatch else "awaiting your approval"
        self._log(f"🟢 Scenario loaded: {len(signals)} initial incidents, {len(self.resources)} resources — "
                  f"dataset: {source}; dispatch {mode}")
        await self._ingest(signals, origin="boot", use_llm=True)   # one batch = one pass through the 5 agents
        self.status = "live"
        await self._persist()
        await self._push()

    async def reset(self) -> WorldSnapshot:
        """Start the drill over (same scenario, fresh state, LLM scores reused)."""
        async with self._lock:
            self._reset_state()
            self.origin = "reset"
            await self._bootstrap_locked()
            return self.snapshot()

    async def end_drill(self) -> WorldSnapshot:
        """Freeze the picture and keep the audit trail for after-action review."""
        async with self._lock:
            if self.status == "ended":
                raise DomainError(409, "conflict", "The drill has already ended.")
            self.status = "ended"
            self.ended_at = time.time()
            self._log(f"🏁 Drill ended by net control after {int(self.ended_at - self.started_at)} s — "
                      f"{self._resolved} incident(s) resolved, {self._injection_count} report(s) injected")
            await self._persist()
            await self._push()
            return self.snapshot()

    # -- restart recovery --------------------------------------------------------

    def export_state(self) -> dict[str, Any]:
        return {
            "version": STATE_VERSION, "saved_at": time.time(),
            "status": self.status, "tick": self.tick, "seq": self._seq, "drill_id": self.drill_id,
            "started_at": self.started_at, "ended_at": self.ended_at,
            "injection_count": self._injection_count, "resolved": self._resolved,
            "dataset_source": self.dataset_source, "auto_dispatch": self.auto_dispatch,
            "incidents": [i.model_dump(mode="json") for i in self.incidents.values()],
            "resources": [r.model_dump(mode="json") for r in self.resources],
            "event_log": [e.model_dump(mode="json") for e in self.event_log],
            "on_scene_ticks": self._on_scene_ticks, "pop_baseline": self._pop_baseline,
            "rejected": [list(p) for p in self.rejected],
            "proposals": [p.model_dump(mode="json") for p in self.proposals.values()],
            "command_raw": self._command_raw,
            "sim": self.sim.export_state(),
        }

    def import_state(self, d: dict[str, Any]) -> None:
        self._reset_state()
        self.sim.import_state(d["sim"])
        self.status = d["status"]
        self.tick, self._seq, self.drill_id = int(d["tick"]), int(d["seq"]), d.get("drill_id")
        self.started_at, self.ended_at = float(d["started_at"]), d.get("ended_at")
        self._injection_count, self._resolved = int(d["injection_count"]), int(d["resolved"])
        self.dataset_source = d.get("dataset_source", self.dataset_source)
        self.auto_dispatch = bool(d.get("auto_dispatch", self.auto_dispatch))
        self.incidents = {i["id"]: Incident.model_validate(i) for i in d["incidents"]}
        for inc in self.incidents.values():      # re-link the LIVE weather/terrain cells the sim mutates
            inc.terrain = self.sim.terrain_for(inc.lat, inc.lon)
            inc.weather = self.sim.weather_for(inc.lat, inc.lon)
            inc.provisional = False
        self.resources = [Resource.model_validate(r) for r in d["resources"]]
        self.event_log = [EventLine.model_validate(e) for e in d["event_log"]]
        self._on_scene_ticks = {k: int(v) for k, v in d["on_scene_ticks"].items()}
        self._pop_baseline = {k: int(v) for k, v in d["pop_baseline"].items()}
        self.rejected = {(a, b) for a, b in d["rejected"]}
        self.proposals = {p["id"]: Proposal.model_validate(p) for p in d["proposals"]}
        self._command_raw = d.get("command_raw", [])
        self._command_sig = None
        self._apply_command(0)

    async def _try_restore(self) -> bool:
        if not self.store.enabled:
            return False
        try:
            cache = await asyncio.to_thread(self.store.get_kv, "llm_cache")
            if cache:
                agents.import_caches(cache[0])
                self._saved_cache_version = agents.cache_version
            saved = await asyncio.to_thread(self.store.get_kv, "drill_state")
            if not saved:
                return False
            state, at = saved
            age = (datetime.now(timezone.utc) - at).total_seconds()
            # An ended drill is history (its audit trail and CSV stay in the database); a restart or a
            # free-tier wake-up must open a fresh, usable drill rather than a frozen one.
            if state.get("version") != STATE_VERSION or state.get("status") != "live" or age > STATE_MAX_AGE_S:
                return False
            async with self._lock:
                self.import_state(state)
                self.origin = "restore"
                self._log(f"♻️ Drill restored from the database (tick {self.tick}, saved {int(age)} s ago)")
            await self._push()
            return True
        except Exception:
            logger.exception("restore failed; starting a fresh drill")
            self._reset_state()
            return False

    # -- reports ----------------------------------------------------------------

    async def inject_report(self, report: IncomingReport) -> tuple[ReportOutcome, WorldSnapshot]:
        """Free-text report mid-demo. Recognised text is ranked *immediately* (rules) and refined
        by the LLM in the background; text the rules can't classify waits for the LLM."""
        async with self._lock:
            nonce = report.client_nonce
            if nonce and nonce in self._nonces:                      # idempotent retry
                return ReportOutcome.model_validate(self._nonces[nonce]), self.snapshot()
            if self.status == "ended":
                raise DomainError(409, "conflict", "The drill has ended — restart it to inject more reports.")
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

            recognised = bool(agents._surveillance_fallback([signal], (0.0, 0.0))["incidents"])
            use_llm = (not recognised) and self._llm_available()     # ambiguous text: let the LLM decide
            outcomes = await self._ingest([signal], origin="inject", use_llm=use_llm)
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
                    provisional=inc.provisional,
                )
            await asyncio.to_thread(
                self.store.add_report, self.drill_id, text, report.source, outcome.kind,
                outcome.title, outcome.tier, outcome.urgency)
            if nonce:
                self._nonces[nonce] = outcome.model_dump(mode="json")
                while len(self._nonces) > NONCE_CAP:
                    self._nonces.popitem(last=False)
            await self._persist()
            await self._push()
            return outcome, self.snapshot()

    # -- the pipeline ---------------------------------------------------------------

    async def _ingest(self, signals: list[dict[str, Any]], origin: str, use_llm: bool) -> list[dict[str, Any]]:
        """Parse → merge/create → terrain → risk → propose → command.

        ``use_llm=False`` is the fast, rule-scored path (incidents are marked provisional and
        queued for background refinement); ``True`` is the full LLM pass (boot, ambiguous text).
        """
        started = time.perf_counter()
        stage_times: dict[str, int] = {}
        self.origin = origin

        await self._stage("surveillance")
        t0 = time.perf_counter()
        parsed, lat = await agents.run_surveillance(signals, list(self.incidents.values()), allow_llm=use_llm)
        stage_times["surveillance_ms"] = int((time.perf_counter() - t0) * 1000)
        self._log(f"🛰 Surveillance parsed {len(parsed)} incident(s) from {len(signals)} signal(s) "
                  f"[{lat}ms, {'LLM' if use_llm else 'rules'}]")

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

        if touched:
            t0 = time.perf_counter()
            await self._stage("terrain")
            terrain = await asyncio.gather(*(agents.run_terrain(i, allow_llm=use_llm) for i in touched))
            stage_times["terrain_ms"] = int((time.perf_counter() - t0) * 1000)
            t0 = time.perf_counter()
            await self._stage("risk")
            risks = await asyncio.gather(*(agents.run_risk(i, t[0], allow_llm=use_llm) for i, t in zip(touched, terrain)))
            stage_times["risk_ms"] = int((time.perf_counter() - t0) * 1000)
            llm_ok = self._llm_available()
            for inc, (risk, _) in zip(touched, risks):
                inc.risk = risk
                inc.updated_at = risk.scored_at
                inc.provisional = (not use_llm) and risk.source == "rules" and llm_ok
            if not use_llm:
                self._enqueue_refine([i.id for i in touched if i.provisional] or [])

        await self._stage("logistics")
        t0 = time.perf_counter()
        ranked = self._ranked()
        assignments, lat_log = await agents.run_logistics(
            ranked, self._available(), self._assigned_counts(), frozenset(self.rejected), allow_llm=use_llm)
        self._recompute_proposals(llm_items=[a for a in assignments if a.get("source") == "llm"])
        stage_times["logistics_ms"] = int((time.perf_counter() - t0) * 1000)

        await self._stage("command")
        t0 = time.perf_counter()
        self._command_raw, lat_cmd = await agents.run_command(
            ranked, self._deployments, list(self.sim.weather.values()), allow_llm=use_llm)
        self._command_sig = self._command_signature(ranked) if use_llm else None
        if not use_llm:
            self._command_dirty = self._llm_available()
            if self._command_dirty:
                self._refine_event.set()
        self._apply_command(lat_cmd)
        stage_times["command_ms"] = int((time.perf_counter() - t0) * 1000)
        self._log(f"🚁 {len(self.proposals)} dispatch proposal(s) pending · Command issued "
                  f"{len(self.recommendations)} recommendation(s) [{lat_log + lat_cmd}ms]")

        self.cycle_latency_ms = int((time.perf_counter() - started) * 1000)
        self.last_pipeline = stage_times
        self._log(f"⚡ Pipeline cycle complete in {self.cycle_latency_ms}ms")
        await self._stage("idle")
        return outcomes

    # -- background LLM refinement (off the lock) ---------------------------------------

    def _enqueue_refine(self, ids: list[str]) -> None:
        if not self._llm_available():
            return
        self._refine_pending.update(ids)
        self._refine_event.set()

    async def _refine_loop(self) -> None:
        while True:
            await self._refine_event.wait()
            self._refine_event.clear()
            ids, self._refine_pending = list(self._refine_pending), set()
            dirty = self._command_dirty
            if not ids and not dirty:
                continue
            try:
                if self._llm_available():
                    await self._refine(ids, dirty)
                else:
                    await self._give_up_refining(ids)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.exception("refine failed")
                async with self._lock:
                    self._log(f"❗ AI refinement error (recovered): {exc}")
                await self._give_up_refining(ids)

    async def _give_up_refining(self, ids: list[str]) -> None:
        async with self._lock:
            for i in ids:
                if i in self.incidents:
                    self.incidents[i].provisional = False
            self._command_dirty = False
            self.stage = "idle"
        await self._push()

    async def _refine(self, ids: list[str], command_dirty: bool) -> None:
        started = time.perf_counter()
        self.origin = "refine"
        refined = 0
        async with self._lock:
            copies = [self.incidents[i].model_copy(deep=True) for i in ids
                      if i in self.incidents and self.incidents[i].status in ACTIVE_STATUSES]
        if copies:
            await self._stage("terrain")
            terrain = await asyncio.gather(*(agents.run_terrain(c) for c in copies))
            await self._stage("risk")
            risks = await asyncio.gather(*(agents.run_risk(c, t[0]) for c, t in zip(copies, terrain)))
            async with self._lock:
                for c, (risk, _) in zip(copies, risks):
                    inc = self.incidents.get(c.id)
                    if inc is not None and inc.status in ACTIVE_STATUSES:
                        inc.risk, inc.provisional, inc.updated_at = risk, False, risk.scored_at
                        refined += 1
                self._recompute_proposals()
            await self._push()

        # logistics and command also run on copies, off the lock
        async with self._lock:
            ranked = [(r, i.model_copy(deep=True)) for r, i in self._ranked()]
            available = [r.model_copy(deep=True) for r in self._available()]
            counts, rejected = self._assigned_counts(), frozenset(self.rejected)
        await self._stage("logistics")
        assignments, _ = await agents.run_logistics(ranked, available, counts, rejected)
        async with self._lock:
            self._recompute_proposals(llm_items=[a for a in assignments if a.get("source") == "llm"])

        async with self._lock:
            ranked = [(r, i.model_copy(deep=True)) for r, i in self._ranked()]
            deployments, weather = self._deployments, [w.model_copy() for w in self.sim.weather.values()]
            sig = self._command_signature(self._ranked())
        await self._stage("command")
        raw, lat = await agents.run_command(ranked, deployments, weather)
        async with self._lock:
            self._command_raw, self._command_sig, self._command_dirty = raw, sig, False
            self._apply_command(lat)
            self.stage = "idle"
            if refined:
                self._log(f"🤖 AI refinement complete: {refined} incident(s) re-scored by the LLM "
                          f"in {time.perf_counter() - started:.1f}s")
            await self._persist()
        await self._push()

    # -- simulation heartbeat -------------------------------------------------------------

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
        if self.status != "live":
            return                                   # booting or ended: the world is frozen
        signals, log = self.sim.tick(active_incidents=len(self._ranked()))
        for line in log:
            self._log(line)
        self.tick += 1
        self._advance_resources()
        self._drift_unresolved()
        if signals:
            await self._ingest(signals, origin="sim", use_llm=False)
        else:
            self._refresh()
        await self._persist()
        await self._push()

    def _refresh(self) -> None:
        """Idle tick. Never calls the LLM: cached LLM scores are reused while their inputs hold;
        when they materially change the old score stays until the background refinement lands."""
        active = [inc for _, inc in self._ranked()]
        llm_ok = self._llm_available()
        stale: list[str] = []
        for inc in active:
            if llm_ok and inc.risk is not None and not agents.has_cached_risk(inc):
                stale.append(inc.id)
                continue
            terrain = _run_sync(agents.run_terrain(inc, allow_llm=False))
            risk = _run_sync(agents.run_risk(inc, terrain[0], allow_llm=False))[0]
            inc.risk = risk
            inc.provisional = False
        if stale:
            self._enqueue_refine(stale)
        self._recompute_proposals()
        ranked = self._ranked()
        sig = self._command_signature(ranked)
        if sig != self._command_sig:
            self._command_raw = agents._command_fallback(ranked, self._deployments, list(self.sim.weather.values()))["recommendations"]
            self._command_sig = sig
            self._command_dirty = llm_ok
            if llm_ok:
                self._refine_event.set()
        self._apply_command(0)

    # -- merging / creation ---------------------------------------------------------------

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

    # -- ranking, proposals, dispatch ------------------------------------------------------

    def _ranked(self) -> list[tuple[int, Incident]]:
        live = [inc for inc in self.incidents.values() if inc.risk and inc.status in ACTIVE_STATUSES]
        live.sort(key=lambda inc: inc.risk.urgency, reverse=True)  # type: ignore[union-attr]
        return [(rank + 1, inc) for rank, inc in enumerate(live)]

    def _available(self) -> list[Resource]:
        return [r for r in self.resources if r.status == "available"]

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

    def _proposal_from(self, a: dict[str, Any], rank: int) -> Optional[Proposal]:
        inc = self.incidents.get(str(a.get("incident_id")))
        res = next((r for r in self.resources if r.id == a.get("resource_id")), None)
        if inc is None or res is None:
            return None
        return Proposal(
            id=f"{inc.id}:{res.id}", incident_id=inc.id, incident_title=inc.title,
            resource_id=res.id, resource_name=res.name, resource_type=res.type,
            eta_minutes=agents.eta_minutes(res, inc), role=str(a.get("role") or agents.role_for(res, inc)),
            priority=rank, rationale=str(a.get("rationale") or ""), source=a.get("source", "rules"),
        )

    def _recompute_proposals(self, llm_items: Optional[list[dict[str, Any]]] = None) -> None:
        """Rebuild the pending recommendations. Still-valid LLM proposals are kept (and new ones
        installed); the rest are filled by the deterministic matcher. Auto-dispatch commits them."""
        ranked = self._ranked()
        rank_of = {inc.id: r for r, inc in ranked}
        inc_of = {inc.id: inc for _, inc in ranked}
        available = {r.id: r for r in self._available()}
        rejected = frozenset(self.rejected)

        kept: dict[str, Proposal] = {k: p for k, p in self.proposals.items() if p.source == "llm"}
        if llm_items:
            replaced = {a["incident_id"] for a in llm_items}
            kept = {k: p for k, p in kept.items() if p.incident_id not in replaced}
            for a in llm_items:
                p = self._proposal_from({**a, "source": "llm"}, rank_of.get(a["incident_id"], 99))
                if p:
                    kept[p.id] = p

        counts, used, valid = self._assigned_counts(), set(), {}
        for k, p in kept.items():
            inc, res = inc_of.get(p.incident_id), available.get(p.resource_id)
            if inc is None or res is None or res.id in used or (inc.id, res.id) in rejected:
                continue
            if not agents.is_capable(res, inc) or agents.crew_needed(inc, counts) <= 0:
                continue
            used.add(res.id)
            counts[inc.id] = counts.get(inc.id, 0) + 1
            valid[k] = p.model_copy(update={"priority": rank_of[inc.id], "incident_title": inc.title,
                                            "eta_minutes": agents.eta_minutes(res, inc)})

        free = [r for r in available.values() if r.id not in used]
        for a in agents.greedy_match(ranked, free, counts, rejected):
            p = self._proposal_from(a, rank_of.get(a["incident_id"], 99))
            if p and p.id not in valid:
                valid[p.id] = p
        self.proposals = valid
        if self.auto_dispatch and self.proposals:
            self._commit(list(self.proposals.values()))

    def _commit(self, props: list[Proposal]) -> int:
        ranked = self._ranked()
        applied = self._apply_assignments(
            [{"incident_id": p.incident_id, "resource_id": p.resource_id, "role": p.role, "rationale": p.rationale}
             for p in props], ranked)
        for p in props:
            self.proposals.pop(p.id, None)
        return applied

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

    # -- human actions (net control) ---------------------------------------------------------

    async def _after_action(self) -> WorldSnapshot:
        await self._persist()
        await self._push()
        return self.snapshot()

    def _require_live(self) -> None:
        if self.status == "ended":
            raise DomainError(409, "conflict", "The drill has ended — restart it to continue.")

    async def approve(self, proposal_ids: Optional[list[str]] = None) -> WorldSnapshot:
        """Commit proposals (all of them when no ids are given)."""
        async with self._lock:
            self._require_live()
            chosen = list(self.proposals.values())
            if proposal_ids is not None:
                missing = [i for i in proposal_ids if i not in self.proposals]
                if missing:
                    raise DomainError(404, "not_found", "That proposal no longer exists — the picture changed. Review the new recommendations.")
                chosen = [self.proposals[i] for i in proposal_ids]
            n = self._commit(chosen)
            if chosen:
                self._log(f"✅ Net control approved {n} dispatch(es)")
            self._recompute_proposals()
            return await self._after_action()

    async def reject(self, proposal_id: str) -> WorldSnapshot:
        async with self._lock:
            self._require_live()
            p = self.proposals.get(proposal_id)
            if p is None:
                raise DomainError(404, "not_found", "That proposal no longer exists.")
            self.rejected.add((p.incident_id, p.resource_id))
            self.proposals.pop(proposal_id, None)
            self._log(f"✋ Net control rejected {p.resource_name} → {p.incident_title[:40]}")
            self._recompute_proposals()
            return await self._after_action()

    async def manual_dispatch(self, incident_id: str, resource_id: str, role: str = "") -> WorldSnapshot:
        """Override: net control sends a specific available unit to a specific incident."""
        async with self._lock:
            self._require_live()
            inc = self.incidents.get(incident_id)
            res = next((r for r in self.resources if r.id == resource_id), None)
            if inc is None or inc.status not in ACTIVE_STATUSES or inc.risk is None:
                raise DomainError(404, "not_found", "That incident is not active.")
            if res is None:
                raise DomainError(404, "not_found", "Unknown unit.")
            if res.status != "available":
                raise DomainError(409, "conflict", f"{res.name} is not available ({res.status.replace('_', ' ')}). Recall it first.")
            if not agents.is_capable(res, inc):
                raise DomainError(409, "conflict", f"{res.name} cannot serve a {inc.type.value.replace('_', ' ')}.")
            if self._assigned_counts().get(inc.id, 0) >= agents.CREW_CAP[agents.tier_of(inc)]:
                raise DomainError(409, "conflict", "That incident already has its maximum crew.")
            self._apply_assignments([{"incident_id": inc.id, "resource_id": res.id, "role": role,
                                      "rationale": "Net control override"}], self._ranked())
            self._log(f"🎛 Net control dispatched {res.name} → {inc.title[:40]}")
            self._recompute_proposals()
            return await self._after_action()

    async def recall(self, unit_id: str) -> WorldSnapshot:
        async with self._lock:
            self._require_live()
            res = next((r for r in self.resources if r.id == unit_id), None)
            if res is None:
                raise DomainError(404, "not_found", "Unknown unit.")
            if res.status not in ("en_route", "on_scene"):
                raise DomainError(409, "conflict", f"{res.name} is {res.status.replace('_', ' ')} — nothing to recall.")
            inc = self.incidents.get(res.assigned_incident or "")
            res.status, res.assigned_incident, res.role = "returning", None, ""
            self._log(f"↩️ Net control recalled {res.name}")
            if inc is not None:
                self._reconcile_status(inc)
            self._recompute_proposals()
            return await self._after_action()

    async def set_incident_status(self, incident_id: str, status: str) -> WorldSnapshot:
        async with self._lock:
            self._require_live()
            inc = self.incidents.get(incident_id)
            if inc is None:
                raise DomainError(404, "not_found", "Unknown incident.")
            if inc.status not in ACTIVE_STATUSES:
                raise DomainError(409, "conflict", f"That incident is already {inc.status.value}.")
            if status == "contained":
                self._contain(inc, by="net control")
            elif status == "closed":
                self._contain(inc, by="net control", closed=True)
            else:
                raise DomainError(400, "validation_error", "status must be 'contained' or 'closed'.")
            self._recompute_proposals()
            return await self._after_action()

    async def set_auto_dispatch(self, enabled: bool) -> WorldSnapshot:
        async with self._lock:
            self.auto_dispatch = enabled
            self._log("⚙️ Dispatch mode: " + ("AUTO (demo) — recommendations are committed immediately"
                                              if enabled else "MANUAL — recommendations await your approval"))
            self._recompute_proposals()
            return await self._after_action()

    # -- command cards ----------------------------------------------------------------------

    def _command_signature(self, ranked: list[tuple[int, Incident]]) -> tuple:
        top = tuple((inc.id, agents.tier_of(inc), inc.status.value) for _, inc in ranked[:agents.TOP_N])
        deps = tuple(sorted((d.resource_id, d.incident_id) for d in self._deployments))
        alerts = tuple(sorted((w.zone, w.alert) for w in self.sim.weather.values() if w.alert))
        return (top, deps, alerts)

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

    # -- world evolution ---------------------------------------------------------------------

    def _reconcile_status(self, inc: Incident) -> None:
        """After a recall: the incident status follows the units that remain."""
        if inc.status not in (IncidentStatus.ON_SCENE, IncidentStatus.UNITS_EN_ROUTE):
            return
        mine = [r for r in self.resources if r.assigned_incident == inc.id]
        if any(r.status == "on_scene" for r in mine):
            inc.status = IncidentStatus.ON_SCENE
        elif mine:
            inc.status = IncidentStatus.UNITS_EN_ROUTE
        else:
            inc.status = IncidentStatus.TRIAGED
            self._on_scene_ticks.pop(inc.id, None)

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

    def _contain(self, inc: Incident, by: str = "", closed: bool = False) -> None:
        inc.status = IncidentStatus.CLOSED if closed else IncidentStatus.CONTAINED
        self._resolved += 1
        released = 0
        for r in self.resources:
            if r.assigned_incident == inc.id:
                r.status, r.assigned_incident, r.role = "returning", None, ""
                released += 1
        for k in [k for k, p in self.proposals.items() if p.incident_id == inc.id]:
            self.proposals.pop(k, None)
        verb = "Closed" if closed else "Contained"
        who = f" by {by}" if by else ""
        self._log(f"🛡 {verb}{who}: {inc.title[:60]} — {released} unit(s) released")

    def _drift_unresolved(self) -> None:
        """Unaddressed incidents get worse — this is what forces the ranking to
        legitimately change over time (including while a proposal awaits approval)."""
        assigned = {r.assigned_incident for r in self.resources}
        for inc in self.incidents.values():
            if inc.id in assigned or inc.status not in (IncidentStatus.NEW, IncidentStatus.TRIAGED):
                continue
            if inc.injuries <= 0:
                continue        # nobody is hurt: waiting doesn't multiply the people at risk
            baseline = self._pop_baseline.setdefault(inc.id, max(inc.affected_population, 1))
            inc.affected_population = min(int(inc.affected_population * 1.08) + 2, baseline * 3)

    # -- snapshot & metrics --------------------------------------------------------------------

    def elapsed_s(self) -> int:
        return int((self.ended_at or time.time()) - self.started_at)

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
            proposals=sorted(self.proposals.values(), key=lambda p: (p.priority, p.id)),
            settings={"auto_dispatch": self.auto_dispatch,
                      "dispatch_mode": "auto" if self.auto_dispatch else "manual",
                      "llm_available": self._llm_available()},
            elapsed_s=self.elapsed_s(),
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
            "viewers": self.viewers,
            "peak_viewers": self.peak_viewers,
            "provisional_incidents": sum(1 for _, i in ranked if i.provisional),
            "recommendation_quality": {
                "p1p2_count": len(p12),
                "p1p2_covered": len(covered),
                "p1p2_proposed": len({p.incident_id for p in self.proposals.values()
                                      if self.incidents.get(p.incident_id) in p12}),
                "coverage": round(len(covered) / len(p12), 2) if p12 else 1.0,
                "capability_match": round(matched / len(deps), 2) if deps else 1.0,
                "p1_best_eta_min": min(p1_etas) if p1_etas else None,
                "injections_processed": self._injection_count,
                "resolved_incidents": self._resolved,
                "pending_proposals": len(self.proposals),
            },
        }


def _run_sync(coro):
    """Drive a coroutine that never actually suspends (the rule-based agent paths) to completion."""
    try:
        coro.send(None)
    except StopIteration as done:
        return done.value
    coro.close()
    raise RuntimeError("expected a non-suspending coroutine")


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
