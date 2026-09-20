import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runPaths } from '../src/core/artifacts.ts'
import { detach, finishJob, latestJob, loadJob, newJobId, startJob, type JobRecord } from '../src/core/jobs.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()!() })

async function paths(): Promise<ReturnType<typeof runPaths>> {
  const root = await mkdtemp(join(tmpdir(), 'clone-jobs-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  return runPaths(root, 'run-1')
}

/**
 * A run whose `jobs/` path is a regular file: every job write fails before the
 * rename, which is how a persistent disk problem looks from `settle`.
 */
async function unpersistablePaths(): Promise<ReturnType<typeof runPaths>> {
  const target = await paths()
  await mkdir(target.dir, { recursive: true })
  await writeFile(join(target.dir, 'jobs'), 'not a directory', 'utf8')
  return target
}

/**
 * Wait for a condition instead of sleeping a fixed span (R8). A detached task has
 * no promise to await, so the only thing a test can observe is state; polling that
 * state is deterministic, while a constant sleep both slows the suite and turns the
 * measured 0–3 ms detach→hook latency into a machine-speed coin flip.
 */
async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean, label: string): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = await read()
    if (done(value)) return value
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${label}`)
}

/** A record whose job file can never be written, because `jobs/` is a file. */
function unwritableJob(): JobRecord {
  return {
    job_id: 'scan-unwritable', run_id: 'run-1', kind: 'scan', status: 'running',
    started_at: '2026-09-20T01:00:00.000Z', finished_at: null, error: null, summary: '',
  }
}

describe('job records', () => {
  it('builds a sortable id that names its kind', () => {
    expect(newJobId('verify', new Date('2026-09-20T01:02:03Z'), () => 0.5)).toBe('verify-20260920-010203-8000')
  })

  it('round-trips a running then finished job', async () => {
    const target = await paths()
    const job = await startJob(target, 'run-1', 'scan')
    expect(job.status).toBe('running')
    expect((await loadJob(target, job.job_id))?.status).toBe('running')
    await finishJob(target, job, 'succeeded', null, '12 clusters')
    const stored = await loadJob(target, job.job_id)
    expect(stored?.status).toBe('succeeded')
    expect(stored?.summary).toBe('12 clusters')
    expect(stored?.finished_at).not.toBeNull()
    expect((await latestJob(target))?.job_id).toBe(job.job_id)
  })

  it('returns undefined when no job was ever recorded', async () => {
    expect(await latestJob(await paths())).toBeUndefined()
    expect(await loadJob(await paths(), 'nope')).toBeUndefined()
  })

  it('reports the newest job by start time, then by id', async () => {
    const target = await paths()
    const older = await startJob(target, 'run-1', 'scan', new Date('2026-09-20T01:00:00Z'))
    const newer = await startJob(target, 'run-1', 'verify', new Date('2026-09-20T02:00:00Z'))
    expect((await latestJob(target))?.job_id).toBe(newer.job_id)

    // Two jobs that started in the same second are ordered by id, not by write order.
    const sameSecond = new Date('2026-09-20T03:00:00Z')
    const first = await startJob(target, 'run-1', 'scan', sameSecond)
    const second = await startJob(target, 'run-1', 'verify', sameSecond)
    const expected = [first.job_id, second.job_id, older.job_id].sort().at(-1)
    expect((await latestJob(target))?.job_id).toBe(expected)
  })

  it('polls past a corrupt job file instead of failing every read', async () => {
    const target = await paths()
    const good = await startJob(target, 'run-1', 'scan', new Date('2026-09-20T01:00:00Z'))
    // Disk damage or tampering: a `<id>.json` that is not JSON at all. `clone_check`
    // is the interface the plugin's own guidance polls, so one such file must not
    // turn every poll into an exception.
    const corrupt = 'scan-20260920-030000-aaaa.json'
    await writeFile(join(target.dir, 'jobs', corrupt), '{"job_id":', 'utf8')
    const unreadable: string[] = []
    expect((await latestJob(target, name => { unreadable.push(name) }))?.job_id).toBe(good.job_id)
    // Skipped, not silently dropped: the caller is told which file it could not read.
    expect(unreadable).toEqual([corrupt])
  })

  it('polls past a job file that is JSON but not a job record', async () => {
    const target = await paths()
    const good = await startJob(target, 'run-1', 'scan', new Date('2026-09-20T01:00:00Z'))
    // Parses fine, so it survives `readJson`, and then poisons the newest-by-start-time
    // sort: `{}.started_at` is undefined and `localeCompare` throws on it.
    const notARecord = 'verify-20260920-040000-bbbb.json'
    await writeFile(join(target.dir, 'jobs', notARecord), '{}\n', 'utf8')
    const unreadable: string[] = []
    expect((await latestJob(target, name => { unreadable.push(name) }))?.job_id).toBe(good.job_id)
    expect(unreadable).toEqual([notARecord])
  })
})

describe('detach', () => {
  it('records success and the summary a poller reads', async () => {
    const target = await paths()
    const job = await startJob(target, 'run-1', 'scan')
    detach(target, job, async () => 42, value => `answered ${String(value)}`)
    for (let attempt = 0; attempt < 50 && (await loadJob(target, job.job_id))?.status === 'running'; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    const stored = await loadJob(target, job.job_id)
    expect(stored?.status).toBe('succeeded')
    expect(stored?.summary).toBe('answered 42')
    expect((await latestJob(target))?.job_id).toBe(job.job_id)
  })

  it('records a detached failure without an unhandled rejection', async () => {
    const target = await paths()
    const job = await startJob(target, 'run-1', 'scan')
    detach(target, job, async () => { throw new Error('pipeline exploded') })
    // The record is written from a detached task, so poll rather than assume a tick.
    for (let attempt = 0; attempt < 50 && (await loadJob(target, job.job_id))?.status === 'running'; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    const stored = await loadJob(target, job.job_id)
    expect(stored?.status).toBe('failed')
    expect(stored?.error).toMatch(/pipeline exploded/)
  })
})

describe('a summarize that throws', () => {
  it('cannot reject a successful task or leave its record running', async () => {
    const target = await paths()
    const job = await startJob(target, 'run-1', 'scan')
    const notes: string[] = []
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    try {
      // `summarize` is caller-supplied: passing it straight to `finishJob` evaluated
      // it OUTSIDE the guarded region, so a throw escaped `settle`, skipped the hook
      // and left the record at `running` — the silent wedge, by another route.
      detach(target, job, async () => 42, () => { throw new Error('cannot render the summary') },
        info => { notes.push(info.note) })
      await waitFor(async () => (await loadJob(target, job.job_id))?.status, status => status !== 'running',
        'the terminal status of a task whose summarize threw')
      await new Promise(resolve => setTimeout(resolve, 0))
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
    const stored = await loadJob(target, job.job_id)
    expect(stored?.status).toBe('succeeded')
    expect(stored?.summary).toBe('')
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatch(/summar/)
    // A rejected `settle` here would be swallowed by `detach` and never observed,
    // which is exactly why the record and the hook, not the promise, are asserted.
    expect(unhandled).toEqual([])
  })
})

describe('a terminal write that cannot land', () => {
  it('reports the persistence failure to the caller instead of hiding it', async () => {
    const target = await unpersistablePaths()
    const failures: Array<{ job: string, message: string, note: string }> = []
    detach(target, unwritableJob(), async () => { throw new Error('pipeline exploded') },
      undefined, info => { failures.push({ job: info.job.job_id, message: info.error.message, note: info.note }) })
    await waitFor(async () => failures.length, length => length > 0, 'the persistence-failure hook')

    // The hook reports the write error, not the task error: the task's own
    // failure is already what the job record would have carried.
    expect(failures).toHaveLength(1)
    expect(failures[0]?.job).toBe('scan-unwritable')
    expect(failures[0]?.message).toMatch(/EEXIST/)
    expect(failures[0]?.note).toMatch(/stays running/)
    // Which branch fired decides what the note says, and a caller that only counted
    // the calls could not tell a failed terminal write from a successful one's.
    expect(failures[0]?.note).toMatch(/failed/)
  })

  it('reports a failure to record success too, not only a failed task', async () => {
    const target = await unpersistablePaths()
    const notes: string[] = []
    detach(target, unwritableJob(), async () => 42, () => 'answered 42', info => { notes.push(info.note) })
    await waitFor(async () => notes.length, length => length > 0, 'the success-path persistence failure')

    // The task succeeded, but the record still says running: the poller must be told.
    // The count alone is not enough — a relabelled success (reported with the
    // failure path's note) is exactly the defect this has to catch, so the branch
    // that fired is what gets asserted.
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatch(/stays running/)
    expect(notes[0]).toMatch(/succeeded/)
  })

  it('survives a persistent write failure without an unhandled rejection', async () => {
    const target = await unpersistablePaths()
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    try {
      // The hook is the only observable boundary of a detached task whose record
      // can never be written; waiting for it replaces the fixed sleep with the
      // task's own completion. A late rejection still gets its own turn below.
      const caught: string[] = []
      detach(target, unwritableJob(), async () => { throw new Error('pipeline exploded') },
        undefined, info => { caught.push(info.note) })
      await waitFor(async () => caught.length, length => length > 0, 'the failed terminal write')
      await new Promise(resolve => setTimeout(resolve, 0))
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
    expect(unhandled).toEqual([])
  })
})
