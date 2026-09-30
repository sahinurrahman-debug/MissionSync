import { useState } from 'react'
import { CornerDownLeft, Radio, Send, Sparkles } from 'lucide-react'
import { ApiError, type InjectResult, type PipelineStage } from '../types'
import PipelineStepper from './PipelineStepper'
import { Kbd, Panel, PanelHeader } from './ui'

const MAX_CHARS = 2000

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
    return `${e.message}${e.requestId ? ` (ref ${e.requestId})` : ''}`
  }
  return 'Report processing failed — the board keeps running; try again.'
}

export default function ReportIntake({
  onInject, onSample, stage, disabled,
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

  const near = report.length > MAX_CHARS * 0.9

  return (
    <Panel label="Field report intake terminal">
      <PanelHeader title="Field report intake" icon={<Radio size={15} />} right={<span className="hidden sm:inline">radio transcript → structured incident</span>} />
      <div className="space-y-1.5 p-2">
        <div className="rounded-md border border-line bg-bg focus-within:border-accent focus-within:shadow-glow">
          <div className="flex items-start gap-2 px-2.5 pt-2">
            <span className="select-none pt-0.5 font-mono text-base font-bold text-accent" aria-hidden>&gt;</span>
            <textarea
              value={report}
              onChange={(e) => { setReport(e.target.value); setError(null) }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void submit() }
              }}
              placeholder="Type field transcript (e.g. 'Fire spreading near University lab block, 3 trapped')…"
              aria-label="Field report"
              maxLength={MAX_CHARS}
              rows={2}
              className="max-h-28 min-h-[52px] w-full resize-none bg-transparent font-mono text-base leading-snug text-ink outline-none placeholder:text-ink-2/80"
            />
          </div>
          <div className="flex items-center gap-2 border-t border-line px-2 py-1.5">
            <button
              type="button"
              onClick={() => { setReport(onSample()); setError(null) }}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line bg-hi px-2.5 text-sm font-semibold text-ink-2 transition-colors hover:border-accent hover:text-accent"
            >
              <Sparkles size={14} aria-hidden /> Inject sample
            </button>
            <span className={`ml-auto font-mono text-xs tnum ${near ? 'text-warn' : 'text-ink-2'}`} aria-live="polite">{report.length}/{MAX_CHARS}</span>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={busy || disabled || !report.trim()}
              className="inline-flex h-9 items-center gap-2 rounded-md bg-accent px-3 text-sm font-bold text-bg transition-[filter,opacity] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Send size={15} aria-hidden />
              {busy ? 'Processing…' : 'Dispatch'}
              <span className="hidden items-center sm:inline-flex"><Kbd><CornerDownLeft size={11} aria-label="Enter" /></Kbd></span>
            </button>
          </div>
        </div>

        <PipelineStepper stage={stage} busy={busy || stage !== 'idle'} />

        <div aria-live="polite">
          {toast && (
            <p className={`animate-fade-up rounded-md border px-2 py-1 text-sm ${toast.tone === 'ok' ? 'border-ok/40 bg-ok/10 text-ink' : 'border-warn/40 bg-warn/10 text-ink'}`}>{toast.text}</p>
          )}
          {error && <p role="alert" className="rounded-md border border-p1/40 bg-p1/10 px-2 py-1 text-sm text-ink">{error}</p>}
        </div>
      </div>
    </Panel>
  )
}
