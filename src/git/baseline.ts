/**
 * The baseline a run is measured against. Without it there is no way to tell
 * "what this run changed" from "what the user already had", and the whole
 * authorization story collapses.
 */
import type { CommandResult, CommandRunner } from '../core/command.ts'

export interface Baseline {
  head: string
  branch: string
  /** Repo-relative forward-slash paths, dirty when the run started. */
  dirty: string[]
}

/**
 * A porcelain v1 status record → its repo-relative path (a rename keeps the target).
 *
 * The input is `git status --porcelain -z`: NUL-separated and never C-quoted, which
 * is the only form a path containing a space or a non-ASCII character survives. The
 * non-`-z` form prints `MM "path with space"` and escapes non-ASCII as octal, so a
 * parser reading it produced strings that could never equal the real path — and a
 * legitimate run was then frozen by `UNAUTHORIZED_CHANGES` naming a file that does
 * not exist. Scanning every record for ` -> ` was wrong twice over: a POSIX file
 * legally named `a -> b.md` parsed as `b.md`, and the rename target arrived quoted.
 */
export function parsePorcelain(text: string): string[] {
  const records = text.split('\u0000')
  const files: string[] = []
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? ''
    // `XY PATH`: two status characters, a space, then at least one path character.
    // A path may contain spaces and `->`, so the payload is everything after the space.
    if (record.length < 4) continue
    const path = record.slice(3)
    if (path === '') continue
    // A rename or copy record is the TARGET followed by a bare SOURCE record, which
    // names no path this status reports: skip it or the source is reported as changed.
    const status = record.slice(0, 2)
    if (status.includes('R') || status.includes('C')) index += 1
    files.push(path)
  }
  return files.map(file => file.replaceAll('\\', '/')).filter(Boolean)
}

/** `git diff --name-only -z` output → repo-relative forward-slash paths. */
export function parseNameOnly(text: string): string[] {
  return text.split('\u0000').map(name => name.replaceAll('\\', '/')).filter(name => name !== '')
}

/**
 * The one standard for "this git read is trustworthy": it exited 0, it was not cut
 * off by its timeout, and its capture was not truncated.
 *
 * Checking only the exit code is what let a truncated `rev-parse HEAD` become the
 * baseline identity every later diff is measured against, and a truncated
 * `ls-files` listing misclassify tracked files as "added by this run" and hand them
 * to `git clean` — which will not delete a tracked file and exits 0, so the rollback
 * recorded `rolled_back: true` over files it never restored.
 *
 * Every read whose STDOUT is the payload uses this. The mutating commands
 * (`checkout -B`, `restore`, `clean`) use {@link assertCompleted} instead: their
 * stdout is a log line, so `lossy` on it says nothing about whether the command
 * applied.
 */
function assertTrustworthy(result: CommandResult, context: string): void {
  if (result.exitCode === 0 && !result.timedOut && !result.lossy) return
  throw new Error(`${context}: ${detail(result)}`)
}

/**
 * The standard for a MUTATING git command: it exited 0 and it was not cut off by
 * our own deadline.
 *
 * `lossy` is deliberately not checked here — these commands print a log line
 * ("Switched to a new branch", "Removing x"), not a payload this process parses,
 * so a truncated log is no evidence of failure. `timedOut` is a different fact and
 * is refused. It is read from the `AbortSignal.timeout` this plugin owns, never
 * from the outcome, and the subprocess seam classifies no exit fact as a timeout
 * (`SubprocessOutcome` carries no timeout vocabulary, and its own tests show
 * `done` settling `{ exitCode: 0, signal: null }` after `terminate()`), so
 * `timedOut: true` with `exitCode: 0` is reachable: a child that traps SIGTERM, or
 * one that finishes exactly as the deadline fires. Treating that as success would
 * let `checkoutFiles` record `rolled_back: true`, and `createBranch` report a
 * branch it never created, over a command that may not have completed.
 */
function assertCompleted(result: CommandResult, context: string): void {
  if (result.exitCode === 0 && !result.timedOut) return
  if (result.timedOut) {
    throw new Error(`${context}: the command was cut off by its timeout (exit ${String(result.exitCode)})`)
  }
  throw new Error(`${context}: ${detail(result)}`)
}

async function capture(runner: CommandRunner, cwd: string, argv: readonly string[]): Promise<string> {
  const result = await runner.run({ argv, cwd, timeoutMs: 60_000, signal: undefined })
  // One rendering of an untrustworthy read, shared with `detail`: this replaced a
  // character-identical inline copy, so the deduplication changed no behaviour.
  assertTrustworthy(result, `${argv.join(' ')} failed in ${cwd}`)
  return result.stdout
}

/** The one-line reason from a failed command, for an error message. */
function detail(result: CommandResult): string {
  return (result.stderr.trim() || result.stdout.trim() || `exit ${String(result.exitCode)}`).slice(0, 500)
}

/** Read HEAD, the current branch and the dirty file list of one work tree. */
export async function readBaseline(runner: CommandRunner, projectRoot: string): Promise<Baseline> {
  const head = (await capture(runner, projectRoot, ['git', 'rev-parse', 'HEAD'])).trim()
  const branch = (await capture(runner, projectRoot, ['git', 'rev-parse', '--abbrev-ref', 'HEAD'])).trim()
  // A status we cannot trust is NOT a clean tree. `dirty: []` from a timeout, a
  // null exit or a truncated capture reads to `openRun` as "safe to patch", and the
  // whole point of the baseline is that the tree's state is known. `changedFiles`
  // reads the same status through this same helper, so the two can never disagree
  // about what an unreadable status means.
  return { head, branch, dirty: await readDirtyFiles(runner, projectRoot) }
}

/**
 * The one guarded `git status --porcelain -z` read: the parsed dirty list, or a
 * throw.
 *
 * Shared by `readBaseline` and `changedFiles`. The guard has to live inside the
 * read, not at one call site: an unreadable status has an empty (or partial)
 * `stdout`, and both callers read that emptiness as a fact — "the tree is clean",
 * "nothing changed" — when it is the absence of a fact.
 */
async function readDirtyFiles(runner: CommandRunner, projectRoot: string): Promise<string[]> {
  const status = await runner.run({ argv: ['git', 'status', '--porcelain', '-z'], cwd: projectRoot, timeoutMs: 60_000, signal: undefined })
  assertTrustworthy(status, `Cannot read the git status of ${projectRoot}`)
  return parsePorcelain(status.stdout)
}

/**
 * The change set `clone_verify` reconciles the authorization ledger against: the
 * parsed, deduplicated union of the work tree's status and its diff against the
 * baseline commit.
 *
 * This is one guarded helper rather than two reads in the tool layer because that
 * duplication is exactly how the authorization gate went vacuous: `clone_verify`
 * ran its own `git status`/`git diff` and checked neither `exitCode`, `timedOut`
 * nor `lossy`, so a timed-out or truncated read produced `changed: []`,
 * `reconcile` reported `unauthorized: []`, and verification proceeded over an
 * out-of-ledger change nobody had seen.
 *
 * `-z` on both reads: it is the only form that survives a path containing a space
 * or a non-ASCII character. The default forms C-quote and octal-escape such paths,
 * so the parsers could produce a string that never equals the real one and freeze
 * a legitimate run with `UNAUTHORIZED_CHANGES` naming a file that does not exist.
 */
export async function changedFiles(runner: CommandRunner, projectRoot: string, head: string): Promise<string[]> {
  const dirty = await readDirtyFiles(runner, projectRoot)
  const diff = await runner.run({ argv: ['git', 'diff', '--name-only', '-z', head], cwd: projectRoot, timeoutMs: 60_000, signal: undefined })
  assertTrustworthy(diff, `Cannot read the diff against ${head} in ${projectRoot}`)
  return [...new Set([...dirty, ...parseNameOnly(diff.stdout)])]
}

/** Create and switch to the run's own branch; an existing branch is reused. */
export async function createBranch(runner: CommandRunner, projectRoot: string, branch: string): Promise<void> {
  const result = await runner.run({ argv: ['git', 'checkout', '-B', branch], cwd: projectRoot, timeoutMs: 60_000, signal: undefined })
  assertCompleted(result, `Cannot create branch ${branch} in ${projectRoot}`)
}

/**
 * Restore exactly these files to the baseline — the rollback path.
 *
 * `git checkout -- <paths>` restores from the INDEX (not HEAD) and aborts the
 * whole command when any single pathspec is unknown to git: one file the patch
 * CREATED would leave every other file unrestored. A new helper file is a normal
 * clone-refactor output, so partition first and then do the two different things —
 * restore what git tracks, remove what the run added.
 *
 * `--literal-pathspecs` (a git-level option, so it precedes the subcommand) is what
 * makes the partition mean what it says. `files_changed` is model-supplied and
 * arrives through `normalizePath` and nothing else, so a `*` would widen `ls-files`
 * to every tracked file and `git clean` to everything untracked. The environment
 * variable that would do the same job is deliberately unavailable: `CommandRequest`
 * has no `env` field, which is the structural no-credential guarantee.
 */
export async function checkoutFiles(runner: CommandRunner, projectRoot: string, files: readonly string[]): Promise<void> {
  if (files.length === 0) return
  const listed = await runner.run({ argv: ['git', '--literal-pathspecs', 'ls-files', '-z', '--', ...files], cwd: projectRoot, timeoutMs: 60_000, signal: undefined })
  // Same guard as every other read: a truncated listing is not a short listing.
  assertTrustworthy(listed, `Cannot inspect which of these files git tracks (${files.join(', ')})`)
  // `-z` output is NUL-separated and unquoted: the only form that survives paths
  // git would otherwise C-quote.
  const tracked = new Set(listed.stdout.split('\u0000').filter(name => name !== ''))
  const known = files.filter(file => tracked.has(file))
  const added = files.filter(file => !tracked.has(file))
  if (known.length > 0) {
    // Explicit source: restore both the index and the work tree from the baseline
    // commit, never from whatever happens to be staged.
    const restored = await runner.run({ argv: ['git', '--literal-pathspecs', 'restore', '--source=HEAD', '--staged', '--worktree', '--', ...known], cwd: projectRoot, timeoutMs: 120_000, signal: undefined })
    assertCompleted(restored, `Cannot roll back ${known.join(', ')}`)
  }
  if (added.length > 0) {
    // A file the run created is removed, not restored. `-f` is required; no `-x`,
    // so an ignored file the user owns is never touched.
    const removed = await runner.run({ argv: ['git', '--literal-pathspecs', 'clean', '-f', '--', ...added], cwd: projectRoot, timeoutMs: 60_000, signal: undefined })
    assertCompleted(removed, `Cannot remove the files this run added (${added.join(', ')})`)
  }
}
