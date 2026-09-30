// MissionSync shared types.
// The dashboard renders one `Snapshot` shape no matter where it comes from:
//   - RemoteEngine: the FastAPI backend (agents on Groq, real xBD data), mapped
//     from its WorldSnapshot in api/mapping.ts
//   - LocalEngine:  the in-browser demo engine (rule-based twins), used only when
//     no backend is configured or reachable — and always labelled as such.

export type IncidentType =
  | 'fire'
  | 'flood'
  | 'structural_collapse'
  | 'medical'
  | 'hazmat'
  | 'landslide'
  | 'missing_persons'
  | 'roadside_casualties'

export type Tier = 'P1' | 'P2' | 'P3' | 'P4'

export type IncidentStatus =
  | 'new'
  | 'triaged'
  | 'units_en_route'
  | 'on_scene'
  | 'contained'
  | 'closed'

export type ResourceType =
  | 'fire_unit'
  | 'ambulance'
  | 'rescue_team'
  | 'swift_water'
  | 'engineering'
  | 'drone'
  | 'hazmat_unit'

export type ResourceStatus = 'available' | 'en_route' | 'on_scene' | 'returning'

export type SignalSource = 'drone' | 'ground_report' | 'radio' | 'sensor' | 'social'

export interface RiskBreakdown {
  severity: number
  population: number
  spread: number
  time_criticality: number
  confidence: number
  rationale: string
}

export interface RiskScore {
  incident_id: string
  urgency: number
  breakdown: RiskBreakdown
  tier: Tier
  scored_at: string
  scoring_latency_ms: number
  /** Where the four components came from. */
  source: 'llm' | 'cached' | 'rules'
}

export interface Incident {
  id: string
  type: IncidentType
  title: string
  description: string
  lat: number
  lon: number
  zone: string
  status: IncidentStatus
  reported_at: string
  updated_at: string
  affected_population: number
  injuries: number
  confidence: number
  risk: RiskScore | null
  /** false ⇒ the report named no place; pinned to the city centre. */
  location_known: boolean
}

export interface TerrainCell {
  zone: string
  elevation_m: number
  slope_deg: number
  landcover: string
  road_access: 'good' | 'degraded' | 'blocked'
  notes: string
}

export interface WeatherCell {
  zone: string
  wind_kph: number
  wind_direction_deg: number
  precipitation_mm_h: number
  temperature_c: number
  alert: string | null
  forecast_note: string
}

export interface Resource {
  id: string
  type: ResourceType
  name: string
  base_lat: number
  base_lon: number
  current_lat: number | null
  current_lon: number | null
  personnel: number
  capacity_note: string
  status: ResourceStatus
  assigned_incident: string | null
  role: string
  speed_kph: number
}

export interface Deployment {
  id: string
  incident_id: string
  incident_title: string
  resource_id: string
  resource_name: string
  resource_type: ResourceType
  eta_minutes: number
  role: string
  priority: number
  rationale: string
}

export interface RecommendedAction {
  incident_id: string
  incident_title: string
  priority: number
  urgency: number
  headline: string
  details: string[]
  warnings: string[]
  deployments: Deployment[]
}

export interface EventLine {
  seq: number
  t: string
  msg: string
}

/** How the agents are running: real LLM, rule-based twins, out of quota, or the browser demo. */
export type EngineMode = 'llm' | 'fallback' | 'quota_exhausted' | 'demo'

export interface Metrics {
  cycle_ms: number
  stages: Record<string, number>
  spearman: number | null
  evaluated_incidents: number
  p1p2_count: number
  p1p2_covered: number
  coverage: number
  capability_match: number
  p1_best_eta_min: number | null
  injections: number
  resolved: number
  dataset_note: string
  mode: EngineMode
  model: string | null
  llm_success_rate: number | null
  /** Seconds until the Groq daily quota returns (only when mode = quota_exhausted). */
  quota_retry_s: number | null
  scoring_sources: Record<string, number>
  /** Stored drill id, when the backend has a database. */
  drill_id: number | null
  /** 'postgresql' | 'sqlite' | 'disabled' | 'error' */
  database: string
}

export type PipelineStage = 'idle' | 'surveillance' | 'terrain' | 'risk' | 'logistics' | 'command'
export type PipelineOrigin = 'boot' | 'sim' | 'inject' | 'reset'

export type Connection = 'connecting' | 'online' | 'offline' | 'demo'

export interface Snapshot {
  status: 'booting' | 'live'
  connection: Connection
  engine: 'remote' | 'local'
  tick: number
  sim_time: string
  incidents: Incident[]
  resources: Resource[]
  weather: WeatherCell[]
  actions: RecommendedAction[]
  event_log: EventLine[]
  metrics: Metrics
  pipeline: { stage: PipelineStage; origin: PipelineOrigin }
}

export interface InjectResult {
  kind: 'created' | 'merged' | 'rejected'
  incident_title: string
  tier: Tier | null
  urgency: number | null
  message: string
}

/** A failure from the backend, in the standard error envelope (docs/API_SPEC.md). */
export class ApiError extends Error {
  constructor(
    message: string,
    public code: string,
    public status: number,
    public requestId?: string,
    public retryAfterS?: number,
  ) {
    super(message)
  }
}
