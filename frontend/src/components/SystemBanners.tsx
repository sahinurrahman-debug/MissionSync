import { CloudOff, RadioTower, TriangleAlert, X } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import type { Snapshot } from '../types'

function Banner({ tone, icon, children, onDismiss }: { tone: 'warn' | 'bad' | 'info'; icon: ReactNode; children: ReactNode; onDismiss?: () => void }) {
  const cls = {
    warn: 'border-warn/30 bg-warn/10',
    bad: 'border-p1/30 bg-p1/10',
    info: 'border-accent/30 bg-accent/10',
  }[tone]
  return (
    <div role={tone === 'bad' ? 'alert' : 'status'} className={`flex items-start gap-2 rounded-lg border px-3 py-1.5 text-sm text-ink ${cls}`}>
      <span className="mt-0.5 shrink-0" aria-hidden>{icon}</span>
      <span className="min-w-0 flex-1">{children}</span>
      {onDismiss && (
        <button type="button" onClick={onDismiss} aria-label="Hide This Notice" className="-my-1.5 -mr-2 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-ink-2 hover:text-ink sm:h-10 sm:w-10">
          <X size={18} aria-hidden />
        </button>
      )}
    </div>
  )
}

/** The non-blocking alert slot under the HUD: connectivity, engine state, quota. */
export default function SystemBanners({ snap }: { snap: Snapshot }) {
  const m = snap.metrics
  const [hidden, setHidden] = useState<string | null>(null)       // a hidden notice returns if the situation changes (a different mode)
  const offline = snap.engine === 'remote' && snap.connection === 'offline'
  return (
    <div className="shrink-0 space-y-2 empty:hidden">
      {offline && (
        <Banner tone="bad" icon={<CloudOff size={16} className="text-p1" />}>
          {snap.offline_reason === 'busy'
            ? 'The server is busy running other drills right now — retrying in a moment…'
            : 'Lost the connection to the MissionSync server — showing the last known picture and reconnecting…'}
        </Banner>
      )}
      {m.mode === 'quota_exhausted' && hidden !== 'quota_exhausted' && (
        <Banner tone="warn" icon={<TriangleAlert size={16} className="text-warn" />} onDismiss={() => setHidden('quota_exhausted')}>
          <b>AI quota spent — rule-based fallback has taken over.</b>
          <span className="max-sm:sr-only"> No data is lost and the board keeps working.
          {m.quota_retry_s != null && ` AI resumes in about ${Math.max(1, Math.ceil(m.quota_retry_s / 60))} min.`}</span>
        </Banner>
      )}
      {m.mode === 'fallback' && hidden !== 'fallback' && snap.engine === 'remote' && snap.status === 'live' && (
        <Banner tone="warn" icon={<RadioTower size={16} className="text-warn" />} onDismiss={() => setHidden('fallback')}>
          <b>Degraded mode:</b><span className="max-sm:sr-only"> the LLM is unavailable (no API key, or the provider is failing) — rule-based agents are running.</span>
        </Banner>
      )}
    </div>
  )
}
