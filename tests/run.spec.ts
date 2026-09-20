import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveSettings } from '../src/config.ts'
import { artifactsRootOf, loadRun, openRun, saveRun } from '../src/core/run.ts'
import { fakeRunner } from './fixtures/fake-runner.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()!() })

async function root(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'clone-run-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

const GIT_OK: Array<[string, { stdout?: string }]> = [
  ['git rev-parse HEAD', { stdout: 'abc123\n' }],
  ['git rev-parse --abbrev-ref HEAD', { stdout: 'main\n' }],
  ['git status --porcelain', { stdout: '' }],
  ['git checkout -B', { stdout: '' }],
]

describe('artifactsRootOf', () => {
  it('prefers the configured root and otherwise falls back to DSH home', () => {
    expect(artifactsRootOf(resolveSettings({ artifactsRoot: 'D:/runs' }).settings, { DSH_HOME: 'D:/home' })
      .replaceAll('\\', '/')).toContain('D:/runs')
    expect(artifactsRootOf(resolveSettings({}).settings, { DSH_HOME: 'D:/home' })
      .replaceAll('\\', '/')).toBe('D:/home/gme-clone-refactor/runs')
  })
})

describe('openRun', () => {
  it('creates a run, records the baseline, and stays on the current branch when patching is off', async () => {
    const artifactsRoot = await root()
    const runner = fakeRunner(GIT_OK)
    const { settings } = resolveSettings({ projectRoot: 'D:/repo' })
    const opened = await openRun({ settings, runner, artifactsRoot, runId: 'run-1' })
    expect(opened.created).toBe(true)
    expect(opened.record.baseline.head).toBe('abc123')
    expect(opened.record.branch).toBe('main')
    expect(opened.record.detection_provider).toBe('csv')
    expect(runner.calls.some(call => call.argv[0] === 'git' && call.argv[1] === 'checkout')).toBe(false)
    expect(await loadRun(opened.paths)).toEqual(opened.record)
  })

  it('switches to the run branch when patching is authorized', async () => {
    const artifactsRoot = await root()
    const runner = fakeRunner(GIT_OK)
    const { settings } = resolveSettings({ projectRoot: 'D:/repo', authorization: { enabled: true } })
    const opened = await openRun({ settings, runner, artifactsRoot, runId: 'run-2' })
    expect(opened.record.branch).toBe('clone-refactor/run-2')
    expect(opened.record.original_branch).toBe('main')
    expect(runner.calls.some(call => call.argv.join(' ') === 'git checkout -B clone-refactor/run-2')).toBe(true)
  })

  it('resumes an existing run instead of re-baselining it', async () => {
    const artifactsRoot = await root()
    const runner = fakeRunner(GIT_OK)
    const { settings } = resolveSettings({ projectRoot: 'D:/repo' })
    await openRun({ settings, runner, artifactsRoot, runId: 'run-3' })
    const callsAfterCreate = runner.calls.length
    const resumed = await openRun({ settings, runner, artifactsRoot, runId: 'run-3' })
    expect(resumed.created).toBe(false)
    expect(runner.calls.length).toBe(callsAfterCreate)
    expect(resumed.record.created_at).toBe(resumed.record.updated_at)
  })

  it('refuses to start on a dirty work tree unless the operator allowed it', async () => {
    const artifactsRoot = await root()
    const dirty: Array<[string, { stdout?: string }]> = [
      ['git rev-parse HEAD', { stdout: 'abc123\n' }],
      ['git rev-parse --abbrev-ref HEAD', { stdout: 'main\n' }],
      ['git status --porcelain', { stdout: ' M src/a.cpp\u0000' }],
    ]
    await expect(openRun({ settings: resolveSettings({ projectRoot: 'D:/repo' }).settings, runner: fakeRunner(dirty), artifactsRoot, runId: 'run-4' }))
      .rejects.toThrow(/not clean.*workdir\.allowDirty/is)
    const allowed = resolveSettings({ projectRoot: 'D:/repo', workdir: { allowDirty: true } }).settings
    const opened = await openRun({ settings: allowed, runner: fakeRunner(dirty), artifactsRoot, runId: 'run-5' })
    expect(opened.record.baseline.dirty).toEqual(['src/a.cpp'])
  })

  it('rejects a run id that escapes the artifacts root', async () => {
    const artifactsRoot = await root()
    await expect(openRun({ settings: resolveSettings({ projectRoot: 'D:/repo' }).settings, runner: fakeRunner(GIT_OK), artifactsRoot, runId: '../evil' }))
      .rejects.toThrow(/escapes/)
  })

  it('refuses to run without a project root', async () => {
    await expect(openRun({ settings: resolveSettings({}).settings, runner: fakeRunner(GIT_OK), artifactsRoot: 'D:/runs', runId: 'run-6' }))
      .rejects.toThrow(/projectRoot/)
  })

  it('never writes the embedding API key into run.json', async () => {
    const artifactsRoot = await root()
    const runner = fakeRunner(GIT_OK)
    const { settings } = resolveSettings({
      projectRoot: 'D:/repo',
      detection: { embeddingApiBase: 'https://embed.example/v1', embeddingApiKey: 'secret-key' },
      verify: { keepFailedPatch: true },
    })
    const opened = await openRun({ settings, runner, artifactsRoot, runId: 'run-key' })
    // The document says a run directory may be copied or published; the key must not
    // travel with it. The on-disk text is what matters, not the returned record.
    const written = await readFile(opened.paths.runJson, 'utf8')
    expect(written).not.toContain('secret-key')
    expect(written).toContain('[redacted]')
    // Nothing else about the snapshot changed: the rest of detection and the flags
    // the readers actually use (authorization, verify.keepFailedPatch) survive.
    const stored = JSON.parse(written) as { settings: { detection: { embeddingApiBase: string, embeddingApiKey: string }, verify: { keepFailedPatch: boolean } } }
    expect(stored.settings.detection.embeddingApiBase).toBe('https://embed.example/v1')
    expect(stored.settings.detection.embeddingApiKey).toBe('[redacted]')
    expect(stored.settings.verify.keepFailedPatch).toBe(true)

    // The in-memory record still carries the live key: only the persisted copy is
    // redacted, so the detection call this run makes is unaffected.
    expect(opened.record.settings.detection.embeddingApiKey).toBe('secret-key')

    // A resumed run reads the redacted record back and must keep working, including
    // when it rewrites that record: the redaction has to survive a load/save cycle.
    const resumed = await openRun({ settings, runner, artifactsRoot, runId: 'run-key' })
    expect(resumed.created).toBe(false)
    expect(resumed.record.settings.detection.embeddingApiKey).toBe('[redacted]')
    await saveRun(resumed.paths, resumed.record)
    const rewritten = await readFile(resumed.paths.runJson, 'utf8')
    expect(rewritten).not.toContain('secret-key')
    expect((await loadRun(resumed.paths))?.settings.verify.keepFailedPatch).toBe(true)
  })
})
