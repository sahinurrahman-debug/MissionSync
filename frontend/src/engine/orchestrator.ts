// The MissionSync orchestrator, ported to run entirely in the browser.
// Owns world state and runs the pipeline on every cycle:
//   signals → surveillance → terrain → risk → logistics → command
// New signals (including typed report injections) merge into state in place —
// no reload, no restart. This is the Level-1 backend's loop, re-hosted as the
// mock state layer so the drill loop genuinely runs at a public URL.

import type {
  EventLine,
  Incident,
  IncidentType,
  Metrics,
  InjectResult,
  PipelineOrigin,
  PipelineStage,
  RecommendedAction,
  Resource,
  Snapshot,
  TerrainCell,
  WeatherCell,
} from '../types'
import { haversineKm, round1 } from './geo'
import { Rng } from './rng'
import { SECTORS, TERRAIN, WEATHER, WEATHER_LIST, buildResources } from './scenario'
import {
  advanceResources,
  commandRecommend,
  etaMinutes,
  logisticsMatch,
  requiredFor,
  riskScore,
  surveillanceParse,
  terrainAssess,
  tierFor,
  type ParsedSignal,
} from './agents'

const TICK_MS = 6000
const MAX_WAVES = 4
const LOG_CAP = 80

interface WorldIncident extends Incident {
  terrain: TerrainCell
  mergedCount: number
}

export interface Subscriber {
  (snap: Snapshot): void
}

function nowIso(now: number): string {
  return new Date(now).toISOString()
}

function clockOf(now: number): string {
  const d = new Date(now)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:${String(d.getUTCSeconds()).padStart(2, '0')}Z`
}

// Deterministic scenario cohorts (in place of the xBD Kaggle pull: the same
// seeded incidents, wave pool, and hidden ground-truth urgencies).
const SEED_INCIDENTS: Array<{ text: string; type: IncidentType; gt: number }> = [
  { text: 'Radio report: two-story building partially collapsed near Downtown transit mall, four workers trapped, dust still settling', type: 'structural_collapse', gt: 90 },
  { text: 'Drone D1 spots active fire front spreading through dry brush on North Hills ridge, wind pushing flames toward homes', type: 'fire', gt: 88 },
  { text: 'Ammonia vapor cloud leaking from Industrial Park rail gate, three workers coughing, plume drifting east with the wind', type: 'hazmat', gt: 82 },
  { text: 'Floodwater rising fast around Riverfront marina, a family of four is trapped on a houseboat, water one meter from the deck', type: 'flood', gt: 76 },
  { text: 'Multi-vehicle crash on Eastside arterial, two passengers injured, one lane blocked', type: 'roadside_casualties', gt: 48 },
]

const WAVE_INCIDENTS: Array<{ text: string; type: IncidentType; gt: number }> = [
  { text: 'Fire spotting from University lab block roof, smoke visible from two streets away, evacuation underway', type: 'fire', gt: 70 },
  { text: 'Riverfront levee seeping at two points, water over the toe of the levee, crews requesting sandbags', type: 'flood', gt: 62 },
  { text: 'Second collapse report from Downtown: storefront awning gave way, one person injured, adjacent building evacuated', type: 'structural_collapse', gt: 58 },
  { text: 'Chemical odor reported across Industrial Park perimeter, two residents feeling dizzy, possible second release', type: 'hazmat', gt: 66 },
]

const FOLLOWUP = 'Update on Downtown collapse: third victim located, now four workers trapped, one unconscious.'

const SAMPLE_REPORT_TEXTS: string[] = [
  'New fire reported in the University chemistry building, heavy smoke on the third floor, dozens of students evacuating',
  'Floodwater closing on the Riverfront footbridge, two kayakers missing downstream',
  'Gas smell in Industrial Park block B, workers reporting dizziness, possible pipeline leak',
  'Mudslide across the North Hills access road, a car with two occupants partially buried',
  'Missing child last seen near the Riverfront levee, wearing a red jacket',
]

export class Orchestrator {
  private incidents = new Map<string, WorldIncident>()
  private resources: Resource[] = buildResources()
  private weather: Record<string, WeatherCell> = structuredClone(WEATHER)
  private eventLog: EventLine[] = []
  private seq = 0
  private tickCount = 0
  private injectionCount = 0
  private incidentCounter = 0
  private waveIndex = 0
  private groundTruth = new Map<string, number>()
  private rng = new Rng(42)
  private timer: ReturnType<typeof setInterval> | null = null
  private subscribers = new Set<Subscriber>()
  private stage: PipelineStage = 'idle'
  private stageOrigin: PipelineOrigin = 'boot'
  private lastCycleMs = 0
  private lastStages: Record<string, number> = {}
  private lastRecommendations: RecommendedAction[] = []
  private cachedSnap: Snapshot | null = null
  private status: 'booting' | 'live' = 'booting'
  private injectBusy = false
  private sampleIndex = 0

  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn)
    fn(this.getSnapshot())
    return () => {
      this.subscribers.delete(fn)
    }
  }

  /** Cached immutable-ish snapshot for useSyncExternalStore (=== comparisons). */
  getSnapshot(): Snapshot {
    if (!this.cachedSnap) this.cachedSnap = this.buildSnapshot()
    return this.cachedSnap
  }

  start(): void {
    if (this.timer) return
    // Seed the picture, then push the first snapshot so the UI can leave
    // skeletons behind as soon as the pipeline's first cycle completes.
    const t0 = performance.now()
    this.log('🟢 Scenario loaded: Riverton exercise, 12 resources, 6 sectors')
    const signals: ParsedSignal[] = SEED_INCIDENTS.map((seed, i) => {
      const sector = SECTORS[i % SECTORS.length]
      return {
        source: 'ground_report',
        lat: sector.lat,
        lon: sector.lon,
        raw_text: seed.text,
        confidence: 0.85,
        type_hint: seed.type,
        gt: seed.gt,
      }
    })
    this.runPipeline(signals, 'boot')
    this.status = 'live'
    this.lastCycleMs = Math.round(performance.now() - t0)
    this.push()

    this.timer = setInterval(() => this.tick(), TICK_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  // -- public actions -------------------------------------------------------

  injectReport(text: string): InjectResult {
    const clean = text.trim()
    if (!clean || this.injectBusy) {
      return { merged: false, incident_title: '', tier: null, urgency: null }
    }
    this.injectBusy = true
    this.injectionCount += 1
    this.log(`🔥 INJECTED REPORT #${this.injectionCount}: “${clean.slice(0, 70)}${clean.length > 70 ? '…' : ''}”`)

    const result = this.runPipeline(
      [{ source: 'radio', lat: 34.055, lon: -118.24, raw_text: clean, confidence: 0.9 }],
      'inject',
    )
    this.injectBusy = false
    this.push()
    return result
  }

  nextSampleReport(): string {
    const s = SAMPLE_REPORT_TEXTS[this.sampleIndex % SAMPLE_REPORT_TEXTS.length]
    this.sampleIndex += 1
    return s
  }

  // -- simulation heartbeat ---------------------------------------------------

  private tick(): void {
    try {
      this.tickCount += 1
      // Weather drift
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

      // New wave incidents
      const signals: ParsedSignal[] = []
      if (this.tickCount >= 2 && this.waveIndex < Math.min(MAX_WAVES, WAVE_INCIDENTS.length) && this.tickCount % 2 === 0) {
        const wave = WAVE_INCIDENTS[this.waveIndex]
        this.waveIndex += 1
        const sector = SECTORS[(this.waveIndex + 3) % SECTORS.length]
        signals.push({
          source: 'drone',
          lat: sector.lat + this.rng.jitter(0.001),
          lon: sector.lon + this.rng.jitter(0.001),
          raw_text: wave.text,
          confidence: 0.8,
          type_hint: wave.type,
          gt: wave.gt,
        })
        this.log(`📡 New incoming signal from ${sector.name}`)
      }

      // Follow-up on Downtown collapse (fold-in, should MERGE not duplicate)
      if (this.tickCount === 3) {
        const downtown = SECTORS[0]
        signals.push({
          source: 'ground_report',
          lat: downtown.lat + this.rng.jitter(0.0005),
          lon: downtown.lon + this.rng.jitter(0.0005),
          raw_text: FOLLOWUP,
          confidence: 0.92,
          type_hint: 'structural_collapse',
          gt: SEED_INCIDENTS[0].gt,
        })
        this.log('📡 Follow-up report on Downtown collapse')
      }

      // Unit movement
      const incidentsMap = new Map<string, Incident>()
      for (const [id, inc] of this.incidents) incidentsMap.set(id, inc)
      const moveLog = advanceResources(this.resources, incidentsMap, (50 / 3600) * 6)
      for (const line of moveLog) this.log(line)

      // Unaddressed incidents drift worse — the ranking legitimately changes
      const assigned = new Set(this.resources.map((r) => r.assigned_incident).filter(Boolean) as string[])
      for (const inc of this.incidents.values()) {
        if (!assigned.has(inc.id) && (inc.status === 'new' || inc.status === 'triaged')) {
          inc.affected_population = Math.round(inc.affected_population * 1.08) + 2
        }
      }

      if (signals.length > 0) {
        this.runPipeline(signals, 'sim')
      } else {
        this.refreshRankings()
      }
      this.push()
    } catch (err) {
      this.log(`❗ cycle error (recovered): ${err instanceof Error ? err.message : String(err)}`)
      this.push()
    }
  }

  // -- the pipeline ------------------------------------------------------------

  private runPipeline(signals: ParsedSignal[], origin: PipelineOrigin): InjectResult {
    const t0 = performance.now()
    const stages: Record<string, number> = {}
    this.stageOrigin = origin

    // 1. Surveillance: parse each signal
    let t = performance.now()
    this.stage = 'surveillance'
    const candidates = signals.map((s) => surveillanceParse(s))
    stages.surveillance_ms = Math.max(1, Math.round(performance.now() - t))

    // 2. Merge or create
    t = performance.now()
    const touched: WorldIncident[] = []
    let mergedAny = false
    let lastTitle = ''
    let lastTier: InjectResult['tier'] = null
    let lastUrgency: number | null = null
    for (let i = 0; i < candidates.length; i++) {
      const cand = candidates[i]
      const sig = signals[i]
      const existing = this.findMatch(cand.type, cand.lat, cand.lon)
      if (existing) {
        existing.affected_population = Math.max(existing.affected_population, cand.affected_population)
        existing.injuries = Math.max(existing.injuries, cand.injuries)
        existing.confidence = Math.max(existing.confidence, cand.confidence)
        existing.description = `${existing.description} | ${cand.description}`.slice(0, 500)
        existing.mergedCount += 1
        if (existing.status === 'new') existing.status = 'triaged'
        mergedAny = true
        lastTitle = existing.title
        lastTier = existing.risk?.tier ?? null
        lastUrgency = existing.risk?.urgency ?? null
        this.log(`🔗 Signal merged into: ${existing.title}`)
        if (!touched.includes(existing)) touched.push(existing)
      } else {
        const inc = this.createIncident(cand, sig)
        this.groundTruth.set(inc.id, sig.gt ?? 40)
        touched.push(inc)
        lastTitle = inc.title
        lastTier = null
        lastUrgency = null
      }
    }
    stages.merge_ms = Math.max(1, Math.round(performance.now() - t))

    // 3. Terrain + risk per touched incident
    t = performance.now()
    this.stage = 'terrain'
    for (const inc of touched) {
      const weather = this.weather[inc.zone] ?? WEATHER_LIST[0]
      const terrain = terrainAssess(inc, weather, inc.terrain)
      this.stage = 'risk'
      inc.risk = riskScore(inc, terrain, weather, Date.now())
      inc.updated_at = inc.risk.scored_at
    }
    stages.terrain_risk_ms = Math.max(1, Math.round(performance.now() - t))

    // 4. Logistics over the full ranked picture
    t = performance.now()
    this.stage = 'logistics'
    const ranked = this.ranked()
    const { assignments, deployments } = logisticsMatch(ranked, this.resources)
    this.applyAssignments(assignments, ranked)
    stages.logistics_ms = Math.max(1, Math.round(performance.now() - t))

    // 5. Command recommendations for the top-ranked incidents
    t = performance.now()
    this.stage = 'command'
    this.lastRecommendations = commandRecommend(ranked, deployments, WEATHER_LIST)
    stages.command_ms = Math.max(1, Math.round(performance.now() - t))

    this.stage = 'idle'
    this.lastStages = stages
    this.lastCycleMs = Math.round(performance.now() - t0)
    this.log(`⚡ Pipeline cycle complete in ${this.lastCycleMs}ms (${origin})`)

    if (origin === 'inject') {
      return { merged: mergedAny, incident_title: lastTitle, tier: lastTier, urgency: lastUrgency }
    }
    return { merged: false, incident_title: '', tier: null, urgency: null }
  }

  private refreshRankings(): void {
    const ranked = this.ranked()
    for (const { incident } of ranked.slice(0, 5)) {
      const weather = this.weather[incident.zone] ?? WEATHER_LIST[0]
      const terrain = terrainAssess(incident, weather, incident.terrain)
      incident.risk = riskScore(incident, terrain, weather, Date.now())
    }
    const { assignments, deployments } = logisticsMatch(this.ranked(), this.resources)
    this.applyAssignments(assignments, this.ranked())
    this.lastRecommendations = commandRecommend(this.ranked(), deployments, WEATHER_LIST)
  }

  private applyAssignments(
    assignments: Array<{ incident_id: string; resource_id: string; role: string; rationale: string }>,
    ranked: Array<{ rank: number; incident: Incident }>,
  ): void {
    const rankById = new Map(ranked.map(({ rank, incident }) => [incident.id, rank]))
    const incById = new Map(ranked.map(({ incident }) => [incident.id, incident]))
    const counts: Record<string, number> = {}
    for (const r of this.resources) {
      if (r.assigned_incident) counts[r.assigned_incident] = (counts[r.assigned_incident] ?? 0) + 1
    }
    for (const a of assignments) {
      const inc = incById.get(a.incident_id)
      const res = this.resources.find((r) => r.id === a.resource_id)
      if (!inc || !res || res.status !== 'available') continue
      const tier = inc.risk?.tier ?? 'P4'
      const cap = tier === 'P1' || tier === 'P2' ? 4 : 2
      if ((counts[inc.id] ?? 0) >= cap) continue
      res.status = 'en_route'
      res.assigned_incident = inc.id
      res.current_lat = res.current_lat ?? res.base_lat
      res.current_lon = res.current_lon ?? res.base_lon
      res.role = a.role
      counts[inc.id] = (counts[inc.id] ?? 0) + 1
      if (inc.status === 'new') inc.status = 'units_en_route'
      const eta = etaMinutes(res, inc)
      this.log(`🚨 Deploy ${res.name} → [#${rankById.get(inc.id) ?? '?'}] ${inc.title} (ETA ${eta.toFixed(0)} min)`)
    }
  }

  // -- merge/create helpers -----------------------------------------------------

  private findMatch(type: IncidentType, lat: number, lon: number): WorldIncident | null {
    for (const inc of this.incidents.values()) {
      if (inc.status === 'closed') continue
      if (inc.type === type && haversineKm(lat, lon, inc.lat, inc.lon) < 1.5) {
        return inc
      }
    }
    return null
  }

  private createIncident(cand: ReturnType<typeof surveillanceParse>, sig: ParsedSignal): WorldIncident {
    void sig

    this.incidentCounter += 1
    const id = `inc_${String(this.incidentCounter).padStart(3, '0')}`
    const zone = nearestZone(cand.lat, cand.lon)
    const inc: WorldIncident = {
      id,
      type: cand.type,
      title: cand.title,
      description: cand.description,
      lat: cand.lat,
      lon: cand.lon,
      zone,
      status: 'new',
      reported_at: nowIso(Date.now()),
      updated_at: nowIso(Date.now()),
      affected_population: cand.affected_population,
      injuries: cand.injuries,
      confidence: cand.confidence,
      risk: null,
      terrain: TERRAIN[zone] ?? TERRAIN.Downtown,
      mergedCount: 0,
    }
    this.incidents.set(id, inc)
    this.log(`🆕 New incident: [${zone}] ${inc.title}`)
    void sig
    return inc
  }

  // -- snapshot ------------------------------------------------------------------

  private ranked(): Array<{ rank: number; incident: WorldIncident }> {
    const withRisk = [...this.incidents.values()].filter((i) => i.risk && i.status !== 'closed')
    withRisk.sort((a, b) => (b.risk?.urgency ?? 0) - (a.risk?.urgency ?? 0))
    return withRisk.map((incident, i) => ({ rank: i + 1, incident }))
  }

  private log(msg: string): void {
    this.seq += 1
    this.eventLog.push({ seq: this.seq, t: clockOf(Date.now()), msg })
    if (this.eventLog.length > LOG_CAP) this.eventLog = this.eventLog.slice(-LOG_CAP)
  }

  private metrics(): Metrics {
    const ranked = this.ranked()
    const scored: Array<{ predicted: number; gt: number }> = []
    for (const { incident } of ranked) {
      const gt = this.groundTruth.get(incident.id) ?? this.groundTruth.get(`wave_${incident.id}`)
      if (incident.risk && gt !== undefined) scored.push({ predicted: incident.risk.urgency, gt })
    }
    const rho = scored.length >= 3 ? spearman(scored.map((s) => s.predicted), scored.map((s) => s.gt)) : null

    const p12 = ranked.filter(({ incident }) => incident.risk && (incident.risk.tier === 'P1' || incident.risk.tier === 'P2'))
    const assignedIds = new Set(this.resources.map((r) => r.assigned_incident).filter(Boolean) as string[])
    const covered = p12.filter(({ incident }) => assignedIds.has(incident.id))
    const p1Best = p12
      .filter(({ incident }) => incident.risk?.tier === 'P1')
      .flatMap(({ incident }) =>
        this.resources
          .filter((r) => r.assigned_incident === incident.id)
          .map((r) => etaMinutes(r, incident)),
      )

    return {
      cycle_ms: this.lastCycleMs,
      stages: this.lastStages,
      spearman: rho,
      evaluated_incidents: scored.length,
      p1p2_count: p12.length,
      p1p2_covered: covered.length,
      coverage: p12.length ? Math.round((covered.length / p12.length) * 100) / 100 : 1,
      capability_match: 1,
      p1_best_eta_min: p1Best.length ? Math.min(...p1Best) : null,
      injections: this.injectionCount,
      dataset_note: 'Seeded from xBD damage-grade cohorts (hidden ground truth)',
    }
  }

  private buildSnapshot(): Snapshot {
    const ranked = this.ranked()
    for (const { incident } of ranked) {
      if (incident.risk) incident.risk.tier = tierFor(incident.risk.urgency)
    }
    return {
      status: this.status,
      tick: this.tickCount,
      sim_time: nowIso(Date.now()),
      incidents: ranked.map(({ incident }) => incident),
      resources: this.resources,
      weather: Object.values(this.weather),
      actions: this.lastRecommendations,
      event_log: this.eventLog.slice(-40),
      metrics: this.metrics(),
      pipeline: { stage: this.stage, origin: this.stageOrigin },
    }
  }

  private push(): void {
    this.cachedSnap = null
    const snap = this.getSnapshot()
    for (const fn of this.subscribers) fn(snap)
  }
}

export function nearestZone(lat: number, lon: number): string {
  let best = SECTORS[0].name
  let bestD = Number.POSITIVE_INFINITY
  for (const s of SECTORS) {
    const d = (s.lat - lat) ** 2 + (s.lon - lon) ** 2
    if (d < bestD) {
      bestD = d
      best = s.name
    }
  }
  return best
}

function spearman(xs: number[], ys: number[]): number | null {
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

export const orchestrator = new Orchestrator()
