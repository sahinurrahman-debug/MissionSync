import { Suspense, lazy, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Loader2, ScrollText, Truck } from 'lucide-react'
import { createSource } from './api/connect'
import type { DataSource } from './source'
import { ApiError } from './types'
import { useMedia } from './lib/useMedia'
import ActionToast, { type ToastMessage } from './components/ActionToast'
import AdminKeyDialog from './components/AdminKeyDialog'
import ErrorBoundary from './components/ErrorBoundary'
import EventLog from './components/EventLog'
import FleetAndLog from './components/FleetAndLog'
import HeaderHud from './components/HeaderHud'
import IncidentFeed from './components/IncidentFeed'
import ResourceBoard from './components/ResourceBoard'
import { FleetSkeleton } from './components/Skeletons'
import { Panel, PanelHeader } from './components/ui'
import MobileTabs, { type MobileTab } from './components/MobileTabs'
import SideNav, { VIEWS, type View } from './components/SideNav'
import Recommendations from './components/Recommendations'
import ReportIntake from './components/ReportIntake'
import SystemBanners from './components/SystemBanners'

// Leaflet is ~90 KB gzipped: load it after first paint so the shell appears sooner (most of all on phones).
const loadMap = () => import('./components/MapPanel')
const MapPanel = lazy(loadMap)
// Desktop opens on the map: start fetching it immediately, in parallel with the rest of the app.
// Phones open on the feed, so the map waits until the browser is idle.
if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
  if (window.matchMedia('(min-width: 1024px)').matches) void loadMap()
  else (window.requestIdleCallback ?? ((f: () => void) => setTimeout(f, 1500)))(() => void loadMap())
}

function MapFallback() {
  return <div className="h-full w-full animate-pulse bg-hi" role="status" aria-label="Loading the map" />
}

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
    <ErrorBoundary label="MissionSync" scope="app">
      <Board source={source} />
    </ErrorBoundary>
  )
}

function describeError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'rate_limited') return `Too many actions — try again in ${e.retryAfterS ?? 2}s.`
    if (e.code === 'network_error' || e.code === 'timeout') return e.message
    return `${e.message}${e.requestId ? ` (ref ${e.requestId})` : ''}`
  }
  return 'That did not work — the board keeps running. Try again.'
}

function Board({ source }: { source: DataSource }) {
  const subscribe = useCallback((cb: () => void) => source.subscribe(cb), [source])
  const snap = useSyncExternalStore(subscribe, () => source.getSnapshot())
  const { theme, toggle } = useTheme()
  const desktop = useMedia('(min-width: 1024px)')
  const [selected, setSelected] = useState<string | null>(null)
  const [showUnits, setShowUnits] = useState(true)
  const [busy, setBusy] = useState(false)
  const [tab, setTab] = useState<MobileTab>('feed')
  const [view, setViewState] = useState<View>(() => {
    const qs = new URLSearchParams(window.location.search).get('view')       // ?view=orders (links, screenshots)
    if (VIEWS.some((v) => v.id === qs)) return qs as View
    try {
      const saved = localStorage.getItem('ms-view')
      return VIEWS.some((v) => v.id === saved) ? (saved as View) : 'situation'
    } catch {
      return 'situation'
    }
  })
  const setView = useCallback((v: View) => {
    setViewState(v)
    try {
      localStorage.setItem('ms-view', v)
    } catch {
      /* the choice just isn't remembered */
    }
  }, [])
  const [toast, setToast] = useState<ToastMessage | null>(null)
  const [adminPrompt, setAdminPrompt] = useState<{ label: string; run: () => Promise<void>; rejected: boolean } | null>(null)
  const toastId = useRef(0)

  const m = snap.metrics
  const loading = snap.status === 'booting'
  const ended = snap.status === 'ended'
  const offline = snap.engine === 'remote' && snap.connection === 'offline'
  const p1p2 = snap.incidents.filter((i) => i.risk?.tier === 'P1' || i.risk?.tier === 'P2').length
  const exportUrl =
    source.exportUrl && m.drill_id != null && m.database !== 'disabled' && m.database !== 'error' ? source.exportUrl(m.drill_id) : null
  const autoDispatch = snap.settings.auto_dispatch
  const inputsLocked = offline || loading || ended

  const notify = useCallback((tone: ToastMessage['tone'], text: string) => {
    toastId.current += 1
    setToast({ id: toastId.current, tone, text })
  }, [])

  // 1-4 jump between sections (desktop), unless the user is typing.
  useEffect(() => {
    if (!desktop) return
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || adminPrompt) return
      const t = e.target as HTMLElement | null
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return
      const v = VIEWS[Number(e.key) - 1]
      if (v) setView(v.id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [desktop, adminPrompt, setView])

  /** Runs a net-control action. Protected actions that the server refuses ask for the admin key once. */
  const act = useCallback(async (label: string, run: () => Promise<void>, opts: { admin?: boolean; ok?: string; retry?: boolean } = {}) => {
    setBusy(true)
    try {
      await run()
      if (opts.ok) notify('ok', opts.ok)
    } catch (e) {
      if (opts.admin && e instanceof ApiError && e.status === 401) {
        setAdminPrompt({ label, run, rejected: Boolean(opts.retry) })
      } else {
        notify('error', describeError(e))
      }
    } finally {
      setBusy(false)
    }
  }, [notify])

  const submitAdminKey = (key: string) => {
    const pending = adminPrompt
    if (!pending) return
    source.setAdminKey?.(key)
    setAdminPrompt(null)
    void act(pending.label, pending.run, { admin: true, retry: true })
  }

  const doReset = () => {
    if (busy) return
    setSelected(null)
    void act('Restart the drill', () => source.reset(), { admin: true, ok: 'Drill restarted.' })
  }
  const doEnd = () => {
    if (busy || !window.confirm('End the drill? The picture freezes for after-action review. You can restart it afterwards.')) return
    void act('End the drill', () => source.endDrill(), { admin: true, ok: 'Drill ended.' })
  }
  const doToggleAuto = () =>
    void act('Change the dispatch mode', () => source.setAutoDispatch(!autoDispatch), {
      admin: true,
      ok: autoDispatch ? 'Dispatch is manual: recommendations wait for your approval.' : 'Auto-dispatch (demo) is on.',
    })

  const actions = {
    onRecall: (id: string) => void act('Recall', () => source.recall(id)),
    onResolve: (id: string, status: 'contained' | 'closed') =>
      void act('Update incident', () => source.resolveIncident(id, status), { ok: status === 'closed' ? 'Incident closed.' : 'Incident marked contained.' }),
    onDispatch: (incidentId: string, resourceId: string) => void act('Dispatch', () => source.dispatchManual(incidentId, resourceId), { ok: 'Unit dispatched.' }),
  }

  const map = (
    <ErrorBoundary label="The map">
      <Suspense fallback={<MapFallback />}>
      <MapPanel
        incidents={snap.incidents}
        resources={showUnits ? snap.resources : []}
        selectedId={selected}
        onSelect={setSelected}
        theme={theme}
        loading={loading}
      />
      </Suspense>
    </ErrorBoundary>
  )
  const feed = (
    <ErrorBoundary label="The incident feed">
      <IncidentFeed
        incidents={snap.incidents}
        resources={snap.resources}
        proposals={snap.proposals}
        selectedId={selected}
        onSelect={setSelected}
        loading={loading}
        actions={actions}
        disabled={busy || offline || ended}
      />
    </ErrorBoundary>
  )
  const orders = (
    <ErrorBoundary label="Command recommendations">
      <Recommendations
        actions={snap.actions}
        proposals={snap.proposals}
        loading={loading}
        autoDispatch={autoDispatch}
        onApprove={(ids) => void act('Approve', () => source.approve(ids), { ok: ids ? 'Dispatch approved.' : 'All recommended dispatches approved.' })}
        onReject={(id) => void act('Reject', () => source.reject(id), { ok: 'Rejected — the next-best unit is now proposed.' })}
        disabled={busy || inputsLocked}
      />
    </ErrorBoundary>
  )
  const intake = (
    <ErrorBoundary label="Report intake" compact>
      <ReportIntake
        onInject={(text) => source.injectReport(text)}
        onSample={() => source.nextSampleReport()}
        stage={snap.pipeline.stage}
        disabled={inputsLocked}
      />
    </ErrorBoundary>
  )
  const fleetPanel = (
    <Panel className="h-full" label="Resource fleet">
      <PanelHeader
        title="Resource fleet"
        icon={<Truck size={15} />}
        right={<span>{snap.resources.filter((r) => r.status === 'available').length}/{snap.resources.length} free</span>}
      />
      <div className="min-h-0 flex-1">
        <ErrorBoundary label="The fleet board">
          <ResourceBoard resources={snap.resources} incidents={snap.incidents} loading={loading} onRecall={actions.onRecall} disabled={busy || inputsLocked} />
        </ErrorBoundary>
      </div>
    </Panel>
  )
  const logPanel = (
    <Panel className="h-full" label="Live audit log">
      <PanelHeader title="Live audit log" icon={<ScrollText size={15} />} right={<span>{m.injections} injected</span>} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <ErrorBoundary label="The audit log">{loading ? <FleetSkeleton /> : <EventLog lines={snap.event_log} />}</ErrorBoundary>
      </div>
    </Panel>
  )
  const mapFrame = <div className="relative h-full min-h-0 overflow-hidden rounded-lg border border-line">{map}</div>
  const fleet = <FleetAndLog snap={snap} loading={loading} injections={m.injections} onRecall={actions.onRecall} disabled={busy || inputsLocked} />

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-bg text-ink">
      <a
        href="#incident-feed"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-[3000] focus:rounded-md focus:bg-accent focus:px-3 focus:py-2 focus:text-sm focus:font-bold focus:text-bg"
        onClick={(e) => {
          e.preventDefault()
          if (desktop) setView('situation')
          else setTab('feed')
          requestAnimationFrame(() => document.getElementById('incident-feed')?.focus())
        }}
      >
        Skip to the incident feed
      </a>
      <HeaderHud
        snap={snap}
        theme={theme}
        onToggleTheme={toggle}
        showUnits={showUnits}
        onToggleUnits={() => setShowUnits((v) => !v)}
        onReset={doReset}
        resetting={busy}
        exportUrl={exportUrl}
        autoDispatch={autoDispatch}
        onToggleAuto={doToggleAuto}
        onEndDrill={doEnd}
      />

      <SystemBanners snap={snap} />

      {desktop ? (
        <div className="flex min-h-0 flex-1">
          <SideNav view={view} onChange={setView} badge={{ situation: p1p2, orders: snap.proposals.length }} />
          <main id="main" className="min-h-0 min-w-0 flex-1 p-2">
            {view === 'situation' && (
              <div className="flex h-full min-h-0 flex-col gap-2">
                <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,58fr)_minmax(0,42fr)] gap-2">
                  {mapFrame}
                  <div id="incident-feed" tabIndex={-1} className="min-h-0 outline-none">{feed}</div>
                </div>
              </div>
            )}
            {view === 'orders' && (
              <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2">
                {orders}
                {mapFrame}
              </div>
            )}
            {view === 'report' && (
              <div className="flex h-full min-h-0 flex-col gap-2">
                <div className="shrink-0">{intake}</div>
                <div className="min-h-0 flex-1">{logPanel}</div>
              </div>
            )}
            {view === 'fleet' && (
              <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2">
                {fleetPanel}
                {mapFrame}
              </div>
            )}
          </main>
        </div>
      ) : (
        <>
          <main id="main" className="min-h-0 flex-1 p-2">
            <div className={tab === 'map' ? 'relative h-full overflow-hidden rounded-lg border border-line' : 'hidden'}>{map}</div>
            {tab === 'feed' && <div id="incident-feed" tabIndex={-1} className="h-full outline-none">{feed}</div>}
            {tab === 'orders' && <div className="h-full">{orders}</div>}
            {tab === 'report' && <div className="flex h-full flex-col gap-2 overflow-y-auto">{intake}<div className="min-h-[260px] flex-1">{fleet}</div></div>}
            {tab === 'fleet' && <div className="h-full">{fleet}</div>}
          </main>
          <MobileTabs tab={tab} onChange={setTab} badge={{ feed: p1p2, orders: snap.proposals.length }} />
        </>
      )}

      <ActionToast toast={toast} onDismiss={() => setToast(null)} />
      {adminPrompt && (
        <AdminKeyDialog
          action={adminPrompt.label}
          rejected={adminPrompt.rejected}
          onSubmit={submitAdminKey}
          onCancel={() => setAdminPrompt(null)}
        />
      )}
    </div>
  )
}
