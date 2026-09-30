// RemoteEngine: the dashboard's window onto the FastAPI backend.
//   GET  /api/snapshot   first paint
//   WS   /ws             every pipeline stage, pushed (no polling)
//   POST /api/report     inject a free-text report
//   POST /api/reset      start the drill over
// The socket reconnects with backoff; while it is down the last picture stays on
// screen under an "offline" banner — the board never blanks.
import { SAMPLE_REPORTS, type DataSource, type Subscriber } from '../source'
import { ApiError, type Connection, type InjectResult, type Snapshot } from '../types'
import { emptySnapshot, fromBackend } from './mapping'

const PING_MS = 25_000
const REQUEST_TIMEOUT_MS = 90_000      // a real LLM pipeline can take a while

/* eslint-disable @typescript-eslint/no-explicit-any */

export async function parseError(res: Response): Promise<ApiError> {
  let body: any = null
  try {
    body = await res.json()
  } catch {
    /* non-JSON error page */
  }
  const err = body?.error
  const retry = Number(res.headers.get('Retry-After'))
  return new ApiError(
    err?.message ?? `The server answered ${res.status}.`,
    err?.code ?? 'internal_error',
    res.status,
    err?.request_id,
    Number.isFinite(retry) && retry > 0 ? retry : undefined,
  )
}

export class RemoteEngine implements DataSource {
  readonly kind = 'remote' as const

  private snap: Snapshot = emptySnapshot('connecting', 'remote')
  private subscribers = new Set<Subscriber>()
  private ws: WebSocket | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private retries = 0
  private stopped = true
  private sampleIndex = 0

  /** `baseUrl` '' ⇒ same origin (Vite proxy in dev, a reverse proxy in production). */
  constructor(private baseUrl: string = '') {}

  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn)
    return () => {
      this.subscribers.delete(fn)
    }
  }

  getSnapshot(): Snapshot {
    return this.snap
  }

  exportUrl(drillId: number): string {
    return this.url(`/api/drills/${drillId}/export.csv`)
  }

  nextSampleReport(): string {
    const s = SAMPLE_REPORTS[this.sampleIndex % SAMPLE_REPORTS.length]
    this.sampleIndex += 1
    return s
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    void this.fetchSnapshot()
    this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.pingTimer) clearInterval(this.pingTimer)
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.pingTimer = this.retryTimer = null
    this.ws?.close()
    this.ws = null
  }

  async injectReport(text: string): Promise<InjectResult> {
    const body = await this.request('/api/report', { method: 'POST', body: JSON.stringify({ text, source: 'radio' }) })
    this.apply(fromBackend(body.snapshot, this.snap.connection))
    const o = body.outcome ?? {}
    return {
      kind: o.kind ?? 'created',
      incident_title: o.title ?? '',
      tier: o.tier ?? null,
      urgency: typeof o.urgency === 'number' ? o.urgency : null,
      message: o.message ?? '',
    }
  }

  async reset(): Promise<void> {
    const body = await this.request('/api/reset', { method: 'POST' })
    this.apply(fromBackend(body.snapshot, this.snap.connection))
  }

  // -- plumbing ----------------------------------------------------------------

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/$/, '')}${path}`
  }

  private wsUrl(): string {
    if (this.baseUrl) return this.baseUrl.replace(/^http/, 'ws').replace(/\/$/, '') + '/ws'
    return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`
  }

  private async request(path: string, init: RequestInit = {}): Promise<any> {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS)
    let res: Response
    try {
      res = await fetch(this.url(path), {
        ...init,
        signal: ctl.signal,
        headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
      })
    } catch (e) {
      const aborted = e instanceof DOMException && e.name === 'AbortError'
      throw new ApiError(
        aborted ? 'The server took too long to answer.' : 'Cannot reach the MissionSync server.',
        aborted ? 'timeout' : 'network_error',
        0,
      )
    } finally {
      clearTimeout(timer)
    }
    if (!res.ok) throw await parseError(res)
    return res.json()
  }

  private async fetchSnapshot(): Promise<void> {
    try {
      const raw = await this.request('/api/snapshot')
      if (this.snap.status !== 'live' || this.snap.tick === 0) this.apply(fromBackend(raw, this.snap.connection))
    } catch {
      /* the socket will deliver the first snapshot, or the offline banner will say why */
    }
  }

  private connect(): void {
    if (this.stopped) return
    let ws: WebSocket
    try {
      ws = new WebSocket(this.wsUrl())
    } catch {
      this.scheduleReconnect()
      return
    }
    this.ws = ws
    ws.onopen = () => {
      this.retries = 0
      this.setConnection('online')
      if (this.pingTimer) clearInterval(this.pingTimer)
      this.pingTimer = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send('ping'), PING_MS)
    }
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data)
        if (msg.type === 'snapshot') this.apply(fromBackend(msg.data, 'online'))
      } catch {
        /* ignore malformed frames */
      }
    }
    ws.onclose = () => {
      if (this.pingTimer) clearInterval(this.pingTimer)
      this.ws = null
      if (!this.stopped) {
        this.setConnection('offline')
        this.scheduleReconnect()
      }
    }
    ws.onerror = () => ws.close()
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.retryTimer) return
    const delay = Math.min(10_000, 1000 * 2 ** this.retries)
    this.retries += 1
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.connect()
    }, delay)
  }

  private setConnection(connection: Connection): void {
    this.apply({ ...this.snap, connection })
  }

  private apply(next: Snapshot): void {
    this.snap = next
    for (const fn of this.subscribers) fn(next)
  }
}
