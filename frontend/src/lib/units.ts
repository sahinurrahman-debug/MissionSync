// Which units can serve which incidents, and how long they take to get there. Mirrors the server's capability
// matrix (backend/missionsync/agents.py) so the "Send a unit…" menu only offers units the server would accept.
import type { Incident, IncidentType, Resource } from '../types'
import { haversineKm, round1 } from './geo'

export function requiredFor(type: IncidentType): string[] {
  switch (type) {
    case 'fire': return ['fire_unit']
    case 'flood': return ['swift_water', 'rescue_team']
    case 'structural_collapse': return ['rescue_team', 'ambulance', 'engineering']
    case 'medical': return ['ambulance']
    case 'hazmat': return ['hazmat_unit', 'fire_unit']
    case 'landslide': return ['rescue_team', 'engineering']
    case 'missing_persons': return ['drone', 'rescue_team']
    case 'roadside_casualties': return ['ambulance', 'fire_unit']
    default: return ['rescue_team']
  }
}

/** Capable = in the capability matrix, or a drone (universal recon). */
export function isCapable(resource: Resource, incident: Incident): boolean {
  return requiredFor(incident.type).includes(resource.type) || resource.type === 'drone'
}

export function etaMinutes(resource: Resource, incident: Incident): number {
  const dist = haversineKm(
    resource.current_lat ?? resource.base_lat,
    resource.current_lon ?? resource.base_lon,
    incident.lat,
    incident.lon,
  )
  return round1((dist / Math.max(resource.speed_kph, 1.0)) * 60.0)
}
