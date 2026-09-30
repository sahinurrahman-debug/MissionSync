import { CheckSquare, ShieldAlert, Target, TriangleAlert, Wind } from 'lucide-react'
import type { RecommendedAction } from '../types'
import { etaClock } from '../lib/format'
import { RESOURCE_ICON } from '../lib/icons'
import EmptyRadar from './EmptyRadar'
import { RecommendationSkeleton } from './Skeletons'
import { Panel, PanelHeader, TIER_BORDER, TIER_TEXT, micro } from './ui'
import type { Tier } from '../types'

function tierOf(a: RecommendedAction): Tier {
  const u = a.urgency
  return u >= 75 ? 'P1' : u >= 55 ? 'P2' : u >= 35 ? 'P3' : 'P4'
}

function isWind(w: string): boolean { return /wind|kph/i.test(w) }

export default function Recommendations({
  actions, loading,
}: { actions: RecommendedAction[]; loading: boolean }) {
  const top = actions[0]
  return (
    <Panel className="h-full" label="Command recommendations">
      <PanelHeader
        title="Command recommendations"
        icon={<Target size={15} />}
        right={top ? <span className="truncate">top: <b className="text-ink">#{top.priority}</b></span> : undefined}
      />
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
        {loading ? (
          <RecommendationSkeleton />
        ) : actions.length === 0 ? (
          <EmptyRadar title="No orders yet." hint="The command agent issues orders once incidents are ranked." />
        ) : (
          actions.map((a, i) => {
            const tier = tierOf(a)
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
                      <span className="text-sm font-semibold text-p1">No units deployed — coverage gap</span>
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
                </div>
              </article>
            )
          })
        )}
      </div>
    </Panel>
  )
}
