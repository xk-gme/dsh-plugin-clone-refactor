import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertInsideRoot, defaultArtifactsRoot, dshHome, newRunId, readJson, renameWithRetry, runPaths, writeAtomic,
} from '../src/core/artifacts.ts'
import { appendJsonl, readJsonl } from '../src/core/jsonl.ts'

/** A rename that fails with a chosen errno for the first `failures` calls. */
function flakyRename(failures: number, code: string): { calls: number, rename: (from: string, to: string) => Promise<void> } {
  const state = {
    calls: 0,
    rename: async (): Promise<void> => {
      state.calls += 1
      if (state.calls <= failures) {
        const error = new Error(`${code}: flaky rename`) as NodeJS.ErrnoException
        error.code = code
        throw error
      }
    },
  }
  return state
}

/** Errors a rename may hit when another handle holds the target; retrying can fix these. */
const TRANSIENT_RENAME_CODES = ['EPERM', 'EACCES', 'EBUSY']

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()!() })

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'clone-artifacts-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

describe('run paths', () => {
  it('derives every artifact path from the run id', () => {
    const paths = runPaths('D:/runs', 'run-1')
    expect(paths.dir.replaceAll('\\', '/')).toBe('D:/runs/run-1')
    expect(paths.clusters.endsWith('clusters.jsonl')).toBe(true)
    expect(paths.assessments.endsWith('assessments.jsonl')).toBe(true)
    expect(paths.patches.endsWith('patches.json')).toBe(true)
    expect(paths.runJson.endsWith('run.json')).toBe(true)
    expect(paths.reportMd.endsWith('report.md')).toBe(true)
  })

  it('refuses a run id that escapes the artifacts root', () => {
    expect(() => assertInsideRoot('D:/runs', '../evil')).toThrow(/escapes/)
    expect(() => assertInsideRoot('D:/runs', 'a/b')).toThrow(/escapes/)
    expect(() => assertInsideRoot('D:/runs', '..')).toThrow(/escapes/)
    expect(() => assertInsideRoot('D:/runs', 'ok-run.1')).not.toThrow()
  })

  it('defaults the artifacts root under DSH home', () => {
    expect(dshHome({ DSH_HOME: 'D:/home' })).toBe('D:/home')
    expect(defaultArtifactsRoot({ DSH_HOME: 'D:/home' }).replaceAll('\\', '/'))
      .toBe('D:/home/gme-clone-refactor/runs')
  })

  it('builds a sortable, unique run id', () => {
    const id = newRunId(new Date('2026-09-20T01:02:03Z'), () => 0.5)
    expect(id).toBe('20260920-010203-8000')
    expect(newRunId()).not.toBe(newRunId())
  })
})

describe('atomic writes and JSONL', () => {
  it('writes through a temp file and leaves no temp behind', async () => {
    const root = await tempRoot()
    const file = join(root, 'nested', 'run.json')
    await writeAtomic(file, '{"a":1}')
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ a: 1 })
    await expect(readFile(`${file}.tmp`, 'utf8')).rejects.toThrow()
  })

  it('reads a missing JSON file as undefined and rejects malformed JSON', async () => {
    const root = await tempRoot()
    expect(await readJson(join(root, 'absent.json'))).toBeUndefined()
    await writeAtomic(join(root, 'bad.json'), '{oops')
    await expect(readJson(join(root, 'bad.json'))).rejects.toThrow()
  })

  it('appends one record per line and reports torn lines instead of guessing', async () => {
    const root = await tempRoot()
    const file = join(root, 'clusters.jsonl')
    await appendJsonl(file, { id: 'C001' })
    await appendJsonl(file, { id: 'C002' })
    const read = await readJsonl<{ id: string }>(file)
    expect(read.records.map(item => item.id)).toEqual(['C001', 'C002'])
    expect(read.droppedLines).toEqual([])
    // A torn write is dropped and reported, never repaired silently.
    await writeAtomic(file, '{"id":"C001"}\n{broken\n\n{"id":"C003"}\n')
    const torn = await readJsonl<{ id: string }>(file)
    expect(torn.records.map(item => item.id)).toEqual(['C001', 'C003'])
    expect(torn.droppedLines).toEqual([2])
  })

  it('writes concurrently to one target without leaving a temp file behind', async () => {
    const root = await tempRoot()
    const file = join(root, 'run.json')
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    try {
      await Promise.all(Array.from({ length: 8 }, async (_value, index) => {
        await writeAtomic(file, JSON.stringify({ writer: index }))
      }))
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
    expect(unhandled).toEqual([])
    expect(JSON.parse(await readFile(file, 'utf8'))).toHaveProperty('writer')
    // A fixed `<file>.tmp` name would let one writer rename another's temp away.
    expect((await readdir(root)).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('removes its temp file when the write cannot land', async () => {
    const root = await tempRoot()
    // A directory where the target should be: the rename can never succeed, so
    // the failure path runs and must not leave a temp file in the listing.
    const file = join(root, 'occupied')
    await mkdir(file, { recursive: true })
    await expect(writeAtomic(file, '{"a":1}')).rejects.toThrow()
    expect((await readdir(root)).filter(name => name.endsWith('.tmp'))).toEqual([])
  })
})

describe('renameWithRetry', () => {
  it('retries a transient errno and resolves once the rename succeeds', async () => {
    const flaky = flakyRename(2, 'EPERM')
    const sleeps: number[] = []
    await renameWithRetry('from', 'to', flaky.rename, async ms => { sleeps.push(ms) })

    expect(flaky.calls).toBe(3)
    expect(sleeps).toEqual([5, 10])
  })

  it('propagates a non-transient error on the first attempt', async () => {
    const missing = flakyRename(Number.POSITIVE_INFINITY, 'ENOENT')
    await expect(renameWithRetry('from', 'to', missing.rename, async () => {})).rejects.toMatchObject({ code: 'ENOENT' })
    expect(missing.calls).toBe(1)
  })

  it('throws the original error when the transient failures never clear', async () => {
    const always = flakyRename(Number.POSITIVE_INFINITY, 'EPERM')
    const sleeps: number[] = []
    await expect(renameWithRetry('from', 'to', always.rename, async ms => { sleeps.push(ms) }))
      .rejects.toMatchObject({ code: 'EPERM' })
    expect(always.calls).toBe(10)
    // 5 + 10 + 20 + 40 + 80 + 160 + 320 + 320 + 320: capped, bounded, still brief.
    expect(sleeps).toHaveLength(always.calls - 1)
    expect(sleeps.at(-1)).toBe(320)
    expect(sleeps.reduce((total, ms) => total + ms, 0)).toBeLessThanOrEqual(1300)
  })
})

describe('a concurrent reader holding the target', () => {
  it('never fails a write with a transient rename errno', async () => {
    const root = await tempRoot()
    const file = join(root, 'scan-1.json')
    await writeAtomic(file, '{"status":"running"}')

    // The reporter's race at suite scale: a writer persisting one record after
    // another while the poller reads that same record. Both sides are paced the
    // way production paces them — one write at a time, a poll every tick — so the
    // reader holds no handle in between. The writes are serial, which is how a
    // job record is actually rewritten, and that is what keeps the bounded
    // backoff sufficient. Without the retry the measured failure rate is ~16% per
    // write, so 150 iterations fail a regression with probability ~1 - 0.84^150;
    // the whole run still costs about a second.
    let stop = false
    const reader = (async () => {
      while (!stop) {
        await readFile(file, 'utf8').catch(() => undefined)
        await new Promise(resolve => setTimeout(resolve, 1))
      }
    })()
    await new Promise(resolve => setTimeout(resolve, 5))

    const transients = new Map<string, number>()
    try {
      for (let index = 0; index < 150; index += 1) {
        const record = JSON.stringify({ status: index % 2 === 0 ? 'succeeded' : 'failed', n: index })
        try {
          await writeAtomic(file, record)
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code ?? 'none'
          if (TRANSIENT_RENAME_CODES.includes(code)) transients.set(code, (transients.get(code) ?? 0) + 1)
          else throw error
        }
      }
    } finally {
      stop = true
      await reader
    }

    expect([...transients]).toEqual([])
    expect(JSON.parse(await readFile(file, 'utf8'))).toHaveProperty('status')
    expect((await readdir(root)).filter(name => name.endsWith('.tmp'))).toEqual([])
  })
})
