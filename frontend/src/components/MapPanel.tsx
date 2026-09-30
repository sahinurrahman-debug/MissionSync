import { useMemo } from 'react'
import { CircleMarker, MapContainer, TileLayer, Tooltip } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import type { Incident, Resource } from '../types'

export const TIER_COLOR: Record<string, string> = {
  P1: '#f5484d',
  P2: '#f59e42',
  P3: '#eab308',
  P4: '#64748b',
}

const UNIT_COLOR: Record<string, string> = {
  available: '#2dd4a7',
  en_route: '#38bdf8',
  on_scene: '#f59e42',
  returning: '#64748b',
}

export default function MapPanel({
  incidents,
  resources,
  selectedId,
  onSelect,
}: {
  incidents: Incident[]
  resources: Resource[]
  selectedId: string | null
  onSelect: (id: string | null) => void
}) {
  const unitMarkers = useMemo(
    () => resources.filter((r) => r.current_lat != null && r.current_lon != null),
    [resources],
  )

  return (
    <div className="map-wrap">
      <MapContainer
        center={[34.0555, -118.24]}
        zoom={13}
        scrollWheelZoom={false}
        style={{ height: '100%' }}
        attributionControl
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />

        {incidents.map((inc) => {
          const tier = inc.risk?.tier ?? 'P4'
          const color = TIER_COLOR[tier]
          const urgency = inc.risk?.urgency ?? 20
          const selected = selectedId === inc.id
          return (
            <CircleMarker
              key={inc.id}
              center={[inc.lat, inc.lon]}
              radius={7 + (urgency / 100) * 9}
              pathOptions={{
                color,
                fillColor: color,
                fillOpacity: 0.55,
                weight: selected ? 3.5 : 1.5,
                className: tier === 'P1' || tier === 'P2' ? 'marker-pulse' : undefined,
              }}
              eventHandlers={{ click: () => onSelect(inc.id) }}
            >
              <Tooltip direction="top" offset={[0, -6]} opacity={1}>
                <strong>
                  {tier} · {inc.title}
                </strong>
                <br />
                urgency {inc.risk?.urgency.toFixed(0) ?? '—'} · {inc.zone}
                <br />
                pop {inc.affected_population} · injuries {inc.injuries}
              </Tooltip>
            </CircleMarker>
          )
        })}

        {unitMarkers.map((r) => (
          <CircleMarker
            key={r.id}
            center={[r.current_lat as number, r.current_lon as number]}
            radius={5}
            pathOptions={{
              color: UNIT_COLOR[r.status] ?? '#38bdf8',
              fillColor: UNIT_COLOR[r.status] ?? '#38bdf8',
              fillOpacity: 0.9,
              weight: 1,
            }}
          >
            <Tooltip direction="top" offset={[0, -4]}>
              {r.name} · {r.status.replace('_', ' ')}
              {r.role ? ` · ${r.role}` : ''}
            </Tooltip>
          </CircleMarker>
        ))}
      </MapContainer>

      <div className="map-legend" role="list" aria-label="Map legend">
        <span role="listitem"><i className="dot" style={{ background: TIER_COLOR.P1 }} />P1</span>
        <span role="listitem"><i className="dot" style={{ background: TIER_COLOR.P2 }} />P2</span>
        <span role="listitem"><i className="dot" style={{ background: TIER_COLOR.P3 }} />P3</span>
        <span role="listitem"><i className="dot" style={{ background: TIER_COLOR.P4 }} />P4</span>
        <span role="listitem"><i className="dot" style={{ background: UNIT_COLOR.en_route }} />units</span>
      </div>

      <button
        type="button"
        className={`map-clear ${selectedId ? 'visible' : ''}`}
        onClick={() => onSelect(null)}
        aria-label="Clear incident selection"
        title="Clear selection"
      >
        ✕
      </button>
    </div>
  )
}
