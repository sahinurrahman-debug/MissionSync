import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { ScrollText, Truck } from 'lucide-react'
import type { DataSource } from '../source'
import { ApiError } from '../types'
import { useMedia } from '../lib/useMedia'
import { useTheme } from '../lib/useTheme'
import ActionToast, { type ToastMessage } from '../components/ActionToast'
import ConfirmDialog from '../components/ConfirmDialog'
import ErrorBoundary from '../components/ErrorBoundary'
import EventLog from '../components/EventLog'
import FleetAndLog from '../components/FleetAndLog'
import HeaderHud, { StatGrid, TelemetryBar } from '../components/HeaderHud'
import HowItWorks, { guideSeen } from '../components/HowItWorks'
import IncidentFeed from '../components/IncidentFeed'
import MobileTabs, { type MobileTab } from '../components/MobileTabs'
import NextStep, { type Target } from '../components/NextStep'
import Recommendations from '../components/Recommendations'
import ReportIntake from '../components/ReportIntake'
import ResourceBoard from '../components/ResourceBoard'
import SideNav, { VIEWS, type View } from '../components/SideNav'
import { FleetSkeleton } from '../components/Skeletons'
import SystemBanners, { WeatherStrip } from '../components/SystemBanners'
import { Panel, PanelHeader } from '../components/ui'

// Leaflet is ~90 KB gzipped: load it after first paint so the shell appears sooner (most of all on phones).
const loadMap = () => import('../components/MapPanel')
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

export function describeError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'rate_limited') return `Too many actions — try again in ${e.retryAfterS ?? 2}s.`
    return e.message
  }
  return 'That did not work — the board keeps running. Try again.'
}

type Confirm = 'end' | 'reset' | null

/** One drill's dashboard: header, guidance, and one section at a time (side rail on desktop, tabs on phones). */
export default function DrillBoard({ source, leading, trailing }: { source: DataSource; leading?: ReactNode; trailing?: ReactNode }) {
  const subscribe = useCallback((cb: () => void) => source.subscribe(cb), [source])
  const rawSnap = useSyncExternalStore(subscribe, () => source.getSnapshot())
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
  const [confirm, setConfirm] = useState<Confirm>(null)
  const [guide, setGuide] = useState(() => !guideSeen())
  // Optimistic UI: what the user just decided disappears at once; if the server refuses it comes back.
  const [hiddenProposals, setHiddenProposals] = useState<Set<string>>(new Set())
  const [hiddenIncidents, setHiddenIncidents] = useState<Set<string>>(new Set())
  const toastId = useRef(0)

  // A fresh server snapshot is the truth: optimistic hides are only needed while a request is in flight.
  useEffect(() => {
    setHiddenProposals(new Set())
    setHiddenIncidents(new Set())
  }, [rawSnap])

  const snap = useMemo(() => {
    if (hiddenProposals.size === 0 && hiddenIncidents.size === 0) return rawSnap
    return {
      ...rawSnap,
      proposals: rawSnap.proposals.filter((p) => !hiddenProposals.has(p.id)),
      incidents: rawSnap.incidents.filter((i) => !hiddenIncidents.has(i.id)),
    }
  }, [rawSnap, hiddenProposals, hiddenIncidents])

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

  // 1-4 jump between sections (desktop), unless the user is typing or a dialog is open.
  useEffect(() => {
    if (!desktop) return
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || confirm || guide) return
      const t = e.target as HTMLElement | null
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return
      const v = VIEWS[Number(e.key) - 1]
      if (v) setView(v.id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [desktop, confirm, guide, setView])

  /** Runs a net-control action; `optimistic` is applied instantly and rolled back if the server says no. */
  const act = useCallback(async (run: () => Promise<void>, opts: { ok?: string; optimistic?: () => void; rollback?: () => void } = {}) => {
    setBusy(true)
    opts.optimistic?.()
    try {
      await run()
      if (opts.ok) notify('ok', opts.ok)
    } catch (e) {
      opts.rollback?.()
      notify('error', describeError(e))
    } finally {
      setBusy(false)
    }
  }, [notify])

  const hideProposals = (ids?: string[]) => setHiddenProposals(new Set(ids ?? rawSnap.proposals.map((p) => p.id)))
  const showProposals = () => setHiddenProposals(new Set())

  const doReset = () => {
    setConfirm(null)
    setSelected(null)
    void act(() => source.reset(), { ok: 'Drill restarted.' })
  }
  const doEnd = () => {
    setConfirm(null)
    void act(() => source.endDrill(), { ok: 'Drill ended. Download the CSV from the menu.' })
  }
  const doToggleAuto = () =>
    void act(() => source.setAutoDispatch(!autoDispatch), {
      ok: autoDispatch ? 'Manual approval is back on: you decide every dispatch.' : 'Auto-dispatch is on (demo): recommendations are sent without asking.',
    })

  const actions = {
    onRecall: (id: string) => void act(() => source.recall(id), { ok: 'Unit recalled to base.' }),
    onResolve: (id: string, status: 'contained' | 'closed') =>
      void act(() => source.resolveIncident(id, status), {
        ok: status === 'closed' ? 'Incident closed.' : 'Incident marked contained.',
        optimistic: () => setHiddenIncidents(new Set([id])),
        rollback: () => setHiddenIncidents(new Set()),
      }),
    onDispatch: (incidentId: string, resourceId: string) => void act(() => source.dispatchManual(incidentId, resourceId), { ok: 'Unit dispatched.' }),
  }

  const goTo = (t: Target) => {
    if (desktop) setView(t)
    else setTab(t)
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
    <ErrorBoundary label="Dispatch orders">
      <Recommendations
        actions={snap.actions}
        proposals={snap.proposals}
        loading={loading}
        autoDispatch={autoDispatch}
        onApprove={(ids) =>
          void act(() => source.approve(ids), {
            ok: ids ? 'Dispatch approved — the unit is on its way.' : 'All suggested dispatches approved.',
            optimistic: () => hideProposals(ids),
            rollback: showProposals,
          })}
        onReject={(id) =>
          void act(() => source.reject(id), {
            ok: 'Rejected — the next-best unit is now suggested.',
            optimistic: () => hideProposals([id]),
            rollback: showProposals,
          })}
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
      <PanelHeader title="Live audit log" icon={<ScrollText size={15} />} right={<span>{m.injections} reports sent</span>} />
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
        onReset={() => setConfirm('reset')}
        resetting={busy}
        exportUrl={exportUrl}
        autoDispatch={autoDispatch}
        onToggleAuto={doToggleAuto}
        onEndDrill={() => setConfirm('end')}
        onGuide={() => setGuide(true)}
        leading={leading}
        trailing={trailing}
      />
      <TelemetryBar snap={snap} />
      <NextStep snap={snap} onGo={goTo} />
      <SystemBanners snap={snap} />

      {desktop ? (
        <div className="flex min-h-0 flex-1">
          <SideNav view={view} onChange={setView} badge={{ situation: p1p2, orders: snap.proposals.length }} />
          <main id="main" className="min-h-0 min-w-0 flex-1 p-2">
            {view === 'situation' && (
              <div className="flex h-full min-h-0 flex-col gap-2">
                <WeatherStrip snap={snap} />
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
            <div className={tab === 'map' ? 'flex h-full flex-col gap-2' : 'hidden'}>
              <WeatherStrip snap={snap} />
              <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg border border-line">{map}</div>
            </div>
            {tab === 'feed' && <div id="incident-feed" tabIndex={-1} className="h-full outline-none">{feed}</div>}
            {tab === 'orders' && <div className="h-full">{orders}</div>}
            {tab === 'report' && <div className="flex h-full flex-col gap-2 overflow-y-auto">{intake}<div className="min-h-[260px] flex-1">{logPanel}</div></div>}
            {tab === 'fleet' && (
              <div className="flex h-full flex-col gap-2 overflow-y-auto">
                <StatGrid snap={snap} />
                <div className="min-h-[320px] flex-1">{fleet}</div>
              </div>
            )}
          </main>
          <MobileTabs tab={tab} onChange={setTab} badge={{ feed: p1p2, orders: snap.proposals.length }} />
        </>
      )}

      <ActionToast toast={toast} onDismiss={() => setToast(null)} />
      {guide && <HowItWorks onClose={() => setGuide(false)} />}
      {confirm === 'end' && (
        <ConfirmDialog
          title="End this drill?"
          body="The picture freezes so you can review it. You can still download the CSV, and restart afterwards."
          confirmLabel="End drill"
          onConfirm={doEnd}
          onCancel={() => setConfirm(null)}
        />
      )}
      {confirm === 'reset' && (
        <ConfirmDialog
          title="Restart this drill?"
          body="All incidents, units and the audit log of this drill are cleared and the scenario starts again."
          confirmLabel="Restart"
          danger
          onConfirm={doReset}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  )
}
