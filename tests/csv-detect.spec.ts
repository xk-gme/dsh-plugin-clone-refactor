import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveSettings } from '../src/config.ts'
import { runPaths } from '../src/core/artifacts.ts'
import { csvDetector } from '../src/detect/csv.ts'
import { fakeRunner } from './fixtures/fake-runner.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()!() })

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'clone-csv-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** One detect call against a CSV this test just wrote. */
async function detect(text: string): Promise<Awaited<ReturnType<ReturnType<typeof csvDetector>['detect']>>> {
  const dir = await scratch()
  const file = join(dir, 'func_clone_base.csv')
  await writeFile(file, text, 'utf8')
  return await csvDetector().detect({
    settings: resolveSettings({ projectRoot: 'D:/gme' }).settings,
    runner: fakeRunner([]),
    paths: runPaths(dir, 'r1'),
    module: '',
    csvPath: file,
    signal: undefined,
  })
}

describe('csvDetector', () => {
  it('reads a recognized header with rows into clusters', async () => {
    const result = await detect(
      'pair_id,file1,func1_name,lines1,file2,func2_name,lines2,similarity\n'
      + 'p1,a.cpp,f,1-2,b.cpp,g,3-4,0.9\n',
    )
    expect(result.provider).toBe('csv')
    expect(result.clusters).toHaveLength(1)
    expect(result.clusters[0]?.files).toEqual(['a.cpp', 'b.cpp'])
  })

  it('returns zero clusters for a recognized header with no rows', async () => {
    // A well-formed report with nothing in it is a genuine "this module has no
    // clones", and refusing it would be as wrong as the silence it replaces.
    const result = await detect('pair_id,file1,func1_name,lines1,file2,func2_name,lines2,similarity\n')
    expect(result.clusters).toEqual([])
  })

  it('refuses a header that names no clone column family', async () => {
    // `clustersFromRecords` drops every row it cannot place, so an unrelated CSV
    // used to come back as `clusters: []` — indistinguishable from "no clones" and
    // reported as such. The same file's own rule for an unresolvable path applies:
    // silently scanning the wrong report is worse than refusing to scan at all.
    await expect(detect('module,score,lines\nbase,0.9,120\n')).rejects.toThrow(/not a clone report/)
  })

  it('refuses a header that names only one side of a pair', async () => {
    // One `file1` alias and no `file2` alias can never yield a pair, so every row
    // would be dropped and the run would close reporting zero clusters.
    await expect(detect('pair_id,file1,func1_name,similarity\np1,a.cpp,f,0.9\n'))
      .rejects.toThrow(/file2/)
  })

  it('names the file it refused, so the operator knows which report it read', async () => {
    const error = await detect('a,b\n1,2\n').then(() => undefined, (caught: unknown) => caught as Error)
    expect(error?.message).toContain('func_clone_base.csv')
    expect(error?.message).toContain('file1')
  })
})
