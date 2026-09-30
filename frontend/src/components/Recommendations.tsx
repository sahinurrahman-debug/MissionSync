import { Check, CheckCheck, CheckSquare, ShieldAlert, Target, TriangleAlert, Wind, X } from 'lucide-react'
import type { Proposal, RecommendedAction, Tier } from '../types'
import { etaClock } from '../lib/format'
import { RESOURCE_ICON } from '../lib/icons'
import EmptyRadar from './EmptyRadar'
import { RecommendationSkeleton } from './Skeletons'
import { Panel, PanelHeader, TIER_BORDER, TIER_TEXT, micro } from './ui'

function tierOf(a: RecommendedAction): Tier {
  const u = a.urgency
  return u >= 75 ? 'P1' : u >= 55 ? 'P2' : u >= 35 ? 'P3' : 'P4'
}

function isWind(w: string): boolean { return /wind|kph/i.test(w) }

/** One recommended assignment with the two human decisions: approve or reject. */
export function ProposalChip({
  p, onApprove, onReject, disabled,
}: { p: Proposal; onApprove: (id: string) => void; onReject: (id: string) => void; disabled?: boolean }) {
  const Icon = RESOURCE_ICON[p.resource_type]
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-accent/60 bg-accent/5 py-0.5 pl-2 pr-0.5 text-sm text-ink"
      title={p.rationale || `Recommended by the ${p.source === 'llm' ? 'AI logistics agent' : 'rule-based matcher'}`}
    >
      <Icon size={14} className="text-accent" aria-hidden />
      {p.resource_name}
      <span className="text-ink-2">{p.role}</span>
      <span className="font-mono text-xs font-bold text-accent tnum">ETA {etaClock(p.eta_minutes)}</span>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onApprove(p.id)}
        aria-label={`Approve ${p.resource_name} to ${p.incident_title}`}
        title="Approve this dispatch"
        className="inline-flex h-7 w-7 items-center justify-center rounded text-ok hover:bg-ok/15 disabled:opacity-40 max-lg:h-9 max-lg:w-9"
      >
        <Check size={16} aria-hidden />
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onReject(p.id)}
        aria-label={`Reject ${p.resource_name} for ${p.incident_title}`}
        title="Reject — propose someone else"
        className="inline-flex h-7 w-7 items-center justify-center rounded text-p1 hover:bg-p1/15 disabled:opacity-40 max-lg:h-9 max-lg:w-9"
      >
        <X size={16} aria-hidden />
      </button>
    </span>
  )
}

export default function Recommendations({
  actions, proposals, loading, autoDispatch, onApprove, onReject, disabled,
}: {
  actions: RecommendedAction[]
  proposals: Proposal[]
  loading: boolean
  autoDispatch: boolean
  onApprove: (ids?: string[]) => void
  onReject: (id: string) => void
  disabled?: boolean
}) {
  const top = actions[0]
  const carded = new Set(actions.map((a) => a.incident_id))
  const others = proposals.filter((p) => !carded.has(p.incident_id))
  const byIncident = (id: string) => proposals.filter((p) => p.incident_id === id)

  return (
    <Panel className="h-full" label="Command recommendations">
      <PanelHeader
        title="Command recommendations"
        icon={<Target size={15} />}
        right={
          proposals.length > 0 ? (
            <button
              type="button"
              disabled={disabled}
              onClick={() => onApprove()}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-accent px-2.5 text-xs font-bold uppercase tracking-micro text-bg hover:brightness-110 disabled:opacity-40 max-lg:h-10"
            >
              <CheckCheck size={14} aria-hidden /> Approve all ({proposals.length})
            </button>
          ) : top ? (
            <span className="truncate">top: <b className="text-ink">#{top.priority}</b></span>
          ) : undefined
        }
      />
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
        {!autoDispatch && proposals.length > 0 && (
          <p className="rounded-md border border-accent/30 bg-accent/10 px-2 py-1 text-sm text-ink">
            <b>Nothing moves until you approve.</b> Dashed chips are recommended deployments — approve or reject each, or approve them all.
          </p>
        )}
        {loading ? (
          <RecommendationSkeleton />
        ) : actions.length === 0 && others.length === 0 ? (
          <EmptyRadar title="No orders yet." hint="The command agent issues orders once incidents are ranked." />
        ) : (
          <>
            {actions.map((a, i) => {
              const tier = tierOf(a)
              const mine = byIncident(a.incident_id)
              return (
                <article
                  key={a.incident_id}
                  className={`relative overflow-hidden rounded-lg border bg-hi pl-3 animate-fade-up ${i === 0 ? 'border-2' : 'border'} ${i === 0 ? TIER_BORDER[tier] : 'border-line'}`}
                  style={{ animationDelay: `${i * 50}ms` }}
                >
                  {/* hazard-stripe accent on the order that needs action first */}
                  <span aria-hidden className={`absolute inset-y-0 left-0 w-1.5 ${i === 0 ? 'hazard-stripe' : 'bg-line'}`} />
                  <div className="py-2.5 pr-3">
                    <div className="flex items-start gap-2">
                      <span className={`shrink-0 rounded border border-current px-1.5 py-0.5 font-mono text-xs font-bold tnum ${TIER_TEXT[tier]}`}>#{a.priority} · {tier}</span>
                      <h3 className="text-base font-bold leading-snug text-ink">{a.headline.replace(/^\[P\d\]\s*/, '')}</h3>
                      <span className="ml-auto shrink-0 font-mono text-base font-bold text-ink tnum" aria-label={`urgency ${Math.round(a.urgency)}`}>{Math.round(a.urgency)}</span>
                    </div>

                    <ul className="mt-2 space-y-1">
                      {a.details.slice(0, 4).map((d, j) => (
                        <li key={j} className="flex items-start gap-2 text-base leading-snug text-ink">
                          <CheckSquare size={16} className="mt-0.5 shrink-0 text-ok" aria-hidden />
                          <span>{d}</span>
                        </li>
                      ))}
                    </ul>

                    {a.warnings.map((w, j) => (
                      <p key={j} className="mt-2 flex items-start gap-2 rounded-md border border-warn/30 bg-warn/10 px-2 py-1 text-sm text-warn">
                        {isWind(w) ? <Wind size={15} className="mt-0.5 shrink-0" aria-hidden /> : <TriangleAlert size={15} className="mt-0.5 shrink-0" aria-hidden />}
                        <span>{w}</span>
                      </p>
                    ))}

                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <span className={`${micro} mr-0.5 inline-flex items-center gap-1`}><ShieldAlert size={13} aria-hidden />Dispatched</span>
                      {a.deployments.length === 0 ? (
                        <span className="text-sm font-semibold text-ink-2">{mine.length ? 'none yet' : 'none — no capable unit free'}</span>
                      ) : (
                        a.deployments.map((d) => {
                          const Icon = RESOURCE_ICON[d.resource_type]
                          return (
                            <span key={d.id} className="inline-flex items-center gap-1.5 rounded-md border border-line bg-panel px-2 py-0.5 text-sm text-ink">
                              <Icon size={14} className="text-route" aria-hidden />
                              {d.resource_name}
                              <span className="text-ink-2">{d.role}</span>
                              <span className="font-mono text-xs font-bold text-route tnum">ETA {etaClock(d.eta_minutes)}</span>
                            </span>
                          )
                        })
                      )}
                    </div>

                    {mine.length > 0 && (
                      <div className="mt-2 flex flex-wrap items-center gap-1.5" role="group" aria-label={`Proposed deployments for ${a.incident_title}`}>
                        <span className={`${micro} mr-0.5`}>Proposed</span>
                        {mine.map((p) => (
                          <ProposalChip key={p.id} p={p} disabled={disabled} onApprove={(id) => onApprove([id])} onReject={onReject} />
                        ))}
                      </div>
                    )}
                  </div>
                </article>
              )
            })}

            {others.length > 0 && (
              <section className="rounded-lg border border-line bg-hi p-2.5" aria-label="Other recommended deployments">
                <h3 className={`${micro} mb-1.5`}>Other recommended deployments</h3>
                <div className="flex flex-wrap gap-1.5">
                  {others.map((p) => (
                    <ProposalChip key={p.id} p={p} disabled={disabled} onApprove={(id) => onApprove([id])} onReject={onReject} />
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </Panel>
  )
}
