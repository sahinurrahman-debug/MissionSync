import { useState } from 'react'
import { ApiError, type InjectResult, type PipelineStage } from '../types'

const SAMPLE_COUNT = 4
const MAX_CHARS = 2000

const STAGE_LABEL: Record<string, string> = {
  surveillance: 'Parsing the report…',
  terrain: 'Assessing terrain…',
  risk: 'Scoring urgency…',
  logistics: 'Matching units…',
  command: 'Drafting orders…',
}

function describe(result: InjectResult): { text: string; tone: 'ok' | 'warn' } {
  if (result.kind === 'rejected') {
    return { text: result.message || 'No emergency recognised in that report.', tone: 'warn' }
  }
  const scored = result.tier ? `${result.tier} · urgency ${result.urgency?.toFixed(0) ?? '—'}` : 'scored'
  return result.kind === 'merged'
    ? { text: `Merged into existing incident “${result.incident_title}” — now ${scored}; ranking refreshed.`, tone: 'ok' }
    : { text: `New incident logged: “${result.incident_title}” — ${scored}.`, tone: 'ok' }
}

function describeError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'rate_limited') return `Too many reports — try again in ${e.retryAfterS ?? 2}s.`
    const id = e.requestId ? ` (ref ${e.requestId})` : ''
    return `${e.message}${id}`
  }
  return 'Report processing failed — the board keeps running; try again.'
}

export default function ReportIntake({
  onInject,
  onSample,
  stage,
  disabled,
}: {
  onInject: (text: string) => Promise<InjectResult>
  onSample: () => string
  stage: PipelineStage
  disabled?: boolean
}) {
  const [report, setReport] = useState('')
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<{ text: string; tone: 'ok' | 'warn' } | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Pull the sample list exactly once per mount (not on every render).
  const [samples] = useState(() => Array.from({ length: SAMPLE_COUNT }, () => onSample()))

  const submit = async () => {
    const text = report.trim()
    if (!text || busy || disabled) return
    setBusy(true)
    setToast(null)
    setError(null)
    try {
      const result = await onInject(text)
      setToast(describe(result))
      if (result.kind !== 'rejected') setReport('')
    } catch (e) {
      setError(describeError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="injector">
      <textarea
        placeholder="Type a field report — what is happening and where — e.g. “smoke from the University chemistry lab, two people coughing”"
        value={report}
        onChange={(e) => {
          setReport(e.target.value)
          setError(null)
        }}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void submit()
        }}
        aria-label="Field report"
        maxLength={MAX_CHARS}
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
        <button className="btn" onClick={() => void submit()} disabled={busy || disabled || !report.trim()}>
          {busy && <span className="spinner" aria-hidden />}
          {busy ? (STAGE_LABEL[stage] ?? 'Processing…') : 'Inject report'}
        </button>
      </div>
      {toast && <div className={`inject-toast ${toast.tone}`} role="status">{toast.text}</div>}
      {error && <div className="warning" role="alert">{error}</div>}
      <div className="inject-hint">
        Injection runs the full pipeline — parse → merge → re-rank → recommend. Name a place (Downtown, Riverfront, Industrial Park…) so it lands on the map. ⌘/Ctrl+Enter to submit.
      </div>
    </div>
  )
}
