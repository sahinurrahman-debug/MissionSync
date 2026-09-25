// Mirrors backend/missionsync/models.py JSON shapes (snake_case preserved)

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
  tier: 'P1' | 'P2' | 'P3' | 'P4'
  scored_at: string
  scoring_latency_ms: number
}

export interface Incident {
  id: string
  type: string
  title: string
  description: string
  lat: number
  lon: number
  zone: string
  status: string
  reported_at: string
  updated_at: string
  affected_population: number
  injuries: number
  confidence: number
  risk: RiskScore | null
}

export interface Resource {
  id: string
  type: string
  name: string
  base_lat: number
  base_lon: number
  current_lat: number | null
  current_lon: number | null
  personnel: number
  capacity_note: string
  status: 'available' | 'en_route' | 'on_scene' | 'returning'
  assigned_incident: string | null
  role: string
  speed_kph: number
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

export interface Deployment {
  id: string
  incident_id: string
  incident_title: string
  resource_id: string
  resource_name: string
  resource_type: string
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
  deployments: Deployment[]
  warnings: string[]
  latency_ms: number
}

export interface Metrics {
  mode: string
  ranking_accuracy: {
    spearman: number | null
    evaluated_incidents: number
    note: string
  }
  latency: {
    last_cycle_ms: number
    pipeline: Record<string, number>
    llm: { calls: number; avg_latency_ms: number; success_rate: number; mode: string }
  }
  recommendation_quality: {
    p1p2_count: number
    p1p2_covered: number
    coverage: number
    capability_match: number
    p1_best_eta_min: number | null
    injections_processed: number
  }
}

export interface WorldSnapshot {
  tick: number
  sim_time: string
  incidents: Incident[]
  resources: Resource[]
  weather: WeatherCell[]
  actions: RecommendedAction[]
  metrics: Metrics
  event_log: string[]
}
