import { CheckCircle2, GitMerge, TriangleAlert, Truck, Dot } from 'lucide-react'
import type { EventLine } from '../types'
import { logTone, stripMarker } from '../lib/format'
import EmptyRadar from './EmptyRadar'

const TONE = {
  deploy: { Icon: Truck, cls: 'text-route' },
  merge: { Icon: GitMerge, cls: 'text-accent' },
  alert: { Icon: TriangleAlert, cls: 'text-warn' },
  done: { Icon: CheckCircle2, cls: 'text-ok' },
  info: { Icon: Dot, cls: 'text-ink-2' },
} as const

/** Timestamped audit trail: every parse → merge → rank → dispatch step, newest first. */
export default function EventLog({ lines }: { lines: EventLine[] }) {
  if (lines.length === 0) return <EmptyRadar title="Listening." hint="Pipeline events appear here as the drill runs." />
  const ordered = [...lines].reverse()
  return (
    <ul className="divide-y divide-line/60 font-mono text-sm leading-snug" role="log" aria-live="off" aria-label="Audit log, newest first">
      {ordered.map((line, i) => {
        const { Icon, cls } = TONE[logTone(line.msg)]
        return (
          <li key={line.seq} className={`flex items-start gap-2 px-3 py-1.5 ${i === 0 ? 'animate-fade-up bg-hi text-ink' : 'text-ink-2'}`}>
            <time className="shrink-0 pt-px text-xs text-ink-2 tnum">{line.t}</time>
            <Icon size={14} className={`mt-0.5 shrink-0 ${cls}`} aria-hidden />
            <span className="min-w-0 break-words">{stripMarker(line.msg)}</span>
          </li>
        )
      })}
    </ul>
  )
}
