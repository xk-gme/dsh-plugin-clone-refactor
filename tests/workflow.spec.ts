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

describe('clone_assess authorization rules', () => {
  it('refuses a patched verdict without confirm, and with patching disabled', async () => {
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
      // Order matters: `fakeRunner` returns the FIRST entry whose prefix matches,
      // and each array is a sequence consumed one entry per call. `openRun` must
      // read a clean tree or it refuses to start, while clone_verify must read the
      // patch. The longer diff prefix also wins over GIT_OK's shorter one.
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
  /**
   * One entry per `git status --porcelain` read, resting on the dirty answer: the
   * run's baseline read is clean, and every later read — the reconcile's — sees
   * the patch. `readBaseline` insists on a trustworthy status, so the sequence is
   * what makes a run start against a tree that is about to look modified.
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
