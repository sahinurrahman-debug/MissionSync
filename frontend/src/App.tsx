import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { Suspense, lazy, type ReactNode } from 'react'
import { AuthProvider, useAuth } from './auth/AuthContext'
import AuthPage from './pages/AuthPage'
import MessagePage from './pages/MessagePage'

import DemoStart from './pages/DemoStart'

// The dashboard (map, animation library) is the heavy part: the sign-in page must not pay for it.
const DrillPage = lazy(() => import('./pages/DrillPage'))
const DrillsPage = lazy(() => import('./pages/DrillsPage'))

function Splash({ text }: { text: string }) {
  return (
    <div className="flex h-dvh items-center justify-center gap-3 bg-bg text-ink-2" role="status">
      <Loader2 size={18} className="animate-spin text-accent" aria-hidden /> {text}
    </div>
  )
}

/** Protected route: visitors without a session are sent to sign-in and brought back afterwards. */
function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading, unreachable } = useAuth()
  const location = useLocation()
  if (loading) return <Splash text="Checking your session…" />
  if (unreachable) return <Unreachable />
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />
  return <>{children}</>
}

/** The server did not answer (it may be waking up): say so and offer another try — never pretend the person signed out. */
function Unreachable() {
  return <MessagePage title="Cannot Reach MissionSync" body="The server did not answer. It may be waking up — wait a few seconds and try again. You are still signed in." action={{ to: '/', label: 'Try Again', reload: true }} />
}

function Home() {
  const { user, loading, unreachable } = useAuth()
  if (loading) return <Splash text="Loading MissionSync…" />
  if (unreachable) return <Unreachable />
  return <Navigate to={user ? '/drills' : '/login'} replace />
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Suspense fallback={<Splash text="Loading…" />}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/login" element={<AuthPage mode="signin" />} />
          <Route path="/signup" element={<AuthPage mode="signup" />} />
          <Route path="/demo" element={<DemoStart />} />
          <Route path="/drills" element={<RequireAuth><DrillsPage /></RequireAuth>} />
          <Route path="/drills/:id" element={<RequireAuth><DrillPage /></RequireAuth>} />
          <Route path="*" element={<MessagePage title="Page Not Found" body="That address does not lead anywhere." action={{ to: '/', label: 'Go to the Start' }} />} />
        </Routes>
        </Suspense>
      </AuthProvider>
    </BrowserRouter>
  )
}
