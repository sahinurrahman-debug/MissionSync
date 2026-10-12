import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { createSource } from './api/connect'
import type { DataSource } from './source'
import ErrorBoundary from './components/ErrorBoundary'
import DrillBoard from './pages/DrillBoard'

/** Picks the engine (backend or demo), then renders the board once it is ready. */
export default function App() {
  const [source, setSource] = useState<DataSource | null>(null)

  useEffect(() => {
    let cancelled = false
    let started: DataSource | null = null
    void createSource().then((s) => {
      if (cancelled) return
      started = s
      s.start()
      setSource(s)
    })
    return () => {
      cancelled = true
      started?.stop()
    }
  }, [])

  if (!source) {
    return (
      <div className="flex h-dvh items-center justify-center gap-3 bg-bg text-ink-2" role="status">
        <Loader2 size={18} className="animate-spin text-accent" aria-hidden /> Connecting to MissionSync…
      </div>
    )
  }
  return (
    <ErrorBoundary label="MissionSync" scope="app">
      <DrillBoard source={source} />
    </ErrorBoundary>
  )
}
