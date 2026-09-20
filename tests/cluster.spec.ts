import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { clustersFromRecords, parseCsv, recordsOf, MAX_REPRESENTATIVE_BODY_CHARS } from '../src/detect/cluster.ts'

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sample_func_clone.csv')

async function fixtureClusters() {
  const { header, rows } = parseCsv(await readFile(FIXTURE, 'utf8'))
  return clustersFromRecords(recordsOf(header, rows))
}

describe('parseCsv', () => {
  it('handles quoted fields with commas and escaped quotes', () => {
    const { header, rows } = parseCsv('a,b\n"x,1","he said ""hi"""\n')
    expect(header).toEqual(['a', 'b'])
    expect(rows).toEqual([['x,1', 'he said "hi"']])
  })

  it('tolerates CRLF and a trailing newline', () => {
    const { header, rows } = parseCsv('a,b\r\n1,2\r\n')
    expect(header).toEqual(['a', 'b'])
    expect(rows).toEqual([['1', '2']])
  })
})

describe('clustersFromRecords', () => {
  it('groups pairs into families over the (file, function, lines) node graph', async () => {
    const clusters = await fixtureClusters()
    // p1 and p2 share the node (b.cpp, CalcArea, 30-40), and p4 connects a.cpp to
    // c.cpp, so {a,b,c} is one family and {z,y} is another.
    expect(clusters).toHaveLength(2)
    expect(clusters[0]?.id).toBe('C001')
    expect(clusters[0]?.size).toBe(3)
    expect(clusters[0]?.files).toEqual([
      'module/laws/src/a.cpp', 'module/laws/src/b.cpp', 'module/laws/src/c.cpp',
    ])
    expect(clusters[1]?.files).toEqual(['module/laws/src/y.cpp', 'module/laws/src/z.cpp'])
  })

  it('picks the most similar pair as the representative', async () => {
    const clusters = await fixtureClusters()
    expect(clusters[0]?.representative.pair_id).toBe('p4')
    expect(clusters[0]?.representative.similarity).toBe(0.99)
  })

  it('reads every documented column alias, case-insensitively', async () => {
    const clusters = await fixtureClusters()
    const pair = clusters[0]?.representative
    expect(pair?.left.file).toBe('module/laws/src/a.cpp')
    expect(pair?.left.function).toBe('ComputeArea')
    expect(pair?.left.lines).toBe('10-20')
    expect(pair?.right.function).toBe('AreaHelper')
    expect(pair?.detection_method).toBe('type34')
  })

  it('normalizes windows separators in paths', async () => {
    const clusters = await fixtureClusters()
    expect(clusters[1]?.files.some(file => file.includes('\\'))).toBe(false)
  })

  it('truncates a body excerpt at 3000 characters', () => {
    const long = 'x'.repeat(MAX_REPRESENTATIVE_BODY_CHARS + 500)
    const records = recordsOf(['file1', 'func1_name', 'lines1', 'file2', 'func2_name', 'lines2', 'code1', 'code2'], [
      ['a.cpp', 'f', '1-2', 'b.cpp', 'g', '3-4', long, long],
    ])
    const [cluster] = clustersFromRecords(records)
    expect(cluster?.representative.left.body).toHaveLength(MAX_REPRESENTATIVE_BODY_CHARS)
  })

  it('drops a row that names fewer than two nodes', () => {
    const records = recordsOf(['file1', 'func1_name'], [['a.cpp', 'f']])
    expect(clustersFromRecords(records)).toEqual([])
  })
})
