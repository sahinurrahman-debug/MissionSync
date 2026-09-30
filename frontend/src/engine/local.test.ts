import { describe, expect, it } from 'vitest'
import { LocalEngine, spearman } from './local'
import { SEED_ITEMS, WAVE_ITEMS } from './scenario'
import type { Snapshot } from '../types'

/* eslint-disable @typescript-eslint/no-explicit-any */
function boot(autoDispatch = true): LocalEngine {
  const e = new LocalEngine({ paceMs: 0, autoDispatch })
  e.start()
  e.stop() // no timers in tests: we drive ticks by hand
  return e
}
const tick = (e: LocalEngine, n = 1) => { for (let i = 0; i < n; i++) (e as any).tick() }
const zoneOf = (s: Snapshot, needle: string) => s.incidents.find((i) => i.description.includes(needle))?.zone

describe('scenario consistency', () => {
  it('places every seeded incident in the sector its text names', () => {
    const s = boot().getSnapshot()
    expect(s.status).toBe('live')
    expect(s.incidents).toHaveLength(SEED_ITEMS.length)
    expect(zoneOf(s, 'Floodwater rising fast around the Riverfront marina')).toBe('Riverfront')
    expect(zoneOf(s, 'active fire front spreading through dry brush on the North Hills')).toBe('North Hills')
    expect(zoneOf(s, 'Ammonia vapor cloud leaking from the Industrial Park')).toBe('Industrial Park')
    expect(zoneOf(s, 'two-story building partially collapsed near the Downtown')).toBe('Downtown')
  })

  it('every wave lands as its own incident, not a silent merge', () => {
    const e = boot()
    tick(e, 10)
    const titles = e.getSnapshot().incidents.map((i) => i.title)
    for (const w of WAVE_ITEMS) expect(titles.some((t) => t.startsWith(w.text.slice(0, 30)))).toBe(true)
  })

  it('folds the follow-up into the collapse and raises its counts', () => {
    const e = boot()
    const before = e.getSnapshot().incidents.find((i) => i.type === 'structural_collapse')!
    expect(before.affected_population).toBe(4)
    tick(e, 3)
    const after = e.getSnapshot().incidents.find((i) => i.id === before.id)!
    expect(after.affected_population).toBe(6)
    expect(e.getSnapshot().event_log.some((l) => l.msg.includes('merged into'))).toBe(true)
  })
})

describe('report intake', () => {
  it('places a report by its place name and creates a distinct scored incident', async () => {
    const e = boot()
    const before = e.getSnapshot().incidents.length
    const r = await e.injectReport('fire spreading near the University lab block, three students trapped')
    expect(r.kind).toBe('created')
    expect(r.tier).toMatch(/^P[1-4]$/)
    expect(r.urgency).not.toBeNull()
    const s = e.getSnapshot()
    expect(s.incidents).toHaveLength(before + 1)
    expect(s.incidents.find((i) => i.title.startsWith('Fire spreading near the University'))!.zone).toBe('University')
  })

  it('merges two reports about the same place and type', async () => {
    const e = boot()
    const a = await e.injectReport('Ammonia leak at Industrial Park west gate, workers coughing')
    const b = await e.injectReport('Industrial Park ammonia leak worsening, 6 workers hurt')
    expect(a.kind).toBe('merged') // the seeded Industrial Park hazmat is the same incident
    expect(b.kind).toBe('merged')
  })

  it('does not geo-merge a report that names no place', async () => {
    const e = boot()
    const a = await e.injectReport('smoke from Building C, two people coughing')
    const b = await e.injectReport('fire alarm and smoke in another building, three people coughing')
    expect([a.kind, b.kind]).toEqual(['created', 'created'])
    const un = e.getSnapshot().incidents.filter((i) => !i.location_known)
    expect(un).toHaveLength(2)
    expect(un[0].zone).toBe('Unlocated')
  })

  it('rejects text that is not an emergency and changes nothing', async () => {
    const e = boot()
    const n = e.getSnapshot().incidents.length
    const r = await e.injectReport('asdf qwerty nothing')
    expect(r.kind).toBe('rejected')
    expect(r.message).toMatch(/No emergency recognised/)
    expect(e.getSnapshot().incidents).toHaveLength(n)
  })

  it('classifies a missing child as missing_persons, not flood', async () => {
    const e = boot()
    await e.injectReport('Missing child last seen near the Riverfront levee, wearing a red jacket')
    expect(e.getSnapshot().incidents.some((i) => i.type === 'missing_persons')).toBe(true)
  })

  it('does not let typed reports move the ground-truth accuracy', async () => {
    const e = boot()
    const before = e.getSnapshot().metrics
    await e.injectReport('Fire in the University chemistry lab, 5 people hurt')
    await e.injectReport('Flood at Riverfront marina, 3 people trapped')
    const after = e.getSnapshot().metrics
    expect(after.evaluated_incidents).toBe(before.evaluated_incidents)
    expect(after.spearman).toBe(before.spearman)
  })
})

describe('units and lifecycle', () => {
  it('shows recommendation deployments that match the real assignments', () => {
    const e = boot()
    tick(e, 6)
    const s = e.getSnapshot()
    for (const a of s.actions) {
      const real = s.resources.filter((r) => r.assigned_incident === a.incident_id).map((r) => r.id).sort()
      expect(a.deployments.map((d) => d.resource_id).sort()).toEqual(real)
      if (real.length === 0) expect(a.warnings.some((w) => w.includes('No units'))).toBe(true)
    }
  })

  it('works incidents to containment and returns the units to base', () => {
    const e = boot()
    tick(e, 90)
    const s = e.getSnapshot()
    expect(s.metrics.resolved).toBeGreaterThan(0)
    expect(s.event_log.some((l) => l.msg.includes('Contained'))).toBe(true)
    expect(s.event_log.some((l) => l.msg.includes('back at base'))).toBe(true)
    const ids = new Set(s.incidents.map((i) => i.id))
    for (const r of s.resources) if (r.assigned_incident) expect(ids.has(r.assigned_incident)).toBe(true)
  })

  it('never double-books a unit or exceeds crew caps', async () => {
    const e = boot()
    await Promise.all(['Downtown', 'Riverfront', 'North Hills', 'Eastside', 'University'].map((z) => e.injectReport(`Fire reported in ${z}, several people hurt`)))
    tick(e, 5)
    const counts: Record<string, number> = {}
    for (const r of e.getSnapshot().resources) if (r.assigned_incident) counts[r.assigned_incident] = (counts[r.assigned_incident] ?? 0) + 1
    for (const n of Object.values(counts)) expect(n).toBeLessThanOrEqual(4)
  })

  it('does not grow the population of uninjured scenes', () => {
    const e = boot()
    const quiet = { id: 'inc_quiet' }
    void quiet
    tick(e, 40)
    for (const i of e.getSnapshot().incidents) if (i.injuries === 0) expect(i.affected_population).toBeLessThanOrEqual(120)
  })
})

describe('snapshots', () => {
  it('returns fresh object identities after every change (memo-safe)', () => {
    const e = boot()
    const a = e.getSnapshot()
    tick(e, 3)
    const b = e.getSnapshot()
    expect(b).not.toBe(a)
    expect(b.resources).not.toBe(a.resources)
    expect(b.resources[0]).not.toBe(a.resources[0])
    expect(b.incidents[0]).not.toBe(a.incidents[0])
    // ...and the old snapshot is a frozen-in-time copy, not a live view:
    expect(a.tick).toBe(0)
  })

  it('labels itself as the demo engine', () => {
    const s = boot().getSnapshot()
    expect(s.engine).toBe('local')
    expect(s.connection).toBe('demo')
    expect(s.metrics.mode).toBe('demo')
  })

  it('resets to a clean drill', async () => {
    const e = boot()
    await e.injectReport('Fire in the University chemistry lab, 5 people hurt')
    tick(e, 5)
    await e.reset()
    const s = e.getSnapshot()
    expect(s.tick).toBe(0)
    expect(s.incidents).toHaveLength(SEED_ITEMS.length)
    expect(s.metrics.injections).toBe(0)
    e.stop()
  })
})

describe('spearman', () => {
  it('handles ordering, reversal and ties', () => {
    expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBe(1)
    expect(spearman([1, 2, 3, 4], [40, 30, 20, 10])).toBe(-1)
    expect(spearman([1, 1, 1], [1, 2, 3])).toBeNull()
    expect(spearman([1], [1])).toBeNull()
  })
})
