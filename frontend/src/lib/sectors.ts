// The six named sectors of the drill area (the same names the server's scenario uses); drawn as labels on the map.
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
