// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { LocalEngine } from '../engine/local'
import { ApiError, type Snapshot } from '../types'
import ActionToast from './ActionToast'
import AdminKeyDialog from './AdminKeyDialog'
import ErrorBoundary from './ErrorBoundary'
import FleetAndLog from './FleetAndLog'
import HeaderHud, { clockOf } from './HeaderHud'
import IncidentCard from './IncidentCard'
import Recommendations from './Recommendations'
import ReportIntake from './ReportIntake'
import SystemBanners from './SystemBanners'

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
    for (const b of screen.getAllByRole('button')) expect((b as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows dispatched units (not proposals) once auto-dispatch has committed them', () => {
    const { snap } = world(true)
    render(<Recommendations actions={snap.actions} proposals={snap.proposals} loading={false} autoDispatch onApprove={vi.fn()} onReject={vi.fn()} />)
    expect(screen.queryByText(/Nothing moves until you approve/)).toBeNull()
    expect(screen.getAllByText('Dispatched').length).toBeGreaterThan(0)
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
    const handlers = { onToggleTheme: vi.fn(), onToggleUnits: vi.fn(), onReset: vi.fn(), onToggleAuto: vi.fn(), onEndDrill: vi.fn() }
    render(<HeaderHud snap={s} theme="dark" showUnits resetting={false} exportUrl={null} autoDispatch={false} {...handlers} {...props} />)
    return { snap: s, ...handlers }
  }

  it('formats the drill clock', () => {
    expect(clockOf(0)).toBe('00:00:00')
    expect(clockOf(3725)).toBe('01:02:05')
    expect(clockOf(-5)).toBe('00:00:00')
  })

  it('shows LIVE, and the telemetry keeps the Greek rho (not an upper-cased P)', () => {
    hud({ elapsed_s: 754 })
    expect(screen.getByText('LIVE')).toBeTruthy()
    expect(screen.getAllByText('T+00:12:34').length).toBeGreaterThan(0)   // header (xl) and strip (smaller) share one component
    expect(document.body.textContent).toContain('ρ')
    expect(screen.getAllByText('ρ')[0].className).toContain('normal-case')
  })

  it('reports OFFLINE and ENDED distinctly', () => {
    hud({ engine: 'remote', connection: 'offline' })
    expect(screen.getByText('OFFLINE')).toBeTruthy()
    document.body.innerHTML = ''
    hud({ status: 'ended' })
    expect(screen.getByText('ENDED')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'End the drill' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('exposes dispatch mode as a pressed toggle and calls the handlers', async () => {
    const { onToggleAuto, onEndDrill, onReset } = hud({}, { autoDispatch: true })
    const toggle = screen.getByRole('button', { name: /Auto-dispatch is on/ })
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    await userEvent.click(toggle)
    await userEvent.click(screen.getByRole('button', { name: 'End the drill' }))
    await userEvent.click(screen.getByRole('button', { name: 'Restart the drill' }))
    expect([onToggleAuto, onEndDrill, onReset].every((f) => f.mock.calls.length === 1)).toBe(true)
  })

  it('offers the CSV only when there is something to download', () => {
    hud({}, { exportUrl: null })
    expect((screen.getByRole('button', { name: /export unavailable/i }) as HTMLButtonElement).disabled).toBe(true)
    document.body.innerHTML = ''
    hud({}, { exportUrl: '/api/drills/3/export.csv' })
    expect(screen.getByRole('link', { name: /Download after-action CSV/ }).getAttribute('href')).toBe('/api/drills/3/export.csv')
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
    expect(screen.getByLabelText('Weather advisories')).toBeTruthy()
  })
})

describe('AdminKeyDialog', () => {
  it('is a modal that takes focus, traps Tab, closes on Escape and returns the key', async () => {
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()
    const onSubmit = vi.fn()
    const onCancel = vi.fn()
    const { unmount } = render(<AdminKeyDialog action="Restart the drill" rejected={false} onSubmit={onSubmit} onCancel={onCancel} />)
    const dialog = screen.getByRole('dialog', { name: 'Admin key required' })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    const input = screen.getByLabelText('Admin key')
    expect(document.activeElement).toBe(input)
    expect((screen.getByRole('button', { name: 'Confirm' }) as HTMLButtonElement).disabled).toBe(true)

    await userEvent.tab({ shift: true })                            // backwards from the first control wraps to the last
    expect(dialog.contains(document.activeElement)).toBe(true)
    await userEvent.type(input, ' s3cret ')
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    expect(onSubmit).toHaveBeenCalledWith('s3cret')
    await userEvent.keyboard('{Escape}')
    expect(onCancel).toHaveBeenCalled()
    unmount()
    expect(document.activeElement).toBe(opener)                     // focus goes back where it came from
  })

  it('says when a key was refused', () => {
    render(<AdminKeyDialog action="End the drill" rejected onSubmit={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByRole('alert').textContent).toContain('not accepted')
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
