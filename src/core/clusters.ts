/** The cluster ledger: an append-only file that a resumed run replays. */
import { readJsonl } from './jsonl.ts'
import { writeAtomic, type RunPaths } from './artifacts.ts'
import type { Cluster } from './schema.ts'

export async function loadJsonlClusters(paths: RunPaths): Promise<Cluster[]> {
  return (await readJsonl<Cluster>(paths.clusters)).records
}

/** A scan replaces the cluster set; a resumed run reads whatever is there. */
export async function saveJsonlClusters(paths: RunPaths, clusters: readonly Cluster[]): Promise<void> {
  await writeAtomic(paths.clusters, clusters.map(cluster => `${JSON.stringify(cluster)}\n`).join(''))
}
