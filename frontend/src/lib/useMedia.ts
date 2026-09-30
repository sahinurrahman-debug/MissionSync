import { useEffect, useState } from 'react'

/** Subscribes to a CSS media query. Used to mount exactly ONE layout tree (and one map).
 *  Listens to both the query's `change` event and window `resize`, because some embedded
 *  webviews and device emulators resize the viewport without firing `change`. */
export function useMedia(query: string): boolean {
  const get = () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : true)
  const [matches, setMatches] = useState(get)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia(query)
    const on = () => setMatches(window.matchMedia(query).matches)
    on()
    mq.addEventListener('change', on)
    window.addEventListener('resize', on)
    return () => {
      mq.removeEventListener('change', on)
      window.removeEventListener('resize', on)
    }
  }, [query])
  return matches
}
