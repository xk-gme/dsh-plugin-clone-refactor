/** The machine-readable counts: what a caller checks without parsing Markdown. */
import type { JobRecord } from '../core/jobs.ts'
import type { Assessment, Cluster, PatchRecord, ReconcileAudit, VerifyResult } from '../core/schema.ts'
import { newestVerifyOutcome } from '../verify/gate.ts'

export interface SummaryInput {
  clusters: readonly Cluster[]
  assessments: ReadonlyMap<string, Assessment>
  patches: readonly PatchRecord[]
  verify: readonly VerifyResult[]
  /**
   * The submit gate's own inputs for the newest attempt: its DIRECTORY number, the
   * newest verify job record and that attempt's reconcile audit. The verdict below is
   * computed from these three, so the summary reports the claim the gate itself reads
   * rather than a second opinion about it.
   *
   * That is the whole claim these three support. The gate can still refuse a ledger the
   * attempt settled on — a patch authorized after it (`late`) — which is a fact about
   * the LEDGER, not about the attempt, and `ReportInput.patchesCovered` carries it.
   */
  newestAttempt: number | undefined
  verifyJob: JobRecord | undefined
  audit: ReconcileAudit | undefined
}

export interface Summary {
  clusters: number
  recorded: number
  missing: number
  patched: number
  report_only: number
  skipped: number
  /** Clusters per priority, so P0/P1/P2/PX is readable without parsing Markdown. */
  by_priority: Record<string, number>
  authorized_files: number
  verify_attempts: number
  /**
   * Whether the NEWEST attempt settled as a pass, by the submit gate's own
   * definition (`newestVerifyOutcome`): the newest attempt DIRECTORY has a readable
   * ok result, its verify JOB succeeded, and its reconcile audit is readable.
   *
   * Not "the newest readable `result.json`", which is not the attempt a gate reads:
   * an attempt killed or frozen before its result landed left no result.json for
   * `loadVerifyAttempts` to return, and a verdict built from that list alone said
   * `verify_ok: true` about a run whose newest verification has no outcome at all.
   */
  verify_ok: boolean
}

/** Clusters per assessed priority. Sums to `recorded`: a cluster with no verdict has no priority. */
export function countByPriority(clusters: readonly Cluster[], assessments: ReadonlyMap<string, Assessment>): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const cluster of clusters) {
    const priority = assessments.get(cluster.id)?.priority
    if (priority === undefined) continue
    counts[priority] = (counts[priority] ?? 0) + 1
  }
  return counts
}

export function summarize(input: SummaryInput): Summary {
  const verdicts = [...input.assessments.values()]
  // The newest attempt is the one a submit gate reads, so its verdict is the gate's:
  // attempt 1 failing and attempt 2 passing is a verified patch, a report that said
  // otherwise would tell a human not to commit work the tooling accepts — and the
  // mirror image (attempt 2 never wrote a result) is not a pass.
  const newest = newestVerifyOutcome({
    attempts: input.verify, newestAttempt: input.newestAttempt, verifyJob: input.verifyJob, audit: input.audit,
  })
  return {
    clusters: input.clusters.length,
    recorded: input.clusters.filter(cluster => input.assessments.has(cluster.id)).length,
    missing: input.clusters.filter(cluster => !input.assessments.has(cluster.id)).length,
    patched: verdicts.filter(item => item.verdict === 'patched').length,
    report_only: verdicts.filter(item => item.verdict === 'report_only').length,
    skipped: verdicts.filter(item => item.verdict === 'skipped').length,
    by_priority: countByPriority(input.clusters, input.assessments),
    authorized_files: new Set(input.patches.flatMap(patch => patch.files_changed)).size,
    verify_attempts: input.verify.length,
    verify_ok: newest.settled,
  }
}
