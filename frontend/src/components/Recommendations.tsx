import type { RecommendedAction } from '../types'

export default function Recommendations({ actions }: { actions: RecommendedAction[] }) {
  if (actions.length === 0) {
    return (
      <div className="empty">
        <span className="empty-icon">🎯</span>
        <span>No active recommendations — the command agent issues orders once incidents are ranked.</span>
      </div>
    )
  }

  return (
    <>
      {actions.map((a, i) => (
        <article className="action-card" key={a.incident_id} style={{ '--i': i } as React.CSSProperties}>
          <div className="action-head">
            <span className="prio">#{a.priority}</span>
            <span className="headline">{a.headline}</span>
            <span className="urgency" style={{ fontSize: 16 }}>{a.urgency.toFixed(0)}</span>
          </div>
          <ul>
            {a.details.slice(0, 4).map((d, j) => (
              <li key={j}>{d}</li>
            ))}
          </ul>
          {a.warnings.map((w, j) => (
            <div className="warning" key={j}>⚠ {w}</div>
          ))}
          {a.deployments.length > 0 && (
            <div>
              {a.deployments.map((d) => (
                <span className="dep-chip" key={d.id}>
                  {d.resource_name} <small>· {d.role} · ETA {Math.round(d.eta_minutes)}m</small>
                </span>
              ))}
            </div>
          )}
        </article>
      ))}
    </>
  )
}
