import { describe, expect, it } from 'vitest'
import { renderCommitMessage, submit } from '../src/submit.ts'
import { fakeRunner } from './fixtures/fake-runner.ts'

const BASE = {
  runner: fakeRunner([]), projectRoot: 'D:/repo', branch: 'clone-refactor/run-1',
  remote: 'origin', baseBranch: 'main', files: ['module/laws/src/a.cpp'],
  message: 'refactor: dedupe ComputeArea', title: 'Clone refactor run-1', body: 'Deduplicated one clone family.',
  signal: undefined,
}

describe('renderCommitMessage', () => {
  it('expands the documented placeholders', () => {
    expect(renderCommitMessage('clone({cluster_id}) {files_count} {timestamp}', { cluster_id: 'C001', files_count: '2', timestamp: 'T' }))
      .toBe('clone(C001) 2 T')
  })

  it('leaves an unknown placeholder alone instead of blanking it', () => {
    expect(renderCommitMessage('x {nope} y', {})).toBe('x {nope} y')
    // The rule has to hold for names that exist on Object.prototype too: a plain
    // `values[name] ?? match` reads the prototype chain and would render
    // "function Object() { [native code] }" (or "[object Object]" for `__proto__`)
    // into a user's commit message. `Object.hasOwn` is what makes "unknown" mean
    // "not supplied by the caller".
    expect(renderCommitMessage('x {constructor} y', {})).toBe('x {constructor} y')
    expect(renderCommitMessage('x {toString} y', {})).toBe('x {toString} y')
    expect(renderCommitMessage('x {__proto__} y', {})).toBe('x {__proto__} y')
  })
})

describe('submit', () => {
  it('runs nothing at all in the none mode', async () => {
    const runner = fakeRunner([])
    const result = await submit({ ...BASE, runner, mode: 'none' })
    expect(result.steps).toEqual([])
    expect(runner.calls).toEqual([])
  })

  it('stages exactly the authorized files and commits', async () => {
    const runner = fakeRunner([['git add', {}], ['git commit', {}]])
    const result = await submit({ ...BASE, runner, mode: 'commit' })
    expect(result.committed).toBe(true)
    expect(result.pushed).toBe(false)
    expect(runner.calls.map(call => call.argv.join(' '))).toEqual([
      'git add -- module/laws/src/a.cpp',
      'git commit -m refactor: dedupe ComputeArea',
    ])
  })

  it('pushes the run branch when asked', async () => {
    const runner = fakeRunner([['git add', {}], ['git commit', {}], ['git push', { stdout: 'ok\n' }]])
    const result = await submit({ ...BASE, runner, mode: 'push' })
    expect(result.pushed).toBe(true)
    // The whole sequence, by equality: a mode that ran one rung too many or too few
    // has to fail this, not merely "something ran".
    expect(runner.calls.map(call => call.argv.join(' '))).toEqual([
      'git add -- module/laws/src/a.cpp',
      'git commit -m refactor: dedupe ComputeArea',
      'git push -u origin clone-refactor/run-1',
    ])
  })

  it('opens a pull request against the configured base branch', async () => {
    const runner = fakeRunner([['git add', {}], ['git commit', {}], ['git push', {}], ['gh pr create', { stdout: 'https://github.com/x/y/pull/7\n' }]])
    const result = await submit({ ...BASE, runner, mode: 'pr' })
    expect(result.pr_url).toBe('https://github.com/x/y/pull/7')
    // By equality, including the title and the body: a bare `toContain('--base')`
    // would let a wrong title/body or an extra trailing command pass.
    expect(runner.calls.map(call => call.argv.join(' '))).toEqual([
      'git add -- module/laws/src/a.cpp',
      'git commit -m refactor: dedupe ComputeArea',
      'git push -u origin clone-refactor/run-1',
      'gh pr create --base main --head clone-refactor/run-1 --title Clone refactor run-1 --body Deduplicated one clone family.',
    ])
  })

  it('falls back to main when no base branch is configured', async () => {
    // `submit.baseBranch` defaults to '' in the shipped config, so this is the path
    // every unconfigured user takes — not a dead branch.
    const runner = fakeRunner([['git add', {}], ['git commit', {}], ['git push', {}], ['gh pr create', { stdout: 'https://github.com/x/y/pull/8\n' }]])
    await submit({ ...BASE, runner, mode: 'pr', baseBranch: '' })
    expect(runner.calls[3]?.argv.join(' ')).toContain('--base main')
  })

  it('stops before the pull request when the push fails', async () => {
    const runner = fakeRunner([['git add', {}], ['git commit', {}], ['git push', { exitCode: 1, stderr: 'rejected' }]])
    await expect(submit({ ...BASE, runner, mode: 'pr' })).rejects.toThrow(/rejected/)
    expect(runner.calls.some(call => call.argv[0] === 'gh')).toBe(false)
  })

  it('refuses to commit nothing', async () => {
    await expect(submit({ ...BASE, runner: fakeRunner([]), mode: 'commit', files: [] })).rejects.toThrow(/no authorized files/)
  })

  it('never puts a credential in argv', async () => {
    const runner = fakeRunner([['git add', {}], ['git commit', {}], ['git push', {}], ['gh pr create', { stdout: 'u\n' }]])
    await submit({ ...BASE, runner, mode: 'pr' })
    // The token belongs in the environment the host provides, never in a command
    // line that the run directory records.
    expect(runner.calls.flatMap(call => [...call.argv]).join(' ')).not.toMatch(/token|secret|ghp_/i)
  })
})
