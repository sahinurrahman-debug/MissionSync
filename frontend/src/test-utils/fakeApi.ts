// An in-memory stand-in for the MissionSync API, installed as `fetch`, so page tests exercise the real
// client code (cookies, error shapes, optimistic updates) without a server.
import { vi } from 'vitest'

export interface FakeDrill { id: number; name: string; notes: string; status: 'new' | 'live' | 'ended'; dataset: string; created_at: string; updated_at: string; events: number; reports: number }

const json = (body: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const fail = (status: number, code: string, error: string, details: unknown[] = []) => json({ error, code, details, request_id: 'req_test' }, status)

export class FakeApi {
  signedIn: { id: number; email: string; display_name: string; created_at: string; is_guest?: boolean } | null = null
  demoFails = false
  accounts = new Map<string, { password: string; name: string }>()
  drills: FakeDrill[] = []
  nextId = 1
  /** Delay (ms) before the server answers drill writes — lets a test look at the optimistic state. */
  delay = 0
  /** Make the next write of this kind fail with this response. */
  failNext: Record<string, Response | undefined> = {}
  calls: Array<{ method: string; path: string; body: unknown }> = []

  install(): this {
    vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit = {}) => this.handle(url, init)))
    return this
  }

  addAccount(email: string, password: string, name = 'Ann Tester'): void {
    this.accounts.set(email, { password, name })
  }

  signIn(email = 'ann@example.com', name = 'Ann Tester'): void {
    this.signedIn = { id: 1, email, display_name: name, created_at: new Date().toISOString() }
  }

  seed(...names: string[]): void {
    for (const name of names) this.drills.push(this.make(name))
  }

  private make(name: string, notes = ''): FakeDrill {
    const now = new Date().toISOString()
    return { id: this.nextId++, name, notes, status: 'new', dataset: '', created_at: now, updated_at: now, events: 0, reports: 0 }
  }

  private async handle(url: string, init: RequestInit): Promise<Response> {
    const method = (init.method ?? 'GET').toUpperCase()
    const body = init.body ? JSON.parse(String(init.body)) : undefined
    this.calls.push({ method, path: url, body })
    const key = `${method} ${url.replace(/\/\d+/g, '/:id')}`

    if (key === 'GET /api/auth/session') return json({ user: this.signedIn })
    if (key === 'GET /api/auth/me') return this.signedIn ? json({ user: this.signedIn }) : fail(401, 'unauthorized', 'Please sign in to continue.')
    if (key === 'POST /api/auth/login') {
      const acc = this.accounts.get(String(body.email).trim().toLowerCase())
      if (!acc || acc.password !== body.password) {
        const msg = 'That email and password do not match.'
        return fail(401, 'unauthorized', msg, [{ field: 'password', issue: msg }])
      }
      this.signIn(String(body.email).toLowerCase(), acc.name)
      return json({ user: this.signedIn })
    }
    if (key === 'POST /api/auth/signup') {
      if (this.accounts.has(body.email)) {
        const msg = 'An account with this email already exists. Try signing in instead.'
        return fail(409, 'conflict', msg, [{ field: 'email', issue: msg }])
      }
      this.addAccount(body.email, body.password, body.display_name)
      this.signIn(body.email, body.display_name)
      return json({ user: this.signedIn }, 201)
    }
    if (key === 'POST /api/auth/demo') {
      if (this.demoFails) return fail(503, 'degraded', 'The demo is busy right now. Please try again in a few minutes, or create a free account.')
      const d = this.make('Demo drill', 'Real xBD damage scenarios with the AI agents. This temporary account is deleted after 24 hours.')
      this.drills.push(d)
      this.signedIn = { id: 99, email: 'guest-ab12cd@guest.missionsync.invalid', display_name: 'Demo guest', created_at: new Date().toISOString(), is_guest: true }
      return json({ user: this.signedIn, drill: d, expires_in_hours: 24 }, 201)
    }
    if (key === 'POST /api/auth/logout') {
      this.signedIn = null
      return json(null, 204)
    }

    if (!this.signedIn) return fail(401, 'unauthorized', 'Please sign in to continue.')
    if (this.delay) await new Promise((r) => setTimeout(r, this.delay))
    const forced = this.failNext[key]
    if (forced) {
      this.failNext[key] = undefined
      return forced.clone()
    }

    if (key === 'GET /api/drills') return json({ drills: [...this.drills].reverse(), limit: 10 })
    if (key === 'POST /api/drills') {
      if (!String(body.name).trim()) return fail(400, 'validation_error', 'Invalid name.', [{ field: 'name', issue: 'Give the drill a name.' }])
      const d = this.make(String(body.name).trim(), body.notes ?? '')
      this.drills.push(d)
      return json({ drill: d }, 201)
    }
    const m = /^\/api\/drills\/(\d+)$/.exec(url)
    if (m) {
      const d = this.drills.find((x) => x.id === Number(m[1]))
      if (!d) return fail(404, 'not_found', 'That drill does not exist.')
      if (method === 'GET') return json({ drill: d })
      if (method === 'PATCH') { Object.assign(d, body); return json({ drill: d }) }
      if (method === 'DELETE') { this.drills = this.drills.filter((x) => x !== d); return json(null, 204) }
    }
    const snap = /^\/api\/drills\/(\d+)\/snapshot$/.exec(url)
    if (snap) {
      if (!this.drills.some((x) => x.id === Number(snap[1]))) return fail(404, 'not_found', 'That drill does not exist.')
      return new Promise<Response>(() => undefined)               // a real server would answer; these tests only need the page to open
    }
    return fail(404, 'not_found', 'No such endpoint.')
  }
}
