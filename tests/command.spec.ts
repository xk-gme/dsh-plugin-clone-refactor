import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type {
  SubprocessHandle, SubprocessOutcome, SubprocessOutputRead, SubprocessOutputReader,
  SubprocessRuntime, SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { EXIT_NOT_RUN, type CommandRequest } from '../src/core/command.ts'
import { hasSubprocess, hostRunner } from '../src/core/command-host.ts'
import { fakeRunner } from './fixtures/fake-runner.ts'

describe('fakeRunner', () => {
  it('answers by argv prefix and records every call', async () => {
    const runner = fakeRunner([['git status --porcelain', { stdout: ' M src/a.cpp\n' }]])
    const result = await runner.run({ argv: ['git', 'status', '--porcelain'], cwd: 'D:/repo', timeoutMs: 1000, signal: undefined })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe(' M src/a.cpp\n')
    expect(runner.calls).toEqual([{ argv: ['git', 'status', '--porcelain'], cwd: 'D:/repo' }])
    expect(runner.matched).toEqual(['git status --porcelain'])
  })

  it('returns exit 127 for an unscripted command instead of throwing', async () => {
    const runner = fakeRunner([])
    const result = await runner.run({ argv: ['msbuild', 'tests.sln'], cwd: 'D:/repo', timeoutMs: 1000, signal: undefined })
    expect(result.exitCode).toBe(127)
    expect(result.stderr).toMatch(/no scripted answer/)
  })
})

/** One collected-stream reader as the host exposes it after settlement. */
function reader(text: string, lossy = false, spillPath?: string): SubprocessOutputReader {
  return {
    readFrom: (): SubprocessOutputRead => ({
      text,
      nextOffset: text.length,
      lossy,
      ...(spillPath === undefined ? {} : { spillPath }),
    }),
  }
}

/** A handle over one scripted outcome and two collected streams. */
function handle(
  outcome: SubprocessOutcome | Promise<SubprocessOutcome>,
  stdout?: SubprocessOutputReader,
  stderr?: SubprocessOutputReader,
): SubprocessHandle {
  return {
    collected: {
      ...(stdout === undefined ? {} : { stdout }),
      ...(stderr === undefined ? {} : { stderr }),
    },
    done: Promise.resolve(outcome),
  } as unknown as SubprocessHandle
}

/** The host's subprocess service, scripted per test. */
function service(spec: {
  resolveExecutable?: (command: string) => Promise<string>
  spawn?: (spawnSpec: SubprocessSpawnSpec) => SubprocessHandle
} = {}): SubprocessRuntime {
  return {
    resolveExecutable: spec.resolveExecutable ?? (async (command: string) => `D:/bin/${command}.exe`),
    spawn: spec.spawn ?? ((): SubprocessHandle => handle({ exitCode: 0, signal: null })),
  } as unknown as SubprocessRuntime
}

/** A context whose only interesting service is subprocess. */
function contextWith(subprocess: SubprocessRuntime | undefined): Context {
  return { get: () => subprocess } as unknown as Context
}

const DEFAULTS = { maxBytes: 4096, graceMs: 250 }

function request(argv: readonly string[], signal: AbortSignal | undefined = undefined): CommandRequest {
  return { argv, cwd: 'D:/repo', timeoutMs: 5_000, signal }
}

describe('hostRunner', () => {
  it('reports a deployment with no subprocess provider instead of throwing', async () => {
    const ctx = contextWith(undefined)
    expect(hasSubprocess(ctx)).toBe(false)
    const result = await hostRunner(ctx, DEFAULTS).run(request(['git', 'status']))
    expect(result.exitCode).toBe(EXIT_NOT_RUN)
    expect(result.stderr).toMatch(/no subprocess provider/)
    expect(result.argv).toEqual(['git', 'status'])
    expect(result.cwd).toBe('D:/repo')
    expect(result.timedOut).toBe(false)
  })

  it('reports an empty command instead of throwing', async () => {
    const ctx = contextWith(service())
    expect(hasSubprocess(ctx)).toBe(true)
    const runner = hostRunner(ctx, DEFAULTS)
    const emptyArgv = await runner.run(request([]))
    expect(emptyArgv.exitCode).toBe(EXIT_NOT_RUN)
    expect(emptyArgv.stderr).toBe('The command is empty.')
    const emptyName = await runner.run(request(['']))
    expect(emptyName.exitCode).toBe(EXIT_NOT_RUN)
    expect(emptyName.stderr).toBe('The command is empty.')
  })

  it('reports an unresolvable executable instead of throwing', async () => {
    const ctx = contextWith(service({ resolveExecutable: async () => { throw new Error('ENOENT') } }))
    const result = await hostRunner(ctx, DEFAULTS).run(request(['msbuild', 'tests.sln']))
    expect(result.exitCode).toBe(EXIT_NOT_RUN)
    expect(result.stderr).toBe('Cannot resolve msbuild: ENOENT')
  })

  it('reports a synchronous spawn failure instead of throwing', async () => {
    const ctx = contextWith(service({ spawn: () => { throw new Error('EPERM') } }))
    const result = await hostRunner(ctx, DEFAULTS).run(request(['cl.exe', '/nologo']))
    expect(result.exitCode).toBe(EXIT_NOT_RUN)
    expect(result.stderr).toBe('Cannot start cl.exe: EPERM')
  })

  it('reports an outcome promise that rejects instead of throwing', async () => {
    const ctx = contextWith(service({ spawn: () => handle(Promise.reject(new Error('spawn-level failure'))) }))
    const result = await hostRunner(ctx, DEFAULTS).run(request(['cl.exe']))
    expect(result.exitCode).toBe(EXIT_NOT_RUN)
    expect(result.stderr).toBe('Subprocess failed before reporting an outcome: spawn-level failure')
  })

  it('resolves the executable, then forwards the exit facts and the host output', async () => {
    const specs: SubprocessSpawnSpec[] = []
    const ctx = contextWith(service({
      resolveExecutable: async () => 'D:/bin/git.exe',
      spawn: (spawnSpec) => {
        specs.push(spawnSpec)
        return handle({ exitCode: 1, signal: null }, reader(' M src/a.cpp\n'), reader('warning\n', true, 'D:/spill.txt'))
      },
    }))
    const result = await hostRunner(ctx, DEFAULTS).run(request(['git', 'status', '--porcelain']))
    expect(specs[0]?.argv).toEqual(['D:/bin/git.exe', 'status', '--porcelain'])
    expect(specs[0]?.cwd).toBe('D:/repo')
    expect(specs[0]?.stdio).toEqual({ stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } })
    expect(specs[0]?.graceMs).toBe(250)
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe(' M src/a.cpp\n')
    expect(result.stderr).toBe('warning\n')
    expect(result.lossy).toBe(true)
    expect(result.spillPath).toBe('D:/spill.txt')
    expect(result.timedOut).toBe(false)
  })

  it('reports our own deadline as a timeout', async () => {
    const ctx = contextWith(service({
      spawn: (spawnSpec) => handle(new Promise<SubprocessOutcome>((resolve) => {
        spawnSpec.signal?.addEventListener('abort', () => resolve({ exitCode: null, signal: 'SIGTERM' }))
      })),
    }))
    const result = await hostRunner(ctx, DEFAULTS).run({ ...request(['slow.exe']), timeoutMs: 5 })
    expect(result.exitCode).toBeNull()
    expect(result.signal).toBe('SIGTERM')
    expect(result.timedOut).toBe(true)
  })

  it('classifies a deadline that fired together with a caller cancellation as a cancellation', async () => {
    const controller = new AbortController()
    const ctx = contextWith(service({
      spawn: (spawnSpec) => handle(new Promise<SubprocessOutcome>((resolve) => {
        const stop = (): void => {
          // The caller cancels in the same instant our own deadline fires.
          controller.abort()
          resolve({ exitCode: null, signal: 'SIGTERM' })
        }
        if (spawnSpec.signal?.aborted === true) stop()
        else spawnSpec.signal?.addEventListener('abort', stop)
      })),
    }))
    const result = await hostRunner(ctx, DEFAULTS)
      .run({ ...request(['slow.exe'], controller.signal), timeoutMs: 5 })
    expect(result.exitCode).toBeNull()
    expect(result.timedOut).toBe(false)
  })

  it('reports a caller cancellation as a cancellation, not a timeout', async () => {
    const ctx = contextWith(service({
      spawn: (spawnSpec) => handle(new Promise<SubprocessOutcome>((resolve) => {
        const stop = (): void => resolve({ exitCode: null, signal: 'SIGTERM' })
        // The caller may already have aborted before the child started.
        if (spawnSpec.signal?.aborted === true) stop()
        else spawnSpec.signal?.addEventListener('abort', stop)
      })),
    }))
    const controller = new AbortController()
    const pending = hostRunner(ctx, DEFAULTS).run(request(['slow.exe'], controller.signal))
    controller.abort()
    const result = await pending
    expect(result.exitCode).toBeNull()
    expect(result.signal).toBe('SIGTERM')
    expect(result.timedOut).toBe(false)
  })
})
