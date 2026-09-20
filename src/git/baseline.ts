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

/** A porcelain v1 status line → its repo-relative path (renames keep the target). */
export function parsePorcelain(text: string): string[] {
  const files: string[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    const payload = line.length > 3 ? line.slice(3).trim() : line.trim()
    if (payload === '') continue
    const arrow = payload.lastIndexOf(' -> ')
    files.push(arrow === -1 ? payload : payload.slice(arrow + 4))
  }
  return files.map(file => file.replaceAll('\\', '/')).filter(Boolean)
}

/** `git diff --name-only` output → repo-relative forward-slash paths. */
export function parseNameOnly(text: string): string[] {
  return text.split('\n').map(line => line.trim().replaceAll('\\', '/')).filter(line => line !== '')
}

async function capture(runner: CommandRunner, cwd: string, argv: readonly string[]): Promise<string> {
  const result = await runner.run({ argv, cwd, timeoutMs: 60_000, signal: undefined })
  if (result.exitCode !== 0) {
    const detail = (result.stderr.trim() || result.stdout.trim() || `exit ${String(result.exitCode)}`).slice(0, 500)
    throw new Error(`${argv.join(' ')} failed in ${cwd}: ${detail}`)
  }
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
  const status = await runner.run({ argv: ['git', 'status', '--porcelain'], cwd: projectRoot, timeoutMs: 60_000, signal: undefined })
  // A status we cannot trust is NOT a clean tree. `dirty: []` from a timeout, a
  // null exit or a truncated capture reads to Task 6 as "safe to patch", and the
  // whole point of the baseline is that the tree's state is known.
  if (status.exitCode !== 0 || status.timedOut || status.lossy) {
    throw new Error(`Cannot read the git status of ${projectRoot}: ${detail(status)}`)
  }
  return { head, branch, dirty: parsePorcelain(status.stdout) }
}

/** Create and switch to the run's own branch; an existing branch is reused. */
export async function createBranch(runner: CommandRunner, projectRoot: string, branch: string): Promise<void> {
  const result = await runner.run({ argv: ['git', 'checkout', '-B', branch], cwd: projectRoot, timeoutMs: 60_000, signal: undefined })
  if (result.exitCode !== 0) {
    throw new Error(`Cannot create branch ${branch} in ${projectRoot}: ${detail(result)}`)
  }
}

/**
 * Restore exactly these files to the baseline — the rollback path.
 *
 * `git checkout -- <paths>` restores from the INDEX (not HEAD) and aborts the
 * whole command when any single pathspec is unknown to git: one file the patch
 * CREATED would leave every other file unrestored. A new helper file is a normal
 * clone-refactor output, so partition first and then do the two different things —
 * restore what git tracks, remove what the run added.
 */
export async function checkoutFiles(runner: CommandRunner, projectRoot: string, files: readonly string[]): Promise<void> {
  if (files.length === 0) return
  const listed = await runner.run({ argv: ['git', 'ls-files', '-z', '--', ...files], cwd: projectRoot, timeoutMs: 60_000, signal: undefined })
  if (listed.exitCode !== 0) {
    throw new Error(`Cannot inspect which of these files git tracks (${files.join(', ')}): ${detail(listed)}`)
  }
  // `-z` output is NUL-separated and unquoted: the only form that survives paths
  // git would otherwise C-quote.
  const tracked = new Set(listed.stdout.split('\u0000').filter(name => name !== ''))
  const known = files.filter(file => tracked.has(file))
  const added = files.filter(file => !tracked.has(file))
  if (known.length > 0) {
    // Explicit source: restore both the index and the work tree from the baseline
    // commit, never from whatever happens to be staged.
    const restored = await runner.run({ argv: ['git', 'restore', '--source=HEAD', '--staged', '--worktree', '--', ...known], cwd: projectRoot, timeoutMs: 120_000, signal: undefined })
    if (restored.exitCode !== 0) {
      throw new Error(`Cannot roll back ${known.join(', ')}: ${detail(restored)}`)
    }
  }
  if (added.length > 0) {
    // A file the run created is removed, not restored. `-f` is required; no `-x`,
    // so an ignored file the user owns is never touched.
    const removed = await runner.run({ argv: ['git', 'clean', '-f', '--', ...added], cwd: projectRoot, timeoutMs: 60_000, signal: undefined })
    if (removed.exitCode !== 0) {
      throw new Error(`Cannot remove the files this run added (${added.join(', ')}): ${detail(removed)}`)
    }
  }
}
