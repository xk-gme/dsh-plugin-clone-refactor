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
import { assertCompleted } from '../git/baseline.ts'
import { clustersFromRecords, hasCloneColumns, parseCsv, recordsOf } from './cluster.ts'
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
    // This plugin only exposes the two commercial knobs (base/key), while the script
    // falls back to `local` for a missing or unknown `--embedding-provider`: without
    // selecting the channel explicitly, a configured base/key is silently ignored and
    // type 3-4 runs on the local channel. "Configured but inert" is a defect of the
    // same class as a container warning that never fires.
    if (detection.embeddingApiBase !== '' || detection.embeddingApiKey !== '') argv.push('--embedding-provider', 'commercial')
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

/**
 * The same rule for free text. Redacting the command line is not enough: the child
 * is started with the key on its argv, so its own echo of that argv is the most
 * likely thing a diagnostic log contains — and the same streams are sliced into
 * the thrown message. `replaceAll` per secret, because the occurrence is not
 * necessarily a whole argument.
 */
export function redactText(text: string, secrets: readonly string[]): string {
  let redacted = text
  for (const secret of secrets) {
    if (secret !== '') redacted = redacted.replaceAll(secret, '[redacted]')
  }
  return redacted
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
      // Keep the invocation next to its output, with the API key redacted — and
      // redact the captured streams too, not just the command line we composed.
      const secrets = [settings.detection.embeddingApiKey]
      await writeFile(
        join(paths.detectionDir, 'detect-command.txt'),
        redactText(`${redactArgv(argv, secrets).join(' ')}\nexit=${String(result.exitCode)}\n\n${result.stdout}\n${result.stderr}`, secrets),
        'utf8',
      )
      if (result.exitCode !== 0 || result.timedOut) {
        // The shared MUTATING/started-command guard, not a bare `exitCode` check:
        // `{ exitCode: 0, timedOut: true }` is reachable (see the comment on
        // `assertCompleted` and `tests/command.spec.ts:157`), and the pipeline writes
        // its merged CSV incrementally — a child killed at its deadline that exits 0
        // leaves a PARTIAL csv, which would be parsed and reported as a complete
        // scan. That is a silent under-report of clone families.
        //
        // The guard is asked whether the command completed; its own message is NOT
        // reused, because it embeds the raw stderr and this provider is the one that
        // carries the embedding key on the child's argv. The refusal is rebuilt here
        // from the redacted detail, distinguishing a timeout from a plain failure.
        const detail = redactText(result.stderr.trim() || result.stdout.trim() || `exit ${String(result.exitCode)}`, secrets).slice(0, 2000)
        try {
          assertCompleted(result, 'The clone-detection pipeline')
        } catch {
          const reason = result.timedOut
            ? `The clone-detection pipeline was cut off by its timeout (exit ${String(result.exitCode)})`
            : 'The clone-detection pipeline failed'
          throw new Error(`${reason} (${detail})`)
        }
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
      // A CSV this parser cannot read is the SAME silent-zero-clusters failure as
      // exit 0 with no CSV: `clustersFromRecords` drops every row whose left or
      // right file is empty, so an unrecognized header comes back as `clusters: []`
      // — byte-identical to "this module has no clones". The `csv` detector already
      // refuses this at its own boundary with `hasCloneColumns`; without the same
      // refusal here the two providers disagree about whether an unreadable report
      // is a refusal or a clean result. A recognized header with no rows is a
      // different thing entirely and still returns zero clusters.
      if (!hasCloneColumns(header)) {
        throw new Error(
          `${csv} is not a clone report this provider can read: its header (${header.join(', ') || 'empty'}) `
          + 'names no file1/file2 column pair, so every row would be dropped and the module would look clone-free. '
          + 'The pipeline exited 0, so this is a report it wrote that this plugin cannot interpret.',
        )
      }
      return {
        clusters: clustersFromRecords(recordsOf(header, rows)),
        provider: 'python-pipeline',
        artifacts: [csv, join(paths.detectionDir, 'detect-command.txt')],
      }
    },
  }
}
