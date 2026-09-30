import type { Incident, RiskBreakdown } from '../types'
import { TIER_COLOR } from './MapPanel'

const BREAKDOWN_LABELS: Array<[keyof RiskBreakdown, string]> = [
  ['severity', 'Severity'],
  ['population', 'Population'],
  ['spread', 'Spread'],
  ['time_criticality', 'Time-crit'],
]

export default function IncidentCard({
  incident,
  rank,
  selected,
  onSelect,
}: {
  incident: Incident
  rank: number
  selected: boolean
  onSelect: (id: string | null) => void
}) {
  const tier = incident.risk?.tier ?? 'P4'
  const color = TIER_COLOR[tier]
  const b = incident.risk?.breakdown

  return (
    <button
      type="button"
      className={`incident-card ${selected ? 'selected' : ''}`}
      style={{ '--tier': color, '--i': Math.min(rank - 1, 8) } as React.CSSProperties}
      onClick={() => onSelect(selected ? null : incident.id)}
      aria-pressed={selected}
    >
      <div className="card-row">
        <span className="rank">#{rank}</span>
        <span className="card-title">{incident.title}</span>
        <span className={`tier-chip ${tier}`}>{tier}</span>
        <span className="urgency">{incident.risk ? incident.risk.urgency.toFixed(0) : '—'}</span>
      </div>

      <div className="card-meta">
        {incident.zone} · {incident.type.replace(/_/g, ' ')} · pop {incident.affected_population} · injuries {incident.injuries}
      </div>

      <div className="card-meta" style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' }}>
        <span className={`status-pill ${incident.status}`}>{incident.status.replace(/_/g, ' ')}</span>
        <span>conf {(incident.confidence * 100).toFixed(0)}%</span>
        {incident.risk && <span>scored {new Date(incident.risk.scored_at).toLocaleTimeString()}</span>}
        {incident.risk && (
          <span
            className={`src-badge ${incident.risk.source}`}
            title={
              incident.risk.source === 'rules'
                ? 'Components scored by the rule-based twin'
                : 'Components scored by the LLM' + (incident.risk.source === 'cached' ? ' (reused — inputs unchanged)' : '')
            }
          >
            {incident.risk.source === 'rules' ? 'rules' : 'AI'}
          </span>
        )}
      </div>

      {selected && b && (
        <div className="breakdown" aria-label="Urgency breakdown">
          {BREAKDOWN_LABELS.map(([key, label], i) => {
            const value = Number(b[key])
            return (
              <div className="breakdown-row" key={key}>
                <span>{label}</span>
                <span className="bar"><i style={{ width: `${value}%`, '--i': i } as React.CSSProperties} /></span>
                <b>{Math.round(value)}</b>
              </div>
            )
          })}
          <div className="rationale">“{b.rationale}”</div>
        </div>
      )}
    </button>
  )
}
