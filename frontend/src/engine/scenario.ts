// Scenario data for the fictional city of Riverton — the same sectors, terrain,
// weather and resource inventory as the backend simulator (simulator.py).

import type { IncidentType, Resource, ResourceType, TerrainCell, WeatherCell } from '../types'

export interface Sector {
  name: string
  lat: number
  lon: number
}

export const SECTORS: Sector[] = [
  { name: 'Downtown', lat: 34.058, lon: -118.245 },
  { name: 'Riverfront', lat: 34.043, lon: -118.238 },
  { name: 'North Hills', lat: 34.074, lon: -118.255 },
  { name: 'Industrial Park', lat: 34.035, lon: -118.259 },
  { name: 'Eastside', lat: 34.052, lon: -118.221 },
  { name: 'University', lat: 34.066, lon: -118.229 },
]

export const CITY_CENTER = { lat: 34.0555, lon: -118.24 }

/** Words that place a free-text report in a sector (first match in the text wins). */
const ZONE_ALIASES: Record<string, string[]> = {
  Downtown: ['downtown', 'transit mall', 'city center', 'city centre', 'high-rise', 'storefront'],
  Riverfront: ['riverfront', 'marina', 'levee', 'footbridge', 'houseboat', 'river'],
  'North Hills': ['north hills', 'hillside', 'ridge', 'hills', 'brush'],
  'Industrial Park': ['industrial park', 'industrial', 'rail', 'depot', 'warehouse', 'refinery', 'chemical plant'],
  Eastside: ['eastside', 'east side', 'arterial', 'care home', 'suburb'],
  University: ['university', 'campus', 'lab block', 'chemistry', 'dorm', 'students'],
}

export function locateText(text: string): { zone: string; lat: number; lon: number } | null {
  const low = text.toLowerCase()
  let best: { pos: number; len: number; zone: string } | null = null
  for (const [zone, aliases] of Object.entries(ZONE_ALIASES)) {
    for (const alias of aliases) {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const m = new RegExp(`\\b${escaped}`).exec(low)
      if (m && (best === null || m.index < best.pos || (m.index === best.pos && alias.length > best.len))) {
        best = { pos: m.index, len: alias.length, zone }
      }
    }
  }
  if (!best) return null
  const sector = SECTORS.find((s) => s.name === best!.zone)!
  return { zone: sector.name, lat: sector.lat, lon: sector.lon }
}

export const TERRAIN: Record<string, TerrainCell> = {
  Downtown: { zone: 'Downtown', elevation_m: 85, slope_deg: 2, landcover: 'urban', road_access: 'good', notes: 'dense high-rise, narrow alleys' },
  Riverfront: { zone: 'Riverfront', elevation_m: 42, slope_deg: 3, landcover: 'water', road_access: 'degraded', notes: 'river levee, flood-prone low ground' },
  'North Hills': { zone: 'North Hills', elevation_m: 310, slope_deg: 18, landcover: 'forest', road_access: 'degraded', notes: 'single access road, dry brush' },
  'Industrial Park': { zone: 'Industrial Park', elevation_m: 55, slope_deg: 1, landcover: 'industrial', road_access: 'good', notes: 'chemical storage depots, rail spur' },
  Eastside: { zone: 'Eastside', elevation_m: 70, slope_deg: 4, landcover: 'suburban', road_access: 'good', notes: 'schools and care homes in grid' },
  University: { zone: 'University', elevation_m: 95, slope_deg: 6, landcover: 'urban', road_access: 'good', notes: 'high daytime population, labs on campus' },
}

export function initialWeather(): Record<string, WeatherCell> {
  return {
    'North Hills': { zone: 'North Hills', wind_kph: 38, wind_direction_deg: 210, precipitation_mm_h: 0, temperature_c: 34, alert: 'red_flag_wind', forecast_note: 'gusting to 50 kph by hour 2' },
    Riverfront: { zone: 'Riverfront', wind_kph: 14, wind_direction_deg: 180, precipitation_mm_h: 12, temperature_c: 19, alert: 'flood_watch', forecast_note: 'rain intensifying, river at 85% capacity' },
    Downtown: { zone: 'Downtown', wind_kph: 16, wind_direction_deg: 200, precipitation_mm_h: 2, temperature_c: 24, alert: null, forecast_note: '' },
    'Industrial Park': { zone: 'Industrial Park', wind_kph: 18, wind_direction_deg: 230, precipitation_mm_h: 1, temperature_c: 23, alert: null, forecast_note: '' },
    Eastside: { zone: 'Eastside', wind_kph: 12, wind_direction_deg: 190, precipitation_mm_h: 3, temperature_c: 25, alert: null, forecast_note: '' },
    University: { zone: 'University', wind_kph: 15, wind_direction_deg: 200, precipitation_mm_h: 2, temperature_c: 24, alert: null, forecast_note: '' },
  }
}

// ---------------------------------------------------------------------------
// Demo drill script. Hand-authored (the real xBD scenarios need the backend), but
// consistent: every item's text, coordinates and sector agree, and the hidden
// ground truth is a damage grade converted on the same 0→10 … 3→90 scale.
// ---------------------------------------------------------------------------

export interface ScenarioItem {
  text: string
  type: IncidentType
  /** Joint Damage Scale grade 0–3 (hidden from the agents). */
  grade: 0 | 1 | 2 | 3
  lat: number
  lon: number
  source: 'drone' | 'radio' | 'ground_report'
}

export const GRADE_URGENCY: Record<number, number> = { 0: 10, 1: 40, 2: 70, 3: 90 }

const at = (name: string): { lat: number; lon: number } => {
  const s = SECTORS.find((x) => x.name === name)!
  return { lat: s.lat, lon: s.lon }
}

export const SEED_ITEMS: ScenarioItem[] = [
  { text: 'Radio report: two-story building partially collapsed near the Downtown transit mall, four workers trapped, dust still settling', type: 'structural_collapse', grade: 3, source: 'radio', ...at('Downtown') },
  { text: 'Drone D1 spots an active fire front spreading through dry brush on the North Hills ridge, wind pushing flames toward homes', type: 'fire', grade: 3, source: 'drone', ...at('North Hills') },
  { text: 'Ammonia vapor cloud leaking from the Industrial Park rail gate, three workers coughing, plume drifting east with the wind', type: 'hazmat', grade: 2, source: 'radio', ...at('Industrial Park') },
  { text: 'Floodwater rising fast around the Riverfront marina, a family of four is trapped on a houseboat, water one meter from the deck', type: 'flood', grade: 2, source: 'radio', ...at('Riverfront') },
  { text: 'Multi-vehicle crash on the Eastside arterial, two passengers injured, one lane blocked', type: 'roadside_casualties', grade: 1, source: 'ground_report', ...at('Eastside') },
]

// Waves sit ≥1.6 km from any same-type seed, so they are distinct incidents, not merges.
export const WAVE_ITEMS: ScenarioItem[] = [
  { text: 'Fire spotting from the University lab block roof, smoke visible from two streets away, evacuation underway', type: 'fire', grade: 2, source: 'drone', ...at('University') },
  { text: 'Riverfront levee seeping at two points south of the marina, water over the toe of the levee, crews requesting sandbags', type: 'flood', grade: 1, source: 'drone', lat: 34.0275, lon: -118.233 },
  { text: 'Second collapse report from Downtown: a storefront awning gave way on the west side, one person injured, adjacent building evacuated', type: 'structural_collapse', grade: 1, source: 'ground_report', lat: 34.0555, lon: -118.2625 },
  { text: 'Chemical odor reported across the Industrial Park west perimeter, two residents feeling dizzy, possible second release', type: 'hazmat', grade: 1, source: 'ground_report', lat: 34.0305, lon: -118.2755 },
]

export const FOLLOWUP_TEXT =
  'Downtown update on the transit mall collapse: another victim located, now six workers trapped, one unconscious.'

function makeResource(
  id: string,
  type: ResourceType,
  name: string,
  zone: string,
  personnel: number,
  speedKph: number,
  note: string,
): Resource {
  const sector = SECTORS.find((s) => s.name === zone) ?? SECTORS[0]
  return {
    id,
    type,
    name,
    base_lat: sector.lat,
    base_lon: sector.lon,
    current_lat: null,
    current_lon: null,
    personnel,
    capacity_note: note,
    status: 'available',
    assigned_incident: null,
    role: '',
    speed_kph: speedKph,
  }
}

export function buildResources(): Resource[] {
  return [
    makeResource('res_fire1', 'fire_unit', 'Engine 1', 'Downtown', 6, 50, 'class-A pump, 1000L foam'),
    makeResource('res_fire2', 'fire_unit', 'Engine 2', 'Industrial Park', 6, 50, 'wildland-capable'),
    makeResource('res_amb1', 'ambulance', 'Ambulance A1', 'Downtown', 3, 55, ''),
    makeResource('res_amb2', 'ambulance', 'Ambulance A2', 'Eastside', 3, 55, ''),
    makeResource('res_amb3', 'ambulance', 'Ambulance A3', 'University', 3, 55, ''),
    makeResource('res_res1', 'rescue_team', 'USAR Team 1', 'Downtown', 12, 40, 'heavy rescue, concrete cutting'),
    makeResource('res_res2', 'rescue_team', 'Rescue 2', 'Eastside', 8, 40, 'rope + confined space'),
    makeResource('res_sw1', 'swift_water', 'Swift Water 1', 'Riverfront', 6, 45, 'boat + 6 swimmers'),
    makeResource('res_eng1', 'engineering', 'Engineering Squad', 'Industrial Park', 10, 35, 'crane + shoring'),
    makeResource('res_dr1', 'drone', 'Drone D1', 'Downtown', 2, 90, 'thermal camera'),
    makeResource('res_dr2', 'drone', 'Drone D2', 'North Hills', 2, 90, 'IR + zoom'),
    makeResource('res_haz1', 'hazmat_unit', 'Hazmat 1', 'Industrial Park', 8, 40, ''),
  ]
}
