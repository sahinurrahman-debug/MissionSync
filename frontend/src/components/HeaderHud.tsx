import type { ReactNode } from 'react'
import { Download, Flag, Loader2, Moon, RotateCcw, Sun, Timer, Truck, Zap } from 'lucide-react'
import type { Metrics, Snapshot } from '../types'
import { modeChip } from '../lib/format'
import { Chip } from './ui'

const STAGE_LABEL: Record<string, string> = {
  surveillance: 'parsing reports',
  terrain: 'assessing terrain',
  risk: 'scoring urgency',
  logistics: 'matching units',
  command: 'drafting orders',
}

/** "RANK ρ 0.88" — micro-label plus a bold monospaced value. */
function Metric({ label, value, title }: { label: ReactNode; value: string; title?: string }) {
  return (
    <span title={title} className="inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-md border border-line bg-hi px-2 tnum">
      <span className="text-xs font-semibold uppercase tracking-micro text-ink-2">{label}</span>
      <b className="font-mono text-sm font-bold text-ink">{value}</b>
    </span>
  )
}

export function TelemetryChips({ m, snap, className = '' }: { m: Metrics; snap: Snapshot; className?: string }) {
  const free = snap.resources.filter((r) => r.status === 'available').length
  return (
    <div className={`flex items-center gap-1.5 ${className}`}>
      <Metric
        label={<>Rank <span className="normal-case">ρ</span></>}
        value={m.spearman != null ? m.spearman.toFixed(2) : '—'}
        title={`Spearman correlation between our urgency and hidden ground truth over ${m.evaluated_incidents} scenario incidents. ${m.dataset_note}.`}
      />
      <Metric label="P1/P2 cover" value={`${Math.round(m.coverage * 100)}%`} title="Share of P1/P2 incidents with a unit assigned" />
      <Metric label="Units free" value={`${free}/${snap.resources.length}`} />
      <Metric label="Resolved" value={String(m.resolved)} />
      <Metric label="Loop" value={`${m.cycle_ms}ms`} title="Last full pipeline cycle" />
    </div>
  )
}

export function EngineChips({ snap, className = '' }: { snap: Snapshot; className?: string }) {
  const m = snap.metrics
  const mode = modeChip(m.mode, m.model, snap.status !== 'live')
  const busy = snap.pipeline.stage !== 'idle'
  return (
    <div className={`min-w-0 items-center gap-1.5 ${className}`}>
      <Chip tone={mode.tone} title={mode.title}>{mode.label}</Chip>
      <Chip className="w-[172px] justify-start" title="Active AI pipeline stage">
        {busy ? <Loader2 size={13} className="animate-spin text-accent" aria-hidden /> : <span className="h-1.5 w-1.5 rounded-full bg-muted" aria-hidden />}
        <span className="truncate">{busy ? STAGE_LABEL[snap.pipeline.stage] : `tick ${snap.tick}`}</span>
      </Chip>
    </div>
  )
}

interface Props {
  snap: Snapshot
  theme: 'dark' | 'light'
  onToggleTheme: () => void
  showUnits: boolean
  onToggleUnits: () => void
  onReset: () => void
  resetting: boolean
  exportUrl: string | null
  autoDispatch: boolean
  onToggleAuto: () => void
  onEndDrill: () => void
}

/** 3725 s → "01:02:05" */
export function clockOf(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`
}

const iconBtn =
  'inline-flex h-9 w-9 items-center justify-center rounded-md border border-line bg-hi text-ink-2 transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-50 aria-pressed:border-accent/60 aria-pressed:text-accent max-lg:h-11 max-lg:w-11'

export default function HeaderHud({ snap, theme, onToggleTheme, showUnits, onToggleUnits, onReset, resetting, exportUrl, autoDispatch, onToggleAuto, onEndDrill }: Props) {
  const m = snap.metrics
  const booted = snap.status === 'live'
  const offline = snap.engine === 'remote' && snap.connection === 'offline'

  const ended = snap.status === 'ended'
  const status = offline ? { label: 'OFFLINE', tone: 'bad' as const }
    : ended ? { label: 'ENDED', tone: 'neutral' as const }
    : booted ? { label: 'LIVE', tone: 'ok' as const } : { label: 'BOOTING', tone: 'warn' as const }
  const beacon = status.tone === 'ok' ? 'bg-ok' : status.tone === 'bad' ? 'bg-p1' : 'bg-warn'

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-panel px-3 lg:px-4">
      {/* Brand + drill status */}
      <div className="flex min-w-0 items-center gap-2.5">
        <h1 className="whitespace-nowrap text-lg font-extrabold tracking-tight text-ink">
          Mission<span className="text-accent">Sync</span>
        </h1>
        <Chip tone={status.tone} title={`Drill status: ${status.label}`}>
          <span className="relative flex h-2 w-2" aria-hidden>
            {status.tone === 'ok' && <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${beacon}`} />}
            <span className={`relative inline-flex h-2 w-2 rounded-full ${beacon}`} />
          </span>
          {status.label}
        </Chip>
      </div>

      {/* Engine mode + live pipeline stage */}
      <EngineChips snap={snap} className="hidden md:flex" />
      <Chip className="hidden lg:inline-flex" title="Time since the drill started (stops when it ends)">
        <Timer size={13} aria-hidden />
        <span className="font-mono tnum">T+{clockOf(snap.elapsed_s)}</span>
      </Chip>

      {/* Drill telemetry (wide screens; smaller ones get the strip under the header) */}
      <TelemetryChips m={m} snap={snap} className="ml-auto hidden xl:flex" />

      {/* Utilities */}
      <div className="ml-auto flex items-center gap-1.5 xl:ml-0">
        <button
          type="button"
          className={iconBtn}
          onClick={onToggleAuto}
          aria-pressed={autoDispatch}
          disabled={ended || offline}
          title={autoDispatch ? 'Auto-dispatch (demo) is ON — click to require your approval' : 'Dispatch is manual — click to auto-dispatch (demo)'}
          aria-label={autoDispatch ? 'Auto-dispatch is on. Switch to manual approval' : 'Dispatch is manual. Switch to auto-dispatch'}
        >
          <Zap size={18} aria-hidden />
        </button>
        <button type="button" className={iconBtn} onClick={onToggleUnits} aria-pressed={showUnits} title="Toggle unit layer" aria-label="Toggle unit layer">
          <Truck size={18} aria-hidden />
        </button>
        {exportUrl ? (
          <a className={iconBtn} href={exportUrl} download title="Download the after-action CSV (reports + audit trail)" aria-label="Download after-action CSV">
            <Download size={18} aria-hidden />
          </a>
        ) : (
          <button type="button" className={iconBtn} disabled title="After-action export needs a connected database" aria-label="After-action export unavailable">
            <Download size={18} aria-hidden />
          </button>
        )}
        <button type="button" className={iconBtn} onClick={onEndDrill} disabled={ended || offline || !booted} title="End the drill (freezes the picture)" aria-label="End the drill">
          <Flag size={18} aria-hidden />
        </button>
        <button type="button" className={iconBtn} onClick={onReset} disabled={resetting || offline} title="Restart the drill" aria-label="Restart the drill">
          {resetting ? <Loader2 size={18} className="animate-spin" aria-hidden /> : <RotateCcw size={18} aria-hidden />}
        </button>
        <button type="button" className={iconBtn} onClick={onToggleTheme} title="Toggle light / dark" aria-label="Toggle color theme">
          {theme === 'dark' ? <Sun size={18} aria-hidden /> : <Moon size={18} aria-hidden />}
        </button>
      </div>
    </header>
  )
}
