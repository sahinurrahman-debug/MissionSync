import { useEffect, useMemo, useRef, useState } from 'react'
import { MapContainer, CircleMarker, TileLayer, Tooltip } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import type { Incident, WorldSnapshot } from './types'

const WS_URL = 'ws://127.0.0.1:8000/ws'
const API_URL = 'http://127.0.0.1:8000'

const TIER_COLOR: Record<string, string> = {
  P1: '#ff4d4d', P2: '#ff9f43', P3: '#f6d743', P4: '#5f6f81',
}

const SAMPLE_REPORTS = [
  'Drone D1 spots new fire front near University lab block, smoke visible from two streets away',
  'Ammonia vapor cloud spreading from Industrial Park rail gate, three workers coughing, wind pushing it east',
  'Floodwater rising fast in Riverfront marina, a family of four is trapped on a houseboat',
  'Gas explosion in Downtown substation, power out in six blocks, people evacuating',
]

function useLiveSnapshot(): WorldSnapshot | null {
  const [snap, setSnap] = useState<WorldSnapshot | null>(null)
  const wsRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    let closed = false
    let retry: ReturnType<typeof setTimeout>

    const connect = () => {
      const ws = new WebSocket(WS_URL)
      wsRef.current = ws
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data)
          if (msg.type === 'snapshot') setSnap(msg.data as WorldSnapshot)
        } catch { /* ignore malformed frames */ }
      }
      ws.onclose = () => {
        if (!closed) retry = setTimeout(connect, 2000)
      }
      ws.onerror = () => ws.close()
    }
    connect()

    // Backup initial fetch in case WS is briefly unavailable
    fetch(`${API_URL}/api/snapshot`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d && !wsRef.current?.readyState) setSnap(d) })
      .catch(() => {})

    return () => { closed = true; clearTimeout(retry); wsRef.current?.close() }
  }, [])

  return snap
}

function App() {
  const snap = useLiveSnapshot()
  const [selected, setSelected] = useState<string | null>(null)
  const [report, setReport] = useState('')
  const [busy, setBusy] = useState(false)
  const [ack, setAck] = useState<string | null>(null)

  const inject = async () => {
    if (!report.trim()) return
    setBusy(true); setAck(null)
    try {
      const res = await fetch(`${API_URL}/api/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: report, source: 'radio', confidence: 0.95 }),
      })
      const data = await res.json()
      setAck(`✅ Pipeline re-ran — injections processed: ${data.injections}. Ranking refreshed live (no restart).`)
      setReport('')
    } catch {
      setAck('⚠️ Backend unreachable — is it running on :8000?')
    } finally {
      setBusy(false)
    }
  }

  const incidents = snap?.incidents ?? []
  const actions = snap?.actions ?? []
  const m = snap?.metrics
  const llmAgentsLive = Object.values(m?.latency.llm.agents ?? {})
    .filter((agent) => agent.last_mode === 'llm').length

  const p1p2 = useMemo(
    () => incidents.filter((i) => i.risk && ['P1', 'P2'].includes(i.risk.tier)).length,
    [incidents],
  )

  return (
    <div className="app">
      <header className="header">
        <h1>Mission<span>Sync</span> — Joint Operations</h1>
        <span className={`badge ${m ? (m.mode === 'llm' ? 'llm' : 'fallback') : ''}`}>
          {m ? (m.mode === 'llm' ? `LLM: Groq live` : 'fallback mode') : 'connecting…'}
        </span>
        <span className="badge live">● LIVE</span>
        <div className="spacer" />
        <span className="metric-chip">tick <b>{snap?.tick ?? 0}</b></span>
        <span className="metric-chip">cycle <b>{m?.latency.last_cycle_ms ?? '—'} ms</b></span>
        <span className="metric-chip">rank acc (ρ) <b>{m?.ranking_accuracy.spearman ?? '—'}</b></span>
        <span className="metric-chip">P1/P2 cover <b>{m ? `${Math.round(m.recommendation_quality.coverage * 100)}%` : '—'}</b></span>
        <span className="metric-chip">injections <b>{m?.recommendation_quality.injections_processed ?? 0}</b></span>
        <span className="metric-chip">
          agents <b>{m ? `${llmAgentsLive}/5 LLM` : '—'}</b> · xBD <b>{m?.scenario_dataset.replace(/_/g, ' ') ?? '—'}</b>
        </span>
      </header>

      <div className="main">
        <div className="left">
          <div className="map-wrap">
            <MapContainer center={[34.055, -118.245]} zoom={13} style={{ height: '100%' }}>
              <TileLayer
                attribution='&copy; OpenStreetMap'
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              />
              {incidents.map((inc) => (
                <CircleMarker
                  key={inc.id}
                  center={[inc.lat, inc.lon]}
                  radius={inc.risk ? 8 + inc.risk.urgency / 10 : 6}
                  pathOptions={{
                    color: inc.risk ? TIER_COLOR[inc.risk.tier] : '#5f6f81',
                    fillOpacity: 0.55,
                    weight: selected === inc.id ? 3 : 1.5,
                  }}
                  eventHandlers={{ click: () => setSelected(inc.id) }}
                >
                  <Tooltip>
                    <b>#{inc.risk?.tier ?? '—'} {inc.title}</b><br />
                    urgency {inc.risk?.urgency ?? '—'} · {inc.zone}<br />
                    pop {inc.affected_population} · injuries {inc.injuries}
                  </Tooltip>
                </CircleMarker>
              ))}
              {(snap?.resources ?? []).filter((r) => r.current_lat && r.current_lon).map((r) => (
                <CircleMarker
                  key={r.id}
                  center={[r.current_lat!, r.current_lon!]}
                  radius={5}
                  pathOptions={{
                    color: r.status === 'on_scene' ? '#2dd4a7' : '#38bdf8',
                    fillOpacity: 0.9,
                  }}
                >
                  <Tooltip>{r.name} · {r.status}</Tooltip>
                </CircleMarker>
              ))}
            </MapContainer>
            <div className="map-legend">
              <span><i className="dot" style={{ background: TIER_COLOR.P1 }} />P1</span>
              <span><i className="dot" style={{ background: TIER_COLOR.P2 }} />P2</span>
              <span><i className="dot" style={{ background: TIER_COLOR.P3 }} />P3</span>
              <span><i className="dot" style={{ background: TIER_COLOR.P4 }} />P4</span>
              <span><i className="dot" style={{ background: '#38bdf8' }} />units</span>
            </div>
          </div>

          <div className="panel ranked-feed">
            <div className="panel-header">Ranked Incident Feed · {incidents.length} active · {p1p2} P1/P2</div>
            <div className="panel-body">
              {incidents.length === 0 && <div className="empty">Waiting for first pipeline cycle…</div>}
              {incidents.map((inc, idx) => (
                <IncidentCard
                  key={inc.id} inc={inc} rank={idx + 1}
                  selected={selected === inc.id}
                  onClick={() => setSelected(inc.id)}
                />
              ))}
            </div>
          </div>
        </div>

        <div className="right">
          <div className="panel actions-panel">
            <div className="panel-header">Command Recommendations</div>
            <div className="panel-body">
              {actions.length === 0 && <div className="empty">No recommendations yet — pipeline warming up.</div>}
              {actions.map((a) => (
                <div className="action-card" key={a.incident_id}>
                  <div className="action-head">
                    <span className="prio">#{a.priority}</span>
                    <span className="headline">{a.headline}</span>
                    <span className="tier" style={{ background: TIER_COLOR['P1'] }}>{a.urgency.toFixed(0)}</span>
                  </div>
                  <ul>{a.details.map((d, i) => <li key={i}>{d}</li>)}</ul>
                  {a.warnings.map((w, i) => <div className="warning" key={i}>⚠ {w}</div>)}
                  {a.deployments.map((d) => (
                    <span className="dep-chip" key={d.id}>
                      {d.resource_name} <small>· {d.role} · ETA {d.eta_minutes.toFixed(0)}m</small>
                    </span>
                  ))}
                </div>
              ))}
            </div>
          </div>

          <div className="injector">
            <textarea
              placeholder="Judge stress test: type a new field report and inject it mid-demo…"
              value={report}
              onChange={(e) => setReport(e.target.value)}
            />
            <div className="injector-row">
              <select
                onChange={(e) => { if (e.target.value) setReport(e.target.value) }}
                defaultValue=""
              >
                <option value="">— sample reports —</option>
                {SAMPLE_REPORTS.map((s) => <option key={s} value={s}>{s.slice(0, 58)}…</option>)}
              </select>
              <button onClick={inject} disabled={busy || !report.trim()}>
                {busy ? 'Processing…' : 'Inject report'}
              </button>
            </div>
            {ack && <div className="inject-hint">{ack}</div>}
            <div className="inject-hint">
              Injection triggers the full agent pipeline — ranking &amp; recommendations refresh in place.
            </div>
          </div>

          <div className="panel log-panel">
            <div className="panel-header">Live Event Log</div>
            <div className="panel-body log-body">
              {(snap?.event_log ?? []).slice().reverse().map((line, i) => (
                <div key={i}>{line}</div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function IncidentCard({ inc, rank, selected, onClick }: {
  inc: Incident; rank: number; selected: boolean; onClick: () => void
}) {
  const tier = inc.risk?.tier ?? 'P4'
  const color = TIER_COLOR[tier]
  return (
    <div className={`incident-card ${selected ? 'selected' : ''}`}
      style={{ borderLeftColor: color }} onClick={onClick}>
      <div className="card-row">
        <span className="rank">#{rank}</span>
        <span className="title">{inc.title}</span>
        <span className="tier {tier}" style={{ background: color }}>{tier}</span>
        <span className="urgency" style={{ color }}>{inc.risk?.urgency.toFixed(0) ?? '—'}</span>
      </div>
      <div className="meta">
        {inc.zone} · {inc.type.replace(/_/g, ' ')} · pop {inc.affected_population} · injuries {inc.injuries} · conf {(inc.confidence * 100).toFixed(0)}% · {inc.status.replace(/_/g, ' ')}
      </div>
      {inc.risk && <div className="rationale">“{inc.risk.breakdown.rationale}”</div>}
    </div>
  )
}

export default App
