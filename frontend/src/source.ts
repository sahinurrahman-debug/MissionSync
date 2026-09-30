// One interface, two engines. The dashboard never knows which it is talking to.
import type { InjectResult, Snapshot } from './types'

export type Subscriber = (snap: Snapshot) => void

export interface DataSource {
  readonly kind: 'remote' | 'local'
  subscribe(fn: Subscriber): () => void
  getSnapshot(): Snapshot
  start(): void
  stop(): void
  /** Resolves with what the pipeline did; rejects with ApiError on a backend failure. */
  injectReport(text: string): Promise<InjectResult>
  /** Start the drill over. */
  reset(): Promise<void>
  nextSampleReport(): string
  /** URL of the after-action CSV for a stored drill (backends with a database only). */
  exportUrl?(drillId: number): string
}

/** Reports a net-control lead might actually type — used by the intake's sample picker. */
export const SAMPLE_REPORTS: readonly string[] = [
  'New fire reported in the University chemistry building, heavy smoke on the third floor, dozens of students evacuating',
  'Floodwater closing on the Riverfront footbridge, two kayakers missing downstream',
  'Gas smell in Industrial Park block B, workers reporting dizziness, possible pipeline leak',
  'Mudslide across the North Hills access road, a car with two occupants partially buried',
  'Missing child last seen near the Riverfront levee, wearing a red jacket',
]
