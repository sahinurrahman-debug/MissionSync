import { Truck, Undo2 } from 'lucide-react'
import type { Incident, Resource, ResourceStatus } from '../types'
import { haversineKm } from '../engine/geo'
import { etaMinutes } from '../engine/agents'
import { RESOURCE_LABEL, STATUS_LABEL, etaClock } from '../lib/format'
import { RESOURCE_ICON } from '../lib/icons'
import { FleetSkeleton } from './Skeletons'

// Explicit class names (not string-built) so Tailwind can see them.
const STATUS_CHIP: Record<ResourceStatus, string> = {
  available: 'border-ok/40 bg-ok/15 text-ok',
  en_route: 'border-route/40 bg-route/15 text-route',
  on_scene: 'border-scene/40 bg-scene/15 text-scene',
  returning: 'border-ret/40 bg-ret/15 text-ink-2',
}
const STATUS_DOT: Record<ResourceStatus, string> = { available: 'bg-ok', en_route: 'bg-route', on_scene: 'bg-scene', returning: 'bg-ret' }

/** Seconds-accurate countdown to wherever the unit is heading. */
function etaFor(r: Resource, inc: Incident | undefined): number | null {
  if (r.status === 'en_route' && inc) return etaMinutes(r, inc)
  if (r.status === 'returning') {
    const km = haversineKm(r.current_lat ?? r.base_lat, r.current_lon ?? r.base_lon, r.base_lat, r.base_lon)
    return (km / Math.max(r.speed_kph, 1)) * 60
  }
  return null
}

export default function ResourceBoard({
  resources, incidents, loading, onRecall, disabled,
}: { resources: Resource[]; incidents: Incident[]; loading: boolean; onRecall?: (unitId: string) => void; disabled?: boolean }) {
  if (loading) return <FleetSkeleton />
  const byId = new Map(incidents.map((i) => [i.id, i]))
  const counts = resources.reduce<Record<string, number>>((acc, r) => ((acc[r.status] = (acc[r.status] ?? 0) + 1), acc), {})

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-3 py-1.5">
        {(Object.keys(STATUS_LABEL) as ResourceStatus[]).map((s) => (
          <span key={s} className="inline-flex items-center gap-1.5 text-sm text-ink-2">
            <i className={`h-2 w-2 rounded-full ${STATUS_DOT[s]}`} aria-hidden />
            {STATUS_LABEL[s]} <b className="font-mono text-ink tnum">{counts[s] ?? 0}</b>
          </span>
        ))}
      </div>
      <ul className="min-h-0 flex-1 divide-y divide-line overflow-y-auto">
        {resources.map((r) => {
          const inc = r.assigned_incident ? byId.get(r.assigned_incident) : undefined
          const Icon = RESOURCE_ICON[r.type] ?? Truck
          const eta = etaFor(r, inc)
          const tags = r.capacity_note.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 2)
          return (
            <li key={r.id} className="grid h-[52px] grid-cols-[minmax(0,1fr)_92px_64px] items-center gap-2 px-3">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <Icon size={15} className="shrink-0 text-ink-2" aria-label={RESOURCE_LABEL[r.type]} />
                  <span className="truncate text-base font-semibold text-ink">{r.name}</span>
                  {onRecall && (r.status === 'en_route' || r.status === 'on_scene') && (
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => onRecall(r.id)}
                      aria-label={`Recall ${r.name}`}
                      title="Recall this unit"
                      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-ink-2 hover:bg-hi hover:text-p1 disabled:opacity-40 max-lg:h-9 max-lg:w-9"
                    >
                      <Undo2 size={14} aria-hidden />
                    </button>
                  )}
                  {tags.map((t) => (
                    <span key={t} className="hidden shrink-0 rounded border border-line px-1 text-xs text-ink-2 2xl:inline">{t}</span>
                  ))}
                </div>
                <div className="truncate text-sm text-ink-2">
                  {inc ? <>→ {inc.title}</> : r.status === 'returning' ? 'returning to base' : `${RESOURCE_LABEL[r.type]} · ${r.personnel} personnel`}
                </div>
              </div>
              <span className={`inline-flex h-7 items-center justify-center rounded-md border px-1.5 text-xs font-bold uppercase tracking-micro ${STATUS_CHIP[r.status]}`}>
                {STATUS_LABEL[r.status]}
              </span>
              <span className="text-right font-mono text-sm font-bold text-ink tnum">{eta != null ? etaClock(eta) : r.status === 'on_scene' ? 'HERE' : '—'}</span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
