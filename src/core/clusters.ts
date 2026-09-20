/** The cluster ledger: the clusters of one scan revision, and that revision's id. */
import { readJsonl } from './jsonl.ts'
import { readJson, writeAtomic, type RunPaths } from './artifacts.ts'
import type { Cluster } from './schema.ts'

/** The file naming the revision `clusters.jsonl` currently belongs to. */
export function scanRevisionPath(paths: RunPaths): string {
  return `${paths.clusters}.scan.json`
}

/**
 * Record the scan revision `clusters.jsonl` now belongs to.
 *
 * A verdict or authorization record stamped with an older revision is invisible to
 * the coverage contract and to `clone_verify` (see `seenAtRevision`). The revision
 * is kept beside the clusters rather than inside them so that appending to
 * `clusters.jsonl` stays impossible and one scan stays one atomic pair of writes.
 */
export async function saveJsonlClusters(
  paths: RunPaths,
  clusters: readonly Cluster[],
  revision?: string,
): Promise<void> {
  await writeAtomic(paths.clusters, clusters.map(cluster => `${JSON.stringify(cluster)}\n`).join(''))
  if (revision !== undefined) await writeAtomic(scanRevisionPath(paths), `${JSON.stringify({ revision }, null, 2)}\n`)
}

export async function loadJsonlClusters(paths: RunPaths): Promise<Cluster[]> {
  return (await readJsonl<Cluster>(paths.clusters)).records
}

/** The revision this run's clusters belong to; `undefined` when no scan recorded one. */
export async function loadScanRevision(paths: RunPaths): Promise<string | undefined> {
  const stored = await readJson<{ revision?: unknown }>(scanRevisionPath(paths))
  return typeof stored?.revision === 'string' && stored.revision !== '' ? stored.revision : undefined
}
