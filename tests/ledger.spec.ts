import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runPaths, writeAtomic } from '../src/core/artifacts.ts'
import { readJsonl } from '../src/core/jsonl.ts'
import {
  coverageGaps, loadAssessments, loadPatches, recordAssessment, savePatches,
  requireText, type Assessment, type PatchRecord,
} from '../src/core/ledger.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()!() })

async function paths(): Promise<ReturnType<typeof runPaths>> {
  const root = await mkdtemp(join(tmpdir(), 'clone-ledger-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  return runPaths(root, 'run-1')
}

function assessment(clusterId: string, verdict: Assessment['verdict'], files: string[] = []): Assessment {
  return { cluster_id: clusterId, verdict, priority: 'P0', reason: 'because', files_changed: files, recorded_at: '2026-09-20T00:00:00.000Z' }
}

describe('assessments', () => {
  it('reports missing, not-yet-assessed clusters as coverage gaps', async () => {
    const target = await paths()
    await recordAssessment(target, assessment('C001', 'report_only'), { replace: false })
    const { latest } = await loadAssessments(target)
    expect(coverageGaps(['C001', 'C002'], latest)).toEqual(['C002'])
    expect(coverageGaps(['C001'], latest)).toEqual([])
  })

  it('refuses a second verdict for the same cluster unless replace is set', async () => {
    const target = await paths()
    await recordAssessment(target, assessment('C001', 'report_only'), { replace: false })
    await expect(recordAssessment(target, assessment('C001', 'skipped'), { replace: false }))
      .rejects.toThrow(/already has a verdict/)
    // A refused verdict is not a record: the throw happens before the append, so
    // only the accepted writes are in the ledger. On the `replace: true` below the
    // history is 2, not 3 — 1 accepted + 1 refused (nothing written) + 1 replaced.
    expect((await loadAssessments(target)).history).toHaveLength(1)
    await recordAssessment(target, assessment('C001', 'patched', ['src/a.cpp']), { replace: true })
    const { latest, history } = await loadAssessments(target)
    expect(history).toHaveLength(2)
    expect(latest.get('C001')?.verdict).toBe('patched')
  })

  it('lets a verdict from an earlier scan revision be re-recorded without replace', async () => {
    // A refresh rewrites `clusters.jsonl`, so the positional id C001 can name a
    // completely different family. The verdict about the OLD family is stale — it is
    // not a duplicate of a verdict about the new cluster set — and the documented
    // recovery after a refresh is a plain `clone_assess`. Refusing it with "already
    // has a verdict" told the model to pass `replace: true` to overwrite a verdict
    // the coverage contract had already stopped counting.
    const target = await paths()
    await recordAssessment(target, { ...assessment('C001', 'report_only'), scan_revision: 'rev-1' }, { replace: false })
    const re = await recordAssessment(target, { ...assessment('C001', 'skipped'), scan_revision: 'rev-2' }, { replace: false })
    // Nothing in the CURRENT revision was superseded, which is what `replaced` says.
    expect(re.replaced).toBe(false)
    const current = await loadAssessments(target, 'rev-2')
    expect(current.latest.get('C001')?.verdict).toBe('skipped')
    expect(current.history).toHaveLength(1)
    // The other direction: a duplicate under the SAME revision is still refused, so a
    // model cannot silently retract a verdict it already recorded for this set.
    await expect(recordAssessment(target, { ...assessment('C001', 'skipped'), scan_revision: 'rev-2' }, { replace: false }))
      .rejects.toThrow(/already has a verdict/)
    expect((await loadAssessments(target, 'rev-2')).history).toHaveLength(1)
  })

  it('keeps the newest record per cluster', async () => {
    const target = await paths()
    await recordAssessment(target, assessment('C001', 'report_only'), { replace: false })
    await recordAssessment(target, assessment('C002', 'skipped'), { replace: false })
    const { latest, droppedLines } = await loadAssessments(target)
    expect([...latest.keys()].sort()).toEqual(['C001', 'C002'])
    expect(droppedLines).toEqual([])
  })

  it('counts only UNSTAMPED records while the run records no revision', async () => {
    // The pointer file is named by `saveJsonlClusters`, and the revision filter used to
    // read the WHOLE file when that pointer was absent (`revision === undefined`). That
    // state is reachable two ways: `clusters.jsonl` was replaced and the pointer write
    // that should have followed never landed, or the pointer file was deleted. Reading
    // every record then paired a NEW cluster set with the OLD verdict text and closed
    // the run with `gaps: []`.
    //
    // A record stamped with SOME revision cannot be shown to speak about a cluster set
    // whose revision is unknown, so it must not count. The unstamped legacy record still
    // counts — that is the documented behaviour a run with no pointer needs — so both
    // directions are asserted here, in one test that is red on the whole-file read.
    const target = await paths()
    await recordAssessment(target, { ...assessment('C001', 'report_only'), scan_revision: 'rev-1' }, { replace: false })
    await recordAssessment(target, assessment('C002', 'skipped'), { replace: false })
    const { latest, history } = await loadAssessments(target)
    expect([...latest.keys()]).toEqual(['C002'])
    expect(history.map(record => record.cluster_id)).toEqual(['C002'])
    // The conservative direction, spelled out: the new cluster set reports the stamped
    // cluster as a gap a human has to resolve.
    expect(coverageGaps(['C001', 'C002'], latest)).toEqual(['C001'])
  })

  it('lets a plain re-assess speak for a run whose revision pointer is gone', async () => {
    // With the pointer deleted, `clone_assess` finds no revision and stamps nothing, so
    // `recordAssessment` asks about `undefined`. Reading the whole file made the OLD
    // stamped verdict a duplicate and refused with "'C001' already has a verdict for
    // this scan revision" — the documented recovery after a rescan was unavailable
    // exactly where the coverage contract had already stopped counting that verdict.
    const target = await paths()
    await recordAssessment(target, { ...assessment('C001', 'report_only'), scan_revision: 'rev-1' }, { replace: false })
    const re = await recordAssessment(target, assessment('C001', 'skipped'), { replace: false })
    expect(re.replaced).toBe(false)
    const { latest } = await loadAssessments(target)
    expect(latest.get('C001')?.verdict).toBe('skipped')
    // And the write side now agrees with this read side: the verdict just written is an
    // unstamped record of the (unknown) current revision, so a second plain one is a
    // genuine duplicate and still needs `replace: true`.
    await expect(recordAssessment(target, assessment('C001', 'report_only'), { replace: false }))
      .rejects.toThrow(/already has a verdict/)
  })

  it('round-trips the evidence a verdict was recorded with', async () => {
    const target = await paths()
    const evidence = { file: 'module/laws/src/a.cpp', line: 12, snippet: 'virtual void draw();' }
    await recordAssessment(target, { ...assessment('C001', 'report_only'), evidence }, { replace: false })
    // A record written before the field existed carries none: "not recorded" must
    // stay distinguishable from an invented value, and must not upset the reader.
    await recordAssessment(target, assessment('C002', 'skipped'), { replace: false })
    const { latest } = await loadAssessments(target)
    expect(latest.get('C001')?.evidence).toEqual(evidence)
    expect(latest.get('C002')?.evidence).toBeUndefined()
  })

  it('repairs a torn tail instead of letting it swallow the next record', async () => {
    const target = await paths()
    await recordAssessment(target, assessment('C001', 'report_only'), { replace: false })
    // A crash mid-append leaves a fragment with no trailing newline. Without the
    // repair the next append would glue onto it and readJsonl would drop BOTH.
    await writeAtomic(target.assessments, `${JSON.stringify(assessment('C001', 'report_only'))}\n{"cluster_id":"C0`)
    await recordAssessment(target, assessment('C002', 'skipped'), { replace: false })
    const { records, droppedLines } = await readJsonl<Assessment>(target.assessments)
    expect(droppedLines).toEqual([])
    expect(records.map(record => record.cluster_id)).toEqual(['C001', 'C002'])
  })

  it('leaves a corrupt middle line alone for readJsonl to report', async () => {
    const target = await paths()
    // The tail is complete, so nothing is rewritten: the damage is reported, not hidden.
    await writeAtomic(target.assessments, `${JSON.stringify(assessment('C001', 'report_only'))}\n{broken\n{"cluster_id":"C002","verdict":"skipped","priority":"PX","reason":"r","files_changed":[],"recorded_at":"2026-09-20T00:00:00.000Z"}\n`)
    const { records, droppedLines } = await readJsonl<Assessment>(target.assessments)
    expect(droppedLines).toEqual([2])
    expect(records.map(record => record.cluster_id)).toEqual(['C001', 'C002'])
  })
})

describe('patches', () => {
  it('round-trips the authorization ledger', async () => {
    const target = await paths()
    const patches: PatchRecord[] = [{
      cluster_id: 'C003', priority: 'P0', files_changed: ['module/laws/src/a.cpp'],
      recorded_at: '2026-09-20T00:00:00.000Z',
      // The authorization carries the same evidence as the verdict it records.
      evidence: { file: 'module/laws/src/a.cpp', line: 12, snippet: 'static int area(const Rect& r)' },
    }]
    await savePatches(target, patches)
    expect(await loadPatches(target)).toEqual(patches)
    expect(await loadPatches(await paths())).toEqual([])
  })
})

describe('requireText', () => {
  it('trims and rejects an empty or non-string value', () => {
    expect(requireText('  x ', 'run_id')).toBe('x')
    expect(() => requireText('   ', 'run_id')).toThrow(/run_id is required/)
    expect(() => requireText(7, 'run_id')).toThrow(/run_id is required/)
  })
})
