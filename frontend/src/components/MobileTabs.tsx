import { ListOrdered, Map as MapIcon, Radio, Target, Truck, type LucideIcon } from 'lucide-react'

export type MobileTab = 'map' | 'feed' | 'orders' | 'report' | 'fleet'

const TABS: Array<{ id: MobileTab; label: string; Icon: LucideIcon }> = [
  { id: 'map', label: 'Map', Icon: MapIcon },
  { id: 'feed', label: 'Incidents', Icon: ListOrdered },
  { id: 'orders', label: 'Orders', Icon: Target },
  { id: 'report', label: 'Report', Icon: Radio },
  { id: 'fleet', label: 'Units', Icon: Truck },
]

/** Bottom navigation for phones and small tablets: thumb-reachable, 56px tall. */
export default function MobileTabs({ tab, onChange, badge }: { tab: MobileTab; onChange: (t: MobileTab) => void; badge: Partial<Record<MobileTab, number>> }) {
  return (
    <nav aria-label="Sections" className="flex h-14 shrink-0 border-t border-line bg-panel pb-[env(safe-area-inset-bottom)]">
      {TABS.map(({ id, label, Icon }) => {
        const active = tab === id
        const n = badge[id]
        return (
          <button
            key={id}
            type="button"
            onClick={() => onChange(id)}
            aria-current={active ? 'page' : undefined}
            className={`relative flex flex-1 flex-col items-center justify-center gap-0.5 text-xs font-semibold transition-colors ${active ? 'text-accent' : 'text-ink-2'}`}
          >
            {active && <span className="absolute inset-x-4 top-0 h-0.5 rounded-b bg-accent" aria-hidden />}
            <span className="relative">
              <Icon size={20} aria-hidden />
              {n != null && n > 0 && (
                <span className="absolute -right-2.5 -top-1.5 min-w-[16px] rounded-full bg-p1 px-1 text-center font-mono text-[10px] font-bold leading-4 text-white tnum">{n}</span>
              )}
            </span>
            {label}
          </button>
        )
      })}
    </nav>
  )
}
