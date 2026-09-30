import { Crosshair, Radio, Target, Truck, type LucideIcon } from 'lucide-react'

export type View = 'situation' | 'orders' | 'report' | 'fleet'

export const VIEWS: Array<{ id: View; label: string; hint: string; Icon: LucideIcon }> = [
  { id: 'situation', label: 'Situation', hint: 'Map and ranked incidents', Icon: Crosshair },
  { id: 'orders', label: 'Orders', hint: 'Approve or reject proposed dispatches', Icon: Target },
  { id: 'report', label: 'Report', hint: 'Field report intake and the audit log', Icon: Radio },
  { id: 'fleet', label: 'Fleet', hint: 'Every unit, its status and assignment', Icon: Truck },
]

/** Desktop navigation rail: one section per panel, the same mental model as the phone's bottom tabs. */
export default function SideNav({ view, onChange, badge }: { view: View; onChange: (v: View) => void; badge: Partial<Record<View, number>> }) {
  return (
    <nav aria-label="Sections" className="flex w-[96px] shrink-0 flex-col gap-1 border-r border-line bg-panel px-2 py-3">
      {VIEWS.map(({ id, label, hint, Icon }, i) => {
        const active = view === id
        const n = badge[id]
        return (
          <button
            key={id}
            type="button"
            onClick={() => onChange(id)}
            aria-current={active ? 'page' : undefined}
            aria-label={n != null && n > 0 ? `${label}, ${n} ${id === 'orders' ? 'awaiting approval' : 'P1/P2'}` : label}
            aria-keyshortcuts={String(i + 1)}
            title={`${hint} (${i + 1})`}
            className={`relative flex h-[72px] flex-col items-center justify-center gap-1 rounded-lg border text-xs font-semibold transition-colors ${
              active ? 'border-accent/50 bg-accent/10 text-accent' : 'border-transparent text-ink-2 hover:bg-hi hover:text-ink'
            }`}
          >
            {active && <span className="absolute -left-2 top-3 h-[calc(100%-24px)] w-1 rounded-r bg-accent" aria-hidden />}
            <span className="relative">
              <Icon size={22} aria-hidden />
              {n != null && n > 0 && (
                <span className="absolute -right-3.5 -top-2 min-w-[22px] rounded-full bg-p1 px-1 text-center font-mono text-base font-bold leading-5 text-white tnum" aria-hidden>
                  {n}
                </span>
              )}
            </span>
            {label}
          </button>
        )
      })}
    </nav>
  )
}
