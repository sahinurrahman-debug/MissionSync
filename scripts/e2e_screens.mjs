// End-to-end walk-through of the real app in headless Edge/Chrome — and the source of the README screenshots.
//
//   (terminal 1)  cd backend && .venv/Scripts/python -m uvicorn missionsync.main:app --port 8000   # serves the built dashboard
//   (terminal 2)  cd frontend && npm run build
//   (terminal 3)  node scripts/e2e_screens.mjs            # needs: npm i -D puppeteer-core   (or NODE_PATH=<its node_modules>)
//
// It signs up a throw-away account through the UI, creates a drill, opens it, approves dispatches, adds a report,
// ends the drill, signs out — asserting what a person would see at each step — and writes screenshots/*.png.
import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = process.env.BASE ?? 'http://127.0.0.1:8000'
const EXE = process.env.CHROME_PATH ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'screenshots')
const THEME = process.env.THEME ?? 'dark'
const email = `e2e-${Date.now()}@example.com`
const password = 'correct horse 9'
mkdirSync(OUT, { recursive: true })

const browser = await puppeteer.launch({ executablePath: EXE, headless: 'new', args: ['--no-sandbox'] })
let failures = 0
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) failures++ }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const shot = (page, name) => page.screenshot({ path: join(OUT, `${name}.png`) })
const text = (page) => page.evaluate(() => document.body.innerText)
const waitText = async (page, re, timeout = 60000) => {
  try {
    await page.waitForFunction((s) => new RegExp(s).test(document.body.innerText), { timeout, polling: 150 }, re.source)
  } catch {
    const t = await page.evaluate(() => document.body.innerText.slice(0, 300).replace(/\s+/g, ' '))
    throw new Error(`waited ${timeout} ms for ${re} at ${page.url()} — the page said: ${t}`)
  }
}
const clickText = (page, selector, re) => page.evaluate((sel, s) => {
  const el = [...document.querySelectorAll(sel)].find((e) => new RegExp(s, 'i').test((e.getAttribute('aria-label') || e.textContent).trim()))
  if (!el) throw new Error(`no ${sel} matching ${s}`)
  el.click()
}, selector, re.source)

async function setup(page, w, h, mobile = false) {
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile })
  await page.evaluateOnNewDocument((theme) => {
    try { localStorage.setItem('ms-theme', theme); localStorage.setItem('ms-guide-seen', '1') } catch { /* ignore */ }
  }, THEME)
}

try {
  const page = await browser.newPage()
  await setup(page, 1366, 800)

  // 1. a visitor is sent to sign-in
  await page.goto(`${BASE}/drills`, { waitUntil: 'networkidle2' })
  check(page.url().endsWith('/login'), 'visitor on /drills is redirected to /login')
  await shot(page, 'login')

  // 1b. the one-click demo: no form, a temporary private drill with the real scenario and agents
  const incognito = await browser.createBrowserContext()                     // its own cookie jar: the guest must not leak into the main run
  const demo = await incognito.newPage()
  await setup(demo, 1366, 800)
  await demo.goto(`${BASE}/demo`, { waitUntil: 'networkidle2' })
  await waitText(demo, /Temporary demo account/, 90000)
  check(/\/drills\/\d+$/.test(demo.url()), 'the demo button lands in the visitor\'s own drill (no form)')
  await waitText(demo, /LIVE/, 90000)
  await waitText(demo, /waiting for you/, 90000)
  check(true, 'the demo drill boots with the real scenario and proposals waiting for approval')
  await incognito.close()

  // 2. validation is inline
  await page.goto(`${BASE}/signup`, { waitUntil: 'networkidle2' })
  await clickText(page, 'button', /create account/)
  check(/Enter a valid email address/.test(await text(page)), 'empty sign-up shows inline validation')

  // 3. sign up
  await page.type('input[autocomplete="name"]', 'E2E Tester')
  await page.type('input[type="email"]', email)
  await page.type('input[autocomplete="new-password"]', password)
  await clickText(page, 'button', /^create account$/)
  await waitText(page, /No drills yet/)
  check(/No drills yet/.test(await text(page)), 'new account lands on My drills with a designed empty state')
  await shot(page, 'drills-empty')

  // 4. create a drill (optimistic card), then open it
  await page.type('input[placeholder^="e.g."]', 'Saturday campus drill')
  await clickText(page, 'button', /new drill/)
  await waitText(page, /Open/)
  await shot(page, 'drills')
  await clickText(page, 'a', /^open$/)
  await waitText(page, /LIVE/, 90000)
  await waitText(page, /waiting for you|No incidents/, 90000)
  await sleep(1500)
  check(/waiting for you/.test(await text(page)), 'the drill boots and the next-step bar asks for approval')
  check(/Saturday campus drill/.test(await text(page)), 'the header shows the drill name')
  await sleep(25000)                                                                  // let the LLM refine the first scores
  await shot(page, 'desktop')

  // 5. orders → approve all → fleet
  await clickText(page, 'nav[aria-label="Sections"] button', /^orders/i)
  await sleep(800)
  await shot(page, 'view-orders')
  await clickText(page, 'button', /approve all/)
  await waitText(page, /responding/)
  check(true, 'approve-all dispatches units and the bar says they are responding')
  await clickText(page, 'nav[aria-label="Sections"] button', /^fleet/i)
  await sleep(800)
  check(/EN ROUTE/i.test(await text(page)), 'fleet shows units en route')
  await shot(page, 'view-fleet')

  // 6. report
  await clickText(page, 'nav[aria-label="Sections"] button', /^report/i)
  await page.type('textarea', 'Gas leak at the University chemistry building, three students unconscious')
  await page.keyboard.press('Enter')
  await waitText(page, /New incident logged|Merged into/, 30000)
  check(true, 'a typed report is accepted and ranked')
  await sleep(500)
  await shot(page, 'view-report')

  // light theme, for the README
  await clickText(page, 'nav[aria-label="Sections"] button', /^situation/i)
  await clickText(page, 'button', /toggle color theme/)
  await sleep(1200)
  await shot(page, 'desktop-light')
  await clickText(page, 'button', /toggle color theme/)

  // 7. refresh keeps the session and the drill (server-side state)
  await page.reload({ waitUntil: 'networkidle2' })
  await waitText(page, /LIVE/, 60000)
  check(/Saturday campus drill/.test(await text(page)), 'after a page refresh you are still signed in and the drill is intact')

  // 8. mobile (same session, while the drill is live)
  const phone = await browser.newPage()
  await setup(phone, 375, 812, true)
  await phone.goto(`${BASE}/drills`, { waitUntil: 'networkidle2' })
  await waitText(phone, /My drills/)
  await shot(phone, 'mobile-drills')
  await clickText(phone, 'a', /review|open/)
  await waitText(phone, /LIVE/, 60000)
  await sleep(2500)
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth > innerWidth)
  check(!overflow, 'no horizontal scroll at 375px')
  const headerFits = await phone.evaluate(() => [...document.querySelectorAll('header button, header a')].every((el) => el.getBoundingClientRect().right <= innerWidth + 1))
  check(headerFits, 'every header control is on screen at 375px')
  await shot(phone, 'mobile')
  await clickText(phone, 'nav[aria-label="Sections"] button', /orders/i)
  await sleep(700)
  await shot(phone, 'mobile-orders')

  // 9. end the drill
  await clickText(page, 'button', /^menu$/i)
  await clickText(page, '[role="menuitem"]', /end the drill/)
  await clickText(page, 'button', /^end drill$/)
  await waitText(page, /The drill has ended/)
  check(true, 'ending the drill freezes it')

  // 10. sign out and the guard is back
  await clickText(page, 'a', /back to my drills/)
  await waitText(page, /My drills/)
  await clickText(page, 'button', /E2E/)
  await clickText(page, '[role="menuitem"]', /sign out/)
  await waitText(page, /Sign in/)
  await page.goto(`${BASE}/drills`, { waitUntil: 'networkidle2' })
  check(page.url().endsWith('/login'), 'after signing out, /drills is protected again')
} catch (e) {
  console.error('E2E error:', e.message)
  failures++
} finally {
  await browser.close()
}
console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed')
process.exit(failures ? 1 : 0)
