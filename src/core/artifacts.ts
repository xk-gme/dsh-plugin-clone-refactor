/** Where a run lives, and how its files are written. */
import { mkdir, readFile, rename as renameFile, rm, writeFile } from 'node:fs/promises'
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

export interface RenameAttempt { (from: string, to: string): Promise<void> }

/** Errnos a rename may hit while another handle holds the target. */
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])

/** 10 attempts, 5 ms doubling to a 320 ms cap: ~1.3 s of waiting in the worst case. */
const RENAME_ATTEMPTS = 10
const RENAME_BASE_DELAY_MS = 5
const RENAME_MAX_DELAY_MS = 320

/**
 * Windows refuses to replace a file another handle has open, so a concurrent reader
 * makes `rename` fail with EPERM/EACCES/EBUSY. Those are transient by nature: retry
 * briefly, and only then let the error out.
 *
 * The delay is constant per attempt rather than held in a closure counter, so a
 * rejected attempt cannot corrupt the next one's backoff. The rename and the sleep
 * are injectable so a test can prove the retry policy without racing a real
 * filesystem or waiting out the real backoff; the attempt count and the delays
 * themselves are fixed, because this is a policy, not a knob.
 */
export async function renameWithRetry(
  from: string,
  to: string,
  rename: RenameAttempt = renameFile,
  sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      // Anything but the transient set is a real error: report it, do not wait on it.
      if (code === undefined || !TRANSIENT_RENAME_CODES.has(code)) throw error
      if (attempt === RENAME_ATTEMPTS - 1) throw error
      await sleep(Math.min(RENAME_BASE_DELAY_MS * 2 ** attempt, RENAME_MAX_DELAY_MS))
    }
  }
}

/**
 * Makes each call's temp name distinct. Two writers aiming at one file used to
 * share `<file>.tmp`, so the second could rename away the first's temp while the
 * first was still writing it; the loser then failed with ENOENT on its own rename.
 */
let tempCounter = 0

function tempPath(file: string): string {
  tempCounter += 1
  return `${file}.${process.pid}.${String(tempCounter)}.tmp`
}

/**
 * Write through a temp file and rename, so a crash cannot leave a half artifact.
 *
 * The rename goes through `renameWithRetry`: a concurrent reader makes the plain
 * rename fail on Windows, and a caller that swallowed that failure would leave the
 * previous contents in place, which for a job record means a task that finished
 * still reads as `running`. A failed write also removes its temp file, so a crash
 * cannot leave debris for a later directory listing to mistake for a record.
 */
export async function writeAtomic(file: string, text: string): Promise<void> {
  await ensureDir(dirname(file))
  const temp = tempPath(file)
  try {
    await writeFile(temp, text, 'utf8')
    await renameWithRetry(temp, file)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
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
