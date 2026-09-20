/** Append-only JSONL: the ledger survives an interrupted run. */
import { appendFile, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { ensureDir } from './artifacts.ts'

export interface JsonlRead<T> {
  records: T[]
  /** 1-based line numbers that were not valid JSON: a torn write is dropped, never guessed. */
  droppedLines: number[]
}

/** Append one record as its own line, creating the file's directory. */
export async function appendJsonl(file: string, value: unknown): Promise<void> {
  await ensureDir(dirname(file))
  await appendFile(file, `${JSON.stringify(value)}\n`, 'utf8')
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
