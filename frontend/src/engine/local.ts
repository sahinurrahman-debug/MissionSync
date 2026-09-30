// The in-browser DEMO engine: the backend orchestrator's loop, re-hosted with
// rule-based agents so the drill runs at a public URL with no server. It is used
// only when no backend is configured or reachable, and the UI labels it "demo".
//
// Same loop as backend/missionsync/orchestrator.py:
//   signals → surveillance → merge/create → terrain → risk → logistics → command
// plus the incident lifecycle: en route → on scene → worked → contained → units
// return to base and become available again.

import {
  ApiError,
  type Deployment,
  type EventLine,
  type Incident,
  type IncidentType,
  type InjectResult,
  type Metrics,
  type PipelineOrigin,
  type PipelineStage,
  type Proposal,
  type RecommendedAction,
  type Resource,
  type Snapshot,
  type TerrainCell,
  type WeatherCell,
} from '../types'
import { SAMPLE_REPORTS, type DataSource, type Subscriber } from '../source'
import { haversineKm, round1 } from './geo'
import { Rng } from './rng'
import {
  CITY_CENTER, FOLLOWUP_TEXT, GRADE_URGENCY, SECTORS, SEED_ITEMS, TERRAIN, WAVE_ITEMS,
  buildResources, initialWeather, locateText, type ScenarioItem,
} from './scenario'
import {
  CREW_CAP, commandRecommend, etaMinutes, isCapable, logisticsMatch, riskScore, roleFor,
  surveillanceParse, terrainAssess, tierFor, tierOf, type Assignment, type ParsedSignal,
} from './agents'

export const TICK_MS = 6000
const WAVE_TICKS = [2, 4, 6, 8]
const FOLLOWUP_TICK = 3
/** After the scripted opening a report arrives every RECYCLE_EVERY ticks (~3 min), so a drill can run for hours. */
const RECYCLE_AFTER = 10
const RECYCLE_EVERY = 30
const MAX_ACTIVE = 12
const LOG_CAP = 300
/** Ticks a crew works on scene before the incident is contained (6 s per tick). */
const WORK_TICKS = { P1: 24, P2: 20, P3: 12, P4: 8 } as const
const ACTIVE = new Set(['new', 'triaged', 'units_en_route', 'on_scene'])

interface WorldIncident extends Incident {
  terrain: TerrainCell
  mergedCount: number
}

function clockOf(now: number): string {
  const d = new Date(now)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}Z`
}

const STAGES: PipelineStage[] = ['surveillance', 'terrain', 'risk', 'logistics', 'command']
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export class LocalEngine implements DataSource {
  readonly kind = 'local' as const

  /** The demo engine computes instantly; `paceMs` walks the five stages visibly for an injected report
   *  (so the pipeline stepper reads like the real one). The backend streams genuine stages instead. */
  constructor(private opts: { paceMs?: number; autoDispatch?: boolean } = {}) {
    this.autoDispatch = opts.autoDispatch ?? false
  }

  private incidents = new Map<string, WorldIncident>()
  private resources: Resource[] = buildResources()
  private weather: Record<string, WeatherCell> = initialWeather()
  private eventLog: EventLine[] = []
  private seq = 0
  private tickCount = 0
  private injectionCount = 0
  private resolved = 0
  private incidentCounter = 0
  private waveIndex = 0
  private groundTruth = new Map<string, number>()
  private onSceneTicks = new Map<string, number>()
  private popBaseline = new Map<string, number>()
  private rng = new Rng(42)
  private timer: ReturnType<typeof setInterval> | null = null
  private subscribers = new Set<Subscriber>()
  private stage: PipelineStage = 'idle'
  private origin: PipelineOrigin = 'boot'
  private lastCycleMs = 0
  private lastStages: Record<string, number> = {}
  private recs: RecommendedAction[] = []
  private cachedSnap: Snapshot | null = null
  private booted = false
  private sampleIndex = 0
  // Agents recommend, a person commits: proposals wait for approval unless auto-dispatch (demo) is on.
  private proposals = new Map<string, Proposal>()
  private rejected = new Set<string>()
  private autoDispatch = false
  private startedAt = Date.now()
  private endedAt: number | null = null
  private ended = false
  private recycleIndex = 0

  // -- DataSource -----------------------------------------------------------

  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn)
    return () => {
      this.subscribers.delete(fn)
    }
  }

  getSnapshot(): Snapshot {
    if (!this.cachedSnap) this.cachedSnap = this.buildSnapshot()
    return this.cachedSnap
  }

  start(): void {
    if (!this.booted) this.boot('boot')
    if (!this.timer) this.timer = setInterval(() => this.tick(), TICK_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  nextSampleReport(): string {
    const s = SAMPLE_REPORTS[this.sampleIndex % SAMPLE_REPORTS.length]
    this.sampleIndex += 1
    return s
  }

  async reset(): Promise<void> {
    const running = this.timer !== null
    this.stop()
    this.incidents = new Map()
    this.resources = buildResources()
    this.weather = initialWeather()
    this.eventLog = []
    this.seq = this.tickCount = this.injectionCount = this.resolved = this.incidentCounter = this.waveIndex = 0
    this.groundTruth = new Map()
    this.onSceneTicks = new Map()
    this.popBaseline = new Map()
    this.rng = new Rng(42)
    this.recs = []
    this.proposals = new Map()
    this.rejected = new Set()
    this.startedAt = Date.now()
    this.endedAt = null
    this.ended = false
    this.recycleIndex = 0
    this.booted = false
    this.boot('reset')
    if (running) this.start()
  }

  // -- net control: the human-commit actions ---------------------------------------------

  private requireLive(): void {
    if (this.ended) throw new ApiError('The drill has ended — restart it to continue.', 'conflict', 409)
  }

  async approve(proposalIds?: string[]): Promise<void> {
    this.requireLive()
    let chosen = [...this.proposals.values()]
    if (proposalIds) {
      const missing = proposalIds.filter((id) => !this.proposals.has(id))
      if (missing.length) throw new ApiError('That proposal no longer exists — the picture changed. Review the new recommendations.', 'not_found', 404)
      chosen = proposalIds.map((id) => this.proposals.get(id)!)
    }
    const n = this.commit(chosen)
    if (chosen.length) this.log(`✅ Net control approved ${n} dispatch(es)`)
    this.recomputeProposals()
    this.push()
  }

  async reject(proposalId: string): Promise<void> {
    this.requireLive()
    const p = this.proposals.get(proposalId)
    if (!p) throw new ApiError('That proposal no longer exists.', 'not_found', 404)
    this.rejected.add(`${p.incident_id}:${p.resource_id}`)
    this.proposals.delete(proposalId)
    this.log(`✋ Net control rejected ${p.resource_name} → ${p.incident_title.slice(0, 40)}`)
    this.recomputeProposals()
    this.push()
  }

  async dispatchManual(incidentId: string, resourceId: string): Promise<void> {
    this.requireLive()
    const inc = this.incidents.get(incidentId)
    const res = this.resources.find((r) => r.id === resourceId)
    if (!inc || !ACTIVE.has(inc.status) || !inc.risk) throw new ApiError('That incident is not active.', 'not_found', 404)
    if (!res) throw new ApiError('Unknown unit.', 'not_found', 404)
    if (res.status !== 'available') throw new ApiError(`${res.name} is not available (${res.status.replace('_', ' ')}). Recall it first.`, 'conflict', 409)
    if (!isCapable(res, inc)) throw new ApiError(`${res.name} cannot serve a ${inc.type.replace(/_/g, ' ')}.`, 'conflict', 409)
    if ((this.assignedCounts()[inc.id] ?? 0) >= CREW_CAP[tierOf(inc)]) throw new ApiError('That incident already has its maximum crew.', 'conflict', 409)
    this.applyAssignments([{ incident_id: inc.id, resource_id: res.id, role: roleFor(res, inc), rationale: 'Net control override' }], this.ranked())
    this.log(`🎛 Net control dispatched ${res.name} → ${inc.title.slice(0, 40)}`)
    this.recomputeProposals()
    this.push()
  }

  async recall(unitId: string): Promise<void> {
    this.requireLive()
    const res = this.resources.find((r) => r.id === unitId)
    if (!res) throw new ApiError('Unknown unit.', 'not_found', 404)
    if (res.status !== 'en_route' && res.status !== 'on_scene') {
      throw new ApiError(`${res.name} is ${res.status.replace('_', ' ')} — nothing to recall.`, 'conflict', 409)
    }
    const inc = res.assigned_incident ? this.incidents.get(res.assigned_incident) : undefined
    res.status = 'returning'; res.assigned_incident = null; res.role = ''
    this.log(`↩️ Net control recalled ${res.name}`)
    if (inc && (inc.status === 'on_scene' || inc.status === 'units_en_route')) {
      const mine = this.resources.filter((r) => r.assigned_incident === inc.id)
      inc.status = mine.some((r) => r.status === 'on_scene') ? 'on_scene' : mine.length ? 'units_en_route' : 'triaged'
    }
    this.recomputeProposals()
    this.push()
  }

  async resolveIncident(incidentId: string, status: 'contained' | 'closed'): Promise<void> {
    this.requireLive()
    const inc = this.incidents.get(incidentId)
    if (!inc) throw new ApiError('Unknown incident.', 'not_found', 404)
    if (!ACTIVE.has(inc.status)) throw new ApiError(`That incident is already ${inc.status}.`, 'conflict', 409)
    this.contain(inc, 'net control', status === 'closed')
    this.recomputeProposals()
    this.push()
  }

  async setAutoDispatch(enabled: boolean): Promise<void> {
    this.autoDispatch = enabled
    this.log(`⚙️ Dispatch mode: ${enabled ? 'AUTO (demo) — recommendations are committed immediately' : 'MANUAL — recommendations await your approval'}`)
    this.recomputeProposals()
    this.push()
  }

  async endDrill(): Promise<void> {
    if (this.ended) throw new ApiError('The drill has already ended.', 'conflict', 409)
    this.ended = true
    this.endedAt = Date.now()
    this.log(`🏁 Drill ended by net control after ${Math.round((this.endedAt - this.startedAt) / 1000)} s — ${this.resolved} incident(s) resolved`)
    this.push()
  }

  async injectReport(text: string): Promise<InjectResult> {
    if (this.ended) throw new ApiError('The drill has ended — restart it to inject more reports.', 'conflict', 409)
    const clean = text.trim().slice(0, 2000)
    if (!clean) {
      return { kind: 'rejected', incident_title: '', tier: null, urgency: null, message: 'Type a report first.', provisional: false }
    }
    this.injectionCount += 1
    this.log(`🔥 INJECTED REPORT #${this.injectionCount}: “${clean.slice(0, 70)}${clean.length > 70 ? '…' : ''}”`)

    const place = locateText(clean)
    const signal: ParsedSignal = place
      ? { source: 'radio', lat: place.lat, lon: place.lon, raw_text: clean, confidence: 0.9, located: true }
      : { source: 'radio', lat: CITY_CENTER.lat, lon: CITY_CENTER.lon, raw_text: clean, confidence: 0.9, located: false }

    const pace = this.opts.paceMs ?? 150
    if (pace > 0) {
      this.origin = 'inject'
      for (const st of STAGES) {
        this.stage = st
        this.push()
        await sleep(pace)
      }
    }
    const outcomes = this.runPipeline([signal], 'inject')
    let result: InjectResult
    if (outcomes.length === 0) {
      this.log('🚫 No emergency recognised in that report — nothing logged')
      result = {
        kind: 'rejected', incident_title: '', tier: null, urgency: null, provisional: false,
        message: 'No emergency recognised. Say what is happening and where (e.g. “smoke from the University chemistry lab, two people coughing”).',
      }
    } else {
      const last = outcomes[outcomes.length - 1]
      result = {
        kind: last.kind,
        incident_title: last.incident.title,
        tier: last.incident.risk?.tier ?? null,
        urgency: last.incident.risk?.urgency ?? null,
        message: '',
        provisional: false,
      }
    }
    this.push()
    return result
  }

  // -- boot / heartbeat -------------------------------------------------------

  private boot(origin: PipelineOrigin): void {
    this.booted = true
    this.log(`🟢 Scenario loaded: Riverton exercise, ${SEED_ITEMS.length} initial incidents, ${this.resources.length} resources (demo engine)`)
    this.runPipeline(SEED_ITEMS.map((item) => this.signalFromItem(item)), origin === 'reset' ? 'reset' : 'boot')
    this.push()
  }

  private signalFromItem(item: ScenarioItem): ParsedSignal {
    return {
      source: item.source, lat: item.lat, lon: item.lon, raw_text: item.text, confidence: 0.85,
      located: true, type_hint: item.type, gt: GRADE_URGENCY[item.grade],
    }
  }

  private tick(): void {
    if (this.ended || !this.booted) return          // an ended drill is frozen
    try {
      this.tickCount += 1
      for (const cell of Object.values(this.weather)) {
        cell.wind_kph = Math.max(2, round1(cell.wind_kph + this.rng.range(-3, 3)))
        if (cell.alert === 'flood_watch') {
          cell.precipitation_mm_h = Math.max(0, round1(cell.precipitation_mm_h + this.rng.range(-1.5, 2)))
        }
      }
      if (this.tickCount === 4) {
        this.weather['North Hills'].wind_kph = 52
        this.weather['North Hills'].forecast_note = 'wind gusting to 65 kph — extreme fire behavior possible'
        this.log('⚠️ Weather: North Hills winds intensifying to 52 kph')
      }

      const signals: ParsedSignal[] = []
      if (WAVE_TICKS.includes(this.tickCount) && this.waveIndex < WAVE_ITEMS.length) {
        const item = WAVE_ITEMS[this.waveIndex]
        this.waveIndex += 1
        signals.push(this.signalFromItem(item))
        this.log(`📡 New incoming signal from ${this.zoneOf(item.lat, item.lon)}`)
      }
      if (this.tickCount === FOLLOWUP_TICK) {
        const seed = SEED_ITEMS[0]
        signals.push({ source: 'ground_report', lat: seed.lat, lon: seed.lon, raw_text: FOLLOWUP_TEXT, confidence: 0.92, located: true, type_hint: seed.type })
        this.log('📡 Follow-up report on Downtown collapse')
      }

      if (this.tickCount > RECYCLE_AFTER && (this.tickCount - RECYCLE_AFTER) % RECYCLE_EVERY === 0 && this.ranked().length < MAX_ACTIVE) {
        const pool = [...SEED_ITEMS, ...WAVE_ITEMS]
        const item = pool[this.recycleIndex % pool.length]
        this.recycleIndex += 1
        signals.push({ ...this.signalFromItem(item), lat: item.lat + this.rng.jitter(0.002), lon: item.lon + this.rng.jitter(0.002) })
        this.log(`📡 New incoming signal from ${this.zoneOf(item.lat, item.lon)}`)
      }

      this.advanceWorld()
      if (signals.length > 0) this.runPipeline(signals, 'sim')
      else this.refreshRankings()
      this.push()
    } catch (err) {
      this.log(`❗ cycle error (recovered): ${err instanceof Error ? err.message : String(err)}`)
      this.stage = 'idle'
      this.push()
    }
  }

  // -- the pipeline ---------------------------------------------------------------

  private runPipeline(
    signals: ParsedSignal[],
    origin: PipelineOrigin,
  ): Array<{ kind: 'created' | 'merged'; incident: WorldIncident }> {
    const t0 = performance.now()
    const stages: Record<string, number> = {}
    this.origin = origin

    let t = performance.now()
    this.stage = 'surveillance'
    const outcomes: Array<{ kind: 'created' | 'merged'; incident: WorldIncident }> = []
    for (const sig of signals) {
      const cand = surveillanceParse(sig)
      if (!cand) continue
      // The geospatial safety net needs a real place; an unlocated report says nothing about where.
      const existing = sig.located === false ? null : this.findMatch(cand.type, cand.lat, cand.lon)
      if (existing) {
        // Counts ratchet up only when the report states numbers; a type default must not win.
        if (cand.counts_reported) {
          existing.affected_population = Math.max(existing.affected_population, cand.affected_population)
          existing.injuries = Math.max(existing.injuries, cand.injuries)
        }
        existing.confidence = Math.max(existing.confidence, cand.confidence)
        if (!existing.description.includes(cand.description)) {
          existing.description = `${existing.description} | ${cand.description}`.slice(0, 500)
        }
        existing.mergedCount += 1
        if (existing.status === 'new') existing.status = 'triaged'
        this.log(`🔗 Report merged into: ${existing.title}`)
        outcomes.push({ kind: 'merged', incident: existing })
      } else {
        const inc = this.createIncident(cand, sig.located !== false)
        if (sig.gt !== undefined) this.groundTruth.set(inc.id, sig.gt)
        outcomes.push({ kind: 'created', incident: inc })
      }
    }
    stages.surveillance_ms = Math.max(1, Math.round(performance.now() - t))

    t = performance.now()
    this.stage = 'terrain'
    const touched = [...new Set(outcomes.map((o) => o.incident))]
    for (const inc of touched) this.rescore(inc)
    this.stage = 'risk'
    stages.terrain_risk_ms = Math.max(1, Math.round(performance.now() - t))

    t = performance.now()
    this.stage = 'logistics'
    this.recomputeProposals()
    stages.logistics_ms = Math.max(1, Math.round(performance.now() - t))

    t = performance.now()
    this.stage = 'command'
    this.recs = commandRecommend(this.ranked(), this.deployments(), Object.values(this.weather))
    stages.command_ms = Math.max(1, Math.round(performance.now() - t))

    this.stage = 'idle'
    this.lastStages = stages
    this.lastCycleMs = Math.round(performance.now() - t0)
    this.log(`🚁 ${this.proposals.size} dispatch proposal(s) pending · Command issued ${this.recs.length} recommendation(s)`)
    this.log(`⚡ Pipeline cycle complete in ${this.lastCycleMs}ms (${origin})`)
    return outcomes
  }

  private rescore(inc: WorldIncident): void {
    const weather = this.weather[inc.zone] ?? this.weather[this.zoneOf(inc.lat, inc.lon)]
    const terrain = terrainAssess(inc, weather, inc.terrain)
    inc.risk = riskScore(inc, terrain, weather, Date.now())
    inc.updated_at = inc.risk.scored_at
  }

  private refreshRankings(): void {
    for (const { incident } of this.ranked()) this.rescore(incident)
    this.recomputeProposals()
    this.recs = commandRecommend(this.ranked(), this.deployments(), Object.values(this.weather))
  }

  private assignedCounts(): Record<string, number> {
    const counts: Record<string, number> = {}
    for (const r of this.resources) {
      if (r.assigned_incident) counts[r.assigned_incident] = (counts[r.assigned_incident] ?? 0) + 1
    }
    return counts
  }

  /** Rebuild the pending recommendations; auto-dispatch (demo) commits them at once. */
  private recomputeProposals(): void {
    const ranked = this.ranked()
    const rankById = new Map(ranked.map(({ rank, incident }) => [incident.id, rank]))
    const next = new Map<string, Proposal>()
    for (const a of logisticsMatch(ranked, this.resources, this.assignedCounts(), this.rejected)) {
      const inc = this.incidents.get(a.incident_id)
      const res = this.resources.find((r) => r.id === a.resource_id)
      if (!inc || !res) continue
      const id = `${inc.id}:${res.id}`
      next.set(id, {
        id, incident_id: inc.id, incident_title: inc.title, resource_id: res.id, resource_name: res.name,
        resource_type: res.type, eta_minutes: etaMinutes(res, inc), role: a.role, priority: rankById.get(inc.id) ?? 99,
        rationale: a.rationale, source: 'rules',
      })
    }
    this.proposals = next
    if (this.autoDispatch && next.size > 0) this.commit([...next.values()])
  }

  private commit(props: Proposal[]): number {
    const applied = this.applyAssignments(
      props.map((p) => ({ incident_id: p.incident_id, resource_id: p.resource_id, role: p.role, rationale: p.rationale })),
      this.ranked(),
    )
    for (const p of props) this.proposals.delete(p.id)
    return applied
  }

  /** Final gate: available + capable + within the per-incident cap. */
  private applyAssignments(assignments: Assignment[], ranked: Array<{ rank: number; incident: Incident }>): number {
    const rankById = new Map(ranked.map(({ rank, incident }) => [incident.id, rank]))
    const incById = new Map(ranked.map(({ incident }) => [incident.id, incident]))
    const counts = this.assignedCounts()
    let applied = 0
    for (const a of assignments) {
      const inc = incById.get(a.incident_id)
      const res = this.resources.find((r) => r.id === a.resource_id)
      if (!inc || !res || res.status !== 'available' || !isCapable(res, inc)) continue
      if ((counts[inc.id] ?? 0) >= CREW_CAP[tierOf(inc)]) continue
      res.status = 'en_route'
      res.assigned_incident = inc.id
      res.current_lat = res.current_lat ?? res.base_lat
      res.current_lon = res.current_lon ?? res.base_lon
      res.role = a.role || roleFor(res, inc)
      counts[inc.id] = (counts[inc.id] ?? 0) + 1
      if (inc.status === 'new' || inc.status === 'triaged') inc.status = 'units_en_route'
      applied += 1
      this.log(`🚨 Deploy ${res.name} → [#${rankById.get(inc.id) ?? '?'}] ${inc.title.slice(0, 50)} (ETA ${etaMinutes(res, inc).toFixed(0)} min)`)
    }
    return applied
  }

  private deployments(): Deployment[] {
    const rankById = new Map(this.ranked().map(({ rank, incident }) => [incident.id, rank]))
    const deps: Deployment[] = []
    for (const r of this.resources) {
      const inc = r.assigned_incident ? this.incidents.get(r.assigned_incident) : undefined
      if (!inc || !rankById.has(inc.id)) continue
      deps.push({
        id: `dep_${r.id}_${inc.id}`,
        incident_id: inc.id,
        incident_title: inc.title,
        resource_id: r.id,
        resource_name: r.name,
        resource_type: r.type,
        eta_minutes: etaMinutes(r, inc),
        role: r.role || 'assigned',
        priority: rankById.get(inc.id) ?? 99,
        rationale: 'Capability + proximity match',
      })
    }
    return deps
  }

  // -- world evolution ---------------------------------------------------------------

  /** Move units and run the incident lifecycle. */
  private advanceWorld(): void {
    const stepKm = (50 / 3600) * (TICK_MS / 1000)
    for (const r of this.resources) {
      const inc = r.assigned_incident ? this.incidents.get(r.assigned_incident) : undefined
      if (r.status === 'en_route') {
        if (!inc || !ACTIVE.has(inc.status)) {
          r.status = 'returning'; r.assigned_incident = null; r.role = ''
        } else if (this.stepToward(r, inc.lat, inc.lon, stepKm)) {
          r.status = 'on_scene'
          inc.status = 'on_scene'
          this.log(`✅ ${r.name} on scene at ${inc.title.slice(0, 50)}`)
        }
      } else if (r.status === 'returning') {
        if (this.stepToward(r, r.base_lat, r.base_lon, stepKm)) {
          r.status = 'available'; r.current_lat = null; r.current_lon = null
          this.log(`🏁 ${r.name} back at base, available`)
        }
      }
    }
    for (const inc of this.incidents.values()) {
      if (inc.status !== 'on_scene') continue
      const ticks = (this.onSceneTicks.get(inc.id) ?? 0) + 1
      this.onSceneTicks.set(inc.id, ticks)
      if (ticks >= WORK_TICKS[tierOf(inc)]) this.contain(inc)
    }
    // Unaddressed casualties get worse — capped, and only where someone is hurt.
    const assigned = new Set(this.resources.map((r) => r.assigned_incident).filter(Boolean) as string[])
    for (const inc of this.incidents.values()) {
      if (assigned.has(inc.id) || !(inc.status === 'new' || inc.status === 'triaged') || inc.injuries <= 0) continue
      const base = this.popBaseline.get(inc.id) ?? Math.max(inc.affected_population, 1)
      this.popBaseline.set(inc.id, base)
      inc.affected_population = Math.min(Math.round(inc.affected_population * 1.08) + 2, base * 3)
    }
  }

  private stepToward(r: Resource, lat: number, lon: number, stepKm: number): boolean {
    const fromLat = r.current_lat ?? r.base_lat
    const fromLon = r.current_lon ?? r.base_lon
    const d = haversineKm(fromLat, fromLon, lat, lon)
    if (d <= Math.max(stepKm, 0.15)) {
      r.current_lat = lat
      r.current_lon = lon
      return true
    }
    const frac = stepKm / Math.max(d, 1e-6)
    r.current_lat = fromLat + (lat - fromLat) * frac
    r.current_lon = fromLon + (lon - fromLon) * frac
    return false
  }

  private contain(inc: WorldIncident, by = '', closed = false): void {
    inc.status = closed ? 'closed' : 'contained'
    this.resolved += 1
    for (const [k, p] of this.proposals) if (p.incident_id === inc.id) this.proposals.delete(k)
    let released = 0
    for (const r of this.resources) {
      if (r.assigned_incident === inc.id) {
        r.status = 'returning'; r.assigned_incident = null; r.role = ''
        released += 1
      }
    }
    this.log(`🛡 ${closed ? 'Closed' : 'Contained'}${by ? ` by ${by}` : ''}: ${inc.title.slice(0, 60)} — ${released} unit(s) released`)
  }

  // -- merge/create helpers -------------------------------------------------------------

  private findMatch(type: IncidentType, lat: number, lon: number): WorldIncident | null {
    for (const inc of this.incidents.values()) {
      if (!ACTIVE.has(inc.status)) continue
      if (inc.type === type && haversineKm(lat, lon, inc.lat, inc.lon) < 1.5) return inc
    }
    return null
  }

  private zoneOf(lat: number, lon: number): string {
    let best = SECTORS[0].name
    let bestD = Number.POSITIVE_INFINITY
    for (const s of SECTORS) {
      const d = (s.lat - lat) ** 2 + (s.lon - lon) ** 2
      if (d < bestD) { bestD = d; best = s.name }
    }
    return best
  }

  private createIncident(cand: NonNullable<ReturnType<typeof surveillanceParse>>, located: boolean): WorldIncident {
    this.incidentCounter += 1
    const id = `inc_${String(this.incidentCounter).padStart(3, '0')}`
    const sector = this.zoneOf(cand.lat, cand.lon)
    const now = new Date().toISOString()
    const inc: WorldIncident = {
      id,
      type: cand.type,
      title: cand.title,
      description: cand.description,
      lat: cand.lat,
      lon: cand.lon,
      zone: located ? sector : 'Unlocated',
      status: 'new',
      reported_at: now,
      updated_at: now,
      affected_population: cand.affected_population,
      injuries: cand.injuries,
      confidence: cand.confidence,
      risk: null,
      location_known: located,
      provisional: false,
      terrain: TERRAIN[sector] ?? TERRAIN.Downtown,
      mergedCount: 0,
    }
    this.incidents.set(id, inc)
    this.log(`🆕 New incident: [${inc.zone}] ${inc.title}`)
    return inc
  }

  // -- snapshot ---------------------------------------------------------------------------

  private ranked(): Array<{ rank: number; incident: WorldIncident }> {
    const live = [...this.incidents.values()].filter((i) => i.risk && ACTIVE.has(i.status))
    live.sort((a, b) => (b.risk?.urgency ?? 0) - (a.risk?.urgency ?? 0))
    return live.map((incident, i) => ({ rank: i + 1, incident }))
  }

  private log(msg: string): void {
    this.seq += 1
    this.eventLog.push({ seq: this.seq, t: clockOf(Date.now()), msg })
    if (this.eventLog.length > LOG_CAP) this.eventLog = this.eventLog.slice(-LOG_CAP)
  }

  private metrics(ranked: Array<{ rank: number; incident: WorldIncident }>): Metrics {
    // Ground truth exists only for scripted incidents, so typed reports can't move ρ.
    const pairs: Array<[number, number]> = []
    for (const inc of this.incidents.values()) {
      const gt = this.groundTruth.get(inc.id)
      if (inc.risk && gt !== undefined) pairs.push([inc.risk.urgency, gt])
    }
    const rho = pairs.length >= 3 ? spearman(pairs.map((p) => p[0]), pairs.map((p) => p[1])) : null

    const p12 = ranked.filter(({ incident }) => tierOf(incident) === 'P1' || tierOf(incident) === 'P2')
    const assignedIds = new Set(this.resources.map((r) => r.assigned_incident).filter(Boolean) as string[])
    const covered = p12.filter(({ incident }) => assignedIds.has(incident.id))
    const deps = this.deployments()
    const byRes = new Map(this.resources.map((r) => [r.id, r]))
    const matched = deps.filter((d) => {
      const inc = this.incidents.get(d.incident_id)
      const res = byRes.get(d.resource_id)
      return inc && res && isCapable(res, inc)
    }).length
    const p1Etas = deps.filter((d) => d.priority === 1).map((d) => d.eta_minutes)
    const sources: Record<string, number> = {}
    for (const { incident } of ranked) if (incident.risk) sources[incident.risk.source] = (sources[incident.risk.source] ?? 0) + 1

    return {
      cycle_ms: this.lastCycleMs,
      stages: this.lastStages,
      spearman: rho,
      evaluated_incidents: pairs.length,
      p1p2_count: p12.length,
      p1p2_covered: covered.length,
      coverage: p12.length ? Math.round((covered.length / p12.length) * 100) / 100 : 1,
      capability_match: deps.length ? Math.round((matched / deps.length) * 100) / 100 : 1,
      p1_best_eta_min: p1Etas.length ? Math.min(...p1Etas) : null,
      injections: this.injectionCount,
      resolved: this.resolved,
      dataset_note: 'Demo scenario: hand-authored, damage grades on the xBD scale',
      mode: 'demo',
      model: null,
      llm_success_rate: null,
      quota_retry_s: null,
      scoring_sources: sources,
      drill_id: null,
      database: 'disabled',
      pending_proposals: this.proposals.size,
      provisional_incidents: 0,
      viewers: 1,
    }
  }

  private buildSnapshot(): Snapshot {
    const ranked = this.ranked()
    for (const { incident } of ranked) if (incident.risk) incident.risk.tier = tierFor(incident.risk.urgency)
    // Fresh copies every snapshot: React (and memo hooks) rely on new identities to see change.
    return structuredClone({
      status: this.ended ? 'ended' : this.booted ? 'live' : 'booting',
      connection: 'demo',
      engine: 'local',
      tick: this.tickCount,
      sim_time: new Date().toISOString(),
      incidents: ranked.map(({ incident }) => {
        const { terrain: _terrain, mergedCount: _merged, ...pub } = incident
        return pub
      }),
      resources: this.resources,
      weather: Object.values(this.weather),
      actions: this.recs,
      event_log: this.eventLog.slice(-40),
      metrics: this.metrics(ranked),
      pipeline: { stage: this.stage, origin: this.origin },
      proposals: [...this.proposals.values()].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id)),
      settings: { auto_dispatch: this.autoDispatch, dispatch_mode: this.autoDispatch ? 'auto' : 'manual', llm_available: false },
      elapsed_s: Math.round(((this.endedAt ?? Date.now()) - this.startedAt) / 1000),
    }) as unknown as Snapshot
  }

  private push(): void {
    this.cachedSnap = null
    const snap = this.getSnapshot()
    for (const fn of this.subscribers) fn(snap)
  }
}

export function spearman(xs: number[], ys: number[]): number | null {
  if (xs.length !== ys.length || xs.length < 2) return null
  const ranks = (vals: number[]): number[] => {
    const order = vals.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v)
    const out = new Array<number>(vals.length)
    let i = 0
    while (i < order.length) {
      let j = i
      while (j + 1 < order.length && order[j + 1].v === order[i].v) j += 1
      const avg = (i + j) / 2 + 1
      for (let k = i; k <= j; k++) out[order[k].i] = avg
      i = j + 1
    }
    return out
  }
  const rx = ranks(xs)
  const ry = ranks(ys)
  const n = xs.length
  const mx = rx.reduce((a, b) => a + b, 0) / n
  const my = ry.reduce((a, b) => a + b, 0) / n
  let num = 0
  let dx = 0
  let dy = 0
  for (let k = 0; k < n; k++) {
    num += (rx[k] - mx) * (ry[k] - my)
    dx += (rx[k] - mx) ** 2
    dy += (ry[k] - my) ** 2
  }
  if (dx === 0 || dy === 0) return null
  return Math.round((num / Math.sqrt(dx * dy)) * 1000) / 1000
}
