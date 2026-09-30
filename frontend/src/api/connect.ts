// Picks the engine. No silent surprises:
//   VITE_API_URL set          → backend, always (an unreachable backend shows an offline banner)
//   ?engine=local             → the in-browser demo engine
//   otherwise                 → probe same-origin /api/health; reachable → backend,
//                               not reachable → the demo engine, labelled DEMO in the header
import type { DataSource } from '../source'
import { LocalEngine } from '../engine/local'
import { RemoteEngine } from './remote'

const PROBE_TIMEOUT_MS = 2500

export async function backendReachable(baseUrl: string): Promise<boolean> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS)
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/health`, { signal: ctl.signal })
    if (!res.ok) return false
    const body = await res.json()
    return body?.status === 'ok'
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

export async function createSource(): Promise<DataSource> {
  const params = new URLSearchParams(window.location.search)
  const configured = (import.meta.env.VITE_API_URL as string | undefined)?.trim() ?? ''

  if (params.get('engine') === 'local') return new LocalEngine()
  if (configured) return new RemoteEngine(configured)
  if (params.get('engine') === 'remote' || (await backendReachable(''))) return new RemoteEngine('')
  return new LocalEngine()
}
