/** Verification attempt records on disk: the evidence `clone_submit` checks. */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { readJson, type RunPaths } from '../core/artifacts.ts'
import type { VerifyResult } from '../core/schema.ts'

export async function loadVerifyAttempts(paths: RunPaths): Promise<VerifyResult[]> {
  let names: string[]
  try {
    names = await readdir(paths.verifyDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const attempts = await Promise.all(names
    .filter(name => /^\d+$/.test(name))
    .map(async name => await readJson<VerifyResult>(join(paths.verifyDir, name, 'result.json'))))
  return attempts.filter((attempt): attempt is VerifyResult => attempt !== undefined)
    .sort((left, right) => left.attempt - right.attempt)
}

/** Every reconcile audit recorded so far, flattened: what the report calls unauthorized. */
export async function loadUnauthorized(paths: RunPaths): Promise<string[]> {
  let names: string[]
  try {
    names = await readdir(paths.verifyDir)
  } catch {
    return []
  }
  const audits = await Promise.all(names
    .filter(name => /^\d+$/.test(name))
    .map(async name => await readJson<{ unauthorized?: string[] }>(join(paths.verifyDir, name, 'reconcile.json'))))
  return [...new Set(audits.flatMap(audit => audit?.unauthorized ?? []))].sort()
}

/**
 * The tail of the newest step log of the newest attempt. A poller reads this
 * while a build runs, so it stays a bounded slice rather than the whole file.
 */
export async function readNewestVerifyLog(
  paths: RunPaths,
  lines: number,
): Promise<{ file: string; lines: string[] } | undefined> {
  const attempts = await loadVerifyAttempts(paths)
  const newest = attempts.at(-1)
  const directory = newest === undefined
    ? await newestAttemptDir(paths)
    : join(paths.verifyDir, String(newest.attempt))
  if (directory === undefined) return undefined
  const names = (await readdir(directory).catch(() => [])).filter(name => name.endsWith('.log')).sort()
  const file = names.at(-1)
  if (file === undefined) return undefined
  const absolute = join(directory, file)
  const text = await readFile(absolute, 'utf8').catch(() => '')
  const all = text.split('\n')
  return { file: absolute, lines: all.slice(Math.max(0, all.length - lines)) }
}

/** The highest-numbered attempt directory, when no result.json has been written yet. */
async function newestAttemptDir(paths: RunPaths): Promise<string | undefined> {
  const names = (await readdir(paths.verifyDir).catch(() => [])).filter(name => /^\d+$/.test(name))
  const highest = names.map(Number).sort((left, right) => left - right).at(-1)
  return highest === undefined ? undefined : join(paths.verifyDir, String(highest))
}
