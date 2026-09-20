/** The shared data model: the only truth the capability modules agree on. */
import type { Priority, VerifyPhase } from '../config.ts'

export const VERDICTS = ['patched', 'report_only', 'skipped'] as const
export type Verdict = typeof VERDICTS[number]

/** One side of a clone pair, exactly as the detection CSV or the model reports it. */
export interface ClonePairSide {
  file: string
  function: string
  /** The CSV's line-range string, e.g. `120-168`; may be empty. */
  lines: string
  /** Body excerpt when the CSV carries one; empty when the model must read the source. */
  body: string
}

export interface ClonePair {
  pair_id: string
  similarity: number | null
  detection_method: string
  left: ClonePairSide
  right: ClonePairSide
}

/** A clone family: one connected component of the pair graph, and the coverage unit. */
export interface Cluster {
  id: string
  size: number
  representative: ClonePair
  files: string[]
  functions: string[]
}

export interface Assessment {
  cluster_id: string
  verdict: Verdict
  priority: Priority
  reason: string
  files_changed: string[]
  recorded_at: string
  /**
   * The scan revision this verdict was recorded against. Cluster ids are
   * positional, so after a refresh a verdict from an earlier revision must not
   * satisfy the coverage contract of the new cluster set (see `seenAtRevision`).
   * Absent only on records written before revisions existed.
   */
  scan_revision?: string
}

/** The authorization ledger: what the user allowed, and what it touched. */
export interface PatchRecord {
  cluster_id: string
  priority: Priority
  files_changed: string[]
  recorded_at: string
  /** The scan revision this authorization belongs to; see {@link Assessment.scan_revision}. */
  scan_revision?: string
}

export interface StepResult {
  name: string
  phase: VerifyPhase
  command: string
  required: boolean
  always: boolean
  exit_code: number | null
  ok: boolean
  timed_out: boolean
  log_file: string
  lossy: boolean
}

export interface VerifyResult {
  attempt: number
  ok: boolean
  started_at: string
  finished_at: string
  steps: StepResult[]
  rolled_back: boolean
  rollback_files: string[]
  /**
   * Why a rollback that was ATTEMPTED did not happen. Absent when none was
   * attempted — the two are different facts, and a report that showed the second
   * while the first was true told the operator nothing needed rolling back while
   * the failed patch was still in their tree.
   */
  rollback_error?: string
}

/**
 * What one `clone_verify` call authorized and reconciled, written next to the
 * attempt it belongs to (`verify/<n>/reconcile.json`).
 *
 * This is the fact `clone_submit` gates on, recorded rather than re-derived: the
 * ledger can be re-authorized between the verification and the submission, and a
 * run-level "did the newest attempt pass" boolean cannot see that. `recorded_at`
 * is what makes "a patch authorized afterwards" detectable, and `cluster_ids`
 * makes it detectable even when the file set happens to be identical.
 *
 * `recorded_at` and `cluster_ids` are absent on records written before this
 * existed. A missing record is never a pass: see `src/verify/gate.ts`.
 */
export interface ReconcileAudit {
  /** The files the ledger authorized when the tree was read. */
  authorized: string[]
  /** Every file git reported as changed. */
  changed: string[]
  /** Changed in the work tree, never authorized: the run freezes. */
  unauthorized: string[]
  /** Authorized but no longer changed: the ledger no longer describes reality. */
  missing: string[]
  /** The clusters whose authorization produced `authorized`. */
  cluster_ids: string[]
  /** The scan revision the ledger belonged to; absent before revisions existed. */
  scan_revision?: string
  /** When the ledger and the tree were read; absent before this record existed. */
  recorded_at: string
}

/** A required argument that a model may only supply as a non-empty string. */
export function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} is required`)
  return value.trim()
}
