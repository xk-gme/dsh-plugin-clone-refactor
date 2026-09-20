import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertInsideRoot, defaultArtifactsRoot, dshHome, newRunId, readJson, runPaths, writeAtomic,
} from '../src/core/artifacts.ts'
import { appendJsonl, readJsonl } from '../src/core/jsonl.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()!() })

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'clone-artifacts-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

describe('run paths', () => {
  it('derives every artifact path from the run id', () => {
    const paths = runPaths('D:/runs', 'run-1')
    expect(paths.dir.replaceAll('\\', '/')).toBe('D:/runs/run-1')
    expect(paths.clusters.endsWith('clusters.jsonl')).toBe(true)
    expect(paths.assessments.endsWith('assessments.jsonl')).toBe(true)
    expect(paths.patches.endsWith('patches.json')).toBe(true)
    expect(paths.runJson.endsWith('run.json')).toBe(true)
    expect(paths.reportMd.endsWith('report.md')).toBe(true)
  })

  it('refuses a run id that escapes the artifacts root', () => {
    expect(() => assertInsideRoot('D:/runs', '../evil')).toThrow(/escapes/)
    expect(() => assertInsideRoot('D:/runs', 'a/b')).toThrow(/escapes/)
    expect(() => assertInsideRoot('D:/runs', '..')).toThrow(/escapes/)
    expect(() => assertInsideRoot('D:/runs', 'ok-run.1')).not.toThrow()
  })

  it('defaults the artifacts root under DSH home', () => {
    expect(dshHome({ DSH_HOME: 'D:/home' })).toBe('D:/home')
    expect(defaultArtifactsRoot({ DSH_HOME: 'D:/home' }).replaceAll('\\', '/'))
      .toBe('D:/home/gme-clone-refactor/runs')
  })

  it('builds a sortable, unique run id', () => {
    const id = newRunId(new Date('2026-09-20T01:02:03Z'), () => 0.5)
    expect(id).toBe('20260920-010203-8000')
    expect(newRunId()).not.toBe(newRunId())
  })
})

describe('atomic writes and JSONL', () => {
  it('writes through a temp file and leaves no temp behind', async () => {
    const root = await tempRoot()
    const file = join(root, 'nested', 'run.json')
    await writeAtomic(file, '{"a":1}')
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ a: 1 })
    await expect(readFile(`${file}.tmp`, 'utf8')).rejects.toThrow()
  })

  it('reads a missing JSON file as undefined and rejects malformed JSON', async () => {
    const root = await tempRoot()
    expect(await readJson(join(root, 'absent.json'))).toBeUndefined()
    await writeAtomic(join(root, 'bad.json'), '{oops')
    await expect(readJson(join(root, 'bad.json'))).rejects.toThrow()
  })

  it('appends one record per line and reports torn lines instead of guessing', async () => {
    const root = await tempRoot()
    const file = join(root, 'clusters.jsonl')
    await appendJsonl(file, { id: 'C001' })
    await appendJsonl(file, { id: 'C002' })
    const read = await readJsonl<{ id: string }>(file)
    expect(read.records.map(item => item.id)).toEqual(['C001', 'C002'])
    expect(read.droppedLines).toEqual([])
    // A torn write is dropped and reported, never repaired silently.
    await writeAtomic(file, '{"id":"C001"}\n{broken\n\n{"id":"C003"}\n')
    const torn = await readJsonl<{ id: string }>(file)
    expect(torn.records.map(item => item.id)).toEqual(['C001', 'C003'])
    expect(torn.droppedLines).toEqual([2])
  })
})
