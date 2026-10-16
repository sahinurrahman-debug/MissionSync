import type { ReactNode } from 'react'
import { BookOpen, Download, Flag, Loader2, Moon, RotateCcw, Sun, Timer, Truck, Zap } from 'lucide-react'
import type { Metrics, Snapshot } from '../types'
import { modeChip } from '../lib/format'
import DrillMenu, { type MenuItem } from './DrillMenu'
import { Chip } from './ui'

const STAGE_LABEL: Record<string, string> = {
  surveillance: 'Reading Reports',
  terrain: 'Checking Terrain',
  risk: 'Scoring Urgency',
  logistics: 'Matching Units',
  command: 'Drafting Orders',
}

/** 3725 s → "01:02:05" */
export function clockOf(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`
}

interface Stat { id: string; label: string; value: string; title: string }

/** The six drill numbers, named in plain words (the Greek-letter / jargon names live in the tooltips). */
export function statsOf(snap: Snapshot): Stat[] {
  const m: Metrics = snap.metrics
  const free = snap.resources.filter((r) => r.status === 'available').length
  return [
    {
      id: 'accuracy', label: 'Ranking accuracy',
      value: m.spearman != null ? `${Math.round(Math.max(0, m.spearman) * 100)}%` : '—',
      title: `How closely our urgency ranking matches the real xBD damage ground truth (Spearman ρ = ${m.spearman != null ? m.spearman.toFixed(2) : 'n/a'} over ${m.evaluated_incidents} scenario incidents). Typed reports never change it.`,
    },
    { id: 'covered', label: 'Critical covered', value: `${Math.round(m.coverage * 100)}%`, title: 'Share of P1/P2 incidents that have at least one unit assigned.' },
    { id: 'free', label: 'Units free', value: `${free}/${snap.resources.length}`, title: 'Units that are available to be sent.' },
    { id: 'resolved', label: 'Resolved', value: String(m.resolved), title: 'Incidents contained or closed so far.' },
    { id: 'cycle', label: 'Response time', value: `${m.cycle_ms}ms`, title: 'How long the last full AI pipeline cycle took.' },
    { id: 'time', label: 'Drill time', value: `T+${clockOf(snap.elapsed_s)}`, title: 'Time since the drill started (stops when it ends).' },
  ]
}

function BarCell({ stat }: { stat: Stat }) {
  return (
    <div title={stat.title} className="flex min-w-0 flex-col justify-center rounded-lg border border-line bg-panel px-3 py-1 shadow-panel tnum">
      <span className="truncate text-xs font-semibold uppercase leading-tight tracking-micro text-ink-2">{stat.label}</span>
      <b className="whitespace-nowrap font-mono text-lg font-bold leading-tight text-ink">{stat.value}</b>
      <span className="sr-only">{stat.title}</span>
    </div>
  )
}

/** Desktop telemetry bar: six equal columns in one straight line under the header. */
export function TelemetryBar({ snap }: { snap: Snapshot }) {
  return (
    <div role="group" aria-label="Drill telemetry" className="hidden shrink-0 grid-cols-6 gap-2 lg:grid">
      {statsOf(snap).map((s) => <BarCell key={s.id} stat={s} />)}
    </div>
  )
}

/** Phone version: the same six numbers as a 2×3 grid (shown at the top of the Units tab). */
export function StatGrid({ snap }: { snap: Snapshot }) {
  return (
    <dl aria-label="Drill telemetry" className="grid grid-cols-2 gap-2">
      {statsOf(snap).map((s) => (
        <div key={s.id} title={s.title} className="rounded-lg border border-line bg-panel px-3 py-2">
          <dt className="text-xs font-semibold uppercase tracking-micro text-ink-2">{s.label}</dt>
          <dd className="font-mono text-lg font-bold text-ink tnum">{s.value}</dd>
        </div>
      ))}
    </dl>
  )
}

export function EngineChips({ snap, className = '' }: { snap: Snapshot; className?: string }) {
  const m = snap.metrics
  const mode = modeChip(m.mode, m.model, snap.status !== 'live')
  const busy = snap.pipeline.stage !== 'idle'
  return (
    <div className={`shrink-0 items-center gap-1.5 ${className}`}>
      <Chip tone={mode.tone} title={mode.title}>{mode.label}</Chip>
      <Chip className="w-[150px] justify-start" title="What the AI agents are doing right now (Agents ready = waiting for the next report)">
        {busy ? <Loader2 size={13} className="animate-spin text-accent" aria-hidden /> : <span className="h-1.5 w-1.5 rounded-full bg-muted" aria-hidden />}
        <span className="truncate">{busy ? STAGE_LABEL[snap.pipeline.stage] : 'Agents Ready'}</span>
      </Chip>
    </div>
  )
}

export function ClockChip({ snap, className = '' }: { snap: Snapshot; className?: string }) {
  return (
    <Chip className={`shrink-0 ${className}`} title="Time since the drill started (stops when it ends)">
      <Timer size={13} aria-hidden />
      <span className="font-mono tnum">T+{clockOf(snap.elapsed_s)}</span>
    </Chip>
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
  onGuide: () => void
  /** Optional left-hand slot (e.g. “← My drills”) and right-hand slot (e.g. the account menu). */
  leading?: ReactNode
  trailing?: ReactNode
  /** The drill's name, shown next to the brand on wider screens. */
  title?: string
}

const iconBtn =
  'inline-flex h-11 w-11 items-center justify-center rounded-md border border-line bg-hi text-ink-2 transition-colors hover:border-accent hover:text-accent'

export default function HeaderHud({
  snap, theme, onToggleTheme, showUnits, onToggleUnits, onReset, resetting, exportUrl, autoDispatch, onToggleAuto, onEndDrill, onGuide,
  leading, trailing, title,
}: Props) {
  const booted = snap.status === 'live'
  const offline = snap.engine === 'remote' && snap.connection === 'offline'
  const ended = snap.status === 'ended'
  const status = offline ? { label: 'OFFLINE', tone: 'bad' as const }
    : ended ? { label: 'ENDED', tone: 'neutral' as const }
    : booted ? { label: 'LIVE', tone: 'ok' as const } : { label: 'BOOTING', tone: 'warn' as const }
  const beacon = status.tone === 'ok' ? 'bg-ok' : status.tone === 'bad' ? 'bg-p1' : 'bg-warn'
  const mode = modeChip(snap.metrics.mode, snap.metrics.model, snap.status !== 'live')

  const items: MenuItem[] = [
    {
      id: 'auto', label: 'Auto-Dispatch', icon: <Zap size={18} />, pressed: autoDispatch, disabled: ended || offline, onSelect: onToggleAuto,
      hint: autoDispatch ? 'ON — recommendations are sent without asking (demo mode).' : 'OFF — you approve every dispatch.',
    },
    { id: 'units', label: 'Show Units on the Map', icon: <Truck size={18} />, pressed: showUnits, onSelect: onToggleUnits },
    { id: 'theme', label: theme === 'dark' ? 'Switch to the Light Theme' : 'Switch to the Dark Theme', icon: theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />, onSelect: onToggleTheme, className: 'sm:hidden' },
    { id: 'guide', label: 'How It Works', icon: <BookOpen size={18} />, onSelect: onGuide, hint: 'A 4-step walkthrough.' },
    {
      id: 'csv', label: 'Download After-Action CSV', icon: <Download size={18} />, href: exportUrl ?? undefined, disabled: !exportUrl,
      hint: exportUrl ? 'Every report and audit-log line of this drill.' : 'Needs a connected database.',
    },
    { id: 'end', label: 'End the Drill', icon: <Flag size={18} />, onSelect: onEndDrill, disabled: ended || offline || !booted, hint: 'Freezes the picture for review.' },
    {
      id: 'reset', label: 'Restart the Drill', icon: resetting ? <Loader2 size={18} className="animate-spin" /> : <RotateCcw size={18} />,
      danger: true, onSelect: onReset, disabled: resetting || offline, hint: 'Clears this drill and starts over.',
    },
  ]

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line bg-panel px-3 sm:gap-3 lg:px-4">
      {leading}
      <div className="flex min-w-0 shrink-0 items-center gap-2.5">
        <h1 className="whitespace-nowrap text-lg font-extrabold tracking-tight text-ink">
          Mission<span className="text-accent">Sync</span>
        </h1>
        <Chip tone={status.tone} title={`Drill status: ${status.label}`}>
          <span className="relative flex h-2 w-2" aria-hidden>
            {status.tone === 'ok' && <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${beacon}`} />}
            <span className={`relative inline-flex h-2 w-2 rounded-full ${beacon}`} />
          </span>
          <span className={status.tone === 'ok' ? 'max-sm:sr-only' : ''}>{status.label}</span>
        </Chip>
      </div>

      {title && <span className="hidden min-w-0 max-w-[16rem] truncate text-base font-semibold text-ink-2 md:block" title={title}>{title}</span>}
      <EngineChips snap={snap} className="hidden lg:flex" />

      <div className="ml-auto flex items-center gap-2">
        <button
          type="button"
          onClick={onToggleAuto}
          aria-pressed={autoDispatch}
          disabled={ended || offline}
          title={autoDispatch ? 'Auto-dispatch is ON: recommendations are sent without asking. Click to approve each one yourself.' : 'You approve every dispatch. Click to switch to auto-dispatch (demo).'}
          className="hidden h-11 items-center gap-2 rounded-md border border-line bg-hi px-3 text-base font-semibold text-ink transition-colors hover:border-accent disabled:opacity-50 aria-pressed:border-accent/60 aria-pressed:text-accent xl:inline-flex"
        >
          <Zap size={16} aria-hidden />
          {autoDispatch ? 'Auto-Dispatch' : 'Manual Approval'}
        </button>
        <DrillMenu
          items={items}
          header={<span className="inline-flex items-center gap-1.5"><span className={`h-2 w-2 rounded-full ${mode.tone === 'ok' ? 'bg-ok' : mode.tone === 'bad' ? 'bg-p1' : 'bg-warn'}`} aria-hidden />{mode.label}</span>}
        />
        <button type="button" className={`${iconBtn} max-sm:hidden`} onClick={onToggleTheme} title="Switch between dark and light" aria-label="Toggle Color Theme">
          {theme === 'dark' ? <Sun size={18} aria-hidden /> : <Moon size={18} aria-hidden />}
        </button>
        {trailing}
      </div>
    </header>
  )
}
