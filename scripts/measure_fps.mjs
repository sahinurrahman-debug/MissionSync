// Measures real frame pacing while the dashboard is being used (section switches, scrolling the
// feed, approving every dispatch, selecting incidents) in headless Edge/Chrome.
//
//   (backend running and serving the built dashboard)  cd frontend && npm run build
//   node scripts/measure_fps.mjs [base-url]       # needs puppeteer-core (npm i -D puppeteer-core); signs in through /demo
//
// Reports average fps, the 95th/99th-percentile frame time and the share of frames slower than
// 16.7 ms (60 fps) and 33 ms (30 fps). Headless runs use software rasterisation, so a real GPU is faster.
import puppeteer from 'puppeteer-core'

const BASE = process.argv[2] ?? 'http://127.0.0.1:8000'
const EXE = process.env.CHROME_PATH ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'

const browser = await puppeteer.launch({ executablePath: EXE, headless: 'new', args: ['--no-sandbox', '--window-size=1366,768'], defaultViewport: { width: 1366, height: 768 } })
const page = await browser.newPage()
await page.evaluateOnNewDocument(() => { try { localStorage.setItem('ms-guide-seen', '1') } catch { /* ignore */ } })
await page.goto(`${BASE}/demo`, { waitUntil: 'networkidle2', timeout: 60000 })     // one click: a temporary guest with its own drill
await page.waitForFunction(() => /waiting for you/.test(document.body.innerText), { timeout: 90000, polling: 200 })
await new Promise((r) => setTimeout(r, 2500))

await page.evaluate(() => {
  window.__frames = []
  let last = performance.now()
  const tick = (t) => { window.__frames.push(t - last); last = t; window.__raf = requestAnimationFrame(tick) }
  window.__raf = requestAnimationFrame(tick)
})

const click = (sel) => page.evaluate((s) => { const el = [...document.querySelectorAll('button')].find((b) => new RegExp(s, 'i').test(b.getAttribute('aria-label') || b.textContent)); el?.click() }, sel)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const script = ['^Orders', 'Approve all', '^Report', '^Fleet', '^Situation']
for (let round = 0; round < 3; round++) {
  for (const s of script) { await click(s); await wait(900) }
  // scroll the ranked feed and select a few incidents (re-rank + map pan animations)
  await page.evaluate(async () => {
    const feed = document.querySelector('#incident-feed ul, #incident-feed [class*=overflow-y-auto]') ?? document.querySelector('#incident-feed')
    for (let i = 0; i < 20; i++) { feed?.scrollBy(0, 60); await new Promise((r) => setTimeout(r, 40)) }
    for (const b of [...document.querySelectorAll('#incident-feed button[aria-pressed]')].slice(0, 3)) { b.click(); await new Promise((r) => setTimeout(r, 500)) }
  })
}

const frames = await page.evaluate(() => { cancelAnimationFrame(window.__raf); return window.__frames.slice(1) })
await browser.close()

const sorted = [...frames].sort((a, b) => a - b)
const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
const total = frames.reduce((a, b) => a + b, 0)
const over = (ms) => (100 * frames.filter((f) => f > ms).length / frames.length).toFixed(1)
console.log(`frames: ${frames.length} over ${(total / 1000).toFixed(1)} s`)
console.log(`average: ${(1000 * frames.length / total).toFixed(1)} fps`)
console.log(`frame time p50 ${pct(0.5).toFixed(1)} ms · p95 ${pct(0.95).toFixed(1)} ms · p99 ${pct(0.99).toFixed(1)} ms · worst ${sorted.at(-1).toFixed(1)} ms`)
console.log(`slower than 16.7 ms (below 60 fps): ${over(16.8)}%   slower than 33.4 ms (below 30 fps): ${over(33.4)}%`)
