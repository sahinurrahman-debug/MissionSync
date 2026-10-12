import { useEffect, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { LocalEngine } from '../engine/local'
import ErrorBoundary from '../components/ErrorBoundary'
import DrillBoard from './DrillBoard'

/** /demo — the whole dashboard running in your browser with rule-based agents. No account, nothing is saved. */
export default function DemoPage() {
  const source = useMemo(() => new LocalEngine(), [])
  useEffect(() => {
    source.start()
    return () => source.stop()
  }, [source])
  return (
    <ErrorBoundary label="MissionSync" scope="app">
      <DrillBoard
        source={source}
        title="Demo (not saved)"
        leading={
          <Link to="/" aria-label="Back to the home page" className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-md border border-line bg-hi px-2.5 text-base font-semibold text-ink hover:border-accent sm:px-3">
            <ArrowLeft size={18} aria-hidden /><span className="max-sm:sr-only">Home</span>
          </Link>
        }
      />
    </ErrorBoundary>
  )
}
