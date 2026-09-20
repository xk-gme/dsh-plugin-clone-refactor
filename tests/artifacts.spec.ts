import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, open, readFile, readdir, rm } from 'node:fs/promises'
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
    // The temp name is `${file}.${pid}.${n}.tmp`, so reading a fixed `<file>.tmp`
    // could never fail and pinned nothing. The listing is the assertion that can:
    // the target is the only file the write left behind.
    expect(await readdir(join(root, 'nested'))).toEqual(['run.json'])
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

  it('refuses a value that does not serialize instead of writing the line "undefined"', async () => {
    const root = await tempRoot()
    const file = join(root, 'assessments.jsonl')
    await appendJsonl(file, { id: 'C001' })
    // `JSON.stringify(undefined)` is `undefined`, not a string, so the old template
    // wrote the literal line `undefined`: a durable record no reader can consume.
    await expect(appendJsonl(file, undefined)).rejects.toThrow(/serialize/)
    expect(await readFile(file, 'utf8')).toBe('{"id":"C001"}\n')
    const read = await readJsonl<{ id: string }>(file)
    expect(read.records.map(item => item.id)).toEqual(['C001'])
    expect(read.droppedLines).toEqual([])
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
    // One stable error instance across every attempt: the caller must see the error
    // the rename actually raised, not a look-alike carrying the same `.code`.
    const original = Object.assign(new Error('EPERM: the same rename error every attempt'), { code: 'EPERM' })
    let calls = 0
    const always = async (): Promise<void> => { calls += 1; throw original }
    const sleeps: number[] = []
    const caught = await renameWithRetry('from', 'to', always, async ms => { sleeps.push(ms) })
      .then(() => undefined, (error: unknown) => error)
    expect(caught).toBe(original)
    expect((caught as NodeJS.ErrnoException).code).toBe('EPERM')
    expect(calls).toBe(10)
    // 5 + 10 + 20 + 40 + 80 + 160 + 320 + 320 + 320: capped, bounded, still brief.
    expect(sleeps).toHaveLength(calls - 1)
    expect(sleeps.at(-1)).toBe(320)
    expect(sleeps.reduce((total, ms) => total + ms, 0)).toBeLessThanOrEqual(1300)
  })
})

describe('a concurrent reader holding the target', () => {
  /**
   * The whole budget `renameWithRetry` spends before it gives up:
   * 5 + 10 + 20 + 40 + 80 + 160 + 320 + 320 + 320 = 1_275 ms.
   *
   * That budget is a claim about the READER: a hold shorter than this window can
   * never exhaust it, because once the reader releases the target some later attempt
   * must succeed. A single hold that outlasts the whole window — a release timer
   * delayed past every attempt — is the documented residual of a bounded retry, and
   * the only escape admitted below.
   */
  const RETRY_WINDOW_MS = 1_275

  /**
   * How long the reader keeps its handle on the target for each write.
   *
   * This is the property the retry rests on, so the test states it instead of hoping
   * a free-running poll loop happens to be paced fast enough: the reader TAKES the
   * target, the write's first rename attempt collides with that open handle, and the
   * reader RELEASES it well inside the retry window so a later attempt lands.
   *
   * That coordination is what makes the test load-insensitive. A poll loop holds the
   * target for as long as `readFile` takes, which on a loaded machine is unbounded,
   * and a reader that holds (or immediately re-opens) through all ten attempts
   * defeats any bounded retry — that is how this test failed once in a full-suite
   * run. With one bounded hold per write there is exactly one colliding attempt to
   * recover from, and recovering is the only thing being asserted.
   */
  const READER_HOLD_MS = 25

  /**
   * Each iteration costs one hold, so the count is paid for in wall-clock time, not
   * in red power: the coordination makes a lost retry fail on the FIRST iteration (a
   * bare rename collides immediately), and repeating it pins that many serial writes
   * in a row all survive. 40 x 25 ms keeps the test near a second.
   */
  const WRITES = 40

  it('never fails a write with a transient rename errno', async () => {
    const root = await tempRoot()
    const file = join(root, 'scan-1.json')
    await writeAtomic(file, '{"status":"running"}')

    // The reporter's race at suite scale: a writer persisting one record after
    // another while a poller reads that same record, one write at a time — which is
    // how a job record is actually rewritten.
    const escapes: Array<{ code: string, heldMs: number }> = []
    const unattributable: unknown[] = []
    for (let index = 0; index < WRITES; index += 1) {
      const record = JSON.stringify({ status: index % 2 === 0 ? 'succeeded' : 'failed', n: index })
      const reader = await open(file, 'r')
      const holdStart = performance.now()
      // Deliberately not awaited here: its first rename attempt must collide with the
      // open handle above. The rejection is turned into a value immediately so the
      // gap until it is awaited cannot surface as an unhandled rejection.
      const settled = writeAtomic(file, record).then(() => undefined, (error: unknown) => error)
      await new Promise(resolve => setTimeout(resolve, READER_HOLD_MS))
      await reader.readFile('utf8')
      await reader.close()
      const heldMs = performance.now() - holdStart
      const error = await settled
      if (error === undefined) continue
      const code = (error as NodeJS.ErrnoException).code ?? 'none'
      if (!TRANSIENT_RENAME_CODES.includes(code)) throw error
      // A hold shorter than the retry window cannot explain an exhausted retry: the
      // write's attempts continue for ~1.275 s after the hold began, so once this
      // reader released, a later attempt had to succeed. Anything else is a lost
      // retry and must fail here.
      if (heldMs < RETRY_WINDOW_MS) unattributable.push(error)
      else escapes.push({ code, heldMs })
    }

    // A lost retry — the failure this test exists to catch — is asserted as empty
    // rather than tolerated. A non-empty `escapes` is the documented residual of a
    // bounded retry, and only a hold that outlasted the entire window may land there.
    expect(unattributable).toEqual([])
    expect(escapes.every(escape => escape.heldMs >= RETRY_WINDOW_MS)).toBe(true)
    expect(JSON.parse(await readFile(file, 'utf8'))).toHaveProperty('status')
    expect((await readdir(root)).filter(name => name.endsWith('.tmp'))).toEqual([])
  })
})
