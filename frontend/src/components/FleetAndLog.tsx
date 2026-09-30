import { useState } from 'react'
import { ScrollText, Truck } from 'lucide-react'
import type { Snapshot } from '../types'
import ErrorBoundary from './ErrorBoundary'
import EventLog from './EventLog'
import ResourceBoard from './ResourceBoard'
import { FleetSkeleton } from './Skeletons'
import { Panel } from './ui'

/** Fleet matrix and audit log as one tabbed group (side by side is a luxury of 2xl screens). */
export default function FleetAndLog({ snap, loading, injections }: { snap: Snapshot; loading: boolean; injections: number }) {
  const [tab, setTab] = useState<'fleet' | 'log'>('fleet')
  const free = snap.resources.filter((r) => r.status === 'available').length

  const tabBtn = (id: 'fleet' | 'log', short: string, long: string, Icon: typeof Truck, badge: string) => (
    <button
      type="button"
      role="tab"
      id={`tab-${id}`}
      aria-selected={tab === id}
      aria-controls={`panel-${id}`}
      onClick={() => setTab(id)}
      className={`inline-flex h-10 items-center gap-2 whitespace-nowrap border-b-2 px-3 text-xs font-semibold uppercase tracking-micro transition-colors ${
        tab === id ? 'border-accent text-ink' : 'border-transparent text-ink-2 hover:text-ink'
      }`}
    >
      <Icon size={15} aria-hidden />
      <span className="sm:hidden">{short}</span>
      <span className="hidden sm:inline">{long}</span>
      <span className="rounded bg-hi px-1.5 py-0.5 font-mono text-xs normal-case tracking-normal text-ink-2 tnum">{badge}</span>
    </button>
  )

  return (
    <Panel className="h-full" label="Fleet and audit log">
      <div role="tablist" aria-label="Fleet and audit log" className="flex shrink-0 items-center border-b border-line px-1">
        {tabBtn('fleet', 'Fleet', 'Resource fleet', Truck, `${free}/${snap.resources.length}${' free'}`)}
        {tabBtn('log', 'Log', 'Live audit log', ScrollText, `${injections} inj`)}
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="min-h-0 flex-1 overflow-y-auto">
        <ErrorBoundary label={tab === 'fleet' ? 'The fleet board' : 'The audit log'}>
          {tab === 'fleet'
            ? <ResourceBoard resources={snap.resources} incidents={snap.incidents} loading={loading} />
            : loading ? <FleetSkeleton /> : <EventLog lines={snap.event_log} />}
        </ErrorBoundary>
      </div>
    </Panel>
  )
}
