// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from '../App'
import { FakeApi } from '../test-utils/fakeApi'

let api: FakeApi

function visit(path: string) {
  window.history.pushState({}, '', path)
  return render(<App />)
}

class IdleSocket {                         // the live socket is covered by api/remote.ws.test.ts; page tests just need it quiet
  onopen = null; onclose = null; onmessage = null; onerror = null; readyState = 0
  send() {}
  close() {}
}

beforeEach(() => {
  vi.stubGlobal('WebSocket', IdleSocket)
  localStorage.clear()
  sessionStorage.clear()
  localStorage.setItem('ms-guide-seen', '1')
  api = new FakeApi().install()
  vi.spyOn(window, 'alert').mockImplementation(() => undefined)
  vi.spyOn(window, 'confirm').mockImplementation(() => true)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('protected routes', () => {
  it('sends a visitor from /drills to the sign-in page, and brings them back after signing in', async () => {
    api.addAccount('ann@example.com', 'correct horse 9')
    visit('/drills')
    expect(await screen.findByRole('button', { name: 'Sign In' })).toBeTruthy()
    expect(window.location.pathname).toBe('/login')
    await userEvent.type(screen.getByLabelText('Email'), 'ann@example.com')
    await userEvent.type(screen.getByLabelText('Password'), 'correct horse 9')
    await userEvent.click(screen.getByRole('button', { name: 'Sign In' }))
    expect(await screen.findByRole('heading', { name: 'My Drills' })).toBeTruthy()
    expect(window.location.pathname).toBe('/drills')
  })

  it('also guards a single drill, and returns there after sign-in', async () => {
    api.addAccount('ann@example.com', 'correct horse 9')
    api.seed('Mine')
    visit('/drills/1')
    expect(await screen.findByLabelText('Email')).toBeTruthy()
    await userEvent.type(screen.getByLabelText('Email'), 'ann@example.com')
    await userEvent.type(screen.getByLabelText('Password'), 'correct horse 9')
    await userEvent.click(screen.getByRole('button', { name: 'Sign In' }))
    await waitFor(() => expect(window.location.pathname).toBe('/drills/1'))
  })

  it('a signed-in user who opens /login is sent on to their drills', async () => {
    api.signIn()
    visit('/login')
    expect(await screen.findByRole('heading', { name: 'My Drills' })).toBeTruthy()
  })

  it('verifies the session with the server on load (nothing is trusted from the browser)', async () => {
    localStorage.setItem('user', JSON.stringify({ email: 'forged@example.com' }))        // a forged client-side "login" does nothing
    visit('/drills')
    expect(await screen.findByLabelText('Email')).toBeTruthy()
    expect(api.calls[0]).toMatchObject({ method: 'GET', path: '/api/auth/session' })
  })

  it('an expired session (401 anywhere) returns you to sign-in', async () => {
    api.signIn()
    api.seed('One')
    visit('/drills')
    expect(await screen.findByText('One')).toBeTruthy()
    api.signedIn = null                                                                   // the server forgot us
    await userEvent.click(screen.getByRole('button', { name: /Rename One/ }))
    await userEvent.type(screen.getByLabelText(/New name for/), ' two{Enter}')
    expect(await screen.findByRole('button', { name: 'Sign In' })).toBeTruthy()
  })

  it('shows a friendly page — not an error — for a drill that is not yours', async () => {
    api.signIn()
    visit('/drills/999')
    expect(await screen.findByRole('heading', { name: 'That Drill Does Not Exist' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Back to My Drills' })).toBeTruthy()
  })

  it('has a catch-all page, and the demo needs no account', async () => {
    visit('/nope/nowhere')
    expect(await screen.findByRole('heading', { name: 'Page Not Found' })).toBeTruthy()
  })

  it('the demo needs no form: one click makes a temporary guest with its own drill and opens it', async () => {
    visit('/demo')
    await waitFor(() => expect(window.location.pathname).toBe('/drills/1'))
    expect(api.calls.some((c) => c.path === '/api/auth/demo' && c.method === 'POST')).toBe(true)
    expect(api.drills.map((d) => d.name)).toEqual(['Demo Drill'])
    expect(api.signedIn?.is_guest).toBe(true)
    expect(await screen.findByText('Temporary Demo Account.')).toBeTruthy()           // says plainly that it is temporary
    expect(screen.getByRole('link', { name: 'Create an Account' }).getAttribute('href')).toBe('/signup')
    await userEvent.click(screen.getByRole('button', { name: 'Hide This Notice' }))      // dismissible, so it never costs a phone screen its room
    expect(screen.queryByText('Temporary Demo Account.')).toBeNull()
  })

  it('the demo explains a busy server and offers to try again or sign up', async () => {
    api.demoFails = true
    visit('/demo')
    expect(await screen.findByText(/The demo is busy right now/)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Create an Account' })).toBeTruthy()
    api.demoFails = false
    await userEvent.click(screen.getByRole('button', { name: 'Try Again' }))
    await waitFor(() => expect(window.location.pathname).toBe('/drills/1'))
  })

  it('someone who is already signed in is not given a second, guest account', async () => {
    api.signIn()
    visit('/demo')
    expect(await screen.findByRole('heading', { name: 'My Drills' })).toBeTruthy()
    expect(api.calls.some((c) => c.path === '/api/auth/demo')).toBe(false)
  })

  it('the sign-in page advertises the demo in plain words', async () => {
    visit('/login')
    const link = await screen.findByRole('link', { name: 'Try the Demo' })
    expect(link.getAttribute('href')).toBe('/demo')
    expect(document.body.textContent).toMatch(/real data and the AI agents/)
  })
})

describe('site footer', () => {
  it('every full page ends with the footer: sign-in, My Drills, not-found', async () => {
    visit('/login')
    expect(await screen.findByRole('contentinfo')).toBeTruthy()
    document.body.innerHTML = ''
    api.signIn()
    visit('/drills')
    await screen.findByRole('heading', { name: 'My Drills' })
    expect(screen.getByRole('contentinfo').textContent).toContain('MissionSync')
    document.body.innerHTML = ''
    visit('/nowhere')
    expect((await screen.findByRole('contentinfo')).textContent).toContain('not for real emergencies')
  })

  it('pages own their vertical scrolling and never scroll sideways', async () => {
    visit('/login')
    await screen.findByRole('contentinfo')
    const shell = document.querySelector('main')!.closest('div.overflow-y-auto')!
    expect(shell.className).toContain('overflow-x-hidden')
    expect(shell.className).toContain('h-dvh')
    expect(shell.firstElementChild!.className).not.toContain('min-h-0')                // content must never shrink under the footer
  })
})

describe('sign in and sign up forms', () => {
  it('shows validation inline — never an alert popup — and does not call the server', async () => {
    visit('/signup')
    await userEvent.click(await screen.findByRole('button', { name: 'Create Account' }))
    expect(screen.getByText('Enter your name.')).toBeTruthy()
    expect(screen.getByText('Enter a valid email address.')).toBeTruthy()
    expect(screen.getAllByText('Use at least 8 characters.').length).toBeGreaterThan(0)
    expect(screen.getByLabelText('Email').getAttribute('aria-invalid')).toBe('true')
    expect(window.alert).not.toHaveBeenCalled()
    expect(api.calls.filter((c) => c.path === '/api/auth/signup')).toHaveLength(0)
  })

  it('puts the server\'s sign-in refusal under the password field', async () => {
    api.addAccount('ann@example.com', 'correct horse 9')
    visit('/login')
    await userEvent.type(await screen.findByLabelText('Email'), 'ann@example.com')
    await userEvent.type(screen.getByLabelText('Password'), 'wrong password!')
    await userEvent.click(screen.getByRole('button', { name: 'Sign In' }))
    expect(await screen.findByText('That email and password do not match.')).toBeTruthy()
    expect(window.location.pathname).toBe('/login')
    expect(window.alert).not.toHaveBeenCalled()
  })

  it('creates an account, signs in and lands on an empty My Drills page', async () => {
    visit('/signup')
    await userEvent.type(await screen.findByLabelText('Your Name'), 'Bea Tester')
    await userEvent.type(screen.getByLabelText('Email'), 'bea@example.com')
    await userEvent.type(screen.getByLabelText('Password'), 'a long passphrase')
    await userEvent.click(screen.getByRole('button', { name: 'Create Account' }))
    expect(await screen.findByRole('heading', { name: 'My Drills' })).toBeTruthy()
    expect(screen.getByText('No Drills Yet.')).toBeTruthy()                                // a designed empty state
    expect(screen.getByRole('button', { name: /Bea/ })).toBeTruthy()                       // the account menu knows who you are
  })

  it('shows "email already used" next to the email field', async () => {
    api.addAccount('ann@example.com', 'correct horse 9')
    visit('/signup')
    await userEvent.type(await screen.findByLabelText('Your Name'), 'Ann')
    await userEvent.type(screen.getByLabelText('Email'), 'ann@example.com')
    await userEvent.type(screen.getByLabelText('Password'), 'a long passphrase')
    await userEvent.click(screen.getByRole('button', { name: 'Create Account' }))
    expect(await screen.findByText(/already exists/)).toBeTruthy()
    expect(screen.getByLabelText('Email').getAttribute('aria-describedby')).toBeTruthy()
  })

  it('disables the button and says what it is doing while the request runs', async () => {
    api.addAccount('ann@example.com', 'correct horse 9')
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => { release = r })
    const real = fetch as unknown as (u: string, i?: RequestInit) => Promise<Response>
    vi.stubGlobal('fetch', vi.fn(async (u: string, i?: RequestInit) => { if (u === '/api/auth/login') await gate; return real(u, i) }))
    visit('/login')
    await userEvent.type(await screen.findByLabelText('Email'), 'ann@example.com')
    await userEvent.type(screen.getByLabelText('Password'), 'correct horse 9')
    await userEvent.click(screen.getByRole('button', { name: 'Sign In' }))
    const busy = await screen.findByRole('button', { name: /Signing In/ })
    expect((busy as HTMLButtonElement).disabled).toBe(true)
    release()
    expect(await screen.findByRole('heading', { name: 'My Drills' })).toBeTruthy()
  })

  it('the password can be revealed and hidden', async () => {
    visit('/login')
    const field = await screen.findByLabelText('Password')
    expect(field.getAttribute('type')).toBe('password')
    await userEvent.click(screen.getByRole('button', { name: /Show/ }))
    expect(field.getAttribute('type')).toBe('text')
  })
})

describe('My Drills — create, read, update, delete with optimistic UI', () => {
  beforeEach(() => api.signIn())

  it('lists drills, and shows a skeleton while loading', async () => {
    api.seed('Alpha', 'Bravo')
    api.delay = 60
    visit('/drills')
    expect(await screen.findByLabelText('Loading your drills')).toBeTruthy()
    expect(await screen.findByText('Alpha')).toBeTruthy()
    expect(screen.getByText('Bravo')).toBeTruthy()
  })

  it('create: the card appears instantly, then becomes real', async () => {
    api.delay = 150
    visit('/drills')
    expect(await screen.findByText('No Drills Yet.')).toBeTruthy()
    await userEvent.type(screen.getByLabelText('Drill Name'), 'Saturday drill')
    await userEvent.click(screen.getByRole('button', { name: /New Drill/ }))
    const pending = await screen.findByText('Saturday drill')                              // before the server has answered
    expect(pending.closest('li')?.getAttribute('aria-busy')).toBe('true')
    expect(screen.getByText('Creating…')).toBeTruthy()
    await waitFor(() => expect(screen.getByRole('link', { name: /^Open$/ }).getAttribute('href')).toBe('/drills/1'))
    expect((screen.getByLabelText('Drill Name') as HTMLInputElement).value).toBe('')
  })

  it('create: validation shows inline, and a server refusal rolls the card back and keeps what you typed', async () => {
    visit('/drills')
    await screen.findByText('No Drills Yet.')
    await userEvent.click(screen.getByRole('button', { name: /New Drill/ }))
    expect(screen.getByText('Give the drill a name.')).toBeTruthy()
    expect(api.calls.filter((c) => c.method === 'POST' && c.path === '/api/drills')).toHaveLength(0)

    api.failNext['POST /api/drills'] = new Response(JSON.stringify({ error: 'You can keep up to 10 drills. Delete one to make room.', code: 'conflict', request_id: 'r' }), { status: 409 })
    await userEvent.type(screen.getByLabelText('Drill Name'), 'Too many')
    await userEvent.click(screen.getByRole('button', { name: /New Drill/ }))
    expect(await screen.findByText(/up to 10 drills/)).toBeTruthy()                         // friendly message
    expect(screen.queryByRole('link', { name: /^Open$/ })).toBeNull()                         // optimistic card removed
    expect((screen.getByLabelText('Drill Name') as HTMLInputElement).value).toBe('Too many')
  })

  it('update: renaming shows at once and is saved', async () => {
    api.seed('Old name')
    api.delay = 100
    visit('/drills')
    await userEvent.click(await screen.findByRole('button', { name: /Rename Old name/ }))
    const input = screen.getByLabelText(/New name for/) as HTMLInputElement
    await userEvent.clear(input)
    await userEvent.type(input, 'New name{Enter}')
    expect(screen.getByText('New name')).toBeTruthy()                                      // instantly
    await waitFor(() => expect(api.drills[0].name).toBe('New name'))
    expect(api.calls.find((c) => c.method === 'PATCH')?.body).toEqual({ name: 'New name' })
  })

  it('update: a failed rename goes back to the old name with a message', async () => {
    api.seed('Keep me')
    visit('/drills')
    api.failNext['PATCH /api/drills/:id'] = new Response(JSON.stringify({ error: 'Something went wrong on the server.', code: 'internal_error', request_id: 'r' }), { status: 500 })
    await userEvent.click(await screen.findByRole('button', { name: /Rename Keep me/ }))
    const input = screen.getByLabelText(/New name for/) as HTMLInputElement
    await userEvent.clear(input)
    await userEvent.type(input, 'Broken{Enter}')
    expect(await screen.findByText('Something went wrong on the server.')).toBeTruthy()
    expect(screen.getByText('Keep me')).toBeTruthy()
    expect(screen.queryByText('Broken')).toBeNull()
  })

  it('delete: asks in-page, removes the card instantly, and really deletes', async () => {
    api.seed('Doomed', 'Survivor')
    visit('/drills')
    await userEvent.click(await screen.findByRole('button', { name: /Delete Doomed/ }))
    expect(window.confirm).not.toHaveBeenCalled()                                          // an accessible dialog, not a popup
    const dialog = screen.getByRole('dialog', { name: /Delete “Doomed”\?/ })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete Drill' }))
    await waitFor(() => expect(screen.queryByText('Doomed')).toBeNull())
    expect(screen.getByText('Survivor')).toBeTruthy()
    expect(api.drills.map((d) => d.name)).toEqual(['Survivor'])
  })

  it('delete: cancelling keeps everything, and a failed delete puts the card back', async () => {
    api.seed('Stays')
    visit('/drills')
    await userEvent.click(await screen.findByRole('button', { name: /Delete Stays/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByText('Stays')).toBeTruthy()

    api.failNext['DELETE /api/drills/:id'] = new Response(JSON.stringify({ error: 'The server is busy.', code: 'degraded', request_id: 'r' }), { status: 503 })
    await userEvent.click(screen.getByRole('button', { name: /Delete Stays/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Delete Drill' }))
    expect(await screen.findByText(/The server is busy\. “Stays” was put back\./)).toBeTruthy()
    expect(screen.getByText('Stays')).toBeTruthy()
  })

  it('signing out clears the session and protects the page again', async () => {
    visit('/drills')
    await userEvent.click(await screen.findByRole('button', { name: /Ann/ }))
    await userEvent.click(screen.getByRole('menuitem', { name: /Sign Out/ }))
    expect(await screen.findByRole('button', { name: 'Sign In' })).toBeTruthy()
    expect(api.signedIn).toBeNull()
    window.history.pushState({}, '', '/drills')
    document.body.innerHTML = ''
    render(<App />)
    expect(await screen.findByRole('button', { name: 'Sign In' })).toBeTruthy()
  })
})
