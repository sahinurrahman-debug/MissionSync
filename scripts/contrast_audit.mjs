// WCAG 2.1 contrast audit of every text/background token pair in both themes.
// Run: node scripts/contrast_audit.mjs   (exits 1 if any pair is below 4.5:1)
import fs from 'node:fs'
const css = fs.readFileSync(new URL('../frontend/src/index.css', import.meta.url), 'utf8')
const darkStart = css.indexOf("[data-theme='dark'] {")
const lightStart = css.indexOf("[data-theme='light'] {")
const parse = (b) => Object.fromEntries([...b.matchAll(/--([\w-]+):\s*(\d+)\s+(\d+)\s+(\d+)/g)].map((m) => [m[1], [+m[2], +m[3], +m[4]]]))
const themes = { dark: parse(css.slice(darkStart, lightStart)), light: parse(css.slice(lightStart, css.indexOf('html { font-size')) ) }
const lum = ([r, g, b]) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b) }
const mix = (fg, bg, a) => fg.map((c, i) => Math.round(c * a + bg[i] * (1 - a)))
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }
const pairs = (t) => [
  ['ink on panel', t.ink, t.panel], ['ink on bg', t.ink, t.bg], ['ink on panel-hi', t.ink, t['panel-hi']],
  ['ink-2 on panel', t['ink-2'], t.panel], ['ink-2 on bg', t['ink-2'], t.bg], ['ink-2 on panel-hi', t['ink-2'], t['panel-hi']],
  ['accent on panel', t.accent, t.panel], ['accent on accent/15 chip', t.accent, mix(t.accent, t.panel, 0.15)],
  ['bg on accent button', t.bg, t.accent],
  ['p1 text on panel', t.p1, t.panel], ['p2 text on panel', t.p2, t.panel], ['p3 text on panel', t.p3, t.panel],
  ['ok text on panel', t.ok, t.panel], ['route text on panel', t.route, t.panel], ['scene text on panel', t.scene, t.panel], ['warn text on panel', t.warn, t.panel],
  ['ok on ok/15 status chip', t.ok, mix(t.ok, t.panel, 0.15)], ['route on route/15', t.route, mix(t.route, t.panel, 0.15)], ['scene on scene/15', t.scene, mix(t.scene, t.panel, 0.15)],
  ['warn text on warn/10 chip', t.warn, mix(t.warn, t.panel, 0.1)],
  ['ink on warn/10 banner', t.ink, mix(t.warn, t.bg, 0.1)],
  ['on-tier on P1 pill', t['on-tier'], t.p1], ['on-tier on P2 pill', t['on-tier'], t.p2], ['on-tier on P3 pill', t['on-tier'], t.p3], ['white on P4 pill', [255,255,255], t.p4],
]
let fails = 0
for (const [name, t] of Object.entries(themes)) {
  console.log(`\n== ${name} ==`)
  for (const [label, fg, bg] of pairs(t)) {
    const r = ratio(fg, bg)
    const ok = r >= 4.5
    if (!ok) fails++
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${r.toFixed(2).padStart(5)}:1  ${label}`)
  }
}
console.log(`\n${fails} failing pair(s)`)
if (fails > 0) process.exit(1)
