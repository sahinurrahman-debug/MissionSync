import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Menu } from 'lucide-react'

export interface MenuItem {
  id: string
  label: string
  hint?: string
  icon: ReactNode
  onSelect?: () => void
  href?: string
  danger?: boolean
  /** Renders as a switch: the current state is announced and shown. */
  pressed?: boolean
  disabled?: boolean
  /** Extra classes, e.g. `sm:hidden` for an item that only makes sense on phones. */
  className?: string
}

/** Every drill-level action in one labelled menu (replaces a row of cryptic icon buttons). */
export default function DrillMenu({
  items, header, label = 'Menu', icon, menuLabel = 'Drill menu', align = 'right',
}: { items: MenuItem[]; header?: ReactNode; label?: string; icon?: ReactNode; menuLabel?: string; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menuId = useId()

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('touchstart', onDown)
    root.current?.querySelector<HTMLElement>('[role^="menuitem"]:not([disabled])')?.focus()
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('touchstart', onDown)
    }
  }, [open])

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { setOpen(false); trigger.current?.focus(); return }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return
    const els = [...(root.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([disabled])') ?? [])]
    if (els.length === 0) return
    e.preventDefault()
    const i = els.indexOf(document.activeElement as HTMLElement)
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? els.length - 1 : e.key === 'ArrowDown' ? (i + 1) % els.length : (i - 1 + els.length) % els.length
    els[next].focus()
  }

  const rowCls = (danger?: boolean, extra = '') =>
    `${extra} flex min-h-[48px] w-full items-center gap-3 rounded-md px-3 py-2 text-left text-base transition-colors hover:bg-hi focus-visible:bg-hi disabled:cursor-not-allowed disabled:opacity-40 ${danger ? 'text-p1' : 'text-ink'}`

  return (
    <div ref={root} className="relative" onKeyDown={onKey}>
      <button
        ref={trigger}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-11 min-w-[44px] items-center justify-center gap-2 rounded-md border border-line bg-hi px-3 text-base font-semibold text-ink transition-colors hover:border-accent aria-expanded:border-accent"
      >
        {icon ?? <Menu size={18} aria-hidden />}
        <span className="max-sm:sr-only">{label}</span>
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label={menuLabel}
          className={`fixed inset-x-2 top-14 z-[1800] max-h-[calc(100dvh-4.5rem)] overflow-y-auto rounded-lg border border-line bg-panel p-1.5 shadow-panel sm:absolute sm:inset-x-auto ${align === 'right' ? 'sm:right-0' : 'sm:left-0'} sm:top-full sm:mt-1.5 sm:w-80`}
        >
          {header && <div className="border-b border-line px-3 pb-2 pt-1.5 text-sm text-ink-2">{header}</div>}
          {items.map((it) => {
            const inner = (
              <>
                <span className="shrink-0 text-ink-2" aria-hidden>{it.icon}</span>
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold">{it.label}</span>
                  {it.hint && <span className="block text-sm text-ink-2">{it.hint}</span>}
                </span>
                {it.pressed !== undefined && (
                  <span className={`shrink-0 rounded-full border px-2 py-0.5 font-mono text-sm font-bold ${it.pressed ? 'border-accent/60 bg-accent/15 text-accent' : 'border-line text-ink-2'}`} aria-hidden>
                    {it.pressed ? 'ON' : 'OFF'}
                  </span>
                )}
              </>
            )
            return it.href && !it.disabled ? (
              <a key={it.id} role="menuitem" href={it.href} download className={rowCls(it.danger, it.className)} onClick={() => setOpen(false)}>{inner}</a>
            ) : (
              <button
                key={it.id}
                type="button"
                role={it.pressed !== undefined ? 'menuitemcheckbox' : 'menuitem'}
                aria-checked={it.pressed}
                disabled={it.disabled}
                className={rowCls(it.danger, it.className)}
                onClick={() => { setOpen(false); it.onSelect?.() }}
              >
                {inner}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
