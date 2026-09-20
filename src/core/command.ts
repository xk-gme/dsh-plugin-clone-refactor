/**
 * The one seam through which this plugin executes anything.
 *
 * A confined Harness cannot have a plugin spawn a child and capture its pipes
 * directly, so the production implementation goes through the host's subprocess
 * service; everything else in the plugin takes this interface as a parameter.
 */

export interface CommandRequest {
  /** `argv[0]` is an executable name or path; the host resolves it. */
  argv: readonly string[]
  cwd: string
  timeoutMs: number
  /** Absent means "no caller cancellation". */
  signal: AbortSignal | undefined
}

export interface CommandResult {
  argv: readonly string[]
  cwd: string
  exitCode: number | null
  signal: string | null
  stdout: string
  stderr: string
  /** True when the retained output was truncated by the host's byte cap. */
  lossy: boolean
  timedOut: boolean
  /** When the host spilled the complete stream to disk, where it lives. */
  spillPath: string | null
}

export interface CommandRunner {
  run(request: CommandRequest): Promise<CommandResult>
}

/** The exit code of a command that never ran (host refused, no subprocess service). */
export const EXIT_NOT_RUN = -1
