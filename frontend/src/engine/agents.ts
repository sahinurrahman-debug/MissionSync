// The five MissionSync agents, ported to the browser as their deterministic
// rule-based twins (the same logic the Level-1 backend used when the LLM was
// unavailable). Kenshi is frontend-only, so these twins ARE the pipeline —
// and because they're real code, ranking, merging, and matching genuinely
// happen rather than being faked for the demo.

import type {
  Deployment,
  Incident,
  IncidentType,
  RecommendedAction,
  Resource,
  ResourceStatus,
  RiskBreakdown,
  RiskScore,
  TerrainCell,
  Tier,
  WeatherCell,
} from '../types'
import { clamp100, haversineKm, round1 } from './geo'

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

export function requiredFor(type: IncidentType): string[] {
  switch (type) {
    case 'fire': return ['fire_unit']
    case 'flood': return ['swift_water', 'rescue_team']
    case 'structural_collapse': return ['rescue_team', 'ambulance']
    case 'medical': return ['ambulance']
    case 'hazmat': return ['hazmat_unit', 'fire_unit']
    case 'landslide': return ['rescue_team', 'engineering']
    case 'missing_persons': return ['drone', 'rescue_team']
    case 'roadside_casualties': return ['ambulance', 'fire_unit']
    default: return ['rescue_team']
  }
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

const KEYWORD_TYPES: Array<[string, IncidentType]> = [
  ['fire', 'fire'], ['smoke', 'fire'], ['burning', 'fire'], ['blaze', 'fire'],
  ['flood', 'flood'], ['drowning', 'flood'], ['levee', 'flood'], ['rising water', 'flood'],
  ['collapse', 'structural_collapse'], ['rubble', 'structural_collapse'], ['trapped', 'structural_collapse'],
  ['chemical', 'hazmat'], ['hazmat', 'hazmat'], ['spill', 'hazmat'], ['ammonia', 'hazmat'], ['leak', 'hazmat'],
  ['landslide', 'landslide'], ['mudslide', 'landslide'],
  ['missing', 'missing_persons'],
  ['crash', 'roadside_casualties'], ['pileup', 'roadside_casualties'],
]

const INCIDENT_TYPES: readonly string[] = [
  'fire', 'flood', 'structural_collapse', 'medical', 'hazmat',
  'landslide', 'missing_persons', 'roadside_casualties',
]

const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, several: 4, multiple: 4,
}

const INJURY_RE =
  /(\d+|one|two|three|four|five|six|seven|eight|nine|ten|several|multiple)\s+(injur\w*|trapped|dead|killed|casualt\w*|missing|hurt|unconscious|victims)/i
const POPULATION_RE =
  /(\d+|one|two|three|four|five|six|seven|eight|nine|ten|several|multiple)\s+(people|persons|workers|residents|students|employees|families|elderly|passengers)/i

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
  zone: string
  affected_population: number
  injuries: number
  confidence: number
}

export interface ParsedSignal {
  source: string
  lat: number
  lon: number
  raw_text: string
  confidence: number
  type_hint?: string
  /** Hidden ground-truth urgency (evaluation only, never shown to scoring). */
  gt?: number
}

export function surveillanceParse(signal: ParsedSignal): ParsedCandidate {
  const text = String(signal.raw_text ?? '')
  const low = text.toLowerCase()

  let type: IncidentType
  const hint = signal.type_hint
  if (hint && INCIDENT_TYPES.includes(hint)) {
    type = hint as IncidentType
  } else {
    type = KEYWORD_TYPES.find(([kw]) => low.includes(kw))?.[1] ?? 'medical'
  }

  const injuryMatch = low.match(INJURY_RE)
  const popMatch = low.match(POPULATION_RE)
  const injuries = injuryMatch ? countFrom(injuryMatch) : (DEFAULT_INJURIES[type] ?? 0)
  const population = popMatch ? countFrom(popMatch) : DEFAULT_POPULATION[type]

  const title = (text.length > 60 ? `${text.slice(0, 57)}…` : text).replace(/^\w/, (c) => c.toUpperCase())

  return {
    type,
    title: title || 'Unverified signal',
    description: text.slice(0, 300),
    lat: signal.lat,
    lon: signal.lon,
    zone: '',
    affected_population: population,
    injuries,
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

  return {
    access_difficulty: clamp100(access),
    escalation_risk: clamp100(escalation),
    hazards,
  }
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
    scoring_latency_ms: 1 + Math.round(Math.random() * 2),
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
// 4. Logistics — greedy nearest-capable matcher with per-incident caps
// ---------------------------------------------------------------------------

export interface Assignment {
  incident_id: string
  resource_id: string
  role: string
  rationale: string
}

const CAP_FOR_TIER = (tier: Tier): number => (tier === 'P1' || tier === 'P2' ? 4 : 2)

export function logisticsMatch(
  ranked: Array<{ rank: number; incident: Incident }>,
  resources: Resource[],
): { assignments: Assignment[]; deployments: Deployment[] } {
  const used = new Set<string>()
  const assignedCounts: Record<string, number> = {}
  for (const r of resources) {
    if (r.assigned_incident) {
      assignedCounts[r.assigned_incident] = (assignedCounts[r.assigned_incident] ?? 0) + 1
    }
  }

  const assignments: Assignment[] = []
  const deployments: Deployment[] = []

  for (const { rank, incident } of ranked) {
    if (incident.status === 'closed' || incident.status === 'contained') continue
    const required = requiredFor(incident.type)
    const cap = CAP_FOR_TIER(incident.risk?.tier ?? 'P4')
    if ((assignedCounts[incident.id] ?? 0) >= cap) continue

    const free = resources.filter((r) => !used.has(r.id) && r.status !== 'on_scene')
    let candidates = free.filter((r) => required.includes(r.type))
    if (candidates.length === 0) candidates = free.filter((r) => r.type === 'drone')
    if (candidates.length === 0) continue

    const best = candidates.reduce((a, b) =>
      haversineKm(a.current_lat ?? a.base_lat, a.current_lon ?? a.base_lon, incident.lat, incident.lon) <
      haversineKm(b.current_lat ?? b.base_lat, b.current_lon ?? b.base_lon, incident.lat, incident.lon)
        ? a : b)

    used.add(best.id)
    assignedCounts[incident.id] = (assignedCounts[incident.id] ?? 0) + 1
    const role = roleFor(best, incident)
    assignments.push({
      incident_id: incident.id,
      resource_id: best.id,
      role,
      rationale: `Nearest capable ${best.type.replace('_', ' ')} (rank #${rank})`,
    })
    deployments.push({
      id: `dep_${best.id}_${incident.id}`,
      incident_id: incident.id,
      incident_title: incident.title,
      resource_id: best.id,
      resource_name: best.name,
      resource_type: best.type,
      eta_minutes: etaMinutes(best, incident),
      role,
      priority: rank,
      rationale: 'Capability + proximity match',
    })
  }

  return { assignments, deployments }
}

function roleFor(resource: Resource, incident: Incident): string {
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

// ---------------------------------------------------------------------------
// 5. Command — operational recommendation cards for the top incidents
// ---------------------------------------------------------------------------

export function commandRecommend(
  ranked: Array<{ rank: number; incident: Incident }>,
  deployments: Deployment[],
  weather: WeatherCell[],
): RecommendedAction[] {
  const recs: RecommendedAction[] = []

  for (const { rank, incident } of ranked.slice(0, 4)) {
    const tier = incident.risk?.tier ?? 'P4'
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
    } else if (incident.type === 'structural_collapse') {
      details.push('Mark collapse zones; shoring before interior search')
      details.push('Rely on canine/acoustic search before heavy equipment')
    } else if (incident.type === 'hazmat') {
      details.push('Upwind staging; identify plume direction before approach')
      details.push('Decon corridor before crew rotation')
    } else {
      details.push('Confirm scene size-up via nearest drone feed')
      details.push('Stage resources at safe approach point')
    }
    details.push('Establish incident command perimeter')

    if (deps.length === 0) warnings.push('No units assigned yet — coverage gap at this priority')
    if (incident.status === 'units_en_route' || incident.status === 'on_scene') {
      const eta = deps.length > 0 ? Math.min(...deps.map((d) => d.eta_minutes)) : null
      if (eta !== null) details.push(`First unit ETA ~${Math.round(eta)} min`)
    }

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
  switch (incident.type) {
    case 'fire': return `Commit engines to ${incident.zone} fire — attack from the east`
    case 'flood': return `Push boat crew to ${incident.zone} flooding; clear the marina`
    case 'structural_collapse': return `Start search & extrication at ${incident.zone} collapse`
    case 'hazmat': return `Contain plume at ${incident.zone}; upwind approach only`
    case 'landslide': return `Open access route into ${incident.zone} before extraction`
    case 'missing_persons': return `Sweep ${incident.zone} grid with drone + ground team`
    case 'roadside_casualties': return `Triage and extricate at ${incident.zone} crash site`
    default: return `Respond to ${incident.zone} incident`
  }
}

// ---------------------------------------------------------------------------
// Resource movement (orchestrator helper, lives here for cohesion)
// ---------------------------------------------------------------------------

export function advanceResources(resources: Resource[], incidents: Map<string, Incident>, stepKm: number): string[] {
  const log: string[] = []
  for (const r of resources) {
    if (r.status !== 'en_route' || !r.assigned_incident) continue
    const incident = incidents.get(r.assigned_incident)
    if (!incident) continue
    const fromLat = r.current_lat ?? r.base_lat
    const fromLon = r.current_lon ?? r.base_lon
    const dist = haversineKm(fromLat, fromLon, incident.lat, incident.lon)
    if (dist <= Math.max(stepKm, 0.15)) {
      r.current_lat = incident.lat
      r.current_lon = incident.lon
      r.status = 'on_scene' satisfies ResourceStatus
      incident.status = 'on_scene'
      log.push(`✅ ${r.name} on scene at ${incident.title}`)
    } else {
      const frac = stepKm / Math.max(dist, 1e-6)
      r.current_lat = fromLat + (incident.lat - fromLat) * frac
      r.current_lon = fromLon + (incident.lon - fromLon) * frac
    }
  }
  return log
}
