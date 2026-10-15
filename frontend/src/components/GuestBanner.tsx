import { Link } from 'react-router-dom'
import { Clock } from 'lucide-react'
import { useCurrentUser } from '../auth/AuthContext'

/** Shown on a temporary demo account: says plainly that it is temporary and how to keep your work. */
export default function GuestBanner() {
  const user = useCurrentUser()
  if (!user?.is_guest) return null
  return (
    <div role="note" className="flex shrink-0 items-center gap-3 border-b border-line bg-hi px-3 py-1.5 text-base text-ink lg:px-4">
      <Clock size={18} className="shrink-0 text-ink-2" aria-hidden />
      <span className="min-w-0 flex-1 leading-snug">
        <b>Temporary demo account.</b>
        <span className="max-sm:sr-only"> It and its drills are deleted after 24 hours.</span>
      </span>
      <Link to="/signup" className="inline-flex h-11 shrink-0 items-center rounded-md border border-accent/60 px-3 text-base font-bold text-accent hover:bg-accent/10 sm:h-9">Create an account</Link>
    </div>
  )
}
