// Geospatial helpers — ports of the Level-1 prototype's math so the browser
// engine ranks and routes exactly like the backend did.

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371.0
  const p1 = toRad(lat1)
  const p2 = toRad(lat2)
  const dp = toRad(lat2 - lat1)
  const dl = toRad(lon2 - lon1)
  const a =
    Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

export function toRad(deg: number): number {
  return (deg * Math.PI) / 180
}

export function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x))
}

export function clamp100(x: number): number {
  return Math.max(0, Math.min(100, x))
}

export function round1(x: number): number {
  return Math.round(x * 10) / 10
}
