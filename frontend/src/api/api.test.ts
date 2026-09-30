import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../types'
import { emptySnapshot, fromBackend, mapMetrics } from './mapping'
import { RemoteEngine } from './remote'

/* eslint-disable @typescript-eslint/no-explicit-any */

const backendSnapshot = (over: object = {}) => ({
  status: 'live', tick: 7, sim_time: '2026-01-01T00:00:00Z',
  incidents: [{ id: 'inc_1', type: 'fire', title: 'Fire', zone: 'Downtown', status: 'new', location_known: false,
    risk: { tier: 'P2', urgency: 61, source: 'llm', breakdown: {} } }, { id: 'inc_2', type: 'flood', title: 'Flood' }],
  resources: [{ id: 'res_1' }], weather: [{ zone: 'Downtown' }], actions: [{ incident_id: 'inc_1' }],
  event_log: [{ seq: 1, t: '00:00:01Z', msg: 'hi' }],
  pipeline: { stage: 'risk', origin: 'inject' },
  metrics: {
    mode: 'llm', model: 'openai/gpt-oss-20b', scenario_dataset: 'kaggle',
    ranking_accuracy: { spearman: 0.81, evaluated_incidents: 9 },
    latency: { last_cycle_ms: 1234, pipeline: { risk_ms: 5 }, llm: { success_rate: 1, quota: { exhausted_models: {} } } },
    scoring_sources: { llm: 5 },
    recommendation_quality: { p1p2_count: 3, p1p2_covered: 2, coverage: 0.67, capability_match: 1, p1_best_eta_min: 4.2, injections_processed: 2, resolved_incidents: 1 },
  },
  ...over,
})

describe('backend → dashboard mapping', () => {
  it('maps the snapshot and flattens the nested metrics', () => {
    const s = fromBackend(backendSnapshot())
    expect(s.status).toBe('live')
    expect(s.engine).toBe('remote')
    expect(s.pipeline).toEqual({ stage: 'risk', origin: 'inject' })
    expect(s.incidents[0].location_known).toBe(false)
    expect(s.incidents[1].location_known).toBe(true)
    expect(s.metrics).toMatchObject({
      mode: 'llm', model: 'openai/gpt-oss-20b', spearman: 0.81, evaluated_incidents: 9, cycle_ms: 1234,
      coverage: 0.67, p1_best_eta_min: 4.2, injections: 2, resolved: 1, llm_success_rate: 1,
      dataset_note: 'Real xBD damage surveys (live from Kaggle)', scoring_sources: { llm: 5 },
    })
  })

  it('reports the quota wait when every model is spent', () => {
    const m = mapMetrics({ mode: 'quota_exhausted', latency: { llm: { quota: { exhausted_models: { a: 420, b: 130 } } } } })
    expect(m.mode).toBe('quota_exhausted')
    expect(m.quota_retry_s).toBe(130)
  })

  it('tolerates a half-empty or unknown payload', () => {
    const m = mapMetrics({ mode: 'weird' })
    expect(m.mode).toBe('fallback')
    expect(m.spearman).toBeNull()
    expect(fromBackend({}).incidents).toEqual([])
    expect(emptySnapshot('connecting', 'remote').status).toBe('booting')
  })
})

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => handler(url, init)))
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })

afterEach(() => vi.unstubAllGlobals())

describe('RemoteEngine', () => {
  it('posts the report and returns what the pipeline did', async () => {
    let seen: any
    mockFetch((url, init) => {
      seen = { url, body: JSON.parse(String(init?.body)) }
      return json({ status: 'processed', outcome: { kind: 'created', title: 'Fire at Downtown', tier: 'P2', urgency: 61.5, message: '' }, snapshot: backendSnapshot() })
    })
    const e = new RemoteEngine('http://api.test/')
    const r = await e.injectReport('fire at downtown')
    expect(seen.url).toBe('http://api.test/api/report')
    expect(seen.body).toMatchObject({ text: 'fire at downtown', source: 'radio' })
    expect(typeof seen.body.client_nonce).toBe('string')
    expect(seen.body.client_nonce.length).toBeGreaterThan(8)                 // idempotency key on every submit
    expect(r).toEqual({ kind: 'created', incident_title: 'Fire at Downtown', tier: 'P2', urgency: 61.5, message: '', provisional: false })
    expect(e.getSnapshot().tick).toBe(7)                       // the returned picture is applied immediately
    expect(e.getSnapshot().metrics.injections).toBe(2)
  })

  it('surfaces the standard error envelope', async () => {
    mockFetch(() => json({ error: { code: 'validation_error', message: 'Invalid text.', details: [], request_id: 'req_ab12' } }, 400))
    const err = await new RemoteEngine().injectReport('x').catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ code: 'validation_error', status: 400, requestId: 'req_ab12', message: 'Invalid text.' })
  })

  it('carries the retry hint on a rate limit', async () => {
    mockFetch(() => json({ error: { code: 'rate_limited', message: 'Slow down', request_id: 'req_1' } }, 429, { 'Retry-After': '3' }))
    const err = await new RemoteEngine().injectReport('x').catch((e) => e)
    expect(err).toMatchObject({ code: 'rate_limited', retryAfterS: 3 })
  })

  it('reports an unreachable server as a network error, not a crash', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    const err = await new RemoteEngine().injectReport('x').catch((e) => e)
    expect(err).toMatchObject({ code: 'network_error', status: 0 })
  })

  it('survives a non-JSON error page', async () => {
    mockFetch(() => new Response('<html>Bad gateway</html>', { status: 502 }))
    const err = await new RemoteEngine().reset().catch((e) => e)
    expect(err).toMatchObject({ code: 'internal_error', status: 502 })
  })
})
