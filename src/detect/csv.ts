/** The zero-dependency detector: read a `func_clone_<module>.csv` that already exists. */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { clustersFromRecords, parseCsv, recordsOf } from './cluster.ts'
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

export function csvDetector(): CloneDetector {
  return {
    id: 'csv',
    async detect(input: DetectInput): Promise<DetectResult> {
      const file = resolveCsvPath(input)
      const text = await readFile(file, 'utf8')
      const { header, rows } = parseCsv(text)
      const clusters = clustersFromRecords(recordsOf(header, rows))
      return { clusters, provider: 'csv', artifacts: [file] }
    },
  }
}
