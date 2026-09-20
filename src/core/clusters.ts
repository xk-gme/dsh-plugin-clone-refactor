/** The cluster ledger: the clusters of one scan revision, and that revision's id. */
import { basename } from 'node:path'
import { readJsonl } from './jsonl.ts'
import { readJson, writeAtomic, type RunPaths } from './artifacts.ts'
import type { Cluster } from './schema.ts'

/** The file naming the revision `clusters.jsonl` currently belongs to. */
export function scanRevisionPath(paths: RunPaths): string {
  return `${paths.clusters}.scan.json`
}

/**
 * Record the clusters of one scan, and the revision they belong to.
 *
 * The revision pointer is written FIRST, on purpose. A scan replaces both files and no
 * rename makes the pair atomic, so a failure BETWEEN them has to leave the conservative
 * pair: a new revision with the OLD cluster set. Every verdict or authorization stamped
 * with the previous revision then stops counting (`seenAtRevision`), so the run reports
 * gaps a human resolves with one `clone_assess` — the direction that cannot close a run
 * on a verdict that is not there.
 *
 * The other order leaves the harmful pair, and it was the shipped one: a NEW cluster set
 * under the OLD revision, which is indistinguishable from a legitimate scan as far as
 * every reader is concerned. `clone_report` then closed while pairing the new cluster's
 * files with the old cluster's verdict text, and no reader could tell.
 *
 * Two files rather than one, because the revision is kept beside the clusters rather
 * than inside them: appending to `clusters.jsonl` stays impossible, and one scan stays a
 * pair of writes rather than a read-modify-write.
 *
 * The revision is a REQUIRED parameter, and that is the second half of the same rule.
 * Omitting it used to write only `clusters.jsonl` and leave the previous pointer in
 * place — the harmful pair above, produced by the write side with every reader unable
 * to tell. No production caller omitted it, so the shape was latent; making the
 * parameter required removes the shape rather than trusting callers, and a caller that
 * reaches the function anyway (plain JavaScript, or a cast) now writes a pointer with
 * no revision, which every reader treats as "no revision recorded" — the conservative
 * direction, never a stale one.
 */
export async function saveJsonlClusters(
  paths: RunPaths,
  clusters: readonly Cluster[],
  revision: string,
): Promise<void> {
  await writeAtomic(scanRevisionPath(paths), `${JSON.stringify({ revision }, null, 2)}\n`)
  await writeAtomic(paths.clusters, clusters.map(cluster => `${JSON.stringify(cluster)}\n`).join(''))
}

export async function loadJsonlClusters(paths: RunPaths): Promise<Cluster[]> {
  return (await readJsonl<Cluster>(paths.clusters)).records
}

/**
 * The revision this run's clusters belong to; `undefined` when no scan recorded one.
 *
 * A pointer that exists and cannot be parsed is SKIPPED and NAMED, by the rule
 * `latestJob` and `loadVerifyAttempts` already follow for their own records: a plain
 * `readJson` threw here, so one damaged file took down `clone_check` — the only
 * progress interface — along with `clone_report` and `clone_submit`, and the run
 * became unobservable.
 *
 * What the damage MEANS is the conservative half, and it is exactly what a LOST
 * pointer means: `undefined`. The cluster set on disk can no longer be tied to a
 * revision, so a record that carries one cannot be shown to speak about it
 * (`seenAtRevision`) and stops counting. The run then reports a coverage gap a human
 * resolves with one `clone_assess`, where the other reading would close it on a
 * verdict about a cluster set that may have been replaced.
 */
export async function loadScanRevision(
  paths: RunPaths,
  onUnreadable?: (name: string, error: Error) => void,
): Promise<string | undefined> {
  let stored: { revision?: unknown } | undefined
  try {
    stored = await readJson<{ revision?: unknown }>(scanRevisionPath(paths))
  } catch (error) {
    // The name as a reader of the run directory sees it, the same way the sibling
    // readers render theirs (`<id>.json`, `verify/<n>/result.json`).
    onUnreadable?.(basename(scanRevisionPath(paths)), error instanceof Error ? error : new Error(String(error)))
    return undefined
  }
  return typeof stored?.revision === 'string' && stored.revision !== '' ? stored.revision : undefined
}
