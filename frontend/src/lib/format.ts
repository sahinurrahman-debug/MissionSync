// Small pure helpers shared by the UI (and unit-tested).
import type { EngineMode, IncidentStatus, IncidentType, ResourceStatus, ResourceType, Tier } from '../types'

export const TIER_LABEL: Record<Tier, string> = {
  P1: 'CRITICAL',
  P2: 'URGENT',
  P3: 'MODERATE',
  P4: 'ADVISORY',
}

/** Hex values for the Leaflet layer (SVG can't read Tailwind classes). Mid-tones that hold up on dark and light tiles. */
export const TIER_HEX: Record<Tier, string> = {
  P1: '#EF4444',
  P2: '#F59E0B',
  P3: '#EAB308',
  P4: '#64748B',
}

export const STATUS_HEX: Record<ResourceStatus, string> = {
  available: '#10B981',
  en_route: '#60A5FA',
  on_scene: '#A78BFA',
  returning: '#64748B',
}

export const STATUS_LABEL: Record<ResourceStatus, string> = {
  available: 'Available',
  en_route: 'En route',
  on_scene: 'On scene',
  returning: 'Returning',
}

export const INCIDENT_STATUS_LABEL: Record<IncidentStatus, string> = {
  new: 'New',
  triaged: 'Triaged',
  units_en_route: 'Units en route',
  on_scene: 'On scene',
  contained: 'Contained',
  closed: 'Closed',
}

export const TYPE_LABEL: Record<IncidentType, string> = {
  fire: 'Fire',
  flood: 'Flood',
  structural_collapse: 'Structural collapse',
  medical: 'Medical',
  hazmat: 'Hazmat',
  landslide: 'Landslide',
  missing_persons: 'Missing person',
  roadside_casualties: 'Roadside casualties',
}

export const RESOURCE_LABEL: Record<ResourceType, string> = {
  fire_unit: 'Fire',
  ambulance: 'EMS',
  rescue_team: 'Rescue',
  swift_water: 'Swift water',
  engineering: 'Engineering',
  drone: 'Drone',
  hazmat_unit: 'Hazmat',
}

/** "2m ago", "45s ago", "1h 05m ago". Never negative. */
export function elapsed(fromIso: string, now: number): string {
  const t = Date.parse(fromIso)
  if (!Number.isFinite(t)) return '—'
  const s = Math.max(0, Math.floor((now - t) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  return `${h}h ${String(m % 60).padStart(2, '0')}m ago`
}

/** ETA countdown as a fixed-width clock: 3.4 min → "03:24". */
export function etaClock(minutes: number): string {
  const total = Math.max(0, Math.round(minutes * 60))
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

export function modeChip(mode: EngineMode, model: string | null, booting: boolean): { label: string; tone: 'ok' | 'warn' | 'bad' | 'info'; title: string } {
  switch (mode) {
    case 'llm':
      return { label: `AI · ${(model ?? 'LLM').replace(/^openai\//, '')}`, tone: 'ok', title: 'All five agents are running on the LLM.' }
    case 'quota_exhausted':
      return { label: 'AI QUOTA HIT', tone: 'bad', title: 'The Groq daily token quota is spent; rule-based agents are covering.' }
    case 'demo':
      return { label: 'DEMO ENGINE', tone: 'info', title: 'Running in the browser with rule-based agents — no backend connected.' }
    default:
      return {
        label: booting ? 'STARTING' : 'RULES · LLM off',
        tone: 'warn',
        title: 'Rule-based agents are running (no LLM key, or the LLM is failing).',
      }
  }
}

/** Classify an audit-log line by its leading marker so the log can colour it. */
export function logTone(msg: string): 'deploy' | 'merge' | 'alert' | 'done' | 'info' {
  const c = msg.trimStart().slice(0, 2)
  if (c.startsWith('🚨') || c.startsWith('🚁')) return 'deploy'
  if (c.startsWith('🔗') || c.startsWith('🆕') || c.startsWith('🛰')) return 'merge'
  if (c.startsWith('⚠') || c.startsWith('❗') || c.startsWith('🔥') || c.startsWith('🚫')) return 'alert'
  if (c.startsWith('✅') || c.startsWith('🛡') || c.startsWith('🏁') || c.startsWith('🟢')) return 'done'
  return 'info'
}

/** Strip the leading emoji so the log can show a proper icon instead. */
export function stripMarker(msg: string): string {
  return msg.replace(/^[^\p{L}\p{N}“"'\[(]+/u, '').trim()
}
