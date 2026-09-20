import { describe, expect, it } from 'vitest'
import { checkoutFiles, parseNameOnly, parsePorcelain, readBaseline } from '../src/git/baseline.ts'
import { normalizePath } from '../src/core/paths.ts'
import { reconcile } from '../src/git/reconcile.ts'
import { fakeRunner } from './fixtures/fake-runner.ts'

describe('git output parsing', () => {
  it('reads porcelain status as repo-relative forward-slash paths', () => {
    expect(parsePorcelain(' M src/a.cpp\n?? src/b.cpp\nR  old.cpp -> new.cpp\n')).toEqual([
      'src/a.cpp', 'src/b.cpp', 'new.cpp',
    ])
  })

  it('reads a name-only diff', () => {
    expect(parseNameOnly('src/a.cpp\nmodule/laws/src/b.cpp\n\n')).toEqual(['src/a.cpp', 'module/laws/src/b.cpp'])
  })

  it('normalizes windows separators and redundant segments', () => {
    expect(normalizePath('src\\a.cpp')).toBe('src/a.cpp')
    expect(normalizePath('./src//a.cpp')).toBe('src/a.cpp')
    expect(normalizePath('src/../b.cpp')).toBe('b.cpp')
  })
})

describe('readBaseline', () => {
  it('captures head, branch and the dirty list', async () => {
    const runner = fakeRunner([
      ['git rev-parse HEAD', { stdout: 'abc123\n' }],
      ['git rev-parse --abbrev-ref HEAD', { stdout: 'main\n' }],
      ['git status --porcelain', { stdout: ' M src/a.cpp\n' }],
    ])
    const baseline = await readBaseline(runner, 'D:/repo')
    expect(baseline.head).toBe('abc123')
    expect(baseline.branch).toBe('main')
    expect(baseline.dirty).toEqual(['src/a.cpp'])
  })

  it('fails loudly when the directory is not a git work tree', async () => {
    const runner = fakeRunner([['git rev-parse HEAD', { exitCode: 128, stderr: 'not a git repository' }]])
    await expect(readBaseline(runner, 'D:/nope')).rejects.toThrow(/not a git repository|HEAD/i)
  })
})

describe('reconcile', () => {
  it('passes when every changed file is covered by the authorization ledger', () => {
    const result = reconcile(['src/a.cpp'], ['src/a.cpp'])
    expect(result).toEqual({ unauthorized: [], missing: [] })
  })

  // 参数顺序是 (authorized, changed)：这里两处曾把顺序写反，导致断言要求的
  // 恰是数据所否定的东西（"授权 b 然后断言 b 未授权"），计划已修正。
  it('flags a changed file the ledger never authorized', () => {
    const result = reconcile(['src/a.cpp'], ['src/a.cpp', 'module/laws/src/b.cpp'])
    expect(result.unauthorized).toEqual(['module/laws/src/b.cpp'])
    expect(result.missing).toEqual([])
  })

  it('flags an authorized file that is not actually changed', () => {
    const result = reconcile(['src/a.cpp', 'src/gone.cpp'], ['src/a.cpp'])
    expect(result.unauthorized).toEqual([])
    expect(result.missing).toEqual(['src/gone.cpp'])
  })

  it('ignores path flavour differences between the ledger and git', () => {
    const result = reconcile(['module\\laws\\src\\b.cpp'], ['module/laws/src/b.cpp'])
    expect(result).toEqual({ unauthorized: [], missing: [] })
  })
})

describe('checkoutFiles', () => {
  it('restores the files git tracks and removes the ones the run added', async () => {
    const runner = fakeRunner([
      ['git ls-files -z --', { stdout: 'src/a.cpp\u0000' }],
      ['git restore --source=HEAD', {}],
      ['git clean -f --', {}],
    ])
    await checkoutFiles(runner, 'D:/repo', ['src/a.cpp', 'src/new_helper.cpp'])
    expect(runner.calls.map(call => call.argv.join(' '))).toEqual([
      'git ls-files -z -- src/a.cpp src/new_helper.cpp',
      'git restore --source=HEAD --staged --worktree -- src/a.cpp',
      'git clean -f -- src/new_helper.cpp',
    ])
  })

  it('runs nothing at all for an empty file list', async () => {
    const runner = fakeRunner([])
    await checkoutFiles(runner, 'D:/repo', [])
    expect(runner.calls).toEqual([])
  })

  it('fails loudly instead of reporting a rollback that did not happen', async () => {
    const runner = fakeRunner([
      ['git ls-files -z --', { stdout: 'src/a.cpp\u0000' }],
      ['git restore --source=HEAD', { exitCode: 1, stderr: 'error: could not restore' }],
    ])
    await expect(checkoutFiles(runner, 'D:/repo', ['src/a.cpp'])).rejects.toThrow(/could not restore/)
  })

  it('fails loudly when git will not even list the paths', async () => {
    const runner = fakeRunner([['git ls-files -z --', { exitCode: 128, stderr: 'fatal: not a git repository' }]])
    await expect(checkoutFiles(runner, 'D:/repo', ['src/a.cpp'])).rejects.toThrow(/not a git repository/)
  })
})

describe('readBaseline robustness', () => {
  it('refuses to read a timed-out status as a clean tree', async () => {
    const runner = fakeRunner([
      ['git rev-parse HEAD', { stdout: 'abc123\n' }],
      ['git rev-parse --abbrev-ref HEAD', { stdout: 'main\n' }],
      ['git status --porcelain', { exitCode: null, signal: 'SIGTERM', timedOut: true }],
    ])
    await expect(readBaseline(runner, 'D:/repo')).rejects.toThrow(/git status/)
  })

  it('refuses a truncated status capture even though it exited 0', async () => {
    const runner = fakeRunner([
      ['git rev-parse HEAD', { stdout: 'abc123\n' }],
      ['git rev-parse --abbrev-ref HEAD', { stdout: 'main\n' }],
      ['git status --porcelain', { lossy: true, stdout: ' M src/a.cpp' }],
    ])
    await expect(readBaseline(runner, 'D:/repo')).rejects.toThrow(/git status/)
  })

  it('refuses a status that failed for any other reason', async () => {
    const runner = fakeRunner([
      ['git rev-parse HEAD', { stdout: 'abc123\n' }],
      ['git rev-parse --abbrev-ref HEAD', { stdout: 'main\n' }],
      ['git status --porcelain', { exitCode: 128, stderr: 'fatal: bad revision' }],
    ])
    await expect(readBaseline(runner, 'D:/repo')).rejects.toThrow(/bad revision/)
  })
})
