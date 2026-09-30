// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import axe from 'axe-core'
import App from '../App'
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
    expect(screen.getByRole('button', { name: 'Orders, 9 awaiting approval' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Situation, 4 P1/P2' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Fleet' })).toBeTruthy()            // no badge ⇒ plain name
  })

  it('has no detectable accessibility violations', async () => {
    const { container } = render(<SideNav view="situation" onChange={vi.fn()} badge={{ orders: 2 }} />)
    const res = await axe.run(container, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } })
    expect(res.violations.map((v) => v.id)).toEqual([])
  })
})

/** The whole board on a desktop-sized viewport, driven by the in-browser demo engine. */
describe('Board navigation (desktop layout)', () => {
  beforeEach(() => {
    window.history.pushState({}, '', '/?engine=local')
    try {
      localStorage.clear()
    } catch {
      /* ignore */
    }
    window.matchMedia = ((query: string) => ({
      matches: /min-width:\s*1024px/.test(query),
      media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia
  })
  afterEach(() => window.history.pushState({}, '', '/'))

  it('shows one section per panel and switches by click and by the 1-4 keys', async () => {
    render(<App />)
    await screen.findByRole('navigation', { name: 'Sections' })
    // Situation (default): map + ranked feed, but not the intake or fleet panels.
    expect(await screen.findByRole('region', { name: /Ranked incident feed|incident feed/i })).toBeTruthy()
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

    await userEvent.keyboard('1')
    expect(screen.getByRole('button', { name: /^Situation/ }).getAttribute('aria-current')).toBe('page')
  })

  it('does not hijack number keys while typing a report, and remembers the section', async () => {
    render(<App />)
    await userEvent.click(await screen.findByRole('button', { name: /^Report/ }))
    const box = await screen.findByLabelText('Field report')
    await userEvent.type(box, 'unit 2 on scene 4')
    expect((box as HTMLTextAreaElement).value).toBe('unit 2 on scene 4')        // digits typed, view unchanged
    expect(screen.getByRole('button', { name: /^Report/ }).getAttribute('aria-current')).toBe('page')
    expect(localStorage.getItem('ms-view')).toBe('report')
  })

  it('an approval made in Orders shows up as busy units in Fleet', async () => {
    render(<App />)
    await userEvent.click(await screen.findByRole('button', { name: /^Orders/ }))
    await userEvent.click(await screen.findByRole('button', { name: /Approve all/ }))
    await userEvent.keyboard('4')
    const fleet = await screen.findByRole('region', { name: 'Resource fleet' })
    expect(within(fleet).getAllByText(/EN ROUTE|ON SCENE/i).length).toBeGreaterThan(0)
  })
})
