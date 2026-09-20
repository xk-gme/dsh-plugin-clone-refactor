/**
 * Persisted job records: the only progress source that survives a reload.
 *
 * A job left `running` is an interrupted job, and the report says so. Anything
 * else would let a killed verification read as a passed one.
 */
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { readJson, writeAtomic, type RunPaths } from './artifacts.ts'

export const JOB_KINDS = ['scan', 'verify'] as const
export type JobKind = typeof JOB_KINDS[number]
export type JobStatus = 'running' | 'succeeded' | 'failed'

export interface JobRecord {
  job_id: string
  run_id: string
  kind: JobKind
  status: JobStatus
  started_at: string
  finished_at: string | null
  error: string | null
  summary: string
}

/** `<kind>-<YYYYMMDD-HHMMSS>-<4 hex>`: sortable, and obvious in a directory listing. */
export function newJobId(kind: JobKind, now: Date = new Date(), rand: () => number = Math.random): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0')
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`
    + `-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
  return `${kind}-${stamp}-${Math.floor(rand() * 0x10000).toString(16).padStart(4, '0')}`
}

function jobFile(paths: RunPaths, jobId: string): string {
  return join(paths.dir, 'jobs', `${jobId}.json`)
}

export async function loadJob(paths: RunPaths, jobId: string): Promise<JobRecord | undefined> {
  return await readJson<JobRecord>(jobFile(paths, jobId))
}

export async function saveJob(paths: RunPaths, job: JobRecord): Promise<void> {
  await writeAtomic(jobFile(paths, job.job_id), `${JSON.stringify(job, null, 2)}\n`)
}

/** Record a job as running before its work starts. */
export async function startJob(paths: RunPaths, runId: string, kind: JobKind, now: Date = new Date()): Promise<JobRecord> {
  const job: JobRecord = {
    job_id: newJobId(kind, now),
    run_id: runId,
    kind,
    status: 'running',
    started_at: now.toISOString(),
    finished_at: null,
    error: null,
    summary: '',
  }
  await saveJob(paths, job)
  return job
}

export async function finishJob(
  paths: RunPaths,
  job: JobRecord,
  status: Exclude<JobStatus, 'running'>,
  error: string | null,
  summary: string,
  now: Date = new Date(),
): Promise<JobRecord> {
  const finished: JobRecord = { ...job, status, error, summary, finished_at: now.toISOString() }
  await saveJob(paths, finished)
  return finished
}

/** The newest job of a run, by start time then id: what a poller reports. */
export async function latestJob(paths: RunPaths): Promise<JobRecord | undefined> {
  let names: string[]
  try {
    names = await readdir(join(paths.dir, 'jobs'))
  } catch (error) {
    // No job was ever recorded: the very first poll of a fresh run lands here.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const jobs = (await Promise.all(names.filter(name => name.endsWith('.json')).map(name => loadJob(paths, name.slice(0, -5)))))
    .filter((job): job is JobRecord => job !== undefined)
  if (jobs.length === 0) return undefined
  return jobs.sort((left, right) => (left.started_at === right.started_at
    ? left.job_id.localeCompare(right.job_id)
    : left.started_at.localeCompare(right.started_at))).at(-1)
}

/**
 * Await one task under an existing job record, writing the terminal status in
 * both directions. `detach` reuses it, so success and failure are recorded by
 * exactly one code path.
 */
async function settle<T>(paths: RunPaths, job: JobRecord, task: () => Promise<T>, summarize?: (value: T) => string): Promise<T> {
  try {
    const value = await task()
    await finishJob(paths, job, 'succeeded', null, summarize?.(value) ?? '')
    return value
  } catch (error) {
    await finishJob(paths, job, 'failed', error instanceof Error ? error.message : String(error), '')
      .catch(() => { /* best effort: the caller's log still carries the error */ })
    throw error
  }
}

/**
 * Hand a job's work to the background, so a tool call can return `accepted`
 * immediately. Every outcome — including a rejection — lands in the record,
 * because the tool call is over by the time it happens and `clone_check` is the
 * only thing that will ever look at it again.
 */
export function detach<T>(paths: RunPaths, job: JobRecord, task: () => Promise<T>, summarize?: (value: T) => string): void {
  void settle(paths, job, task, summarize).catch(() => { /* recorded above */ })
}
