import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runPaths, writeAtomic } from '../src/core/artifacts.ts'
import type { JobRecord } from '../src/core/jobs.ts'
import { resolveSettings } from '../src/config.ts'
import { renderReport, summarizeReport, writeReport, type ReportInput } from '../src/report/report.ts'
import type { Assessment, Cluster, PatchRecord, ReconcileAudit, VerifyResult } from '../src/core/schema.ts'
import { loadUnauthorized, loadVerifyAttempts } from '../src/verify/artifacts.ts'

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

/** One attempt's reconcile record: shaped, and about the ledger the fixture patches. */
function audit(): ReconcileAudit {
  return {
    authorized: ['module/laws/src/a.cpp'], changed: ['module/laws/src/a.cpp'], unauthorized: [], missing: [],
    cluster_ids: ['C001'], scan_revision: 'rev-1', recorded_at: '2026-09-20T00:00:00.000Z',
  }
}

/**
 * The newest VERIFY job record, on its own path from `result.json`.
 *
 * It names the attempt it settled, and that number has to match the newest attempt
 * DIRECTORY: a deleted terminal record is invisible to the job reader, so the newest
 * job left on disk is an EARLIER attempt's and may not stand in for the newest one.
 */
function verifyJob(status: JobRecord['status'], attempt = 1): JobRecord {
  return {
    job_id: 'verify-20260920-000000-aaaa', run_id: 'run-1', kind: 'verify', status, attempt,
    started_at: '2026-09-20T00:00:00.000Z', finished_at: status === 'running' ? null : '2026-09-20T00:10:00.000Z',
    error: null, summary: '',
  }
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
    // The default state is "no verification was ever attempted": no attempt
    // directory, no verify job and no reconcile record. A test that supplies an
    // attempt states all three, because the summary's verdict is the submit gate's
    // and those are the gate's own inputs.
    newestAttempt: undefined,
    verifyJob: undefined,
    audit: undefined,
    // Every patch this input carries is the one `audit()` reconciled (`C001` at the
    // audit's own `recorded_at`, under its revision and file set), so the default is
    // "covered". A test about a patch authorized AFTER the attempt says `false`.
    patchesCovered: true,
    job: undefined,
    droppedLines: [],
    unauthorized: [],
    resolvedUnauthorized: [],
    unreadableRecords: [],
    // The freeze claim is backed unless a test says the newest attempt left no
    // reconcile record at all.
    missingReconcileAttempt: undefined,
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
    const text = renderReport(input({
      verify: [verify],
      newestAttempt: 1, verifyJob: verifyJob('succeeded'), audit: audit(),
      assessments: new Map([['C001', assessment('C001', 'patched')], ['C002', assessment('C002', 'report_only')]]),
    }))
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
    // The row itself, not just the first mention of the id: whoever puts a bare id back
    // in the cell, or lets the grouping drift, gets a red test rather than a silent pass.
    expect(text).toContain('| `C002` | P0 | report_only |')
  })

  it('concludes verification from the newest attempt, not from every attempt ever recorded', () => {
    const complete = new Map([['C001', assessment('C001', 'patched')], ['C002', assessment('C002', 'report_only')]])
    const outcome = (attempt: number, ok: boolean): VerifyResult => ({
      attempt, ok, started_at: '2026-09-20T00:00:00.000Z', finished_at: '2026-09-20T00:10:00.000Z',
      rolled_back: false, rollback_files: [],
      steps: [{ name: 'build', phase: 'build', command: 'msbuild t.sln', required: true, always: false, exit_code: ok ? 0 : 1, ok, timed_out: false, log_file: `D:/runs/run-1/verify/${attempt}/1-build.log`, lossy: false }],
    })
    // The sequence the plan is built around: attempt 1 fails, the patch is fixed, attempt 2
    // passes. A submit gate reads the newest attempt, so the closing report must too, or it
    // tells a human not to commit work the tooling accepts.
    const recovered = input({
      verify: [outcome(1, false), outcome(2, true)], assessments: complete,
      newestAttempt: 2, verifyJob: verifyJob('succeeded', 2), audit: audit(),
    })
    expect(summarizeReport(recovered).verify_ok).toBe(true)
    expect(renderReport(recovered)).toContain('验证 attempts: 2（最新一次 ok: true）')
    expect(renderReport(recovered)).not.toContain('有已 patch 的簇没有通过的验证')
    // The other direction: a pass that a later failing attempt broke is not a pass, so
    // "newest" cannot be satisfied by "some attempt passed".
    const regressed = input({
      verify: [outcome(1, true), outcome(2, false)], assessments: complete,
      newestAttempt: 2, verifyJob: verifyJob('failed', 2), audit: audit(),
    })
    expect(summarizeReport(regressed).verify_ok).toBe(false)
    expect(renderReport(regressed)).toContain('有已 patch 的簇没有通过的验证')
  })

  it('does not call a run verified when the newest attempt has no result at all', () => {
    // Attempt 1 recorded a passing result.json; attempt 2 wrote its reconcile.json and
    // then never produced a result (frozen before the job started, or killed mid-build).
    // `loadVerifyAttempts` can only return the attempts it can READ, so a verdict built
    // from that list alone said "verify_attempts: 1, verify_ok: true" about a run whose
    // newest verification has no outcome — while the submit gate, reading the attempt
    // DIRECTORY, refuses it. The two artefacts a human and a machine trust were the
    // wrong ones.
    const complete = new Map([['C001', assessment('C001', 'patched')], ['C002', assessment('C002', 'report_only')]])
    const outcome = (attempt: number, ok: boolean): VerifyResult => ({
      attempt, ok, started_at: '2026-09-20T00:00:00.000Z', finished_at: '2026-09-20T00:10:00.000Z',
      rolled_back: false, rollback_files: [], steps: [],
    })
    const newestHasNoResult = input({
      verify: [outcome(1, true)], assessments: complete,
      newestAttempt: 2, verifyJob: verifyJob('succeeded', 2), audit: audit(),
    })
    expect(summarizeReport(newestHasNoResult).verify_ok).toBe(false)
    expect(summarizeReport(newestHasNoResult).unverified).toBe(true)
    expect(renderReport(newestHasNoResult)).toContain('有已 patch 的簇没有通过的验证')

    // The no-newer-attempt case is a pass: the same three inputs, with the newest
    // attempt being the one that passed and settled.
    const settled = input({
      verify: [outcome(1, true)], assessments: complete,
      newestAttempt: 1, verifyJob: verifyJob('succeeded'), audit: audit(),
    })
    expect(summarizeReport(settled).verify_ok).toBe(true)
    expect(summarizeReport(settled).unverified).toBe(false)
    expect(renderReport(settled)).not.toContain('有已 patch 的簇没有通过的验证')

    // And an unreadable reconcile record is not a pass either: "cannot be shown" must
    // never read as "verified".
    const noReconcile = input({
      verify: [outcome(1, true)], assessments: complete,
      newestAttempt: 1, verifyJob: verifyJob('succeeded'), audit: undefined,
    })
    expect(summarizeReport(noReconcile).verify_ok).toBe(false)
    expect(summarizeReport(noReconcile).unverified).toBe(true)
  })

  it('warns about a patch the newest attempt never covered, while still reporting that attempt as passed', () => {
    // The reproduced state: attempt 1 PASSED for C001, and then `clone_assess C002
    // patched` authorized a second cluster — the flow `clone_submit`'s own description
    // names ("a patch authorized after it"). `verify_ok` is a fact about the NEWEST
    // ATTEMPT, and that attempt genuinely passed, so a summary that derived "nothing is
    // unverified" from it alone printed no warning about a patch no build ever saw
    // while `clone_submit` refused the same ledger (`late`). The warning text is
    // "有已 patched 的簇没有通过的验证", and C002 is exactly such a cluster.
    const complete = new Map([['C001', assessment('C001', 'patched')], ['C002', assessment('C002', 'patched')]])
    const attempt: VerifyResult = {
      attempt: 1, ok: true, started_at: '2026-09-20T00:00:00.000Z', finished_at: '2026-09-20T00:10:00.000Z',
      rolled_back: false, rollback_files: [], steps: [],
    }
    const afterTheAttempt = input({
      verify: [attempt], assessments: complete,
      newestAttempt: 1, verifyJob: verifyJob('succeeded'), audit: audit(),
      patchesCovered: false,
    })
    // Both facts, and neither is the other's opposite: the newest attempt passed AND a
    // current patch is uncovered. Reporting `ok: false` here would be the opposite lie.
    expect(summarizeReport(afterTheAttempt).verify_ok).toBe(true)
    expect(summarizeReport(afterTheAttempt).unverified).toBe(true)
    expect(renderReport(afterTheAttempt)).toContain('验证 attempts: 1（最新一次 ok: true）')
    expect(renderReport(afterTheAttempt)).toContain('有已 patch 的簇没有通过的验证')

    // The same passing attempt with every current patch covered carries no warning.
    const covered = input({
      verify: [attempt], assessments: complete,
      newestAttempt: 1, verifyJob: verifyJob('succeeded'), audit: audit(),
      patchesCovered: true,
    })
    expect(summarizeReport(covered).verify_ok).toBe(true)
    expect(summarizeReport(covered).unverified).toBe(false)
    expect(renderReport(covered)).not.toContain('有已 patch 的簇没有通过的验证')
  })

  it('labels the resolved-freeze sentence with the newest attempt DIRECTORY, not the newest readable result', async () => {
    // Three attempt directories, and only attempt 1 wrote a `result.json`: attempt 2 was
    // killed mid-build and the newest attempt (3) recorded its reconcile and nothing
    // else. The durable sentence named `input.verify.at(-1)?.attempt` — the newest
    // READABLE result — so a run whose newest reconcile is attempt 3 told the operator
    // that attempt 1's reconcile had resolved the older freeze.
    const target = await paths()
    await writeAtomic(join(target.verifyDir, '1', 'result.json'), `${JSON.stringify({
      attempt: 1, ok: false, started_at: '2026-09-20T01:00:00.000Z', finished_at: '2026-09-20T01:10:00.000Z',
      rolled_back: false, rollback_files: [], steps: [],
    } satisfies VerifyResult)}\n`)
    await writeAtomic(join(target.verifyDir, '1', 'reconcile.json'), `${JSON.stringify({
      ...audit(), changed: ['module/laws/src/a.cpp', 'module/laws/src/sneaky.cpp'],
      unauthorized: ['module/laws/src/sneaky.cpp'],
    })}\n`)
    // Attempt 2 owns its directory with a step log and no result at all.
    await writeAtomic(join(target.verifyDir, '2', '1-build.log'), 'killed mid-build\n')
    await writeAtomic(join(target.verifyDir, '3', 'reconcile.json'), `${JSON.stringify(audit())}\n`)

    const verify = await loadVerifyAttempts(target)
    const status = await loadUnauthorized(target)
    // The fixture is what makes the two numbers disagree, so it is asserted rather
    // than assumed: one readable result, and a newest directory of 3.
    expect(verify.map(attempt => attempt.attempt)).toEqual([1])
    expect(status.newestAttempt).toBe(3)
    expect(status.resolved).toEqual(['module/laws/src/sneaky.cpp'])
    const text = renderReport(input({
      verify,
      assessments: new Map([['C001', assessment('C001', 'report_only')], ['C002', assessment('C002', 'report_only')]]),
      newestAttempt: status.newestAttempt, audit: status.newestAudit, verifyJob: verifyJob('succeeded', 3),
      unauthorized: status.files, resolvedUnauthorized: status.resolved,
    }))
    expect(text).toContain('最新一次 reconcile（attempt 3）')
    expect(text).not.toContain('attempt 1）已不含它们')
  })

  it('keeps a row intact when a reason carries a pipe or a newline', () => {
    const reason = 'replaced `a | b` with `a || b`\nsecond line'
    const text = renderReport(input({
      assessments: new Map([
        ['C001', { ...assessment('C001', 'patched'), reason }],
        ['C002', assessment('C002', 'report_only')],
      ]),
    }))
    const lines = text.split('\n')
    const header = lines.find(line => line.startsWith('| 簇 |'))!
    const row = lines.find(line => line.startsWith('| `C001`'))!
    // An escaped pipe is content; a bare pipe is a column separator.
    const columns = (line: string): number => line.replaceAll('\\|', '').split('|').length
    expect(row).toContain('a \\| b')
    expect(row).toContain('second line')
    expect(columns(row)).toBe(columns(header))
    // The newline is gone, so nothing spilled out of the row as a line of its own.
    expect(lines.some(line => line.trim() === 'second line')).toBe(false)
  })

  it('escapes a verification command the same way, so the evidence row stays one row', () => {
    const verify: VerifyResult = {
      attempt: 1, ok: false, started_at: '2026-09-20T00:00:00.000Z', finished_at: '2026-09-20T00:10:00.000Z',
      rolled_back: false, rollback_files: [],
      steps: [{ name: 'build|debug', phase: 'build', command: 'msbuild a | b', required: true, always: false, exit_code: 1, ok: false, timed_out: false, log_file: 'D:/runs/run-1/verify/1/1-build.log', lossy: false }],
    }
    const text = renderReport(input({
      verify: [verify],
      newestAttempt: 1, verifyJob: verifyJob('failed'), audit: audit(),
      assessments: new Map([['C001', assessment('C001', 'patched')], ['C002', assessment('C002', 'report_only')]]),
    }))
    const lines = text.split('\n')
    const header = lines.find(line => line.startsWith('| 步骤 |'))!
    const row = lines.find(line => line.includes('msbuild a \\| b'))!
    const columns = (line: string): number => line.replaceAll('\\|', '').split('|').length
    expect(row).toContain('build\\|debug')
    expect(columns(row)).toBe(columns(header))
  })

  it('keeps an assessed cluster whose priority is outside the vocabulary, instead of dropping its row', () => {
    const text = renderReport(input({
      assessments: new Map([
        ['C001', { ...assessment('C001', 'report_only'), priority: 'P9' as unknown as Assessment['priority'] }],
        ['C002', assessment('C002', 'report_only')],
      ]),
    }))
    expect(text).toContain('### 其他优先级 / other priority（1）')
    expect(text).toContain('| `C001` | P9 | report_only |')
  })

  it('carries the evidence for each cluster: the line range and a snippet of the body', () => {
    const text = renderReport(input({
      assessments: new Map([['C001', assessment('C001', 'patched')], ['C002', assessment('C002', 'report_only')]]),
    }))
    const row = text.split('\n').find(line => line.startsWith('| `C001`'))!
    expect(row).toContain('`module/laws/src/a.cpp:10-20`')
    expect(row).toContain('`module/laws/src/b.cpp:30-40`')
    expect(row).toContain('`int x;`')
    expect(row).toContain('same body, no API change')
    // A representative with no body says so, rather than leaving a blank cell to read as one.
    expect(text.split('\n').find(line => line.startsWith('| `C002`'))!).toContain('| — |')
  })

  it('counts each priority in the overview, not only in the group headings', () => {
    const text = renderReport(input({
      assessments: new Map([
        ['C001', { ...assessment('C001', 'patched'), priority: 'P0' }],
        ['C002', { ...assessment('C002', 'report_only'), priority: 'P2' }],
      ]),
    }))
    expect(text).toContain('各优先级 by priority: P0 1 / P1 0 / P2 1 / PX 0')
  })

  it('says why a failed attempt was not rolled back, instead of printing nothing', () => {
    const failed: VerifyResult = {
      attempt: 1, ok: false, started_at: '2026-09-20T00:00:00.000Z', finished_at: '2026-09-20T00:10:00.000Z',
      rolled_back: false, rollback_files: [],
      steps: [{ name: 'build', phase: 'build', command: 'msbuild t.sln', required: true, always: false, exit_code: 1, ok: false, timed_out: false, log_file: 'D:/runs/run-1/verify/1/1-build.log', lossy: false }],
    }
    const complete = new Map([['C001', assessment('C001', 'patched')], ['C002', assessment('C002', 'report_only')]])
    // A dirty baseline is the spec's documented suppression: there is no baseline worth
    // restoring to, and a restore would destroy the operator's own uncommitted work.
    const baseline = input()
    const dirty = renderReport(input({
      verify: [failed], assessments: complete,
      run: { ...baseline.run, baseline: { head: 'abc123', branch: 'main', dirty: ['module/laws/src/user.cpp'] } },
    }))
    expect(dirty).toContain('未回滚 / not rolled back')
    expect(dirty).toContain('基线不干净')
    // The other documented suppression: the operator asked to keep the failed patch.
    const kept = input({ verify: [failed], assessments: complete })
    kept.run.settings = resolveSettings({
      projectRoot: 'D:/gme',
      verify: { keepFailedPatch: true, steps: [{ name: 'build', phase: 'build', command: 'msbuild t.sln' }] },
    }).settings
    expect(renderReport(kept)).toContain('未回滚 / not rolled back')
    expect(renderReport(kept)).toContain('keepFailedPatch')
  })

  it('names the configured steps from the attempt itself, so a mid-run edit cannot invent a skip', () => {
    // The engine runs the LIVE `settings.verify.steps`, while the "not run" line used
    // to be derived from the run SNAPSHOT. An operator who removes a step mid-run —
    // an advertised flow — then got a step named as "skipped after an earlier
    // failure" that the engine was never configured with, and a wrong count: a false
    // CAUSE for a step that was deleted. The attempt's own record is what the engine
    // actually ran against.
    const verify: VerifyResult = {
      attempt: 1, ok: false, started_at: '2026-09-20T00:00:00.000Z', finished_at: '2026-09-20T00:10:00.000Z',
      rolled_back: false, rollback_files: [],
      configured_steps: ['build'],
      steps: [{ name: 'build', phase: 'build', command: 'msbuild tests.sln', required: true, always: false, exit_code: 1, ok: false, timed_out: false, log_file: 'D:/runs/run-1/verify/1/1-build.log', lossy: false }],
    }
    const complete = new Map([['C001', assessment('C001', 'patched')], ['C002', assessment('C002', 'report_only')]])
    const removedMidRun = input({ verify: [verify], assessments: complete })
    // The snapshot still holds the step the operator removed from the live list.
    removedMidRun.run.settings = resolveSettings({
      projectRoot: 'D:/gme',
      verify: { steps: [{ name: 'build', phase: 'build', command: 'msbuild tests.sln' }, { name: 'test-debug', phase: 'test', command: 'tests.exe' }] },
    }).settings
    const text = renderReport(removedMidRun)
    expect(text).not.toContain('test-debug')
    expect(text).not.toContain('未执行')

    // The mirror case: a step the operator ADDED mid-run was configured for this
    // attempt and never ran, so it must still be named — from the attempt's record,
    // not from the snapshot that no longer holds it.
    const addedMidRun = input({
      verify: [{ ...verify, configured_steps: ['build', 'test-debug'] }], assessments: complete,
    })
    addedMidRun.run.settings = resolveSettings({
      projectRoot: 'D:/gme',
      verify: { steps: [{ name: 'build', phase: 'build', command: 'msbuild tests.sln' }] },
    }).settings
    const added = renderReport(addedMidRun)
    expect(added).toContain('test-debug')
    expect(added).toContain('本次共配置 2 步，实际执行 1 步')
  })

  it('falls back to the run snapshot for an attempt whose result predates the recorded step list', () => {
    // Backwards compatibility: `configured_steps` is absent on a `result.json`
    // written before the engine recorded it. The snapshot is then the only source
    // left, and it must still be read rather than the line disappearing.
    const verify: VerifyResult = {
      attempt: 1, ok: false, started_at: '2026-09-20T00:00:00.000Z', finished_at: '2026-09-20T00:10:00.000Z',
      rolled_back: false, rollback_files: [],
      steps: [{ name: 'build', phase: 'build', command: 'msbuild tests.sln', required: true, always: false, exit_code: 1, ok: false, timed_out: false, log_file: 'D:/runs/run-1/verify/1/1-build.log', lossy: false }],
    }
    const withSteps = input({ verify: [verify], assessments: new Map([['C001', assessment('C001', 'patched')], ['C002', assessment('C002', 'report_only')]]) })
    withSteps.run.settings = resolveSettings({
      projectRoot: 'D:/gme',
      verify: { steps: [{ name: 'build', phase: 'build', command: 'msbuild tests.sln' }, { name: 'test-debug', phase: 'test', command: 'tests.exe' }] },
    }).settings
    const text = renderReport(withSteps)
    expect(text).toContain('未执行')
    expect(text).toContain('test-debug')
    expect(text).toContain('本次共配置 2 步，实际执行 1 步')
  })

  it('explains a rollback that FAILED, instead of claiming there was nothing to roll back', () => {
    // `checkoutFiles` threw, so the second write that would have recorded the outcome
    // never happened and `rolled_back` stayed false. Falling through to the last
    // branch told the operator nothing needed rolling back while the failed patch was
    // still in their tree.
    const failed: VerifyResult = {
      attempt: 1, ok: false, started_at: '2026-09-20T00:00:00.000Z', finished_at: '2026-09-20T00:10:00.000Z',
      rolled_back: false, rollback_files: [],
      rollback_error: 'Cannot roll back module/laws/src/a.cpp: error: pathspec did not match any file(s) known to git',
      steps: [{ name: 'build', phase: 'build', command: 'msbuild t.sln', required: true, always: false, exit_code: 1, ok: false, timed_out: false, log_file: 'D:/runs/run-1/verify/1/1-build.log', lossy: false }],
    }
    const complete = new Map([['C001', assessment('C001', 'patched')], ['C002', assessment('C002', 'report_only')]])
    const text = renderReport(input({ verify: [failed], assessments: complete }))
    expect(text).toContain('未回滚 / not rolled back')
    expect(text).toContain('自动回滚失败')
    expect(text).toContain('Cannot roll back module/laws/src/a.cpp')
    expect(text).not.toContain('没有记录到回滚文件')
  })

  it('stops claiming a freeze once the newest attempt reconciled clean', () => {
    // Attempt 1 found a file outside the ledger and the run froze (correctly); the
    // operator reverted it and attempt 2 reconciled clean. The freeze claim came from
    // the UNION of every attempt ever recorded, so a finished, submitted run printed
    // "this run is frozen and must not be verified or submitted".
    const failed: VerifyResult = {
      attempt: 1, ok: false, started_at: '2026-09-20T00:00:00.000Z', finished_at: '2026-09-20T00:10:00.000Z',
      rolled_back: false, rollback_files: [],
      steps: [{ name: 'build', phase: 'build', command: 'msbuild t.sln', required: true, always: false, exit_code: 1, ok: false, timed_out: false, log_file: 'D:/runs/run-1/verify/1/1-build.log', lossy: false }],
    }
    const passed: VerifyResult = {
      attempt: 2, ok: true, started_at: '2026-09-20T01:00:00.000Z', finished_at: '2026-09-20T01:10:00.000Z',
      rolled_back: false, rollback_files: [],
      steps: [{ name: 'build', phase: 'build', command: 'msbuild t.sln', required: true, always: false, exit_code: 0, ok: true, timed_out: false, log_file: 'D:/runs/run-1/verify/2/1-build.log', lossy: false }],
    }
    const complete = new Map([['C001', assessment('C001', 'patched')], ['C002', assessment('C002', 'report_only')]])
    const resolved = input({
      verify: [failed, passed], assessments: complete,
      unauthorized: [], resolvedUnauthorized: ['module/laws/src/sneaky.cpp'],
    })
    const text = renderReport(resolved)
    expect(text).not.toContain('## 未授权改动')
    expect(text).not.toContain('本 run 已冻结')
    // The history is kept and MARKED resolved, so the earlier freeze stays auditable
    // without being claimed as the run's current state.
    expect(text).toContain('已解决')
    expect(text).toMatch(/sneaky\.cpp/)
    expect(summarizeReport(resolved).unauthorized_files).toEqual([])
    expect(summarizeReport(resolved).resolved_unauthorized_files).toEqual(['module/laws/src/sneaky.cpp'])
  })

  it('says the newest attempt left no reconcile record instead of implying the run is clean', () => {
    // The submit gate refuses when the newest attempt has NO reconcile record, while
    // the freeze claim came from the newest attempt that HAD a readable one. Delete
    // `reconcile.json` outright and the report printed no frozen section at all —
    // which reads as "nothing was unauthorized" for a run the tooling will not
    // submit. The report must name the missing record.
    const failed: VerifyResult = {
      attempt: 1, ok: false, started_at: '2026-09-20T00:00:00.000Z', finished_at: '2026-09-20T00:10:00.000Z',
      rolled_back: false, rollback_files: [],
      steps: [{ name: 'build', phase: 'build', command: 'msbuild t.sln', required: true, always: false, exit_code: 1, ok: false, timed_out: false, log_file: 'D:/runs/run-1/verify/1/1-build.log', lossy: false }],
    }
    const passed: VerifyResult = {
      attempt: 2, ok: true, started_at: '2026-09-20T01:00:00.000Z', finished_at: '2026-09-20T01:10:00.000Z',
      rolled_back: false, rollback_files: [],
      steps: [{ name: 'build', phase: 'build', command: 'msbuild t.sln', required: true, always: false, exit_code: 0, ok: true, timed_out: false, log_file: 'D:/runs/run-1/verify/2/1-build.log', lossy: false }],
    }
    const complete = new Map([['C001', assessment('C001', 'patched')], ['C002', assessment('C002', 'report_only')]])
    const text = renderReport(input({
      verify: [failed, passed], assessments: complete,
      // Attempt 2's reconcile.json is gone, so there is no newest reconcile to claim
      // a freeze from — and none to call an older finding resolved, either.
      unauthorized: [], resolvedUnauthorized: [],
      missingReconcileAttempt: 2,
    }))
    expect(text).toContain('冻结状态未知')
    expect(text).toContain('没有可读的 `reconcile.json`')
    expect(text).toContain('attempt 2')
    expect(text).toContain('clone_verify')
    // The claims that must NOT be made: an unbacked "this run is not frozen", and a
    // resolved-freeze section that would read as a clean bill of health.
    expect(text).not.toContain('本 run 未被冻结')
    expect(text).not.toContain('已解决的冻结')
    expect(text).not.toContain('## 未授权改动')
  })

  it('explains a verify job that does not name the newest attempt, the state the gate refuses on', () => {
    // Reachable WITHOUT tampering: every run verified before `attempt` existed has a
    // `succeeded` verify job record that names no attempt. The report then published
    // `最新一次 ok: false`, the unverified warning, `### attempt N — PASS` and a
    // `## 最近的后台任务` line reading `verify-… (verify) → **succeeded**` — which is an
    // EARLIER attempt's record, the newest left on disk — with nothing connecting them.
    // Every line was true under the report's own definitions, and the operator still
    // could not tell why `clone_submit` refuses; that "Last job → succeeded" line is
    // exactly the shape the unreadable-records section exists to prevent.
    const complete = new Map([['C001', assessment('C001', 'patched')], ['C002', assessment('C002', 'report_only')]])
    const passed: VerifyResult = {
      attempt: 1, ok: true, started_at: '2026-09-20T00:00:00.000Z', finished_at: '2026-09-20T00:10:00.000Z',
      rolled_back: false, rollback_files: [], steps: [],
    }
    // A record written before the field existed: no `attempt` key at all.
    const legacy: JobRecord = {
      job_id: 'verify-20260920-000000-aaaa', run_id: 'run-1', kind: 'verify', status: 'succeeded',
      started_at: '2026-09-20T00:00:00.000Z', finished_at: '2026-09-20T00:10:00.000Z',
      error: null, summary: 'attempt 1: PASS',
    }
    const text = renderReport(input({
      verify: [passed], assessments: complete,
      newestAttempt: 1, verifyJob: legacy, audit: audit(),
      // The run's last job is that same record, so the report shows the shape the
      // operator reads as "the verification succeeded".
      job: legacy,
    }))
    expect(text).toContain('## 最近的后台任务')
    expect(text).toContain('**succeeded**')
    expect(text).toContain('验证任务与最新尝试')
    expect(text).toContain('没有记录它')
    expect(text).toContain('attempt 1')
    expect(text).toContain('clone_submit')
    expect(text).toContain('clone_verify')

    // The normal case: the same three records, with a job that NAMES the attempt, add
    // no such section — the report must not cry wolf on a run that settled cleanly.
    const settled = renderReport(input({
      verify: [passed], assessments: complete, newestAttempt: 1, verifyJob: verifyJob('succeeded'), audit: audit(),
    }))
    expect(settled).not.toContain('验证任务与最新尝试')
    expect(settled).not.toContain('没有记录它')
  })

  it('names a verify job that belongs to another attempt, and one that is missing outright', () => {
    const complete = new Map([['C001', assessment('C001', 'patched')], ['C002', assessment('C002', 'report_only')]])
    const outcome = (attempt: number): VerifyResult => ({
      attempt, ok: true, started_at: '2026-09-20T00:00:00.000Z', finished_at: '2026-09-20T00:10:00.000Z',
      rolled_back: false, rollback_files: [], steps: [],
    })
    // Attempt 2 passed and then its terminal job record was lost; the newest verify job
    // left on disk is attempt 1's succeeded one, which stood in for it.
    const other = renderReport(input({
      verify: [outcome(1), outcome(2)], assessments: complete,
      newestAttempt: 2, verifyJob: verifyJob('succeeded', 1), audit: audit(),
    }))
    expect(other).toContain('属于 attempt 1')
    expect(other).toContain('attempt 2')
    expect(other).toContain('clone_verify')

    // No verify job record at all: the gate refuses for the same reason, so the report
    // says which record is missing rather than leaving the overview's `ok: false` with
    // no explanation next to the last-job line.
    const missing = renderReport(input({
      verify: [outcome(1)], assessments: complete, newestAttempt: 1, audit: audit(),
    }))
    expect(missing).toContain('没有最新的 verify job 记录')
    expect(missing).toContain('attempt 1')
  })

  it('names an unreadable job record instead of reporting an older job as the last one', () => {
    // A corrupt `<id>.json` is skipped by `latestJob`, so the "last job" section would
    // silently present an OLDER job — in the artefact meant for audit. The skip has to
    // be visible.
    const job: JobRecord = {
      job_id: 'scan-20260920-010000-aaaa', run_id: 'run-1', kind: 'scan', status: 'succeeded',
      started_at: '2026-09-20T01:00:00.000Z', finished_at: '2026-09-20T01:01:00.000Z', error: null, summary: '1 cluster(s)',
    }
    const corrupt = 'verify-20260920-050000-cccc.json'
    const named = input({ job, unreadableRecords: [corrupt] })
    const text = renderReport(named)
    expect(text).toContain('无法读取 / unreadable')
    expect(text).toContain(corrupt)
    // The older job is still reported, and the report says which file it could not read.
    expect(text).toContain('scan-20260920-010000-aaaa')
    expect(summarizeReport(named).unreadable_records).toEqual([corrupt])
  })
})

describe('writeReport', () => {
  it('refuses to close a run while a cluster has no verdict', async () => {
    const target = await paths()
    await expect(writeReport(target, input())).rejects.toThrow(/C002 .*no verdict|no verdict.*C002/s)
    // The refusal is before every write: a refused close leaves no artifact behind, so
    // nothing can be mistaken for a report that was produced.
    await expect(readFile(target.reportMd, 'utf8')).rejects.toThrow()
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

  it('writes per-priority counts a caller can read without parsing Markdown', async () => {
    const target = await paths()
    const written = await writeReport(target, input({
      assessments: new Map([
        ['C001', { ...assessment('C001', 'patched'), priority: 'P0' }],
        ['C002', { ...assessment('C002', 'report_only'), priority: 'P2' }],
      ]),
    }))
    expect(written.summary.by_priority).toEqual({ P0: 1, P2: 1 })
    expect(JSON.parse(await readFile(target.summaryJson, 'utf8')).by_priority).toEqual({ P0: 1, P2: 1 })
  })

  it('changes the digest when the report text changes', async () => {
    const first = await paths()
    const second = await paths()
    // A constant 16-hex string would satisfy the format and equality checks; only
    // sensitivity makes the digest a check on the text rather than a decoration.
    const left = await writeReport(first, input({
      assessments: new Map([['C001', assessment('C001', 'patched')], ['C002', assessment('C002', 'report_only')]]),
    }))
    const right = await writeReport(second, input({
      assessments: new Map([
        ['C001', assessment('C001', 'patched')],
        ['C002', { ...assessment('C002', 'report_only'), reason: 'a different reason' }],
      ]),
    }))
    expect(right.digest).not.toBe(left.digest)
  })

  it('closes a partial run only when the caller accepts the gaps', async () => {
    const target = await paths()
    const written = await writeReport(target, input({ allowPartial: true }))
    expect(written.summary.missing).toBe(1)
    expect(await readFile(target.reportMd, 'utf8')).toMatch(/C002/)
  })

  it('names the unauthorized files in a partial report instead of hiding them', async () => {
    // Reachable exactly the way a reviewer's probe reached it: the run is frozen
    // with UNAUTHORIZED_CHANGES, and `allow_partial: true` is the only way to close
    // it. The section that names the file is then the whole point of the artifact —
    // the file a human must resolve before the run can proceed.
    const target = await paths()
    const written = await writeReport(target, input({
      assessments: new Map([['C001', assessment('C001', 'patched')]]),
      unauthorized: ['module/laws/src/sneaky.cpp', 'module/laws/src/sneaky.cpp', 'module/laws/src/other.cpp'],
      allowPartial: true,
    }))
    const report = await readFile(target.reportMd, 'utf8')
    expect(report).toContain('## 未授权改动 / Unauthorized changes')
    expect(report).toContain('`module/laws/src/sneaky.cpp`')
    expect(report).toContain('`module/laws/src/other.cpp`')
    // Deduplicated and sorted in the machine-readable half, so both halves agree.
    expect(written.summary.unauthorized_files).toEqual(['module/laws/src/other.cpp', 'module/laws/src/sneaky.cpp'])
    expect(JSON.parse(await readFile(target.summaryJson, 'utf8')).unauthorized_files)
      .toEqual(['module/laws/src/other.cpp', 'module/laws/src/sneaky.cpp'])
    // And a run with no unauthorized change must NOT carry the heading: an empty
    // section would read as "something was reported here".
    const clean = await writeReport(await paths(), input({
      assessments: new Map([['C001', assessment('C001', 'patched')], ['C002', assessment('C002', 'report_only')]]),
    }))
    expect(await readFile(clean.report_path, 'utf8')).not.toContain('未授权改动')
  })
})
