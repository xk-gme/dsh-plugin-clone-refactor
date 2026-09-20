/** The zero-dependency detector: read a `func_clone_<module>.csv` that already exists. */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { clustersFromRecords, hasCloneColumns, parseCsv, recordsOf } from './cluster.ts'
import type { CloneDetector, DetectInput, DetectResult } from './provider.ts'

/**
 * Resolve which CSV this call reads: the caller's explicit `csv_path` first, then
 * the configured `detection.csvPath`. The caller's `module` is deliberately NOT
 * consulted — with the csv provider a module name would resolve to a nonexistent
 * file next to the process working directory, and silently scanning the wrong
 * report is worse than refusing to scan at all.
 */
export function resolveCsvPath(input: DetectInput): string {
  const explicit = input.csvPath.trim()
  if (explicit !== '') return resolve(explicit)
  if (input.settings.detection.csvPath !== '') return resolve(input.settings.detection.csvPath)
  throw new Error('No CSV to scan: pass csv_path, or set detection.csvPath in the profile row')
}

/**
 * Refuse a header naming no clone-pair column family.
 *
 * `clustersFromRecords` silently drops every row it cannot place, so a CSV that is
 * not a clone report at all used to come back as `clusters: []` — byte-identical to
 * "this module genuinely has no clones", with the run then closing on zero clusters.
 * That is the same failure `resolveCsvPath` refuses to make for an unresolvable
 * path, so it is refused here too. A well-formed header with no rows is a different
 * thing entirely and still returns zero clusters.
 */
function assertCloneReport(file: string, header: readonly string[]): void {
  if (hasCloneColumns(header)) return
  throw new Error(
    `${file} is not a clone report this detector understands: its header (${header.join(', ') || 'empty'}) `
    + 'names no file1/file2 column pair. Expected columns such as file1 and file2, or the path1/path2 aliases.',
  )
}

export function csvDetector(): CloneDetector {
  return {
    id: 'csv',
    async detect(input: DetectInput): Promise<DetectResult> {
      const file = resolveCsvPath(input)
      const text = await readFile(file, 'utf8')
      const { header, rows } = parseCsv(text)
      assertCloneReport(file, header)
      const clusters = clustersFromRecords(recordsOf(header, rows))
      return { clusters, provider: 'csv', artifacts: [file] }
    },
  }
}
