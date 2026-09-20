/**
 * The verification pipeline: a declarative step list, not a port of the Python
 * backend's BuildTestPipeline.
 *
 * That pipeline exists to serialise parallel workers, parse compiler output and
 * write database rows. A single-run plugin whose model is in the loop needs none
 * of that: it has to run commands, judge exit codes, keep the logs as evidence,
 * and make sure a restore step runs even after a failure. Compile-error repair
 * is not ported either — the backend needed a `compile-fixer` strategy because it
 * was unattended, while here the model reads the log itself.
 */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { VerifyStep } from '../config.ts'
import { writeAtomic, type RunPaths } from '../core/artifacts.ts'
import type { CommandRunner } from '../core/command.ts'
import type { StepResult, VerifyResult } from '../core/schema.ts'

/** Humans read this in the report to know what "passed" meant. */
export const PASS_CRITERIA = 'Every required step exited 0; a step that times out or is killed never passes.'

export interface EngineOptions {
  runner: CommandRunner
  paths: RunPaths
  steps: readonly VerifyStep[]
  cwd: string
  attempt: number
  signal: AbortSignal | undefined
  now?: () => Date
  /** Called after each step, so a poller can report progress mid-pipeline. */
  onStep?: (result: StepResult) => Promise<void> | void
}

export function logFileFor(paths: RunPaths, attempt: number, index: number, name: string): string {
  const safe = name.replaceAll(/[^\w.-]+/g, '-')
  return join(paths.verifyDir, String(attempt), `${index}-${safe}.log`)
}

function renderLog(step: VerifyStep, result: StepResult, cwd: string, stdout: string, stderr: string, spillPath: string | null, signal: string | null): string {
  const lines = [
    `step: ${step.name}`,
    `phase: ${step.phase}`,
    `command: ${step.command}`,
    `cwd: ${cwd}`,
    `required: ${String(step.required)}`,
    `always: ${String(step.always)}`,
    `exit_code: ${String(result.exit_code)}`,
    // The runner's own signal — never an inference from a null exit code. A command
    // that never started reports EXIT_NOT_RUN (-1), not null, so "null means it never
    // started" would be a false statement inside the one artifact that *is* the
    // evidence. StepResult has no field for the signal, so this line is its only home.
    `signal: ${signal ?? (result.exit_code === null ? 'unknown' : 'none')}`,
    `timed_out: ${String(result.timed_out)}`,
    `lossy: ${String(result.lossy)}`,
  ]
  if (spillPath !== null) lines.push(`spill: ${spillPath}`)
  lines.push('', '--- stdout ---', stdout, '', '--- stderr ---', stderr, '')
  return lines.join('\n')
}

/** Run the configured steps and return the recorded outcome of one attempt. */
export async function runVerification(options: EngineOptions): Promise<VerifyResult> {
  const now = options.now ?? (() => new Date())
  const startedAt = now().toISOString()
  const attemptDir = join(options.paths.verifyDir, String(options.attempt))
  await mkdir(attemptDir, { recursive: true })
  const results: StepResult[] = []
  let failed = false
  for (const [index, step] of options.steps.entries()) {
    if (failed && !step.always) continue
    const result = await options.runner.run({
      // `command` is a whole command line by design: build and test invocations
      // differ per site, and every shipped profile is a documented example.
      argv: splitCommand(step.command),
      cwd: options.cwd,
      timeoutMs: step.timeoutMs,
      signal: options.signal,
    })
    const ok = result.exitCode === 0 && !result.timedOut
    const stepResult: StepResult = {
      name: step.name,
      phase: step.phase,
      command: step.command,
      required: step.required,
      always: step.always,
      exit_code: result.exitCode,
      ok,
      timed_out: result.timedOut,
      log_file: logFileFor(options.paths, options.attempt, index + 1, step.name),
      lossy: result.lossy,
    }
    await mkdir(attemptDir, { recursive: true })
    // `writeAtomic`, like every other run-directory artefact: this file is exactly
    // what the model polls live through `clone_check what: 'log'`, so a reader must
    // never find a half-written log in place of the previous step's.
    await writeAtomic(stepResult.log_file, renderLog(step, stepResult, options.cwd, result.stdout, result.stderr, result.spillPath, result.signal))
    results.push(stepResult)
    // Only a required step can fail the run: an optional step that fails is
    // bookkeeping, not evidence about the patch. An `always` step that fails is
    // still recorded, and still counts when it is required.
    if (!ok && step.required) failed = true
    await options.onStep?.(stepResult)
  }
  return {
    attempt: options.attempt,
    // Vacuous truth by design: with no configured steps nothing required failed, so
    // `ok` is true. A caller that reads `ok` as "this patch was verified" MUST
    // therefore refuse an empty step list itself — the `clone_verify` tool in
    // `src/tools.ts` does — and
    // the test below pins this vacuity so it stays a decision rather than a surprise.
    ok: !results.some(result => result.required && !result.ok),
    started_at: startedAt,
    finished_at: now().toISOString(),
    steps: results,
    // The set this attempt was configured with, recorded on the attempt itself: the
    // report derives "not run" from these two fields, so it stays truthful about a
    // run whose `verify.steps` the operator edited after this attempt ran.
    configured_steps: options.steps.map(step => step.name),
    rolled_back: false,
    rollback_files: [],
  }
}

/**
 * Split a configured command line into argv. Quoted segments survive, because a
 * site path with spaces is the normal case on Windows.
 */
export function splitCommand(command: string): string[] {
  const argv: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let started = false
  for (const char of command) {
    if (quote !== null) {
      if (char === quote) quote = null
      else current += char
      continue
    }
    if (char === '"' || char === "'") { quote = char; started = true; continue }
    if (char === ' ' || char === '\t') {
      if (started || current !== '') { argv.push(current); current = ''; started = false }
      continue
    }
    current += char
    started = true
  }
  if (started || current !== '') argv.push(current)
  return argv
}
