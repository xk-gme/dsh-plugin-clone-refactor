/**
 * The append-only ledger. Clusters live in `clusters.jsonl`, verdicts in
 * `assessments.jsonl`, and the authorization records in `patches.json`; the
 * coverage contract is "every cluster has exactly one latest verdict".
 *
 * `clusters.jsonl` is rewritten wholesale by a scan and `assessments.jsonl` is
 * appended to; they are never both written to, so they need no shared writer
 * discipline today. If a later task ever appends to `clusters.jsonl` while
 * another rewrites it, revisit that: the read-modify-write race would start to
 * matter. The temp-name half of that hazard is already closed — `writeAtomic`
 * names each call's temp file uniquely, so two writers can no longer rename away
 * each other's temp.
 */
import { readFile } from 'node:fs/promises'
import { appendJsonl, readJsonl } from './jsonl.ts'
import { readJson, writeAtomic, type RunPaths } from './artifacts.ts'
import type { Assessment, PatchRecord } from './schema.ts'

export { requireText, VERDICTS } from './schema.ts'
export type { Assessment, PatchRecord } from './schema.ts'

export interface LedgerRead {
  /** Newest record per cluster id, in insertion order. */
  latest: Map<string, Assessment>
  history: Assessment[]
  droppedLines: number[]
}

/** Load every assessment; the newest record per cluster wins. */
export async function loadAssessments(paths: RunPaths): Promise<LedgerRead> {
  const { records, droppedLines } = await readJsonl<Assessment>(paths.assessments)
  const latest = new Map<string, Assessment>()
  for (const record of records) {
    if (typeof record?.cluster_id !== 'string' || record.cluster_id === '') continue
    // A later record always wins, including a `replace: true` correction.
    latest.delete(record.cluster_id)
    latest.set(record.cluster_id, record)
  }
  return { latest, history: records, droppedLines }
}

/**
 * A torn tail — a crash mid-append leaves a fragment with no trailing newline —
 * would glue onto the next record and make `readJsonl` drop BOTH lines. The file's
 * whole purpose is to survive an interrupted run, so repair it before appending.
 * Only ever truncates a file whose last line is incomplete, and rewrites nothing
 * else, so a corrupt *middle* line is left for `readJsonl` to report.
 */
export async function repairTornTail(file: string): Promise<boolean> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  if (text === '' || text.endsWith('\n')) return false
  await writeAtomic(file, text.slice(0, text.lastIndexOf('\n') + 1))
  return true
}

/** Append one verdict, refusing a silent overwrite of an existing cluster. */
export async function recordAssessment(
  paths: RunPaths,
  assessment: Assessment,
  options: { replace: boolean },
): Promise<{ replaced: boolean }> {
  const { latest } = await loadAssessments(paths)
  const replaced = latest.has(assessment.cluster_id)
  if (replaced && !options.replace) {
    throw new Error(`'${assessment.cluster_id}' already has a verdict. Pass replace: true to overwrite it.`)
  }
  await repairTornTail(paths.assessments)
  await appendJsonl(paths.assessments, assessment)
  return { replaced }
}

/** The authorization ledger; a missing file is an empty ledger. */
export async function loadPatches(paths: RunPaths): Promise<PatchRecord[]> {
  return (await readJson<PatchRecord[]>(paths.patches)) ?? []
}

export async function savePatches(paths: RunPaths, patches: readonly PatchRecord[]): Promise<void> {
  await writeAtomic(paths.patches, `${JSON.stringify(patches, null, 2)}\n`)
}

/** Cluster ids with no verdict yet: what `clone_report` refuses to close over. */
export function coverageGaps(clusterIds: readonly string[], latest: ReadonlyMap<string, Assessment>): string[] {
  return clusterIds.filter(id => !latest.has(id))
}
