/** Where candidate clusters come from. The only detection seam there is. */
import type { Cluster } from '../core/schema.ts'
import type { CommandRunner } from '../core/command.ts'
import type { Settings } from '../config.ts'
import type { RunPaths } from '../core/artifacts.ts'

export interface DetectInput {
  settings: Settings
  runner: CommandRunner
  paths: RunPaths
  /** GME module name. Only the python-pipeline provider reads this. */
  module: string
  /** An explicit CSV to read, overriding `detection.csvPath`. Only the csv provider reads this. */
  csvPath: string
  signal: AbortSignal | undefined
}

export interface DetectResult {
  clusters: Cluster[]
  /** Which implementation answered: recorded on the run and in every report. */
  provider: string
  /** Where the raw detection artifacts were kept. */
  artifacts: string[]
}

export interface CloneDetector {
  readonly id: string
  detect(input: DetectInput): Promise<DetectResult>
}
