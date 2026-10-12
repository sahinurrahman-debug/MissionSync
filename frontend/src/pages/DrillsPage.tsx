import { useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, Check, Loader2, Moon, Pencil, Plus, Sun, Trash2, X } from 'lucide-react'
import ActionToast, { type ToastMessage } from '../components/ActionToast'
import AccountMenu from '../components/AccountMenu'
import ConfirmDialog from '../components/ConfirmDialog'
import EmptyRadar from '../components/EmptyRadar'
import FormField from '../components/FormField'
import { useDrills, messageOf, type Item } from '../hooks/useDrills'
import { useTheme } from '../lib/useTheme'
import { ApiError } from '../types'

const STATUS: Record<Item['status'], { label: string; cls: string }> = {
  new: { label: 'Not started', cls: 'border-line text-ink-2' },
  live: { label: 'In progress', cls: 'border-ok/50 bg-ok/10 text-ok' },
  ended: { label: 'Ended', cls: 'border-line bg-hi text-ink-2' },
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—')

function DrillCard({ d, onRename, onDelete }: { d: Item; onRename: (id: number, name: string) => Promise<void>; onDelete: (d: Item) => void }) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(d.name)
  const [error, setError] = useState('')
  const st = STATUS[d.status]

  const save = async (ev: FormEvent) => {
    ev.preventDefault()
    if (!name.trim()) return setError('Give the drill a name.')
    if (name.trim() === d.name) return setEditing(false)
    setError('')
    setEditing(false)                                                  // optimistic: the new name shows immediately
    try {
      await onRename(d.id, name)
    } catch (e) {
      setName(d.name)
      setError(messageOf(e))
    }
  }

  return (
    <li className={`flex flex-col rounded-lg border border-line bg-panel p-4 transition-opacity ${d.pending ? 'opacity-70' : ''}`} aria-busy={d.pending}>
      <div className="flex items-start gap-2">
        {editing ? (
          <form onSubmit={save} className="flex min-w-0 flex-1 items-center gap-1.5">
            <label className="sr-only" htmlFor={`rename-${d.id}`}>New name for {d.name}</label>
            <input
              id={`rename-${d.id}`} autoFocus value={name} maxLength={80} onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') { setName(d.name); setEditing(false) } }}
              className="h-11 min-w-0 flex-1 rounded-md border border-accent bg-bg px-2 text-base font-bold text-ink outline-none"
            />
            <button type="submit" aria-label="Save name" className="inline-flex h-11 w-11 items-center justify-center rounded-md bg-accent text-bg"><Check size={18} aria-hidden /></button>
            <button type="button" aria-label="Cancel rename" onClick={() => { setName(d.name); setEditing(false) }} className="inline-flex h-11 w-11 items-center justify-center rounded-md border border-line text-ink-2"><X size={18} aria-hidden /></button>
          </form>
        ) : (
          <>
            <h3 className="min-w-0 flex-1 break-words text-lg font-bold leading-snug text-ink">{d.name}</h3>
            <button type="button" aria-label={`Rename ${d.name}`} disabled={d.pending} onClick={() => setEditing(true)} className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-ink-2 hover:bg-hi hover:text-ink disabled:opacity-40"><Pencil size={18} aria-hidden /></button>
          </>
        )}
      </div>
      {error && <p role="alert" className="mt-1 text-sm font-semibold text-p1">{error}</p>}
      {d.notes && <p className="mt-1 line-clamp-2 text-base text-ink-2">{d.notes}</p>}
      <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-base text-ink-2">
        <span className={`rounded border px-1.5 text-sm font-semibold ${st.cls}`}>{st.label}</span>
        <span>{d.reports} {d.reports === 1 ? 'report' : 'reports'}</span>
        <span>Created {when(d.created_at)}</span>
      </p>
      <div className="mt-4 flex items-center gap-2">
        {d.pending ? (
          <span className="inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-md border border-line text-base font-semibold text-ink-2"><Loader2 size={16} className="animate-spin" aria-hidden />Creating…</span>
        ) : (
          <Link to={`/drills/${d.id}`} className="inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-md bg-accent text-base font-bold text-bg hover:brightness-110">
            {d.status === 'ended' ? 'Review' : 'Open'} <ArrowRight size={16} aria-hidden />
          </Link>
        )}
        <button type="button" aria-label={`Delete ${d.name}`} disabled={d.pending} onClick={() => onDelete(d)} className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md border border-line text-ink-2 hover:border-p1 hover:text-p1 disabled:opacity-40"><Trash2 size={18} aria-hidden /></button>
      </div>
    </li>
  )
}

export default function DrillsPage() {
  const { theme, toggle } = useTheme()
  const { items, limit, loadError, reload, create, rename, remove } = useDrills()
  const [name, setName] = useState('')
  const [notes, setNotes] = useState('')
  const [nameError, setNameError] = useState('')
  const [creating, setCreating] = useState(false)
  const [toDelete, setToDelete] = useState<Item | null>(null)
  const [toast, setToast] = useState<ToastMessage | null>(null)
  const toastId = useRef(0)

  const say = (tone: ToastMessage['tone'], text: string) => { toastId.current += 1; setToast({ id: toastId.current, tone, text }) }

  const submit = async (ev: FormEvent) => {
    ev.preventDefault()
    if (!name.trim()) return setNameError('Give the drill a name.')
    setNameError('')
    setCreating(true)
    const keep = { name, notes }
    setName(''); setNotes('')                                          // optimistic: the form clears and the card appears
    try {
      await create(keep.name, keep.notes)
      say('ok', 'Drill created. Press Open to start.')
    } catch (e) {
      setName(keep.name); setNotes(keep.notes)                         // roll back the form so nothing typed is lost
      if (e instanceof ApiError && e.fields.name) setNameError(e.fields.name)
      else say('error', messageOf(e))
    } finally {
      setCreating(false)
    }
  }

  const confirmDelete = async () => {
    const d = toDelete
    setToDelete(null)
    if (!d) return
    try {
      await remove(d.id)
      say('ok', `“${d.name}” was deleted.`)
    } catch (e) {
      say('error', `${messageOf(e)} “${d.name}” was put back.`)
    }
  }

  const count = items?.length ?? 0
  return (
    <div className="min-h-dvh bg-bg text-ink">
      <header className="flex h-14 items-center gap-3 border-b border-line bg-panel px-3 lg:px-4">
        <h1 className="text-lg font-extrabold tracking-tight">Mission<span className="text-accent">Sync</span></h1>
        <div className="ml-auto flex items-center gap-2">
          <AccountMenu />
          <button type="button" onClick={toggle} aria-label="Toggle color theme" className="inline-flex h-11 w-11 items-center justify-center rounded-md border border-line bg-hi text-ink-2 hover:border-accent hover:text-accent">
            {theme === 'dark' ? <Sun size={18} aria-hidden /> : <Moon size={18} aria-hidden />}
          </button>
        </div>
      </header>

      <main id="main" className="mx-auto w-full max-w-5xl px-4 py-6">
        <h2 className="text-2xl font-extrabold">My drills</h2>
        <p className="mt-1 text-base text-ink-2">Each drill is a private practice exercise. Create one, open it, type radio reports and approve the dispatches the AI suggests.</p>

        <form onSubmit={submit} noValidate className="mt-5 rounded-lg border border-line bg-panel p-4" aria-label="Create a drill">
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-start">
            <FormField label="Drill name" value={name} onChange={(e) => setName(e.target.value)} error={nameError} placeholder="e.g. Saturday campus drill" maxLength={80} />
            <FormField label="Notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Who is taking part, what to practise…" maxLength={500} />
            <button type="submit" disabled={creating || count >= limit} className="mt-0 inline-flex h-12 items-center justify-center gap-2 rounded-md bg-accent px-4 text-base font-bold text-bg hover:brightness-110 disabled:opacity-50 sm:mt-7">
              {creating ? <Loader2 size={18} className="animate-spin" aria-hidden /> : <Plus size={18} aria-hidden />} New drill
            </button>
          </div>
          {count >= limit && <p className="mt-2 text-sm text-ink-2">You have {limit} drills, the most one account can keep. Delete one to make room.</p>}
        </form>

        <section aria-label="Your drills" className="mt-6">
          {items === null ? (
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-busy="true" aria-label="Loading your drills">
              {[0, 1, 2].map((i) => <li key={i} className="h-44 animate-pulse rounded-lg border border-line bg-panel" />)}
            </ul>
          ) : loadError ? (
            <div role="alert" className="rounded-lg border border-p1/50 bg-panel p-4">
              <p className="text-base text-ink">{loadError}</p>
              <button type="button" onClick={() => void reload()} className="mt-2 h-11 rounded-md border border-line bg-hi px-4 text-base font-semibold hover:border-accent">Try again</button>
            </div>
          ) : count === 0 ? (
            <div className="rounded-lg border border-dashed border-line bg-panel">
              <EmptyRadar title="No drills yet." hint="Name your first drill above and press New drill. Not ready? Try the no-account demo." />
              <p className="pb-4 text-center"><Link to="/demo" className="text-base font-semibold text-accent underline underline-offset-4">Open the demo</Link></p>
            </div>
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {items.map((d) => <DrillCard key={d.id} d={d} onRename={rename} onDelete={setToDelete} />)}
            </ul>
          )}
        </section>
      </main>

      <ActionToast toast={toast} onDismiss={() => setToast(null)} />
      {toDelete && (
        <ConfirmDialog
          title={`Delete “${toDelete.name}”?`}
          body="Its incidents, reports and audit log are removed for good. This cannot be undone."
          confirmLabel="Delete drill"
          danger
          onConfirm={() => void confirmDelete()}
          onCancel={() => setToDelete(null)}
        />
      )}
    </div>
  )
}
