import { ArrowRight, CheckCheck, FileText, Flag, Loader2, Radio, Truck } from 'lucide-react'
import type { ReactNode } from 'react'
import type { Snapshot } from '../types'

export type Target = 'orders' | 'report'

/** `lead` is always shown; `rest` is the explanation, dropped on phones to keep the bar to one line. */
export interface Step { id: string; icon: ReactNode; lead: string; rest?: string; action?: { label: string; target: Target } }

/** What should the operator do right now? Derived from the world state, so the board explains itself. */
export function nextStepOf(snap: Snapshot): Step {
  const pending = snap.proposals.length
  const active = snap.incidents.length
  const busy = snap.resources.filter((r) => r.status === 'en_route' || r.status === 'on_scene').length
  if (snap.status === 'booting') {
    return { id: 'booting', icon: <Loader2 size={18} className="animate-spin" />, lead: 'Setting up the drill…', rest: 'Loading incidents and ranking them.' }
  }
  if (snap.status === 'ended') {
    return { id: 'ended', icon: <Flag size={18} />, lead: 'The drill has ended.', rest: 'Download the CSV from the menu, or restart to run another.' }
  }
  if (pending > 0 && !snap.settings.auto_dispatch) {
    return {
      id: 'approve',
      icon: <CheckCheck size={18} />,
      lead: `${pending} ${pending === 1 ? 'dispatch is' : 'dispatches are'} waiting for you.`,
      rest: 'Approve or reject each suggested unit.',
      action: { label: 'Review', target: 'orders' },
    }
  }
  if (active === 0) {
    return {
      id: 'report', icon: <Radio size={18} />,
      lead: 'No incidents yet.', rest: 'Type what a field team reports to start the drill.',
      action: { label: 'Add Report', target: 'report' },
    }
  }
  if (busy > 0) {
    return {
      id: 'watch', icon: <Truck size={18} />,
      lead: `${busy} ${busy === 1 ? 'unit is' : 'units are'} responding.`, rest: 'Add another report, or close incidents as they are contained.',
      action: { label: 'Add Report', target: 'report' },
    }
  }
  return {
    id: 'idle', icon: <FileText size={18} />,
    lead: 'All units are free.', rest: 'Add a field report to keep the drill moving.',
    action: { label: 'Add Report', target: 'report' },
  }
}

/** One calm line under the header: what is happening, and the single button that moves the drill forward. */
export default function NextStep({ snap, onGo }: { snap: Snapshot; onGo: (t: Target) => void }) {
  const step = nextStepOf(snap)
  return (
    <div role="status" aria-label="Next step" className="flex shrink-0 items-center gap-3 rounded-lg border border-accent/30 bg-accent/10 px-3 py-1.5 text-base text-ink">
      <span className="shrink-0 text-accent" aria-hidden>{step.icon}</span>
      <span className="min-w-0 flex-1 leading-snug">
        <b>{step.lead}</b>
        {step.rest && <span className="max-sm:sr-only"> {step.rest}</span>}
      </span>
      {step.action && (
        <button
          type="button"
          onClick={() => onGo(step.action!.target)}
          className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-md bg-accent px-3 text-base font-bold text-bg hover:brightness-110 sm:h-10"
        >
          {step.action.label} <ArrowRight size={16} aria-hidden />
        </button>
      )}
    </div>
  )
}
