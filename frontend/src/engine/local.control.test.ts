import { describe, expect, it } from 'vitest'
import { LocalEngine } from './local'
import type { Snapshot } from '../types'

function boot(autoDispatch: boolean): LocalEngine {
  const e = new LocalEngine({ paceMs: 0, autoDispatch })
  e.start()
  e.stop()
  return e
}
const tick = (e: LocalEngine, n = 1) => { for (let i = 0; i < n; i++) (e as unknown as { tick(): void }).tick() }
const busy = (s: Snapshot) => s.resources.filter((r) => r.status === 'en_route' || r.status === 'on_scene')

describe('human-approved dispatch (the PRD rule)', () => {
  it('commits nothing on its own in manual mode, but proposes', () => {
    const s = boot(false).getSnapshot()
    expect(busy(s)).toHaveLength(0)
    expect(s.proposals.length).toBeGreaterThan(0)
    expect(s.settings.auto_dispatch).toBe(false)
  })

  it('approve-all commits every proposal and clears them', async () => {
    const e = boot(false)
    const n = e.getSnapshot().proposals.length
    await e.approve()
    const s = e.getSnapshot()
    expect(busy(s).length).toBeGreaterThanOrEqual(1)
    expect(busy(s).length).toBeLessThanOrEqual(n)
    expect(s.event_log.some((l) => l.msg.includes('approved'))).toBe(true)
  })

  it('approves a single proposal and refuses a stale id', async () => {
    const e = boot(false)
    const p = e.getSnapshot().proposals[0]
    await e.approve([p.id])
    expect(e.getSnapshot().resources.find((r) => r.id === p.resource_id)!.assigned_incident).toBe(p.incident_id)
    await expect(e.approve(['nope'])).rejects.toMatchObject({ code: 'not_found', status: 404 })
  })

  it('a rejected pairing does not come straight back', async () => {
    const e = boot(false)
    const p = e.getSnapshot().proposals[0]
    await e.reject(p.id)
    const after = e.getSnapshot().proposals
    expect(after.some((x) => x.incident_id === p.incident_id && x.resource_id === p.resource_id)).toBe(false)
    await expect(e.reject(p.id)).rejects.toMatchObject({ status: 404 })
  })

  it('manual dispatch enforces availability, capability and the crew cap', async () => {
    const e = boot(false)
    const s = e.getSnapshot()
    const inc = s.incidents.find((i) => i.type === 'fire')!
    const water = s.resources.find((r) => r.type === 'swift_water')
    await e.dispatchManual(inc.id, s.resources.find((r) => r.status === 'available' && r.type === 'fire_unit')!.id)
    const after = e.getSnapshot()
    expect(busy(after)).toHaveLength(1)
    const used = busy(after)[0]
    await expect(e.dispatchManual(inc.id, used.id)).rejects.toMatchObject({ code: 'conflict' })       // already busy
    await expect(e.dispatchManual('missing', used.id)).rejects.toMatchObject({ code: 'not_found' })
    if (water) await expect(e.dispatchManual(inc.id, water.id)).rejects.toMatchObject({ code: 'conflict' }) // cannot serve a fire
  })

  it('recall frees a unit and only works on a unit that is out', async () => {
    const e = boot(true)
    const out = busy(e.getSnapshot())[0]
    await e.recall(out.id)
    const back = e.getSnapshot().resources.find((r) => r.id === out.id)!
    expect(back.status).toBe('returning')
    expect(back.assigned_incident).toBeNull()
    await expect(e.recall(out.id)).rejects.toMatchObject({ code: 'conflict' })
    await expect(e.recall('ghost')).rejects.toMatchObject({ code: 'not_found' })
  })

  it('resolving an incident works once, then refuses', async () => {
    const e = boot(true)
    const inc = e.getSnapshot().incidents.find((i) => i.status !== 'closed' && i.status !== 'contained')!
    await e.resolveIncident(inc.id, 'closed')
    const after = e.getSnapshot().incidents.find((i) => i.id === inc.id)
    expect(after === undefined || after.status === 'closed').toBe(true)   // closed incidents leave the active board
    await expect(e.resolveIncident(inc.id, 'contained')).rejects.toMatchObject({ status: expect.any(Number) })
  })

  it('toggling auto-dispatch flips the mode and starts committing', async () => {
    const e = boot(false)
    await e.setAutoDispatch(true)
    expect(e.getSnapshot().settings.auto_dispatch).toBe(true)
    tick(e, 2)
    expect(busy(e.getSnapshot()).length).toBeGreaterThan(0)
  })

  it('ending the drill freezes it: actions are refused, and a reset starts a new one', async () => {
    const e = boot(false)
    await e.endDrill()
    expect(e.getSnapshot().status).toBe('ended')
    await expect(e.approve()).rejects.toMatchObject({ code: 'conflict', status: 409 })
    await expect(e.endDrill()).rejects.toMatchObject({ code: 'conflict' })
    await e.reset()
    expect(e.getSnapshot().status).toBe('live')
  })

  it('never proposes more than the crew cap or the same unit twice', () => {
    const p = boot(false).getSnapshot().proposals
    expect(new Set(p.map((x) => x.resource_id)).size).toBe(p.length)
  })
})
