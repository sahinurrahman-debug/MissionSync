import { describe, expect, it } from 'vitest'
import { elapsed, etaClock, logTone, modeChip, stripMarker } from './format'
import { summaryOf } from '../components/IncidentCard'

describe('elapsed', () => {
  const now = Date.parse('2026-01-01T12:00:00Z')
  it('formats seconds, minutes and hours', () => {
    expect(elapsed('2026-01-01T11:59:15Z', now)).toBe('45s ago')
    expect(elapsed('2026-01-01T11:58:00Z', now)).toBe('2m ago')
    expect(elapsed('2026-01-01T10:55:00Z', now)).toBe('1h 05m ago')
  })
  it('never goes negative and survives bad input', () => {
    expect(elapsed('2026-01-01T12:00:30Z', now)).toBe('0s ago')
    expect(elapsed('not a date', now)).toBe('—')
  })
})

describe('etaClock', () => {
  it('renders a fixed-width mm:ss countdown', () => {
    expect(etaClock(3.4)).toBe('03:24')
    expect(etaClock(0)).toBe('00:00')
    expect(etaClock(-2)).toBe('00:00')
    expect(etaClock(75)).toBe('75:00')
  })
})

describe('engine mode chip', () => {
  it('names the model and strips the vendor prefix', () => {
    expect(modeChip('llm', 'openai/gpt-oss-20b', false)).toMatchObject({ label: 'AI · gpt-oss-20b', tone: 'ok' })
  })
  it('is honest about every degraded state', () => {
    expect(modeChip('fallback', null, false)).toMatchObject({ label: 'RULES · LLM off', tone: 'warn' })
    expect(modeChip('fallback', null, true).label).toBe('STARTING')
    expect(modeChip('quota_exhausted', null, false)).toMatchObject({ label: 'AI QUOTA HIT', tone: 'bad' })
    expect(modeChip('demo', null, false)).toMatchObject({ label: 'DEMO ENGINE', tone: 'info' })
  })
})

describe('audit log helpers', () => {
  it('classifies lines by their leading marker', () => {
    expect(logTone('🚨 Deploy Engine 1 → [#1] Fire')).toBe('deploy')
    expect(logTone('🔗 Report merged into: Fire')).toBe('merge')
    expect(logTone('⚠️ Weather: North Hills winds intensifying')).toBe('alert')
    expect(logTone('✅ Engine 1 on scene')).toBe('done')
    expect(logTone('⚡ Pipeline cycle complete')).toBe('info')
  })
  it('strips the marker but keeps quoted text', () => {
    expect(stripMarker('🚨 Deploy Engine 1')).toBe('Deploy Engine 1')
    expect(stripMarker('🔥 INJECTED REPORT #1: “fire”')).toBe('INJECTED REPORT #1: “fire”')
  })
})

describe('incident summary', () => {
  it('shows the whole report when the title was cut mid-sentence', () => {
    const description = 'Drone D1 spots an active fire front spreading through dry brush on the North Hills ridge, wind pushing flames toward homes'
    const s = summaryOf({ title: 'Drone D1 spots an active fire front spreading through dry brush on th…', description })
    expect(s).toBe(description)
  })
  it('drops what the title already said when it was not cut', () => {
    expect(summaryOf({ title: 'Warehouse fire', description: 'Warehouse fire. Three workers trapped inside.' })).toBe('Three workers trapped inside.')
  })
  it('uses only the first merged report', () => {
    expect(summaryOf({ title: 'x', description: 'first report | second report' })).toBe('first report')
  })
})
