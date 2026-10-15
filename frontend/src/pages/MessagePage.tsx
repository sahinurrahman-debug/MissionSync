import { Link } from 'react-router-dom'
import { SearchX } from 'lucide-react'
import PageShell from '../components/PageShell'
import { useTheme } from '../lib/useTheme'

/** A friendly full-page message (not found, could not load) with one clear way forward. */
export default function MessagePage({ title, body, action }: { title: string; body: string; action: { to: string; label: string; reload?: boolean } }) {
  useTheme()
  return (
    <PageShell center>
      <main id="main" className="m-4 w-full max-w-md rounded-lg border border-line bg-panel p-6 text-center shadow-panel">
        <SearchX size={32} className="mx-auto text-accent" aria-hidden />
        <h1 className="mt-3 text-xl font-bold">{title}</h1>
        <p className="mt-1 text-base text-ink-2">{body}</p>
        <Link
          to={action.to}
          onClick={action.reload ? () => window.location.reload() : undefined}
          className="mt-4 inline-flex h-12 items-center justify-center rounded-md bg-accent px-5 text-base font-bold text-bg hover:brightness-110"
        >
          {action.label}
        </Link>
      </main>
    </PageShell>
  )
}
