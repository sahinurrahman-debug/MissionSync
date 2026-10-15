import { describe, expect, it } from 'vitest'
import indexHtml from '../index.html?raw'

/** The server sends `script-src 'self'`: an inline <script> in the page would be silently refused by browsers. */
describe('index.html under the Content-Security-Policy', () => {
  it('has no inline scripts', () => {
    const inline = [...indexHtml.matchAll(/<script\b([^>]*)>/g)].filter((m) => !/\bsrc=/.test(m[1]))
    expect(inline).toEqual([])
  })

  it('restores the theme from an external file before the app loads', () => {
    expect(indexHtml).toContain('<script src="/theme-init.js"></script>')
    expect(indexHtml.indexOf('theme-init.js')).toBeLessThan(indexHtml.indexOf('/src/main.tsx'))
  })
})
