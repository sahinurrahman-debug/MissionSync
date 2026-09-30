// Scenario data for the fictional city of Riverton — a faithful port of the
// Level-1 prototype's simulator constants (simulator.py). Sectors, terrain,
// weather, and the resource inventory are identical, so the PRD's drill
// picture is preserved exactly.

import type { Resource, ResourceType, TerrainCell, WeatherCell } from '../types'

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

export const TERRAIN: Record<string, TerrainCell> = {
  Downtown: { zone: 'Downtown', elevation_m: 85, slope_deg: 2, landcover: 'urban', road_access: 'good', notes: 'dense high-rise, narrow alleys' },
  Riverfront: { zone: 'Riverfront', elevation_m: 42, slope_deg: 3, landcover: 'water', road_access: 'degraded', notes: 'river levee, flood-prone low ground' },
  'North Hills': { zone: 'North Hills', elevation_m: 310, slope_deg: 18, landcover: 'forest', road_access: 'degraded', notes: 'single access road, dry brush' },
  'Industrial Park': { zone: 'Industrial Park', elevation_m: 55, slope_deg: 1, landcover: 'industrial', road_access: 'good', notes: 'chemical storage depots, rail spur' },
  Eastside: { zone: 'Eastside', elevation_m: 70, slope_deg: 4, landcover: 'suburban', road_access: 'good', notes: 'schools and care homes in grid' },
  University: { zone: 'University', elevation_m: 95, slope_deg: 6, landcover: 'urban', road_access: 'good', notes: 'high daytime population, labs on campus' },
}

export const WEATHER: Record<string, WeatherCell> = {
  'North Hills': { zone: 'North Hills', wind_kph: 38, wind_direction_deg: 210, precipitation_mm_h: 0, temperature_c: 34, alert: 'red_flag_wind', forecast_note: 'gusting to 50 kph by hour 2' },
  Riverfront: { zone: 'Riverfront', wind_kph: 14, wind_direction_deg: 180, precipitation_mm_h: 12, temperature_c: 19, alert: 'flood_watch', forecast_note: 'rain intensifying, river at 85% capacity' },
  Downtown: { zone: 'Downtown', wind_kph: 16, wind_direction_deg: 200, precipitation_mm_h: 2, temperature_c: 24, alert: null, forecast_note: '' },
  'Industrial Park': { zone: 'Industrial Park', wind_kph: 18, wind_direction_deg: 230, precipitation_mm_h: 1, temperature_c: 23, alert: null, forecast_note: '' },
  Eastside: { zone: 'Eastside', wind_kph: 12, wind_direction_deg: 190, precipitation_mm_h: 3, temperature_c: 25, alert: null, forecast_note: '' },
  University: { zone: 'University', wind_kph: 15, wind_direction_deg: 200, precipitation_mm_h: 2, temperature_c: 24, alert: null, forecast_note: '' },
}

export const WEATHER_LIST: WeatherCell[] = Object.values(WEATHER)

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
