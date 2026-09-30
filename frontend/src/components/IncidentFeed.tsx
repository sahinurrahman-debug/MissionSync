import { useEffect } from 'react'
import { AnimatePresence } from 'framer-motion'
import { ListOrdered } from 'lucide-react'
import type { Incident, Resource } from '../types'
import { useNow } from '../lib/useNow'
import EmptyRadar from './EmptyRadar'
import IncidentCard from './IncidentCard'
import { IncidentFeedSkeleton } from './Skeletons'
import { Panel, PanelHeader } from './ui'

export default function IncidentFeed({
  incidents, resources, selectedId, onSelect, loading, fill = true,
}: {
  incidents: Incident[]
  resources: Resource[]
  selectedId: string | null
  onSelect: (id: string | null) => void
  loading: boolean
  fill?: boolean
}) {
  const now = useNow(1000)
  const p1p2 = incidents.filter((i) => i.risk?.tier === 'P1' || i.risk?.tier === 'P2').length

  // A pin picked on the map brings its card into view.
  useEffect(() => {
    if (!selectedId) return
    document.getElementById(`inc-${selectedId}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [selectedId])

  return (
    <Panel className={fill ? 'h-full' : ''} label="Ranked incident feed">
      <PanelHeader
        title="Ranked incident feed"
        icon={<ListOrdered size={15} />}
        right={<span><b className="text-ink">{incidents.length}</b> active · <b className="text-p1">{p1p2}</b> P1/P2</span>}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <IncidentFeedSkeleton />
        ) : incidents.length === 0 ? (
          <EmptyRadar title="Airwaves quiet." hint="Inject a field report to start the drill, or restart it from the toolbar." />
        ) : (
          <ul className="space-y-2 p-2">
            <AnimatePresence initial={false}>
              {incidents.map((inc, i) => (
                <IncidentCard
                  key={inc.id}
                  incident={inc}
                  rank={i + 1}
                  selected={selectedId === inc.id}
                  onSelect={onSelect}
                  units={resources.filter((r) => r.assigned_incident === inc.id)}
                  now={now}
                />
              ))}
            </AnimatePresence>
          </ul>
        )}
      </div>
    </Panel>
  )
}
