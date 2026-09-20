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
}

/** A required argument that a model may only supply as a non-empty string. */
export function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} is required`)
  return value.trim()
}
