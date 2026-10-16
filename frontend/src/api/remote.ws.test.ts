// @vitest-environment jsdom
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
  onclose: ((ev?: { code?: number }) => void) | null = null
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
    const e = new RemoteEngine(7)
    const seen: number[] = []
    e.subscribe((s) => seen.push(s.tick))
    e.start()
    const ws = MockSocket.instances[0]
    expect(ws.url).toBe('ws://localhost:3000/ws/drills/7')            // same origin as the page, one socket per drill
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
    const e = new RemoteEngine(7)
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
    const e = new RemoteEngine(7)
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
    const e = new RemoteEngine(7)
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
    const e = new RemoteEngine(7)
    expect(() => e.start()).not.toThrow()
    e.stop()
  })
})

describe('RemoteEngine actions', () => {
  function engine(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
    const f = vi.fn(async (url: string, init: RequestInit = {}) => (init.method ? respond(url, init) : json(snap(1))))
    vi.stubGlobal('fetch', f)
    const e = new RemoteEngine(7)
    return { e, calls: () => f.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method) as [string, RequestInit][] }
  }

  it('hits the right drill-scoped endpoint with the right body and applies the returned snapshot', async () => {
    const { e, calls } = engine(() => json({ snapshot: snap(42) }))
    await e.approve(['p1', 'p2'])
    await e.approve()
    await e.reject('p3')
    await e.dispatchManual('inc_1', 'res_1')
    await e.recall('res 1')
    await e.resolveIncident('inc_1', 'contained')
    await e.setAutoDispatch(true)
    await e.endDrill()
    await e.reset()
    const seen = calls().map(([u, i]) => [i.method, u, i.body])
    expect(seen).toEqual([
      ['POST', '/api/drills/7/dispatch/approve', JSON.stringify({ proposal_ids: ['p1', 'p2'] })],
      ['POST', '/api/drills/7/dispatch/approve', '{}'],
      ['POST', '/api/drills/7/dispatch/reject', JSON.stringify({ proposal_id: 'p3' })],
      ['POST', '/api/drills/7/dispatch/manual', JSON.stringify({ incident_id: 'inc_1', resource_id: 'res_1' })],
      ['POST', '/api/drills/7/units/res%201/recall', undefined],
      ['PATCH', '/api/drills/7/incidents/inc_1', JSON.stringify({ status: 'contained' })],
      ['POST', '/api/drills/7/settings', JSON.stringify({ auto_dispatch: true })],
      ['POST', '/api/drills/7/end', undefined],
      ['POST', '/api/drills/7/reset', undefined],
    ])
    expect(e.getSnapshot().tick).toBe(42)
  })

  it('always sends the session cookie and never an admin key (the account is the authorisation)', async () => {
    const { e, calls } = engine(() => json({ snapshot: snap(2) }))
    await e.reset()
    for (const [, init] of calls()) {
      expect(init.credentials).toBe('include')
      expect(JSON.stringify(init.headers ?? {})).not.toMatch(/admin/i)
    }
  })

  it('surfaces 401 / 409 as typed errors the UI can act on', async () => {
    const { e } = engine((url) => url.endsWith('/reset')
      ? json({ error: 'Please sign in to continue.', code: 'unauthorized', request_id: 'r1' }, 401)
      : json({ error: 'Unit is busy.', code: 'conflict' }, 409))
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

  it('exposes the CSV of its own drill', () => {
    expect(new RemoteEngine(7).exportUrl()).toBe('/api/drills/7/export.csv')
  })
})

describe('RemoteEngine snapshot ordering', () => {
  it('a slow first-paint REST snapshot never overwrites a newer one already pushed over the socket', async () => {
    let release: (r: Response) => void = () => undefined
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((res) => { release = res })))
    const e = new RemoteEngine(7)
    e.start()
    MockSocket.instances[0].open()
    MockSocket.instances[0].push({ type: 'snapshot', data: snap(9) })
    expect(e.getSnapshot().tick).toBe(9)
    release(json(snap(3)))                                                      // the stale answer arrives last
    await vi.advanceTimersByTimeAsync(10)
    expect(e.getSnapshot().tick).toBe(9)
    e.stop()
  })

  it('but a newer REST snapshot is applied (e.g. after the socket was down)', async () => {
    let release: (r: Response) => void = () => undefined
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((res) => { release = res })))
    const e = new RemoteEngine(7)
    e.start()
    MockSocket.instances[0].push({ type: 'snapshot', data: snap(2) })
    release(json(snap(6)))
    await vi.advanceTimersByTimeAsync(10)
    expect(e.getSnapshot().tick).toBe(6)
    e.stop()
  })
})

describe('RemoteEngine access loss', () => {
  it('stops reconnecting and tells the app when the server closes the socket with 4401 (signed out) or 4404 (not yours)', () => {
    for (const [code, why] of [[4401, 'signed_out'], [4404, 'not_found']] as const) {
      MockSocket.instances = []
      const lost = vi.fn()
      const e = new RemoteEngine(7, lost)
      e.start()
      const ws = MockSocket.instances[0]
      ws.onclose?.({ code } as any)
      expect(lost).toHaveBeenCalledWith(why)
      vi.advanceTimersByTime(60_000)
      expect(MockSocket.instances).toHaveLength(1)                    // no reconnect storm against a door that is closed
    }
  })

  it('tells a full server (close 1013) apart from a lost connection', () => {
    const e = new RemoteEngine(7)
    e.start()
    MockSocket.instances[0].onclose?.({ code: 1013 } as any)
    expect(e.getSnapshot().connection).toBe('offline')
    expect(e.getSnapshot().offline_reason).toBe('busy')
    vi.advanceTimersByTime(1000)
    MockSocket.instances[1].open()                                    // back: the reason is cleared with the offline state
    expect(e.getSnapshot().connection).toBe('online')
    expect(e.getSnapshot().offline_reason).toBeUndefined()
    e.stop()
  })

  it('treats an ordinary drop as offline and keeps trying', () => {
    const lost = vi.fn()
    const e = new RemoteEngine(7, lost)
    e.start()
    MockSocket.instances[0].onclose?.({ code: 1006 } as any)
    expect(lost).not.toHaveBeenCalled()
    expect(e.getSnapshot().connection).toBe('offline')
    vi.advanceTimersByTime(1000)
    expect(MockSocket.instances).toHaveLength(2)
    e.stop()
  })

  it('leaves when the first snapshot request says 401 or 404', async () => {
    vi.useRealTimers()
    for (const [status, why] of [[401, 'signed_out'], [404, 'not_found']] as const) {
      vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'nope', code: 'x' }, status)))
      const lost = vi.fn()
      const e = new RemoteEngine(7, lost)
      e.start()
      await vi.waitFor(() => expect(lost).toHaveBeenCalledWith(why))
      e.stop()
    }
  })
})
