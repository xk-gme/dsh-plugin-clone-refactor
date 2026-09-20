import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runPaths } from '../src/core/artifacts.ts'
import { runVerification, splitCommand } from '../src/verify/engine.ts'
import type { VerifyStep } from '../src/config.ts'
import { fakeRunner } from './fixtures/fake-runner.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()!() })

async function paths(): Promise<ReturnType<typeof runPaths>> {
  const root = await mkdtemp(join(tmpdir(), 'clone-engine-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  return runPaths(root, 'run-1')
}

function step(name: string, command: string, extra: Partial<VerifyStep> = {}): VerifyStep {
  return { name, phase: 'build', command, required: true, always: false, timeoutMs: 60_000, ...extra }
}

describe('runVerification', () => {
  it('passes when every required step exits zero and logs each one', async () => {
    const target = await paths()
    const runner = fakeRunner([['msbuild', { stdout: 'built\n' }], ['tests.exe', { stdout: 'ok\n' }]])
    const result = await runVerification({
      runner, paths: target, attempt: 1, cwd: 'D:/repo', signal: undefined, steps: [
        step('build', 'msbuild tests.sln'),
        step('test', 'tests.exe', { phase: 'test' }),
      ],
    })
    expect(result.ok).toBe(true)
    expect(result.steps.map(item => item.name)).toEqual(['build', 'test'])
    expect(result.rolled_back).toBe(false)
    const log = await readFile(join(target.verifyDir, '1', '1-build.log'), 'utf8')
    expect(log).toContain('msbuild tests.sln')
    expect(log).toContain('built')
    expect(log).toContain('exit_code: 0')
  })

  it('stops after a failed required step but still runs the always step', async () => {
    const target = await paths()
    const runner = fakeRunner([
      ['msbuild', { exitCode: 1, stderr: 'error C2065' }],
      ['restore.ps1', { stdout: 'restored\n' }],
    ])
    const result = await runVerification({
      runner, paths: target, attempt: 2, cwd: 'D:/repo', signal: undefined, steps: [
        step('build', 'msbuild tests.sln'),
        step('test', 'tests.exe', { phase: 'test' }),
        step('restore-config', 'restore.ps1', { phase: 'restore', required: true, always: true }),
      ],
    })
    expect(result.ok).toBe(false)
    expect(result.steps.map(item => item.name)).toEqual(['build', 'restore-config'])
    expect(result.steps[0]?.exit_code).toBe(1)
    expect(result.steps[0]?.ok).toBe(false)
    expect(result.steps[1]?.ok).toBe(true)
  })

  it('keeps ok true when a non-required step fails', async () => {
    const target = await paths()
    const runner = fakeRunner([['optional.exe', { exitCode: 3 }]])
    const result = await runVerification({
      runner, paths: target, attempt: 1, cwd: 'D:/repo', signal: undefined,
      steps: [step('optional', 'optional.exe', { required: false })],
    })
    expect(result.ok).toBe(true)
    expect(result.steps[0]?.ok).toBe(false)
  })

  it('marks a timed-out step and never reports it as success', async () => {
    const target = await paths()
    const runner = fakeRunner([['slow.exe', { exitCode: null, signal: 'SIGTERM', timedOut: true }]])
    const result = await runVerification({
      runner, paths: target, attempt: 1, cwd: 'D:/repo', signal: undefined, steps: [step('slow', 'slow.exe')],
    })
    expect(result.ok).toBe(false)
    expect(result.steps[0]?.timed_out).toBe(true)
  })

  it('records the lossy flag so a truncated log is never mistaken for a full one', async () => {
    const target = await paths()
    const runner = fakeRunner([['noisy.exe', { lossy: true, spillPath: 'D:/spill.txt' }]])
    const result = await runVerification({
      runner, paths: target, attempt: 1, cwd: 'D:/repo', signal: undefined, steps: [step('noisy', 'noisy.exe')],
    })
    expect(result.steps[0]?.lossy).toBe(true)
    const log = await readFile(join(target.verifyDir, '1', '1-noisy.log'), 'utf8')
    expect(log).toContain('spill: D:/spill.txt')
  })

  it('runs the steps in a caller-supplied work directory', async () => {
    const target = await paths()
    const runner = fakeRunner([['msbuild', {}]])
    await runVerification({ runner, paths: target, attempt: 1, cwd: 'D:/repo', signal: undefined, steps: [step('build', 'msbuild x.sln')] })
    expect(runner.calls[0]?.cwd).toBe('D:/repo')
  })
})

describe('splitCommand', () => {
  // This is the function that turns a configured command *string* into argv, so a
  // quoting bug here silently mis-invokes the build rather than failing loudly.
  it('splits on spaces and tabs and collapses runs of them', () => {
    expect(splitCommand('msbuild tests.sln /p:Configuration=Debug')).toEqual(['msbuild', 'tests.sln', '/p:Configuration=Debug'])
    expect(splitCommand('a\t\tb   c')).toEqual(['a', 'b', 'c'])
  })

  it('keeps a quoted segment together, which is the normal case for a Windows path', () => {
    expect(splitCommand('"C:\\Program Files\\msbuild.exe" /p:Configuration=Debug'))
      .toEqual(['C:\\Program Files\\msbuild.exe', '/p:Configuration=Debug'])
    expect(splitCommand("clang-format -i 'my file.cpp'")).toEqual(['clang-format', '-i', 'my file.cpp'])
  })

  it('returns nothing for an empty or blank command instead of one empty argument', () => {
    expect(splitCommand('')).toEqual([])
    expect(splitCommand('   ')).toEqual([])
  })

  it('pins the limitation: an opening quote with no close still yields the token', () => {
    // Not an escape-aware splitter: there is no way to embed a literal quote, and an
    // unterminated quote simply ends at the string's end. Pinned so a later change to
    // either behaviour is a deliberate one.
    expect(splitCommand('"unterminated')).toEqual(['unterminated'])
  })
})
