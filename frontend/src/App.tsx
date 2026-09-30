import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import MapPanel from './components/MapPanel'
import IncidentCard from './components/IncidentCard'
import Recommendations from './components/Recommendations'
import ResourceBoard from './components/ResourceBoard'
import EventLog from './components/EventLog'
import ReportIntake from './components/ReportIntake'
import { SkeletonList } from './components/Skeletons'
import { orchestrator } from './engine/orchestrator'
import type { Snapshot } from './types'

const STAGE_LABEL: Record<string, string> = {
  surveillance: 'parsing reports',
  terrain: 'assessing terrain',
  risk: 'scoring urgency',
  logistics: 'matching units',
  command: 'drafting orders',
}

function useTheme() {
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    // ?theme=light wins (handy for screenshots/tests), then saved choice.
    const qs = new URLSearchParams(window.location.search).get('theme')
    if (qs === 'light' || qs === 'dark') return qs
    const saved = localStorage.getItem('ms-theme')
    return saved === 'light' || saved === 'dark' ? saved : 'dark'
  })
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('ms-theme', theme)
  }, [theme])
  return { theme, toggle: () => setTheme((t) => (t === 'dark' ? 'light' : 'dark')) }
}

export default function App() {
  const snap = useSyncExternalStore(
    (cb) => orchestrator.subscribe(cb),
    () => orchestrator.getSnapshot(),
  )
  const { theme, toggle } = useTheme()
  const [selected, setSelected] = useState<string | null>(null)
  const [showUnits, setShowUnits] = useState(true)

  useEffect(() => {
    orchestrator.start()
    return () => orchestrator.stop()
  }, [])

  const m = snap.metrics
  const booted = snap.incidents.length > 0
  const p1p2 = snap.incidents.filter((i) => i.risk?.tier === 'P1' || i.risk?.tier === 'P2').length
  const availableUnits = snap.resources.filter((r) => r.status === 'available').length
  const alerts = snap.weather.filter((w) => w.alert)
  const topAction = useMemo(() => snap.actions[0], [snap])

  return (
    <div className="app">
      <header className="header">
        <h1 className="brand">
          Mission<span className="sync">Sync</span>
          <span className="lvl">Kenshi · drill board</span>
        </h1>

        <span className={`chip live ${booted ? '' : 'hide-sm'}`}>
          {booted && <span className="pulse-dot" aria-hidden />}
          {booted ? 'LIVE' : 'BOOTING'}
        </span>

        <span className="chip pipeline-chip hide-sm">
          {snap.pipeline.stage !== 'idle' && <span className="mini-spin" aria-hidden />}
          {snap.pipeline.stage !== 'idle'
            ? (STAGE_LABEL[snap.pipeline.stage] ?? snap.pipeline.stage)
            : `tick ${snap.tick}`}
        </span>

        <div className="header-spacer" />

        <span className="chip hide-md">rank ρ <b>{m.spearman != null ? m.spearman.toFixed(2) : '—'}</b></span>
        <span className="chip hide-md">P1/P2 cover <b>{Math.round(m.coverage * 100)}%</b></span>
        <span className="chip hide-md">units free <b>{availableUnits}/{snap.resources.length}</b></span>
        <span className="chip hide-md">cycle <b>{m.cycle_ms} ms</b></span>

        <button className="icon-btn" onClick={() => setShowUnits((v) => !v)} aria-pressed={showUnits} title="Toggle units layer">
          {showUnits ? '📡' : '🛰'}
        </button>
        <button className="icon-btn" onClick={toggle} aria-label="Toggle color theme" title="Toggle theme">
          {theme === 'dark' ? '☀️' : '🌙'}
        </button>
      </header>

      {alerts.length > 0 && (
        <div className="weather-strip" role="status">
          {alerts.map((w) => (
            <span key={w.zone} className="chip weather-alert">
              ⚠ {w.zone}: {(w.alert ?? '').replace(/_/g, ' ')} · wind {Math.round(w.wind_kph)} kph · {w.forecast_note || `${w.precipitation_mm_h} mm/h rain`}
            </span>
          ))}
        </div>
      )}

      <main className="main">
        <section className="col col-left" aria-label="Live map and ranked incidents">
          <MapPanel
            incidents={snap.incidents}
            resources={showUnits ? snap.resources : []}
            selectedId={selected}
            onSelect={setSelected}
          />

          <div className="panel grow-1">
            <div className="panel-header">
              Ranked incident feed
              <span className="count">{snap.incidents.length} active · {p1p2} P1/P2</span>
            </div>
            <div className="panel-body">
              {!booted ? (
                <SkeletonList count={4} />
              ) : snap.incidents.length === 0 ? (
                <div className="empty">
                  <span className="empty-icon">🛰</span>
                  <span>No open incidents. Inject a report below to start the drill.</span>
                </div>
              ) : (
                snap.incidents.map((inc) => (
                  <IncidentCard
                    key={inc.id}
                    incident={inc}
                    rank={snap.incidents.indexOf(inc) + 1}
                    selected={selected === inc.id}
                    onSelect={setSelected}
                  />
                ))
              )}
            </div>
          </div>
        </section>

        <section className="col col-right" aria-label="Recommendations, resources and log">
          <div className="panel grow-2">
            <div className="panel-header">
              Command recommendations
              {topAction && <span className="count">top: #{topAction.priority} {topAction.incident_title}</span>}
            </div>
            <div className="panel-body">
              {!booted ? <SkeletonList count={2} /> : <Recommendations actions={snap.actions} />}
            </div>
          </div>

          <ReportIntake
            onInject={(text) => orchestrator.injectReport(text)}
            onSample={() => orchestrator.nextSampleReport()}
          />

          <div className="panel h-fixed">
            <div className="panel-header">
              Resource board
              <span className="count">{snap.resources.length} units</span>
            </div>
            <div className="panel-body" style={{ maxHeight: 240 }}>
              {!booted ? <SkeletonList count={3} /> : <ResourceBoard resources={snap.resources} incidents={snap.incidents} />}
            </div>
          </div>

          <div className="panel grow-1">
            <div className="panel-header">
              Live event log
              <span className="count">injections {m.injections}</span>
            </div>
            <div className="panel-body">
              {!booted ? <SkeletonList count={3} /> : <EventLog lines={snap.event_log} />}
            </div>
          </div>
        </section>
      </main>
    </div>
  )
}
