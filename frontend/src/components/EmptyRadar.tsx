/** Designed empty state: a quiet radar with a sweeping arm. */
export default function EmptyRadar({ title = 'Airwaves quiet.', hint }: { title?: string; hint?: string }) {
  return (
    <div className="flex h-full min-h-[220px] flex-col items-center justify-center gap-3 p-6 text-center" role="status">
      <svg width="132" height="132" viewBox="0 0 132 132" aria-hidden className="text-accent">
        <g fill="none" stroke="currentColor" strokeOpacity="0.35">
          <circle cx="66" cy="66" r="60" />
          <circle cx="66" cy="66" r="40" />
          <circle cx="66" cy="66" r="20" />
          <path d="M66 6v120M6 66h120" strokeOpacity="0.2" />
        </g>
        <g className="origin-center animate-sweep" style={{ transformOrigin: '66px 66px' }}>
          <path d="M66 66 L66 6 A60 60 0 0 1 108.4 23.6 Z" fill="currentColor" fillOpacity="0.18" />
          <path d="M66 66 L66 6" stroke="currentColor" strokeWidth="1.5" />
        </g>
        <circle cx="66" cy="66" r="3" fill="currentColor" />
      </svg>
      <div>
        <p className="text-base font-semibold text-ink">{title} No active incidents.</p>
        {hint && <p className="mt-1 max-w-xs text-sm text-ink-2">{hint}</p>}
      </div>
    </div>
  )
}
