/** Verification attempt records on disk: the evidence `clone_submit` checks. */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { readJson, type RunPaths } from '../core/artifacts.ts'
import type { ReconcileAudit, VerifyResult } from '../core/schema.ts'

/**
 * Called for a verify record that exists but could not be read, so a skip is
 * visible rather than silent.
 *
 * The rule is `latestJob`'s, for the same reason: `clone_check` is the only
 * progress interface this plugin has, so one damaged file may not turn every poll
 * into an exception — and `clone_report` and `clone_submit`'s own refusal read the
 * same records through the same readers. The name is the path as a reader of the
 * run directory sees it: `verify/2/result.json`.
 */
export type UnreadableRecord = (name: string, error: Error) => void

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

/** A record's name as the report and the refusal render it, relative to the run. */
function recordName(attempt: number, file: string): string {
  return `verify/${attempt}/${file}`
}

/**
 * The numeric attempt directories, ascending.
 *
 * The DIRECTORY is the attempt's identity, not the `attempt` field inside it: a
 * killed attempt has an empty-by-result directory and no result.json at all, and it
 * still owns its number.
 */
async function attemptNumbers(paths: RunPaths): Promise<number[]> {
  const names = await readdir(paths.verifyDir).catch(() => [])
  return names.filter(name => /^\d+$/.test(name)).map(Number).sort((left, right) => left - right)
}

/** The highest attempt directory; `undefined` when no attempt has been recorded. */
export async function newestAttemptNumber(paths: RunPaths): Promise<number | undefined> {
  return (await attemptNumbers(paths)).at(-1)
}

/**
 * The number the NEXT attempt must take: one past the highest attempt directory.
 *
 * Counting result.json files instead reuses the number of an attempt killed before
 * its result write, which overwrites that attempt's step logs and reconcile.json —
 * destroying the very evidence the neighbour of this computation preserves.
 */
export async function nextAttemptNumber(paths: RunPaths): Promise<number> {
  return ((await newestAttemptNumber(paths)) ?? 0) + 1
}

/** The shape a verify result must have for the readers below to be well defined. */
function asVerifyResult(value: unknown): VerifyResult | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const result = value as Partial<VerifyResult>
  return typeof result.attempt === 'number' && typeof result.ok === 'boolean' ? result as VerifyResult : undefined
}

/** The shape a reconcile audit must have: four arrays, or it is not one. */
function asReconcileAudit(value: unknown): ReconcileAudit | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const audit = value as Partial<ReconcileAudit>
  const arrays = [audit.authorized, audit.changed, audit.unauthorized, audit.missing]
  return arrays.every(entry => Array.isArray(entry)) ? audit as ReconcileAudit : undefined
}

/**
 * Every readable attempt, oldest first. A damaged or unshapeable `result.json` is
 * skipped and named, never an exception.
 */
export async function loadVerifyAttempts(paths: RunPaths, onUnreadable?: UnreadableRecord): Promise<VerifyResult[]> {
  const found: Array<{ attempt: number, result: VerifyResult }> = []
  for (const attempt of await attemptNumbers(paths)) {
    const file = join(paths.verifyDir, String(attempt), 'result.json')
    let parsed: unknown
    try {
      parsed = await readJson(file)
    } catch (error) {
      onUnreadable?.(recordName(attempt, 'result.json'), asError(error))
      continue
    }
    // A missing file is an attempt that never finished, which the gate refuses on its
    // own terms; only a file that EXISTS and cannot be consumed is damage.
    if (parsed === undefined) continue
    const result = asVerifyResult(parsed)
    if (result === undefined) {
      onUnreadable?.(recordName(attempt, 'result.json'), new Error(`${recordName(attempt, 'result.json')} is not a verification result`))
      continue
    }
    found.push({ attempt, result })
  }
  return found.sort((left, right) => left.attempt - right.attempt).map(entry => entry.result)
}

/** Every attempt's reconcile audit, keyed by attempt number. */
export async function loadReconcileAudits(paths: RunPaths, onUnreadable?: UnreadableRecord): Promise<Map<number, ReconcileAudit>> {
  const audits = new Map<number, ReconcileAudit>()
  for (const attempt of await attemptNumbers(paths)) {
    const file = join(paths.verifyDir, String(attempt), 'reconcile.json')
    let parsed: unknown
    try {
      parsed = await readJson(file)
    } catch (error) {
      onUnreadable?.(recordName(attempt, 'reconcile.json'), asError(error))
      continue
    }
    if (parsed === undefined) continue
    const audit = asReconcileAudit(parsed)
    if (audit === undefined) {
      onUnreadable?.(recordName(attempt, 'reconcile.json'), new Error(`${recordName(attempt, 'reconcile.json')} is not a reconcile audit`))
      continue
    }
    audits.set(attempt, audit)
  }
  return audits
}

export interface UnauthorizedRead {
  /** The newest attempt's unauthorized list: the freeze claim, newest-wins. */
  files: string[]
  /** Files an OLDER attempt found unauthorized and the newest one no longer does. */
  resolved: string[]
}

/**
 * The freeze claim plus the two attempt numbers it rests on.
 *
 * `newestAttempt` and `reconciledAttempt` differ exactly when the newest attempt
 * left no READABLE `reconcile.json` (deleted, or damaged), which is the fact
 * `clone_submit` refuses on. The report needs it to say so instead of printing an
 * unbacked "not frozen", and it cannot be recovered from `files`/`resolved` alone.
 */
export interface UnauthorizedStatus extends UnauthorizedRead {
  /** The highest attempt DIRECTORY, whether or not it reconciled. */
  newestAttempt: number | undefined
  /** The newest attempt whose reconcile record is readable. */
  reconciledAttempt: number | undefined
  /**
   * The newest attempt's OWN readable reconcile audit, when it recorded one.
   *
   * The freeze claim above is derived from it, and it is also the third record the
   * submit gate reads (`src/verify/gate.ts`). `clone_report` needs that same record —
   * the gate's verdict is what `summary.json` publishes as `verify_ok` — so one read
   * of the attempt directory serves both rather than a second read that could name a
   * damaged file twice.
   */
  newestAudit: ReconcileAudit | undefined
}

/**
 * The freeze claim, from the attempt the submit gate reads.
 *
 * The union of every attempt's audit claimed a freeze forever: the operator reverts
 * the file, attempt 2 reconciles clean, verification passes, the run is submitted and
 * closed — and the report still says it is frozen and must not be verified. Every
 * other verdict in the report is newest-wins, and the claim has to be too. The older
 * findings are kept as `resolved` so the history stays auditable.
 *
 * `newestAttempt` is the highest attempt DIRECTORY. When the newest attempt recorded
 * no readable reconcile, this claims NOTHING — neither a freeze nor a resolution:
 * "an older finding the newest reconcile no longer repeats" is a statement about a
 * newest reconcile, and there is none. Callers that only pass a map (a pure
 * question about the audits themselves) get the historical behaviour, because the
 * map's own newest key is then the only newest known.
 */
export function unauthorizedClaim(audits: ReadonlyMap<number, ReconcileAudit>, newestAttempt?: number): UnauthorizedRead {
  const numbers = [...audits.keys()].sort((left, right) => left - right)
  const newest = numbers.at(-1)
  if (newest === undefined) return { files: [], resolved: [] }
  if (newestAttempt !== undefined && newestAttempt !== newest) return { files: [], resolved: [] }
  const files = [...new Set(audits.get(newest)?.unauthorized ?? [])].sort()
  const older = new Set(numbers.filter(attempt => attempt !== newest).flatMap(attempt => audits.get(attempt)?.unauthorized ?? []))
  return { files, resolved: [...older].filter(file => !files.includes(file)).sort() }
}

/** The freeze claim of this run's verify attempts, with the attempt it rests on. */
export async function loadUnauthorized(paths: RunPaths, onUnreadable?: UnreadableRecord): Promise<UnauthorizedStatus> {
  const audits = await loadReconcileAudits(paths, onUnreadable)
  const newestAttempt = await newestAttemptNumber(paths)
  return {
    ...unauthorizedClaim(audits, newestAttempt),
    newestAttempt,
    reconciledAttempt: [...audits.keys()].sort((left, right) => left - right).at(-1),
    newestAudit: newestAttempt === undefined ? undefined : audits.get(newestAttempt),
  }
}

/** The step index a log file name carries: the writer emits `${index}-${name}.log`. */
function logIndex(name: string): number {
  const match = /^(\d+)-/.exec(name)
  return match === null ? -1 : Number(match[1])
}

/**
 * The tail of the newest step log of the newest attempt. A poller reads this while
 * a build runs, so it stays a bounded slice rather than the whole file.
 *
 * The step index is parsed, not compared as a string: names are unpadded, so
 * `"10-x.log" < "2-y.log"` lexically and ten or more steps returned step 9's log
 * while step 10+ was running. The directory is the newest ATTEMPT, not the newest
 * readable result: that is what makes this the live window for the attempt running
 * now rather than for the last one that finished.
 */
export async function readNewestVerifyLog(
  paths: RunPaths,
  lines: number,
): Promise<{ file: string; lines: string[] } | undefined> {
  const newest = await newestAttemptNumber(paths)
  if (newest === undefined) return undefined
  const directory = join(paths.verifyDir, String(newest))
  const names = (await readdir(directory).catch(() => [])).filter(name => name.endsWith('.log'))
  const file = names.sort((left, right) => logIndex(left) - logIndex(right) || left.localeCompare(right)).at(-1)
  if (file === undefined) return undefined
  const absolute = join(directory, file)
  const text = await readFile(absolute, 'utf8').catch(() => '')
  const all = text.split('\n')
  return { file: absolute, lines: all.slice(Math.max(0, all.length - lines)) }
}
