/**
 * The cluster ledger's pair of writes: `clusters.jsonl` and the revision pointer
 * beside it (`core/clusters.ts`, not to be confused with the detection suites in
 * `cluster.spec.ts`).
 *
 * One scan replaces both files, and no rename makes the pair atomic. What a failure
 * BETWEEN them may leave is therefore a design decision, and only one of the two
 * leftovers is safe. The pointer must land FIRST:
 *
 * - pointer first, clusters second: a failure leaves the NEW revision with the OLD
 *   cluster set. Every verdict stamped with the previous revision stops counting, so
 *   the run reports gaps a human resolves with one `clone_assess` — the conservative
 *   direction.
 * - clusters first, pointer second (the defect): a failure leaves a NEW cluster set
 *   under the OLD revision, so `clone_report` closes while pairing the new cluster's
 *   files with the old cluster's verdict text.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runPaths, writeAtomic, type RunPaths } from '../src/core/artifacts.ts'
import { loadJsonlClusters, loadScanRevision, saveJsonlClusters, scanRevisionPath } from '../src/core/clusters.ts'
import type { Cluster } from '../src/core/schema.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()!() })

async function paths(): Promise<RunPaths> {
  const root = await mkdtemp(join(tmpdir(), 'clone-clusters-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  return runPaths(root, 'run-1')
}

/** A minimal cluster, so the two sets are distinguishable by id alone. */
function cluster(id: string): Cluster {
  return {
    id, size: 1, files: [`module/laws/src/${id}.cpp`], functions: [],
    representative: {
      pair_id: `p-${id}`, similarity: 0.9, detection_method: 'type12',
      left: { file: `module/laws/src/${id}.cpp`, function: 'f', lines: '1-2', body: '' },
      right: { file: `module/laws/src/${id}2.cpp`, function: 'g', lines: '3-4', body: '' },
    },
  }
}

/**
 * A path `writeAtomic` cannot rename onto: a NON-EMPTY directory. The rename fails
 * with ENOTEMPTY, which is not one of the transient errnos the retry policy handles,
 * so the write fails at once instead of waiting out the backoff.
 */
async function blockWritesAt(target: string): Promise<void> {
  await mkdir(target, { recursive: true })
  await writeAtomic(join(target, 'blocker'), 'this directory is not a file\n')
}

describe('saveJsonlClusters', () => {
  it('writes the revision pointer before the cluster set', async () => {
    // The order is observable exactly when the cluster write fails: the pointer has
    // already landed, so the run is on a NEW revision while `clusters.jsonl` still holds
    // the old set — gaps. With the old order the pointer was never written at all, so
    // the failure left the previous revision naming a set that had just been replaced.
    const target = await paths()
    await blockWritesAt(target.clusters)
    await expect(saveJsonlClusters(target, [cluster('C002')], 'rev-2')).rejects.toThrow()
    expect(await loadScanRevision(target)).toBe('rev-2')
  })

  it('leaves the old cluster set in place when the pointer write fails', async () => {
    // The conservative leftover, from the other side: if the pointer cannot be written,
    // the cluster set must not be replaced either. The pointer is forced to fail by
    // standing a non-empty directory where the file belongs; what is asserted is that
    // `clusters.jsonl` still holds the set the (old) pointer names.
    const target = await paths()
    await saveJsonlClusters(target, [cluster('C001')], 'rev-1')
    await rm(scanRevisionPath(target), { force: true })
    await blockWritesAt(scanRevisionPath(target))

    await expect(saveJsonlClusters(target, [cluster('C002')], 'rev-2')).rejects.toThrow()
    expect((await loadJsonlClusters(target)).map(entry => entry.id)).toEqual(['C001'])
  })

  it('round-trips a scan: the cluster set and the revision it belongs to', async () => {
    const target = await paths()
    await saveJsonlClusters(target, [cluster('C001'), cluster('C002')], 'rev-7')
    expect((await loadJsonlClusters(target)).map(entry => entry.id)).toEqual(['C001', 'C002'])
    expect(await loadScanRevision(target)).toBe('rev-7')
    // A second scan RESTAMPS. The test this replaced saved without a revision and
    // asserted the pointer still named `rev-7` while `clusters.jsonl` held the new set:
    // the harmful pair, pinned as intended.
    await saveJsonlClusters(target, [cluster('C003')], 'rev-8')
    expect((await loadJsonlClusters(target)).map(entry => entry.id)).toEqual(['C003'])
    expect(await loadScanRevision(target)).toBe('rev-8')
  })

  it('never leaves a stale revision naming the cluster set it just replaced', async () => {
    // The harmful pair this function's own docblock calls harmful: a NEW cluster set
    // under the OLD revision, indistinguishable from a legitimate scan to every reader.
    // The revision was an optional parameter, and a caller that omitted it wrote only
    // `clusters.jsonl`, leaving the previous pointer in place. It is now REQUIRED, so
    // the type is the first guard; this is the second, for a caller that got past the
    // type (plain JavaScript, or a cast) — the pointer must not survive as stale.
    const target = await paths()
    await saveJsonlClusters(target, [cluster('C001')], 'rev-1')
    await saveJsonlClusters(target, [cluster('C002')], undefined as unknown as string)
    expect((await loadJsonlClusters(target)).map(entry => entry.id)).toEqual(['C002'])
    expect(await loadScanRevision(target)).not.toBe('rev-1')
    // No revision recorded at all: the conservative state a lost pointer leaves, in
    // which a stamped verdict stops counting (`seenAtRevision`).
    expect(await loadScanRevision(target)).toBeUndefined()
  })
})

describe('loadScanRevision', () => {
  it('skips a damaged pointer, names it, and reports no revision', async () => {
    // The pointer is the durable record every reader of the coverage contract starts
    // from, and `readJson` throws on malformed JSON. A damaged one therefore made
    // clone_check, clone_report and clone_submit fail with a JSON parse error instead
    // of the readable state the sibling readers (`latestJob`, `loadVerifyAttempts`)
    // already produce for their own damaged records.
    const target = await paths()
    await saveJsonlClusters(target, [cluster('C001')], 'rev-1')
    await writeAtomic(scanRevisionPath(target), '{not json\n')

    const unreadable: string[] = []
    expect(await loadScanRevision(target, (name, error) => { unreadable.push(`${name}: ${error.message}`) })).toBeUndefined()
    // Named the way a reader of the run directory sees the file, as the other
    // unreadable records are (`jobs/<id>.json`, `verify/<n>/result.json`).
    expect(unreadable[0]).toMatch(/^clusters\.jsonl\.scan\.json: /)
  })

  it('reports a MISSING pointer as no revision without naming it', async () => {
    // A run that never scanned has no pointer at all. That is not damage, and the
    // visible-skip hook exists for records that EXIST and cannot be read — naming a
    // file that is simply absent would report a loss that has not happened.
    const target = await paths()
    const unreadable: string[] = []
    expect(await loadScanRevision(target, name => { unreadable.push(name) })).toBeUndefined()
    expect(unreadable).toEqual([])
  })
})
