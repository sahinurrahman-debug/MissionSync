import { request } from './http'

export interface User { id: number; email: string; display_name: string; created_at: string; is_guest?: boolean }

/** The signed-in user, or null for a visitor (a normal state — the probe answers 200, so nothing is logged as an error). */
export async function fetchMe(): Promise<User | null> {
  return (await request<{ user: User | null }>('/api/auth/session', { quiet401: true, timeoutMs: 12_000 })).user
}

export async function signUp(input: { email: string; password: string; display_name: string }): Promise<User> {
  return (await request<{ user: User }>('/api/auth/signup', { method: 'POST', json: input, quiet401: true })).user
}

export async function signIn(input: { email: string; password: string }): Promise<User> {
  return (await request<{ user: User }>('/api/auth/login', { method: 'POST', json: input, quiet401: true })).user
}

/** One click: the server creates a temporary guest account that owns a ready drill (real data, real agents). */
export async function startDemo(): Promise<{ user: User; drillId: number; hours: number }> {
  const r = await request<{ user: User; drill: { id: number }; expires_in_hours: number }>('/api/auth/demo', { method: 'POST', quiet401: true })
  return { user: r.user, drillId: r.drill.id, hours: r.expires_in_hours }
}

export async function signOut(): Promise<void> {
  await request('/api/auth/logout', { method: 'POST', quiet401: true })
}

/** Sign this account out on every device. */
export async function signOutEverywhere(): Promise<void> {
  await request('/api/auth/logout-all', { method: 'POST', quiet401: true })
}

/** Delete the account and all its drills for good. The password is asked again so a stolen session cannot do it. */
export async function deleteAccount(password: string): Promise<void> {
  await request('/api/auth/me', { method: 'DELETE', json: { password }, quiet401: true })
}
