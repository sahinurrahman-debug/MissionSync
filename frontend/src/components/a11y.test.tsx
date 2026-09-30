// @vitest-environment jsdom
// Automated accessibility checks (axe-core). Colour contrast needs real layout/paint, which jsdom
// doesn't have; that is covered separately by `npm run audit:contrast` over the actual design tokens.
import { describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import axe from 'axe-core'
import { LocalEngine } from '../engine/local'
import FleetAndLog from './FleetAndLog'
import HeaderHud from './HeaderHud'
import IncidentCard from './IncidentCard'
import Recommendations from './Recommendations'
import ReportIntake from './ReportIntake'
import SystemBanners from './SystemBanners'
import AdminKeyDialog from './AdminKeyDialog'

async function violations(container: Element) {
  const res = await axe.run(container, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } })
  return res.violations.map((v) => `${v.id}: ${v.help} → ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)
}

function world(auto = false) {
  const e = new LocalEngine({ paceMs: 0, autoDispatch: auto })
  e.start()
  e.stop()
  return e.getSnapshot()
}

describe('axe-core: no detectable a11y violations', () => {
  it('report intake', async () => {
    const { container } = render(<ReportIntake onInject={vi.fn()} onSample={() => 's'} stage="risk" />)
    expect(await violations(container)).toEqual([])
  })

  it('recommendations (proposals waiting + dispatched)', async () => {
    for (const auto of [false, true]) {
      const s = world(auto)
      const { container, unmount } = render(<Recommendations actions={s.actions} proposals={s.proposals} loading={false} autoDispatch={auto} onApprove={vi.fn()} onReject={vi.fn()} />)
      expect(await violations(container)).toEqual([])
      unmount()
    }
  })

  it('incident card, selected', async () => {
    const s = world(true)
    const incident = s.incidents.find((i) => s.resources.some((r) => r.assigned_incident === i.id))!
    const { container } = render(
      <ul>
        <IncidentCard incident={incident} rank={1} selected onSelect={vi.fn()} now={Date.now()}
          units={s.resources.filter((r) => r.assigned_incident === incident.id)}
          availableUnits={s.resources.filter((r) => r.status === 'available')}
          actions={{ onRecall: vi.fn(), onResolve: vi.fn(), onDispatch: vi.fn() }} />
      </ul>,
    )
    expect(await violations(container)).toEqual([])
  })

  it('fleet & log tabs', async () => {
    const { container } = render(<FleetAndLog snap={world(true)} loading={false} injections={0} onRecall={vi.fn()} />)
    expect(await violations(container)).toEqual([])
  })

  it('header and banners', async () => {
    const s = world()
    const { container } = render(
      <div>
        <HeaderHud snap={s} theme="dark" showUnits resetting={false} exportUrl="/x.csv" autoDispatch={false}
          onToggleTheme={vi.fn()} onToggleUnits={vi.fn()} onReset={vi.fn()} onToggleAuto={vi.fn()} onEndDrill={vi.fn()} />
        <SystemBanners snap={{ ...s, engine: 'remote', connection: 'offline' }} />
      </div>,
    )
    expect(await violations(container)).toEqual([])
  })

  it('admin key dialog', async () => {
    const { baseElement } = render(<AdminKeyDialog action="Restart the drill" rejected onSubmit={vi.fn()} onCancel={vi.fn()} />)
    expect(await violations(baseElement)).toEqual([])
  })
})
