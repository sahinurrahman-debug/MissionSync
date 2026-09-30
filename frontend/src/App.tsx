import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { Loader2 } from 'lucide-react'
import { createSource } from './api/connect'
import type { DataSource } from './source'
import { useMedia } from './lib/useMedia'
import ErrorBoundary from './components/ErrorBoundary'
import FleetAndLog from './components/FleetAndLog'
import HeaderHud, { EngineChips, TelemetryChips } from './components/HeaderHud'
import IncidentFeed from './components/IncidentFeed'
import MapPanel from './components/MapPanel'
import MobileTabs, { type MobileTab } from './components/MobileTabs'
import Recommendations from './components/Recommendations'
import ReportIntake from './components/ReportIntake'
import SystemBanners from './components/SystemBanners'

function useTheme() {
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    // ?theme=light wins (handy for screenshots/tests), then the saved choice.
    const qs = new URLSearchParams(window.location.search).get('theme')
    if (qs === 'light' || qs === 'dark') return qs
    try {
      const saved = localStorage.getItem('ms-theme')
      return saved === 'light' || saved === 'dark' ? saved : 'dark'
    } catch {
      return 'dark'
    }
  })
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try {
      localStorage.setItem('ms-theme', theme)
    } catch {
      /* storage blocked: the theme still applies for this visit */
    }
  }, [theme])
  return { theme, toggle: () => setTheme((t) => (t === 'dark' ? 'light' : 'dark')) }
}

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
    <ErrorBoundary label="MissionSync">
      <Board source={source} />
    </ErrorBoundary>
  )
}

function Board({ source }: { source: DataSource }) {
  const subscribe = useCallback((cb: () => void) => source.subscribe(cb), [source])
  const snap = useSyncExternalStore(subscribe, () => source.getSnapshot())
  const { theme, toggle } = useTheme()
  const desktop = useMedia('(min-width: 1024px)')
  const [selected, setSelected] = useState<string | null>(null)
  const [showUnits, setShowUnits] = useState(true)
  const [resetting, setResetting] = useState(false)
  const [tab, setTab] = useState<MobileTab>('feed')

  const m = snap.metrics
  const loading = snap.status !== 'live'
  const offline = snap.engine === 'remote' && snap.connection === 'offline'
  const p1p2 = snap.incidents.filter((i) => i.risk?.tier === 'P1' || i.risk?.tier === 'P2').length
  const exportUrl =
    source.exportUrl && m.drill_id != null && m.database !== 'disabled' && m.database !== 'error' ? source.exportUrl(m.drill_id) : null

  const doReset = async () => {
    if (resetting) return
    setResetting(true)
    setSelected(null)
    try {
      await source.reset()
    } catch {
      /* the banner already reports connectivity problems */
    } finally {
      setResetting(false)
    }
  }

  const select = (id: string | null) => {
    setSelected(id)
  }

  const map = (
    <ErrorBoundary label="The map">
      <MapPanel
        incidents={snap.incidents}
        resources={showUnits ? snap.resources : []}
        selectedId={selected}
        onSelect={select}
        theme={theme}
        loading={loading}
      />
    </ErrorBoundary>
  )
  const feed = (
    <ErrorBoundary label="The incident feed">
      <IncidentFeed incidents={snap.incidents} resources={snap.resources} selectedId={selected} onSelect={select} loading={loading} />
    </ErrorBoundary>
  )
  const orders = (
    <ErrorBoundary label="Command recommendations">
      <Recommendations actions={snap.actions} loading={loading} />
    </ErrorBoundary>
  )
  const intake = (
    <ErrorBoundary label="Report intake" compact>
      <ReportIntake
        onInject={(text) => source.injectReport(text)}
        onSample={() => source.nextSampleReport()}
        stage={snap.pipeline.stage}
        disabled={offline || loading}
      />
    </ErrorBoundary>
  )
  const fleet = <FleetAndLog snap={snap} loading={loading} injections={m.injections} />

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-bg text-ink">
      <HeaderHud
        snap={snap}
        theme={theme}
        onToggleTheme={toggle}
        showUnits={showUnits}
        onToggleUnits={() => setShowUnits((v) => !v)}
        onReset={doReset}
        resetting={resetting}
        exportUrl={exportUrl}
      />

      {/* Telemetry for screens too narrow to show it in the HUD */}
      <div className="no-scrollbar flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-line bg-panel px-3 py-1.5 xl:hidden" aria-label="Drill telemetry">
        <EngineChips snap={snap} className="flex md:hidden" />
        <TelemetryChips m={m} snap={snap} />
      </div>

      <SystemBanners snap={snap} />

      {desktop ? (
        <main className="grid min-h-0 flex-1 grid-cols-[55fr_45fr] gap-2 p-2">
          <div className="flex min-h-0 flex-col gap-2">
            <div className="relative min-h-0 flex-[48] overflow-hidden rounded-lg border border-line">{map}</div>
            <div className="min-h-0 flex-[52]">{feed}</div>
          </div>
          <div className="flex min-h-0 flex-col gap-2">
            <div className="min-h-0 flex-[46]">{orders}</div>
            <div className="shrink-0">{intake}</div>
            <div className="min-h-0 flex-[36]">{fleet}</div>
          </div>
        </main>
      ) : (
        <>
          <main className="min-h-0 flex-1 p-2">
            <div className={tab === 'map' ? 'relative h-full overflow-hidden rounded-lg border border-line' : 'hidden'}>{map}</div>
            {tab === 'feed' && <div className="h-full">{feed}</div>}
            {tab === 'orders' && <div className="h-full">{orders}</div>}
            {tab === 'report' && <div className="flex h-full flex-col gap-2 overflow-y-auto">{intake}<div className="min-h-[260px] flex-1">{fleet}</div></div>}
            {tab === 'fleet' && <div className="h-full">{fleet}</div>}
          </main>
          <MobileTabs tab={tab} onChange={setTab} badge={{ feed: p1p2 }} />
        </>
      )}
    </div>
  )
}
