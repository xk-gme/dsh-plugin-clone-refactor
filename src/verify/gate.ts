/**
 * The submit precondition: whether the verification a submission would claim
 * actually covers the ledger and the file SET the commit would take.
 *
 * What it binds, exactly: the committed file set, and the ledger's authorization,
 * revision and timestamps. It does NOT bind the content of those files. An edit to a
 * file that was already authorized and verified is committed without a fresh
 * verification — the spec binds only the file scope, so that is the contract, and
 * "the tree it commits" (the older wording) invited the stronger reading that the
 * verified tree's CONTENT is pinned, which no code here checks.
 *
 * The gate is one pure function so the whole precondition is readable at once, and
 * so every reason for refusing it can be tested without a work tree. Its first
 * question — did the newest attempt settle as a pass? — has its own name
 * ({@link newestVerifyOutcome}) because the closing report publishes the same
 * verdict as `verify_ok`: one definition, so the two cannot disagree about whether
 * THE NEWEST ATTEMPT passed.
 *
 * They can still disagree about the RUN, and saying otherwise was wrong: this
 * function settles on the newest attempt alone, and the `late` branch below refuses a
 * ledger that moved after that attempt read it. A patch authorized afterwards
 * therefore has `verify_ok: true` from a summary that shares this predicate while a
 * submission is refused. That is why the report publishes TWO facts — `verify_ok` (the
 * newest attempt's own outcome) and `unverified` (whether every patch the ledger holds
 * now is covered by the audit that attempt recorded) — rather than deriving one from
 * the other.
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

/**
 * The inputs that decide whether the NEWEST verification attempt is a settled pass:
 * the same three records the submit gate reads, so the report's `verify_ok` is the
 * gate's verdict rather than a second opinion about it.
 */
export interface NewestVerifyInput {
  /** The readable verify attempts, oldest first. */
  attempts: readonly VerifyResult[]
  /** The highest attempt DIRECTORY, whether or not it holds a result.json. */
  newestAttempt: number | undefined
  /**
   * The newest VERIFY job record, which must NAME the newest attempt
   * ({@link JobRecord.attempt}): the terminal write is on its own path, so a lost one
   * leaves no file for the reader to miss, and the newest job still on disk is then an
   * earlier attempt's.
   */
  verifyJob: JobRecord | undefined
  /** What the newest attempt reconciled, when it recorded it. */
  audit: ReconcileAudit | undefined
  /** Verify records that could not be read, for the refusal to name them. */
  unreadable?: readonly string[]
}

/**
 * Whether the newest attempt settled as a pass, or why it cannot be shown to have.
 *
 * A settled verdict carries the audit it validated, so a caller that goes on to read
 * `audit.recorded_at` does not have to re-establish that the record is there.
 */
export type NewestVerify =
  | { settled: true, audit: ReconcileAudit }
  | { settled: false, reason: string }

/**
 * The one definition of "the newest verification attempt is a pass": its DIRECTORY
 * has a readable, ok `result.json`, its verify JOB settled successfully AND names that
 * attempt, and it recorded a readable `reconcile.json`.
 *
 * The freeze claim comes first, and from the newest attempt's own record. A frozen
 * `clone_verify` throws before it starts a job, so that attempt has a
 * `reconcile.json` and no `result.json` — and every check below refuses it for the
 * wrong reason ("no result record", or "no passing clone_verify" when the freeze was
 * the first attempt), while the audit naming the unauthorized file sits unread. The
 * attempt number therefore comes from the DIRECTORY when there is no readable
 * attempt to ask.
 */
export function newestVerifyOutcome(input: NewestVerifyInput): NewestVerify {
  const audit = input.audit
  const newestAttempt = input.newestAttempt ?? input.attempts.at(-1)?.attempt
  // The audit is the newest attempt's by construction, so one of the two is always
  // there in practice; the label says which attempt the claim is about either way.
  const label = newestAttempt === undefined ? 'The newest verification attempt' : `Attempt ${String(newestAttempt)}`
  if (audit !== undefined && Array.isArray(audit.unauthorized) && audit.unauthorized.length > 0) {
    return {
      settled: false,
      reason: `${label} reconciled with unauthorized changes (${audit.unauthorized.join(', ')}): `
        + 'this run is frozen and must not be submitted. Either re-assess the cluster with clone_assess so the current '
        + 'scan revision authorizes the file, or revert a file no revision authorized; then re-run clone_verify.',
    }
  }
  const last = input.attempts.at(-1)
  if (last === undefined) {
    return { settled: false, reason: 'No passing clone_verify for this run: nothing may be submitted before the build and tests pass.' }
  }
  if (!last.ok) {
    return { settled: false, reason: `The newest clone_verify (attempt ${last.attempt}) did not pass: nothing may be submitted before the build and tests pass.` }
  }
  // The newest attempt is the highest-numbered DIRECTORY, not the newest readable
  // result.json: an attempt killed before its result landed still happened, and the
  // run may not be submitted on the strength of the attempt before it.
  if (input.newestAttempt !== undefined && last.attempt !== input.newestAttempt) {
    const unreadable = input.unreadable ?? []
    const damaged = unreadable.length > 0 ? ` (unreadable: ${unreadable.join(', ')})` : ''
    return {
      settled: false,
      reason: `The newest verification attempt (attempt ${input.newestAttempt}) has no result record${damaged}, `
        + `so its outcome is unknown: attempt ${last.attempt} may not be submitted in its place. Re-run clone_verify.`,
    }
  }
  // The job record is written on a separate path from result.json (`core/jobs.ts`).
  // A failed attempt whose result write never landed therefore leaves the newest
  // verify JOB failed while the newest result.json still belongs to an older, passing
  // attempt — the run-level boolean that read one file saw only that older pass.
  if (input.verifyJob === undefined) {
    return { settled: false, reason: `No verification job record for this run: attempt ${last.attempt} cannot be shown to have settled successfully, so nothing may be submitted.` }
  }
  if (input.verifyJob.status !== 'succeeded') {
    return {
      settled: false,
      reason: `The newest verification job (${input.verifyJob.job_id}) is ${input.verifyJob.status}, not succeeded${input.verifyJob.error === null ? '' : `: ${input.verifyJob.error}`}. `
        + 'A verification with no successful terminal record is not a passing one: re-run clone_verify.',
    }
  }
  // A record's own attempt number, because "the newest verify job on disk" is not the
  // same claim: a terminal write that never landed leaves NO file, so the reader cannot
  // report that attempt 2's status is missing — it reports attempt 1's succeeded job,
  // which then stood in for an attempt nothing recorded. The status above is checked
  // first because a failed record refuses on its own terms whatever attempt it belongs
  // to; this closes the case that check cannot see.
  if (input.verifyJob.attempt !== newestAttempt) {
    const belongs = input.verifyJob.attempt === undefined
      ? 'does not record which attempt it settled'
      : `belongs to attempt ${String(input.verifyJob.attempt)}`
    return {
      settled: false,
      reason: `The newest verification job on record (${input.verifyJob.job_id}) ${belongs}; `
        + `it cannot show that attempt ${String(newestAttempt)} settled as a pass. Re-run clone_verify.`,
    }
  }
  // A record written before this existed has no timestamp, and one that was only
  // partly written has no cluster set. Neither can establish what was verified or
  // when, and "cannot be shown" must not read as "verified".
  if (audit === undefined || typeof audit.recorded_at !== 'string' || !Array.isArray(audit.cluster_ids)) {
    return {
      settled: false,
      reason: `The newest verification attempt (attempt ${last.attempt}) has no reconcile record of WHAT it verified and WHEN, `
        + 'so this ledger cannot be shown to be the one it verified. Re-run clone_verify to record it.',
    }
  }
  return { settled: true, audit }
}

export interface SubmitGateInput extends NewestVerifyInput {
  patches: readonly PatchRecord[]
  /** The run's current scan revision. */
  revision: string | undefined
  /** Exactly the files the ledger authorizes right now. */
  files: readonly string[]
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
  const newest = newestVerifyOutcome(input)
  if (!newest.settled) return refuse(newest.reason)
  const audit = newest.audit
  // The attempt whose record this gate is reading: the newest DIRECTORY when one is
  // known, else the newest readable attempt (the settled verdict above guarantees
  // that one exists).
  const attempt = input.newestAttempt ?? input.attempts.at(-1)?.attempt
  // The ordering check, first among the comparisons because it is the reason the
  // others exist: an authorization recorded after the reconcile was not in the set
  // the attempt reconciled, whatever the sets look like now.
  const late = input.patches.filter(patch => !(patch.recorded_at <= audit.recorded_at))
  if (late.length > 0) {
    return refuse(
      `A patch was authorized after the verification it would be submitted under: `
      + `${late.map(patch => `${patch.cluster_id} at ${String(patch.recorded_at)}`).join(', ')} `
      + `is newer than attempt ${String(attempt)}'s reconcile at ${audit.recorded_at}. Re-run clone_verify so the verification covers the current authorization.`,
    )
  }
  if (audit.scan_revision !== input.revision) {
    return refuse(
      `The cluster set was rescanned after attempt ${String(attempt)} verified it (revision ${String(audit.scan_revision)} → ${String(input.revision)}): `
      + 'cluster ids are positional, so that attempt no longer speaks about this ledger. Re-run clone_verify against the current revision.',
    )
  }
  if (!sameSet(audit.authorized, input.files)) {
    return refuse(
      `The authorization ledger no longer matches what attempt ${String(attempt)} verified: it verified ${audit.authorized.join(', ') || '(nothing)'} `
      + `but the ledger now authorizes ${input.files.join(', ') || '(nothing)'}. Re-run clone_verify.`,
    )
  }
  if (!sameSet(audit.cluster_ids, input.patches.map(patch => patch.cluster_id))) {
    return refuse(
      `The authorized clusters no longer match what attempt ${String(attempt)} verified: it verified ${audit.cluster_ids.join(', ') || '(none)'} `
      + `but the ledger now holds ${input.patches.map(patch => patch.cluster_id).join(', ') || '(none)'}. Re-run clone_verify.`,
    )
  }
  return { allowed: true }
}
