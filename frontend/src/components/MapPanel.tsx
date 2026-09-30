import { useEffect, useMemo, useState } from 'react'
import L from 'leaflet'
import { Circle, CircleMarker, MapContainer, Marker, Polyline, TileLayer, Tooltip, useMap } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import { Hexagon, LocateFixed, Route } from 'lucide-react'
import type { Incident, Resource, Tier } from '../types'
import { STATUS_HEX, STATUS_LABEL, TIER_HEX, TIER_LABEL } from '../lib/format'
import { SECTORS } from '../engine/scenario'
import { MapSkeleton } from './Skeletons'

const CENTER: [number, number] = [34.0555, -118.24]
// OpenStreetMap standard tiles need no API key; the dark theme is a CSS filter over them (see index.css).
const TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'

// Teardrop pins are built once per (rank, tier, selected) — Leaflet icons are not free.
const pinCache = new Map<string, L.DivIcon>()
function pinIcon(rank: number, tier: Tier, selected: boolean): L.DivIcon {
  const key = `${rank}|${tier}|${selected}`
  const hit = pinCache.get(key)
  if (hit) return hit
  const c = TIER_HEX[tier]
  const pulse = tier === 'P1' || tier === 'P2'
  const label = rank > 99 ? '99+' : String(rank)
  const icon = L.divIcon({
    className: '',
    iconSize: [32, 40],
    iconAnchor: [16, 40],
    tooltipAnchor: [0, -38],
    html: `<div class="ms-pin ${selected ? 'sel' : ''}" style="--c:${c}">
      ${pulse ? '<span class="ring"></span><span class="ring r2"></span>' : ''}
      <svg width="32" height="40" viewBox="0 0 32 40" aria-hidden="true">
        <path d="M16 1C8.3 1 2 7.2 2 14.8 2 25 16 39 16 39s14-14 14-24.2C30 7.2 23.7 1 16 1z" fill="${c}" stroke="${selected ? '#F1F5F9' : 'rgba(0,0,0,.55)'}" stroke-width="${selected ? 2.5 : 1.5}"/>
        <text x="16" y="19.5" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="${label.length > 2 ? 10 : 14}" font-weight="800" fill="${tier === 'P4' ? '#F1F5F9' : '#0E1113'}">${label}</text>
      </svg></div>`,
  })
  pinCache.set(key, icon)
  return icon
}

/** Flies to the selected incident, recentres on demand, and re-measures when its panel resizes. */
function MapController({ target, recenter }: { target: Incident | null; recenter: number }) {
  const map = useMap()
  const id = target?.id
  useEffect(() => {
    if (target) map.flyTo([target.lat, target.lon], Math.max(map.getZoom(), 14), { duration: 0.6 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, map])
  useEffect(() => {
    if (recenter > 0) map.flyTo(CENTER, 13, { duration: 0.6 })
  }, [recenter, map])
  useEffect(() => {
    const el = map.getContainer()
    const ro = new ResizeObserver(() => map.invalidateSize())
    ro.observe(el)
    return () => ro.disconnect()
  }, [map])
  return null
}

const ctl =
  'inline-flex h-9 w-9 items-center justify-center rounded-md border border-line bg-panel/95 text-ink-2 shadow-panel backdrop-blur transition-colors hover:border-accent hover:text-accent aria-pressed:border-accent/60 aria-pressed:text-accent'

export default function MapPanel({
  incidents,
  resources,
  selectedId,
  onSelect,
  theme,
  loading,
}: {
  incidents: Incident[]
  resources: Resource[]
  selectedId: string | null
  onSelect: (id: string | null) => void
  theme: 'dark' | 'light'
  loading: boolean
}) {
  const [routes, setRoutes] = useState(true)
  const [sectors, setSectors] = useState(true)
  const [recenter, setRecenter] = useState(0)
  const selected = useMemo(() => incidents.find((i) => i.id === selectedId) ?? null, [incidents, selectedId])
  const byId = useMemo(() => new Map(incidents.map((i) => [i.id, i])), [incidents])

  return (
    <div className={`relative h-full min-h-0 w-full ${theme === 'dark' ? 'tiles-dark' : 'tiles-light'}`}>
      {loading && <MapSkeleton />}
      <MapContainer center={CENTER} zoom={13} scrollWheelZoom={false} zoomControl={false} className="h-full w-full" attributionControl>
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url={TILE_URL}
          subdomains="abc"
          maxZoom={19}
        />
        <MapController target={selected} recenter={recenter} />

        {sectors &&
          SECTORS.map((s) => (
            <Circle
              key={s.name}
              center={[s.lat, s.lon]}
              radius={850}
              interactive={false}
              pathOptions={{ color: '#94A3B8', weight: 1, opacity: 0.4, dashArray: '3 6', fillOpacity: 0.03 }}
            >
              <Tooltip permanent direction="center" className="sector-label">{s.name}</Tooltip>
            </Circle>
          ))}

        {routes &&
          resources.map((r) => {
            const inc = r.status === 'en_route' && r.assigned_incident ? byId.get(r.assigned_incident) : undefined
            if (!inc) return null
            return (
              <Polyline
                key={`route-${r.id}`}
                interactive={false}
                positions={[[r.current_lat ?? r.base_lat, r.current_lon ?? r.base_lon], [inc.lat, inc.lon]]}
                pathOptions={{ color: STATUS_HEX.en_route, weight: 2, opacity: 0.75, dashArray: '4 7' }}
              />
            )
          })}

        {incidents.filter((i) => !i.location_known).map((inc) => (
          <Circle
            key={`approx-${inc.id}`}
            center={[inc.lat, inc.lon]}
            radius={700}
            interactive={false}
            pathOptions={{ color: TIER_HEX[inc.risk?.tier ?? 'P4'], weight: 1.5, dashArray: '6 6', fillOpacity: 0.06 }}
          />
        ))}

        {incidents.map((inc, i) => {
          const tier = inc.risk?.tier ?? 'P4'
          return (
            <Marker
              key={inc.id}
              position={[inc.lat, inc.lon]}
              icon={pinIcon(i + 1, tier, selectedId === inc.id)}
              zIndexOffset={selectedId === inc.id ? 1000 : (100 - i) * 2}
              title={`${inc.title} — rank ${i + 1}, ${tier}`}
              eventHandlers={{ click: () => onSelect(inc.id) }}
            >
              <Tooltip direction="top" opacity={1}>
                <div className="max-w-[240px]">
                  <div className="font-semibold">#{i + 1} · {tier} {TIER_LABEL[tier]} · {inc.risk?.urgency.toFixed(0) ?? '—'}/100</div>
                  <div className="truncate">{inc.title}</div>
                  <div className="text-xs opacity-80">
                    {inc.zone}{inc.location_known ? '' : ' · approximate area'} · pop {inc.affected_population} · injuries {inc.injuries}
                  </div>
                </div>
              </Tooltip>
            </Marker>
          )
        })}

        {resources.map((r) => {
          const color = STATUS_HEX[r.status]
          return (
            <CircleMarker
              key={r.id}
              center={[r.current_lat ?? r.base_lat, r.current_lon ?? r.base_lon]}
              radius={r.status === 'available' ? 4 : 6}
              pathOptions={{ color, fillColor: color, fillOpacity: r.status === 'available' ? 0.4 : 0.95, weight: 1.5 }}
            >
              <Tooltip direction="top" offset={[0, -4]}>
                {r.name} · {STATUS_LABEL[r.status]}{r.role ? ` · ${r.role}` : ''}
              </Tooltip>
            </CircleMarker>
          )
        })}
      </MapContainer>

      {/* Floating controls */}
      <div className="absolute right-2 top-2 z-[1000] flex flex-col gap-1.5">
        <button type="button" className={ctl} onClick={() => setRecenter((n) => n + 1)} aria-label="Re-center map" title="Re-center map">
          <LocateFixed size={18} aria-hidden />
        </button>
        <button type="button" className={ctl} onClick={() => setRoutes((v) => !v)} aria-pressed={routes} aria-label="Toggle unit routes" title="Toggle unit routes">
          <Route size={18} aria-hidden />
        </button>
        <button type="button" className={ctl} onClick={() => setSectors((v) => !v)} aria-pressed={sectors} aria-label="Toggle sector boundaries" title="Toggle sector boundaries">
          <Hexagon size={18} aria-hidden />
        </button>
        {selectedId && (
          <button type="button" className={ctl} onClick={() => onSelect(null)} aria-label="Clear selection" title="Clear selection">
            <span aria-hidden className="text-base leading-none">✕</span>
          </button>
        )}
      </div>

      {/* Legend */}
      <ul className="absolute bottom-6 left-2 z-[1000] flex max-w-[calc(100%-4rem)] flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-line bg-panel/95 px-2 py-1 text-xs text-ink-2 shadow-panel backdrop-blur" aria-label="Map legend">
        {(['P1', 'P2', 'P3', 'P4'] as Tier[]).map((t) => (
          <li key={t} className="flex items-center gap-1"><i className="h-2.5 w-2.5 rounded-full" style={{ background: TIER_HEX[t] }} />{t}</li>
        ))}
        <li className="flex items-center gap-1"><i className="h-2.5 w-2.5 rounded-full" style={{ background: STATUS_HEX.en_route }} />en route</li>
        <li className="flex items-center gap-1"><i className="h-2.5 w-2.5 rounded-full opacity-50" style={{ background: STATUS_HEX.available }} />idle</li>
        <li className="flex items-center gap-1"><i className="h-2.5 w-2.5 rounded-full border border-dashed border-ink-2" />approx.</li>
      </ul>
    </div>
  )
}
