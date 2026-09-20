import { describe, expect, it } from 'vitest'
import { parseNameOnly, parsePorcelain, readBaseline } from '../src/git/baseline.ts'
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
