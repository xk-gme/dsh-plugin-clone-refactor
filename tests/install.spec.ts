/**
 * The install contract of this package, checked against the real artefacts: the
 * committed `cordis.patch.yml`, composed through the include's own patch engine
 * and mounted into a real Cordis Loader tree.
 *
 * Two things can break a marketplace install and both are covered here: a
 * manifest/row drift, and the boot hazard this bundle exists to avoid — an
 * inserted row whose `projectRoot` is unset must stay inert (no tools, one
 * warning, setup guidance for the model) instead of failing the plugin tree
 * ("dsh: 1 entry did not activate").
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import jsYaml from 'js-yaml'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { applyEntryPatches, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt, { type PromptSection } from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import * as Workflow from '../src/index.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE_NAME = 'dsh-gme-clone-refactor'
const ROW_ID = 'gme-clone-refactor'
const ROOT_ENV = 'GME_CLONE_REFACTOR_ROOT'
/** The surface a configured install must publish. */
const TOOLS = ['clone_scan', 'clone_check', 'clone_assess', 'clone_verify', 'clone_submit', 'clone_report']

const cleanups: Array<() => Promise<unknown> | unknown> = []
const savedEnv = new Map<string, string | undefined>()

afterEach(async () => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  savedEnv.clear()
  while (cleanups.length) await cleanups.pop()!()
})

function setEnv(key: string, value: string | undefined): void {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key])
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

/** The include's YAML dialect, rebuilt so the committed patch parses here. */
const JsExpr = new jsYaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data: unknown) => typeof data === 'string',
  construct: (data: string) => ({ __jsExpr: data }),
})
const schema = jsYaml.JSON_SCHEMA.extend(JsExpr)

async function patchText(): Promise<string> {
  return await readFile(join(ROOT, 'cordis.patch.yml'), 'utf8')
}

async function patchRows(): Promise<PatchOptions[]> {
  const parsed = jsYaml.load(await patchText(), { schema })
  if (!Array.isArray(parsed)) throw new Error('the bundle patch must be a top-level array')
  return parsed as PatchOptions[]
}

async function insertedRow(): Promise<EntryOptions> {
  const entries = applyEntryPatches([], await patchRows(), () => {})
  expect(entries).toHaveLength(1)
  return entries[0]!
}

async function mount(row: EntryOptions): Promise<{ ctx: Context; imported: string[]; sections: PromptSection[]; warnings: string[] }> {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(Loader)
  const sections: PromptSection[] = []
  const original = ctx.systemPrompt.section.bind(ctx.systemPrompt)
  ctx.systemPrompt.section = ((section: PromptSection) => {
    sections.push(section)
    return original(section)
  }) as typeof ctx.systemPrompt.section
  const warnings: string[] = []
  // `ctx.logger.buffer` is fed by an exporter that a bare `new Context()` never
  // installs, so the warning the contract promises is captured at the call site.
  const logger = ctx.logger as unknown as { warn: (...args: unknown[]) => void }
  const originalWarn = logger.warn.bind(logger)
  logger.warn = (...args: unknown[]) => {
    warnings.push(args.map(value => String(value)).join(' '))
    originalWarn(...args)
  }
  const imported: string[] = []
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string): Promise<unknown> {
      imported.push(specifier)
      if (specifier === PACKAGE_NAME) return Workflow
      throw new Error(`Unexpected Loader module ${specifier}`)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create(row)
  await ctx.loader.await()
  return { ctx, imported, sections, warnings }
}

function call(ctx: Context, name: string, args: unknown) {
  return ctx.tools.execute({ name, arguments: args, signal: new AbortController().signal, callId: ToolCallId(`clone-install-${name}`) })
}

describe('the committed dsh.bundle.patch', () => {
  it('inserts exactly one row whose id and module name are the published package', async () => {
    const manifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as {
      name: string
      files?: string[]
      dsh?: { bundle?: { patch?: string } }
    }
    const row = await insertedRow()
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(manifest.files).toContain('cordis.patch.yml')
    expect(manifest.name).toBe(PACKAGE_NAME)
    expect(row.id).toBe(ROW_ID)
    expect(row.name).toBe(manifest.name)
  })

  it('carries the deployment paths as expressions, never as machine paths', async () => {
    const row = await insertedRow()
    expect((row.config as Record<string, unknown>).projectRoot).toEqual({
      __jsExpr: `process.env.${ROOT_ENV} ?? ''`,
    })
    expect(row.disabled).toBeUndefined()
    const values = (await patchText())
      .split('\n')
      .filter(line => !line.trimStart().startsWith('#'))
      .join('\n')
    expect(values).not.toMatch(/[A-Za-z]:[\\/]/)
    expect(values).not.toMatch(/\/home\/|\/Users\//)
  })
})

describe('a freshly installed, unconfigured row', () => {
  it('mounts the plugin, registers no tools, and tells the model how to configure it', async () => {
    setEnv(ROOT_ENV, undefined)
    const { ctx, imported, sections, warnings } = await mount(await insertedRow())
    expect(imported).toEqual([PACKAGE_NAME])
    // "No tools" is the contract, so the call must miss the registry entirely
    // rather than reach a clone-refactor body that happens to refuse this input.
    const checked = await call(ctx, 'clone_check', { run_id: 'r1', what: 'status' })
    expect(checked.isError).toBe(true)
    expect(JSON.stringify(checked)).toMatch(/UNKNOWN_TOOL/)
    // ... and exactly one warning: an inert install is one line of log noise, not
    // a silent no-op and not a flood.
    expect(warnings).toEqual([expect.stringContaining('projectRoot is not configured')])
    expect(sections).toHaveLength(1)
    expect(sections[0]?.name).toBe(ROW_ID)
    expect(sections[0]?.text).toMatch(/NOT available/)
    expect(sections[0]?.text).toContain(ROOT_ENV)
    expect(sections[0]?.text).toContain('- id: gme-clone-refactor')
  })
})

describe('a row pointed at a configured work tree', () => {
  it('activates and registers all six tools', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clone-install-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    setEnv(ROOT_ENV, root)
    const row = await insertedRow()
    ;(row.config as Record<string, unknown>).artifactsRoot = join(root, 'runs')
    const { ctx, imported } = await mount(row)
    expect(imported).toEqual([PACKAGE_NAME])
    // The registry itself, so the name of this test is what its body checks.
    expect(TOOLS.filter(tool => ctx.tools.get(tool) !== undefined)).toEqual(TOOLS)
    // `clone_check` on a run that does not exist yet creates nothing and fails
    // with the tool's own guidance, which proves the tool is registered at all.
    const checked = await call(ctx, 'clone_check', { run_id: 'r1', what: 'status' })
    expect(checked.isError).toBe(true)
    expect(JSON.stringify(checked)).toMatch(/Call clone_scan first/)
    // ... whereas an unconfigured row answered the very same call with UNKNOWN_TOOL.
    expect(JSON.stringify(checked)).not.toMatch(/UNKNOWN_TOOL/)
    const scan = await call(ctx, 'clone_scan', { run_id: 'r1', module: 'base' })
    // projectRoot is a real directory but not a git work tree, so the run must
    // fail on the baseline read rather than pretending to succeed.
    expect((scan as { isError?: boolean }).isError).toBe(true)
    expect(JSON.stringify(scan)).toMatch(/git rev-parse HEAD/)
  })
})
