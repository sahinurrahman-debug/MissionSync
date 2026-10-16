// RemoteEngine: the dashboard's window onto ONE of your drills on the FastAPI backend.
//   GET   /api/drills/:id/snapshot      first paint
//   WS    /ws/drills/:id                every pipeline stage, pushed (no polling)
//   POST  /api/drills/:id/report ...    actions (each answers with the new snapshot)
// The socket reconnects with backoff; while it is down the last picture stays on screen under an
// "offline" banner — the board never blanks. If the server says the session ended (close 4401) or the
// drill is gone (4404), `onLost` tells the app to leave this page instead of reconnecting forever.
import { SAMPLE_REPORTS, type DataSource, type Subscriber } from '../source'
import { type Connection, type InjectResult, type Snapshot } from '../types'
import { request } from './http'
import { emptySnapshot, fromBackend } from './mapping'

export { parseError } from './http'

const PING_MS = 25_000

/** A unique id per submit: a retried or double-clicked request is processed once by the server. */
function nonce(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */

export type LostReason = 'signed_out' | 'not_found'

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

  constructor(private drillId: number, private onLost?: (why: LostReason) => void) {}

  private get base(): string {
    return `/api/drills/${this.drillId}`
  }

  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn)
    return () => {
      this.subscribers.delete(fn)
    }
  }

  getSnapshot(): Snapshot {
    return this.snap
  }

  exportUrl(): string {
    return `${this.base}/export.csv`
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
    const body = await request(`${this.base}/report`, { method: 'POST', json: { text, source: 'radio', client_nonce: nonce() } })
    this.apply(fromBackend(body.snapshot, this.snap.connection))
    const o = body.outcome ?? {}
    return {
      kind: o.kind ?? 'created',
      incident_title: o.title ?? '',
      tier: o.tier ?? null,
      urgency: typeof o.urgency === 'number' ? o.urgency : null,
      message: o.message ?? '',
      provisional: o.provisional === true,
    }
  }

  /** POST/PATCH an action and apply the snapshot the server answers with. */
  private async act(path: string, method: 'POST' | 'PATCH', json?: unknown): Promise<void> {
    const res = await request(`${this.base}${path}`, { method, json })
    if (res?.snapshot) this.apply(fromBackend(res.snapshot, this.snap.connection))
  }

  reset(): Promise<void> { return this.act('/reset', 'POST') }
  endDrill(): Promise<void> { return this.act('/end', 'POST') }
  setAutoDispatch(enabled: boolean): Promise<void> { return this.act('/settings', 'POST', { auto_dispatch: enabled }) }
  approve(proposalIds?: string[]): Promise<void> { return this.act('/dispatch/approve', 'POST', proposalIds ? { proposal_ids: proposalIds } : {}) }
  reject(proposalId: string): Promise<void> { return this.act('/dispatch/reject', 'POST', { proposal_id: proposalId }) }
  dispatchManual(incidentId: string, resourceId: string): Promise<void> {
    return this.act('/dispatch/manual', 'POST', { incident_id: incidentId, resource_id: resourceId })
  }
  recall(unitId: string): Promise<void> { return this.act(`/units/${encodeURIComponent(unitId)}/recall`, 'POST') }
  resolveIncident(incidentId: string, status: 'contained' | 'closed'): Promise<void> {
    return this.act(`/incidents/${encodeURIComponent(incidentId)}`, 'PATCH', { status })
  }

  // -- plumbing ----------------------------------------------------------------

  private wsUrl(): string {
    return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/drills/${this.drillId}`
  }

  private async fetchSnapshot(): Promise<void> {
    try {
      const raw = await request(`${this.base}/snapshot`, { quiet401: true })
      const incoming = fromBackend(raw, this.snap.connection)
      if (this.snap.tick === 0 || incoming.tick >= this.snap.tick) this.apply(incoming)       // never go backwards
    } catch (e: any) {
      if (e?.status === 401) this.lost('signed_out')
      else if (e?.status === 404) this.lost('not_found')
      else if (e?.status === 503) this.setConnection('offline', 'busy')            // the server is full of other drills
      /* otherwise the socket will deliver the first snapshot, or the offline banner will say why */
    }
  }

  private lost(why: LostReason): void {
    this.stop()
    this.onLost?.(why)
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
    ws.onclose = (ev) => {
      if (this.pingTimer) clearInterval(this.pingTimer)
      this.ws = null
      if (this.stopped) return
      if (ev?.code === 4401) return this.lost('signed_out')
      if (ev?.code === 4404) return this.lost('not_found')
      this.setConnection('offline', ev?.code === 1013 ? 'busy' : undefined)
      this.scheduleReconnect()
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

  private setConnection(connection: Connection, reason?: 'busy'): void {
    this.apply({ ...this.snap, connection, offline_reason: connection === 'offline' ? reason : undefined })
  }

  private apply(next: Snapshot): void {
    this.snap = next
    for (const fn of this.subscribers) fn(next)
  }
}
