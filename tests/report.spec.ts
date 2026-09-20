import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runPaths } from '../src/core/artifacts.ts'
import { resolveSettings } from '../src/config.ts'
import { renderReport, summarizeReport, writeReport, type ReportInput } from '../src/report/report.ts'
import type { Assessment, Cluster, PatchRecord, VerifyResult } from '../src/core/schema.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()!() })

async function paths(): Promise<ReturnType<typeof runPaths>> {
  const root = await mkdtemp(join(tmpdir(), 'clone-report-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  return runPaths(root, 'run-1')
}

const CLUSTERS: Cluster[] = [
  {
    id: 'C001', size: 2, files: ['module/laws/src/a.cpp', 'module/laws/src/b.cpp'], functions: ['ComputeArea'],
    representative: {
      pair_id: 'p1', similarity: 0.95, detection_method: 'type12',
      left: { file: 'module/laws/src/a.cpp', function: 'ComputeArea', lines: '10-20', body: 'int x;' },
      right: { file: 'module/laws/src/b.cpp', function: 'ComputeArea', lines: '30-40', body: 'int y;' },
    },
  },
  {
    id: 'C002', size: 1, files: ['module/laws/src/y.cpp', 'module/laws/src/z.cpp'], functions: [],
    representative: {
      pair_id: 'p2', similarity: 0.4, detection_method: 'type12',
      left: { file: 'module/laws/src/z.cpp', function: 'Orphan', lines: '70-80', body: '' },
      right: { file: 'module/laws/src/y.cpp', function: 'Orphan2', lines: '90-100', body: '' },
    },
  },
]

function assessment(clusterId: string, verdict: Assessment['verdict']): Assessment {
  return { cluster_id: clusterId, verdict, priority: 'P0', reason: 'same body, no API change', files_changed: verdict === 'patched' ? ['module/laws/src/a.cpp'] : [], recorded_at: '2026-09-20T00:00:00.000Z' }
}

function input(overrides: Partial<ReportInput> = {}): ReportInput {
  return {
    run: {
      run_id: 'run-1', project_root: 'D:/gme', baseline: { head: 'abc123', branch: 'main', dirty: [] },
      branch: 'clone-refactor/run-1', original_branch: 'main', detection_provider: 'csv', cluster_path: 'inline',
      created_at: '2026-09-20T00:00:00.000Z', updated_at: '2026-09-20T00:00:00.000Z',
      settings: {} as ReportInput['run']['settings'],
    },
    clusters: CLUSTERS,
    assessments: new Map([['C001', assessment('C001', 'patched')]]),
    patches: [{ cluster_id: 'C001', priority: 'P0', files_changed: ['module/laws/src/a.cpp'], recorded_at: '2026-09-20T00:00:00.000Z' }] as PatchRecord[],
    verify: [],
    job: undefined,
    droppedLines: [],
    unauthorized: [],
    notes: '',
    allowPartial: false,
    language: 'zh',
    ...overrides,
  }
}

describe('summarizeReport', () => {
  it('counts verdicts, gaps and the detection path', () => {
    const summary = summarizeReport(input())
    expect(summary.clusters).toBe(2)
    expect(summary.recorded).toBe(1)
    expect(summary.missing).toBe(1)
    expect(summary.patched).toBe(1)
    expect(summary.detection_provider).toBe('csv')
    expect(summary.cluster_path).toBe('inline')
  })
})

describe('renderReport', () => {
  it('names the detection path, the baseline and the verification result', () => {
    const verify: VerifyResult = {
      attempt: 1, ok: true, started_at: '2026-09-20T00:00:00.000Z', finished_at: '2026-09-20T00:10:00.000Z',
      rolled_back: false, rollback_files: [],
      steps: [{ name: 'build', phase: 'build', command: 'msbuild x.sln', required: true, always: false, exit_code: 0, ok: true, timed_out: false, log_file: 'D:/runs/run-1/verify/1/1-build.log', lossy: false }],
    }
    const text = renderReport(input({ verify: [verify], assessments: new Map([['C001', assessment('C001', 'patched')], ['C002', assessment('C002', 'report_only')]]) }))
    expect(text).toContain('run-1')
    expect(text).toContain('abc123')
    expect(text).toContain('csv')
    expect(text).toContain('inline')
    expect(text).toContain('msbuild x.sln')
    expect(text).toContain('C002')
  })

  it('lists the coverage gaps instead of hiding them', () => {
    const text = renderReport(input())
    expect(text).toMatch(/C002/)
  })

  it('groups clusters by priority, not by the order the ledger happens to hold them', () => {
    // The discriminating case: the P0 cluster has the *greater* id, so an implementation
    // that merely preserved ledger order (or sorted by id) would put C001 first and fail.
    const clusters: Cluster[] = [
      { ...CLUSTERS[1]!, id: 'C001' },
      { ...CLUSTERS[0]!, id: 'C002' },
    ]
    const text = renderReport(input({
      clusters,
      assessments: new Map([
        ['C001', { ...assessment('C001', 'report_only'), priority: 'P2' }],
        ['C002', { ...assessment('C002', 'report_only'), priority: 'P0' }],
      ]),
    }))
    expect(text).toContain('### P0（1）')
    expect(text).toContain('### P2（1）')
    expect(text.indexOf('### P0')).toBeLessThan(text.indexOf('### P2'))
    expect(text.indexOf('`C002`')).toBeLessThan(text.indexOf('`C001`'))
  })

  it('names the configured steps that did not run, so a skip cannot read as a smaller pipeline', () => {
    const verify: VerifyResult = {
      attempt: 1, ok: false, started_at: '2026-09-20T00:00:00.000Z', finished_at: '2026-09-20T00:10:00.000Z',
      rolled_back: false, rollback_files: [],
      steps: [{ name: 'build', phase: 'build', command: 'msbuild tests.sln', required: true, always: false, exit_code: 1, ok: false, timed_out: false, log_file: 'D:/runs/run-1/verify/1/1-build.log', lossy: false }],
    }
    const withSteps = input({ verify: [verify], assessments: new Map([['C001', assessment('C001', 'patched')], ['C002', assessment('C002', 'report_only')]]) })
    // The run's snapshot is what knows the full configured list; the attempt only has
    // the steps that executed.
    withSteps.run.settings = resolveSettings({
      projectRoot: 'D:/gme',
      verify: { steps: [{ name: 'build', phase: 'build', command: 'msbuild tests.sln' }, { name: 'test-debug', phase: 'test', command: 'tests.exe' }] },
    }).settings
    const text = renderReport(withSteps)
    expect(text).toContain('未执行')
    expect(text).toContain('test-debug')
    expect(text).toContain('本次共配置 2 步，实际执行 1 步')
  })
})

describe('writeReport', () => {
  it('refuses to close a run while a cluster has no verdict', async () => {
    const target = await paths()
    await expect(writeReport(target, input())).rejects.toThrow(/C002 .*no verdict|no verdict.*C002/s)
  })

  it('writes the three artifacts when the coverage contract holds', async () => {
    const target = await paths()
    const complete = input({
      assessments: new Map([['C001', assessment('C001', 'patched')], ['C002', assessment('C002', 'report_only')]]),
    })
    const written = await writeReport(target, complete)
    expect(written.summary.missing).toBe(0)
    expect(written.digest).toMatch(/^[0-9a-f]{16}$/)
    expect(JSON.parse(await readFile(target.summaryJson, 'utf8')).clusters).toBe(2)
    expect(JSON.parse(await readFile(target.findingsJson, 'utf8'))).toHaveLength(2)
    expect(await readFile(target.reportMd, 'utf8')).toContain('# ')
  })

  it('digests the same input to the same value, on disk and in the return value', async () => {
    const first = await paths()
    const second = await paths()
    const complete = input({
      assessments: new Map([['C001', assessment('C001', 'patched')], ['C002', assessment('C002', 'report_only')]]),
    })
    const left = await writeReport(first, complete)
    const right = await writeReport(second, complete)
    // A digest is only a check on a report if the same run always digests the same:
    // the two run directories differ, so only a pure renderer can agree.
    expect(right.digest).toBe(left.digest)
    // The digest the caller is handed is the one summary.json holds; a file that
    // disagrees with the return value is a run nobody can verify afterwards.
    expect(JSON.parse(await readFile(right.summary_path, 'utf8')).digest).toBe(right.digest)
    expect(await readFile(second.reportMd, 'utf8')).toBe(await readFile(first.reportMd, 'utf8'))
  })

  it('closes a partial run only when the caller accepts the gaps', async () => {
    const target = await paths()
    const written = await writeReport(target, input({ allowPartial: true }))
    expect(written.summary.missing).toBe(1)
    expect(await readFile(target.reportMd, 'utf8')).toMatch(/C002/)
  })
})
