import { describe, expect, it } from 'vitest'
import { checkoutFiles, parseNameOnly, parsePorcelain, readBaseline } from '../src/git/baseline.ts'
import { normalizePath } from '../src/core/paths.ts'
import { reconcile } from '../src/git/reconcile.ts'
import { fakeRunner } from './fixtures/fake-runner.ts'

describe('git output parsing', () => {
  it('reads porcelain -z status as repo-relative forward-slash paths', () => {
    // `-z` records are NUL-separated and never C-quoted, so a path with a space or a
    // non-ASCII character arrives as the path itself. A rename record is the target
    // followed by a bare source record, which is not a path this status names.
    const text = ' M src/a.cpp\u0000'
      + '?? src/b.cpp\u0000'
      + 'R  new.cpp\u0000old.cpp\u0000'
      + ' M my file.cpp\u0000'
      + ' M uni-ünïcode.cpp\u0000'
      + ' M a -> b.md\u0000'
    expect(parsePorcelain(text)).toEqual([
      'src/a.cpp', 'src/b.cpp', 'new.cpp', 'my file.cpp', 'uni-ünïcode.cpp', 'a -> b.md',
    ])
  })

  it('reads a NUL-separated name-only diff, spaces and non-ASCII included', () => {
    expect(parseNameOnly('src/a.cpp\u0000module/laws/src/b.cpp\u0000my file.cpp\u0000uni-ünïcode.cpp\u0000'))
      .toEqual(['src/a.cpp', 'module/laws/src/b.cpp', 'my file.cpp', 'uni-ünïcode.cpp'])
    expect(parseNameOnly('')).toEqual([])
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
      ['git status --porcelain', { stdout: ' M src/a.cpp\u0000' }],
    ])
    const baseline = await readBaseline(runner, 'D:/repo')
    expect(baseline.head).toBe('abc123')
    expect(baseline.branch).toBe('main')
    expect(baseline.dirty).toEqual(['src/a.cpp'])
    // The status read is the one the parser above consumes: a non-`-z` read beside a
    // `-z` parser would silently report every space-bearing path as mangled.
    expect(runner.calls.map(call => call.argv.join(' '))).toContain('git status --porcelain -z')
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
      ['git --literal-pathspecs ls-files -z --', { stdout: 'src/a.cpp\u0000' }],
      ['git --literal-pathspecs restore --source=HEAD', {}],
      ['git --literal-pathspecs clean -f --', {}],
    ])
    await checkoutFiles(runner, 'D:/repo', ['src/a.cpp', 'src/new_helper.cpp'])
    expect(runner.calls.map(call => call.argv.join(' '))).toEqual([
      'git --literal-pathspecs ls-files -z -- src/a.cpp src/new_helper.cpp',
      'git --literal-pathspecs restore --source=HEAD --staged --worktree -- src/a.cpp',
      'git --literal-pathspecs clean -f -- src/new_helper.cpp',
    ])
  })

  it('never lets a ledger path widen into a pathspec', async () => {
    const runner = fakeRunner([
      ['git --literal-pathspecs ls-files -z --', { stdout: '\u0000' }],
      ['git --literal-pathspecs clean -f --', {}],
    ])
    // `files_changed` is model-supplied and reaches here through `normalizePath` and
    // nothing else. Without `--literal-pathspecs` a `*` widens `ls-files` to every
    // tracked file and `git clean` to everything untracked, so the partition that
    // makes the rollback safe would be decided by a glob. The option is the git-level
    // one (`git --literal-pathspecs <cmd>`): git accepts it nowhere else.
    await checkoutFiles(runner, 'D:/repo', ['*', 'src/?.cpp'])
    expect(runner.calls.map(call => call.argv.join(' '))).toEqual([
      'git --literal-pathspecs ls-files -z -- * src/?.cpp',
      'git --literal-pathspecs clean -f -- * src/?.cpp',
    ])
  })

  it('runs nothing at all for an empty file list', async () => {
    const runner = fakeRunner([])
    await checkoutFiles(runner, 'D:/repo', [])
    expect(runner.calls).toEqual([])
  })

  it('fails loudly instead of reporting a rollback that did not happen', async () => {
    const runner = fakeRunner([
      ['git --literal-pathspecs ls-files -z --', { stdout: 'src/a.cpp\u0000' }],
      ['git --literal-pathspecs restore --source=HEAD', { exitCode: 1, stderr: 'error: could not restore' }],
    ])
    await expect(checkoutFiles(runner, 'D:/repo', ['src/a.cpp'])).rejects.toThrow(/could not restore/)
  })

  it('fails loudly when git will not even list the paths', async () => {
    const runner = fakeRunner([['git --literal-pathspecs ls-files -z --', { exitCode: 128, stderr: 'fatal: not a git repository' }]])
    await expect(checkoutFiles(runner, 'D:/repo', ['src/a.cpp'])).rejects.toThrow(/not a git repository/)
  })

  it('refuses a truncated listing even though it exited 0', async () => {
    // A truncated `ls-files` misclassifies tracked files as "added by this run" and
    // hands them to `git clean`, which will not delete a tracked file and exits 0:
    // the rollback then records success over files it never restored.
    const runner = fakeRunner([['git --literal-pathspecs ls-files -z --', { lossy: true, stdout: 'src/a.cpp\u0000' }]])
    await expect(checkoutFiles(runner, 'D:/repo', ['src/a.cpp'])).rejects.toThrow(/src\/a\.cpp/)
  })

  it('refuses a timed-out listing even though it exited 0', async () => {
    const runner = fakeRunner([['git --literal-pathspecs ls-files -z --', { timedOut: true, stdout: 'src/a.cpp\u0000' }]])
    await expect(checkoutFiles(runner, 'D:/repo', ['src/a.cpp'])).rejects.toThrow(/src\/a\.cpp/)
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

  it('refuses a truncated HEAD read even though it exited 0', async () => {
    // Treating only the status read as untrustworthy was the bug: a truncated HEAD
    // yields a WRONG baseline identity that every later diff is measured against.
    const runner = fakeRunner([['git rev-parse HEAD', { lossy: true, stdout: 'abc1' }]])
    await expect(readBaseline(runner, 'D:/repo')).rejects.toThrow(/rev-parse HEAD/)
  })

  it('refuses a timed-out branch read even though it exited 0', async () => {
    const runner = fakeRunner([
      ['git rev-parse HEAD', { stdout: 'abc123\n' }],
      ['git rev-parse --abbrev-ref HEAD', { timedOut: true, stdout: 'mai' }],
    ])
    await expect(readBaseline(runner, 'D:/repo')).rejects.toThrow(/abbrev-ref HEAD/)
  })
})
