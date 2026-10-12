import { useId, type InputHTMLAttributes, type ReactNode } from 'react'

/** A labelled input with its error shown inline (never an alert popup), wired for screen readers. */
export default function FormField({
  label, error, hint, trailing, ...input
}: { label: string; error?: string; hint?: string; trailing?: ReactNode } & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId()
  const describedBy = [error ? `${id}-err` : '', hint ? `${id}-hint` : ''].filter(Boolean).join(' ') || undefined
  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={id} className="text-base font-semibold text-ink">{label}</label>
        {trailing}
      </div>
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        {...input}
        className={`mt-1 h-12 w-full rounded-md border bg-bg px-3 text-base text-ink outline-none transition-colors placeholder:text-ink-2/70 focus:border-accent ${error ? 'border-p1' : 'border-line'} ${input.className ?? ''}`}
      />
      {hint && !error && <p id={`${id}-hint`} className="mt-1 text-sm text-ink-2">{hint}</p>}
      {error && <p id={`${id}-err`} role="alert" className="mt-1 text-sm font-semibold text-p1">{error}</p>}
    </div>
  )
}
