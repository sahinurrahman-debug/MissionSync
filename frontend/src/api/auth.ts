import { request } from './http'

export interface User { id: number; email: string; display_name: string; created_at: string }

/** The signed-in user, or null for a visitor (a normal state — the probe answers 200, so nothing is logged as an error). */
export async function fetchMe(): Promise<User | null> {
  return (await request<{ user: User | null }>('/api/auth/session', { quiet401: true })).user
}

export async function signUp(input: { email: string; password: string; display_name: string }): Promise<User> {
  return (await request<{ user: User }>('/api/auth/signup', { method: 'POST', json: input, quiet401: true })).user
}

export async function signIn(input: { email: string; password: string }): Promise<User> {
  return (await request<{ user: User }>('/api/auth/login', { method: 'POST', json: input, quiet401: true })).user
}

export async function signOut(): Promise<void> {
  await request('/api/auth/logout', { method: 'POST', quiet401: true })
}
