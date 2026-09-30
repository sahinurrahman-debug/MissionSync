import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import MapPanel from './components/MapPanel'
import IncidentCard from './components/IncidentCard'
import Recommendations from './components/Recommendations'
import ResourceBoard from './components/ResourceBoard'
import EventLog from './components/EventLog'
import ReportIntake from './components/ReportIntake'
import { SkeletonList } from './components/Skeletons'
import { createSource } from './api/connect'
import type { DataSource } from './source'
import type { Metrics, Snapshot } from './types'

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
      <div className="app">
        <div className="connecting" role="status">
          <span className="mini-spin" aria-hidden /> Connecting to MissionSync…
        </div>
      </div>
    )
  }
  return <Board source={source} />
}

function modeChip(m: Metrics, snap: Snapshot): { label: string; cls: string; title: string } {
  switch (m.mode) {
    case 'llm':
      return { label: `AI · ${m.model ?? 'LLM'}`, cls: 'mode-llm', title: 'All five agents are running on the LLM.' }
    case 'quota_exhausted':
      return { label: 'AI QUOTA HIT', cls: 'mode-bad', title: 'The Groq daily token quota is spent; rule-based agents are covering.' }
    case 'demo':
      return { label: 'DEMO ENGINE', cls: 'mode-warn', title: 'Running in the browser with rule-based agents — no backend connected.' }
    default:
      return {
        label: snap.status === 'booting' ? 'STARTING' : 'RULES · LLM off',
        cls: 'mode-warn',
        title: 'Rule-based agents are running (no LLM key, or the LLM is failing).',
      }
  }
}

function Board({ source }: { source: DataSource }) {
  const subscribe = useCallback((cb: () => void) => source.subscribe(cb), [source])
  const snap = useSyncExternalStore(subscribe, () => source.getSnapshot())
  const { theme, toggle } = useTheme()
  const [selected, setSelected] = useState<string | null>(null)
  const [showUnits, setShowUnits] = useState(true)
  const [resetting, setResetting] = useState(false)

  const m = snap.metrics
  const booted = snap.status === 'live'
  const p1p2 = snap.incidents.filter((i) => i.risk?.tier === 'P1' || i.risk?.tier === 'P2').length
  const availableUnits = snap.resources.filter((r) => r.status === 'available').length
  const alerts = snap.weather.filter((w) => w.alert)
  const topAction = snap.actions[0]
  const mode = modeChip(m, snap)
  const offline = snap.engine === 'remote' && snap.connection === 'offline'
  const stageBusy = snap.pipeline.stage !== 'idle'

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

  return (
    <div className="app">
      <header className="header">
        <h1 className="brand">
          Mission<span className="sync">Sync</span>
          <span className="lvl">drill board</span>
        </h1>

        <span className={`chip live ${booted && !offline ? '' : 'hide-sm'}`}>
          {booted && !offline && <span className="pulse-dot" aria-hidden />}
          {offline ? 'OFFLINE' : booted ? 'LIVE' : 'BOOTING'}
        </span>

        <span className={`chip ${mode.cls}`} title={mode.title}>{mode.label}</span>

        <span className="chip pipeline-chip hide-sm">
          {stageBusy && <span className="mini-spin" aria-hidden />}
          {stageBusy ? (STAGE_LABEL[snap.pipeline.stage] ?? snap.pipeline.stage) : `tick ${snap.tick}`}
        </span>

        <div className="header-spacer" />

        <span
          className="chip hide-md"
          title={`Spearman correlation between our urgency and hidden ground truth over ${m.evaluated_incidents} scenario incidents. ${m.dataset_note}.`}
        >
          rank ρ <b>{m.spearman != null ? m.spearman.toFixed(2) : '—'}</b>
        </span>
        <span className="chip hide-md">P1/P2 cover <b>{Math.round(m.coverage * 100)}%</b></span>
        <span className="chip hide-md">units free <b>{availableUnits}/{snap.resources.length}</b></span>
        <span className="chip hide-md">resolved <b>{m.resolved}</b></span>
        <span className="chip hide-md">cycle <b>{m.cycle_ms} ms</b></span>

        <button className="icon-btn" onClick={() => setShowUnits((v) => !v)} aria-pressed={showUnits} title="Toggle units layer">
          {showUnits ? '📡' : '🛰'}
        </button>
        {source.exportUrl && m.database !== 'disabled' && m.database !== 'error' && m.drill_id != null && (
          <a className="icon-btn" href={source.exportUrl(m.drill_id)} download title="Download the after-action CSV (reports + audit trail)" aria-label="Download after-action CSV">
            ⬇
          </a>
        )}
        <button className="icon-btn" onClick={doReset} disabled={resetting || offline} title="Restart the drill" aria-label="Restart the drill">
          {resetting ? <span className="mini-spin" aria-hidden /> : '↺'}
        </button>
        <button className="icon-btn" onClick={toggle} aria-label="Toggle color theme" title="Toggle theme">
          {theme === 'dark' ? '☀️' : '🌙'}
        </button>
      </header>

      {offline && (
        <div className="banner error" role="alert">
          Lost the connection to the MissionSync server — showing the last known picture and reconnecting…
        </div>
      )}
      {snap.engine === 'local' && (
        <div className="banner warn" role="status">
          Demo engine: the drill is running entirely in your browser with rule-based agents. Start the backend for live AI agents and real xBD data (see the README).
        </div>
      )}
      {m.mode === 'quota_exhausted' && (
        <div className="banner error" role="status">
          The Groq daily token quota is spent, so rule-based agents are covering — the board keeps working.
          {m.quota_retry_s != null && ` AI resumes in about ${Math.max(1, Math.ceil(m.quota_retry_s / 60))} min.`}
        </div>
      )}
      {m.mode === 'fallback' && snap.engine === 'remote' && booted && (
        <div className="banner warn" role="status">
          Degraded mode: the LLM is unavailable (no API key, or the provider is failing) — rule-based agents are running.
        </div>
      )}

      {alerts.length > 0 && (
        <div className="weather-strip" role="status">
          {alerts.map((w) => (
            <span key={w.zone} className="chip weather-alert">
              ⚠ {w.zone}: {(w.alert ?? '').replace(/_/g, ' ')} · wind {Math.round(w.wind_kph)} kph · {w.forecast_note || `${w.precipitation_mm_h.toFixed(0)} mm/h rain`}
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
                  <span>No open incidents. Inject a report to keep the drill going, or restart it with ↺.</span>
                </div>
              ) : (
                snap.incidents.map((inc, i) => (
                  <IncidentCard
                    key={inc.id}
                    incident={inc}
                    rank={i + 1}
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
            onInject={(text) => source.injectReport(text)}
            onSample={() => source.nextSampleReport()}
            stage={snap.pipeline.stage}
            disabled={offline || !booted}
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
