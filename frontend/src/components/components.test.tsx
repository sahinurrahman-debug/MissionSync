// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { LocalEngine } from '../engine/local'
import { ApiError, type Snapshot } from '../types'
import ActionToast from './ActionToast'
import ConfirmDialog from './ConfirmDialog'
import DrillMenu from './DrillMenu'
import HowItWorks from './HowItWorks'
import NextStep, { nextStepOf } from './NextStep'
import ErrorBoundary from './ErrorBoundary'
import FleetAndLog from './FleetAndLog'
import HeaderHud, { StatGrid, TelemetryBar, clockOf, statsOf } from './HeaderHud'
import IncidentCard from './IncidentCard'
import Recommendations from './Recommendations'
import ReportIntake from './ReportIntake'
import SystemBanners, { WeatherStrip } from './SystemBanners'

/** A real snapshot from the demo engine (manual dispatch: proposals waiting for a human). */
function world(autoDispatch = false): { engine: LocalEngine; snap: Snapshot } {
  const engine = new LocalEngine({ paceMs: 0, autoDispatch })
  engine.start()
  engine.stop()
  return { engine, snap: engine.getSnapshot() }
}

describe('Recommendations — the approval surface', () => {
  it('tells the operator nothing moves until they approve, and offers Approve all', async () => {
    const { snap } = world()
    const onApprove = vi.fn()
    render(<Recommendations actions={snap.actions} proposals={snap.proposals} loading={false} autoDispatch={false} onApprove={onApprove} onReject={vi.fn()} />)
    expect(screen.getByText(/Nothing moves until you approve/)).toBeTruthy()
    const all = screen.getByRole('button', { name: /Approve all \((\d+)\)/ })
    expect(all.textContent).toContain(`(${snap.proposals.length})`)
    await userEvent.click(all)
    expect(onApprove).toHaveBeenCalledWith()                       // no ids ⇒ every pending proposal
  })

  it('approves or rejects one proposal at a time', async () => {
    const { snap } = world()
    const onApprove = vi.fn()
    const onReject = vi.fn()
    render(<Recommendations actions={snap.actions} proposals={snap.proposals} loading={false} autoDispatch={false} onApprove={onApprove} onReject={onReject} />)
    const p = snap.proposals.find((x) => snap.actions.some((a) => a.incident_id === x.incident_id))!
    await userEvent.click(screen.getAllByRole('button', { name: new RegExp(`Approve ${p.resource_name} to`) })[0])
    expect(onApprove).toHaveBeenCalledWith([p.id])
    await userEvent.click(screen.getAllByRole('button', { name: new RegExp(`Reject ${p.resource_name} for`) })[0])
    expect(onReject).toHaveBeenCalledWith(p.id)
  })

  it('disables every decision while an action is in flight', () => {
    const { snap } = world()
    render(<Recommendations actions={snap.actions} proposals={snap.proposals} loading={false} autoDispatch={false} onApprove={vi.fn()} onReject={vi.fn()} disabled />)
    const decisions = screen.getAllByRole('button', { name: /Approve|Reject/ })
    expect(decisions.length).toBeGreaterThan(2)
    for (const b of decisions) expect((b as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows dispatched units (not proposals) once auto-dispatch has committed them', () => {
    const { snap } = world(true)
    render(<Recommendations actions={snap.actions} proposals={snap.proposals} loading={false} autoDispatch onApprove={vi.fn()} onReject={vi.fn()} />)
    expect(screen.queryByText(/Nothing moves until you approve/)).toBeNull()
    expect(screen.getAllByText('On the way').length).toBeGreaterThan(0)
    expect(snap.actions.some((a) => a.deployments.length > 0)).toBe(true)
  })

  it('has a designed empty state and a loading skeleton', () => {
    const { rerender } = render(<Recommendations actions={[]} proposals={[]} loading={false} autoDispatch={false} onApprove={vi.fn()} onReject={vi.fn()} />)
    expect(screen.getByText(/No orders yet/)).toBeTruthy()
    rerender(<Recommendations actions={[]} proposals={[]} loading autoDispatch={false} onApprove={vi.fn()} onReject={vi.fn()} />)
    expect(screen.getByLabelText('Loading command recommendations').getAttribute('aria-busy')).toBe('true')
  })
})

describe('IncidentCard — net control actions', () => {
  function card(selected = true) {
    const { snap } = world(true)
    const incident = snap.incidents.find((i) => snap.resources.some((r) => r.assigned_incident === i.id))!
    const props = {
      incident, rank: 1, selected, onSelect: vi.fn(), now: Date.parse(incident.reported_at) + 125_000,
      units: snap.resources.filter((r) => r.assigned_incident === incident.id),
      availableUnits: snap.resources.filter((r) => r.status === 'available'),
      actions: { onRecall: vi.fn(), onResolve: vi.fn(), onDispatch: vi.fn() },
    }
    render(<ul><IncidentCard {...props} /></ul>)
    return { incident, props, snap }
  }

  it('shows tier, score, provenance and elapsed time — never colour alone', () => {
    const { incident } = card(false)
    const pill = screen.getByLabelText(new RegExp(`^Rank 1, ${incident.risk!.tier}`))
    expect(pill.textContent).toContain(`${Math.round(incident.risk!.urgency)}/100`)
    expect(screen.getByText('RULES')).toBeTruthy()
    expect(screen.getByText('2m ago')).toBeTruthy()
  })

  it('reveals the four-factor auditable breakdown and the actions when selected', () => {
    card(true)
    const breakdown = screen.getByLabelText('Urgency breakdown')
    expect(within(breakdown).getAllByRole('term')).toHaveLength(4)
    expect(screen.getByRole('group', { name: 'Net control actions' })).toBeTruthy()
  })

  it('marks contained, closes, and recalls a unit', async () => {
    const { incident, props } = card(true)
    await userEvent.click(screen.getByRole('button', { name: /Mark contained/ }))
    expect(props.actions.onResolve).toHaveBeenCalledWith(incident.id, 'contained')
    await userEvent.click(screen.getByRole('button', { name: /^Close$/ }))
    expect(props.actions.onResolve).toHaveBeenCalledWith(incident.id, 'closed')
    await userEvent.click(screen.getByRole('button', { name: `Recall ${props.units[0].name}` }))
    expect(props.actions.onRecall).toHaveBeenCalledWith(props.units[0].id)
  })

  it('only offers units that can actually serve this incident, and dispatches the chosen one', async () => {
    const { incident, props, snap } = card(true)
    const select = screen.getByLabelText(new RegExp(`Send a unit to`)) as HTMLSelectElement
    const offered = [...select.options].map((o) => o.value).filter(Boolean)
    expect(offered.length).toBeGreaterThan(0)
    const byId = new Map(snap.resources.map((r) => [r.id, r]))
    for (const id of offered) expect(byId.get(id)!.status).toBe('available')
    await userEvent.selectOptions(select, offered[0])
    await userEvent.click(screen.getByRole('button', { name: 'Dispatch' }))
    expect(props.actions.onDispatch).toHaveBeenCalledWith(incident.id, offered[0])
  })

  it('flags a provisional score while the AI is still refining it', () => {
    const { snap } = world()
    const incident = { ...snap.incidents[0], provisional: true }
    render(<ul><IncidentCard incident={incident} rank={1} selected={false} onSelect={vi.fn()} units={[]} now={Date.now()} /></ul>)
    expect(screen.getByText(/AI scoring/)).toBeTruthy()
    expect(screen.queryByText('RULES')).toBeNull()
  })
})

describe('FleetAndLog — tabs follow the WAI-ARIA pattern', () => {
  it('moves between tabs with arrows, Home and End, with a roving tabindex', async () => {
    const { snap } = world()
    render(<FleetAndLog snap={snap} loading={false} injections={0} />)
    const fleet = screen.getByRole('tab', { name: /fleet/i })
    const log = screen.getByRole('tab', { name: /audit log|Log/i })
    expect(fleet.getAttribute('aria-selected')).toBe('true')
    expect(fleet.tabIndex).toBe(0)
    expect(log.tabIndex).toBe(-1)

    fleet.focus()
    await userEvent.keyboard('{ArrowRight}')
    expect(log.getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('log')).toBeTruthy()
    await userEvent.keyboard('{ArrowRight}')                       // wraps
    expect(fleet.getAttribute('aria-selected')).toBe('true')
    await userEvent.keyboard('{End}')
    expect(log.getAttribute('aria-selected')).toBe('true')
    await userEvent.keyboard('{Home}')
    expect(fleet.getAttribute('aria-selected')).toBe('true')
  })

  it('lets net control recall a unit that is out', async () => {
    const { snap } = world(true)
    const onRecall = vi.fn()
    render(<FleetAndLog snap={snap} loading={false} injections={0} onRecall={onRecall} />)
    const out = snap.resources.find((r) => r.status === 'en_route' || r.status === 'on_scene')!
    await userEvent.click(screen.getByRole('button', { name: `Recall ${out.name}` }))
    expect(onRecall).toHaveBeenCalledWith(out.id)
    expect(screen.queryByRole('button', { name: new RegExp(`Recall ${snap.resources.find((r) => r.status === 'available')!.name}`) })).toBeNull()
  })
})

describe('ReportIntake', () => {
  const ok = { kind: 'created' as const, incident_title: 'Fire at University', tier: 'P2' as const, urgency: 61, message: '', provisional: false }

  it('submits on Enter, but Shift+Enter is a newline', async () => {
    const onInject = vi.fn().mockResolvedValue(ok)
    render(<ReportIntake onInject={onInject} onSample={() => 'sample'} stage="idle" />)
    const box = screen.getByLabelText('Field report')
    await userEvent.type(box, 'fire at the lab{Shift>}{Enter}{/Shift}second line')
    expect(onInject).not.toHaveBeenCalled()
    expect((box as HTMLTextAreaElement).value).toContain('\n')
    await userEvent.type(box, '{Enter}')
    expect(onInject).toHaveBeenCalledTimes(1)
    expect(await screen.findByText(/New incident logged/)).toBeTruthy()
    expect((box as HTMLTextAreaElement).value).toBe('')
  })

  it('says a provisional result will be refined, and keeps the text when nothing was recognised', async () => {
    const onInject = vi.fn().mockResolvedValueOnce({ ...ok, provisional: true })
      .mockResolvedValueOnce({ kind: 'rejected', incident_title: '', tier: null, urgency: null, message: 'No emergency recognised.', provisional: false })
    render(<ReportIntake onInject={onInject} onSample={() => 's'} stage="idle" />)
    const box = screen.getByLabelText('Field report')
    await userEvent.type(box, 'one{Enter}')
    expect(await screen.findByText(/the AI is refining it/)).toBeTruthy()
    await userEvent.type(box, 'gibberish{Enter}')
    expect(await screen.findByText(/No emergency recognised/)).toBeTruthy()
    expect((box as HTMLTextAreaElement).value).toBe('gibberish')   // not lost on a rejection
  })

  it('explains API failures in plain words, including the retry hint', async () => {
    const onInject = vi.fn().mockRejectedValue(new ApiError('Too many requests', 'rate_limited', 429, 'req_1', 4))
    render(<ReportIntake onInject={onInject} onSample={() => 's'} stage="idle" />)
    await userEvent.type(screen.getByLabelText('Field report'), 'fire{Enter}')
    expect((await screen.findByRole('alert')).textContent).toContain('try again in 4s')
  })

  it('fills the box from a sample, counts characters, and locks when disabled', async () => {
    const { rerender } = render(<ReportIntake onInject={vi.fn()} onSample={() => 'Sample fire report'} stage="idle" />)
    await userEvent.click(screen.getByRole('button', { name: /Inject sample/ }))
    expect((screen.getByLabelText('Field report') as HTMLTextAreaElement).value).toBe('Sample fire report')
    expect(screen.getByText('18/2000')).toBeTruthy()
    rerender(<ReportIntake onInject={vi.fn()} onSample={() => 's'} stage="idle" disabled />)
    expect((screen.getByRole('button', { name: /Dispatch/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows the live pipeline stage in the stepper', () => {
    render(<ReportIntake onInject={vi.fn()} onSample={() => 's'} stage="risk" />)
    const steps = screen.getByLabelText('AI pipeline progress')
    expect(within(steps).getByText('Risk').closest('[aria-current="step"]')).toBeTruthy()
  })
})

describe('HeaderHud', () => {
  function hud(patch: Partial<Snapshot> = {}, props: Record<string, unknown> = {}) {
    const { snap } = world()
    const s = { ...snap, ...patch } as Snapshot
    const handlers = { onToggleTheme: vi.fn(), onToggleUnits: vi.fn(), onReset: vi.fn(), onToggleAuto: vi.fn(), onEndDrill: vi.fn(), onGuide: vi.fn() }
    render(<HeaderHud snap={s} theme="dark" showUnits resetting={false} exportUrl={null} autoDispatch={false} {...handlers} {...props} />)
    return { snap: s, ...handlers }
  }
  const openMenu = () => userEvent.click(screen.getByRole('button', { name: 'Menu' }))

  it('formats the drill clock', () => {
    expect(clockOf(0)).toBe('00:00:00')
    expect(clockOf(3725)).toBe('01:02:05')
    expect(clockOf(-5)).toBe('00:00:00')
  })

  it('names the six telemetry numbers in plain words, with the maths in the tooltip', () => {
    const { snap } = world()
    const stats = statsOf({ ...snap, elapsed_s: 754 })
    expect(stats.map((x) => x.label)).toEqual(['Ranking accuracy', 'Critical covered', 'Units free', 'Resolved', 'Response time', 'Drill time'])
    expect(stats[5].value).toBe('T+00:12:34')
    expect(stats[0].title).toContain('Spearman ρ')
    render(<><TelemetryBar snap={snap} /><StatGrid snap={snap} /></>)
    expect(screen.getAllByText('Ranking accuracy')).toHaveLength(2)
  })

  it('shows LIVE and the engine, and OFFLINE / ENDED distinctly', () => {
    hud()
    expect(screen.getByText('LIVE')).toBeTruthy()
    document.body.innerHTML = ''
    hud({ engine: 'remote', connection: 'offline' })
    expect(screen.getByText('OFFLINE')).toBeTruthy()
    document.body.innerHTML = ''
    hud({ status: 'ended' })
    expect(screen.getByText('ENDED')).toBeTruthy()
  })

  it('puts every drill action in one labelled menu (no cryptic icon row)', async () => {
    const { onToggleAuto, onEndDrill, onReset, onGuide, onToggleUnits } = hud({}, { autoDispatch: true })
    await openMenu()
    expect(screen.getByRole('menu')).toBeTruthy()
    const auto = screen.getByRole('menuitemcheckbox', { name: /Auto-dispatch/ })
    expect(auto.getAttribute('aria-checked')).toBe('true')
    await userEvent.click(auto)
    await openMenu(); await userEvent.click(screen.getByRole('menuitem', { name: /How it works/ }))
    await openMenu(); await userEvent.click(screen.getByRole('menuitemcheckbox', { name: /Show units on the map/ }))
    await openMenu(); await userEvent.click(screen.getByRole('menuitem', { name: /End the drill/ }))
    await openMenu(); await userEvent.click(screen.getByRole('menuitem', { name: /Restart the drill/ }))
    expect([onToggleAuto, onGuide, onToggleUnits, onEndDrill, onReset].every((f) => f.mock.calls.length === 1)).toBe(true)
  })

  it('disables ending an ended drill, and offers the CSV only when there is one', async () => {
    hud({ status: 'ended' }, { exportUrl: null })
    await openMenu()
    expect((screen.getByRole('menuitem', { name: /End the drill/ }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('menuitem', { name: /Download after-action CSV/ }) as HTMLButtonElement).disabled).toBe(true)
    document.body.innerHTML = ''
    hud({}, { exportUrl: '/api/drills/3/export.csv' })
    await openMenu()
    expect(screen.getByRole('menuitem', { name: /Download after-action CSV/ }).getAttribute('href')).toBe('/api/drills/3/export.csv')
  })
})

describe('DrillMenu', () => {
  it('opens on click, moves with the arrow keys, closes on Escape and returns focus', async () => {
    const a = vi.fn()
    render(<DrillMenu items={[{ id: 'a', label: 'Alpha', icon: null, onSelect: a }, { id: 'b', label: 'Bravo', icon: null }]} />)
    const trigger = screen.getByRole('button', { name: 'Menu' })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    await userEvent.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement?.textContent).toContain('Alpha')
    await userEvent.keyboard('{ArrowDown}')
    expect(document.activeElement?.textContent).toContain('Bravo')
    await userEvent.keyboard('{ArrowDown}')
    expect(document.activeElement?.textContent).toContain('Alpha')           // wraps
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })
})

describe('NextStep — the board explains itself', () => {
  it('derives one plain instruction from the state', () => {
    const { snap } = world()
    expect(nextStepOf({ ...snap, status: 'booting' }).id).toBe('booting')
    expect(nextStepOf({ ...snap, status: 'ended' }).id).toBe('ended')
    expect(nextStepOf(snap).id).toBe('approve')                                       // manual mode, proposals waiting
    expect(nextStepOf({ ...snap, proposals: [], incidents: [] }).id).toBe('report')
    const out = { ...snap, proposals: [], resources: snap.resources.map((r, i) => (i === 0 ? { ...r, status: 'en_route' as const } : r)) }
    expect(nextStepOf(out).id).toBe('watch')
    expect(nextStepOf({ ...snap, proposals: [], resources: snap.resources.map((r) => ({ ...r, status: 'available' as const })) }).id).toBe('idle')
  })

  it('offers the one button that moves the drill forward', async () => {
    const { snap } = world()
    const onGo = vi.fn()
    render(<NextStep snap={snap} onGo={onGo} />)
    expect(screen.getByRole('status', { name: 'Next step' }).textContent).toMatch(/waiting for you/)
    await userEvent.click(screen.getByRole('button', { name: /Review/ }))
    expect(onGo).toHaveBeenCalledWith('orders')
  })
})

describe('HowItWorks and ConfirmDialog', () => {
  it('walks through four steps and remembers that it was seen', async () => {
    localStorage.clear()
    const onClose = vi.fn()
    render(<HowItWorks onClose={onClose} />)
    expect(screen.getByRole('dialog', { name: 'How MissionSync works' })).toBeTruthy()
    expect(screen.getAllByRole('listitem')).toHaveLength(4)
    await userEvent.click(screen.getByRole('button', { name: /Got it/ }))
    expect(onClose).toHaveBeenCalled()
    expect(localStorage.getItem('ms-guide-seen')).toBe('1')
  })

  it('confirms in-page (no window.confirm), cancels on Escape and returns focus', async () => {
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    const { unmount } = render(<ConfirmDialog title="End this drill?" body="It freezes." confirmLabel="End drill" danger onConfirm={onConfirm} onCancel={onCancel} />)
    const dialog = screen.getByRole('dialog', { name: 'End this drill?' })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(document.activeElement?.textContent).toBe('Cancel')                       // the safe choice has focus
    await userEvent.tab()
    await userEvent.tab()
    expect(dialog.contains(document.activeElement)).toBe(true)                        // Tab stays inside
    await userEvent.click(screen.getByRole('button', { name: 'End drill' }))
    expect(onConfirm).toHaveBeenCalled()
    await userEvent.keyboard('{Escape}')
    expect(onCancel).toHaveBeenCalled()
    unmount()
    expect(document.activeElement).toBe(opener)
  })
})

describe('SystemBanners', () => {
  const base = () => world().snap
  it('says what is wrong, in words', () => {
    const s = base()
    const { rerender } = render(<SystemBanners snap={{ ...s, status: 'ended' }} />)
    expect(screen.getByText(/Drill ended/)).toBeTruthy()
    rerender(<SystemBanners snap={{ ...s, engine: 'remote', connection: 'offline' }} />)
    expect(screen.getByRole('alert').textContent).toContain('Lost the connection')
    rerender(<SystemBanners snap={{ ...s, engine: 'remote', metrics: { ...s.metrics, mode: 'quota_exhausted', quota_retry_s: 240 } }} />)
    expect(screen.getByText(/AI quota spent/)).toBeTruthy()
    expect(document.body.textContent).toContain('AI resumes in about 4 min')
    rerender(<SystemBanners snap={{ ...s, engine: 'remote', metrics: { ...s.metrics, mode: 'fallback' } }} />)
    expect(screen.getByText(/Degraded mode/)).toBeTruthy()
    rerender(<SystemBanners snap={s} />)
    expect(screen.getByText(/Demo engine/)).toBeTruthy()
    expect(screen.queryByLabelText(/Weather advisories/)).toBeNull()                 // weather lives with the map now
    document.body.innerHTML = ''
    render(<WeatherStrip snap={s} />)
    expect(screen.getByLabelText(/Weather advisories/).textContent).toMatch(/wind/)
  })
})

describe('ActionToast and ErrorBoundary', () => {
  it('announces politely and dismisses itself', () => {
    vi.useFakeTimers()
    const onDismiss = vi.fn()
    render(<ActionToast toast={{ id: 1, tone: 'error', text: 'Unit is busy' }} onDismiss={onDismiss} />)
    expect(screen.getByRole('status').getAttribute('aria-live')).toBe('polite')
    expect(screen.getByText('Unit is busy')).toBeTruthy()
    act(() => { vi.advanceTimersByTime(8100) })
    expect(onDismiss).toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('contains a crash to one panel and offers a retry', async () => {
    let explode = true
    function Bomb() {
      if (explode) throw new Error('kaboom')
      return <p>recovered</p>
    }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<ErrorBoundary label="The map"><Bomb /></ErrorBoundary>)
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('The map hit a problem')
    expect(alert.textContent).toContain('The rest of the board is still live')
    expect(alert.textContent).not.toContain('kaboom')                         // the technical message never reaches the user ...
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('The map crashed'), expect.any(Error), expect.anything())   // ... only the console
    explode = false
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(screen.getByText('recovered')).toBeTruthy()
    spy.mockRestore()
  })

  it('a crash of the whole app offers a reload instead of a retry, still without raw errors', () => {
    function Bomb(): never {
      throw new TypeError("Cannot read properties of undefined (reading 'incidents')")
    }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<ErrorBoundary label="MissionSync" scope="app"><Bomb /></ErrorBoundary>)
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('MissionSync hit a problem')
    expect(alert.textContent).not.toMatch(/Cannot read|undefined|TypeError/)
    expect(screen.getByRole('button', { name: 'Reload the page' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    spy.mockRestore()
  })
})
