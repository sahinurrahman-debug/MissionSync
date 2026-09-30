import { CloudOff, Info, RadioTower, TriangleAlert, Wind } from 'lucide-react'
import type { ReactNode } from 'react'
import type { Snapshot } from '../types'

function Banner({ tone, icon, children }: { tone: 'warn' | 'bad' | 'info'; icon: ReactNode; children: ReactNode }) {
  const cls = {
    warn: 'border-warn/30 bg-warn/10',
    bad: 'border-p1/30 bg-p1/10',
    info: 'border-accent/30 bg-accent/10',
  }[tone]
  return (
    <div role={tone === 'bad' ? 'alert' : 'status'} className={`flex items-start gap-2 border-b px-3 py-1.5 text-sm text-ink lg:px-4 ${cls}`}>
      <span className="mt-0.5 shrink-0" aria-hidden>{icon}</span>
      <span className="min-w-0">{children}</span>
    </div>
  )
}

/** The non-blocking alert slot under the HUD: connectivity, engine state, quota, weather. */
export default function SystemBanners({ snap }: { snap: Snapshot }) {
  const m = snap.metrics
  const offline = snap.engine === 'remote' && snap.connection === 'offline'
  const alerts = snap.weather.filter((w) => w.alert)
  return (
    <div className="shrink-0">
      {offline && (
        <Banner tone="bad" icon={<CloudOff size={16} className="text-p1" />}>
          Lost the connection to the MissionSync server — showing the last known picture and reconnecting…
        </Banner>
      )}
      {snap.engine === 'local' && (
        <Banner tone="info" icon={<Info size={16} className="text-accent" />}>
          <b>Demo engine:</b> the drill runs in your browser with rule-based agents.<span className="hidden sm:inline"> Start the backend for live AI agents and real xBD data (see the README).</span>
        </Banner>
      )}
      {m.mode === 'quota_exhausted' && (
        <Banner tone="warn" icon={<TriangleAlert size={16} className="text-warn" />}>
          <b>AI quota spent — rule-based fallback has taken over.</b> No data is lost and the board keeps working.
          {m.quota_retry_s != null && ` AI resumes in about ${Math.max(1, Math.ceil(m.quota_retry_s / 60))} min.`}
        </Banner>
      )}
      {m.mode === 'fallback' && snap.engine === 'remote' && snap.status === 'live' && (
        <Banner tone="warn" icon={<RadioTower size={16} className="text-warn" />}>
          <b>Degraded mode:</b> the LLM is unavailable (no API key, or the provider is failing) — rule-based agents are running.
        </Banner>
      )}
      {alerts.length > 0 && (
        <div className="no-scrollbar flex gap-2 overflow-x-auto border-b border-line bg-hi px-3 py-1.5 lg:px-4" role="status" aria-label="Weather advisories">
          {alerts.map((w) => (
            <span key={w.zone} className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-warn/40 bg-warn/10 px-2 py-0.5 text-sm text-warn">
              <Wind size={14} aria-hidden />
              <b className="font-semibold">{w.zone}</b>
              <span className="text-ink-2">
                {(w.alert ?? '').replace(/_/g, ' ')} · wind <span className="font-mono tnum">{Math.round(w.wind_kph)}</span> kph
                {w.forecast_note ? ` · ${w.forecast_note}` : ''}
              </span>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
