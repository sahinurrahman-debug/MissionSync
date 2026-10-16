// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import axe from 'axe-core'
import { MemoryRouter } from 'react-router-dom'
import DrillBoard from '../pages/DrillBoard'
import { AuthProvider } from '../auth/AuthContext'
import AccountMenu from './AccountMenu'
import { FakeApi } from '../test-utils/fakeApi'
import { FakeSource } from '../test-utils/world'
import SideNav, { VIEWS } from './SideNav'

describe('SideNav', () => {
  it('lists every section, marks the current one, and reports clicks', async () => {
    const onChange = vi.fn()
    render(<SideNav view="orders" onChange={onChange} badge={{ situation: 3, orders: 9 }} />)
    const nav = screen.getByRole('navigation', { name: 'Sections' })
    expect(within(nav).getAllByRole('button')).toHaveLength(VIEWS.length)
    for (const v of VIEWS) expect(within(nav).getByRole('button', { name: new RegExp(`^${v.label}`) })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Orders/ }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('button', { name: /Fleet/ }).getAttribute('aria-current')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: /Fleet/ }))
    expect(onChange).toHaveBeenCalledWith('fleet')
  })

  it('says what the badges mean, in words', () => {
    render(<SideNav view="situation" onChange={vi.fn()} badge={{ situation: 4, orders: 9 }} />)
    expect(screen.getByRole('button', { name: /^Orders\s*9\s*awaiting approval$/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Situation\s*4\s*P1\/P2$/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Fleet' })).toBeTruthy()            // no badge ⇒ plain name
  })

  it('has no detectable accessibility violations', async () => {
    const { container } = render(<SideNav view="situation" onChange={vi.fn()} badge={{ orders: 2 }} />)
    const res = await axe.run(container, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } })
    expect(res.violations.map((v) => v.id)).toEqual([])
  })
})

/** The whole board on a desktop-sized viewport, fed by an in-memory source that behaves like the server. */
describe('Board navigation (desktop layout)', () => {
  const board = (source = new FakeSource()) => render(<MemoryRouter><DrillBoard source={source} title="Test drill" /></MemoryRouter>)

  beforeEach(() => {
    try {
      localStorage.clear()
      localStorage.setItem('ms-guide-seen', '1')          // the first-run walkthrough has its own tests
    } catch {
      /* ignore */
    }
    window.history.pushState({}, '', '/')
    window.matchMedia = ((query: string) => ({
      matches: /min-width:\s*1024px/.test(query),
      media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia
  })

  it('shows one section per panel and switches by click and by the 1-5 keys', async () => {
    board()
    await screen.findByRole('navigation', { name: 'Sections' })
    // Situation (default): map + ranked feed, but not the intake or fleet panels.
    const feed = await screen.findByRole('region', { name: /Ranked incident feed|incident feed/i })
    expect(feed).toBeTruthy()
    const mapBox = document.querySelector('.leaflet-container, [aria-label="Loading the map"]')?.closest('div.relative')
    if (mapBox) expect(feed.compareDocumentPosition(mapBox) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()   // the feed is on the left, the map after it
    expect(screen.queryByLabelText('Field report')).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: /^Orders/ }))
    expect(await screen.findByText(/Nothing moves until you approve/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Orders/ }).getAttribute('aria-current')).toBe('page')

    await userEvent.keyboard('3')
    expect(await screen.findByLabelText('Field report')).toBeTruthy()
    expect(screen.getByRole('region', { name: 'Live audit log' })).toBeTruthy()

    await userEvent.keyboard('4')
    expect(await screen.findByRole('region', { name: 'Resource fleet' })).toBeTruthy()
    expect(screen.queryByLabelText('Field report')).toBeNull()

    await userEvent.keyboard('5')
    const weather = await screen.findByRole('region', { name: 'Weather' })
    expect(weather).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Weather/ }).getAttribute('aria-current')).toBe('page')
    expect(screen.queryByLabelText(/Weather advisories/)).toBeNull()

    await userEvent.keyboard('1')
    expect(screen.getByRole('button', { name: /^Situation/ }).getAttribute('aria-current')).toBe('page')
  })

  it('does not hijack number keys while typing a report, and remembers the section', async () => {
    board()
    await userEvent.click(await screen.findByRole('button', { name: /^Report/ }))
    const box = await screen.findByLabelText('Field report')
    await userEvent.type(box, 'unit 2 on scene 4')
    expect((box as HTMLTextAreaElement).value).toBe('unit 2 on scene 4')        // digits typed, view unchanged
    expect(screen.getByRole('button', { name: /^Report/ }).getAttribute('aria-current')).toBe('page')
    expect(localStorage.getItem('ms-view')).toBe('report')
  })

  it('an approval made in Orders shows up as busy units in Fleet, and the next-step bar follows', async () => {
    const source = new FakeSource()
    board(source)
    expect(await screen.findByText(/dispatches are waiting for you/)).toBeTruthy()
    await userEvent.click(await screen.findByRole('button', { name: /^Orders/ }))
    await userEvent.click(await screen.findByRole('button', { name: /Approve All/ }))
    expect(source.calls).toContain('approve:all')
    expect(await screen.findByText(/responding/)).toBeTruthy()
    await userEvent.keyboard('4')
    const fleet = await screen.findByRole('region', { name: 'Resource fleet' })
    expect(within(fleet).getAllByText(/EN ROUTE|ON SCENE/i).length).toBeGreaterThan(0)
  })

  it('rolls an approval back when the server refuses it (optimistic UI)', async () => {
    const source = new FakeSource()
    source.approve = async () => { throw new Error('boom') }
    board(source)
    const before = source.getSnapshot().proposals.length
    await userEvent.click(await screen.findByRole('button', { name: /^Orders/ }))
    await userEvent.click(await screen.findByRole('button', { name: /Approve All/ }))
    expect(await screen.findByText(/did not work|Try Again/)).toBeTruthy()           // a friendly message, not the raw error
    expect(screen.queryByText(/boom/)).toBeNull()
    expect(await screen.findByRole('button', { name: new RegExp(`Approve All \\(${before}\\)`) })).toBeTruthy()   // the proposals came back
  })


  it('pins the account to the very bottom of the side rail, and keeps it out of the header on desktop', async () => {
    const api = new FakeApi().install()
    api.signIn('bea@example.com', 'Bea Tester')
    render(
      <MemoryRouter>
        <AuthProvider>
          <DrillBoard source={new FakeSource()} title="Test drill" account={<AccountMenu />} railAccount={<AccountMenu variant="rail" />} />
        </AuthProvider>
      </MemoryRouter>,
    )
    const rail = await screen.findByRole('navigation', { name: 'Sections' })
    const account = await within(rail).findByRole('button', { name: /Bea/ })
    expect(rail.lastElementChild?.contains(account)).toBe(true)                        // the extreme bottom of the rail
    expect(account.getAttribute('title')).toContain('bea@example.com')                  // full name and email on hover
    expect(screen.getAllByRole('button', { name: /Bea/ })).toHaveLength(1)             // not duplicated in the header
    await userEvent.click(account)
    expect(screen.getByRole('menu', { name: 'Account menu' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: /Sign Out/ })).toBeTruthy()
    expect(screen.getByText('bea@example.com')).toBeTruthy()
  })

  it('on a phone the account is in the header instead (there is no rail)', async () => {
    window.matchMedia = ((query: string) => ({ matches: false, media: query, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false })) as unknown as typeof window.matchMedia
    const api = new FakeApi().install()
    api.signIn('bea@example.com', 'Bea Tester')
    render(
      <MemoryRouter>
        <AuthProvider>
          <DrillBoard source={new FakeSource()} title="Test drill" account={<AccountMenu />} railAccount={<AccountMenu variant="rail" />} />
        </AuthProvider>
      </MemoryRouter>,
    )
    expect(await screen.findByRole('button', { name: /Bea/ })).toBeTruthy()
    expect(screen.queryByRole('navigation', { name: 'Sections' })?.textContent).not.toContain('Bea')   // only the tab bar, no rail
  })

  it('asks before ending the drill, then freezes it', async () => {
    const source = new FakeSource()
    board(source)
    await userEvent.click(await screen.findByRole('button', { name: 'Menu' }))
    await userEvent.click(screen.getByRole('menuitem', { name: /End the Drill/ }))
    expect(source.calls).not.toContain('end')                                         // nothing happens until confirmed
    await userEvent.click(screen.getByRole('button', { name: 'End Drill' }))
    expect(await screen.findByText(/The drill has ended/)).toBeTruthy()
    expect(source.calls).toContain('end')
  })
})
