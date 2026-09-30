// The five MissionSync agents as deterministic, rule-based twins of the backend
// agents (backend/missionsync/agents.py). They power the in-browser DEMO engine
// only; with a backend the real LLM agents run server-side.

import type {
  Deployment,
  Incident,
  IncidentType,
  RecommendedAction,
  Resource,
  RiskBreakdown,
  RiskScore,
  TerrainCell,
  Tier,
  WeatherCell,
} from '../types'
import { clamp100, haversineKm, round1 } from './geo'

// ---------------------------------------------------------------------------
// Capability matrix (mirrors REQUIRED_TYPES in agents.py)
// ---------------------------------------------------------------------------

export function requiredFor(type: IncidentType): string[] {
  switch (type) {
    case 'fire': return ['fire_unit']
    case 'flood': return ['swift_water', 'rescue_team']
    case 'structural_collapse': return ['rescue_team', 'ambulance', 'engineering']
    case 'medical': return ['ambulance']
    case 'hazmat': return ['hazmat_unit', 'fire_unit']
    case 'landslide': return ['rescue_team', 'engineering']
    case 'missing_persons': return ['drone', 'rescue_team']
    case 'roadside_casualties': return ['ambulance', 'fire_unit']
    default: return ['rescue_team']
  }
}

/** Capable = in the capability matrix, or a drone (universal recon). */
export function isCapable(resource: Resource, incident: Incident): boolean {
  return requiredFor(incident.type).includes(resource.type) || resource.type === 'drone'
}

export const TARGET_CREW: Record<Tier, number> = { P1: 3, P2: 2, P3: 1, P4: 1 }
export const CREW_CAP: Record<Tier, number> = { P1: 4, P2: 4, P3: 2, P4: 2 }

export function tierOf(incident: Incident): Tier {
  return incident.risk?.tier ?? 'P4'
}

export function etaMinutes(resource: Resource, incident: Incident): number {
  const dist = haversineKm(
    resource.current_lat ?? resource.base_lat,
    resource.current_lon ?? resource.base_lon,
    incident.lat,
    incident.lon,
  )
  return round1((dist / Math.max(resource.speed_kph, 1.0)) * 60.0)
}

export function tierFor(urgency: number): Tier {
  if (urgency >= 75) return 'P1'
  if (urgency >= 55) return 'P2'
  if (urgency >= 35) return 'P3'
  return 'P4'
}

// ---------------------------------------------------------------------------
// 1. Surveillance — parse a raw signal into a structured incident candidate
// ---------------------------------------------------------------------------

// The EARLIEST mention wins, so "Missing child near the levee" is a missing-person
// case, not a flood. Weak cues count only when no strong cue appears anywhere.
const STRONG_KEYWORDS: Array<[string, IncidentType]> = [
  ['fire', 'fire'], ['smoke', 'fire'], ['burning', 'fire'], ['blaze', 'fire'],
  ['flood', 'flood'], ['drowning', 'flood'], ['levee', 'flood'], ['rising water', 'flood'], ['swept away', 'flood'],
  ['collapse', 'structural_collapse'], ['rubble', 'structural_collapse'],
  ['chemical', 'hazmat'], ['hazmat', 'hazmat'], ['spill', 'hazmat'], ['ammonia', 'hazmat'], ['leak', 'hazmat'],
  ['gas smell', 'hazmat'], ['toxic', 'hazmat'], ['fumes', 'hazmat'],
  ['landslide', 'landslide'], ['mudslide', 'landslide'], ['rockslide', 'landslide'],
  ['missing', 'missing_persons'], ['lost child', 'missing_persons'],
  ['crash', 'roadside_casualties'], ['pileup', 'roadside_casualties'], ['collision', 'roadside_casualties'], ['overturned', 'roadside_casualties'],
]
const WEAK_KEYWORDS: Array<[string, IncidentType]> = [
  ['trapped', 'structural_collapse'],
  ['unconscious', 'medical'], ['cardiac', 'medical'], ['heart attack', 'medical'], ['seizure', 'medical'],
  ['injur', 'medical'], ['medical', 'medical'], ['not breathing', 'medical'],
]

export function classifyText(text: string): IncidentType | null {
  const low = text.toLowerCase()
  for (const list of [STRONG_KEYWORDS, WEAK_KEYWORDS]) {
    let best: { pos: number; type: IncidentType } | null = null
    for (const [kw, type] of list) {
      const pos = low.indexOf(kw)
      if (pos !== -1 && (best === null || pos < best.pos)) best = { pos, type }
    }
    if (best) return best.type
  }
  return null
}

const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  several: 4, multiple: 4, dozen: 24, dozens: 24,
}
const NUM = '(\\d+|one|two|three|four|five|six|seven|eight|nine|ten|several|multiple|dozens?)'
const INJURY_RE = new RegExp(
  `${NUM}\\s+(?:more\\s+)?(?:\\w+\\s+)?(injur\\w*|trapped|dead|killed|casualt\\w*|missing|hurt|unconscious|victims|coughing|down)\\b`,
  'i',
)
const POPULATION_RE = new RegExp(
  `${NUM}\\s+(?:more\\s+)?(?:\\w+\\s+)?(people|person|persons|workers|residents|students|employees|families|elderly|passengers|occupants|kayakers|children|kids)`,
  'i',
)

const DEFAULT_POPULATION: Record<IncidentType, number> = {
  fire: 40, flood: 100, structural_collapse: 15, hazmat: 80,
  medical: 30, missing_persons: 1, landslide: 5, roadside_casualties: 12,
}
const DEFAULT_INJURIES: Partial<Record<IncidentType, number>> = {
  structural_collapse: 4, hazmat: 2, flood: 2, roadside_casualties: 3, medical: 1,
}

function countFrom(match: RegExpMatchArray): number {
  const token = match[1].toLowerCase()
  return /^\d+$/.test(token) ? parseInt(token, 10) : (WORD_NUMBERS[token] ?? 1)
}

export interface ParsedCandidate {
  type: IncidentType
  title: string
  description: string
  lat: number
  lon: number
  affected_population: number
  injuries: number
  /** true when the text itself states numbers (vs. type defaults). */
  counts_reported: boolean
  confidence: number
}

export interface ParsedSignal {
  source: string
  lat: number
  lon: number
  raw_text: string
  confidence: number
  /** false ⇒ the report named no place (pinned to the city centre). */
  located?: boolean
  type_hint?: string
  /** Hidden ground-truth urgency (evaluation only, never used for scoring). */
  gt?: number
}

function headline(text: string, limit = 70): string {
  const t = text.replace(/\s+/g, ' ').trim()
  const cut = t.length > limit ? `${t.slice(0, limit - 1).trimEnd()}…` : t
  return cut.charAt(0).toUpperCase() + cut.slice(1)
}

/** Returns null when the text describes no emergency. */
export function surveillanceParse(signal: ParsedSignal): ParsedCandidate | null {
  const text = String(signal.raw_text ?? '')
  const type = (signal.type_hint as IncidentType | undefined) ?? classifyText(text)
  if (!type) return null

  const injuryMatch = text.match(INJURY_RE)
  const popMatch = text.match(POPULATION_RE)
  const injuries = injuryMatch ? countFrom(injuryMatch) : (DEFAULT_INJURIES[type] ?? 0)
  let population = popMatch ? countFrom(popMatch) : DEFAULT_POPULATION[type]
  if (injuryMatch && !popMatch) population = Math.max(injuries, 1)

  return {
    type,
    title: headline(text) || 'Unverified signal',
    description: text.slice(0, 300),
    lat: signal.lat,
    lon: signal.lon,
    affected_population: population,
    injuries,
    counts_reported: Boolean(injuryMatch || popMatch),
    confidence: signal.confidence,
  }
}

// ---------------------------------------------------------------------------
// 2. Terrain — access difficulty + escalation risk from zone layers
// ---------------------------------------------------------------------------

export interface TerrainAssessment {
  access_difficulty: number
  escalation_risk: number
  hazards: string[]
}

export function terrainAssess(incident: Incident, weather: WeatherCell, terrain: TerrainCell): TerrainAssessment {
  let access = ({ good: 20, degraded: 55, blocked: 85 }[terrain.road_access] ?? 40)
  access += Math.min(Math.round(terrain.slope_deg * 1.5), 15)
  let escalation = 30
  if (incident.type === 'fire') escalation += Math.min(Math.round(weather.wind_kph * 2), 40)
  if (incident.type === 'flood') escalation += Math.min(Math.round(weather.precipitation_mm_h * 3), 40)
  if (incident.type === 'landslide') escalation += Math.min(Math.round(weather.precipitation_mm_h * 2), 30)

  const hazards: string[] = []
  if (terrain.road_access === 'blocked') hazards.push('road access blocked — plan alternate route')
  if (weather.wind_kph > 30) hazards.push('high wind — aerial ops limited')
  if (weather.precipitation_mm_h > 10) hazards.push('heavy rain — flash flood watch')

  return { access_difficulty: clamp100(access), escalation_risk: clamp100(escalation), hazards }
}

// ---------------------------------------------------------------------------
// 3. Risk — transparent 0–100 components → weighted composite → tier
// ---------------------------------------------------------------------------

export const WEIGHTS = { severity: 0.35, population: 0.25, spread: 0.2, time_criticality: 0.2 } as const

const TYPE_SEVERITY: Record<IncidentType, number> = {
  fire: 78, hazmat: 82, structural_collapse: 90, flood: 70,
  landslide: 65, medical: 48, missing_persons: 55, roadside_casualties: 62,
}

export function riskScore(
  incident: Incident,
  terrain: TerrainAssessment,
  weather: WeatherCell,
  now: number,
): RiskScore {
  const desc = `${incident.description} ${incident.title}`.toLowerCase()
  const trappedBonus = desc.includes('trapped') ? 15 : 0

  const severity = clamp100(TYPE_SEVERITY[incident.type] + (trappedBonus ? 5 : 0))
  const population = clamp100(Math.sqrt(Math.max(incident.affected_population, 1)) * 10)
  const spread = clamp100(20 + 0.6 * terrain.escalation_risk)
  let timeCriticality = 55
  if (incident.injuries > 2) timeCriticality += 10
  timeCriticality += trappedBonus
  if (terrain.access_difficulty > 60) timeCriticality += 10
  if (weather.alert) timeCriticality += 5

  const breakdown: RiskBreakdown = {
    severity: round1(severity),
    population: round1(population),
    spread: round1(spread),
    time_criticality: clamp100(timeCriticality),
    confidence: Math.round(incident.confidence * 100),
    rationale: buildRationale(incident, terrain, trappedBonus > 0),
  }

  const urgency = round1(
    breakdown.severity * WEIGHTS.severity +
    breakdown.population * WEIGHTS.population +
    breakdown.spread * WEIGHTS.spread +
    breakdown.time_criticality * WEIGHTS.time_criticality,
  )

  return {
    incident_id: incident.id,
    urgency,
    breakdown,
    tier: tierFor(urgency),
    scored_at: new Date(now).toISOString(),
    scoring_latency_ms: 0,
    source: 'rules',
  }
}

function buildRationale(incident: Incident, terrain: TerrainAssessment, trapped: boolean): string {
  const parts: string[] = []
  if (incident.injuries > 0) parts.push(`${incident.injuries} injured`)
  if (trapped) parts.push('persons trapped')
  if (incident.affected_population >= 40) parts.push(`~${incident.affected_population} in impact zone`)
  if (terrain.access_difficulty >= 55) parts.push('degraded access slows response')
  if (terrain.escalation_risk >= 60) parts.push('escalation likely within the hour')
  if (parts.length === 0) parts.push('contained scope, routine response window')
  return parts.join('; ')
}

// ---------------------------------------------------------------------------
// 4. Logistics — greedy nearest-capable matcher, crew sized by tier
// ---------------------------------------------------------------------------

export interface Assignment {
  incident_id: string
  resource_id: string
  role: string
  rationale: string
}

export function roleFor(resource: Resource, incident: Incident): string {
  switch (resource.type) {
    case 'fire_unit': return incident.type === 'fire' ? 'primary suppression' : 'support & extinguish'
    case 'ambulance': return 'triage & evac'
    case 'rescue_team': return incident.type === 'structural_collapse' ? 'search & extrication' : 'search & rescue'
    case 'swift_water': return 'boat rescue'
    case 'engineering': return 'shoring & access'
    case 'drone': return 'recon & size-up'
    case 'hazmat_unit': return 'containment & decon'
    default: return 'assigned'
  }
}

const dist = (r: Resource, inc: Incident): number =>
  haversineKm(r.current_lat ?? r.base_lat, r.current_lon ?? r.base_lon, inc.lat, inc.lon)

/**
 * P1 gets the best pick, then P2, … up to each incident's target crew. Only
 * AVAILABLE units are candidates (a unit already en route elsewhere is not free).
 */
export function logisticsMatch(
  ranked: Array<{ rank: number; incident: Incident }>,
  resources: Resource[],
  assignedCounts: Record<string, number>,
  rejected: ReadonlySet<string> = new Set(),   // "incidentId:resourceId" pairs a human turned down
): Assignment[] {
  const used = new Set<string>()
  const counts = { ...assignedCounts }
  const out: Assignment[] = []

  for (const { rank, incident } of ranked) {
    const tier = tierOf(incident)
    const need = Math.max(0, TARGET_CREW[tier] - (counts[incident.id] ?? 0))
    for (let n = 0; n < need; n++) {
      const free = resources.filter((r) => r.status === 'available' && !used.has(r.id) && !rejected.has(`${incident.id}:${r.id}`))
      let candidates = free.filter((r) => requiredFor(incident.type).includes(r.type))
      if (candidates.length === 0) candidates = free.filter((r) => r.type === 'drone')
      if (candidates.length === 0) break
      const best = candidates.reduce((a, b) => (dist(a, incident) <= dist(b, incident) ? a : b))
      used.add(best.id)
      counts[incident.id] = (counts[incident.id] ?? 0) + 1
      out.push({
        incident_id: incident.id,
        resource_id: best.id,
        role: roleFor(best, incident),
        rationale: `Nearest capable unit (rank #${rank})`,
      })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// 5. Command — operational recommendation cards from the REAL deployments
// ---------------------------------------------------------------------------

export function commandRecommend(
  ranked: Array<{ rank: number; incident: Incident }>,
  deployments: Deployment[],
  weather: WeatherCell[],
): RecommendedAction[] {
  const recs: RecommendedAction[] = []

  for (const { rank, incident } of ranked.slice(0, 4)) {
    const tier = tierOf(incident)
    const deps = deployments.filter((d) => d.incident_id === incident.id)
    const details: string[] = []
    const warnings: string[] = []

    const zoneWeather = weather.find((w) => w.zone === incident.zone)
    if (incident.type === 'fire') {
      details.push('Attack from upslope/upwind side; establish anchor point')
      if (zoneWeather && zoneWeather.wind_kph > 30) warnings.push(`Wind ${Math.round(zoneWeather.wind_kph)} kph — spot fires likely, aerial ops limited`)
    } else if (incident.type === 'flood') {
      details.push('Boat-based rescue only; no wading in moving water')
      details.push('Stage swift-water team upstream of debris line')
      if (zoneWeather?.alert === 'flood_watch') warnings.push('Flood watch in effect — river still rising')
    } else if (incident.type === 'structural_collapse') {
      details.push('Mark collapse zones; shoring before interior search')
      details.push('Rely on canine/acoustic search before heavy equipment')
    } else if (incident.type === 'hazmat') {
      details.push('Upwind staging; identify plume direction before approach')
      details.push('Decon corridor before crew rotation')
    } else if (incident.type === 'landslide') {
      details.push('Assess slope stability before committing crews')
    } else {
      details.push('Confirm scene size-up via nearest drone feed')
      details.push('Stage resources at safe approach point')
    }
    details.push('Establish incident command perimeter')

    if (deps.length === 0) warnings.push('No units deployed yet — coverage gap at this priority')
    else details.push(`First unit ETA ~${Math.round(Math.min(...deps.map((d) => d.eta_minutes)))} min`)

    recs.push({
      incident_id: incident.id,
      incident_title: incident.title,
      priority: rank,
      urgency: incident.risk?.urgency ?? 0,
      headline: `[${tier}] ${commandHeadline(incident)}`,
      details,
      warnings,
      deployments: deps,
    })
  }

  return recs
}

function commandHeadline(incident: Incident): string {
  const zone = incident.zone || 'scene'
  switch (incident.type) {
    case 'fire': return `Commit engines to the ${zone} fire — attack from the upwind side`
    case 'flood': return `Push boat crews into ${zone} flooding; clear the low ground`
    case 'structural_collapse': return `Start search & extrication at the ${zone} collapse`
    case 'hazmat': return `Contain the ${zone} release; upwind approach only`
    case 'landslide': return `Open an access route into ${zone} before extraction`
    case 'missing_persons': return `Sweep the ${zone} grid with drone + ground team`
    case 'roadside_casualties': return `Triage and extricate at the ${zone} crash site`
    default: return `Respond to the ${zone} incident`
  }
}
