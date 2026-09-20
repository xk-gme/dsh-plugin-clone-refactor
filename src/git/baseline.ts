/**
 * The baseline a run is measured against. Without it there is no way to tell
 * "what this run changed" from "what the user already had", and the whole
 * authorization story collapses.
 */
import { EXIT_NOT_RUN, type CommandRunner } from '../core/command.ts'

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

/** Read HEAD, the current branch and the dirty file list of one work tree. */
export async function readBaseline(runner: CommandRunner, projectRoot: string): Promise<Baseline> {
  const head = (await capture(runner, projectRoot, ['git', 'rev-parse', 'HEAD'])).trim()
  const branch = (await capture(runner, projectRoot, ['git', 'rev-parse', '--abbrev-ref', 'HEAD'])).trim()
  const status = await runner.run({ argv: ['git', 'status', '--porcelain'], cwd: projectRoot, timeoutMs: 60_000, signal: undefined })
  if (status.exitCode === EXIT_NOT_RUN) throw new Error(`Cannot read the git status of ${projectRoot}: ${status.stderr}`)
  return { head, branch, dirty: status.exitCode === 0 ? parsePorcelain(status.stdout) : [] }
}

/** Create and switch to the run's own branch; an existing branch is reused. */
export async function createBranch(runner: CommandRunner, projectRoot: string, branch: string): Promise<void> {
  const result = await runner.run({ argv: ['git', 'checkout', '-B', branch], cwd: projectRoot, timeoutMs: 60_000, signal: undefined })
  if (result.exitCode !== 0) {
    throw new Error(`Cannot create branch ${branch} in ${projectRoot}: ${(result.stderr || result.stdout).slice(0, 500)}`)
  }
}

/** Check out the baseline revision of exactly these files (the rollback path). */
export async function checkoutFiles(runner: CommandRunner, projectRoot: string, files: readonly string[]): Promise<void> {
  if (files.length === 0) return
  const result = await runner.run({ argv: ['git', 'checkout', '--', ...files], cwd: projectRoot, timeoutMs: 120_000, signal: undefined })
  if (result.exitCode !== 0) {
    throw new Error(`Cannot roll back ${files.join(', ')}: ${(result.stderr || result.stdout).slice(0, 500)}`)
  }
}
