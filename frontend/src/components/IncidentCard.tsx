import { motion, useReducedMotion } from 'framer-motion'
import { Clock, MapPin, Users } from 'lucide-react'
import type { Incident, Resource, RiskBreakdown } from '../types'
import { etaMinutes } from '../engine/agents'
import { INCIDENT_STATUS_LABEL, TYPE_LABEL, elapsed, etaClock } from '../lib/format'
import { INCIDENT_ICON, RESOURCE_ICON } from '../lib/icons'
import { SourceBadge, TIER_BG, TIER_BORDER, TierPill, micro } from './ui'

const FACTORS: Array<[keyof RiskBreakdown, string]> = [
  ['severity', 'Severity'],
  ['population', 'Population at risk'],
  ['spread', 'Spread potential'],
  ['time_criticality', 'Time criticality'],
]

/** The title is the report's first ~70 chars; show only what the title doesn't already say. */
export function summaryOf(inc: Pick<Incident, 'title' | 'description'>): string {
  const d = inc.description.trim().split(' | ')[0]
  if (inc.title.endsWith('…')) return d               // title was cut mid-sentence: show the whole report
  const stem = inc.title.trim().toLowerCase()
  const rest = d.toLowerCase().startsWith(stem) ? d.slice(stem.length).replace(/^[\s.,:;—-]+/, '') : d
  return rest || d
}

export default function IncidentCard({
  incident, rank, selected, onSelect, units, now,
}: {
  incident: Incident
  rank: number
  selected: boolean
  onSelect: (id: string | null) => void
  units: Resource[]
  now: number
}) {
  const reduce = useReducedMotion()
  const tier = incident.risk?.tier ?? 'P4'
  const b = incident.risk?.breakdown
  const TypeIcon = INCIDENT_ICON[incident.type]

  return (
    <motion.li
      id={`inc-${incident.id}`}
      layout={reduce ? false : 'position'}
      initial={reduce ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reduce ? undefined : { opacity: 0, scale: 0.98 }}
      transition={{ type: 'spring', stiffness: 520, damping: 42, mass: 0.7 }}
      className="list-none"
    >
      <div
        className={`rounded-lg border border-l-4 bg-panel transition-colors ${TIER_BORDER[tier]} ${
          selected ? 'border-y-line border-r-line bg-hi shadow-glow' : 'border-y-line border-r-line hover:bg-hi'
        }`}
      >
        <button
          type="button"
          onClick={() => onSelect(selected ? null : incident.id)}
          aria-pressed={selected}
          aria-label={`${incident.title}. Rank ${rank}, ${tier}. ${selected ? 'Selected' : 'Select to focus on the map'}`}
          className="block w-full px-3 pb-2 pt-2.5 text-left"
        >
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <TierPill tier={tier} urgency={incident.risk?.urgency} rank={rank} />
            <SourceBadge source={incident.risk?.source} />
            <span className="ml-auto inline-flex items-center gap-1 font-mono text-xs text-ink-2 tnum">
              <Clock size={12} aria-hidden />
              {elapsed(incident.reported_at, now)}
            </span>
          </span>

          <span className="mt-1.5 block truncate text-base font-bold leading-snug text-ink">{incident.title}</span>
          <span className="mt-0.5 line-clamp-2 block text-sm leading-snug text-ink-2">{summaryOf(incident)}</span>

          <span className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-2">
            <span className="inline-flex items-center gap-1"><TypeIcon size={14} aria-hidden />{TYPE_LABEL[incident.type]}</span>
            <span className="inline-flex items-center gap-1">
              <MapPin size={14} aria-hidden />
              {incident.zone}{incident.location_known ? '' : ' · approx.'}
            </span>
            <span className="inline-flex items-center gap-1 tnum"><Users size={14} aria-hidden />{incident.affected_population} at risk · {incident.injuries} inj</span>
            <span className="rounded border border-line px-1.5 text-xs font-semibold uppercase tracking-micro">{INCIDENT_STATUS_LABEL[incident.status]}</span>
          </span>
        </button>

        {selected && b && (
          <div className="border-t border-line px-3 py-2.5" aria-label="Urgency breakdown">
            <div className={`${micro} mb-1.5`}>Auditable score · severity 35% · population 25% · spread 20% · time 20%</div>
            <dl className="grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-2">
              {FACTORS.map(([key, label]) => {
                const v = Math.round(Number(b[key]))
                return (
                  <div key={key} className="grid grid-cols-[1fr_auto] items-center gap-x-2">
                    <dt className="text-sm text-ink-2">{label}</dt>
                    <dd className="font-mono text-sm font-bold text-ink tnum">{v}<span className="text-ink-2">/100</span></dd>
                    <div className="col-span-2 h-1.5 overflow-hidden rounded-full bg-line">
                      <motion.div
                        className={`h-full rounded-full ${TIER_BG[tier]}`}
                        initial={reduce ? false : { width: 0 }}
                        animate={{ width: `${v}%` }}
                        transition={{ duration: 0.5, ease: 'easeOut' }}
                      />
                    </div>
                  </div>
                )
              })}
            </dl>
            {b.rationale && <p className="mt-2 border-l-2 border-line pl-2 text-sm italic text-ink-2">“{b.rationale}”</p>}
          </div>
        )}

        <div className="flex min-h-[38px] flex-wrap items-center gap-1.5 border-t border-line px-3 py-1.5">
          <span className={`${micro} mr-1`}>Units</span>
          {units.length === 0 ? (
            <span className="text-sm text-ink-2">none assigned</span>
          ) : (
            units.map((r) => {
              const Icon = RESOURCE_ICON[r.type]
              const onScene = r.status === 'on_scene'
              return (
                <span key={r.id} className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-sm ${onScene ? 'border-scene/40 text-scene' : 'border-route/40 text-route'}`}>
                  <Icon size={13} aria-hidden />
                  {r.name}
                  <span className="font-mono text-xs tnum text-ink-2">{onScene ? 'On scene' : `ETA ${etaClock(etaMinutes(r, incident))}`}</span>
                </span>
              )
            })
          )}
        </div>
      </div>
    </motion.li>
  )
}
