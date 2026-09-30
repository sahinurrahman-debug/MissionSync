import { useState } from 'react'
import type { InjectResult } from '../types'

const SAMPLE_COUNT = 4

export default function ReportIntake({
  onInject,
  onSample,
}: {
  onInject: (text: string) => InjectResult | null
  onSample: () => string
}) {
  const [report, setReport] = useState('')
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Pull the sample list exactly once per mount (not on every render).
  const [samples] = useState(() => Array.from({ length: SAMPLE_COUNT }, () => onSample()))

  const submit = () => {
    const text = report.trim()
    if (!text || busy) return
    setBusy(true)
    setToast(null)
    setError(null)
    // Let the UI paint the busy state before the (synchronous) pipeline runs.
    setTimeout(() => {
      try {
        const result = onInject(text)
        if (result) {
          setToast(
            result.merged
              ? `Merged into existing incident “${result.incident_title}” — ranking refreshed.`
              : `New incident logged: “${result.incident_title}” — ${result.tier ?? 'P?'} · urgency ${result.urgency?.toFixed(0) ?? '—'}.`,
          )
        } else {
          setError('Could not process the report — try again.')
        }
        setReport('')
      } catch {
        setError('Report processing failed — the board keeps running; try rephrasing.')
      } finally {
        setBusy(false)
      }
    }, 350)
  }

  return (
    <div className="injector">
      <textarea
        placeholder="Type a field report — e.g. “smoke from Building C, two people coughing” — and inject it into the live drill…"
        value={report}
        onChange={(e) => {
          setReport(e.target.value)
          setError(null)
        }}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit()
        }}
        aria-label="Field report"
        maxLength={500}
      />
      <div className="injector-row">
        <select
          value=""
          onChange={(e) => {
            if (e.target.value) {
              setReport(e.target.value)
              setError(null)
            }
          }}
          aria-label="Sample reports"
        >
          <option value="">— or pick a sample report —</option>
          {samples.map((s) => (
            <option key={s} value={s}>{s.slice(0, 52)}…</option>
          ))}
        </select>
        <button className="btn" onClick={submit} disabled={busy || !report.trim()}>
          {busy && <span className="spinner" aria-hidden />}
          {busy ? 'Processing…' : 'Inject report'}
        </button>
      </div>
      {toast && <div className="inject-toast">{toast}</div>}
      {error && <div className="warning">{error}</div>}
      <div className="inject-hint">
        Injection runs the full pipeline — parse → merge → re-rank → recommend — right here in the browser. ⌘/Ctrl+Enter to submit.
      </div>
    </div>
  )
}
