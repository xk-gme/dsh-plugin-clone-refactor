/**
 * The documentation contract, checked against the code it documents.
 *
 * A manual cross-check has no second chance: the day a seventh tool is registered
 * or a settings key is added, nothing would go red. Two of the checks can be
 * mechanical, and each fails for one specific, nameable mistake:
 *
 * - a README naming a `clone_*` tool the plugin does not register, or omitting one
 *   it does — the names come from the real registry, never from a list copied here;
 * - a setup doc that no longer documents a settings key `resolveSettings` produces.
 *
 * What stays a human check is the semantic equivalence of `README.md` with
 * `README.zh.md` and of `docs/setup.md` with `docs/setup.zh.md`. The key coverage
 * below is asserted against both setup docs, which is the part of that equivalence
 * that can be stated in a test at all.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { apply, resolveSettings } from '../src/index.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Settings keys that genuinely do not belong in user documentation, each with the
 * reason it is exempt. Empty on purpose: every key `resolveSettings` produces is
 * documented, so nothing needs an exemption today. A key is added here only when
 * it has no operator-facing meaning, and it must carry its reason — deleting an
 * assertion is not how this test is allowed to pass.
 */
const DOC_EXEMPTIONS: Readonly<Record<string, string>> = {}

const cleanups: Array<() => Promise<unknown> | unknown> = []

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

/**
 * The names the plugin actually registers, read from the live tool registry after
 * the real composition root ran. `TOOLS` in `install.spec.ts` covers the six
 * specific names; this is the same truth through `apply`, so a tool the docs
 * mention can only match if the plugin really mounts it.
 */
async function registeredToolNames(): Promise<string[]> {
  const root = await mkdtemp(join(tmpdir(), 'clone-docs-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  apply(ctx, { projectRoot: root, artifactsRoot: join(root, 'runs') })
  return ctx.tools.schemas().map(schema => schema.name).filter(name => name.startsWith('clone_')).sort()
}

/**
 * Every tool-shaped `clone_*` name a document mentions, deduplicated and sorted.
 *
 * The leading boundary matters: `func_clone_base.csv` and
 * `run_gme_clone_detection.py` are file names that happen to contain `clone_`, and
 * neither is a tool. A tool name is only ever written as a whole word.
 */
function mentionedToolNames(text: string): string[] {
  return [...new Set(text.match(/(?<![A-Za-z0-9_])clone_[a-z][a-z0-9_]*/g) ?? [])].sort()
}

/** Every leaf key path of a settings object; an array is a leaf, not a subtree. */
function leafPaths(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [prefix]
  return Object.entries(value as Record<string, unknown>)
    .flatMap(([key, item]) => leafPaths(item, prefix === '' ? key : `${prefix}.${key}`))
}

/**
 * Whether a document names this key as a whole token. A plain `includes` would let
 * `verify.graceMs` count as documented because `verify.graceMsX` contains it — and
 * `verify.steps` would be satisfied by a document that only lists the step fields.
 * Every character that is special in a key path (`.` and the `[]` of a step field)
 * is escaped, and an identifier character may not follow the match.
 */
function documentedIn(text: string, key: string): boolean {
  const pattern = key.replaceAll('.', '\\.').replaceAll('[', '\\[').replaceAll(']', '\\]')
  return new RegExp(`${pattern}(?![A-Za-z0-9_.])`).test(text)
}

/**
 * The configuration-reference section of a setup doc: `## 4.` up to the next
 * heading. The reverse check below is scoped to it deliberately — prose elsewhere
 * legitimately contains dotted names that are file paths (`docs/setup.md`), package
 * files (`cordis.patch.yml`) or hosts (`registry.npmjs.org`), and none of those is
 * a settings key. Both setup docs number this section `## 4.`.
 */
function configurationSection(text: string): string {
  const start = text.search(/^## 4\./m)
  if (start === -1) return ''
  const rest = text.slice(start + 1)
  const end = rest.search(/^## /m)
  return end === -1 ? rest : rest.slice(0, end)
}

describe('the tool table in the two READMEs', () => {
  it('names exactly the clone_* tools the plugin registers, in English and in Chinese', async () => {
    const registered = await registeredToolNames()
    // Guards the two set comparisons against passing vacuously: a composition root
    // that registered nothing would make "no unexpected name" trivially true.
    expect(registered).toHaveLength(6)
    for (const file of ['README.md', 'README.zh.md']) {
      const named = mentionedToolNames(await readFile(join(ROOT, file), 'utf8'))
      expect(named, `${file} must name exactly the registered clone_* tools`).toEqual(registered)
    }
  })
})

describe('the configuration reference in the two setup docs', () => {
  it('documents every settings leaf key resolveSettings produces', async () => {
    const required = leafPaths(resolveSettings({}).settings)
    // `verify.steps` is an array, so the walk above stops at it. The fields of one
    // step are read off a step the real resolver just normalized, so this half of
    // the requirement follows the code exactly as the other half does.
    const probe = resolveSettings({
      verify: { steps: [{ name: 'probe', phase: 'build', command: 'true', required: true, always: true, timeoutMs: 1000 }] },
    }).settings.verify.steps[0]
    const stepFields = Object.keys(probe ?? {}).map(field => `verify.steps[].${field}`)
    // The six fields `VerifyStep` normalizes. A field that stops being produced
    // shrinks this list and must be noticed here rather than quietly dropping out
    // of the documentation requirement.
    expect(stepFields).toHaveLength(6)
    // An exemption without a reason is not an exemption.
    for (const [key, reason] of Object.entries(DOC_EXEMPTIONS)) {
      expect(reason.trim(), `${key} is exempt without a stated reason`).not.toBe('')
    }
    const documented = [...required, ...stepFields].filter(path => DOC_EXEMPTIONS[path] === undefined)
    // Guards the coverage loop against an empty requirement list.
    expect(required.length).toBeGreaterThan(20)
    for (const file of ['docs/setup.md', 'docs/setup.zh.md']) {
      const text = await readFile(join(ROOT, file), 'utf8')
      const missing = documented.filter(path => !documentedIn(text, path))
      expect(missing, `${file} does not document: ${missing.join(', ')}`).toEqual([])
    }
    // The reverse direction, which is the one that hides dead configuration: a table
    // presenting a key as real that `resolveSettings` does not produce at all. This is
    // the check that would have caught `workdir.returnToOriginalBranch` on its own —
    // parsed, normalized, documented in the spec and both setup docs, and read by no
    // code path in the release. Every row whose first cell is a single backticked key
    // is compared against what the resolver actually produces.
    const known = new Set<string>([...required, ...stepFields])
    for (const file of ['docs/setup.md', 'docs/setup.zh.md']) {
      const section = configurationSection(await readFile(join(ROOT, file), 'utf8'))
      // A section this check cannot locate would make the assertion below vacuous.
      expect(section.length, `${file} has no configuration-reference section to check`).toBeGreaterThan(0)
      const claimed = [...new Set(section.split('\n')
        .map(line => /^\|\s*`([A-Za-z][A-Za-z0-9_.[\]]*)`\s*\|/.exec(line)?.[1])
        .filter((key): key is string => key !== undefined))]
        .filter(key => !known.has(key))
      expect(claimed, `${file} documents keys resolveSettings() does not produce: ${claimed.join(', ')}`).toEqual([])
    }
  })
})

describe('the package manifest', () => {
  it('ships the runtime, the patch layer and the documents, and never the internal plan', async () => {
    const manifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as { files?: string[] }
    const files = manifest.files ?? []
    // The packed list itself is `tests/pack-smoke.mjs`'s job; this pins the manifest
    // entries that list is produced from, including the exclusion of the internal
    // design docs — a published plan is a documentation defect of its own.
    for (const entry of ['lib', 'cordis.patch.yml', 'docs', '!docs/superpowers', 'README.md', 'README.zh.md', 'LICENSE']) {
      expect(files, `package.json files must carry ${entry}`).toContain(entry)
    }
  })
})
