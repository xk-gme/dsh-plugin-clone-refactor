/** Append-only JSONL: the ledger survives an interrupted run. */
import { appendFile, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { ensureDir } from './artifacts.ts'

export interface JsonlRead<T> {
  records: T[]
  /** 1-based line numbers that were not valid JSON: a torn write is dropped, never guessed. */
  droppedLines: number[]
}

/**
 * Append one record as its own line, creating the file's directory.
 *
 * `JSON.stringify(undefined)` is `undefined`, not a string, so the template below
 * used to write the literal line `undefined` — a durable line no reader can consume,
 * which `readJsonl` then reports as torn. Refusing is the only outcome that keeps
 * every line in the file a JSON record: writing `null` instead would invent a record
 * (a null assessment) that downstream callers would have to learn to distrust.
 */
export async function appendJsonl(file: string, value: unknown): Promise<void> {
  const line = JSON.stringify(value)
  if (line === undefined) {
    throw new Error(`Cannot append a value that does not serialize to JSON: ${file}`)
  }
  await ensureDir(dirname(file))
  await appendFile(file, `${line}\n`, 'utf8')
}

/** Read a JSONL file: blank lines are skipped, malformed lines are reported and dropped. */
export async function readJsonl<T>(file: string): Promise<JsonlRead<T>> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { records: [], droppedLines: [] }
    throw error
  }
  const records: T[] = []
  const droppedLines: number[] = []
  text.split('\n').forEach((line, index) => {
    if (line.trim() === '') return
    try {
      records.push(JSON.parse(line) as T)
    } catch {
      droppedLines.push(index + 1)
    }
  })
  return { records, droppedLines }
}
