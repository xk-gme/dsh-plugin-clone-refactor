/**
 * The run lifecycle. A run is bound to one work tree and one baseline: without
 * that binding the authorization reconciliation cannot tell this run's edits
 * from the user's own, and every later tool must keep using the same pair.
 */
import { resolve } from 'node:path'
import type { DetectionProvider, Settings } from '../config.ts'
import { assertInsideRoot, defaultArtifactsRoot, newRunId, readJson, runPaths, writeAtomic, type RunPaths } from './artifacts.ts'
import type { CommandRunner } from './command.ts'
import { createBranch, readBaseline, type Baseline } from '../git/baseline.ts'

export interface RunRecord {
  run_id: string
  project_root: string
  baseline: Baseline
  /** The branch this run works on: `clone-refactor/<id>` only when patching is authorized. */
  branch: string
  /** The branch the user was on when the run started. */
  original_branch: string
  detection_provider: DetectionProvider
  /** Which clustering implementation produced the clusters. */
  cluster_path: 'inline'
  created_at: string
  updated_at: string
  /** The configuration this run started with: a later config change must not rewrite history. */
  settings: Settings
}

/** Where this deployment's runs live: the configured root, else the DSH home default. */
export function artifactsRootOf(settings: Settings, env: NodeJS.ProcessEnv = process.env): string {
  return settings.artifactsRoot === '' ? defaultArtifactsRoot(env) : resolve(settings.artifactsRoot)
}

export async function loadRun(paths: RunPaths): Promise<RunRecord | undefined> {
  return await readJson<RunRecord>(paths.runJson)
}

/** What replaces a credential in the persisted snapshot. */
const REDACTED = '[redacted]'

/**
 * The record as it may exist on disk.
 *
 * `JSON.stringify(record)` used to write the whole `Settings` snapshot — including
 * `detection.embeddingApiKey` — into `run.json`, which is the artifact the docs tell
 * operators they may copy or publish. The key is redacted here, at the one boundary
 * where a record becomes bytes, so no other path can reintroduce it. Nothing reads
 * it back: `record.settings` is consulted for `authorization` and
 * `verify.keepFailedPatch` only, and detection reads the LIVE settings, so every
 * field a reader needs survives this unchanged. An empty key stays empty rather than
 * claiming a credential was withheld.
 */
function serializeRun(record: RunRecord): string {
  const persisted: RunRecord = {
    ...record,
    settings: {
      ...record.settings,
      detection: {
        ...record.settings.detection,
        embeddingApiKey: record.settings.detection.embeddingApiKey === '' ? '' : REDACTED,
      },
    },
  }
  return `${JSON.stringify(persisted, null, 2)}\n`
}

/**
 * Resume an EXISTING run, or fail naming the id.
 *
 * `openRun` does more than read: it reads the baseline and, when patching is
 * authorized, runs `git checkout -B clone-refactor/<id>` in the user's checkout.
 * Every tool except `clone_scan` must not create a run, so a mistyped `run_id`
 * must not reach it — that is how a stray `clone_assess`, `clone_verify`,
 * `clone_submit` or `clone_report` created a run, switched the user's branch and
 * (for verify) started the build pipeline for a run that never existed.
 */
export async function requireRun(artifactsRoot: string, runId: string): Promise<OpenedRun> {
  assertInsideRoot(artifactsRoot, runId)
  const paths = runPaths(artifactsRoot, runId)
  const record = await loadRun(paths)
  if (record === undefined) {
    throw new Error(`No run '${runId}' under ${artifactsRoot}. Call clone_scan first: only clone_scan may create a run.`)
  }
  return { record, paths, created: false }
}

export interface OpenRunOptions {
  settings: Settings
  runner: CommandRunner
  artifactsRoot: string
  runId?: string
  now?: Date
}

export interface OpenedRun {
  record: RunRecord
  paths: RunPaths
  created: boolean
}

/**
 * Create a run, or resume the one with this id. Resuming never re-reads the
 * baseline: the whole point of the record is that it is fixed at creation.
 */
export async function openRun(options: OpenRunOptions): Promise<OpenedRun> {
  const { settings, runner, artifactsRoot } = options
  if (settings.projectRoot === '') {
    throw new Error('projectRoot is not configured; set GME_CLONE_REFACTOR_ROOT before starting Harness or override the gme-clone-refactor row')
  }
  const runId = options.runId?.trim() ?? newRunId(options.now ?? new Date())
  assertInsideRoot(artifactsRoot, runId)
  const paths = runPaths(artifactsRoot, runId)
  const existing = await loadRun(paths)
  if (existing !== undefined) return { record: existing, paths, created: false }

  const baseline = await readBaseline(runner, settings.projectRoot)
  if (baseline.dirty.length > 0 && !settings.workdir.allowDirty) {
    throw new Error(
      `The work tree ${settings.projectRoot} is not clean (${baseline.dirty.length} changed file(s)). `
      + 'Commit or stash them, or set workdir.allowDirty: true to record a hashed baseline and reconcile against the ledger only.',
    )
  }
  const branch = settings.authorization.enabled ? `clone-refactor/${runId}` : baseline.branch
  if (settings.authorization.enabled) await createBranch(runner, settings.projectRoot, branch)
  const stamp = (options.now ?? new Date()).toISOString()
  const record: RunRecord = {
    run_id: runId,
    project_root: settings.projectRoot,
    baseline,
    branch,
    original_branch: baseline.branch,
    detection_provider: settings.detection.provider,
    cluster_path: 'inline',
    created_at: stamp,
    updated_at: stamp,
    settings,
  }
  await writeAtomic(paths.runJson, serializeRun(record))
  return { record, paths, created: true }
}

/** Persist a mutated run record (status, provider choice, timestamps). */
export async function saveRun(paths: RunPaths, record: RunRecord, now: Date = new Date()): Promise<RunRecord> {
  const updated: RunRecord = { ...record, updated_at: now.toISOString() }
  // The same boundary as `openRun`. A record loaded from disk is already redacted,
  // so rewriting it keeps the redaction rather than laundering a key back in.
  await writeAtomic(paths.runJson, serializeRun(updated))
  return updated
}
