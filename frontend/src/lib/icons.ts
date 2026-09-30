import {
  Ambulance, Biohazard, Building2, Car, FlaskConical, Flame, HardHat, HeartPulse, LifeBuoy, Mountain, Plane,
  Search, Waves, type LucideIcon,
} from 'lucide-react'
import type { IncidentType, ResourceType } from '../types'

export const INCIDENT_ICON: Record<IncidentType, LucideIcon> = {
  fire: Flame,
  flood: Waves,
  structural_collapse: Building2,
  medical: HeartPulse,
  hazmat: Biohazard,
  landslide: Mountain,
  missing_persons: Search,
  roadside_casualties: Car,
}

export const RESOURCE_ICON: Record<ResourceType, LucideIcon> = {
  fire_unit: Flame,
  ambulance: Ambulance,
  rescue_team: LifeBuoy,
  swift_water: Waves,
  engineering: HardHat,
  drone: Plane,
  hazmat_unit: FlaskConical,
}
