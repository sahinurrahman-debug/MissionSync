import { request } from './http'

export interface DrillSummary {
  id: number
  name: string
  notes: string
  status: 'new' | 'live' | 'ended'
  dataset: string
  created_at: string | null
  updated_at: string | null
  events: number
  reports: number
}

export async function listDrills(): Promise<{ drills: DrillSummary[]; limit: number }> {
  return request('/api/drills')
}

export async function createDrill(input: { name: string; notes?: string }): Promise<DrillSummary> {
  return (await request<{ drill: DrillSummary }>('/api/drills', { method: 'POST', json: input })).drill
}

export async function getDrill(id: number): Promise<DrillSummary> {
  return (await request<{ drill: DrillSummary }>(`/api/drills/${id}`)).drill
}

export async function updateDrill(id: number, patch: { name?: string; notes?: string }): Promise<DrillSummary> {
  return (await request<{ drill: DrillSummary }>(`/api/drills/${id}`, { method: 'PATCH', json: patch })).drill
}

export async function deleteDrill(id: number): Promise<void> {
  await request(`/api/drills/${id}`, { method: 'DELETE' })
}
