/**
 * The tool layer, driven through `ctx.tools.execute` — the exact calls a model
 * makes, against a real Cordis Tools/SystemPrompt tree and real run directories.
 *
 * This file covers the gates that are easiest to get wrong: clone_scan's
 * background contract, clone_assess's authorization rules, clone_verify's
 * reconcile and empty-step refusals, clone_submit's consent, and clone_report's
 * coverage contract. Task 14 appends the whole-chain cases to this same file.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { resolveSettings } from '../src/config.ts'
import type { CommandRunner } from '../src/core/command.ts'
import { fakeRunner, type FakeScriptEntry } from './fixtures/fake-runner.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()!() })

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'clone-workflow-'))
  cleanups.push(() => removeWorkspace(dir))
  return dir
}

/**
 * A cleanup that survives a job finishing late. `settle` waits for the record to
 * leave `running`, but `finishJob` writes that record and the outcome in one
 * path, so a removal can still race the last write on Windows and fail with
 * ENOTEMPTY. Retrying is what makes teardown deterministic.
 */
async function removeWorkspace(dir: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true })
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (attempt >= 20 || (code !== 'ENOTEMPTY' && code !== 'EPERM' && code !== 'EBUSY')) throw error
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }
}

const CSV_HEADER = 'pair_id,file1,func1_name,lines1,file2,func2_name,lines2,similarity,detection_method\n'
const GIT_OK: Array<[string, { stdout?: string }]> = [
  ['git rev-parse HEAD', { stdout: 'abc123\n' }],
  ['git rev-parse --abbrev-ref HEAD', { stdout: 'main\n' }],
  ['git status --porcelain', { stdout: '' }],
  ['git diff --name-only', { stdout: 'module/laws/src/a.cpp\n' }],
  // Reached only when authorization.enabled: `openRun` switches the run onto its
  // own branch before anything may patch source.
  ['git checkout -B', { stdout: '' }],
]

/** Mount the real plugin into a real Tools/SystemPrompt context. */
async function mount(config: Record<string, unknown>, runner: CommandRunner) {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  const { settings } = resolveSettings(config)
  const { registerTools } = await import('../src/tools.ts')
  registerTools(ctx, settings, runner, String(config.artifactsRoot))
  return ctx
}

function call(ctx: Context, name: string, args: unknown) {
  return ctx.tools.execute({ name, arguments: args, signal: new AbortController().signal, callId: ToolCallId(`clone-${name}`) })
}

/**
 * The rendered text of one call's outcome. `execute` returns an envelope whose
 * `content` is the tool's own JSON payload, so asserting on the payload means
 * reading the content block, not the envelope — an envelope-only assertion
 * passes even when the tool returned nothing.
 */
function rendered(result: unknown): string {
  const blocks = (result as { content?: unknown }).content
  if (!Array.isArray(blocks)) throw new Error('the tool returned no content block')
  return blocks.map((block: { text?: string }) => block.text ?? '').join('')
}

/**
 * Background jobs are detached, so a test must poll the record the way the model
 * does. A fixed sleep makes the suite flaky on a cold machine; polling makes it
 * wait exactly as long as the job needs.
 */
async function settle(ctx: Context, runId: string, attempts = 200): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const text = JSON.stringify(await call(ctx, 'clone_check', { run_id: runId, what: 'status' }))
    if (!text.includes('"status":"running"')) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`run ${runId} never settled`)
}

/** The attempt numbers a run has recorded, read through the public artifact reader. */
async function loadVerifyAttemptsOf(root: string): Promise<number[]> {
  const { loadVerifyAttempts } = await import('../src/verify/artifacts.ts')
  const { runPaths } = await import('../src/core/artifacts.ts')
  return (await loadVerifyAttempts(runPaths(join(root, 'runs'), 'r1'))).map(attempt => attempt.attempt)
}

/** The authorization ledger as the tools read it. */
async function loadPatchesOf(root: string): Promise<Array<{ cluster_id: string }>> {
  const { loadPatches } = await import('../src/core/ledger.ts')
  const { runPaths } = await import('../src/core/artifacts.ts')
  return await loadPatches(runPaths(join(root, 'runs'), 'r1'))
}

/** Every `git <verb>` this runner was asked to run, for "nothing outward" checks. */
function gitVerbsOf(runner: ReturnType<typeof fakeRunner>): string[] {
  return runner.calls.filter(call => call.argv[0] === 'git').map(call => call.argv[1] ?? '')
}

/**
 * One entry per `git status --porcelain` read, resting on the dirty answer: the
 * run's baseline read is clean, and every later read — the reconcile's — sees the
 * patch. `readBaseline` insists on a trustworthy status, so the sequence is what
 * makes a run start against a tree that is about to look modified.
 */
const CLEAN_THEN_PATCHED: FakeScriptEntry = ['git status --porcelain', [
  { stdout: '' },
  { stdout: ' M module/laws/src/a.cpp\n' },
]]

/** The tracked file the rollback would restore, plus the two rollback verbs. */
const ROLLBACK_CALLS: FakeScriptEntry[] = [
  ['git restore', { exitCode: 0 }],
  ['git ls-files', { stdout: 'module/laws/src/a.cpp\u0000' }],
  ['git clean', { exitCode: 0 }],
]

describe('clone_assess authorization rules', () => {
  it('refuses a patched verdict while patching is disabled', async () => {
    const root = await workspace()
    const csv = join(root, 'func_clone_base.csv')
    await writeFile(csv, `${CSV_HEADER}p1,a.cpp,f,1-2,b.cpp,g,3-4,0.9,type12\n`)
    const ctx = await mount({ projectRoot: 'D:/repo', artifactsRoot: join(root, 'runs'), detection: { provider: 'csv', csvPath: csv } }, fakeRunner(GIT_OK))
    const scan = await call(ctx, 'clone_scan', { run_id: 'r1', module: 'base' })
    expect((scan as { isError?: boolean }).isError).not.toBe(true)
    // The scan is a background job: poll until it settles before assessing.
    await settle(ctx, 'r1')
    const assess = await call(ctx, 'clone_assess', { run_id: 'r1', cluster_id: 'C001', verdict: 'patched', priority: 'P0', reason: 'x', files_changed: ['a.cpp'], confirm: true })
    expect((assess as { isError?: boolean }).isError).toBe(true)
    expect(rendered(assess)).toMatch(/authorization\.enabled/)
  })

  it('refuses a patched verdict without confirm: true', async () => {
    const root = await workspace()
    const csv = join(root, 'func_clone_base.csv')
    await writeFile(csv, `${CSV_HEADER}p1,a.cpp,f,1-2,b.cpp,g,3-4,0.9,type12\n`)
    const ctx = await mount({
      projectRoot: 'D:/repo',
      artifactsRoot: join(root, 'runs'),
      detection: { provider: 'csv', csvPath: csv },
      authorization: { enabled: true },
    }, fakeRunner([['git checkout -B', { stdout: '' }], ...GIT_OK]))
    await call(ctx, 'clone_scan', { run_id: 'r1', module: 'base' })
    await settle(ctx, 'r1')
    // Authorization is on, so consent is the only thing left to refuse it.
    const assessed = await call(ctx, 'clone_assess', {
      run_id: 'r1', cluster_id: 'C001', verdict: 'patched', priority: 'P0',
      reason: 'bodies are identical', files_changed: ['module/laws/src/a.cpp'],
      evidence: { file: 'module/laws/src/a.cpp', line: 12, snippet: 'static int area(const Rect& r)' },
    })
    expect((assessed as { isError?: boolean }).isError).toBe(true)
    expect(rendered(assessed)).toMatch(/confirm: true/)
    // Nothing half-written: the refusal happens before the ledger is touched.
    await expect(readFile(join(root, 'runs', 'r1', 'patches.json'), 'utf8')).rejects.toThrow()
  })

  it('caps patching at maxPriority severity, refusing the less severe side', async () => {
    // The cap is a SEVERITY cap: maxPriority 'P0' means "only P0". The previous
    // inverted comparison refused nothing at all under this default — including
    // PX, which design §8 says must never be refactored — so this test fails
    // unless the comparison is the right way round.
    const root = await workspace()
    const csv = join(root, 'func_clone_base.csv')
    await writeFile(csv, `${CSV_HEADER}p1,module/laws/src/a.cpp,ComputeArea,10-20,module/laws/src/b.cpp,CalcArea,30-40,0.95,type12\n`)
    const ctx = await mount({
      projectRoot: 'D:/repo',
      artifactsRoot: join(root, 'runs'),
      detection: { provider: 'csv', csvPath: csv },
      authorization: { enabled: true, maxPriority: 'P0' },
    }, fakeRunner([['git checkout -B', { stdout: '' }], ...GIT_OK]))
    await call(ctx, 'clone_scan', { run_id: 'r1', module: 'base' })
    await settle(ctx, 'r1')

    const patched = (priority: string) => call(ctx, 'clone_assess', {
      run_id: 'r1', cluster_id: 'C001', verdict: 'patched', priority,
      reason: 'bodies are identical', files_changed: ['module/laws/src/a.cpp'],
      evidence: { file: 'module/laws/src/a.cpp', line: 12, snippet: 'static int area(const Rect& r)' },
      confirm: true,
    })

    const p1 = await patched('P1')
    expect((p1 as { isError?: boolean }).isError).toBe(true)
    expect(rendered(p1)).toMatch(/maxPriority is P0/)
    // P0 is exactly what the cap allows, so the same call at P0 must succeed.
    const p0 = await patched('P0')
    expect((p0 as { isError?: boolean }).isError, rendered(p0)).not.toBe(true)
  })

  it('widens the authorization ledger when a patched verdict is replaced', async () => {
    // Upsert, not insert-if-absent: clone_verify authorizes from patches.json
    // alone, so a stale record would freeze this run with UNAUTHORIZED_CHANGES
    // that no further clone_assess could clear.
    const root = await workspace()
    const csv = join(root, 'func_clone_base.csv')
    await writeFile(csv, `${CSV_HEADER}p1,module/laws/src/a.cpp,ComputeArea,10-20,module/laws/src/b.cpp,CalcArea,30-40,0.95,type12\n`)
    const ctx = await mount({
      projectRoot: 'D:/repo',
      artifactsRoot: join(root, 'runs'),
      detection: { provider: 'csv', csvPath: csv },
      authorization: { enabled: true },
      verify: { steps: [{ name: 'build', phase: 'build', command: 'msbuild tests.sln' }] },
    }, fakeRunner([
      ['git checkout -B', { stdout: '' }],
      // The tree is clean at the baseline read and shows both authorized files to
      // the reconcile, which is the state a widened patch really produces.
      ['git status --porcelain', [
        { stdout: '' },
        { stdout: ' M module/laws/src/a.cpp\n M module/laws/src/b.cpp\n' },
      ]],
      ['git diff --name-only abc123', [
        { stdout: '' },
        { stdout: 'module/laws/src/a.cpp\nmodule/laws/src/b.cpp\n' },
      ]],
      ...GIT_OK,
    ]))
    await call(ctx, 'clone_scan', { run_id: 'r1', module: 'base' })
    await settle(ctx, 'r1')
    const first = await call(ctx, 'clone_assess', {
      run_id: 'r1', cluster_id: 'C001', verdict: 'patched', priority: 'P0',
      reason: 'extracted a helper', files_changed: ['module/laws/src/a.cpp'],
      evidence: { file: 'module/laws/src/a.cpp', line: 12, snippet: 'static int area(const Rect& r)' },
      confirm: true,
    })
    expect((first as { isError?: boolean }).isError, rendered(first)).not.toBe(true)

    const widened = await call(ctx, 'clone_assess', {
      run_id: 'r1', cluster_id: 'C001', verdict: 'patched', priority: 'P0',
      reason: 'the helper also touches b.cpp', files_changed: ['module/laws/src/a.cpp', 'module/laws/src/b.cpp'],
      evidence: { file: 'module/laws/src/b.cpp', line: 33, snippet: 'return area(r);' },
      replace: true, confirm: true,
    })
    expect((widened as { isError?: boolean }).isError, rendered(widened)).not.toBe(true)

    const patches = JSON.parse(await readFile(join(root, 'runs', 'r1', 'patches.json'), 'utf8')) as Array<{
      cluster_id: string; files_changed: string[]
    }>
    expect(patches).toHaveLength(1)
    expect(patches[0]?.files_changed).toEqual(['module/laws/src/a.cpp', 'module/laws/src/b.cpp'])

    // The point of the fix: the widened set is what authorizes, so verifying the
    // corrected patch must not freeze the run.
    const verified = await call(ctx, 'clone_verify', { run_id: 'r1' })
    expect((verified as { isError?: boolean }).isError, rendered(verified)).not.toBe(true)
  })

  it('retracts the authorization when a patched cluster is re-assessed as report_only', async () => {
    // R49: the ledger must follow the latest verdict, not stay behind it. A
    // leftover PatchRecord is a stale authorization — clone_verify would still
    // authorize the files and clone_submit would still commit them, while the
    // cluster's own verdict says it must not be patched.
    const root = await workspace()
    const csv = join(root, 'func_clone_base.csv')
    await writeFile(csv, `${CSV_HEADER}p1,module/laws/src/a.cpp,ComputeArea,10-20,module/laws/src/b.cpp,CalcArea,30-40,0.95,type12\n`)
    const runner = fakeRunner([
      ['git checkout -B', { stdout: '' }],
      // The sequence rests on the patched answer, so one entry covers the baseline
      // read, the verify reconcile and anything that asks afterwards.
      CLEAN_THEN_PATCHED,
      ...GIT_OK,
    ])
    const ctx = await mount({
      projectRoot: 'D:/repo',
      artifactsRoot: join(root, 'runs'),
      detection: { provider: 'csv', csvPath: csv },
      authorization: { enabled: true },
      verify: { steps: [{ name: 'build', phase: 'build', command: 'msbuild tests.sln' }] },
    }, runner)
    await call(ctx, 'clone_scan', { run_id: 'r1', module: 'base' })
    await settle(ctx, 'r1')

    const patched = await call(ctx, 'clone_assess', {
      run_id: 'r1', cluster_id: 'C001', verdict: 'patched', priority: 'P0',
      reason: 'bodies are identical', files_changed: ['module/laws/src/a.cpp'],
      evidence: { file: 'module/laws/src/a.cpp', line: 12, snippet: 'static int area(const Rect& r)' },
      confirm: true,
    })
    expect((patched as { isError?: boolean }).isError, rendered(patched)).not.toBe(true)
    expect(await loadPatchesOf(root)).toHaveLength(1)

    const reconsidered = await call(ctx, 'clone_assess', {
      run_id: 'r1', cluster_id: 'C001', verdict: 'report_only', priority: 'P0',
      reason: 'on reflection the callee is virtual, so this must not be refactored',
      evidence: { file: 'module/laws/src/a.cpp', line: 12, snippet: 'virtual void draw();' },
      replace: true,
    })
    expect((reconsidered as { isError?: boolean }).isError, rendered(reconsidered)).not.toBe(true)

    // The retraction itself, read back through the public ledger reader.
    expect(await loadPatchesOf(root)).toEqual([])

    // And the consequence the retraction exists for: with nothing authorized, the
    // still-modified file IS an unauthorized change, so verify freezes the run.
    // That is the correct direction — a modified tree with no recorded consent is
    // exactly what must not proceed — and it is a second, independent barrier
    // against acting on the retracted consent.
    const verified = await call(ctx, 'clone_verify', { run_id: 'r1' })
    expect((verified as { isError?: boolean }).isError).toBe(true)
    expect(rendered(verified)).toMatch(/UNAUTHORIZED_CHANGES/)
    expect(rendered(verified)).toMatch(/module\/laws\/src\/a\.cpp/)
  })

  it('requires evidence for a P0 report_only verdict', async () => {
    const root = await workspace()
    const csv = join(root, 'func_clone_base.csv')
    await writeFile(csv, `${CSV_HEADER}p1,a.cpp,f,1-2,b.cpp,g,3-4,0.9,type12\n`)
    const ctx = await mount({ projectRoot: 'D:/repo', artifactsRoot: join(root, 'runs'), detection: { provider: 'csv', csvPath: csv } }, fakeRunner(GIT_OK))
    await call(ctx, 'clone_scan', { run_id: 'r1', module: 'base' })
    await settle(ctx, 'r1')
    const assessed = await call(ctx, 'clone_assess', { run_id: 'r1', cluster_id: 'C001', verdict: 'report_only', priority: 'P0', reason: 'a virtual call diverges' })
    expect((assessed as { isError?: boolean }).isError).toBe(true)
    expect(rendered(assessed)).toMatch(/evidence/)
  })

  it('rejects an unknown cluster id and lists what it does know', async () => {
    const root = await workspace()
    const csv = join(root, 'func_clone_base.csv')
    await writeFile(csv, `${CSV_HEADER}p1,a.cpp,f,1-2,b.cpp,g,3-4,0.9,type12\n`)
    const ctx = await mount({ projectRoot: 'D:/repo', artifactsRoot: join(root, 'runs'), detection: { provider: 'csv', csvPath: csv } }, fakeRunner(GIT_OK))
    await call(ctx, 'clone_scan', { run_id: 'r1', module: 'base' })
    await settle(ctx, 'r1')
    const assessed = await call(ctx, 'clone_assess', { run_id: 'r1', cluster_id: 'C999', verdict: 'skipped', priority: 'PX', reason: 'nope' })
    expect((assessed as { isError?: boolean }).isError).toBe(true)
    expect(rendered(assessed)).toMatch(/C001/)
  })
})

describe('clone_check', () => {
  it('reads the clusters and the ledger back without losing a field', async () => {
    const root = await workspace()
    const csv = join(root, 'func_clone_base.csv')
    await writeFile(csv, `${CSV_HEADER}p1,a.cpp,f,1-2,b.cpp,g,3-4,0.9,type12\n`)
    const ctx = await mount({ projectRoot: 'D:/repo', artifactsRoot: join(root, 'runs'), detection: { provider: 'csv', csvPath: csv } }, fakeRunner(GIT_OK))
    await call(ctx, 'clone_scan', { run_id: 'r1', module: 'base' })
    await settle(ctx, 'r1')
    await call(ctx, 'clone_assess', { run_id: 'r1', cluster_id: 'C001', verdict: 'skipped', priority: 'PX', reason: 'not worth it' })

    // The open output schema makes an index signature demand a plain-JSON
    // projection, so the tool passes every value through one. A projection that
    // dropped or coerced a field would read as "the ledger lost the verdict".
    const page = JSON.parse(rendered(await call(ctx, 'clone_check', { run_id: 'r1', what: 'clusters' }))) as { clusters: Array<Record<string, unknown>> }
    expect(page.clusters.map(cluster => cluster.id)).toEqual(['C001'])
    expect(page.clusters[0]?.representative).toEqual({
      pair_id: 'p1', similarity: 0.9, detection_method: 'type12',
      left: { file: 'a.cpp', function: 'f', lines: '1-2', body: '' },
      right: { file: 'b.cpp', function: 'g', lines: '3-4', body: '' },
    })

    const ledger = JSON.parse(rendered(await call(ctx, 'clone_check', { run_id: 'r1', what: 'ledger' }))) as {
      assessments: Array<Record<string, unknown>>; dropped_lines: number[]
    }
    expect(ledger.assessments).toHaveLength(1)
    expect(ledger.assessments[0]?.reason).toBe('not worth it')
    expect(ledger.dropped_lines).toEqual([])
  })

  it('fails on a run that does not exist instead of creating one', async () => {
    const root = await workspace()
    const ctx = await mount({ projectRoot: 'D:/repo', artifactsRoot: join(root, 'runs') }, fakeRunner(GIT_OK))
    const missing = await call(ctx, 'clone_check', { run_id: 'nope', what: 'status' })
    expect((missing as { isError?: boolean }).isError).toBe(true)
    expect(rendered(missing)).toMatch(/Call clone_scan first/)
  })

  it('returns no log rather than failing when no attempt has run yet', async () => {
    const root = await workspace()
    const csv = join(root, 'func_clone_base.csv')
    await writeFile(csv, `${CSV_HEADER}p1,a.cpp,f,1-2,b.cpp,g,3-4,0.9,type12\n`)
    const ctx = await mount({ projectRoot: 'D:/repo', artifactsRoot: join(root, 'runs'), detection: { provider: 'csv', csvPath: csv } }, fakeRunner(GIT_OK))
    await call(ctx, 'clone_scan', { run_id: 'r1', module: 'base' })
    await settle(ctx, 'r1')
    const logged = JSON.parse(rendered(await call(ctx, 'clone_check', { run_id: 'r1', what: 'log' }))) as { log: unknown }
    // Explicitly null: an absent key would read as "the field was lost".
    expect(logged.log).toBeNull()
  })
})

describe('clone_submit', () => {
  it('refuses to act without confirm: true', async () => {
    const root = await workspace()
    const ctx = await mount({ projectRoot: 'D:/repo', artifactsRoot: join(root, 'runs') }, fakeRunner(GIT_OK))
    const submitted = await call(ctx, 'clone_submit', { run_id: 'r1' })
    expect((submitted as { isError?: boolean }).isError).toBe(true)
    expect(rendered(submitted)).toMatch(/confirm/)
  })

  it('has nothing to submit when the authorization ledger is empty', async () => {
    // The point of R49: an empty ledger is what makes a retracted authorization
    // impossible to act on. The passing attempt is seeded directly so a ledger
    // check is the only thing that can refuse this call.
    const root = await workspace()
    const runner = fakeRunner(GIT_OK)
    const ctx = await mount({ projectRoot: 'D:/repo', artifactsRoot: join(root, 'runs') }, runner)
    await call(ctx, 'clone_scan', { run_id: 'r1', module: 'base' })
    await settle(ctx, 'r1')
    const { runPaths, writeAtomic } = await import('../src/core/artifacts.ts')
    const paths = runPaths(join(root, 'runs'), 'r1')
    await writeAtomic(join(paths.verifyDir, '1', 'result.json'), `${JSON.stringify({
      attempt: 1, ok: true, started_at: '2026-09-20T00:00:00.000Z', finished_at: '2026-09-20T00:00:01.000Z',
      steps: [], rolled_back: false, rollback_files: [],
    }, null, 2)}\n`)

    const submitted = await call(ctx, 'clone_submit', { run_id: 'r1', confirm: true, mode: 'commit' })
    expect((submitted as { isError?: boolean }).isError).toBe(true)
    expect(rendered(submitted)).toMatch(/authorization ledger is empty/)
    // Nothing outward: no `git commit` was ever attempted.
    expect(gitVerbsOf(runner)).not.toContain('commit')
  })
})

describe('clone_verify', () => {
  it('refuses an empty step list instead of reporting a vacuous pass', async () => {
    const root = await workspace()
    const ctx = await mount({ projectRoot: 'D:/repo', artifactsRoot: join(root, 'runs') }, fakeRunner(GIT_OK))
    const verified = await call(ctx, 'clone_verify', { run_id: 'r1' })
    expect((verified as { isError?: boolean }).isError).toBe(true)
    // The engine reports ok: true for zero steps, and clone_submit reads that as a
    // passing verification, so nothing may reach the job at all.
    expect(rendered(verified)).toMatch(/verify\.steps is empty/)
    // Nothing was attempted: no attempt directory, hence nothing to submit.
    await expect(readFile(join(root, 'runs', 'r1', 'verify', '1', 'reconcile.json'), 'utf8')).rejects.toThrow()
  })

  it('freezes the run when a changed file is not in the authorization ledger', async () => {
    const root = await workspace()
    const csv = join(root, 'func_clone_base.csv')
    await writeFile(csv, `${CSV_HEADER}p1,module/laws/src/a.cpp,ComputeArea,10-20,module/laws/src/b.cpp,CalcArea,30-40,0.95,type12\n`)
    const ctx = await mount({
      projectRoot: 'D:/repo',
      artifactsRoot: join(root, 'runs'),
      detection: { provider: 'csv', csvPath: csv },
      authorization: { enabled: true },
      verify: { steps: [{ name: 'build', phase: 'build', command: 'msbuild tests.sln' }] },
    }, fakeRunner([
      // Order matters: `fakeRunner` is FIRST-match-wins, not longest-prefix-wins,
      // so these narrow entries must precede GIT_OK's broad ones. Each array is a
      // sequence consumed one entry per call: `openRun` must read a clean tree or
      // it refuses to start, while clone_verify must read the patch.
      ['git status --porcelain', [
        { stdout: '' },
        { stdout: ' M module/laws/src/a.cpp\n M module/laws/src/sneaky.cpp\n' },
      ]],
      ['git diff --name-only abc123', [
        { stdout: '' },
        { stdout: 'module/laws/src/a.cpp\nmodule/laws/src/sneaky.cpp\n' },
      ]],
      ...GIT_OK,
    ]))
    await call(ctx, 'clone_scan', { run_id: 'r1', module: 'base' })
    await settle(ctx, 'r1')
    const assessed = await call(ctx, 'clone_assess', {
      run_id: 'r1', cluster_id: 'C001', verdict: 'patched', priority: 'P0',
      reason: 'body identical, extracted a helper', files_changed: ['module/laws/src/a.cpp'],
      evidence: { file: 'module/laws/src/a.cpp', line: 12, snippet: 'static int area(const Rect& r)' },
      confirm: true,
    })
    expect((assessed as { isError?: boolean }).isError, rendered(assessed)).not.toBe(true)

    const verified = await call(ctx, 'clone_verify', { run_id: 'r1' })
    expect((verified as { isError?: boolean }).isError).toBe(true)
    expect(rendered(verified)).toMatch(/UNAUTHORIZED_CHANGES/)
    expect(rendered(verified)).toMatch(/sneaky\.cpp/)
    // The audit is written before the freeze, so the report can name the file.
    const audit = JSON.parse(await readFile(join(root, 'runs', 'r1', 'verify', '1', 'reconcile.json'), 'utf8')) as {
      authorized: string[]; unauthorized: string[]
    }
    expect(audit.authorized).toEqual(['module/laws/src/a.cpp'])
    expect(audit.unauthorized).toEqual(['module/laws/src/sneaky.cpp'])
    // A frozen run must not have started a verification job.
    const status = JSON.parse(rendered(await call(ctx, 'clone_check', { run_id: 'r1', what: 'status' }))) as { job: { kind: string } | null }
    expect(status.job?.kind).toBe('scan')
  })
})

describe('clone_verify auto-rollback', () => {
  const STEPS = { steps: [{ name: 'build', phase: 'build', command: 'msbuild tests.sln' }] }

  it('rolls a failed patch back when the baseline was clean', async () => {
    const root = await workspace()
    const csv = join(root, 'func_clone_base.csv')
    await writeFile(csv, `${CSV_HEADER}p1,module/laws/src/a.cpp,ComputeArea,10-20,module/laws/src/b.cpp,CalcArea,30-40,0.95,type12\n`)
    const runner = fakeRunner([
      // Order matters: `fakeRunner` takes the FIRST entry whose prefix matches.
      // `msbuild` is deliberately unscripted, so the required build step fails.
      ['git checkout -B', { stdout: '' }],
      ...ROLLBACK_CALLS,
      CLEAN_THEN_PATCHED,
      ...GIT_OK,
    ])
    const ctx = await mount({
      projectRoot: 'D:/repo',
      artifactsRoot: join(root, 'runs'),
      detection: { provider: 'csv', csvPath: csv },
      authorization: { enabled: true },
      verify: STEPS,
    }, runner)
    await call(ctx, 'clone_scan', { run_id: 'r1', module: 'base' })
    await settle(ctx, 'r1')
    const assessed = await call(ctx, 'clone_assess', {
      run_id: 'r1', cluster_id: 'C001', verdict: 'patched', priority: 'P0',
      reason: 'bodies are identical', files_changed: ['module/laws/src/a.cpp'],
      evidence: { file: 'module/laws/src/a.cpp', line: 12, snippet: 'static int area(const Rect& r)' },
      confirm: true,
    })
    expect((assessed as { isError?: boolean }).isError, rendered(assessed)).not.toBe(true)
    await call(ctx, 'clone_verify', { run_id: 'r1' })
    await settle(ctx, 'r1')

    const result = JSON.parse(await readFile(join(root, 'runs', 'r1', 'verify', '1', 'result.json'), 'utf8')) as {
      ok: boolean; rolled_back: boolean; rollback_files: string[]
    }
    expect(result.ok).toBe(false)
    expect(result.rolled_back).toBe(true)
    expect(result.rollback_files).toEqual(['module/laws/src/a.cpp'])
    // Pins that the flag is not merely recorded: the restoring command really ran.
    expect(runner.calls.some(call => call.argv[1] === 'restore')).toBe(true)
  })

  it('persists the result even when the rollback itself fails', async () => {
    // `checkoutFiles` throws when git refuses. Writing result.json after the
    // rollback would leave this attempt with step logs but no result: the report
    // would claim no verification ran, and the next attempt would reuse the number
    // and overwrite those logs. The evidence must outlive the rollback's failure.
    const root = await workspace()
    const csv = join(root, 'func_clone_base.csv')
    await writeFile(csv, `${CSV_HEADER}p1,module/laws/src/a.cpp,ComputeArea,10-20,module/laws/src/b.cpp,CalcArea,30-40,0.95,type12\n`)
    const runner = fakeRunner([
      ['git checkout -B', { stdout: '' }],
      // The tracked file is known to git, but restoring it fails.
      ['git ls-files', { stdout: 'module/laws/src/a.cpp\u0000' }],
      ['git restore', { exitCode: 1, stderr: 'error: pathspec did not match' }],
      CLEAN_THEN_PATCHED,
      ...GIT_OK,
    ])
    const ctx = await mount({
      projectRoot: 'D:/repo',
      artifactsRoot: join(root, 'runs'),
      detection: { provider: 'csv', csvPath: csv },
      authorization: { enabled: true },
      verify: STEPS,
    }, runner)
    await call(ctx, 'clone_scan', { run_id: 'r1', module: 'base' })
    await settle(ctx, 'r1')
    await call(ctx, 'clone_assess', {
      run_id: 'r1', cluster_id: 'C001', verdict: 'patched', priority: 'P0',
      reason: 'bodies are identical', files_changed: ['module/laws/src/a.cpp'],
      evidence: { file: 'module/laws/src/a.cpp', line: 12, snippet: 'static int area(const Rect& r)' },
      confirm: true,
    })
    await call(ctx, 'clone_verify', { run_id: 'r1' })
    await settle(ctx, 'r1')

    const result = JSON.parse(await readFile(join(root, 'runs', 'r1', 'verify', '1', 'result.json'), 'utf8')) as {
      ok: boolean; rolled_back: boolean; steps: Array<{ name: string; log_file: string }>
    }
    expect(result.ok).toBe(false)
    // The rollback threw, so it never got to claim success.
    expect(result.rolled_back).toBe(false)
    expect(result.steps.map(step => step.name)).toEqual(['build'])
    // The step log the result points at survived, and the job records the failure.
    await expect(readFile(result.steps[0]!.log_file, 'utf8')).resolves.toContain('msbuild tests.sln')
    const status = JSON.parse(rendered(await call(ctx, 'clone_check', { run_id: 'r1', what: 'status' }))) as {
      job: { kind: string; status: string; error: string | null }
    }
    expect(status.job?.kind).toBe('verify')
    expect(status.job?.status).toBe('failed')
    expect(status.job?.error).toMatch(/Cannot roll back/)
    // And the next attempt must not be numbered 1 again.
    await expect(loadVerifyAttemptsOf(root)).resolves.toEqual([1])
  })

  it('leaves a failed patch alone when the baseline was already dirty', async () => {
    const root = await workspace()
    const csv = join(root, 'func_clone_base.csv')
    await writeFile(csv, `${CSV_HEADER}p1,module/laws/src/a.cpp,ComputeArea,10-20,module/laws/src/b.cpp,CalcArea,30-40,0.95,type12\n`)
    const runner = fakeRunner([
      ['git checkout -B', { stdout: '' }],
      ...ROLLBACK_CALLS,
      // The tree is already dirty before the run starts, and stays that way.
      ['git status --porcelain', { stdout: ' M module/laws/src/a.cpp\n' }],
      ...GIT_OK,
    ])
    // allowDirty is what admits an operator with work in progress; the baseline
    // then records that state, which is what suppresses the rollback.
    const ctx = await mount({
      projectRoot: 'D:/repo',
      artifactsRoot: join(root, 'runs'),
      detection: { provider: 'csv', csvPath: csv },
      authorization: { enabled: true },
      workdir: { allowDirty: true },
      verify: STEPS,
    }, runner)
    await call(ctx, 'clone_scan', { run_id: 'r1', module: 'base' })
    await settle(ctx, 'r1')
    const assessed = await call(ctx, 'clone_assess', {
      run_id: 'r1', cluster_id: 'C001', verdict: 'patched', priority: 'P0',
      reason: 'bodies are identical', files_changed: ['module/laws/src/a.cpp'],
      evidence: { file: 'module/laws/src/a.cpp', line: 12, snippet: 'static int area(const Rect& r)' },
      confirm: true,
    })
    expect((assessed as { isError?: boolean }).isError, rendered(assessed)).not.toBe(true)
    await call(ctx, 'clone_verify', { run_id: 'r1' })
    await settle(ctx, 'r1')

    const result = JSON.parse(await readFile(join(root, 'runs', 'r1', 'verify', '1', 'result.json'), 'utf8')) as {
      ok: boolean; rolled_back: boolean; rollback_files: string[]
    }
    expect(result.ok).toBe(false)
    expect(result.rolled_back).toBe(false)
    expect(result.rollback_files).toEqual([])
    // The destructive commands must not have run at all: `git restore` would
    // discard the operator's uncommitted edits and `git clean` their own files.
    expect(runner.calls.filter(call => call.argv[1] === 'restore' || call.argv[1] === 'clean')).toEqual([])
    const run = JSON.parse(await readFile(join(root, 'runs', 'r1', 'run.json'), 'utf8')) as { baseline: { dirty: string[] } }
    expect(run.baseline.dirty).toEqual(['module/laws/src/a.cpp'])
  })
})

describe('clone_report', () => {
  it('refuses to close a run with an unassessed cluster', async () => {
    const root = await workspace()
    const csv = join(root, 'func_clone_base.csv')
    await writeFile(csv, `${CSV_HEADER}p1,a.cpp,f,1-2,b.cpp,g,3-4,0.9,type12\n`)
    const ctx = await mount({ projectRoot: 'D:/repo', artifactsRoot: join(root, 'runs'), detection: { provider: 'csv', csvPath: csv } }, fakeRunner(GIT_OK))
    await call(ctx, 'clone_scan', { run_id: 'r1', module: 'base' })
    await settle(ctx, 'r1')
    const reported = await call(ctx, 'clone_report', { run_id: 'r1' })
    expect((reported as { isError?: boolean }).isError).toBe(true)
    expect(rendered(reported)).toMatch(/no verdict/)
  })

  it('closes a fully assessed run and writes the three artifacts', async () => {
    const root = await workspace()
    const csv = join(root, 'func_clone_base.csv')
    await writeFile(csv, `${CSV_HEADER}p1,module/laws/src/a.cpp,ComputeArea,10-20,module/laws/src/b.cpp,CalcArea,30-40,0.95,type12\n`)
    const ctx = await mount({ projectRoot: 'D:/repo', artifactsRoot: join(root, 'runs'), detection: { provider: 'csv', csvPath: csv } }, fakeRunner(GIT_OK))
    await call(ctx, 'clone_scan', { run_id: 'r1', module: 'base' })
    await settle(ctx, 'r1')
    await call(ctx, 'clone_assess', {
      run_id: 'r1', cluster_id: 'C001', verdict: 'report_only', priority: 'P1',
      reason: 'renaming-only difference, but the callee is virtual',
      evidence: { file: 'module/laws/src/a.cpp', line: 12, snippet: 'virtual void draw();' },
    })
    const reported = await call(ctx, 'clone_report', { run_id: 'r1', notes: 'nothing was patched' })
    expect((reported as { isError?: boolean }).isError).not.toBe(true)

    const runDir = join(root, 'runs', 'r1')
    const summary = JSON.parse(await readFile(join(runDir, 'summary.json'), 'utf8')) as {
      clusters: number; missing: number; patched: number; verify_ok: boolean; digest: string
    }
    expect(summary.clusters).toBe(1)
    expect(summary.missing).toBe(0)
    expect(summary.patched).toBe(0)
    // No verification was ever run: the summary must not claim one passed.
    expect(summary.verify_ok).toBe(false)
    expect(summary.digest).toMatch(/^[0-9a-f]{16}$/)
    expect(await readFile(join(runDir, 'report.md'), 'utf8')).toContain('nothing was patched')
    const findings = JSON.parse(await readFile(join(runDir, 'findings.json'), 'utf8')) as Array<Record<string, unknown>>
    expect(findings).toHaveLength(1)
    expect(findings[0]?.verdict).toBe('report_only')
  })
})

describe('the whole chain', () => {
  it('scans, judges every cluster, verifies and reports', async () => {
    const root = await workspace()
    const csv = join(root, 'func_clone_base.csv')
    // TWO disjoint pairs, so the CSV really yields two clusters. A single-cluster
    // base makes the summary's counting assertions vacuous: `clusters: 1` is what
    // every wrong aggregation rule returns for a one-element input.
    await writeFile(csv, `${CSV_HEADER}p1,module/laws/src/a.cpp,ComputeArea,10-20,module/laws/src/b.cpp,CalcArea,30-40,0.95,type12\n`
      + 'p2,module/laws/src/c.cpp,DrawShape,50-60,module/laws/src/d.cpp,PaintShape,70-80,0.88,type12\n')
    const gitAndBuild: Array<[string, { stdout?: string; exitCode?: number }]> = [
      // 本测试把两个簇都判为 `report_only`，因此**不记录任何 patch**：授权账本为空，而
      // reconcile 会拿 `[]` 去比 `git diff` 报的东西。GIT_OK 的 diff 回答里有一个文件名，
      // 那会让本测试期望成功的验证步骤先被冻结 —— 所以先报一个干净的工作区（首个前缀匹配
      // 生效，覆盖项必须写在前面）。
      ['git status --porcelain', { stdout: '' }],
      ['git diff --name-only', { stdout: '' }],
      ...GIT_OK,
      ['msbuild', { stdout: 'Build succeeded\n' }],
      ['tests.exe', { stdout: 'All tests passed\n' }],
    ]
    const ctx = await mount({
      projectRoot: 'D:/repo',
      artifactsRoot: join(root, 'runs'),
      detection: { provider: 'csv', csvPath: csv },
      verify: { steps: [
        { name: 'build', phase: 'build', command: 'msbuild tests.sln' },
        { name: 'test', phase: 'test', command: 'tests.exe' },
      ] },
    }, fakeRunner(gitAndBuild))

    const scan = await call(ctx, 'clone_scan', { run_id: 'r1', module: 'base' })
    expect((scan as { isError?: boolean }).isError).not.toBe(true)
    await settle(ctx, 'r1')

    // Every cluster of the scan needs a verdict: the coverage contract is what
    // makes `missing: 0` below mean "judged", not "reported anyway".
    const assessed = await call(ctx, 'clone_assess', {
      run_id: 'r1', cluster_id: 'C001', verdict: 'report_only', priority: 'P1',
      reason: 'renaming-only difference, but the callee is virtual',
      evidence: { file: 'module/laws/src/a.cpp', line: 12, snippet: 'virtual void draw();' },
    })
    expect((assessed as { isError?: boolean }).isError).not.toBe(true)
    expect(rendered(assessed)).toContain('"remaining":1')

    const assessed2 = await call(ctx, 'clone_assess', {
      run_id: 'r1', cluster_id: 'C002', verdict: 'report_only', priority: 'P1',
      reason: 'the two shapes differ, but the base class owns the state both use',
      evidence: { file: 'module/laws/src/c.cpp', line: 52, snippet: 'void Shape::draw(const Target& t)' },
    })
    expect((assessed2 as { isError?: boolean }).isError, rendered(assessed2)).not.toBe(true)
    expect(rendered(assessed2)).toContain('"remaining":0')

    const verify = await call(ctx, 'clone_verify', { run_id: 'r1' })
    expect((verify as { isError?: boolean }).isError).not.toBe(true)
    await settle(ctx, 'r1')

    const report = await call(ctx, 'clone_report', { run_id: 'r1' })
    expect((report as { isError?: boolean }).isError, rendered(report)).not.toBe(true)
    const summaryPath = join(root, 'runs', 'r1', 'summary.json')
    const summary = JSON.parse(await readFile(summaryPath, 'utf8')) as { clusters: number; missing: number; verify_ok: boolean }
    expect(summary.clusters).toBe(2)
    expect(summary.missing).toBe(0)
    expect(summary.verify_ok).toBe(true)
    expect(await readFile(join(root, 'runs', 'r1', 'report.md'), 'utf8')).toContain('msbuild tests.sln')
  })

  it('freezes the run when a file outside the ledger changed', async () => {
    const root = await workspace()
    const csv = join(root, 'func_clone_base.csv')
    await writeFile(csv, `${CSV_HEADER}p1,module/laws/src/a.cpp,ComputeArea,10-20,module/laws/src/b.cpp,CalcArea,30-40,0.95,type12\n`)
    const ctx = await mount({
      projectRoot: 'D:/repo',
      artifactsRoot: join(root, 'runs'),
      detection: { provider: 'csv', csvPath: csv },
      authorization: { enabled: true },
      // 本测试的前提是"有一个改动落在账本之外"，那就意味着工作区是脏的；而默认的
      // `workdir.allowDirty: false` 会拒绝在脏工作区上开跑，于是 clone_scan 会在冻结
      // 被观察到之前就失败。这里必须显式允许脏基线。
      workdir: { allowDirty: true },
      verify: { steps: [{ name: 'build', phase: 'build', command: 'msbuild tests.sln' }] },
    }, fakeRunner([
      // 覆盖项必须写在 `...GIT_OK` **之前**：fakeRunner 返回首个前缀匹配，而 GIT_OK 里
      // 已经有 `git status --porcelain` / `git diff --name-only` 条目，写在后面会被它们
      // 遮蔽，测试于是永远看不到这两个"被改动的文件"，冻结逻辑根本不会被触发。
      ['git status --porcelain', { stdout: ' M module/laws/src/a.cpp\n M module/laws/src/sneaky.cpp\n' }],
      ['git diff --name-only', { stdout: 'module/laws/src/a.cpp\nmodule/laws/src/sneaky.cpp\n' }],
      ...GIT_OK,
    ]))
    await call(ctx, 'clone_scan', { run_id: 'r1', module: 'base' })
    await settle(ctx, 'r1')
    const assessed = await call(ctx, 'clone_assess', {
      run_id: 'r1', cluster_id: 'C001', verdict: 'patched', priority: 'P0',
      reason: 'body identical, extracted a helper', files_changed: ['module/laws/src/a.cpp'],
      evidence: { file: 'module/laws/src/a.cpp', line: 12, snippet: 'static int area(const Rect& r)' },
      confirm: true,
    })
    expect((assessed as { isError?: boolean }).isError, rendered(assessed)).not.toBe(true)
    // "A change outside the ledger" only means something when something is inside
    // it: with an empty ledger EVERY changed file is unauthorized, and the freeze
    // below would be indistinguishable from a ledger that never recorded consent.
    expect(await loadPatchesOf(root)).toHaveLength(1)
    const verify = await call(ctx, 'clone_verify', { run_id: 'r1' })
    expect((verify as { isError?: boolean }).isError).toBe(true)
    // Assert the payload, not the envelope, and name the authorized file too: the
    // freeze must be about sneaky.cpp, not about the authorized a.cpp.
    const frozen = rendered(verify)
    expect(frozen).toMatch(/UNAUTHORIZED_CHANGES/)
    expect(frozen).toMatch(/sneaky\.cpp/)
    expect(frozen).not.toMatch(/module\/laws\/src\/a\.cpp/)
  })
})
