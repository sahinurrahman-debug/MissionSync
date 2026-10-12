import { request } from './http'

export interface User { id: number; email: string; display_name: string; created_at: string }

/** The signed-in user, or null when there is no valid session (a normal state, not an error). */
export async function fetchMe(): Promise<User | null> {
  try {
    return (await request<{ user: User }>('/api/auth/me', { quiet401: true })).user
  } catch (e) {
    if (e instanceof Error && 'status' in e && (e as { status: number }).status === 401) return null
    throw e
  }
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
