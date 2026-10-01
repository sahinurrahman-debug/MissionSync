import { useState } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { Clock, Flag, MapPin, ShieldCheck, Undo2, Users } from 'lucide-react'
import type { Incident, Proposal, Resource, RiskBreakdown } from '../types'
import { etaMinutes, isCapable } from '../engine/agents'
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

export interface IncidentActions {
  onRecall: (unitId: string) => void
  onResolve: (incidentId: string, status: 'contained' | 'closed') => void
  onDispatch: (incidentId: string, resourceId: string) => void
}

const actionBtn =
  'inline-flex h-8 items-center gap-1.5 rounded-md border border-line bg-hi px-2.5 text-sm font-semibold text-ink-2 transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40 max-lg:h-11'

export default function IncidentCard({
  incident, rank, selected, onSelect, units, proposed = [], availableUnits = [], now, actions, disabled,
}: {
  incident: Incident
  rank: number
  selected: boolean
  onSelect: (id: string | null) => void
  units: Resource[]
  proposed?: Proposal[]
  availableUnits?: Resource[]
  now: number
  actions?: IncidentActions
  disabled?: boolean
}) {
  const reduce = useReducedMotion()
  const [pick, setPick] = useState('')
  const tier = incident.risk?.tier ?? 'P4'
  const b = incident.risk?.breakdown
  const TypeIcon = INCIDENT_ICON[incident.type]
  const capable = availableUnits.filter((r) => isCapable(r, incident))

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
          title={selected ? 'Selected — shown on the map' : 'Select to focus on the map'}
          className="block w-full px-3 pb-2 pt-2.5 text-left"
        >
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <TierPill tier={tier} urgency={incident.risk?.urgency} rank={rank} />
            <SourceBadge source={incident.risk?.source} provisional={incident.provisional} />
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
                    <dd aria-hidden="true" className="col-span-2 h-1.5 overflow-hidden rounded-full bg-line">
                      <motion.div
                        className={`h-full rounded-full ${TIER_BG[tier]}`}
                        initial={reduce ? false : { width: 0 }}
                        animate={{ width: `${v}%` }}
                        transition={{ duration: 0.5, ease: 'easeOut' }}
                      />
                    </dd>
                  </div>
                )
              })}
            </dl>
            {b.rationale && <p className="mt-2 border-l-2 border-line pl-2 text-sm italic text-ink-2">“{b.rationale}”</p>}
          </div>
        )}

        {selected && actions && (
          <div className="flex flex-wrap items-center gap-2 border-t border-line px-3 py-2" role="group" aria-label="Net control actions">
            <span className={micro}>Net control</span>
            <button type="button" className={actionBtn} disabled={disabled} onClick={() => actions.onResolve(incident.id, 'contained')}>
              <ShieldCheck size={15} aria-hidden /> Mark contained
            </button>
            <button type="button" className={actionBtn} disabled={disabled} onClick={() => actions.onResolve(incident.id, 'closed')}>
              <Flag size={15} aria-hidden /> Close
            </button>
            {capable.length > 0 && (
              <span className="inline-flex items-center gap-1.5">
                <label htmlFor={`dispatch-${incident.id}`} className="sr-only">Send a unit to {incident.title}</label>
                <select
                  id={`dispatch-${incident.id}`}
                  value={pick}
                  onChange={(e) => setPick(e.target.value)}
                  className="h-8 max-w-[11rem] rounded-md border border-line bg-bg px-2 text-sm text-ink max-lg:h-11"
                >
                  <option value="">Send a unit…</option>
                  {capable.map((r) => (
                    <option key={r.id} value={r.id}>{r.name} · ETA {etaClock(etaMinutes(r, incident))}</option>
                  ))}
                </select>
                <button
                  type="button"
                  className={actionBtn}
                  disabled={disabled || !pick}
                  onClick={() => { actions.onDispatch(incident.id, pick); setPick('') }}
                >
                  Dispatch
                </button>
              </span>
            )}
          </div>
        )}

        <div className="flex min-h-[38px] flex-wrap items-center gap-1.5 border-t border-line px-3 py-1.5">
          <span className={`${micro} mr-1`}>Units</span>
          {units.length === 0 && proposed.length === 0 ? (
            <span className="text-sm text-ink-2">none assigned</span>
          ) : (
            <>
              {units.map((r) => {
                const Icon = RESOURCE_ICON[r.type]
                const onScene = r.status === 'on_scene'
                return (
                  <span key={r.id} className={`inline-flex items-center gap-1 rounded-md border py-0.5 pl-1.5 text-sm ${actions ? 'pr-0.5' : 'pr-1.5'} ${onScene ? 'border-scene/40 text-scene' : 'border-route/40 text-route'}`}>
                    <Icon size={13} aria-hidden />
                    {r.name}
                    <span className="font-mono text-xs tnum text-ink-2">{onScene ? 'On scene' : `ETA ${etaClock(etaMinutes(r, incident))}`}</span>
                    {actions && (
                      <button
                        type="button"
                        disabled={disabled}
                        onClick={() => actions.onRecall(r.id)}
                        aria-label={`Recall ${r.name}`}
                        title="Recall this unit"
                        className="inline-flex h-6 w-6 items-center justify-center rounded text-ink-2 hover:bg-hi hover:text-p1 disabled:opacity-40 max-lg:h-9 max-lg:w-9"
                      >
                        <Undo2 size={13} aria-hidden />
                      </button>
                    )}
                  </span>
                )
              })}
              {proposed.map((p) => {
                const Icon = RESOURCE_ICON[p.resource_type]
                return (
                  <span key={p.id} className="inline-flex items-center gap-1 rounded-md border border-dashed border-accent/60 px-1.5 py-0.5 text-sm text-ink-2" title="Proposed — awaiting approval in Orders">
                    <Icon size={13} className="text-accent" aria-hidden />
                    {p.resource_name}
                    <span className="font-mono text-xs tnum">proposed</span>
                  </span>
                )
              })}
            </>
          )}
        </div>
      </div>
    </motion.li>
  )
}
