import type { ReactNode } from 'react'
import { Bot, Cpu } from 'lucide-react'
import type { Tier } from '../types'
import { TIER_LABEL } from '../lib/format'

/** Shared class fragments: one place to keep the type scale honest.
 *  Body/titles 16px, secondary 14px, uppercase micro-labels 12px. */
export const micro = 'text-xs font-semibold uppercase tracking-micro text-ink-2'

export const TIER_BG: Record<Tier, string> = { P1: 'bg-p1', P2: 'bg-p2', P3: 'bg-p3', P4: 'bg-p4' }
export const TIER_TEXT: Record<Tier, string> = { P1: 'text-p1', P2: 'text-p2', P3: 'text-p3', P4: 'text-ink-2' }
export const TIER_BORDER: Record<Tier, string> = { P1: 'border-p1', P2: 'border-p2', P3: 'border-p3', P4: 'border-p4' }

export function Panel({ children, className = '', label }: { children: ReactNode; className?: string; label?: string }) {
  return (
    <section aria-label={label} className={`flex min-h-0 flex-col overflow-hidden rounded-lg border border-line bg-panel ${className}`}>
      {children}
    </section>
  )
}

export function PanelHeader({ title, icon, right }: { title: string; icon?: ReactNode; right?: ReactNode }) {
  return (
    <header className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
      {icon && <span className="text-ink-2" aria-hidden>{icon}</span>}
      <h2 className={micro}>{title}</h2>
      <div className="ml-auto flex min-w-0 items-center gap-2 text-sm text-ink-2 tnum">{right}</div>
    </header>
  )
}

/** Priority pill — tier text AND score, never colour alone. */
export function TierPill({ tier, urgency, rank }: { tier: Tier; urgency?: number | null; rank?: number }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 font-mono text-xs font-bold tracking-wide tnum ${TIER_BG[tier]} ${tier === 'P4' ? 'text-white' : 'text-on-tier'}`}
      aria-label={`${rank ? `Rank ${rank}, ` : ''}${tier} ${TIER_LABEL[tier]}${urgency != null ? `, urgency ${Math.round(urgency)} of 100` : ''}`}
    >
      {rank != null && <span>#{rank}</span>}
      {rank != null && <span aria-hidden>·</span>}
      <span>{tier} {TIER_LABEL[tier]}</span>
      {urgency != null && (
        <>
          <span aria-hidden>·</span>
          <span>{Math.round(urgency)}/100</span>
        </>
      )}
    </span>
  )
}

export function SourceBadge({ source }: { source: 'llm' | 'cached' | 'rules' | undefined }) {
  const ai = source === 'llm' || source === 'cached'
  return (
    <span
      title={ai ? `Components scored by the LLM${source === 'cached' ? ' (reused — inputs unchanged)' : ''}` : 'Components scored by the rule-based twin'}
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs font-bold uppercase tracking-micro ${
        ai ? 'border-ok/50 text-ok' : 'border-line text-ink-2'
      }`}
    >
      {ai ? <Bot size={12} aria-hidden /> : <Cpu size={12} aria-hidden />}
      {ai ? 'AI' : 'RULES'}
    </span>
  )
}

export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'neutral'
const TONE: Record<Tone, string> = {
  ok: 'border-ok/40 bg-ok/10 text-ok',
  warn: 'border-warn/40 bg-warn/10 text-warn',
  bad: 'border-p1/40 bg-p1/10 text-p1',
  info: 'border-accent/40 bg-accent/10 text-accent',
  neutral: 'border-line bg-hi text-ink-2',
}

export function Chip({ tone = 'neutral', children, title, className = '' }: { tone?: Tone; children: ReactNode; title?: string; className?: string }) {
  return (
    <span title={title} className={`inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-md border px-2 text-xs font-semibold tnum ${TONE[tone]} ${className}`}>
      {children}
    </span>
  )
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-line bg-hi px-1.5 py-0.5 font-mono text-xs text-ink-2">{children}</kbd>
}
