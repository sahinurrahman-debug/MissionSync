import { useEffect } from 'react'
import { CheckCircle2, TriangleAlert, X } from 'lucide-react'

export interface ToastMessage { id: number; tone: 'ok' | 'error'; text: string }

/** Result of a net-control action, announced politely to screen readers and auto-dismissed. */
export default function ActionToast({ toast, onDismiss }: { toast: ToastMessage | null; onDismiss: () => void }) {
  useEffect(() => {
    if (!toast) return
    const id = setTimeout(onDismiss, toast.tone === 'error' ? 8000 : 4000)
    return () => clearTimeout(id)
  }, [toast, onDismiss])

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-16 z-[1900] flex justify-center px-3 lg:bottom-4" aria-live="polite" role="status">
      {toast && (
        <div
          key={toast.id}
          className={`pointer-events-auto flex max-w-lg animate-fade-up items-start gap-2 rounded-lg border px-3 py-2 text-sm shadow-panel ${
            toast.tone === 'error' ? 'border-p1/50 bg-panel text-ink' : 'border-ok/50 bg-panel text-ink'
          }`}
        >
          {toast.tone === 'error'
            ? <TriangleAlert size={16} className="mt-0.5 shrink-0 text-p1" aria-hidden />
            : <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-ok" aria-hidden />}
          <span className="min-w-0">{toast.text}</span>
          <button type="button" onClick={onDismiss} aria-label="Dismiss" className="ml-1 shrink-0 rounded p-0.5 text-ink-2 hover:text-ink"><X size={14} aria-hidden /></button>
        </div>
      )}
    </div>
  )
}
