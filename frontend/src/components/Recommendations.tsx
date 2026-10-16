import { useState } from 'react'
import { Check, CheckCheck, ChevronDown, Target, TriangleAlert, Wind, X } from 'lucide-react'
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

const decisionBtn = 'inline-flex h-11 items-center justify-center gap-1.5 rounded-md border px-3 text-base font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-40 sm:h-9'

/** One recommended assignment as a plain sentence with the two human decisions spelled out. */
export function ProposalRow({
  p, onApprove, onReject, disabled,
}: { p: Proposal; onApprove: (id: string) => void; onReject: (id: string) => void; disabled?: boolean }) {
  const Icon = RESOURCE_ICON[p.resource_type]
  return (
    <li
      className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border border-dashed border-accent/60 bg-accent/5 px-2.5 py-2"
      title={p.rationale || `Recommended by the ${p.source === 'llm' ? 'AI logistics agent' : 'rule-based matcher'}`}
    >
      <span className="flex min-w-0 flex-1 basis-48 items-center gap-2 text-base text-ink">
        <Icon size={18} className="shrink-0 text-accent" aria-hidden />
        <span className="min-w-0">
          <b>{p.resource_name}</b> <span className="text-ink-2">· {p.role}</span>
          <span className="block font-mono text-sm font-bold text-accent tnum">arrives in {etaClock(p.eta_minutes)}</span>
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          disabled={disabled}
          onClick={() => onApprove(p.id)}
          aria-label={`Approve ${p.resource_name} to ${p.incident_title}`}
          className={`${decisionBtn} border-ok/60 bg-ok/15 text-ok hover:bg-ok/25`}
        >
          <Check size={16} aria-hidden /> Approve
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onReject(p.id)}
          aria-label={`Reject ${p.resource_name} for ${p.incident_title}`}
          title="Reject — the next-best unit is proposed instead"
          className={`${decisionBtn} border-line bg-hi text-ink-2 hover:border-p1 hover:text-p1`}
        >
          <X size={16} aria-hidden /> Reject
        </button>
      </span>
    </li>
  )
}

function OrderCard({
  a, i, mine, disabled, onApprove, onReject,
}: { a: RecommendedAction; i: number; mine: Proposal[]; disabled?: boolean; onApprove: (ids?: string[]) => void; onReject: (id: string) => void }) {
  const [open, setOpen] = useState(false)
  const tier = tierOf(a)
  const steps = a.details.slice(0, 4)
  return (
    <article
      className={`relative overflow-hidden rounded-lg border bg-hi pl-3 animate-fade-up ${i === 0 ? 'border-2' : 'border'} ${i === 0 ? TIER_BORDER[tier] : 'border-line'}`}
      style={{ animationDelay: `${i * 50}ms` }}
    >
      <span aria-hidden className={`absolute inset-y-0 left-0 w-1.5 ${i === 0 ? 'hazard-stripe' : 'bg-line'}`} />
      <div className="py-2.5 pr-3">
        <div className="flex items-start gap-2">
          <span className={`shrink-0 rounded border border-current px-1.5 py-0.5 font-mono text-xs font-bold tnum ${TIER_TEXT[tier]}`}>#{a.priority} · {tier}</span>
          <h3 className="text-base font-bold leading-snug text-ink">{a.headline.replace(/^\[P\d\]\s*/, '')}</h3>
          <span className="ml-auto shrink-0 font-mono text-base font-bold text-ink tnum" aria-label={`urgency ${Math.round(a.urgency)}`}>{Math.round(a.urgency)}</span>
        </div>

        {a.warnings.map((w, j) => (
          <p key={j} className="mt-2 flex items-start gap-2 rounded-md border border-warn/30 bg-warn/10 px-2 py-1 text-sm text-warn">
            {isWind(w) ? <Wind size={15} className="mt-0.5 shrink-0" aria-hidden /> : <TriangleAlert size={15} className="mt-0.5 shrink-0" aria-hidden />}
            <span>{w}</span>
          </p>
        ))}

        {mine.length > 0 && (
          <div className="mt-2.5">
            <p className={`${micro} mb-1`}>Waiting for Your Decision</p>
            <ul className="space-y-1.5" aria-label={`Proposed deployments for ${a.incident_title}`}>
              {mine.map((p) => (
                <ProposalRow key={p.id} p={p} disabled={disabled} onApprove={(id) => onApprove([id])} onReject={onReject} />
              ))}
            </ul>
          </div>
        )}

        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          <span className={`${micro} mr-0.5`}>On the Way</span>
          {a.deployments.length === 0 ? (
            <span className="text-sm text-ink-2">{mine.length ? 'nobody yet — approve above' : 'nobody — no capable unit is free'}</span>
          ) : (
            a.deployments.map((d) => {
              const Icon = RESOURCE_ICON[d.resource_type]
              return (
                <span key={d.id} className="inline-flex items-center gap-1.5 rounded-md border border-line bg-panel px-2 py-0.5 text-sm text-ink">
                  <Icon size={14} className="text-route" aria-hidden />
                  {d.resource_name}
                  <span className="font-mono text-xs font-bold text-route tnum">ETA {etaClock(d.eta_minutes)}</span>
                </span>
              )
            })
          )}
        </div>

        {steps.length > 0 && (
          <div className="mt-2">
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
              className="inline-flex h-11 items-center gap-1.5 text-sm font-semibold text-ink-2 hover:text-ink sm:h-8"
            >
              <ChevronDown size={16} className={`transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden />
              {open ? 'Hide Field Steps' : `Show ${steps.length} Field Steps`}
            </button>
            {open && (
              <ul className="mt-1 space-y-1">
                {steps.map((d, j) => (
                  <li key={j} className="flex items-start gap-2 text-base leading-snug text-ink">
                    <Check size={16} className="mt-0.5 shrink-0 text-ok" aria-hidden />
                    <span>{d}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </article>
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
        title="Dispatch orders"
        icon={<Target size={15} />}
        right={
          proposals.length > 0 ? (
            <button
              type="button"
              disabled={disabled}
              onClick={() => onApprove()}
              className="inline-flex h-11 items-center gap-1.5 rounded-md bg-accent px-3 whitespace-nowrap text-sm font-bold text-bg hover:brightness-110 disabled:opacity-40 sm:h-9"
            >
              <CheckCheck size={14} aria-hidden /> Approve All ({proposals.length})
            </button>
          ) : top ? (
            <span className="truncate">top: <b className="text-ink">#{top.priority}</b></span>
          ) : undefined
        }
      />
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
        {!autoDispatch && proposals.length > 0 && (
          <p className="rounded-md border border-accent/30 bg-accent/10 px-2 py-1 text-sm text-ink max-sm:hidden">
            <b>Nothing moves until you approve.</b> Each suggested unit below has Approve and Reject buttons — or approve everything at once.
          </p>
        )}
        {loading ? (
          <RecommendationSkeleton />
        ) : actions.length === 0 && others.length === 0 ? (
          <EmptyRadar title="No Orders Yet." hint="Orders appear here as soon as incidents are ranked. Add a field report to begin." />
        ) : (
          <>
            {actions.map((a, i) => (
              <OrderCard key={a.incident_id} a={a} i={i} mine={byIncident(a.incident_id)} disabled={disabled} onApprove={onApprove} onReject={onReject} />
            ))}

            {others.length > 0 && (
              <section className="rounded-lg border border-line bg-hi p-2.5" aria-label="Other recommended deployments">
                <h3 className={`${micro} mb-1.5`}>Other suggested units</h3>
                <ul className="space-y-1.5">
                  {others.map((p) => (
                    <ProposalRow key={p.id} p={p} disabled={disabled} onApprove={(id) => onApprove([id])} onReject={onReject} />
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </div>
    </Panel>
  )
}
