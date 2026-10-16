// The one place that talks HTTP. Cookies carry the session (same origin, httpOnly — JavaScript never sees the token).
import { ApiError } from '../types'

const REQUEST_TIMEOUT_MS = 90_000      // a real LLM pipeline can take a while

/* eslint-disable @typescript-eslint/no-explicit-any */

export async function parseError(res: Response): Promise<ApiError> {
  let body: any = null
  try {
    body = await res.json()
  } catch {
    /* non-JSON error page */
  }
  const retry = Number(res.headers.get('Retry-After'))
  const message = typeof body?.error === 'string' ? body.error : `The server answered ${res.status}.`
  const fields: Record<string, string> = {}
  for (const d of Array.isArray(body?.details) ? body.details : []) {
    if (d?.field && typeof d.issue === 'string' && !(d.field in fields)) fields[d.field] = d.issue
  }
  return new ApiError(message, body?.code ?? 'internal_error', res.status, body?.request_id, Number.isFinite(retry) && retry > 0 ? retry : undefined, fields)
}

/** Fired when the server says the session is gone (a 401 anywhere), so the app can send you back to sign-in. */
export const SESSION_LOST_EVENT = 'ms:session-lost'

export async function request<T = any>(path: string, init: RequestInit & { json?: unknown; quiet401?: boolean; timeoutMs?: number } = {}): Promise<T> {
  const { json, quiet401, timeoutMs, headers, ...rest } = init
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs ?? REQUEST_TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(path, {
      ...rest,
      credentials: 'include',
      body: json === undefined ? rest.body : JSON.stringify(json),
      signal: ctl.signal,
      headers: { ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(headers ?? {}) },
    })
  } catch (e) {
    const aborted = e instanceof DOMException && e.name === 'AbortError'
    throw new ApiError(
      aborted ? 'The server took too long to answer.' : 'Cannot reach the MissionSync server. Check your connection and try again.',
      aborted ? 'timeout' : 'network_error',
      0,
    )
  } finally {
    clearTimeout(timer)
  }
  if (!res.ok) {
    const err = await parseError(res)
    if (res.status === 401 && !quiet401 && typeof window !== 'undefined') window.dispatchEvent(new Event(SESSION_LOST_EVENT))
    throw err
  }
  return res.status === 204 ? (undefined as T) : res.json()
}
