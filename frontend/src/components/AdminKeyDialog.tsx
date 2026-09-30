import { useEffect, useRef, useState } from 'react'
import { KeyRound, X } from 'lucide-react'

/** Asks for the admin key when a protected action (restart, end drill, dispatch mode) is refused.
 *  Modal: focus moves in, Escape closes, Tab stays inside, focus returns to where it came from. */
export default function AdminKeyDialog({
  action, rejected, onSubmit, onCancel,
}: { action: string; rejected: boolean; onSubmit: (key: string) => void; onCancel: () => void }) {
  const [key, setKey] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const opener = useRef<Element | null>(null)

  useEffect(() => {
    opener.current = document.activeElement
    input.current?.focus()
    return () => {
      if (opener.current instanceof HTMLElement) opener.current.focus()
    }
  }, [])

  const trap = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.stopPropagation(); onCancel(); return }
    if (e.key !== 'Tab' || !box.current) return
    const f = [...box.current.querySelectorAll<HTMLElement>('button, input')].filter((el) => !el.hasAttribute('disabled'))
    if (f.length === 0) return
    const first = f[0]
    const last = f[f.length - 1]
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
  }

  return (
    <div className="fixed inset-0 z-[2000] flex items-center justify-center bg-black/60 p-4" onKeyDown={trap} role="presentation">
      <div
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-labelledby="admin-title"
        aria-describedby="admin-desc"
        className="w-full max-w-sm rounded-lg border border-line bg-panel p-4 shadow-panel"
      >
        <div className="flex items-start gap-2">
          <KeyRound size={18} className="mt-0.5 text-accent" aria-hidden />
          <div className="min-w-0 flex-1">
            <h2 id="admin-title" className="text-base font-bold text-ink">Admin key required</h2>
            <p id="admin-desc" className="mt-0.5 text-sm text-ink-2">
              “{action}” affects everyone watching this drill, so the server asks for the admin key.
            </p>
          </div>
          <button type="button" onClick={onCancel} aria-label="Cancel" className="rounded p-1 text-ink-2 hover:text-ink"><X size={16} aria-hidden /></button>
        </div>
        <form
          className="mt-3 space-y-2"
          onSubmit={(e) => { e.preventDefault(); if (key.trim()) onSubmit(key.trim()) }}
        >
          <label htmlFor="admin-key" className="sr-only">Admin key</label>
          <input
            id="admin-key"
            ref={input}
            type="password"
            autoComplete="off"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="Admin key"
            className="h-10 w-full rounded-md border border-line bg-bg px-3 font-mono text-base text-ink outline-none focus:border-accent"
          />
          {rejected && <p role="alert" className="text-sm text-p1">That key was not accepted.</p>}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onCancel} className="h-10 rounded-md border border-line bg-hi px-3 text-sm font-semibold text-ink-2 hover:text-ink">Cancel</button>
            <button type="submit" disabled={!key.trim()} className="h-10 rounded-md bg-accent px-3 text-sm font-bold text-bg disabled:opacity-40">Confirm</button>
          </div>
        </form>
      </div>
    </div>
  )
}
