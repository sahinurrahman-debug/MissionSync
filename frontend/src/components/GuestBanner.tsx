import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Clock, X } from 'lucide-react'
import { useCurrentUser } from '../auth/AuthContext'

const KEY = 'ms-guest-note-hidden'

function hidden(): boolean {
  try {
    return sessionStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

/** Shown on a temporary demo account: says plainly that it is temporary and how to keep your work.
 *  It can be dismissed for the rest of the visit, so it never costs a phone screen its room. */
export default function GuestBanner() {
  const user = useCurrentUser()
  const [gone, setGone] = useState(hidden)
  if (!user?.is_guest || gone) return null
  const close = () => {
    setGone(true)
    try {
      sessionStorage.setItem(KEY, '1')
    } catch {
      /* the banner just returns on the next page load */
    }
  }
  return (
    <div role="note" className="flex shrink-0 items-center gap-3 rounded-lg border border-line bg-panel px-3 py-1.5 text-base text-ink shadow-panel">
      <Clock size={18} className="shrink-0 text-ink-2" aria-hidden />
      <span className="min-w-0 flex-1 leading-snug">
        <b>Temporary Demo Account.</b>
        <span className="max-sm:sr-only"> It and its drills are deleted after 24 hours.</span>
      </span>
      <Link to="/signup" className="inline-flex h-11 shrink-0 items-center rounded-md border border-accent/60 px-3 text-base font-bold text-accent hover:bg-accent/10 sm:h-10">Create an Account</Link>
      <button type="button" onClick={close} aria-label="Hide This Notice" className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-ink-2 hover:text-ink sm:h-10 sm:w-10">
        <X size={18} aria-hidden />
      </button>
    </div>
  )
}
