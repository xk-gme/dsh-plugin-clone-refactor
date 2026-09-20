/** The production CommandRunner: the host's subprocess service, and nothing else. */
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle, SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'
import { EXIT_NOT_RUN, type CommandRequest, type CommandResult, type CommandRunner } from './command.ts'

export interface HostRunnerDefaults {
  /** Retained bytes per stream; the host spills the rest to disk and marks it lossy. */
  maxBytes: number
  graceMs: number
}

/** True when the host exposes a subprocess provider at all. */
export function hasSubprocess(ctx: Context): boolean {
  return ctx.get('subprocess') !== undefined
}

/**
 * Run one command through the host. Every failure mode is a `CommandResult`
 * (exit code `EXIT_NOT_RUN`, or the exit facts the host reports) rather than a
 * throw: a missing compiler must produce a recorded failure, not an exception
 * that loses the run.
 */
export function hostRunner(ctx: Context, defaults: HostRunnerDefaults): CommandRunner {
  return {
    async run(request: CommandRequest): Promise<CommandResult> {
      const base = { argv: request.argv, cwd: request.cwd }
      const subprocess = ctx.get('subprocess')
      if (subprocess === undefined) {
        return { ...base, exitCode: EXIT_NOT_RUN, signal: null, stdout: '', stderr: 'This deployment has no subprocess provider, so no command could run.', lossy: false, timedOut: false, spillPath: null }
      }
      const [command, ...args] = request.argv
      if (command === undefined || command === '') {
        return { ...base, exitCode: EXIT_NOT_RUN, signal: null, stdout: '', stderr: 'The command is empty.', lossy: false, timedOut: false, spillPath: null }
      }
      const timeout = AbortSignal.timeout(request.timeoutMs)
      const signal = request.signal === undefined ? timeout : AbortSignal.any([request.signal, timeout])
      let executable: string
      try {
        executable = await subprocess.resolveExecutable(command)
      } catch (error) {
        return { ...base, exitCode: EXIT_NOT_RUN, signal: null, stdout: '', stderr: `Cannot resolve ${command}: ${message(error)}`, lossy: false, timedOut: false, spillPath: null }
      }
      let handle: SubprocessHandle
      try {
        handle = subprocess.spawn({
          argv: [executable, ...args],
          cwd: request.cwd,
          stdio: { stdin: 'ignore', stdout: { maxBytes: defaults.maxBytes }, stderr: { maxBytes: defaults.maxBytes } },
          graceMs: defaults.graceMs,
          signal,
        })
      } catch (error) {
        return { ...base, exitCode: EXIT_NOT_RUN, signal: null, stdout: '', stderr: `Cannot start ${command}: ${message(error)}`, lossy: false, timedOut: timeout.aborted, spillPath: null }
      }
      let outcome: SubprocessOutcome
      try {
        outcome = await handle.done
      } catch (error) {
        return { ...base, exitCode: EXIT_NOT_RUN, signal: null, stdout: '', stderr: `Subprocess failed before reporting an outcome: ${message(error)}`, lossy: false, timedOut: timeout.aborted, spillPath: null }
      }
      const out = handle.collected.stdout?.readFrom(0)
      const err = handle.collected.stderr?.readFrom(0)
      return {
        ...base,
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        stdout: out?.text ?? '',
        stderr: err?.text ?? '',
        lossy: out?.lossy === true || err?.lossy === true,
        // Our own deadline, not the caller's cancellation: a caller abort is a
        // cancellation, and must not be reported as a timeout the user can retry.
        timedOut: timeout.aborted && (request.signal === undefined || !request.signal.aborted),
        spillPath: out?.spillPath ?? err?.spillPath ?? null,
      }
    },
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
