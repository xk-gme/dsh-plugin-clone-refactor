/**
 * The faithful detector: drive the existing GME clone-detection pipeline.
 *
 * It is the only path that produces type 3-4 (embedding) clones, and it requires
 * a Python checkout with libclang and, for type 3-4, an embeddings endpoint. The
 * `csv` detector is the self-contained alternative; which one answered is
 * recorded on the run and printed in the report, because two providers never
 * produce comparable cluster sets.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Settings } from '../config.ts'
import { ensureDir } from '../core/artifacts.ts'
import { clustersFromRecords, parseCsv, recordsOf } from './cluster.ts'
import type { CloneDetector, DetectInput, DetectResult } from './provider.ts'

export interface BuildArgvOptions {
  settings: Settings
  module: string
  outputRoot: string
}

/** The exact command line the pipeline documents, in one place. */
export function buildDetectionArgv(options: BuildArgvOptions): string[] {
  const { settings, module, outputRoot } = options
  const detection = settings.detection
  const argv = [detection.pythonPath, '-u', detection.scriptPath, '--module', module, '--output-root', outputRoot]
  if (settings.projectRoot !== '') argv.push('--gme-root', settings.projectRoot)
  if (detection.libclang !== '') argv.push('--libclang', detection.libclang)
  argv.push(detection.enableType34 ? '--enable-type34' : '--disable-type34')
  if (detection.enableType34) {
    if (detection.embeddingModel !== '') argv.push('--type34-model', detection.embeddingModel)
    if (detection.embeddingApiBase !== '') argv.push('--embedding-commercial-api-base', detection.embeddingApiBase)
    if (detection.embeddingApiKey !== '') argv.push('--embedding-commercial-api-key', detection.embeddingApiKey)
    argv.push('--type34-threshold', String(detection.embeddingThreshold))
  }
  return argv
}

/** Never write a credential into a log: replace every occurrence, wherever it sits. */
export function redactArgv(argv: readonly string[], secrets: readonly string[]): string[] {
  const present = secrets.filter(secret => secret !== '')
  return argv.map(arg => (present.some(secret => arg.includes(secret)) ? '[redacted]' : arg))
}

/** The merged CSV the pipeline writes for one module. */
export function mergedCsvPath(outputRoot: string, module: string): string {
  return join(outputRoot, module, `func_clone_${module}.csv`)
}

/**
 * One module's clone detection is long work, and the command host kills a child
 * at its timeout: an hour, the same order as the session's own agent timeout, so
 * the pipeline is not killed while it is still legitimately running.
 */
const DETECTION_TIMEOUT_MS = 3_600_000

export function pythonDetector(): CloneDetector {
  return {
    id: 'python-pipeline',
    async detect(input: DetectInput): Promise<DetectResult> {
      const { settings, runner, paths, module, signal } = input
      if (settings.detection.scriptPath === '') {
        throw new Error('detection.scriptPath is not configured, so the python-pipeline provider cannot run; set it in the profile row or use detection.provider: csv')
      }
      const target = module.trim()
      if (target === '') throw new Error('The python-pipeline provider needs a module name, for example base or laws')
      await ensureDir(paths.detectionDir)
      // The run directory is the only write target: --output-root points at it, so
      // the pipeline never writes into the repository it is scanning.
      const argv = buildDetectionArgv({ settings, module: target, outputRoot: paths.detectionDir })
      const result = await runner.run({
        argv, cwd: settings.projectRoot, timeoutMs: DETECTION_TIMEOUT_MS, signal,
      })
      // Keep the invocation next to its output, with the API key redacted: the
      // run directory is the only durable record of what produced these clusters.
      await writeFile(
        join(paths.detectionDir, 'detect-command.txt'),
        `${redactArgv(argv, [settings.detection.embeddingApiKey]).join(' ')}\nexit=${String(result.exitCode)}\n\n${result.stdout}\n${result.stderr}`,
        'utf8',
      )
      if (result.exitCode !== 0) {
        const detail = (result.stderr.trim() || result.stdout.trim() || `exit ${String(result.exitCode)}`).slice(0, 2000)
        throw new Error(`The clone-detection pipeline failed (${detail})`)
      }
      const csv = mergedCsvPath(paths.detectionDir, target)
      let text: string
      try {
        text = await readFile(csv, 'utf8')
      } catch {
        // Exit 0 with no CSV is the silent-zero-clusters failure this provider
        // exists to prevent: name the file that was expected, and where to look.
        throw new Error(`The pipeline exited 0 but wrote no ${`func_clone_${target}.csv`}; inspect ${paths.detectionDir}`)
      }
      const { header, rows } = parseCsv(text)
      return {
        clusters: clustersFromRecords(recordsOf(header, rows)),
        provider: 'python-pipeline',
        artifacts: [csv, join(paths.detectionDir, 'detect-command.txt')],
      }
    },
  }
}
