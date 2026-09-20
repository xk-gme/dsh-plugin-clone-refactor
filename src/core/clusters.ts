/** The cluster ledger: the clusters of one scan revision, and that revision's id. */
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
 */
export async function saveJsonlClusters(
  paths: RunPaths,
  clusters: readonly Cluster[],
  revision?: string,
): Promise<void> {
  if (revision !== undefined) await writeAtomic(scanRevisionPath(paths), `${JSON.stringify({ revision }, null, 2)}\n`)
  await writeAtomic(paths.clusters, clusters.map(cluster => `${JSON.stringify(cluster)}\n`).join(''))
}

export async function loadJsonlClusters(paths: RunPaths): Promise<Cluster[]> {
  return (await readJsonl<Cluster>(paths.clusters)).records
}

/** The revision this run's clusters belong to; `undefined` when no scan recorded one. */
export async function loadScanRevision(paths: RunPaths): Promise<string | undefined> {
  const stored = await readJson<{ revision?: unknown }>(scanRevisionPath(paths))
  return typeof stored?.revision === 'string' && stored.revision !== '' ? stored.revision : undefined
}
