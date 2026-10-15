import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { useAuth } from '../auth/AuthContext'
import { ApiError } from '../types'
import { useTheme } from '../lib/useTheme'

/** /demo — one click: the server creates a temporary guest account that owns a ready drill (the real xBD scenario
 *  with the real AI agents) and we open it. Already signed in? Just go to your drills; no second account is made. */
export default function DemoStart() {
  useTheme()
  const { user, loading, startDemo } = useAuth()
  const navigate = useNavigate()
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const started = useRef(-1)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  useEffect(() => {
    if (loading) return
    if (user && started.current < 0) { navigate('/drills', { replace: true }); return }     // arrived already signed in
    if (started.current === attempt) return                       // React StrictMode runs effects twice in development
    started.current = attempt
    // `mounted`, not a per-effect flag: signing in changes `user`, which re-runs this effect before the answer is used
    startDemo()
      .then((drillId) => mounted.current && navigate(`/drills/${drillId}`, { replace: true }))
      .catch((e) => mounted.current && setError(e instanceof ApiError ? e.message : 'Could not start the demo. Please try again.'))
  }, [loading, user, attempt, startDemo, navigate])

  return (
    <div className="flex min-h-dvh items-center justify-center bg-bg p-4 text-ink">
      <main id="main" className="w-full max-w-md rounded-lg border border-line bg-panel p-6 text-center shadow-panel">
        {error ? (
          <>
            <h1 className="text-xl font-bold">The demo could not start</h1>
            <p role="alert" className="mt-2 text-base text-ink-2">{error}</p>
            <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:justify-center">
              <button type="button" onClick={() => { setError(''); setAttempt((n) => n + 1) }} className="h-12 rounded-md bg-accent px-5 text-base font-bold text-bg hover:brightness-110">Try again</button>
              <Link to="/signup" className="inline-flex h-12 items-center justify-center rounded-md border border-line bg-hi px-5 text-base font-semibold hover:border-accent">Create an account</Link>
            </div>
          </>
        ) : (
          <div role="status">
            <Loader2 size={28} className="mx-auto animate-spin text-accent" aria-hidden />
            <h1 className="mt-3 text-xl font-bold">Setting up your demo drill…</h1>
            <p className="mt-1 text-base text-ink-2">A private practice drill with real damage data and the AI agents. It takes a few seconds.</p>
          </div>
        )}
      </main>
    </div>
  )
}
