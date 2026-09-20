/**
 * Structural clustering of a clone-detection CSV.
 *
 * This is a deliberate subset of the Python pipeline's `cluster_report.py`: the
 * node graph, the connected components and the representative pair, but not its
 * body-skeleton comparison, behaviour signatures or risk-signal regexes. Those
 * produce machine screening *hints*, and judging risk from the real source is the
 * session model's job — reproducing a heuristic to compete with it would be
 * duplicated investment. The run records `cluster_path: 'inline'` so a report is
 * always explainable against the pipeline it did not use.
 */
import type { Cluster, ClonePair, ClonePairSide } from '../core/schema.ts'
// The one path spelling, shared with git and the ledger: a local second copy
// would drift from the authorization reconciliation.
import { normalizePath } from '../core/paths.ts'

export const MAX_REPRESENTATIVE_BODY_CHARS = 3000

/** RFC 4180 parsing, quoted fields included: a naive `split(',')` breaks on real reports. */
export function parseCsv(text: string): { header: string[]; rows: string[][] } {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') { field += '"'; index += 1 }
        else quoted = false
      } else field += char
      continue
    }
    if (char === '"') { quoted = true; continue }
    if (char === ',') { row.push(field); field = ''; continue }
    if (char === '\r') continue
    if (char === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue }
    field += char
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row) }
  const header = (rows.shift() ?? []).map(cell => cell.trim().toLowerCase())
  return { header, rows: rows.filter(cells => cells.some(cell => cell.trim() !== '')) }
}

/** Column-keyed records with lowercased keys; the shape every lookup below uses. */
export function recordsOf(header: readonly string[], rows: readonly (readonly string[])[]): Array<Record<string, string>> {
  return rows.map(cells => {
    const record: Record<string, string> = {}
    header.forEach((name, index) => { if (name !== '' && record[name] === undefined) record[name] = (cells[index] ?? '').trim() })
    return record
  })
}

/** First non-empty value among aliases, so one CSV dialect is enough. */
function rowGet(row: Record<string, string>, ...names: string[]): string {
  for (const name of names) {
    const value = row[name]
    if (value !== undefined && value !== '') return value
  }
  return ''
}

interface Node { file: string; func: string; lines: string }
type Pair = ClonePair & { leftNode: Node; rightNode: Node }

function nodeFor(row: Record<string, string>, suffix: '1' | '2'): Node {
  return {
    file: normalizePath(rowGet(row, `file${suffix}`, `path${suffix}`, `file_${suffix}`, `path_${suffix}`)),
    func: rowGet(row, `func${suffix}_name`, `function${suffix}`, `func_${suffix}`, `function_${suffix}`),
    lines: rowGet(row, `lines${suffix}`, `line_range${suffix}`, `range${suffix}`, `lines_${suffix}`),
  }
}

function similarityOf(row: Record<string, string>): number | null {
  const raw = rowGet(
    row, 'similarity', 'combined_similarity', 'sequence_similarity',
    'structure_similarity', 'embedding_similarity', 'gamma_similarity', 'score',
  )
  if (raw === '') return null
  const parsed = Number.parseFloat(raw.endsWith('%') ? raw.slice(0, -1) : raw)
  if (!Number.isFinite(parsed)) return null
  return parsed > 1 ? parsed / 100 : parsed
}

function sideOf(node: Node, body: string): ClonePairSide {
  return {
    file: node.file,
    function: node.func,
    lines: node.lines,
    body: body.length > MAX_REPRESENTATIVE_BODY_CHARS ? body.slice(0, MAX_REPRESENTATIVE_BODY_CHARS) : body,
  }
}

function pairsFrom(records: ReadonlyArray<Record<string, string>>): Pair[] {
  const pairs: Pair[] = []
  records.forEach((row, index) => {
    const leftNode = nodeFor(row, '1')
    const rightNode = nodeFor(row, '2')
    // A row naming fewer than two nodes is not a clone pair; dropping it is the
    // only honest option, since guessing the missing side would invent evidence.
    if (leftNode.file === '' || rightNode.file === '') return
    pairs.push({
      pair_id: rowGet(row, 'pair_id', 'id', 'pairid') || String(index + 1),
      similarity: similarityOf(row),
      detection_method: rowGet(row, 'detection_method', 'method', 'type', 'source'),
      left: sideOf(leftNode, rowGet(row, 'func1_body', 'code1', 'snippet1', 'code_a', 'snippet_a')),
      right: sideOf(rightNode, rowGet(row, 'func2_body', 'code2', 'snippet2', 'code_b', 'snippet_b')),
      leftNode,
      rightNode,
    })
  })
  return pairs
}

const nodeKey = (node: Node): string => `${node.file}\u0000${node.func}\u0000${node.lines}`

/** Union-find over the pair graph: one connected component is one clone family. */
function components(pairs: readonly Pair[]): Pair[][] {
  const parent = new Map<string, string>()
  const find = (key: string): string => {
    let current = parent.get(key) ?? key
    while (current !== (parent.get(current) ?? current)) current = parent.get(current) ?? current
    parent.set(key, current)
    return current
  }
  for (const pair of pairs) {
    for (const node of [pair.leftNode, pair.rightNode]) if (!parent.has(nodeKey(node))) parent.set(nodeKey(node), nodeKey(node))
    const left = find(nodeKey(pair.leftNode))
    const right = find(nodeKey(pair.rightNode))
    if (left !== right) parent.set(right, left)
  }
  const groups = new Map<string, Pair[]>()
  for (const pair of pairs) {
    const root = find(nodeKey(pair.leftNode))
    const group = groups.get(root) ?? []
    group.push(pair)
    groups.set(root, group)
  }
  return [...groups.values()]
}

/** The most similar pair of a family; ties keep the pair that appeared first. */
function representativeOf(pairs: readonly Pair[]): Pair {
  return pairs.reduce((best, candidate) => {
    const bestScore = best.similarity ?? -1
    const candidateScore = candidate.similarity ?? -1
    return candidateScore > bestScore ? candidate : best
  })
}

/** Group CSV records into clone families, in first-appearance order with C-prefixed ids. */
export function clustersFromRecords(records: ReadonlyArray<Record<string, string>>): Cluster[] {
  const pairs = pairsFrom(records)
  return components(pairs).map((group, index) => {
    const representative = representativeOf(group)
    const nodes = new Map<string, Node>()
    for (const pair of group) {
      nodes.set(nodeKey(pair.leftNode), pair.leftNode)
      nodes.set(nodeKey(pair.rightNode), pair.rightNode)
    }
    return {
      id: `C${String(index + 1).padStart(3, '0')}`,
      size: group.length,
      representative: {
        pair_id: representative.pair_id,
        similarity: representative.similarity,
        detection_method: representative.detection_method,
        left: representative.left,
        right: representative.right,
      },
      files: [...new Set([...nodes.values()].map(node => node.file))].sort(),
      functions: [...new Set([...nodes.values()].map(node => node.func).filter(name => name !== ''))].sort(),
    }
  })
}
