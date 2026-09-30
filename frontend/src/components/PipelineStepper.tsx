import { Check, Loader2 } from 'lucide-react'
import type { PipelineStage } from '../types'

const STEPS: Array<{ id: Exclude<PipelineStage, 'idle'>; label: string }> = [
  { id: 'surveillance', label: 'Surveillance' },
  { id: 'terrain', label: 'Terrain' },
  { id: 'risk', label: 'Risk' },
  { id: 'logistics', label: 'Logistics' },
  { id: 'command', label: 'Command' },
]

/** The five agents as a stepper. Active stage glows; finished stages are checked. */
export default function PipelineStepper({ stage, busy }: { stage: PipelineStage; busy: boolean }) {
  const active = STEPS.findIndex((s) => s.id === stage)
  return (
    <ol className="flex items-center gap-1.5" aria-label="AI pipeline progress">
      {STEPS.map((s, i) => {
        const running = busy && i === active
        const done = busy && active > i
        return (
          <li key={s.id} className="flex min-w-0 flex-1 items-center gap-1">
            <div
              aria-current={running ? 'step' : undefined}
              className={`flex h-7 min-w-0 flex-1 items-center justify-center gap-1 rounded-md border px-1 text-xs font-semibold uppercase tracking-normal transition-colors ${
                running
                  ? 'animate-stage-glow border-accent bg-accent/15 text-accent'
                  : done
                    ? 'border-ok/40 bg-ok/10 text-ok'
                    : 'border-line bg-hi text-ink-2'
              }`}
            >
              {running ? <Loader2 size={12} className="shrink-0 animate-spin" aria-hidden /> : done ? <Check size={12} className="shrink-0" aria-hidden /> : null}
              <span className="truncate">{s.label}</span>
            </div>
          </li>
        )
      })}
    </ol>
  )
}
