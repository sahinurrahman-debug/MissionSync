import { CheckCheck, ListOrdered, Radio, Truck } from 'lucide-react'
import Modal from './Modal'

const STEPS = [
  { Icon: Radio, title: 'Report', text: 'Type what a field team radios in — “fire near the University lab, 3 trapped”. The place words put it on the map.' },
  { Icon: ListOrdered, title: 'Review', text: 'Every incident gets an urgency score from 0 to 100 and a tier, P1 (critical) to P4. The most urgent is always first.' },
  { Icon: CheckCheck, title: 'Approve', text: 'The AI proposes which unit to send. Nothing moves until you press Approve — or Reject to get the next-best unit.' },
  { Icon: Truck, title: 'Watch', text: 'Approved units drive to the scene, work it and return. Close incidents when they are contained, then end the drill.' },
]

const KEY = 'ms-guide-seen'

export function guideSeen(): boolean {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return true
  }
}

export function markGuideSeen(): void {
  try {
    localStorage.setItem(KEY, '1')
  } catch {
    /* ignore */
  }
}

/** First-run walkthrough, reopenable from the menu. Four steps, one sentence each. */
export default function HowItWorks({ onClose }: { onClose: () => void }) {
  const close = () => { markGuideSeen(); onClose() }
  return (
    <Modal title="How MissionSync works" describedBy="guide-intro" onClose={close} wide initialFocus="[data-start]">
      <p id="guide-intro" className="mt-1 text-base text-ink-2">
        A practice board for emergency-response drills. You run the radio; MissionSync keeps the picture and suggests the next move.
      </p>
      <ol className="mt-3 space-y-3">
        {STEPS.map(({ Icon, title, text }, i) => (
          <li key={title} className="flex gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-accent/40 bg-accent/10 text-accent" aria-hidden>
              <Icon size={20} />
            </span>
            <span className="min-w-0">
              <span className="block text-base font-bold text-ink">{i + 1}. {title}</span>
              <span className="block text-base text-ink-2">{text}</span>
            </span>
          </li>
        ))}
      </ol>
      <button type="button" data-start onClick={close} className="mt-4 h-11 w-full rounded-md bg-accent text-base font-bold text-bg hover:brightness-110">
        Got it — start
      </button>
    </Modal>
  )
}
