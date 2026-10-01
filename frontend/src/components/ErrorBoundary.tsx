import { Component, type ErrorInfo, type ReactNode } from 'react'
import { TriangleAlert } from 'lucide-react'

interface Props {
  children: ReactNode
  label?: string
  compact?: boolean
  /** `app` wraps the whole board: there is no "rest of the board" to fall back on, so offer a reload. */
  scope?: 'panel' | 'app'
}
interface State { failed: boolean }

/** A render error in one panel must never blank the board: the panel says so in plain words and offers a
 *  retry. The technical detail goes to the console for developers, never onto the screen. */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false }

  static getDerivedStateFromError(): State {
    return { failed: true }
  }

  componentDidCatch(err: unknown, info: ErrorInfo): void {
    console.error(`[MissionSync] ${this.props.label ?? 'panel'} crashed`, err, info.componentStack)
  }

  render() {
    if (!this.state.failed) return this.props.children
    const app = this.props.scope === 'app'
    return (
      <div role="alert" className={`flex min-h-[120px] flex-col items-center justify-center gap-2 p-4 text-center ${app ? 'h-dvh bg-bg text-ink' : 'h-full'}`}>
        <TriangleAlert className="text-warn" size={24} aria-hidden />
        <p className="text-base font-semibold text-ink">{this.props.label ?? 'This panel'} hit a problem</p>
        {!this.props.compact && (
          <p className="max-w-sm text-sm text-ink-2">
            {app ? 'Something went wrong while drawing the dashboard. Your drill data is safe on the server.' : 'The rest of the board is still live. Your data is safe — try again.'}
          </p>
        )}
        <button
          type="button"
          onClick={() => (app ? window.location.reload() : this.setState({ failed: false }))}
          className="mt-1 h-11 rounded-md border border-line bg-hi px-4 text-sm font-semibold text-ink hover:border-accent"
        >
          {app ? 'Reload the page' : 'Retry'}
        </button>
      </div>
    )
  }
}
