/**
 * Outward actions, one mode at a time. Every caller must have taken `confirm:
 * true` first, and the plugin never supplies a credential: `gh` and `git` read
 * the credentials the host already has, so no token can leak into a command line
 * that the run directory records.
 */
import type { SubmitMode } from './config.ts'
import type { CommandRunner } from './core/command.ts'

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
  if (result.exitCode !== 0) {
    const detail = (result.stderr.trim() || result.stdout.trim() || `exit ${String(result.exitCode)}`).slice(0, 1000)
    throw new Error(`${argv.join(' ')} failed: ${detail}`)
  }
  steps.push(argv.join(' '))
  return result.stdout.trim()
}

/** Commit, then push, then open a PR — as far as `mode` allows. */
export async function submit(input: SubmitInput): Promise<SubmitResult> {
  const steps: string[] = []
  const result: SubmitResult = { mode: input.mode, committed: false, pushed: false, pr_url: null, steps }
  if (input.mode === 'none') return result
  if (input.files.length === 0) throw new Error('Cannot commit: no authorized files. Record a patched verdict with files_changed first.')
  await run(input, ['git', 'add', '--', ...input.files], steps)
  await run(input, ['git', 'commit', '-m', input.message], steps)
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
