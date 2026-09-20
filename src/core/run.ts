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
  await writeAtomic(paths.runJson, `${JSON.stringify(record, null, 2)}\n`)
  return { record, paths, created: true }
}

/** Persist a mutated run record (status, provider choice, timestamps). */
export async function saveRun(paths: RunPaths, record: RunRecord, now: Date = new Date()): Promise<RunRecord> {
  const updated: RunRecord = { ...record, updated_at: now.toISOString() }
  await writeAtomic(paths.runJson, `${JSON.stringify(updated, null, 2)}\n`)
  return updated
}
