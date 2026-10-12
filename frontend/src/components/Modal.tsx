import { useEffect, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'

/** Accessible modal: focus moves in, Escape closes, Tab stays inside, focus returns to the opener. */
export default function Modal({
  title, describedBy, onClose, children, wide = false, initialFocus,
}: {
  title: string
  describedBy?: string
  onClose: () => void
  children: ReactNode
  wide?: boolean
  /** CSS selector inside the dialog to focus first (defaults to the first focusable control). */
  initialFocus?: string
}) {
  const box = useRef<HTMLDivElement>(null)
  const opener = useRef<Element | null>(null)
  const titleId = useRef(`modal-${Math.random().toString(36).slice(2, 8)}`).current

  useEffect(() => {
    opener.current = document.activeElement
    const target = (initialFocus && box.current?.querySelector<HTMLElement>(initialFocus)) || box.current?.querySelector<HTMLElement>('button, input, a[href]')
    target?.focus()
    return () => {
      if (opener.current instanceof HTMLElement) opener.current.focus()
    }
  }, [initialFocus])

  const trap = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.stopPropagation(); onClose(); return }
    if (e.key !== 'Tab' || !box.current) return
    const f = [...box.current.querySelectorAll<HTMLElement>('button, input, a[href], select, textarea')].filter((el) => !el.hasAttribute('disabled'))
    if (f.length === 0) return
    const first = f[0]
    const last = f[f.length - 1]
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
  }

  return (
    <div className="fixed inset-0 z-[2000] flex items-end justify-center bg-black/60 p-3 sm:items-center sm:p-4" onKeyDown={trap} role="presentation">
      <div
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={describedBy}
        className={`max-h-[92dvh] w-full overflow-y-auto rounded-lg border border-line bg-panel p-4 shadow-panel ${wide ? 'max-w-lg' : 'max-w-sm'}`}
      >
        <div className="flex items-start gap-2">
          <h2 id={titleId} className="min-w-0 flex-1 text-lg font-bold text-ink">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded text-ink-2 hover:text-ink sm:h-9 sm:w-9">
            <X size={18} aria-hidden />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}
