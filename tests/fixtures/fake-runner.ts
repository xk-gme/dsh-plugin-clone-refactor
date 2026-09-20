/** A scriptable CommandRunner: tests never spawn a real compiler. */
import type { CommandRequest, CommandResult, CommandRunner } from '../../src/core/command.ts'

export interface FakeCall { argv: readonly string[]; cwd: string }

/**
 * A scripted answer, or a sequence of them.
 *
 * The sequence form exists because one logical test often has to see the SAME
 * command answer differently across the run: `openRun` must read a clean work
 * tree before it will start, and the later reconcile must read that tree as
 * changed. An array is consumed one entry per matching call and then STICKS on
 * its last entry, so a test states only the transition it cares about and every
 * later call keeps seeing the final state.
 */
export type FakeAnswer = Partial<CommandResult> | readonly Partial<CommandResult>[]

export interface FakeRunner extends CommandRunner {
  readonly calls: FakeCall[]
  /** Key: the joined argv prefix the test matched on. */
  readonly matched: string[]
}

/** One scripted entry: matched by argv prefix, or by a predicate for state. */
export type FakeScriptEntry = [
  prefix: string,
  result: FakeAnswer,
  /** Consulted first. Use it when the answer depends on more than the argv. */
  match?: () => boolean,
]

/**
 * Answer commands by matching their argv prefix. An unmatched command is an
 * exit-127 result rather than a throw, so a test that forgot to script a command
 * fails on the assertion it was checking, not on an exception from the fixture.
 *
 * Matching is by FIRST entry whose prefix fits, not by longest prefix, so a test
 * that wants a narrow override must place it before a broader one — or guard it
 * with `match`, which is checked before the entry is considered at all.
 */
export function fakeRunner(script: FakeScriptEntry[]): FakeRunner {
  const calls: FakeCall[] = []
  const matched: string[] = []
  const taken = new Map<string, number>()
  return {
    calls,
    matched,
    async run(request: CommandRequest): Promise<CommandResult> {
      calls.push({ argv: request.argv, cwd: request.cwd })
      const key = request.argv.join(' ')
      for (const [prefix, answer, match] of script) {
        if (!key.startsWith(prefix)) continue
        if (match !== undefined && !match()) continue
        matched.push(prefix)
        // The last element is the resting state: see {@link FakeAnswer}.
        const index = taken.get(prefix) ?? 0
        if (Array.isArray(answer)) {
          taken.set(prefix, Math.min(index + 1, answer.length - 1))
          return { ...base(request), ...answer[Math.min(index, answer.length - 1)] }
        }
        return { ...base(request), ...(answer as Partial<CommandResult>) }
      }
      return { ...base(request), exitCode: 127, stderr: `no scripted answer for: ${key}` }
    },
  }
}

/** The neutral result every scripted answer starts from. */
function base(request: CommandRequest): CommandResult {
  return {
    argv: request.argv, cwd: request.cwd, exitCode: 0, signal: null,
    stdout: '', stderr: '', lossy: false, timedOut: false, spillPath: null,
  }
}
