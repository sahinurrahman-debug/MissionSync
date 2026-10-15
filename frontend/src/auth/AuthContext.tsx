import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { fetchMe, signIn as apiSignIn, signOut as apiSignOut, signUp as apiSignUp, startDemo as apiStartDemo, type User } from '../api/auth'
import { SESSION_LOST_EVENT } from '../api/http'

/** `loading` while we ask the server who we are; `user` is null for a visitor. Only the server decides. */
interface AuthState {
  loading: boolean
  user: User | null
  signIn: (email: string, password: string) => Promise<void>
  signUp: (email: string, password: string, displayName: string) => Promise<void>
  signOut: () => Promise<void>
  /** Create a temporary guest account with its own drill; resolves with the drill to open. */
  startDemo: () => Promise<number>
}

const Ctx = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true)
  const [user, setUser] = useState<User | null>(null)

  // On every page load the session cookie is verified by the server — nothing is trusted from localStorage.
  useEffect(() => {
    let live = true
    fetchMe()
      .then((u) => live && setUser(u))
      .catch(() => live && setUser(null))
      .finally(() => live && setLoading(false))
    return () => { live = false }
  }, [])

  // Any 401 from the API (expired or revoked session) drops us back to the sign-in page.
  useEffect(() => {
    const lost = () => setUser(null)
    window.addEventListener(SESSION_LOST_EVENT, lost)
    return () => window.removeEventListener(SESSION_LOST_EVENT, lost)
  }, [])

  const signIn = useCallback(async (email: string, password: string) => setUser(await apiSignIn({ email, password })), [])
  const signUp = useCallback(async (email: string, password: string, display_name: string) => setUser(await apiSignUp({ email, password, display_name })), [])
  const startDemo = useCallback(async () => {
    const r = await apiStartDemo()
    setUser(r.user)
    return r.drillId
  }, [])
  const signOut = useCallback(async () => {
    try {
      await apiSignOut()
    } finally {
      setUser(null)
    }
  }, [])

  const value = useMemo(() => ({ loading, user, signIn, signUp, signOut, startDemo }), [loading, user, signIn, signUp, signOut, startDemo])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

/** The signed-in user (or null) — safe to call where there may be no provider, e.g. in a component test. */
export function useCurrentUser(): User | null {
  return useContext(Ctx)?.user ?? null
}

export function useAuth(): AuthState {
  const v = useContext(Ctx)
  if (!v) throw new Error('useAuth must be used inside <AuthProvider>')
  return v
}
