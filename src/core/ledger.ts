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

/**
 * Whether a record belongs to the scan revision being read.
 *
 * Cluster ids are positional (`src/detect/cluster.ts`: `C001`, `C002`, …) and a
 * rescan rewrites `clusters.jsonl` wholesale, so `C001` can name a completely
 * different family after a refresh. A verdict recorded under an older revision
 * therefore must not satisfy the coverage contract of the new one: the closing
 * report would pair the NEW cluster's files with the OLD cluster's verdict text
 * and claim complete coverage.
 *
 * A record with no revision was written before revisions existed. It counts only
 * while the run's clusters have no recorded revision either: once a scan has
 * stamped a revision, such a record cannot be shown to speak about the current
 * cluster set, so it does not count. Hiding it is the conservative direction —
 * the run reports a coverage gap a human can resolve with one `clone_assess`,
 * while the other direction closes the run on a verdict about a different family.
 *
 * That recovery is only real while the WRITE side applies the same rule, which is
 * why {@link recordAssessment} asks this question about the record's own revision
 * rather than about the file: a stale verdict is not a duplicate, so it may be
 * re-recorded plainly.
 */
export function seenAtRevision(record: { scan_revision?: string }, revision: string | undefined): boolean {
  if (revision === undefined) return true
  return record.scan_revision === revision
}

/**
 * Load every assessment; the newest record per cluster wins.
 *
 * Passing the current scan `revision` restricts the read to the records of that
 * revision, which is what the coverage contract needs after a refresh. Passing
 * nothing reads the whole file, which is what a run with no recorded revision
 * needs: no record can be shown to be stale.
 */
export async function loadAssessments(paths: RunPaths, revision?: string): Promise<LedgerRead> {
  const { records, droppedLines } = await readJsonl<Assessment>(paths.assessments)
  const history = records.filter(record => seenAtRevision(record, revision))
  const latest = new Map<string, Assessment>()
  for (const record of history) {
    if (typeof record?.cluster_id !== 'string' || record.cluster_id === '') continue
    // A later record always wins, including a `replace: true` correction.
    latest.delete(record.cluster_id)
    latest.set(record.cluster_id, record)
  }
  return { latest, history, droppedLines }
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

/**
 * Append one verdict, refusing a silent overwrite of an existing cluster.
 *
 * The duplicate check is REVISION-AWARE, through the record's own `scan_revision`.
 * Cluster ids are positional, so a refresh renumbers C001 onto a different family:
 * a verdict under an earlier revision is stale, every reader above already ignores
 * it (`seenAtRevision`), and a plain `clone_assess` is the documented way to
 * re-record the verdict for the new family. Refusing that call told the model to
 * overwrite a verdict the coverage contract had stopped counting, while the
 * docblock of `seenAtRevision` promised exactly that one plain call.
 *
 * A verdict under the CURRENT revision is a genuine duplicate and still needs
 * `replace: true`: that is what stops a model from silently retracting a verdict it
 * already recorded about this cluster set.
 *
 * `replaced` therefore means "an earlier verdict about the CURRENT cluster set is
 * superseded" — not "the file grew another line for this id". A stale-revision
 * record stays in the append-only history; it just no longer counts.
 */
export async function recordAssessment(
  paths: RunPaths,
  assessment: Assessment,
  options: { replace: boolean },
): Promise<{ replaced: boolean }> {
  const { latest } = await loadAssessments(paths, assessment.scan_revision)
  const replaced = latest.has(assessment.cluster_id)
  if (replaced && !options.replace) {
    throw new Error(`'${assessment.cluster_id}' already has a verdict for this scan revision. Pass replace: true to overwrite it.`)
  }
  await repairTornTail(paths.assessments)
  await appendJsonl(paths.assessments, assessment)
  return { replaced }
}

/** The authorization ledger; a missing file is an empty ledger. */
export async function loadPatches(paths: RunPaths, revision?: string): Promise<PatchRecord[]> {
  const patches = (await readJson<PatchRecord[]>(paths.patches)) ?? []
  return revision === undefined ? patches : patches.filter(patch => seenAtRevision(patch, revision))
}

export async function savePatches(paths: RunPaths, patches: readonly PatchRecord[]): Promise<void> {
  await writeAtomic(paths.patches, `${JSON.stringify(patches, null, 2)}\n`)
}

/** Cluster ids with no verdict yet: what `clone_report` refuses to close over. */
export function coverageGaps(clusterIds: readonly string[], latest: ReadonlyMap<string, Assessment>): string[] {
  return clusterIds.filter(id => !latest.has(id))
}
