// Maps the FastAPI WorldSnapshot (backend/missionsync/models.py) to the
// dashboard's Snapshot. Incidents, resources, weather, actions and the event
// log already share their shape; only `metrics` is nested differently.
import type { Connection, EngineMode, Metrics, Snapshot } from '../types'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Raw = Record<string, any>

const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)

export function mapMetrics(m: Raw = {}): Metrics {
  const accuracy = m.ranking_accuracy ?? {}
  const latency = m.latency ?? {}
  const quality = m.recommendation_quality ?? {}
  const llm = latency.llm ?? {}
  const exhausted: Record<string, number> = llm.quota?.exhausted_models ?? {}
  const waits = Object.values(exhausted).map((v) => num(v))
  const mode = (['llm', 'fallback', 'quota_exhausted'].includes(m.mode) ? m.mode : 'fallback') as EngineMode
  return {
    cycle_ms: num(latency.last_cycle_ms),
    stages: latency.pipeline ?? {},
    spearman: typeof accuracy.spearman === 'number' ? accuracy.spearman : null,
    evaluated_incidents: num(accuracy.evaluated_incidents),
    p1p2_count: num(quality.p1p2_count),
    p1p2_covered: num(quality.p1p2_covered),
    coverage: num(quality.coverage, 1),
    capability_match: num(quality.capability_match, 1),
    p1_best_eta_min: typeof quality.p1_best_eta_min === 'number' ? quality.p1_best_eta_min : null,
    injections: num(quality.injections_processed),
    resolved: num(quality.resolved_incidents),
    dataset_note: datasetNote(m.scenario_dataset),
    mode,
    model: typeof m.model === 'string' ? m.model : null,
    llm_success_rate: typeof llm.success_rate === 'number' ? llm.success_rate : null,
    quota_retry_s: mode === 'quota_exhausted' && waits.length ? Math.min(...waits) : null,
    scoring_sources: m.scoring_sources ?? {},
    drill_id: typeof m.drill_id === 'number' ? m.drill_id : null,
    database: typeof m.database === 'string' ? m.database : 'disabled',
    pending_proposals: num(quality.pending_proposals),
    provisional_incidents: num(m.provisional_incidents),
    viewers: num(m.viewers),
  }
}

function datasetNote(source: unknown): string {
  switch (source) {
    case 'kaggle': return 'Real xBD damage surveys (live from Kaggle)'
    case 'xbd_snapshot': return 'Real xBD damage surveys (bundled snapshot)'
    case 'offline_fallback': return 'Synthetic offline cohort (no xBD data available)'
    default: return 'Loading scenario…'
  }
}

export function fromBackend(raw: Raw, connection: Connection = 'online'): Snapshot {
  return {
    status: raw.status === 'live' ? 'live' : raw.status === 'ended' ? 'ended' : 'booting',
    connection,
    engine: 'remote',
    tick: num(raw.tick),
    sim_time: String(raw.sim_time ?? new Date().toISOString()),
    incidents: (raw.incidents ?? []).map((i: Raw) => ({ ...i, location_known: i.location_known !== false, provisional: i.provisional === true })),
    resources: raw.resources ?? [],
    weather: raw.weather ?? [],
    actions: raw.actions ?? [],
    event_log: raw.event_log ?? [],
    metrics: mapMetrics(raw.metrics),
    pipeline: {
      stage: raw.pipeline?.stage ?? 'idle',
      origin: raw.pipeline?.origin ?? 'sim',
    },
    proposals: raw.proposals ?? [],
    settings: {
      auto_dispatch: raw.settings?.auto_dispatch === true,
      dispatch_mode: raw.settings?.auto_dispatch === true ? 'auto' : 'manual',
      llm_available: raw.settings?.llm_available === true,
    },
    elapsed_s: num(raw.elapsed_s),
  }
}

export function emptySnapshot(connection: Connection, engine: 'remote' | 'local'): Snapshot {
  return {
    status: 'booting',
    connection,
    engine,
    tick: 0,
    sim_time: new Date().toISOString(),
    incidents: [],
    resources: [],
    weather: [],
    actions: [],
    event_log: [],
    metrics: mapMetrics({}),
    pipeline: { stage: 'idle', origin: 'boot' },
    proposals: [],
    settings: { auto_dispatch: false, dispatch_mode: 'manual', llm_available: false },
    elapsed_s: 0,
  }
}
