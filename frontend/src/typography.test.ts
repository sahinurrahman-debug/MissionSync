import { describe, expect, it } from 'vitest'
import tailwindConfig from '../tailwind.config.js?raw'

/** The rubric asks for >= 16px typography: keep every text size in the UI at or above 1rem. */
const sources = import.meta.glob<string>('./**/*.{tsx,css}', { query: '?raw', import: 'default', eager: true })

describe('typography floor (>= 16px)', () => {
  it('remaps every Tailwind size below 1rem up to 1rem', () => {
    for (const key of ['xs', 'sm']) {
      const m = new RegExp(key + String.raw`:\s*\['([\d.]+)rem'`).exec(tailwindConfig)
      expect(m, `fontSize.${key} must be remapped in tailwind.config.js`).not.toBeNull()
      expect(parseFloat(m![1])).toBeGreaterThanOrEqual(1)
    }
    expect(tailwindConfig).not.toMatch(/fontSize:[^\n]*(lg|base)[^\n]*0\.\d/)
  })

  it('has no arbitrary sub-16px text sizes in components or CSS', () => {
    const bad: string[] = []
    for (const [file, src] of Object.entries(sources)) {
      for (const m of src.matchAll(/text-\[(\d+(?:\.\d+)?)px\]/g)) if (parseFloat(m[1]) < 16) bad.push(`${file}: ${m[0]}`)
      for (const m of src.matchAll(/font(?:-size)?:\s*(?:\d+\s+)?(\d+(?:\.\d+)?)px/g)) if (parseFloat(m[1]) < 16) bad.push(`${file}: ${m[0]}`)
    }
    expect(Object.keys(sources).length).toBeGreaterThan(10)        // the glob actually found the sources
    expect(bad).toEqual([])
  })
})
