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
import { apply, guidanceText, resolveSettings } from '../src/index.ts'
import { runPaths } from '../src/core/artifacts.ts'
import { startJob } from '../src/core/jobs.ts'
import { writeReport } from '../src/report/report.ts'

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

/**
 * A file name, not a key path: the section legitimately writes
 * `run_gme_clone_detection.py` and `report.md`, and both are dotted backticked
 * tokens that name no settings key. Only extensions the docs actually use are
 * excluded, so `workdir.returnToOriginalBranch` — the dead key this check exists
 * for — still counts as a key path.
 */
const FILE_EXTENSIONS = ['py', 'md', 'json', 'jsonl', 'csv', 'yml', 'yaml', 'ts', 'js', 'txt', 'log']

function looksLikeAFileName(token: string): boolean {
  return FILE_EXTENSIONS.some(extension => token.endsWith(`.${extension}`))
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

  it('keeps one row per tool in each README table, not merely a mention in prose', async () => {
    // The whole-document scan above cannot see a DELETED row: the name survives in
    // that README's prose, so the file still names every tool. A Tools table that
    // lost a row is exactly the drift this contract exists to catch, so the row set
    // is compared separately.
    const registered = await registeredToolNames()
    for (const file of ['README.md', 'README.zh.md']) {
      const text = await readFile(join(ROOT, file), 'utf8')
      const rows = [...new Set(text.split('\n')
        .map(line => /^\|\s*`(clone_[a-z][a-z0-9_]*)`\s*\|/.exec(line)?.[1])
        .filter((name): name is string => name !== undefined))]
        .sort()
      // A row scan that matched nothing must fail loudly rather than prove the
      // absence of unexpected rows.
      expect(rows.length, `${file} has no clone_* tool table rows at all`).toBeGreaterThan(0)
      expect(rows, `${file}'s tool table must have one row per registered tool`).toEqual(registered)
    }
  })
})

describe('the model-facing guidance', () => {
  it('does not overstate the authorization cap as one patch per run', async () => {
    // README.md, README.zh.md, docs/setup.md and docs/setup.zh.md were all corrected
    // for this: `authorization.maxClusters` caps LIVE authorizations, and retracting
    // a verdict frees a slot. The numbered setup steps are the branch a model reads
    // when the plugin is not configured yet, and it says the same thing.
    const { settings } = resolveSettings({})
    const text = guidanceText(settings, false)
    expect(text).not.toMatch(/one authorized P0 patch per run/i)
    expect(text).toMatch(/LIVE/)
    expect(text).toMatch(/retracting a verdict frees a slot/i)
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
    // The shape of a configuration table row. The counts below are what the two
    // docs' tables are supposed to have (26 keys + 6 step fields); a positive control
    // is what keeps "no row matched" from passing as "no dead key found".
    const rowShape = /^\|\s*`([A-Za-z][A-Za-z0-9_.[\]]*)`\s*\|/
    const expectedRows = known.size
    for (const file of ['docs/setup.md', 'docs/setup.zh.md']) {
      const section = configurationSection(await readFile(join(ROOT, file), 'utf8'))
      // A section this check cannot locate would make the assertion below vacuous.
      expect(section.length, `${file} has no configuration-reference section to check`).toBeGreaterThan(0)
      const candidateRows = section.split('\n')
        .map(line => rowShape.exec(line)?.[1])
        .filter((key): key is string => key !== undefined)
      // The reverse direction, over the rows just counted: the set is what makes a
      // candidate row's key have to be real. This runs before the count control so a
      // dead key is reported as the dead key it is, not merely as an extra row.
      const claimed = candidateRows.filter(key => !known.has(key))
      expect(claimed, `${file} documents keys resolveSettings() does not produce: ${claimed.join(', ')}`).toEqual([])
      // A positive control, not a threshold: the tables of both docs hold exactly one
      // row per settings key, so a mutation that removes rows, or a section that
      // stops parsing, fails here instead of silently matching nothing.
      expect(candidateRows.length, `${file}: the configuration tables must have one row per settings key`).toBe(expectedRows)
      expect(new Set(candidateRows).size, `${file}: a configuration table row is duplicated`).toBe(expectedRows)
      // The same key written as prose rather than a table row still names a
      // configuration key, so a DOTTED backticked token anywhere in the section must
      // be a table row (or a known key). A plain single-word token is deliberately
      // out of scope: the section legitimately writes `csv`, `ok`, `zh`, `none` and
      // step phases in its prose, and those are not key paths.
      const rows = new Set(candidateRows)
      const stray = [...new Set([...section.matchAll(/`([A-Za-z][A-Za-z0-9_]*\.[A-Za-z0-9_.[\]]*)`/g)]
        .map(match => match[1] as string))]
        .filter(key => !rows.has(key) && !known.has(key) && !looksLikeAFileName(key))
      expect(stray, `${file} mentions dotted keys outside its configuration tables: ${stray.join(', ')}`).toEqual([])
    }
  })
})

describe('the clone_check row in the two setup docs', () => {
  it('names the record fields `clone_check` with what: status really returns', async () => {
    // The row described the newest job "plus any job records it could not read" without
    // naming the fields, so when `clone_check` began returning `unreadable_attempts` as
    // well — the verification records the same poll skips and names — the documented
    // result was quietly missing it. Both docs carry the row; both have to say so.
    for (const file of ['docs/setup.md', 'docs/setup.zh.md']) {
      const row = (await readFile(join(ROOT, file), 'utf8')).split('\n')
        .find(line => /^\|\s*2\s*\|\s*`clone_check`\s*\|/.test(line)) ?? ''
      expect(row, `${file} has no clone_check row`).not.toBe('')
      // The newer field first: this is the one the row did not describe at all.
      expect(row, `${file}'s clone_check row must name unreadable_attempts`).toContain('unreadable_attempts')
      // And the row's older half is about job records it could not read, which the
      // result names too — prose that says "some records could not be read" without
      // the field is how the attempts half went missing in the first place.
      expect(row, `${file}'s clone_check row must name unreadable_jobs`).toContain('unreadable_jobs')
      // The third durable record the same poll skips and names: the scan revision
      // pointer, whose damage would otherwise have failed the poll outright.
      expect(row, `${file}'s clone_check row must name unreadable_revision_pointer`).toContain('unreadable_revision_pointer')
    }
  })
})

describe('the artifact field lists in the two setup docs', () => {
  /**
   * The section-6 row that describes one artifact, or `''` when the doc has none —
   * and an empty string then fails the assertion below instead of matching nothing.
   */
  function artifactRow(text: string, name: string): string {
    return text.split('\n').find(line => new RegExp(`^\\|\\s*\\\`${name.replaceAll('/', '\\/')}\\\`\\s*\\|`).test(line)) ?? ''
  }

  /**
   * The fields a row lists, and only the fields: a row also names a tool
   * (`clone_check`) and a file (`jobs/<job_id>.json`), so a backticked token that is
   * not an identifier, or that is a `clone_*` tool name, is not a field. Values are
   * written as plain words in these two rows precisely so this stays exact.
   */
  function documentedFields(row: string): string[] {
    return [...new Set([...row.matchAll(/`([a-z_][a-z0-9_]*)`/g)].map(match => match[1] as string))]
      .filter(name => !name.startsWith('clone_'))
      .sort()
  }

  it('names exactly the fields summary.json and a job record really carry', async () => {
    // Read from the ARTIFACTS, not from the interfaces: a hand-written list cannot
    // drift from a file the code actually wrote, which is what these two doc lists
    // describe. `writeReport` needs no clusters to produce a summary, so the fixture
    // is minimal and cannot itself become the thing that drifts.
    const root = await mkdtemp(join(tmpdir(), 'clone-docs-artifacts-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const pathsOfRun = runPaths(root, 'run-1')
    await writeReport(pathsOfRun, {
      run: {
        run_id: 'run-1', project_root: 'D:/gme', baseline: { head: 'abc123', branch: 'main', dirty: [] },
        branch: 'clone-refactor/run-1', original_branch: 'main', detection_provider: 'csv', cluster_path: 'inline',
        created_at: '2026-09-20T00:00:00.000Z', updated_at: '2026-09-20T00:00:00.000Z',
        settings: resolveSettings({}).settings,
      },
      clusters: [], assessments: new Map(), patches: [], verify: [],
      // The submit gate's inputs for the newest attempt: this run has none, so
      // `verify_ok` is false rather than unstated — and there is no patch for an audit
      // to cover, so the coverage half of "nothing patched is unverified" is vacuous.
      newestAttempt: undefined, verifyJob: undefined, audit: undefined, patchesCovered: false,
      job: undefined,
      droppedLines: [], unauthorized: [], resolvedUnauthorized: [],
      unreadableRecords: [], missingReconcileAttempt: undefined,
      notes: '', allowPartial: false, language: 'zh',
    })
    const summaryFields = Object.keys(JSON.parse(await readFile(pathsOfRun.summaryJson, 'utf8')) as object).sort()
    // BOTH job shapes, because one row documents both. Comparing the row against a
    // SCAN record alone made the truthful field list fail: a scan writes no `attempt`,
    // but every VERIFY record now carries the attempt it settled, so the row was left
    // describing only half the records it names. The union is what the row has to
    // document, and `attempt` is written as verify-only so a reader knows which shape
    // carries it.
    const scanJobFields = Object.keys(await startJob(pathsOfRun, 'run-1', 'scan', new Date('2026-09-20T01:00:00Z'))).sort()
    const verifyJobFields = Object.keys(await startJob(pathsOfRun, 'run-1', 'verify', new Date('2026-09-20T02:00:00Z'), 1)).sort()
    const jobFields = [...new Set([...scanJobFields, ...verifyJobFields])].sort()
    // Positive controls: an artifact that suddenly carried two fields would make the
    // comparisons below trivially true, so the lists have to stay the size they are.
    // The verify shape is pinned as the scan shape plus exactly the attempt, so the
    // union cannot silently collapse back to one shape.
    expect(summaryFields.length).toBeGreaterThan(15)
    expect(scanJobFields.length).toBeGreaterThan(5)
    expect(verifyJobFields).toEqual([...scanJobFields, 'attempt'].sort())
    expect(jobFields).toEqual(verifyJobFields)

    for (const file of ['docs/setup.md', 'docs/setup.zh.md']) {
      const text = await readFile(join(ROOT, file), 'utf8')
      const summaryRow = artifactRow(text, 'summary.json')
      expect(summaryRow, `${file} has no summary.json row`).not.toBe('')
      expect(documentedFields(summaryRow), `${file}'s summary.json field list`).toEqual(summaryFields)
      const jobRow = artifactRow(text, 'jobs/<job_id>.json')
      expect(jobRow, `${file} has no job-record row`).not.toBe('')
      expect(documentedFields(jobRow), `${file}'s job-record field list`).toEqual(jobFields)
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
