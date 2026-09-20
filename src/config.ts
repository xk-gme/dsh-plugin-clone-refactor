/**
 * Trusted, normalized deployment configuration.
 *
 * Every field is read defensively. A row whose config fails validation takes the
 * whole plugin tree down at boot ("dsh: 1 entry did not activate"), so a bad value
 * degrades to its documented default and is reported as a warning instead of
 * being rejected by the loader.
 */
import { resolve } from 'node:path'

export type Priority = 'P0' | 'P1' | 'P2' | 'PX'
export type DetectionProvider = 'csv' | 'python-pipeline'
export type VerifyPhase = 'setup' | 'build' | 'test' | 'check' | 'restore'
export type SubmitMode = 'none' | 'commit' | 'push' | 'pr'

export const PRIORITIES: readonly Priority[] = ['P0', 'P1', 'P2', 'PX']
export const PROVIDERS: readonly DetectionProvider[] = ['csv', 'python-pipeline']
export const PHASES: readonly VerifyPhase[] = ['setup', 'build', 'test', 'check', 'restore']
export const SUBMIT_MODES: readonly SubmitMode[] = ['none', 'commit', 'push', 'pr']

/** Rank order for authorization: lower is more severe. */
export const PRIORITY_RANK: Record<Priority, number> = { P0: 0, P1: 1, P2: 2, PX: 3 }

export interface VerifyStep {
  name: string
  phase: VerifyPhase
  command: string
  /** A failed required step fails the whole verification. */
  required: boolean
  /** Run even after an earlier step failed: the `finally` semantics. */
  always: boolean
  timeoutMs: number
}

export interface DetectionSettings {
  provider: DetectionProvider
  /** An existing `func_clone_<module>.csv` when the provider is `csv`. */
  csvPath: string
  pythonPath: string
  scriptPath: string
  libclang: string
  enableType34: boolean
  embeddingModel: string
  embeddingApiBase: string
  embeddingApiKey: string
  embeddingThreshold: number
}

export interface Settings {
  /** Main work tree. Empty means "not configured": no tool is registered. */
  projectRoot: string
  /** Where runs live. Empty means "DSH home". */
  artifactsRoot: string
  detection: DetectionSettings
  authorization: { enabled: boolean; maxPriority: Priority; maxClusters: number }
  verify: { steps: VerifyStep[]; keepFailedPatch: boolean; outputMaxBytes: number; graceMs: number }
  submit: { mode: SubmitMode; baseBranch: string; remote: string; commitMessageTemplate: string }
  workdir: { allowDirty: boolean; returnToOriginalBranch: boolean }
  reportLanguage: 'zh' | 'en'
  pageChars: number
}

/** What a warning prints in place of a value nothing here can describe. */
const UNRENDERABLE = '[unserializable]'

/**
 * Read a nested section. A *present* value that is not a plain object is a
 * configuration mistake, and this file exists so mistakes are reported: a
 * silently-defaulted `detection: 42` leaves the operator with no idea why their
 * settings do nothing. An absent value is not a mistake and warns nothing.
 */
function record(value: unknown, label: string, warnings: string[]): Record<string, unknown> {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    warnings.push(`${label} must be an object; using its defaults`)
    return {}
  }
  return value as Record<string, unknown>
}

/**
 * Render a value inside a warning. `JSON.stringify` throws on a BigInt, and a
 * `!!js` config expression can supply one, so the renderer that explains a bad
 * value must not itself be a way for `apply` to throw.
 */
function render(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, item: unknown) => (typeof item === 'bigint' ? `${item}n` : item))
  } catch {
    return UNRENDERABLE
  }
}

function text(value: unknown, fallback: string, label: string, warnings: string[]): string {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string') {
    warnings.push(`${label} must be a string; using ${render(fallback)}`)
    return fallback
  }
  return value.trim() === '' ? fallback : value.trim()
}

function integer(value: unknown, fallback: number, label: string, min: number, max: number, warnings: string[]): number {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    warnings.push(`${label} must be an integer in [${min}, ${max}]; using ${fallback}`)
    return fallback
  }
  return value
}

function number(value: unknown, fallback: number, label: string, min: number, max: number, warnings: string[]): number {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    warnings.push(`${label} must be a number in [${min}, ${max}]; using ${fallback}`)
    return fallback
  }
  return value
}

function boolean(value: unknown, fallback: boolean, label: string, warnings: string[]): boolean {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'boolean') {
    warnings.push(`${label} must be a boolean; using ${fallback}`)
    return fallback
  }
  return value
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T, label: string, warnings: string[]): T {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    warnings.push(`${label} must be one of ${render(allowed)}; using ${render(fallback)}`)
    return fallback
  }
  return value as T
}

const MAX_TIMEOUT_MS = 86_400_000

/** One step of the verification pipeline; malformed entries are dropped, never guessed. */
function verifySteps(value: unknown, warnings: string[]): VerifyStep[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    warnings.push('verify.steps must be an array; running no steps')
    return []
  }
  const steps: VerifyStep[] = []
  for (const [index, item] of value.entries()) {
    // Guarded here rather than through `record` so one bad item yields exactly one
    // warning: a non-object entry is dropped, it does not also complain about a
    // missing name and command.
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      warnings.push(`verify.steps[${index}] must be an object; dropped`)
      continue
    }
    const raw = item as Record<string, unknown>
    const name = typeof raw.name === 'string' ? raw.name.trim() : ''
    const command = typeof raw.command === 'string' ? raw.command.trim() : ''
    if (name === '' || command === '') {
      warnings.push(`verify.steps[${index}] needs non-empty name and command; dropped`)
      continue
    }
    const phase = oneOf(raw.phase, PHASES, 'build', `verify.steps[${index}].phase`, warnings)
    steps.push({
      name,
      phase,
      command,
      required: boolean(raw.required, true, `verify.steps[${index}].required`, warnings),
      // A restore step that is skipped after a failure is the one thing a
      // pipeline must never do, so `restore` defaults to always running.
      always: boolean(raw.always, phase === 'restore', `verify.steps[${index}].always`, warnings),
      timeoutMs: integer(raw.timeoutMs, 1_800_000, `verify.steps[${index}].timeoutMs`, 1_000, MAX_TIMEOUT_MS, warnings),
    })
  }
  return steps
}

function detectionSettings(value: unknown, warnings: string[]): DetectionSettings {
  const raw = record(value, 'detection', warnings)
  return {
    provider: oneOf(raw.provider, PROVIDERS, 'csv', 'detection.provider', warnings),
    csvPath: text(raw.csvPath, '', 'detection.csvPath', warnings),
    pythonPath: text(raw.pythonPath, 'python', 'detection.pythonPath', warnings),
    scriptPath: text(raw.scriptPath, '', 'detection.scriptPath', warnings),
    libclang: text(raw.libclang, '', 'detection.libclang', warnings),
    enableType34: boolean(raw.enableType34, false, 'detection.enableType34', warnings),
    embeddingModel: text(raw.embeddingModel, '', 'detection.embeddingModel', warnings),
    embeddingApiBase: text(raw.embeddingApiBase, '', 'detection.embeddingApiBase', warnings),
    embeddingApiKey: text(raw.embeddingApiKey, '', 'detection.embeddingApiKey', warnings),
    embeddingThreshold: number(raw.embeddingThreshold, 0.8, 'detection.embeddingThreshold', 0, 1, warnings),
  }
}

/**
 * Normalize a profile row into settings. Never throws: this runs at boot, and a
 * throw here is a plugin-tree failure.
 */
export function resolveSettings(raw: unknown): { settings: Settings; warnings: string[] } {
  const warnings: string[] = []
  const source = record(raw, 'config', warnings)
  const projectRoot = text(source.projectRoot, '', 'projectRoot', warnings)
  const reportLanguage = oneOf(source.reportLanguage, ['zh', 'en'] as const, 'zh', 'reportLanguage', warnings)
  const authorization = record(source.authorization, 'authorization', warnings)
  const verify = record(source.verify, 'verify', warnings)
  const submit = record(source.submit, 'submit', warnings)
  const workdir = record(source.workdir, 'workdir', warnings)
  return {
    settings: {
      projectRoot: projectRoot === '' ? '' : resolve(projectRoot),
      artifactsRoot: text(source.artifactsRoot, '', 'artifactsRoot', warnings),
      detection: detectionSettings(source.detection, warnings),
      authorization: {
        enabled: boolean(authorization.enabled, false, 'authorization.enabled', warnings),
        maxPriority: oneOf(authorization.maxPriority, PRIORITIES, 'P0', 'authorization.maxPriority', warnings),
        maxClusters: integer(authorization.maxClusters, 1, 'authorization.maxClusters', 0, 100, warnings),
      },
      verify: {
        steps: verifySteps(verify.steps, warnings),
        keepFailedPatch: boolean(verify.keepFailedPatch, false, 'verify.keepFailedPatch', warnings),
        outputMaxBytes: integer(verify.outputMaxBytes, 4_194_304, 'verify.outputMaxBytes', 1024, 268_435_456, warnings),
        graceMs: integer(verify.graceMs, 5000, 'verify.graceMs', 0, 60_000, warnings),
      },
      submit: {
        mode: oneOf(submit.mode, SUBMIT_MODES, 'none', 'submit.mode', warnings),
        baseBranch: text(submit.baseBranch, '', 'submit.baseBranch', warnings),
        remote: text(submit.remote, 'origin', 'submit.remote', warnings),
        commitMessageTemplate: text(submit.commitMessageTemplate, '', 'submit.commitMessageTemplate', warnings),
      },
      workdir: {
        allowDirty: boolean(workdir.allowDirty, false, 'workdir.allowDirty', warnings),
        returnToOriginalBranch: boolean(workdir.returnToOriginalBranch, false, 'workdir.returnToOriginalBranch', warnings),
      },
      reportLanguage,
      pageChars: integer(source.pageChars, 12_000, 'pageChars', 256, 50_000, warnings),
    },
    warnings,
  }
}
