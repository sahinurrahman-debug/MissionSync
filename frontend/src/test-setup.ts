// jsdom has no layout engine; give components the browser APIs they expect.
import { afterEach } from 'vitest'

if (typeof window !== 'undefined') {
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia
  }
  class RO {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= RO
  Element.prototype.scrollIntoView ??= function scrollIntoView() {}
  HTMLElement.prototype.focus = HTMLElement.prototype.focus
}

afterEach(async () => {
  if (typeof document === 'undefined') return
  const { cleanup } = await import('@testing-library/react')
  cleanup()
})

// Pages are code-split, so the first render of a route is asynchronous; under a busy CI runner that can take longer than
// Testing Library's 1 s default. A generous ceiling costs nothing when things are fast.
if (typeof document !== 'undefined') {
  void import('@testing-library/dom').then(({ configure }) => configure({ asyncUtilTimeout: 10000 }))
}
