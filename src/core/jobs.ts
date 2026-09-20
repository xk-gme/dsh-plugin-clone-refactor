/**
 * Persisted job records: the only progress source that survives a reload.
 *
 * A job left `running` has no terminal record, and the report says so. There are
 * exactly two ways that happens: the run was interrupted, or the terminal status
 * could not be written — and a task that SUCCEEDED can leave the record at
 * `running`, because the failure of that write reaches the caller's
 * `onPersistFailure` hook instead of being discarded. Neither cause is a success;
 * anything else would let a killed verification read as a passed one.
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

/** What a caller learns when a job's terminal status could not be written. */
export interface PersistFailure {
  job: JobRecord
  /** The write error, never the task's own error. */
  error: Error
  /** What the stale record now claims, for a log line or a warning. */
  note: string
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

/**
 * Every readable job record of a run, oldest first. A `<id>.json` that cannot be
 * read as a record is skipped and named.
 */
async function readJobs(
  paths: RunPaths,
  onUnreadable?: (name: string, error: Error) => void,
): Promise<JobRecord[]> {
  let names: string[]
  try {
    names = await readdir(join(paths.dir, 'jobs'))
  } catch (error) {
    // No job was ever recorded: the very first poll of a fresh run lands here.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const jobs: JobRecord[] = []
  for (const name of names.filter(name => name.endsWith('.json'))) {
    let job: JobRecord | undefined
    try {
      job = asJobRecord(await loadJob(paths, name.slice(0, -5)))
    } catch (error) {
      // Disk damage or tampering. `clone_check` is the only progress interface this
      // plugin has, so one unreadable file may not turn every poll into an
      // exception: the run would become unobservable, which is worse than reporting
      // the newest READABLE record. The name still reaches the caller's hook.
      onUnreadable?.(name, asError(error))
      continue
    }
    if (job === undefined) {
      // Valid JSON, but not a record: `{}.started_at` would also break the sort below.
      onUnreadable?.(name, new Error(`${name} is not a job record`))
      continue
    }
    jobs.push(job)
  }
  return jobs.sort((left, right) => (left.started_at === right.started_at
    ? left.job_id.localeCompare(right.job_id)
    : left.started_at.localeCompare(right.started_at)))
}

/** The newest job of a run, by start time then id: what a poller reports. */
export async function latestJob(
  paths: RunPaths,
  /**
   * Called for a `<id>.json` that could not be read as a job record, so a skip is
   * visible rather than silent. A corrupt file is not dropped from the poll.
   */
  onUnreadable?: (name: string, error: Error) => void,
): Promise<JobRecord | undefined> {
  return (await readJobs(paths, onUnreadable)).at(-1)
}

/**
 * The newest VERIFY job of a run: what `clone_submit` binds a verification to.
 *
 * The job record is the durable terminal status, written on a path of its own
 * (`settle` → `finishJob`) and therefore independently of `result.json`. An attempt
 * that failed a required step but could not write its result still leaves this
 * record failed, and a submit gate that read only `result.json` saw the older,
 * passing attempt and accepted it.
 */
export async function latestVerifyJob(
  paths: RunPaths,
  onUnreadable?: (name: string, error: Error) => void,
): Promise<JobRecord | undefined> {
  return (await readJobs(paths, onUnreadable)).filter(job => job.kind === 'verify').at(-1)
}

/** The shape a job record must have for the sort above to be well defined. */
function asJobRecord(value: unknown): JobRecord | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const job = value as Partial<JobRecord>
  return typeof job.job_id === 'string' && typeof job.started_at === 'string' ? job as JobRecord : undefined
}

/** Any thrown value as an Error, so `PersistFailure` always carries one. */
function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

/**
 * Await one task under an existing job record, writing the terminal status in
 * both directions. `detach` reuses it, so success and failure are recorded by
 * exactly one code path.
 *
 * The record is written on a best-effort basis. If that write cannot land, the
 * task's own outcome still stands and still decides whether this call resolves
 * or rejects — a disk that refuses a bookkeeping update must not turn a
 * successful scan into a failure. `onPersistFailure` is how the caller learns
 * that the record now lies: the job stays `running` while its task has settled.
 */
async function settle<T>(
  paths: RunPaths,
  job: JobRecord,
  task: () => Promise<T>,
  summarize?: (value: T) => string,
  onPersistFailure?: (info: PersistFailure) => void,
): Promise<T> {
  let value: T
  try {
    value = await task()
  } catch (error) {
    await finishJob(paths, job, 'failed', error instanceof Error ? error.message : String(error), '')
      .catch((writeError: unknown) => onPersistFailure?.({
        job,
        error: asError(writeError),
        note: 'the job stays running although its task failed',
      }))
    throw error
  }
  // Success is reported the same way: swallowing this would leave a finished
  // job's on-disk record still claiming `running`, so a poller could not tell a
  // settled task from an unsettled one.
  //
  // `summarize` is evaluated HERE, inside the guarded region, and not as an argument
  // to `finishJob`: as an argument it ran before the call, so a throw escaped `settle`
  // — rejecting a task that had actually succeeded, skipping the hook, and leaving
  // the record at `running`. That is the same silent wedge by another route. Failing
  // to render the summary is a failure to persist part of this record, so it goes to
  // the same hook, and the terminal status is written anyway.
  let summary = ''
  try {
    summary = summarize?.(value) ?? ''
  } catch (error) {
    onPersistFailure?.({
      job,
      error: asError(error),
      note: 'the job succeeded but its summary could not be rendered; its terminal status was written without one',
    })
  }
  await finishJob(paths, job, 'succeeded', null, summary)
    .catch((writeError: unknown) => onPersistFailure?.({
      job,
      error: asError(writeError),
      note: 'the job stays running although its task succeeded',
    }))
  return value
}

/**
 * Hand a job's work to the background, so a tool call can return `accepted`
 * immediately. Every outcome — including a rejection — lands in the record,
 * because the tool call is over by the time it happens and `clone_check` is the
 * only thing that will ever look at it again.
 *
 * Best-effort contract, and its limits. `detach` returns `void` at the moment
 * the work starts, so it cannot report a later persistence failure to the
 * caller, and it never rejects: an unhandled rejection here would crash a
 * process whose tool call already returned. It therefore swallows the task's
 * rejection on purpose — that rejection is the task's normal failure signal and
 * is already recorded as `failed`. What it does not swallow is the write of the
 * terminal status: the optional `onPersistFailure` hook receives that error so
 * the caller can put it somewhere durable. Without the hook the failure is
 * dropped, and the on-disk record keeps claiming `running`; passing a hook is
 * the difference between that and knowing why.
 */
export function detach<T>(
  paths: RunPaths,
  job: JobRecord,
  task: () => Promise<T>,
  summarize?: (value: T) => string,
  onPersistFailure?: (info: PersistFailure) => void,
): void {
  void settle(paths, job, task, summarize, onPersistFailure)
    .catch(() => { /* the task's own rejection: recorded as failed above */ })
}
