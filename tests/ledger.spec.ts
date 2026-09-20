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

  it('keeps the newest record per cluster', async () => {
    const target = await paths()
    await recordAssessment(target, assessment('C001', 'report_only'), { replace: false })
    await recordAssessment(target, assessment('C002', 'skipped'), { replace: false })
    const { latest, droppedLines } = await loadAssessments(target)
    expect([...latest.keys()].sort()).toEqual(['C001', 'C002'])
    expect(droppedLines).toEqual([])
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
