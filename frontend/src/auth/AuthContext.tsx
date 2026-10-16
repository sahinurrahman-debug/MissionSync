import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { deleteAccount as apiDeleteAccount, fetchMe, signIn as apiSignIn, signOut as apiSignOut, signOutEverywhere as apiSignOutEverywhere, signUp as apiSignUp, startDemo as apiStartDemo, type User } from '../api/auth'
import { SESSION_LOST_EVENT } from '../api/http'
import { ApiError } from '../types'

/** `loading` while we ask the server who we are; `user` is null for a visitor. Only the server decides. */
interface AuthState {
  loading: boolean
  /** The server could not be reached (not "signed out"): ask again instead of sending the person to sign-in. */
  unreachable: boolean
  user: User | null
  signIn: (email: string, password: string) => Promise<void>
  signUp: (email: string, password: string, displayName: string) => Promise<void>
  signOut: () => Promise<void>
  signOutEverywhere: () => Promise<void>
  /** Delete the account and its drills (needs the password). */
  deleteAccount: (password: string) => Promise<void>
  /** Create a temporary guest account with its own drill; resolves with the drill to open. */
  startDemo: () => Promise<number>
}

const Ctx = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true)
  const [user, setUser] = useState<User | null>(null)
  const [unreachable, setUnreachable] = useState(false)
  const mounted = useRef(true)

  // On every page load the session cookie is verified by the server — nothing is trusted from localStorage.
  // A server that is waking up (or a dropped connection) is retried a few times: it is not the same as "signed out".
  useEffect(() => {
    mounted.current = true
    void (async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const u = await fetchMe()
          if (mounted.current) { setUser(u); setLoading(false) }
          return
        } catch (e) {
          const transient = !(e instanceof ApiError) || e.status === 0 || e.status >= 500
          if (!transient) break
          if (attempt === 2) {
            if (mounted.current) { setUnreachable(true); setLoading(false) }
            return
          }
          await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt))
          if (!mounted.current) return
        }
      }
      if (mounted.current) { setUser(null); setLoading(false) }
    })()
    return () => { mounted.current = false }
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

  const signOutEverywhere = useCallback(async () => {
    try {
      await apiSignOutEverywhere()
    } finally {
      setUser(null)
    }
  }, [])
  const deleteAccount = useCallback(async (password: string) => {
    await apiDeleteAccount(password)
    setUser(null)
  }, [])

  const value = useMemo(
    () => ({ loading, unreachable, user, signIn, signUp, signOut, signOutEverywhere, deleteAccount, startDemo }),
    [loading, unreachable, user, signIn, signUp, signOut, signOutEverywhere, deleteAccount, startDemo],
  )
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
