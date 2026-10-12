import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { Suspense, lazy, type ReactNode } from 'react'
import { AuthProvider, useAuth } from './auth/AuthContext'
import AuthPage from './pages/AuthPage'
import MessagePage from './pages/MessagePage'

// The dashboard (map, animation library, agents) is the heavy part: the sign-in page must not pay for it.
const DemoPage = lazy(() => import('./pages/DemoPage'))
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
  const { user, loading } = useAuth()
  const location = useLocation()
  if (loading) return <Splash text="Checking your session…" />
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />
  return <>{children}</>
}

function Home() {
  const { user, loading } = useAuth()
  if (loading) return <Splash text="Loading MissionSync…" />
  return <Navigate to={user ? '/drills' : '/login'} replace />
}

export default function App() {
  // ?engine=local was the old way to ask for the demo
  if (new URLSearchParams(window.location.search).get('engine') === 'local' && window.location.pathname === '/') {
    window.history.replaceState(null, '', '/demo' + window.location.search.replace(/[?&]engine=local/, ''))
  }
  return (
    <BrowserRouter>
      <AuthProvider>
        <Suspense fallback={<Splash text="Loading…" />}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/login" element={<AuthPage mode="signin" />} />
          <Route path="/signup" element={<AuthPage mode="signup" />} />
          <Route path="/demo" element={<DemoPage />} />
          <Route path="/drills" element={<RequireAuth><DrillsPage /></RequireAuth>} />
          <Route path="/drills/:id" element={<RequireAuth><DrillPage /></RequireAuth>} />
          <Route path="*" element={<MessagePage title="Page not found" body="That address does not lead anywhere." action={{ to: '/', label: 'Go to the start' }} />} />
        </Routes>
        </Suspense>
      </AuthProvider>
    </BrowserRouter>
  )
}
