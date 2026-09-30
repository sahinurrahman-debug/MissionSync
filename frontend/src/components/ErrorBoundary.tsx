import { Component, type ErrorInfo, type ReactNode } from 'react'
import { TriangleAlert } from 'lucide-react'

interface Props { children: ReactNode; label?: string; compact?: boolean }
interface State { failed: boolean; message: string }

/** A render error in one panel must never blank the board: the panel says so and offers a retry. */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false, message: '' }

  static getDerivedStateFromError(err: unknown): State {
    return { failed: true, message: err instanceof Error ? err.message : String(err) }
  }

  componentDidCatch(err: unknown, info: ErrorInfo): void {
    console.error(`[MissionSync] ${this.props.label ?? 'panel'} crashed`, err, info.componentStack)
  }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <div role="alert" className="flex h-full min-h-[120px] flex-col items-center justify-center gap-2 p-4 text-center">
        <TriangleAlert className="text-warn" size={24} aria-hidden />
        <p className="text-base font-semibold text-ink">{this.props.label ?? 'This panel'} hit a problem</p>
        {!this.props.compact && <p className="max-w-sm text-sm text-ink-2">The rest of the board is still live. {this.state.message}</p>}
        <button
          type="button"
          onClick={() => this.setState({ failed: false, message: '' })}
          className="mt-1 h-9 rounded-md border border-line bg-hi px-3 text-sm font-semibold text-ink hover:border-accent"
        >
          Retry
        </button>
      </div>
    )
  }
}
