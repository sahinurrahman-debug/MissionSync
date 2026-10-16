import { CloudRain, Thermometer, Wind } from 'lucide-react'
import type { Snapshot, WeatherCell } from '../types'
import { Panel, PanelHeader } from './ui'

const words = (s: string) => s.replace(/_/g, ' ').replace(/\b[a-z]/g, (c) => c.toUpperCase())

function ZoneCard({ w }: { w: WeatherCell }) {
  return (
    <li className={`rounded-lg border px-3 py-2 ${w.alert ? 'border-warn/40 bg-warn/10' : 'border-line bg-hi'}`}>
      <div className="flex items-center gap-2">
        <b className="min-w-0 flex-1 truncate text-base text-ink">{w.zone}</b>
        <span className={`shrink-0 rounded-md px-2 py-0.5 text-sm font-semibold ${w.alert ? 'bg-warn/20 text-warn' : 'text-ink-2'}`}>
          {w.alert ? words(w.alert) : 'Clear'}
        </span>
      </div>
      <dl className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-sm text-ink-2">
        <div className="flex items-center gap-1.5"><Wind size={14} aria-hidden /><dt className="sr-only">Wind</dt><dd><span className="font-mono tnum">{Math.round(w.wind_kph)}</span> kph</dd></div>
        <div className="flex items-center gap-1.5"><CloudRain size={14} aria-hidden /><dt className="sr-only">Rain</dt><dd><span className="font-mono tnum">{w.precipitation_mm_h.toFixed(1)}</span> mm/h</dd></div>
        <div className="flex items-center gap-1.5"><Thermometer size={14} aria-hidden /><dt className="sr-only">Temperature</dt><dd><span className="font-mono tnum">{Math.round(w.temperature_c)}</span> °C</dd></div>
      </dl>
      {w.forecast_note && <p className="mt-1 text-sm text-ink">{w.forecast_note}</p>}
    </li>
  )
}

/** Simulated weather for every zone of the drill, warnings first. Lives in its own section so the map stays clear. */
export default function WeatherPanel({ snap }: { snap: Snapshot }) {
  const zones = [...snap.weather].sort((a, b) => Number(!!b.alert) - Number(!!a.alert))
  const warnings = zones.filter((w) => w.alert).length
  return (
    <Panel className="h-full" label="Weather">
      <PanelHeader
        title="Weather by zone"
        icon={<Wind size={15} />}
        right={<span>{warnings > 0 ? `${warnings} warning${warnings === 1 ? '' : 's'}` : 'No warnings'}</span>}
      />
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {zones.length === 0 ? (
          <p className="p-3 text-base text-ink-2">No weather has been reported for this drill yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">{zones.map((w) => <ZoneCard key={w.zone} w={w} />)}</ul>
        )}
        <p className="px-1 pt-2 text-sm text-ink-2">Simulated conditions. Wind and rain slow or block some units, and the agents plan around them.</p>
      </div>
    </Panel>
  )
}
