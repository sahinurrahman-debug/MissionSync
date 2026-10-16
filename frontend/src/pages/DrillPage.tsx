import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Loader2 } from 'lucide-react'
import { getDrill, type DrillSummary } from '../api/drills'
import { RemoteEngine, type LostReason } from '../api/remote'
import AccountMenu from '../components/AccountMenu'
import ErrorBoundary from '../components/ErrorBoundary'
import { useDocumentTitle } from '../lib/useDocumentTitle'
import { ApiError } from '../types'
import DrillBoard from './DrillBoard'
import MessagePage from './MessagePage'

const backLink = (
  <Link to="/drills" aria-label="Back to My Drills" className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-md border border-line bg-hi px-2.5 text-base font-semibold text-ink hover:border-accent sm:px-3">
    <ArrowLeft size={18} aria-hidden /><span className="max-sm:sr-only">Drills</span>
  </Link>
)

/** /drills/:id — the dashboard for one of YOUR drills. The server decides whether it is yours; a stranger's id is a 404. */
export default function DrillPage() {
  const { id } = useParams()
  const drillId = Number(id)
  const navigate = useNavigate()
  const [drill, setDrill] = useState<DrillSummary | null>(null)
  const [problem, setProblem] = useState<'missing' | 'failed' | null>(null)
  useDocumentTitle(drill?.name ?? 'Drill')

  useEffect(() => {
    let live = true
    setDrill(null)
    setProblem(null)
    if (!Number.isInteger(drillId) || drillId <= 0) { setProblem('missing'); return }
    getDrill(drillId)
      .then((d) => live && setDrill(d))
      .catch((e) => live && setProblem(e instanceof ApiError && e.status === 404 ? 'missing' : 'failed'))
    return () => { live = false }
  }, [drillId])

  const source = useMemo(() => {
    if (!drill) return null
    const onLost = (why: LostReason) => navigate(why === 'signed_out' ? '/login' : '/drills', { replace: true })
    return new RemoteEngine(drill.id, onLost)
  }, [drill, navigate])

  useEffect(() => {
    if (!source) return
    source.start()
    return () => source.stop()
  }, [source])

  if (problem === 'missing') {
    return <MessagePage title="That Drill Does Not Exist" body="It may have been deleted, or the link is wrong. Drills are private to the account that created them." action={{ to: '/drills', label: 'Back to My Drills' }} />
  }
  if (problem === 'failed') {
    return <MessagePage title="Could Not Open the Drill" body="The server did not answer. Check your connection and try again." action={{ to: `/drills/${drillId}`, label: 'Try Again', reload: true }} />
  }
  if (!drill || !source) {
    return (
      <div className="flex h-dvh items-center justify-center gap-3 bg-bg text-ink-2" role="status">
        <Loader2 size={18} className="animate-spin text-accent" aria-hidden /> Opening your drill…
      </div>
    )
  }
  return (
    <ErrorBoundary label="MissionSync" scope="app">
      <DrillBoard source={source} title={drill.name} leading={backLink} account={<AccountMenu />} railAccount={<AccountMenu variant="rail" />} />
    </ErrorBoundary>
  )
}
