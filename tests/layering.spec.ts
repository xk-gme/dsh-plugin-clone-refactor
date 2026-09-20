/**
 * The dependency rule, enforced mechanically.
 *
 * The architecture is `tools → core → {detect, verify, git, submit, report}`, and
 * the final whole-branch review amended it to permit exactly ONE `core →
 * capability` edge: `src/core/run.ts` imports `readBaseline`, `createBranch` and
 * `Baseline` from `src/git/baseline.ts`, and nothing else may. What keeps the graph
 * acyclic is that `src/git/baseline.ts` imports `core/command.ts` with `import
 * type` only.
 *
 * The rule lived only in a plan document, so nothing went red when a second edge
 * was added. These three checks are the mechanical guard: a new `core → capability`
 * import, a fourth name pulled out of `git/baseline.ts` into `core/run.ts`, or a
 * value import of `core/command.ts` that would make the cycle real.
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'src')

/**
 * The capability directories, as a `src/`-relative first segment. `core` and the
 * composition root (`index.ts`) are the other side of the rule.
 */
const CAPABILITIES = new Set(['detect', 'verify', 'git', 'submit', 'report'])

/** The one sanctioned exception, spelled out: file → module → names. */
const ALLOWED_CORE_EDGE = {
  file: 'core/run.ts',
  module: 'git/baseline.ts',
  names: ['readBaseline', 'createBranch', 'Baseline'] as const,
}

/** Every `.ts` file under `src/`, as forward-slash paths relative to `src/`. */
function sourceFiles(dir = SRC): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(full)
    return entry.isFile() && entry.name.endsWith('.ts') ? [relative(SRC, full).replaceAll('\\', '/')] : []
  })
}

/**
 * The module named by one import statement, resolved relative to `src/`.
 *
 * The scanner matches the statement's opening line and reads the module specifier
 * off it: every import in this codebase is single-line by construction, and an
 * import whose specifier sits on its own line would simply not be seen here — it is
 * still typechecked, and no edge of the graph is written that way. A form this
 * regex cannot see is `export ... from`, which the architecture does not use.
 */
const IMPORT = /^\s*import\s+(?:(type)\s+)?([\s\S]*?)\s*from\s*['"]([^'"]+)['"]/gm

interface ImportEdge {
  /** The importing file, relative to `src/`. */
  from: string
  /** The imported module, relative to `src/`, or `undefined` for a package import. */
  to: string | undefined
  /** The raw specifier, for failure messages. */
  specifier: string
  /** `true` for `import type`. */
  typeOnly: boolean
  /** The names the statement binds, normalized. */
  names: string[]
}

/**
 * The names an import clause binds, whatever the clause writes:
 * `import { a, b as c }` → `a`, `b`; `import x` → `x`;
 * `import * as ns` → `ns`; `import d, { n }` → `d`, `n`.
 */
function boundNames(clause: string): string[] {
  const names: string[] = []
  const braces = /\{([^}]*)\}/.exec(clause)
  const outside = braces === null ? clause : clause.replace(braces[0], '')
  for (const part of outside.split(',')) {
    const name = part.trim().replace(/^\*\s*as\s+/, '')
    if (name !== '') names.push(name)
  }
  for (const part of (braces?.[1] ?? '').split(',')) {
    // `{ type Baseline }` and `{ a as b }` both bind one name; the inline `type`
    // marker is not part of it.
    const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]?.trim() ?? ''
    if (name !== '') names.push(name)
  }
  return names
}

function importsOf(file: string): ImportEdge[] {
  const text = readFileSync(join(SRC, file), 'utf8')
  const edges: ImportEdge[] = []
  for (const match of text.matchAll(IMPORT)) {
    const specifier = match[3] ?? ''
    const clause = match[2] ?? ''
    edges.push({
      from: file,
      to: specifier.startsWith('.') ? resolve(dirname(join(SRC, file)), specifier).replaceAll('\\', '/').replace(`${resolve(SRC).replaceAll('\\', '/')}/`, '') : undefined,
      specifier,
      typeOnly: match[1] === 'type',
      names: boundNames(clause),
    })
  }
  return edges
}

describe('the amended dependency rule', () => {
  it('has exactly one core → capability import, and it is the sanctioned one', () => {
    const found = sourceFiles()
      .filter(file => file.startsWith('core/'))
      .flatMap(importsOf)
      .filter(edge => edge.to !== undefined && CAPABILITIES.has(edge.to.split('/')[0] ?? ''))
    // Not vacuous: the sanctioned edge is the one the rule exists FOR, so finding
    // zero edges means the scanner stopped reading imports, not that the rule holds.
    expect(found.map(edge => `${edge.from} → ${edge.to}`)).toEqual([
      `${ALLOWED_CORE_EDGE.file} → ${ALLOWED_CORE_EDGE.module}`,
    ])
  })

  it('lets core/run.ts take only readBaseline, createBranch and Baseline from git/baseline.ts', () => {
    const edges = importsOf(ALLOWED_CORE_EDGE.file)
      .filter(edge => edge.to === ALLOWED_CORE_EDGE.module)
    expect(edges).toHaveLength(1)
    const names = [...(edges[0]?.names ?? [])].sort()
    expect(names).toEqual([...ALLOWED_CORE_EDGE.names].sort())
    // `import type` would satisfy the name list while erasing the runtime edge the
    // exception exists to name, so the form is pinned too.
    expect(edges[0]?.typeOnly).toBe(false)
  })

  it('keeps the git/baseline.ts import of core/command.ts type-only, which is what makes the graph acyclic', () => {
    const edges = importsOf('git/baseline.ts').filter(edge => edge.to === 'core/command.ts')
    expect(edges).toHaveLength(1)
    expect(edges[0]?.typeOnly, 'import type { CommandRunner } from ...').toBe(true)
    // A type import that also pulled in a value (the runner has `EXIT_NOT_RUN`) would
    // make `core/run.ts → git/baseline.ts → core/command.ts` a real cycle.
    expect(edges[0]?.names).toEqual(['CommandResult', 'CommandRunner'])
  })
})
