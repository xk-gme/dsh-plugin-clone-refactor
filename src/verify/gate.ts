/**
 * The submit precondition: whether the verification a submission would claim
 * actually covers the ledger and the tree the commit would take.
 *
 * The gate is one pure function so the whole precondition is readable at once, and
 * so every reason for refusing it can be tested without a work tree.
 *
 * Why a recorded fact instead of a re-derivation. The ledger is mutable and the
 * gate runs later than the verification: `clone_assess` can widen a patch, add a
 * second cluster, retract one, or a rescan can replace the cluster set entirely.
 * Re-running `changedFiles` + `reconcile` at submit time would re-derive the same
 * answer only while the tree has not moved; recording what the attempt reconciled
 * (`verify/<n>/reconcile.json`) states the fact the attempt acted on, including
 * WHEN it read the ledger, which is the half a re-derivation cannot recover.
 *
 * Every missing part is a refusal, never a pass: a run created before the record
 * existed, an attempt whose result.json never landed, a job whose terminal status
 * was never written. The one direction that would be wrong is "unknown, so allow".
 */
import type { JobRecord } from '../core/jobs.ts'
import type { PatchRecord, ReconcileAudit, VerifyResult } from '../core/schema.ts'

export interface SubmitGateInput {
  /** The readable verify attempts, oldest first. */
  attempts: readonly VerifyResult[]
  /** The highest attempt DIRECTORY, whether or not it holds a result.json. */
  newestAttempt: number | undefined
  /** The newest VERIFY job record: the durable terminal status of the newest attempt. */
  verifyJob: JobRecord | undefined
  /** What the newest attempt reconciled, when it recorded it. */
  audit: ReconcileAudit | undefined
  patches: readonly PatchRecord[]
  /** The run's current scan revision. */
  revision: string | undefined
  /** Exactly the files the ledger authorizes right now. */
  files: readonly string[]
  /** Verify records that could not be read, for the refusal to name them. */
  unreadable: readonly string[]
}

export type SubmitGate =
  | { allowed: true }
  | { allowed: false, reason: string }

/** The order-independent comparison a set of paths or cluster ids needs. */
function sameSet(left: readonly string[], right: readonly string[]): boolean {
  const a = [...new Set(left)].sort()
  const b = [...new Set(right)].sort()
  return a.length === b.length && a.every((value, index) => value === b[index])
}

function refuse(reason: string): SubmitGate {
  return { allowed: false, reason }
}

export function submitGate(input: SubmitGateInput): SubmitGate {
  const last = input.attempts.at(-1)
  if (last === undefined) {
    return refuse('No passing clone_verify for this run: nothing may be submitted before the build and tests pass.')
  }
  if (!last.ok) {
    return refuse(`The newest clone_verify (attempt ${last.attempt}) did not pass: nothing may be submitted before the build and tests pass.`)
  }
  // The newest attempt is the highest-numbered DIRECTORY, not the newest readable
  // result.json: an attempt killed before its result landed still happened, and the
  // run may not be submitted on the strength of the attempt before it.
  if (input.newestAttempt !== undefined && last.attempt !== input.newestAttempt) {
    const damaged = input.unreadable.length > 0 ? ` (unreadable: ${input.unreadable.join(', ')})` : ''
    return refuse(
      `The newest verification attempt (attempt ${input.newestAttempt}) has no result record${damaged}, so its outcome is unknown: attempt ${last.attempt} may not be submitted in its place. Re-run clone_verify.`,
    )
  }
  // The job record is written on a separate path from result.json (`core/jobs.ts`).
  // A failed attempt whose result write never landed therefore leaves the newest
  // verify JOB failed while the newest result.json still belongs to an older, passing
  // attempt — the run-level boolean that read one file saw only that older pass.
  if (input.verifyJob === undefined) {
    return refuse(`No verification job record for this run: attempt ${last.attempt} cannot be shown to have settled successfully, so nothing may be submitted.`)
  }
  if (input.verifyJob.status !== 'succeeded') {
    return refuse(
      `The newest verification job (${input.verifyJob.job_id}) is ${input.verifyJob.status}, not succeeded${input.verifyJob.error === null ? '' : `: ${input.verifyJob.error}`}. ` +
      'A verification with no successful terminal record is not a passing one: re-run clone_verify.',
    )
  }
  const audit = input.audit
  // A record written before this existed has no timestamp, and one that was only
  // partly written has no cluster set. Neither can establish what was verified or
  // when, and "cannot be shown" must not read as "verified".
  if (audit === undefined || typeof audit.recorded_at !== 'string' || !Array.isArray(audit.cluster_ids)) {
    return refuse(
      `The newest verification attempt (attempt ${last.attempt}) has no reconcile record of WHAT it verified and WHEN, so this ledger cannot be shown to be the one it verified. Re-run clone_verify to record it.`,
    )
  }
  if (audit.unauthorized.length > 0) {
    return refuse(
      `Attempt ${last.attempt} reconciled with unauthorized changes (${audit.unauthorized.join(', ')}): this run is frozen and must not be submitted.`,
    )
  }
  // The ordering check, first among the comparisons because it is the reason the
  // others exist: an authorization recorded after the reconcile was not in the set
  // the attempt reconciled, whatever the sets look like now.
  const late = input.patches.filter(patch => !(patch.recorded_at <= audit.recorded_at))
  if (late.length > 0) {
    return refuse(
      `A patch was authorized after the verification it would be submitted under: `
      + `${late.map(patch => `${patch.cluster_id} at ${String(patch.recorded_at)}`).join(', ')} `
      + `is newer than attempt ${last.attempt}'s reconcile at ${audit.recorded_at}. Re-run clone_verify so the verification covers the current authorization.`,
    )
  }
  if (audit.scan_revision !== input.revision) {
    return refuse(
      `The cluster set was rescanned after attempt ${last.attempt} verified it (revision ${String(audit.scan_revision)} → ${String(input.revision)}): `
      + 'cluster ids are positional, so that attempt no longer speaks about this ledger. Re-run clone_verify against the current revision.',
    )
  }
  if (!sameSet(audit.authorized, input.files)) {
    return refuse(
      `The authorization ledger no longer matches what attempt ${last.attempt} verified: it verified ${audit.authorized.join(', ') || '(nothing)'} `
      + `but the ledger now authorizes ${input.files.join(', ') || '(nothing)'}. Re-run clone_verify.`,
    )
  }
  if (!sameSet(audit.cluster_ids, input.patches.map(patch => patch.cluster_id))) {
    return refuse(
      `The authorized clusters no longer match what attempt ${last.attempt} verified: it verified ${audit.cluster_ids.join(', ') || '(none)'} `
      + `but the ledger now holds ${input.patches.map(patch => patch.cluster_id).join(', ') || '(none)'}. Re-run clone_verify.`,
    )
  }
  return { allowed: true }
}
