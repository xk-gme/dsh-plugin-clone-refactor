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

async function settled(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 50))
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

describe('a terminal write that cannot land', () => {
  it('reports the persistence failure to the caller instead of hiding it', async () => {
    const target = await unpersistablePaths()
    const failures: Array<{ job: string, message: string, note: string }> = []
    detach(target, unwritableJob(), async () => { throw new Error('pipeline exploded') },
      undefined, info => { failures.push({ job: info.job.job_id, message: info.error.message, note: info.note }) })
    await settled()

    // The hook reports the write error, not the task error: the task's own
    // failure is already what the job record would have carried.
    expect(failures).toHaveLength(1)
    expect(failures[0]?.job).toBe('scan-unwritable')
    expect(failures[0]?.message).toMatch(/EEXIST/)
    expect(failures[0]?.note).toMatch(/stays running/)
  })

  it('reports a failure to record success too, not only a failed task', async () => {
    const target = await unpersistablePaths()
    let reported = 0
    detach(target, unwritableJob(), async () => 42, () => 'answered 42', () => { reported += 1 })
    await settled()

    // The task succeeded, but the record still says running: the poller must be told.
    expect(reported).toBe(1)
  })

  it('survives a persistent write failure without an unhandled rejection', async () => {
    const target = await unpersistablePaths()
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    try {
      detach(target, unwritableJob(), async () => { throw new Error('pipeline exploded') })
      await settled()
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
    expect(unhandled).toEqual([])
  })
})
