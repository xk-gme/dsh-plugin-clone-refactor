/**
 * Outward actions, one mode at a time. Every caller must have taken `confirm:
 * true` first, and the plugin never supplies a credential: `gh` and `git` read
 * the credentials the host already has, so no token can leak into a command line
 * that the run directory records.
 */
import type { SubmitMode } from './config.ts'
import type { CommandRunner } from './core/command.ts'
import { assertCompleted } from './git/baseline.ts'

export interface SubmitInput {
  runner: CommandRunner
  projectRoot: string
  branch: string
  remote: string
  baseBranch: string
  /** Exactly the files the authorization ledger covers. */
  files: readonly string[]
  message: string
  title: string
  body: string
  mode: SubmitMode
  signal: AbortSignal | undefined
}

export interface SubmitResult {
  mode: SubmitMode
  committed: boolean
  pushed: boolean
  pr_url: string | null
  steps: string[]
}

/**
 * Expand `{name}` placeholders; an unknown name is left visible, never blanked.
 *
 * `values` is an ordinary object, so a bare `values[name]` reads the prototype
 * chain: `{constructor}` would render `function Object() { [native code] }` and
 * `{__proto__}` would render `[object Object]` into a user's commit message.
 * `Object.hasOwn` is what makes "unknown" mean "not supplied by the caller".
 */
export function renderCommitMessage(template: string, values: Record<string, string>): string {
  return template.replaceAll(/\{(\w+)\}/g, (match, name: string) => {
    const value: string | undefined = values[name]
    return Object.hasOwn(values, name) && value !== undefined ? value : match
  })
}

async function run(input: SubmitInput, argv: readonly string[], steps: string[]): Promise<string> {
  const result = await input.runner.run({ argv, cwd: input.projectRoot, timeoutMs: 600_000, signal: input.signal })
  // The shared MUTATING-command guard, not a bare `exitCode !== 0` check: a child
  // that traps SIGTERM, or one that finishes exactly as our deadline fires, settles
  // as `{ exitCode: 0, timedOut: true }` (see `tests/command.spec.ts:157`). Without
  // this, all four steps below were recorded as successful outward actions over a
  // command that may never have completed. `lossy` stays exempt: the stdout here is
  // only a log line, which the guard documents.
  assertCompleted(result, `${argv.join(' ')} failed`)
  steps.push(argv.join(' '))
  return result.stdout.trim()
}

/**
 * Refuse to submit from a branch that is not the run's own.
 *
 * The whole authorization story is bound to `record.branch`: `clone_verify`
 * reconciles against it and `git push origin <run branch>` pushes it. A manual
 * switch between verify and submit would commit the patch on whichever branch HEAD
 * happens to point at, while the push sends a stale ref — an outward action on
 * work nobody reviewed in the place it was reviewed.
 */
async function assertOnRunBranch(input: SubmitInput): Promise<void> {
  const result = await input.runner.run({ argv: ['git', 'rev-parse', '--abbrev-ref', 'HEAD'], cwd: input.projectRoot, timeoutMs: 60_000, signal: input.signal })
  assertCompleted(result, `Cannot read the current branch of ${input.projectRoot}`)
  const current = result.stdout.trim()
  if (current !== input.branch) {
    throw new Error(`HEAD is on '${current}', not on this run's branch '${input.branch}'. Switch back (git checkout ${input.branch}) before submitting: otherwise the commit would land on the wrong branch.`)
  }
}

/** Commit, then push, then open a PR — as far as `mode` allows. */
export async function submit(input: SubmitInput): Promise<SubmitResult> {
  const steps: string[] = []
  const result: SubmitResult = { mode: input.mode, committed: false, pushed: false, pr_url: null, steps }
  if (input.mode === 'none') return result
  if (input.files.length === 0) throw new Error('Cannot commit: no authorized files. Record a patched verdict with files_changed first.')
  await assertOnRunBranch(input)
  await run(input, ['git', 'add', '--', ...input.files], steps)
  // `--only` (with the same pathspec) is what keeps the commit to the ledger.
  // A bare `git commit` commits the WHOLE INDEX, so `git add -- <files>` bounded
  // nothing: with `workdir.allowDirty: true` — the documented profile of an operator
  // who has work in progress — a pre-existing STAGED change to a file nobody
  // authorized was swept into this commit and pushed under a message that counts
  // ledger files only. `--only -- <paths>` commits exactly those paths and leaves the
  // rest of the index untouched. The `git add` above is still required: an untracked
  // file the run created has no index entry for `--only` to commit.
  await run(input, ['git', 'commit', '--only', '-m', input.message, '--', ...input.files], steps)
  result.committed = true
  if (input.mode === 'commit') return result
  await run(input, ['git', 'push', '-u', input.remote, input.branch], steps)
  result.pushed = true
  if (input.mode === 'push') return result
  const base = input.baseBranch === '' ? 'main' : input.baseBranch
  const stdout = await run(input, ['gh', 'pr', 'create', '--base', base, '--head', input.branch, '--title', input.title, '--body', input.body], steps)
  result.pr_url = stdout.split('\n').map(line => line.trim()).filter(line => line.startsWith('http')).at(-1) ?? null
  return result
}
