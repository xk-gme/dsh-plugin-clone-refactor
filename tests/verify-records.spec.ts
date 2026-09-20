/**
 * The per-attempt verification records on disk: what `clone_submit` gates on and
 * what the report reads back.
 *
 * Three properties are pinned here, each of which was a defect:
 *
 * - a damaged record is skipped and NAMED, never an exception (the run has to stay
 *   observable, and `clone_submit`'s refusal has to stay readable);
 * - every verdict is newest-wins, so a resolved freeze stops reading as a freeze
 *   and the log window follows the attempt that is actually running;
 * - the next attempt number comes from the highest attempt DIRECTORY, so an attempt
 *   killed before its result.json cannot be overwritten by the one after it.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runPaths, writeAtomic, type RunPaths } from '../src/core/artifacts.ts'
import type { JobRecord } from '../src/core/jobs.ts'
import type { PatchRecord, ReconcileAudit, VerifyResult } from '../src/core/schema.ts'
import {
  loadReconcileAudits, loadUnauthorized, loadVerifyAttempts, nextAttemptNumber, readNewestVerifyLog, unauthorizedClaim,
} from '../src/verify/artifacts.ts'
import { submitGate } from '../src/verify/gate.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()!() })

async function paths(): Promise<RunPaths> {
  const root = await mkdtemp(join(tmpdir(), 'clone-verify-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  return runPaths(root, 'run-1')
}

function result(attempt: number, ok = true): VerifyResult {
  return {
    attempt, ok,
    started_at: `2026-09-20T0${attempt}:00:00.000Z`,
    finished_at: `2026-09-20T0${attempt}:10:00.000Z`,
    steps: [], rolled_back: false, rollback_files: [],
  }
}

function audit(unauthorized: readonly string[], overrides: Partial<ReconcileAudit> = {}): ReconcileAudit {
  return {
    authorized: ['module/laws/src/a.cpp'],
    changed: ['module/laws/src/a.cpp', ...unauthorized],
    unauthorized: [...unauthorized],
    missing: [],
    cluster_ids: ['C001'],
    scan_revision: 'rev-1',
    recorded_at: '2026-09-20T00:00:00.000Z',
    ...overrides,
  }
}

/**
 * The newest VERIFY job record, on its own path from `result.json`. It names the
 * attempt it settled, because a deleted terminal record is invisible to the job
 * reader: without the number, the newest job LEFT ON DISK is an earlier attempt's.
 */
function verifyJob(status: JobRecord['status'], attempt = 1): JobRecord {
  return {
    job_id: 'verify-20260920-010000-aaaa', run_id: 'run-1', kind: 'verify', status, attempt,
    started_at: '2026-09-20T00:00:00.000Z',
    finished_at: status === 'running' ? null : '2026-09-20T00:10:00.000Z',
    error: null, summary: '',
  }
}

const PATCH: PatchRecord = {
  cluster_id: 'C001', priority: 'P0', files_changed: ['module/laws/src/a.cpp'],
  recorded_at: '2026-09-20T00:00:00.000Z', scan_revision: 'rev-1',
}

describe('loadVerifyAttempts', () => {
  it('skips a damaged result.json and names it, instead of failing every reader', async () => {
    // The sibling rule for durable records: `latestJob` skips a corrupt job file and
    // reports its name, because `clone_check` is the only progress interface. A
    // malformed result.json used to reject the read, which made clone_check,
    // clone_report and clone_submit's own refusal fail as a JSON parse error.
    const target = await paths()
    await writeAtomic(join(target.verifyDir, '1', 'result.json'), `${JSON.stringify(result(1))}\n`)
    await writeAtomic(join(target.verifyDir, '2', 'result.json'), '{"attempt":\n')
    await writeAtomic(join(target.verifyDir, '3', 'result.json'), `${JSON.stringify(result(3, false))}\n`)

    const unreadable: string[] = []
    const attempts = await loadVerifyAttempts(target, name => { unreadable.push(name) })
    expect(attempts.map(attempt => attempt.attempt)).toEqual([1, 3])
    expect(unreadable).toEqual(['verify/2/result.json'])
  })

  it('does not let a damaged file hide an older passing attempt', async () => {
    // The other direction: the good record must still be readable, so a run with a
    // damaged newest file reports the attempt it does have rather than nothing.
    const target = await paths()
    await writeAtomic(join(target.verifyDir, '1', 'result.json'), `${JSON.stringify(result(1))}\n`)
    await writeAtomic(join(target.verifyDir, '2', 'result.json'), 'not json at all')
    const attempts = await loadVerifyAttempts(target)
    expect(attempts.map(attempt => attempt.attempt)).toEqual([1])
  })
})

describe('readNewestVerifyLog', () => {
  it('orders step logs by their numeric index, not lexically', async () => {
    // Log names are unpadded `${index}-${name}.log`, so `10-x.log` sorts BEFORE
    // `2-y.log`. With ten or more configured steps the live progress window returned
    // step 9's log while step 10+ was running.
    const target = await paths()
    for (let index = 1; index <= 12; index += 1) {
      await writeAtomic(join(target.verifyDir, '1', `${index}-step.log`), `step ${index}\n`)
    }
    const tail = await readNewestVerifyLog(target, 5)
    // `9-step.log` is what `names.sort().at(-1)` picks.
    expect(tail?.file.replaceAll('\\', '/').endsWith('/1/12-step.log')).toBe(true)
    expect(tail?.lines.join('\n')).toContain('step 12')
  })

  it('reads the newest attempt directory while its result is still unwritten', async () => {
    // The live window must follow the attempt that is RUNNING. Choosing the newest
    // attempt by readable result.json showed attempt 1's log for the whole of
    // attempt 2 — the one case the window exists for.
    const target = await paths()
    await writeAtomic(join(target.verifyDir, '1', 'result.json'), `${JSON.stringify(result(1))}\n`)
    await writeAtomic(join(target.verifyDir, '1', '1-old.log'), 'attempt one\n')
    await writeAtomic(join(target.verifyDir, '2', '1-live.log'), 'attempt two\n')
    const tail = await readNewestVerifyLog(target, 5)
    expect(tail?.file.replaceAll('\\', '/').endsWith('/2/1-live.log')).toBe(true)
    expect(tail?.lines.join('\n')).toContain('attempt two')
  })
})

describe('nextAttemptNumber', () => {
  it('numbers from the highest attempt directory, so a killed attempt is not reused', async () => {
    // An attempt killed before its result.json write makes `length + 1` collide with
    // it: attempt 2 is overwritten, step logs and reconcile.json included — the harm
    // the neighbouring rollback comment works to avoid.
    const target = await paths()
    await writeAtomic(join(target.verifyDir, '1', 'result.json'), `${JSON.stringify(result(1))}\n`)
    await writeAtomic(join(target.verifyDir, '2', '1-build.log'), 'killed mid-build\n')
    expect(await nextAttemptNumber(target)).toBe(3)
  })

  it('starts at 1 when no attempt directory exists yet', async () => {
    expect(await nextAttemptNumber(await paths())).toBe(1)
  })
})

describe('loadUnauthorized', () => {
  it('reports the NEWEST attempt, so a resolved freeze stops reading as a freeze', async () => {
    // Attempt 1 found a file outside the ledger (the run froze, correctly); the
    // operator reverted it and attempt 2 reconciled clean. The union of every attempt
    // made a finished, submitted run read as frozen.
    const target = await paths()
    await writeAtomic(join(target.verifyDir, '1', 'reconcile.json'), `${JSON.stringify(audit(['module/laws/src/sneaky.cpp']))}\n`)
    await writeAtomic(join(target.verifyDir, '2', 'reconcile.json'), `${JSON.stringify(audit([]))}\n`)
    const read = await loadUnauthorized(target)
    expect(read.files).toEqual([])
    // The history is kept: the earlier freeze is still auditable, marked resolved.
    expect(read.resolved).toEqual(['module/laws/src/sneaky.cpp'])
  })

  it('reports nothing as resolved when the newest attempt has no reconcile record', async () => {
    // Attempt 2 ran (its result.json is there) but its `reconcile.json` is gone. The
    // freeze claim used to come from the newest attempt that HAD an audit, so
    // attempt 1's finding was reported as "resolved" — a cleanliness claim about a
    // run whose newest attempt recorded nothing, and which `clone_submit` refuses.
    const target = await paths()
    await writeAtomic(join(target.verifyDir, '1', 'reconcile.json'), `${JSON.stringify(audit(['module/laws/src/sneaky.cpp']))}\n`)
    await writeAtomic(join(target.verifyDir, '2', 'result.json'), `${JSON.stringify(result(2))}\n`)
    const read = await loadUnauthorized(target)
    expect(read.newestAttempt).toBe(2)
    expect(read.reconciledAttempt).toBe(1)
    // Neither a freeze nor a clean bill of health: there is nothing newest to claim.
    expect(read.files).toEqual([])
    expect(read.resolved).toEqual([])
  })

  it('still reports the freeze when the newest attempt is the one that found it', async () => {
    const target = await paths()
    await writeAtomic(join(target.verifyDir, '1', 'reconcile.json'), `${JSON.stringify(audit([]))}\n`)
    await writeAtomic(join(target.verifyDir, '2', 'reconcile.json'), `${JSON.stringify(audit(['module/laws/src/sneaky.cpp']))}\n`)
    const read = await loadUnauthorized(target)
    expect(read.files).toEqual(['module/laws/src/sneaky.cpp'])
    expect(read.resolved).toEqual([])
  })
})

describe('unauthorizedClaim', () => {
  it('claims the freeze from the newest audit and reports the rest as resolved', () => {
    const claim = unauthorizedClaim(new Map([
      [1, audit(['module/laws/src/sneaky.cpp'])],
      [2, audit([])],
    ]))
    expect(claim).toEqual({ files: [], resolved: ['module/laws/src/sneaky.cpp'] })
  })

  it('claims nothing when no attempt recorded an audit', () => {
    expect(unauthorizedClaim(new Map())).toEqual({ files: [], resolved: [] })
  })
})

describe('loadReconcileAudits', () => {
  it('reads one audit per attempt and names a damaged one', async () => {
    const target = await paths()
    await writeAtomic(join(target.verifyDir, '1', 'reconcile.json'), `${JSON.stringify(audit([]))}\n`)
    await writeAtomic(join(target.verifyDir, '2', 'reconcile.json'), '{oops\n')
    const unreadable: string[] = []
    const audits = await loadReconcileAudits(target, name => { unreadable.push(name) })
    expect([...audits.keys()]).toEqual([1])
    expect(audits.get(1)?.cluster_ids).toEqual(['C001'])
    expect(unreadable).toEqual(['verify/2/reconcile.json'])
  })
})

describe('submitGate', () => {
  it('allows the legitimate flow: the newest attempt verified exactly this ledger', () => {
    expect(submitGate({
      attempts: [result(1)], newestAttempt: 1, audit: audit([]), verifyJob: verifyJob('succeeded'),
      patches: [PATCH], revision: 'rev-1', files: ['module/laws/src/a.cpp'], unreadable: [],
    })).toEqual({ allowed: true })
  })

  it('refuses a patch authorized after the verification it would be submitted under', () => {
    // The required acceptance: a later `clone_assess` re-authorization must not ride
    // on an earlier pass, however the file set happens to compare.
    const gate = submitGate({
      attempts: [result(1)], newestAttempt: 1, audit: audit([]), verifyJob: verifyJob('succeeded'),
      patches: [{ ...PATCH, recorded_at: '2026-09-20T00:05:00.000Z' }],
      revision: 'rev-1', files: ['module/laws/src/a.cpp'], unreadable: [],
    })
    expect(gate.allowed).toBe(false)
    expect(refusal(gate)).toMatch(/authorized after the verification/)
    expect(refusal(gate)).toMatch(/C001/)
    expect(refusal(gate)).toMatch(/clone_verify/)
  })

  it('refuses when the ledger no longer matches what the attempt verified', () => {
    const gate = submitGate({
      attempts: [result(1)], newestAttempt: 1, audit: audit([]), verifyJob: verifyJob('succeeded'),
      patches: [PATCH, { ...PATCH, cluster_id: 'C002', files_changed: ['module/laws/src/b.cpp'], recorded_at: '2026-09-19T00:00:00.000Z' }],
      revision: 'rev-1', files: ['module/laws/src/a.cpp', 'module/laws/src/b.cpp'], unreadable: [],
    })
    expect(gate.allowed).toBe(false)
    expect(refusal(gate)).toMatch(/no longer matches/)
    expect(refusal(gate)).toMatch(/b\.cpp/)
  })

  it('refuses when the newest attempt has no readable result', () => {
    // The killed attempt: reconcile.json and step logs exist, the outcome does not.
    const gate = submitGate({
      attempts: [result(1)], newestAttempt: 2, audit: audit([]), verifyJob: verifyJob('failed'),
      patches: [PATCH], revision: 'rev-1', files: ['module/laws/src/a.cpp'], unreadable: ['verify/2/result.json'],
    })
    expect(gate.allowed).toBe(false)
    expect(refusal(gate)).toMatch(/no result record/)
    expect(refusal(gate)).toMatch(/verify\/2\/result\.json/)
  })

  it('refuses when the newest verification job is not succeeded', () => {
    const gate = submitGate({
      attempts: [result(1)], newestAttempt: 1, audit: audit([]), verifyJob: verifyJob('failed'),
      patches: [PATCH], revision: 'rev-1', files: ['module/laws/src/a.cpp'], unreadable: [],
    })
    expect(gate.allowed).toBe(false)
    expect(refusal(gate)).toMatch(/not succeeded/)
    expect(refusal(gate)).toMatch(/verify-20260920-010000-aaaa/)
  })

  it('refuses when no verification job record exists at all', () => {
    const gate = submitGate({
      attempts: [result(1)], newestAttempt: 1, audit: audit([]), verifyJob: undefined,
      patches: [PATCH], revision: 'rev-1', files: ['module/laws/src/a.cpp'], unreadable: [],
    })
    expect(gate.allowed).toBe(false)
    expect(refusal(gate)).toMatch(/No verification job record/)
  })

  it('refuses a verify job that belongs to another attempt', () => {
    // Attempts 1 and 2 both passed; attempt 2's terminal job record was then lost — a
    // failed bookkeeping write, or a deleted file, which the job reader cannot see at all
    // (so not even `unreadable` names it). The newest VERIFY job left on disk is attempt
    // 1's, and its `succeeded` status used to stand in for attempt 2's. Nothing unsafe
    // followed (attempt 2's own result.json must still say ok and every set must match),
    // but the gate's stated invariant — every missing part is a refusal — was violated.
    const gate = submitGate({
      attempts: [result(1), result(2)], newestAttempt: 2, audit: audit([]),
      verifyJob: verifyJob('succeeded', 1),
      patches: [PATCH], revision: 'rev-1', files: ['module/laws/src/a.cpp'], unreadable: [],
    })
    expect(gate.allowed).toBe(false)
    expect(refusal(gate)).toMatch(/attempt 1/)
    expect(refusal(gate)).toMatch(/attempt 2/)
    expect(refusal(gate)).toMatch(/clone_verify/)
    // Not a rule that refuses everything: the same records with the job of the attempt
    // the gate is binding are allowed.
    expect(submitGate({
      attempts: [result(1), result(2)], newestAttempt: 2, audit: audit([]),
      verifyJob: verifyJob('succeeded', 2),
      patches: [PATCH], revision: 'rev-1', files: ['module/laws/src/a.cpp'], unreadable: [],
    })).toEqual({ allowed: true })
  })

  it('refuses a verify job that names no attempt at all', () => {
    // `attempt` is absent on a record written before it existed. A record that cannot
    // show which attempt it settled must not be read as this one's.
    const unnamed: JobRecord = {
      job_id: 'verify-20260920-010000-aaaa', run_id: 'run-1', kind: 'verify', status: 'succeeded',
      started_at: '2026-09-20T00:00:00.000Z', finished_at: '2026-09-20T00:10:00.000Z',
      error: null, summary: 'attempt 1: PASS',
    }
    const gate = submitGate({
      attempts: [result(1)], newestAttempt: 1, audit: audit([]), verifyJob: unnamed,
      patches: [PATCH], revision: 'rev-1', files: ['module/laws/src/a.cpp'], unreadable: [],
    })
    expect(gate.allowed).toBe(false)
    expect(refusal(gate)).toMatch(/does not record which attempt/)
  })

  it('refuses an attempt that carries no record of what it verified', () => {
    // A run from before the record existed must not become silently submittable.
    const gate = submitGate({
      attempts: [result(1)], newestAttempt: 1, audit: undefined, verifyJob: verifyJob('succeeded'),
      patches: [PATCH], revision: 'rev-1', files: ['module/laws/src/a.cpp'], unreadable: [],
    })
    expect(gate.allowed).toBe(false)
    expect(refusal(gate)).toMatch(/no reconcile record/)
  })

  it('refuses a record written without a timestamp or a cluster set', () => {
    // The same conservative direction for a partially written record: nothing can be
    // established about when this authorization was read.
    const partial = audit([], { recorded_at: undefined as unknown as string })
    const gate = submitGate({
      attempts: [result(1)], newestAttempt: 1, audit: partial, verifyJob: verifyJob('succeeded'),
      patches: [PATCH], revision: 'rev-1', files: ['module/laws/src/a.cpp'], unreadable: [],
    })
    expect(gate.allowed).toBe(false)
    expect(refusal(gate)).toMatch(/no reconcile record/)
  })

  it('refuses after a rescan replaced the cluster set the attempt verified', () => {
    const gate = submitGate({
      attempts: [result(1)], newestAttempt: 1, audit: audit([]), verifyJob: verifyJob('succeeded'),
      patches: [{ ...PATCH, scan_revision: 'rev-2' }], revision: 'rev-2',
      files: ['module/laws/src/a.cpp'], unreadable: [],
    })
    expect(gate.allowed).toBe(false)
    expect(refusal(gate)).toMatch(/rev-1/)
    expect(refusal(gate)).toMatch(/rev-2/)
  })

  it('refuses an attempt whose own reconcile still lists unauthorized changes', () => {
    // This case pins a PURE-FUNCTION invariant, not a tool-reachable state: no tool flow
    // yields a passing `result.json` beside an audit naming unauthorized files, because a
    // frozen `clone_verify` throws before it ever writes a result. It stays because
    // `submitGate`'s input domain has to include that ordering — an audit with
    // unauthorized files beats a passing result — and that ordering is load-bearing now
    // that the freeze check runs first. It is NOT coverage of the reachable freeze
    // (`workflow.spec.ts` drives that one through the tools).
    const gate = submitGate({
      attempts: [result(1)], newestAttempt: 1, audit: audit(['module/laws/src/sneaky.cpp']), verifyJob: verifyJob('succeeded'),
      patches: [PATCH], revision: 'rev-1', files: ['module/laws/src/a.cpp'], unreadable: [],
    })
    expect(gate.allowed).toBe(false)
    expect(refusal(gate)).toMatch(/frozen/)
    expect(refusal(gate)).toMatch(/sneaky\.cpp/)
  })

  it('refuses when the newest recorded attempt did not pass', () => {
    const gate = submitGate({
      attempts: [result(1), result(2, false)], newestAttempt: 2, audit: audit([]), verifyJob: verifyJob('failed'),
      patches: [PATCH], revision: 'rev-1', files: ['module/laws/src/a.cpp'], unreadable: [],
    })
    expect(gate.allowed).toBe(false)
    expect(refusal(gate)).toMatch(/did not pass/)
  })

  it('refuses when no attempt was ever recorded', () => {
    const gate = submitGate({
      attempts: [], newestAttempt: undefined, audit: undefined, verifyJob: undefined,
      patches: [PATCH], revision: 'rev-1', files: ['module/laws/src/a.cpp'], unreadable: [],
    })
    expect(gate.allowed).toBe(false)
    expect(refusal(gate)).toMatch(/No passing clone_verify/)
  })
})

/** The refusal text of a gate verdict, so each test names the reason it expects. */
function refusal(gate: ReturnType<typeof submitGate>): string {
  if (gate.allowed) throw new Error('the gate allowed a submission that a test expected it to refuse')
  return gate.reason
}
