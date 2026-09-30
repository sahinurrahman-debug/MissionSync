import { useMemo } from 'react'
import type { Incident, Resource } from '../types'

export default function ResourceBoard({
  resources,
  incidents,
}: {
  resources: Resource[]
  incidents: Incident[]
}) {
  const rows = useMemo(() => {
    const byId = new Map(incidents.map((i) => [i.id, i]))
    return resources.map((r) => {
      const inc = r.assigned_incident ? byId.get(r.assigned_incident) : undefined
      const eta = inc && r.current_lat != null ? etaOf(r, inc) : null
      return { r, inc, eta }
    })
  }, [resources, incidents])

  const available = rows.filter(({ r }) => r.status === 'available').length

  return (
    <div>
      {rows.map(({ r, inc, eta }, i) => (
        <div className="resource-row" key={r.id} style={{ '--i': i } as React.CSSProperties}>
          <span className="res-name">
            {r.name}
            <small>
              {r.personnel} personnel{r.capacity_note ? ` · ${r.capacity_note}` : ''}
              {inc ? ` · → ${inc.title}` : ''}
            </small>
          </span>
          <span className={`res-status ${r.status}`}>{r.status.replace('_', ' ')}</span>
          <span className="res-eta">{eta != null ? `ETA ${eta.toFixed(0)}m` : '—'}</span>
        </div>
      ))}
      <div className="inject-hint" style={{ marginTop: 8 }}>{available} of {resources.length} units available</div>
    </div>
  )
}

function etaOf(r: Resource, inc: Incident): number {
  const lat = r.current_lat ?? r.base_lat
  const lon = r.current_lon ?? r.base_lon
  const dLat = ((inc.lat - lat) * Math.PI) / 180
  const dLon = ((inc.lon - lon) * Math.PI) / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat * Math.PI) / 180) * Math.cos((inc.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2
  const km = 2 * 6371 * Math.asin(Math.sqrt(a))
  return (km / Math.max(r.speed_kph, 1)) * 60
}
