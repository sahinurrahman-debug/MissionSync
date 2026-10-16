import { useEffect, useState, type FormEvent } from 'react'
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { Eye, EyeOff, Loader2, Radio, ShieldCheck, Users } from 'lucide-react'
import { useAuth } from '../auth/AuthContext'
import FormField from '../components/FormField'
import PageShell from '../components/PageShell'
import { ApiError } from '../types'
import { useDocumentTitle } from '../lib/useDocumentTitle'
import { useTheme } from '../lib/useTheme'

type Mode = 'signin' | 'signup'
type Errors = Partial<Record<'email' | 'password' | 'display_name', string>>

const EMAIL = /^[^@\s]{1,64}@[^@\s]+\.[^@\s]{2,}$/

/** The same rules the server enforces — checked here only so the message appears before a round trip. */
export function validate(mode: Mode, v: { email: string; password: string; name: string }): Errors {
  const e: Errors = {}
  if (!EMAIL.test(v.email.trim())) e.email = 'Enter a valid email address.'
  if (mode === 'signup') {
    if (!v.name.trim()) e.display_name = 'Enter your name.'
    if (v.password.length < 8) e.password = 'Use at least 8 characters.'
  } else if (!v.password) {
    e.password = 'Enter your password.'
  }
  return e
}

const POINTS = [
  { Icon: Radio, text: 'Type radio reports; AI agents rank incidents and suggest which unit to send.' },
  { Icon: ShieldCheck, text: 'You stay in charge: nothing is dispatched until you approve it.' },
  { Icon: Users, text: 'Every drill is private to your account.' },
]

export default function AuthPage({ mode }: { mode: Mode }) {
  useTheme()
  useDocumentTitle(mode === 'signup' ? 'Create Account' : 'Sign In')
  const { user, loading, signIn, signUp } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const next = (location.state as { from?: string } | null)?.from ?? '/drills'
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [show, setShow] = useState(false)
  const [errors, setErrors] = useState<Errors>({})
  const [formError, setFormError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => { setErrors({}); setFormError('') }, [mode])

  if (!loading && user) return <Navigate to={next} replace />

  const submit = async (ev: FormEvent) => {
    ev.preventDefault()
    const found = validate(mode, { email, password, name })
    setErrors(found)
    setFormError('')
    if (Object.keys(found).length) return
    setBusy(true)
    try {
      if (mode === 'signup') await signUp(email.trim(), password, name.trim())
      else await signIn(email.trim(), password)
      navigate(next, { replace: true })
    } catch (e) {
      if (e instanceof ApiError && Object.keys(e.fields).length) setErrors(e.fields as Errors)
      else setFormError(e instanceof ApiError ? e.message : 'Something went wrong. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  const signup = mode === 'signup'
  return (
    <PageShell>
      <main id="main" className="mx-auto grid w-full flex-1 max-w-5xl items-center gap-8 px-4 py-8 md:grid-cols-[1fr_minmax(0,26rem)]">
        <section className="grid gap-3 max-md:order-2 sm:grid-cols-3 md:grid-cols-1 lg:grid-cols-3">
          <div className="rounded-xl border border-line bg-panel p-5 shadow-panel sm:col-span-3 md:col-span-1 lg:col-span-3">
            <h1 className="text-3xl font-extrabold tracking-tight">Mission<span className="text-accent">Sync</span></h1>
            <p className="mt-2 max-w-md text-xl font-semibold leading-snug text-ink">A calm, ranked picture for emergency-response drills.</p>
          </div>
          <ul className="contents">
            {POINTS.map(({ Icon, text }) => (
              <li key={text} className="flex flex-col gap-3 rounded-xl border border-line bg-panel p-4 text-base text-ink-2 shadow-panel md:flex-row md:items-start lg:flex-col">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent" aria-hidden><Icon size={18} /></span>
                <span>{text}</span>
              </li>
            ))}
          </ul>
          <p className="rounded-xl border border-dashed border-line p-4 text-base text-ink-2 sm:col-span-3 md:col-span-1 lg:col-span-3">
            Just looking? <Link to="/demo" state={{ start: true }} className="font-semibold text-accent underline underline-offset-4">Try the Demo</Link> — one click gives you a temporary private drill with real data and the AI agents. No form to fill in.
          </p>
        </section>

        <section aria-labelledby="auth-title" className="rounded-xl border border-line bg-panel p-5 shadow-panel">
          <div role="tablist" aria-label="Account" className="mb-4 grid grid-cols-2 gap-1 rounded-md border border-line bg-bg p-1">
            {(['signin', 'signup'] as const).map((m) => (
              <Link
                key={m}
                to={m === 'signin' ? '/login' : '/signup'}
                state={location.state}
                role="tab"
                aria-selected={mode === m}
                className={`flex h-11 items-center justify-center rounded text-base font-semibold ${mode === m ? 'bg-accent text-bg' : 'text-ink-2 hover:text-ink'}`}
              >
                {m === 'signin' ? 'Sign In' : 'Create Account'}
              </Link>
            ))}
          </div>
          <h2 id="auth-title" className="sr-only">{signup ? 'Create Your Account' : 'Sign In to Your Account'}</h2>

          <form onSubmit={submit} noValidate className="space-y-3.5">
            {signup && (
              <FormField label="Your Name" value={name} onChange={(e) => setName(e.target.value)} error={errors.display_name} autoComplete="name" maxLength={80} />
            )}
            <FormField label="Email" type="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} error={errors.email} autoComplete="email" autoCapitalize="none" />
            <FormField
              label="Password"
              type={show ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              error={errors.password}
              hint={signup ? 'At least 8 characters.' : undefined}
              autoComplete={signup ? 'new-password' : 'current-password'}
              trailing={
                <button type="button" onClick={() => setShow((v) => !v)} aria-pressed={show} className="inline-flex h-11 items-center gap-1.5 px-1 text-sm font-semibold text-ink-2 hover:text-ink">
                  {show ? <EyeOff size={16} aria-hidden /> : <Eye size={16} aria-hidden />}{show ? 'Hide' : 'Show'}
                </button>
              }
            />
            {formError && <p role="alert" className="rounded-md border border-p1/50 bg-p1/10 px-3 py-2 text-base text-ink">{formError}</p>}
            <button type="submit" disabled={busy} className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-md bg-accent text-base font-bold text-bg transition hover:brightness-110 disabled:opacity-60">
              {busy && <Loader2 size={18} className="animate-spin" aria-hidden />}
              {busy ? (signup ? 'Creating Your Account…' : 'Signing In…') : signup ? 'Create Account' : 'Sign In'}
            </button>
          </form>
        </section>
      </main>
    </PageShell>
  )
}
