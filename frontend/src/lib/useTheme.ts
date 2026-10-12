import { useEffect, useState } from 'react'

export type Theme = 'dark' | 'light'

/** Dark by default; ?theme=light wins (handy for screenshots), then the saved choice. Applied to <html> as data-theme. */
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => {
    const qs = new URLSearchParams(window.location.search).get('theme')
    if (qs === 'light' || qs === 'dark') return qs
    try {
      const saved = localStorage.getItem('ms-theme')
      return saved === 'light' || saved === 'dark' ? saved : 'dark'
    } catch {
      return 'dark'
    }
  })
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try {
      localStorage.setItem('ms-theme', theme)
    } catch {
      /* storage blocked: the theme still applies for this visit */
    }
  }, [theme])
  return { theme, toggle: () => setTheme((t) => (t === 'dark' ? 'light' : 'dark')) }
}
