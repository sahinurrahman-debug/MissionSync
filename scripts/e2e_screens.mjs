// End-to-end walk-through of the real app in headless Edge/Chrome — and the source of the README screenshots.
//
//   (terminal 1)  cd backend && .venv/Scripts/python -m uvicorn missionsync.main:app --port 8000   # serves the built dashboard
//   (terminal 2)  cd frontend && npm run build
//   (terminal 3)  cd scripts && npm install && node e2e_screens.mjs     # CHROME_PATH=<chrome or edge> if it is not the default
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

/** No sideways scrolling anywhere: not on the document, and no element that would grow a horizontal scrollbar
 *  (or a vertical panel whose content is wider than the panel). */
async function noSideways(page, label) {
  const bad = await page.evaluate(() => {
    const out = []
    if (document.documentElement.scrollWidth > innerWidth + 1) out.push(`document ${document.documentElement.scrollWidth}>${innerWidth}`)
    for (const el of document.querySelectorAll('body *')) {
      const cs = getComputedStyle(el)
      if (cs.display === 'none' || el.closest('.leaflet-container') || !el.clientWidth) continue
      const wider = el.scrollWidth > el.clientWidth + 1
      if (wider && (cs.overflowX === 'auto' || cs.overflowX === 'scroll')) out.push(`${el.tagName}.${String(el.className).slice(0, 40)} scrolls sideways`)
      else if (wider && /overflow-y-auto/.test(String(el.className))) out.push(`${el.tagName}.${String(el.className).slice(0, 40)} clips wider content`)
    }
    return out.slice(0, 4)
  })
  check(bad.length === 0, `no sideways scrolling — ${label}${bad.length ? ': ' + bad.join(' | ') : ''}`)
}
const hasFooter = (page) => page.evaluate(() => !!document.querySelector('footer') && /not for real emergencies|MIT licence/.test(document.querySelector('footer').innerText))

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
  check(await hasFooter(page), 'the sign-in page has the footer')
  await noSideways(page, 'sign-in page, desktop')

  // 1b. the one-click demo: no form, a temporary private drill with the real scenario and agents
  const incognito = await browser.createBrowserContext()                     // its own cookie jar: the guest must not leak into the main run
  const demo = await incognito.newPage()
  await setup(demo, 1366, 800)
  await demo.goto(`${BASE}/demo`, { waitUntil: 'networkidle2' })
  await sleep(1500)
  check(/Try MissionSync/.test(await text(demo)) && /\/demo$/.test(demo.url()), 'opening /demo by address only asks — it creates nothing until the button is pressed')
  await clickText(demo, 'button', /start the demo/)
  await waitText(demo, /Temporary Demo Account/, 90000)
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
  await waitText(page, /No Drills Yet/)
  check(/No Drills Yet/.test(await text(page)), 'new account lands on My drills with a designed empty state')
  await shot(page, 'drills-empty')
  check(await hasFooter(page), 'My drills has the footer')
  await noSideways(page, 'My drills, desktop')

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
  const railLast = await page.evaluate(() => document.querySelector('nav[aria-label="Sections"]').lastElementChild.innerText)
  check(/E2E/.test(railLast), 'the account name sits at the very bottom of the side rail')
  check(await page.evaluate(() => { const f = document.querySelector('footer'); return !!f && getComputedStyle(f).display !== 'none' }), 'the dashboard has its compact footer')
  // the account menu opens beside the rail, whole, without clipping or pushing the rail sideways — also in a short window
  for (const h of [800, 600]) {
    await page.setViewport({ width: 1366, height: h })
    await sleep(500)
    await clickText(page, 'nav[aria-label="Sections"] button', /E2E/)
    await sleep(500)
    const geo = await page.evaluate(() => {
      const nav = document.querySelector('nav[aria-label="Sections"]'); const menu = document.querySelector('[role="menu"]')
      const trigger = nav.lastElementChild.querySelector('button'); const m = menu?.getBoundingClientRect(); const r = trigger.getBoundingClientRect()
      const items = [...(menu?.querySelectorAll('[role="menuitem"]') ?? [])].map((i) => i.getBoundingClientRect())
      const top = menu ? document.elementFromPoint(m.x + m.width / 2, m.y + 20) : null
      return { open: !!menu, inView: !!m && m.x >= 0 && m.y >= 0 && m.right <= innerWidth && m.bottom <= innerHeight, railOk: r.x >= 0 && nav.scrollLeft === 0, onTop: !!top && menu.contains(top), items: items.length }
    })
    check(geo.open && geo.inView && geo.railOk && geo.onTop && geo.items >= 2, `the account menu opens whole and on top, beside the rail (window height ${h})`)
    await page.keyboard.press('Escape')
    await sleep(300)
  }
  await page.setViewport({ width: 1366, height: 800 })
  await sleep(500)
  for (const v of ['situation', 'orders', 'report', 'fleet', 'weather']) {
    await clickText(page, 'nav[aria-label="Sections"] button', new RegExp('^' + v, 'i'))
    await sleep(700)
    await noSideways(page, `dashboard ${v}, desktop`)
  }
  await clickText(page, 'nav[aria-label="Sections"] button', /^weather/i)
  await sleep(500)
  check(await page.evaluate(() => !!document.querySelector('section[aria-label="Weather"] li')), 'the Weather section lists the zones')
  await shot(page, 'view-weather')
  await clickText(page, 'nav[aria-label="Sections"] button', /^situation/i)
  await sleep(500)
  check(await page.evaluate(() => {
    const feed = document.getElementById('incident-feed'); const map = document.querySelector('.leaflet-container')
    return !!feed && !!map && feed.getBoundingClientRect().left < map.getBoundingClientRect().left
  }), 'the incident feed is on the left of the map')
  check(await page.evaluate(() => !document.querySelector('[aria-label^="Weather advisories"]')), 'no weather chips cover the situation map')

  // the six stat labels are written out in full (no "RANKING ACCURA…"): every label fits inside its tile, at every desktop width
  for (const w of [1024, 1280, 1366, 1920]) {
    await page.setViewport({ width: w, height: 800 })
    await sleep(500)
    const cut = await page.evaluate(() => [...document.querySelectorAll('[aria-label="Drill telemetry"] > div')].filter((tile) => {
      const label = tile.querySelector('span'); const cs = getComputedStyle(label)
      return label.scrollWidth > label.clientWidth + 1 || cs.textOverflow === 'ellipsis' || tile.scrollWidth > tile.clientWidth + 1
    }).map((tile) => tile.innerText.split(String.fromCharCode(10))[0]))
    check(cut.length === 0 && /Ranking Accuracy/i.test(await text(page)), `stat labels are written in full at ${w}px${cut.length ? ' — cut: ' + cut.join(', ') : ''}`)
  }
  await page.setViewport({ width: 1366, height: 800 })
  await sleep(500)

  // The map can be explored: zoom buttons, mouse wheel, double-click and dragging all work
  // the distance between the two farthest pins on screen doubles with every zoom level
  const zoomOf = () => page.evaluate(() => {
    const pts = [...document.querySelectorAll('.ms-pin')].map((e) => { const r = e.getBoundingClientRect(); return [r.x, r.y] })
    let best = 0
    for (const a of pts) for (const b of pts) best = Math.max(best, Math.hypot(a[0] - b[0], a[1] - b[1]))
    return best
  })
  const panOf = () => page.evaluate(() => document.querySelector('.leaflet-map-pane').style.transform)
  const box = await page.evaluate(() => { const r = document.querySelector('.leaflet-container').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })
  const z0 = await zoomOf()
  await clickText(page, 'button', /zoom in/)
  await sleep(1200)
  const z1 = await zoomOf()
  check(z1 > z0 * 1.6, `the Zoom In button zooms the map (pins ${Math.round(z0)} px apart → ${Math.round(z1)} px)`)
  await clickText(page, 'button', /zoom out/)
  await sleep(1200)
  check(Math.abs((await zoomOf()) - z0) < z0 * 0.1, 'the Zoom Out button zooms back')
  await page.mouse.move(box.x, box.y)
  await page.mouse.wheel({ deltaY: -400 })
  await sleep(1500)
  check((await zoomOf()) > z0 * 1.3, 'the mouse wheel zooms the map')
  const pan0 = await panOf()
  await page.mouse.move(box.x, box.y)
  await page.mouse.down()
  await page.mouse.move(box.x - 140, box.y - 60, { steps: 8 })
  await page.mouse.up()
  await sleep(600)
  check((await panOf()) !== pan0, 'dragging pans the map')
  await clickText(page, 'button', /show all incidents/)
  await sleep(1500)
  check(await page.evaluate(() => { const c = document.querySelector('.leaflet-container').getBoundingClientRect(); return [...document.querySelectorAll('.ms-pin')].every((e) => { const r = e.getBoundingClientRect(); return r.x >= c.x && r.right <= c.right && r.y >= c.y && r.bottom <= c.bottom }) }), 'Show All Incidents frames every incident')
  await clickText(page, 'button', /re-center map/)
  await sleep(1800)
  const pinAt = () => page.evaluate(() => { const r = document.querySelector('.ms-pin').getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y)] })
  const home = await pinAt()
  await page.mouse.move(box.x + 200, box.y + 150)
  await page.mouse.down()
  await page.mouse.move(box.x - 150, box.y - 100, { steps: 10 })
  await page.mouse.up()
  await sleep(500)
  const away = await pinAt()
  await clickText(page, 'button', /re-center map/)
  await sleep(1800)
  const back = await pinAt()
  check(Math.hypot(away[0] - home[0], away[1] - home[1]) > 100 && Math.hypot(back[0] - home[0], back[1] - home[1]) < 4, 'Re-Center Map brings the map back after exploring')
  check(!(await page.evaluate(() => !!document.querySelector('button[aria-label="Clear Selection"]'))), 'no Clear Selection button until something is selected')
  await page.evaluate(() => document.querySelector('#incident-feed button[aria-pressed]')?.click())
  await sleep(1200)
  const shown = await page.evaluate(() => !!document.querySelector('button[aria-label="Clear Selection"]'))
  await clickText(page, 'button', /clear selection/)
  await sleep(500)
  check(shown && !(await page.evaluate(() => !!document.querySelector('button[aria-label="Clear Selection"]'))), 'selecting an incident shows Clear Selection, and it clears it')
  await clickText(page, 'button', /re-center map/)
  await sleep(1500)

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

  // the map's own toggles each do what they say (the Fleet section shows the map beside the units)
  const mapCount = () => page.evaluate(() => {
    const paths = [...document.querySelectorAll('.leaflet-overlay-pane path')]
    return {
      sectors: document.querySelectorAll('.sector-label').length,
      routes: paths.filter((p) => p.getAttribute('stroke-dasharray') === '4 7').length,
      dots: paths.filter((p) => p.getAttribute('stroke-dasharray') === null && p.getAttribute('fill') !== 'none' && p.getAttribute('stroke') !== '#94A3B8').length,
    }
  })
  const flip = async (label) => { await clickText(page, 'button', label); await sleep(500); return mapCount() }
  const m0 = await mapCount()
  check(m0.sectors > 0 && m0.routes > 0 && m0.dots > 0, 'the map starts with sector names, unit routes and unit dots')
  let m = await flip(/toggle sector boundaries/)
  check(m.sectors === 0 && m.routes === m0.routes, 'Toggle Sector Boundaries hides the sectors and nothing else')
  m = await flip(/toggle sector boundaries/)
  check(m.sectors === m0.sectors, '…and shows them again')
  m = await flip(/toggle unit routes/)
  check(m.routes === 0 && m.dots === m0.dots, 'Toggle Unit Routes hides the routes and keeps the units')
  m = await flip(/toggle unit routes/)
  check(m.routes === m0.routes, '…and shows them again')
  await clickText(page, 'header button', /^menu$/)
  await clickText(page, '[role="menuitemcheckbox"], [role="menuitem"]', /show units on the map/)
  await sleep(500)
  m = await mapCount()
  check(m.dots === 0 && m.routes === m0.routes, 'Show Units on the Map (menu) hides the unit dots but keeps their routes')
  await clickText(page, 'header button', /^menu$/)
  await clickText(page, '[role="menuitemcheckbox"], [role="menuitem"]', /show units on the map/)
  await sleep(500)
  check((await mapCount()).dots === m0.dots, '…and shows them again')
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
  await waitText(phone, /My Drills/)
  await shot(phone, 'mobile-drills')
  check(await hasFooter(phone), 'the footer shows on a phone too')
  check(await phone.evaluate(() => { const m = document.querySelector('main').getBoundingClientRect(); const f = document.querySelector('footer').getBoundingClientRect(); return m.bottom <= f.top + 1 }), 'the footer never covers page content')
  await noSideways(phone, 'My drills, 375 px')
  await clickText(phone, 'a', /review|open/)
  await waitText(phone, /LIVE/, 60000)
  await sleep(2500)
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth > innerWidth)
  check(!overflow, 'no horizontal scroll at 375px')
  const headerFits = await phone.evaluate(() => [...document.querySelectorAll('header button, header a')].every((el) => el.getBoundingClientRect().right <= innerWidth + 1))
  check(headerFits, 'every header control is on screen at 375px')
  await shot(phone, 'mobile')
  for (const tab of ['map', 'incidents', 'orders', 'report', 'units', 'weather']) {
    await clickText(phone, 'nav[aria-label="Sections"] button', new RegExp(tab, 'i'))
    await sleep(600)
    await noSideways(phone, `dashboard ${tab} tab, 375 px`)
  }
  await clickText(phone, 'nav[aria-label="Sections"] button', /incidents/i)
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
  await waitText(page, /My Drills/)
  await clickText(page, 'button', /E2E/)
  await clickText(page, '[role="menuitem"]', /sign out/)
  await waitText(page, /Sign In/)
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
