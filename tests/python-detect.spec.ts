import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { resolveSettings } from '../src/config.ts'
import { runPaths } from '../src/core/artifacts.ts'
import { buildDetectionArgv, pythonDetector, redactArgv, redactText } from '../src/detect/python.ts'
import { fakeRunner } from './fixtures/fake-runner.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()!() })

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'clone-python-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

describe('buildDetectionArgv', () => {
  it('passes the module, the GME root, the output root and the embedding options', () => {
    const settings = resolveSettings({
      projectRoot: 'D:/gme',
      detection: { pythonPath: 'py.exe', scriptPath: 'D:/agent/docs/.codex/skills/cpp-clone-detection/scripts/run_gme_clone_detection.py', libclang: 'D:/llvm/libclang.dll', enableType34: true, embeddingApiBase: 'https://embed.example/v1', embeddingApiKey: 'secret-key' },
    }).settings
    const argv = buildDetectionArgv({ settings, module: 'base', outputRoot: 'D:/runs/r1/detection' })
    expect(argv.slice(0, 3)).toEqual(['py.exe', '-u', settings.detection.scriptPath])
    expect(argv).toContain('--module'); expect(argv).toContain('base')
    // `resolveSettings` resolves `projectRoot` natively, so the expected value is
    // spelled the way this OS spells it rather than the way the config literal does.
    expect(argv).toContain('--gme-root'); expect(argv).toContain(settings.projectRoot)
    expect(argv).toContain('--output-root'); expect(argv).toContain('D:/runs/r1/detection')
    expect(argv).toContain('--libclang'); expect(argv).toContain('D:/llvm/libclang.dll')
    expect(argv).toContain('--embedding-commercial-api-base')
    expect(argv).toContain('--enable-type34')
    expect(argv).toContain('--type34-threshold'); expect(argv).toContain('0.8')
  })

  it('asks for type 3-4 to be skipped when it is off', () => {
    const settings = resolveSettings({ projectRoot: 'D:/gme', detection: { scriptPath: 'x.py' } }).settings
    const argv = buildDetectionArgv({ settings, module: 'laws', outputRoot: 'D:/out' })
    expect(argv).toContain('--disable-type34')
    expect(argv).not.toContain('--enable-type34')
  })
})

describe('redactArgv', () => {
  it('replaces a secret wherever it appears', () => {
    expect(redactArgv(['py', '--key', 'secret-key', '--x', 'secret-key'], ['secret-key']))
      .toEqual(['py', '--key', '[redacted]', '--x', '[redacted]'])
  })

  it('leaves the arguments alone when there is no secret to redact', () => {
    expect(redactArgv(['py', '--key', 'k'], ['', ''])).toEqual(['py', '--key', 'k'])
  })
})

describe('redactText', () => {
  it('redacts a secret the child echoed inside a longer string', () => {
    expect(redactText('using key secret-key now', ['secret-key'])).toBe('using key [redacted] now')
    expect(redactText('nothing to hide', ['secret-key', ''])).toBe('nothing to hide')
  })
})

describe('pythonDetector', () => {
  it('runs the pipeline and reads the merged CSV it produced', async () => {
    const dir = await workspace()
    const paths = runPaths(dir, 'r1')
    const settings = resolveSettings({ projectRoot: 'D:/gme', detection: { pythonPath: 'py.exe', scriptPath: 'D:/agent/run.py' } }).settings
    // The pipeline writes <output-root>/<module>/func_clone_<module>.csv.
    await mkdir(join(paths.detectionDir, 'base'), { recursive: true })
    await writeFile(join(paths.detectionDir, 'base', 'func_clone_base.csv'),
      'pair_id,file1,func1_name,lines1,file2,func2_name,lines2,similarity\np1,a.cpp,f,1-2,b.cpp,g,3-4,0.9\n')
    const runner = fakeRunner([['py.exe -u D:/agent/run.py', { stdout: 'done\n' }]])
    const result = await pythonDetector().detect({
      settings, runner, paths, module: 'base', csvPath: '', signal: undefined,
    })
    expect(result.provider).toBe('python-pipeline')
    expect(result.clusters).toHaveLength(1)
    expect(result.artifacts[0]?.replaceAll('\\', '/')).toBe(join(paths.detectionDir, 'base', 'func_clone_base.csv').replaceAll('\\', '/'))
    expect(runner.calls[0]?.cwd).toBe(resolve('D:/gme'))
  })

  it('writes the invocation next to its output with the API key redacted', async () => {
    const dir = await workspace()
    const paths = runPaths(dir, 'r1')
    const settings = resolveSettings({
      projectRoot: 'D:/gme',
      detection: {
        pythonPath: 'py.exe', scriptPath: 'D:/agent/run.py',
        enableType34: true, embeddingApiKey: 'secret-key',
      },
    }).settings
    const runner = fakeRunner([['py.exe', { stdout: 'pipeline log\n' }]])
    // The log is written before the missing-CSV check makes the call fail: a run
    // that produced nothing is exactly when the record of the invocation matters.
    await expect(pythonDetector().detect({ settings, runner, paths, module: 'base', csvPath: '', signal: undefined }))
      .rejects.toThrow(/func_clone_base\.csv/)
    const log = await readFile(join(paths.detectionDir, 'detect-command.txt'), 'utf8')
    expect(log).toContain('--embedding-commercial-api-key [redacted]')
    expect(log).not.toContain('secret-key')
    expect(log).toContain('exit=0')
    expect(log).toContain('pipeline log')
  })

  it('fails with the pipeline log when the command exits non-zero', async () => {
    const dir = await workspace()
    const paths = runPaths(dir, 'r1')
    const settings = resolveSettings({ projectRoot: 'D:/gme', detection: { pythonPath: 'py.exe', scriptPath: 'D:/agent/run.py' } }).settings
    const runner = fakeRunner([['py.exe', { exitCode: 1, stderr: 'ModuleNotFoundError: libclang' }]])
    await expect(pythonDetector().detect({ settings, runner, paths, module: 'base', csvPath: '', signal: undefined }))
      .rejects.toThrow(/libclang/)
  })

  it('fails when the pipeline reports success but wrote no CSV', async () => {
    const dir = await workspace()
    const paths = runPaths(dir, 'r1')
    const settings = resolveSettings({ projectRoot: 'D:/gme', detection: { pythonPath: 'py.exe', scriptPath: 'D:/agent/run.py' } }).settings
    const runner = fakeRunner([['py.exe', { stdout: 'nothing to do\n' }]])
    await expect(pythonDetector().detect({ settings, runner, paths, module: 'base', csvPath: '', signal: undefined }))
      .rejects.toThrow(/func_clone_base\.csv/)
  })

  it('refuses to run when no script path is configured', async () => {
    const dir = await workspace()
    const settings = resolveSettings({ projectRoot: 'D:/gme' }).settings
    await expect(pythonDetector().detect({ settings, runner: fakeRunner([]), paths: runPaths(dir, 'r1'), module: 'base', csvPath: '', signal: undefined }))
      .rejects.toThrow(/detection\.scriptPath/)
  })
})

describe('the embedding channel is selected, not assumed', () => {
  it('asks for the commercial channel when a commercial endpoint is configured', () => {
    const settings = resolveSettings({
      projectRoot: 'D:/gme',
      detection: { scriptPath: 'x.py', enableType34: true, embeddingApiKey: 'secret-key' },
    }).settings
    const argv = buildDetectionArgv({ settings, module: 'base', outputRoot: 'D:/out' })
    // The script falls back to `local` for a missing or unknown provider, so
    // without this flag the configured base/key are silently ignored.
    expect(argv).toContain('--embedding-provider'); expect(argv).toContain('commercial')
  })

  it('leaves the pipeline default channel alone when nothing commercial is configured', () => {
    const settings = resolveSettings({ projectRoot: 'D:/gme', detection: { scriptPath: 'x.py', enableType34: true } }).settings
    const argv = buildDetectionArgv({ settings, module: 'base', outputRoot: 'D:/out' })
    expect(argv).not.toContain('--embedding-provider')
  })
})

describe('a leaked credential', () => {
  it('is redacted in the run log and in the thrown message, not just on the command line', async () => {
    const dir = await workspace()
    const paths = runPaths(dir, 'r1')
    const settings = resolveSettings({
      projectRoot: 'D:/gme',
      detection: { pythonPath: 'py.exe', scriptPath: 'D:/agent/run.py', embeddingApiKey: 'secret-key' },
    }).settings
    // The child was started with the key on its argv, so a pipeline that echoes its
    // own configuration is the realistic leak this test pins.
    const runner = fakeRunner([['py.exe', { exitCode: 1, stdout: 'boot with secret-key\n', stderr: 'fatal: secret-key rejected\n' }]])
    const error = await pythonDetector()
      .detect({ settings, runner, paths, module: 'base', csvPath: '', signal: undefined })
      .then(() => undefined, (caught: unknown) => caught as Error)
    expect(error?.message).toContain('[redacted]')
    expect(error?.message).not.toContain('secret-key')
    const log = await readFile(join(paths.detectionDir, 'detect-command.txt'), 'utf8')
    expect(log).toContain('[redacted]')
    expect(log).not.toContain('secret-key')
  })
})
