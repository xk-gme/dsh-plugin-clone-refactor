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
  authorized_files: number
  verify_attempts: number
  verify_ok: boolean
}

export function summarize(input: SummaryInput): Summary {
  const verdicts = [...input.assessments.values()]
  return {
    clusters: input.clusters.length,
    recorded: input.clusters.filter(cluster => input.assessments.has(cluster.id)).length,
    missing: input.clusters.filter(cluster => !input.assessments.has(cluster.id)).length,
    patched: verdicts.filter(item => item.verdict === 'patched').length,
    report_only: verdicts.filter(item => item.verdict === 'report_only').length,
    skipped: verdicts.filter(item => item.verdict === 'skipped').length,
    authorized_files: new Set(input.patches.flatMap(patch => patch.files_changed)).size,
    verify_attempts: input.verify.length,
    verify_ok: input.verify.length > 0 && input.verify.every(attempt => attempt.ok),
  }
}
