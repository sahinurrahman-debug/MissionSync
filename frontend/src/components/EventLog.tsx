import type { EventLine } from '../types'

export default function EventLog({ lines }: { lines: EventLine[] }) {
  const ordered = [...lines].reverse()

  if (ordered.length === 0) {
    return (
      <div className="empty">
        <span className="empty-icon">📻</span>
        <span>Listening — pipeline events will appear here as the drill runs.</span>
      </div>
    )
  }

  return (
    <div className="log-body" role="log" aria-live="polite">
      {ordered.map((line, i) => (
        <div className={`log-line ${i === 0 ? 'newest' : ''}`} key={line.seq}>
          <time>{line.t}</time>
          <span>{line.msg}</span>
        </div>
      ))}
    </div>
  )
}
