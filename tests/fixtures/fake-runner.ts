/** A scriptable CommandRunner: tests never spawn a real compiler. */
import type { CommandRequest, CommandResult, CommandRunner } from '../../src/core/command.ts'

export interface FakeCall { argv: readonly string[]; cwd: string }

export interface FakeRunner extends CommandRunner {
  readonly calls: FakeCall[]
  /** Key: the joined argv prefix the test matched on. */
  readonly matched: string[]
}

/**
 * Answer commands by matching their argv prefix. An unmatched command is an
 * exit-127 result rather than a throw, so a test that forgot to script a command
 * fails on the assertion it was checking, not on an exception from the fixture.
 */
export function fakeRunner(script: Array<[prefix: string, result: Partial<CommandResult>]>): FakeRunner {
  const calls: FakeCall[] = []
  const matched: string[] = []
  return {
    calls,
    matched,
    async run(request: CommandRequest): Promise<CommandResult> {
      calls.push({ argv: request.argv, cwd: request.cwd })
      const key = request.argv.join(' ')
      for (const [prefix, result] of script) {
        if (key.startsWith(prefix)) {
          matched.push(prefix)
          return {
            argv: request.argv, cwd: request.cwd, exitCode: 0, signal: null,
            stdout: '', stderr: '', lossy: false, timedOut: false, spillPath: null,
            ...result,
          }
        }
      }
      return {
        argv: request.argv, cwd: request.cwd, exitCode: 127, signal: null,
        stdout: '', stderr: `no scripted answer for: ${key}`, lossy: false, timedOut: false, spillPath: null,
      }
    },
  }
}
