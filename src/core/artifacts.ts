/** Where a run lives, and how its files are written. */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'

/** Every file one run owns, so callers never assemble paths by hand. */
export interface RunPaths {
  dir: string
  runJson: string
  clusters: string
  assessments: string
  patches: string
  detectionDir: string
  verifyDir: string
  reportMd: string
  findingsJson: string
  summaryJson: string
}

/** The Harness home: `$DSH_HOME` when set, `~/.dsh` otherwise. */
export function dshHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.DSH_HOME?.trim()
  return configured !== undefined && configured !== '' ? configured : join(homedir(), '.dsh')
}

/** Where runs live when `artifactsRoot` is unconfigured. */
export function defaultArtifactsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(dshHome(env), 'gme-clone-refactor', 'runs')
}

/** The artifact paths of one run. */
export function runPaths(artifactsRoot: string, runId: string): RunPaths {
  const dir = join(artifactsRoot, runId)
  return {
    dir,
    runJson: join(dir, 'run.json'),
    clusters: join(dir, 'clusters.jsonl'),
    assessments: join(dir, 'assessments.jsonl'),
    patches: join(dir, 'patches.json'),
    detectionDir: join(dir, 'detection'),
    verifyDir: join(dir, 'verify'),
    reportMd: join(dir, 'report.md'),
    findingsJson: join(dir, 'findings.json'),
    summaryJson: join(dir, 'summary.json'),
  }
}

/** `<YYYYMMDD-HHMMSS>-<4 hex>` in UTC: sortable, and unique enough for one machine. */
export function newRunId(now: Date = new Date(), rand: () => number = Math.random): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0')
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`
    + `-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
  return `${stamp}-${Math.floor(rand() * 0x10000).toString(16).padStart(4, '0')}`
}

/**
 * Reject a run id that is not a single path segment under the artifacts root.
 * A model-supplied id is untrusted input: a separator or a dot segment would let
 * a run write outside its own directory.
 */
export function assertInsideRoot(artifactsRoot: string, runId: string): void {
  const trimmed = runId.trim()
  if (trimmed === '' || trimmed === '.' || trimmed === '..'
    || trimmed.includes('/') || trimmed.includes('\\')
    || resolve(artifactsRoot, trimmed) !== join(resolve(artifactsRoot), trimmed)) {
    throw new Error(`run_id '${runId}' escapes the artifacts root; use a plain name such as 20260920-010203-ab12`)
  }
  const expected = resolve(artifactsRoot) + sep
  if (!`${resolve(artifactsRoot, trimmed)}${sep}`.startsWith(expected)) {
    throw new Error(`run_id '${runId}' escapes the artifacts root`)
  }
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
}

/** Write through a temp file and rename, so a crash cannot leave a half artifact. */
export async function writeAtomic(file: string, text: string): Promise<void> {
  await ensureDir(dirname(file))
  const temp = `${file}.tmp`
  await writeFile(temp, text, 'utf8')
  await rename(temp, file)
}

/** Parse a JSON file; a missing file is `undefined`, malformed JSON throws. */
export async function readJson<T>(file: string): Promise<T | undefined> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  return JSON.parse(text) as T
}
