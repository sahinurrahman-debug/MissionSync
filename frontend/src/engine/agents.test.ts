import { describe, expect, it } from 'vitest'
import type { Incident, Resource } from '../types'
import {
  classifyText, isCapable, logisticsMatch, requiredFor, riskScore, surveillanceParse, terrainAssess,
  tierFor, WEIGHTS,
} from './agents'
import { buildResources, initialWeather, locateText, TERRAIN } from './scenario'

const sig = (raw_text: string, extra: object = {}) => ({ source: 'radio', lat: 34.05, lon: -118.24, raw_text, confidence: 0.9, ...extra })

function incident(type: Incident['type'], tier: 'P1' | 'P2' | 'P3' | 'P4', lat = 34.058, lon = -118.245): Incident {
  return {
    id: `inc_${type}_${tier}_${lat}`, type, title: 't', description: 'd', lat, lon, zone: 'Downtown', status: 'new',
    reported_at: '', updated_at: '', affected_population: 10, injuries: 0, confidence: 0.9, location_known: true, provisional: false,
    risk: { incident_id: 'x', urgency: 60, tier, scored_at: '', scoring_latency_ms: 0, source: 'rules',
      breakdown: { severity: 1, population: 1, spread: 1, time_criticality: 1, confidence: 90, rationale: '' } },
  }
}

describe('classification', () => {
  it.each([
    ['Missing child last seen near the Riverfront levee, wearing a red jacket', 'missing_persons'],
    ['Floodwater closing on the Riverfront footbridge, two kayakers missing downstream', 'flood'],
    ['Gas smell in Industrial Park block B, workers reporting dizziness', 'hazmat'],
    ['Mudslide across the North Hills access road', 'landslide'],
    ['New fire in the chemistry building, heavy smoke', 'fire'],
    ['Two people trapped in the stairwell', 'structural_collapse'],
    ['Man unconscious near the fountain', 'medical'],
  ])('%s → %s', (text, expected) => {
    expect(classifyText(text)).toBe(expected)
  })

  it('finds no emergency in chatter', () => {
    expect(classifyText('asdf qwerty nothing')).toBeNull()
    expect(surveillanceParse(sig('what time is the drill over?'))).toBeNull()
  })
})

describe('surveillance parsing', () => {
  it('extracts stated counts and flags them as reported', () => {
    const c = surveillanceParse(sig('Fire near the lab, three students trapped'))!
    expect(c.injuries).toBe(3)
    expect(c.affected_population).toBe(3)
    expect(c.counts_reported).toBe(true)
  })

  it('does not treat a timestamp as a casualty count', () => {
    const c = surveillanceParse(sig('Missing hiker, last seen 40 minutes ago'))!
    expect(c.type).toBe('missing_persons')
    expect(c.injuries).toBe(0)
    expect(c.counts_reported).toBe(false)
  })

  it('marks type-default counts as not reported', () => {
    const c = surveillanceParse(sig('Warehouse fire spreading'))!
    expect(c.counts_reported).toBe(false)
    expect(c.affected_population).toBe(40)
  })

  it('honours a scenario type hint', () => {
    expect(surveillanceParse(sig('something vague', { type_hint: 'flood' }))!.type).toBe('flood')
  })
})

describe('place names', () => {
  it('locates by the first place-word', () => {
    expect(locateText('fire near the University lab block')?.zone).toBe('University')
    expect(locateText('Ammonia at Industrial Park gate 3')?.zone).toBe('Industrial Park')
    expect(locateText('Missing child near the Riverfront levee')?.zone).toBe('Riverfront')
    expect(locateText('smoke from Building C')).toBeNull()
  })
})

describe('risk', () => {
  it('composes the weighted urgency and tiers it', () => {
    const inc = incident('fire', 'P2')
    const w = initialWeather()['North Hills']
    const score = riskScore(inc, terrainAssess(inc, w, TERRAIN['North Hills']), w, 0)
    const b = score.breakdown
    const expected = b.severity * WEIGHTS.severity + b.population * WEIGHTS.population + b.spread * WEIGHTS.spread + b.time_criticality * WEIGHTS.time_criticality
    expect(score.urgency).toBeCloseTo(expected, 1)
    expect(score.tier).toBe(tierFor(score.urgency))
    expect([75, 74.9, 55, 54.9, 35, 34.9].map(tierFor)).toEqual(['P1', 'P2', 'P2', 'P3', 'P3', 'P4'])
  })
})

describe('logistics', () => {
  const rankOf = (...incs: Incident[]) => incs.map((incident, i) => ({ rank: i + 1, incident }))

  it('matches the capability matrix and treats drones as universal', () => {
    const res = buildResources()
    const fire = incident('fire', 'P2')
    expect(requiredFor('structural_collapse')).toContain('engineering')
    expect(isCapable(res.find((r) => r.type === 'fire_unit')!, fire)).toBe(true)
    expect(isCapable(res.find((r) => r.type === 'drone')!, fire)).toBe(true)
    expect(isCapable(res.find((r) => r.type === 'swift_water')!, fire)).toBe(false)
  })

  it('sizes crews by tier and starts with the nearest capable unit', () => {
    const res = buildResources()
    const p1 = incident('fire', 'P1', 34.035, -118.259) // Industrial Park
    const out = logisticsMatch(rankOf(p1), res, {})
    expect(out).toHaveLength(3)
    expect(res.find((r) => r.id === out[0].resource_id)!.name).toBe('Engine 2')
  })

  it('never picks a unit that is not available', () => {
    const res: Resource[] = buildResources()
    for (const r of res) if (r.type === 'fire_unit') r.status = 'en_route'
    const out = logisticsMatch(rankOf(incident('fire', 'P1')), res, {})
    expect(out.every((a) => res.find((r) => r.id === a.resource_id)!.status === 'available')).toBe(true)
    expect(out.every((a) => res.find((r) => r.id === a.resource_id)!.type === 'drone')).toBe(true) // only recon left
  })

  it('does not over-assign an incident that already has its crew', () => {
    const p2 = incident('flood', 'P2')
    expect(logisticsMatch(rankOf(p2), buildResources(), { [p2.id]: 2 })).toEqual([])
  })
})
