/** The machine-readable counts: what a caller checks without parsing Markdown. */
import type { Assessment, Cluster, PatchRecord, VerifyResult } from '../core/schema.ts'

export interface SummaryInput {
  clusters: readonly Cluster[]
  assessments: ReadonlyMap<string, Assessment>
  patches: readonly PatchRecord[]
  verify: readonly VerifyResult[]
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
  /** Whether the NEWEST attempt passed: the same attempt a submit gate reads. */
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
  // The newest attempt is the one a submit gate reads. Attempt 1 failing and attempt 2
  // passing is a verified patch, and a report that said otherwise would tell a human
  // not to commit work the tooling accepts.
  const newest = input.verify.at(-1)
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
    verify_ok: newest !== undefined && newest.ok,
  }
}
