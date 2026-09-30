import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RemoteEngine } from './remote'

/* eslint-disable @typescript-eslint/no-explicit-any */

class MockSocket {
  static instances: MockSocket[] = []
  static OPEN = 1
  readyState = 0
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(public url: string) {
    MockSocket.instances.push(this)
  }
  send(data: string) { this.sent.push(data) }
  close() { this.readyState = 3; this.onclose?.() }
  open() { this.readyState = 1; this.onopen?.() }
  push(obj: unknown) { this.onmessage?.({ data: typeof obj === 'string' ? obj : JSON.stringify(obj) }) }
}

const snap = (tick: number) => ({ status: 'live', tick, sim_time: '2026-01-01T00:00:00Z', incidents: [], resources: [], weather: [], actions: [], event_log: [], metrics: {} })
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

beforeEach(() => {
  MockSocket.instances = []
  vi.useFakeTimers()
  vi.stubGlobal('WebSocket', MockSocket)
  vi.stubGlobal('fetch', vi.fn(async () => json(snap(1))))
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('RemoteEngine socket', () => {
  it('goes online on open, applies pushed snapshots, and ignores malformed frames', () => {
    const e = new RemoteEngine('https://api.example.com')
    const seen: number[] = []
    e.subscribe((s) => seen.push(s.tick))
    e.start()
    const ws = MockSocket.instances[0]
    expect(ws.url).toBe('wss://api.example.com/ws')                  // http(s) → ws(s) for a separate API origin
    ws.open()
    expect(e.getSnapshot().connection).toBe('online')
    ws.push({ type: 'snapshot', data: snap(5) })
    ws.push('not json')
    ws.push({ type: 'unknown' })
    expect(e.getSnapshot().tick).toBe(5)
    expect(seen).toContain(5)
    e.stop()
  })

  it('reports offline when the socket drops, and reconnects with exponential backoff', () => {
    const e = new RemoteEngine('http://localhost:9')
    e.start()
    MockSocket.instances[0].open()
    MockSocket.instances[0].close()
    expect(e.getSnapshot().connection).toBe('offline')              // the last picture stays, under a banner
    expect(MockSocket.instances).toHaveLength(1)
    vi.advanceTimersByTime(999)
    expect(MockSocket.instances).toHaveLength(1)
    vi.advanceTimersByTime(1)                                        // 1 s
    expect(MockSocket.instances).toHaveLength(2)
    MockSocket.instances[1].close()                                  // fails again
    vi.advanceTimersByTime(1999)
    expect(MockSocket.instances).toHaveLength(2)
    vi.advanceTimersByTime(1)                                        // 2 s
    expect(MockSocket.instances).toHaveLength(3)
    MockSocket.instances[2].open()                                   // recovered: back to online, backoff resets
    expect(e.getSnapshot().connection).toBe('online')
    MockSocket.instances[2].close()
    vi.advanceTimersByTime(1000)
    expect(MockSocket.instances).toHaveLength(4)
    e.stop()
  })

  it('caps the backoff at 10 s', () => {
    const e = new RemoteEngine('http://localhost:9')
    e.start()
    for (let i = 0; i < 8; i++) {
      MockSocket.instances[MockSocket.instances.length - 1].close()
      vi.advanceTimersByTime(10_000)
    }
    const before = MockSocket.instances.length
    MockSocket.instances[MockSocket.instances.length - 1].close()
    vi.advanceTimersByTime(10_000)
    expect(MockSocket.instances.length).toBe(before + 1)
    e.stop()
  })

  it('sends a keep-alive ping only while open, and stop() ends everything', () => {
    const e = new RemoteEngine('http://localhost:9')
    e.start()
    const ws = MockSocket.instances[0]
    ws.open()
    vi.advanceTimersByTime(25_000)
    expect(ws.sent).toEqual(['ping'])
    e.stop()
    vi.advanceTimersByTime(120_000)
    expect(ws.sent).toEqual(['ping'])
    expect(MockSocket.instances).toHaveLength(1)                     // a stopped engine never reconnects
  })

  it('does not fall over when the socket constructor throws (blocked / bad URL)', () => {
    vi.stubGlobal('WebSocket', class { constructor() { throw new Error('blocked') } })
    const e = new RemoteEngine('http://localhost:9')
    expect(() => e.start()).not.toThrow()
    e.stop()
  })
})

describe('RemoteEngine actions', () => {
  function engine(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
    const f = vi.fn(async (url: string, init: RequestInit = {}) => (init.method ? respond(url, init) : json(snap(1))))
    vi.stubGlobal('fetch', f)
    const e = new RemoteEngine('https://api.example.com')
    return { e, calls: () => f.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method) as [string, RequestInit][] }
  }

  it('hits the right endpoint with the right body and applies the returned snapshot', async () => {
    const { e, calls } = engine(() => json({ snapshot: snap(42) }))
    await e.approve(['p1', 'p2'])
    await e.approve()
    await e.reject('p3')
    await e.dispatchManual('inc_1', 'res_1')
    await e.recall('res 1')
    await e.resolveIncident('inc_1', 'contained')
    const seen = calls().map(([u, i]) => [i.method, u.replace('https://api.example.com', ''), i.body])
    expect(seen).toEqual([
      ['POST', '/api/dispatch/approve', JSON.stringify({ proposal_ids: ['p1', 'p2'] })],
      ['POST', '/api/dispatch/approve', '{}'],
      ['POST', '/api/dispatch/reject', JSON.stringify({ proposal_id: 'p3' })],
      ['POST', '/api/dispatch/manual', JSON.stringify({ incident_id: 'inc_1', resource_id: 'res_1' })],
      ['POST', '/api/units/res%201/recall', undefined],
      ['PATCH', '/api/incidents/inc_1', JSON.stringify({ status: 'contained' })],
    ])
    expect(e.getSnapshot().tick).toBe(42)
  })

  it('sends the admin key only on the privileged calls', async () => {
    const { e, calls } = engine(() => json({ snapshot: snap(2) }))
    e.setAdminKey('k-123')
    await e.reset()
    await e.endDrill()
    await e.setAutoDispatch(true)
    await e.approve()
    const headers = calls().map(([u, i]) => [u.replace(/^.*\/api/, ''), (i.headers as Record<string, string>)['X-Admin-Key']])
    expect(headers).toEqual([['/reset', 'k-123'], ['/drill/end', 'k-123'], ['/settings', 'k-123'], ['/dispatch/approve', undefined]])
    expect(JSON.parse(calls()[2][1].body as string)).toEqual({ auto_dispatch: true })
  })

  it('remembers the admin key for the tab session', async () => {
    const store: Record<string, string> = {}
    vi.stubGlobal('sessionStorage', { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v } })
    new RemoteEngine('').setAdminKey('abc')
    expect(store['ms-admin-key']).toBe('abc')
    const { e, calls } = engine(() => json({ snapshot: snap(3) }))   // a fresh engine (page reload) picks it up
    await e.reset()
    expect((calls()[0][1].headers as Record<string, string>)['X-Admin-Key']).toBe('abc')
  })

  it('surfaces 401 / 409 as typed errors the UI can act on', async () => {
    const { e } = engine((url) => url.endsWith('/reset')
      ? json({ error: { code: 'unauthorized', message: 'Admin key required.', request_id: 'r1' } }, 401)
      : json({ error: { code: 'conflict', message: 'Unit is busy.' } }, 409))
    await expect(e.reset()).rejects.toMatchObject({ code: 'unauthorized', status: 401, requestId: 'r1' })
    await expect(e.recall('res_1')).rejects.toMatchObject({ code: 'conflict', status: 409, message: 'Unit is busy.' })
  })

  it('gives each report submit its own nonce', async () => {
    const bodies: any[] = []
    const { e } = engine((_u, init) => { bodies.push(JSON.parse(init.body as string)); return json({ snapshot: snap(1), outcome: { kind: 'created', title: 'T', tier: 'P2', urgency: 50, provisional: true } }) })
    const r = await e.injectReport('fire')
    await e.injectReport('fire')
    expect(bodies[0].client_nonce).toBeTruthy()
    expect(bodies[0].client_nonce).not.toBe(bodies[1].client_nonce)
    expect(r.provisional).toBe(true)
  })
})
