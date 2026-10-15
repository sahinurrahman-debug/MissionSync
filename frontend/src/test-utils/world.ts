// Test helpers: realistic snapshots (captured from the real backend, see scripts/make_frontend_fixtures.py) and an
// in-memory DataSource so a whole DrillBoard can be driven without a server.
import auto from './fixtures/snapshot.auto.json'
import manual from './fixtures/snapshot.manual.json'
import { fromBackend } from '../api/mapping'
import type { DataSource, Subscriber } from '../source'
import type { InjectResult, Snapshot } from '../types'

/** What the API sends for a booted drill: `autoDispatch` false = proposals waiting for a person; true = units already out. */
export function snapshotOf(autoDispatch = false): Snapshot {
  return fromBackend(structuredClone(autoDispatch ? auto : manual), 'online')
}

export function world(autoDispatch = false): { snap: Snapshot } {
  return { snap: snapshotOf(autoDispatch) }
}

/** A DataSource that behaves like a tiny server: approving turns proposals into units on their way. */
export class FakeSource implements DataSource {
  readonly kind = 'remote' as const
  private snap: Snapshot
  private subs = new Set<Subscriber>()
  calls: string[] = []

  constructor(autoDispatch = false) {
    this.snap = snapshotOf(autoDispatch)
  }

  subscribe(fn: Subscriber): () => void {
    this.subs.add(fn)
    return () => this.subs.delete(fn)
  }
  getSnapshot(): Snapshot { return this.snap }
  start(): void {}
  stop(): void {}
  exportUrl(): string { return '/api/drills/1/export.csv' }
  nextSampleReport(): string { return 'Fire at the University chemistry lab, three students trapped' }

  private set(next: Snapshot): void {
    this.snap = next
    for (const fn of this.subs) fn(next)
  }

  async injectReport(text: string): Promise<InjectResult> {
    this.calls.push(`report:${text}`)
    return { kind: 'created', incident_title: 'Fake incident', tier: 'P2', urgency: 61, message: '', provisional: false }
  }
  async approve(ids?: string[]): Promise<void> {
    this.calls.push(`approve:${ids?.join(',') ?? 'all'}`)
    const chosen = this.snap.proposals.filter((p) => !ids || ids.includes(p.id))
    const resources = this.snap.resources.map((r) => {
      const p = chosen.find((x) => x.resource_id === r.id)
      return p ? { ...r, status: 'en_route' as const, assigned_incident: p.incident_id, role: p.role } : r
    })
    this.set({ ...this.snap, resources, proposals: this.snap.proposals.filter((p) => !chosen.includes(p)) })
  }
  async reject(id: string): Promise<void> {
    this.calls.push(`reject:${id}`)
    this.set({ ...this.snap, proposals: this.snap.proposals.filter((p) => p.id !== id) })
  }
  async dispatchManual(): Promise<void> { this.calls.push('manual') }
  async recall(): Promise<void> { this.calls.push('recall') }
  async resolveIncident(id: string): Promise<void> {
    this.calls.push(`resolve:${id}`)
    this.set({ ...this.snap, incidents: this.snap.incidents.filter((i) => i.id !== id) })
  }
  async setAutoDispatch(): Promise<void> { this.calls.push('auto') }
  async endDrill(): Promise<void> {
    this.calls.push('end')
    this.set({ ...this.snap, status: 'ended' })
  }
  async reset(): Promise<void> { this.calls.push('reset') }
}
