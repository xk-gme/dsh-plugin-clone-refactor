/**
 * Plugin entry: the composition root. Task 1 owns only the mount contract —
 * `name`, `inject`, the loose `Config` row and a defensive `apply` — so the
 * build, the install and the config tests have an entry to compile. The tools
 * and every capability module are registered here by a later task.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveSettings } from './config.ts'

export type { DetectionProvider, Priority, Settings, SubmitMode, VerifyPhase, VerifyStep } from './config.ts'

/** What the profile row may carry. Read defensively by `resolveSettings`. */
export interface Config {
  projectRoot?: unknown
  artifactsRoot?: unknown
  detection?: unknown
  authorization?: unknown
  verify?: unknown
  submit?: unknown
  workdir?: unknown
  reportLanguage?: unknown
  pageChars?: unknown
}

export const name = 'gme-clone-refactor'
/**
 * Nothing yet: this task's `apply` reads only its own config. The tools and
 * prompt sections that need `tools` and `systemPrompt` arrive with the later
 * capability modules, which declare their injections here.
 */
export const inject: string[] = []
/**
 * Every field is deliberately loose. A row whose config fails validation takes
 * the whole plugin tree down at boot, so wrong values are degraded by
 * `resolveSettings` (with a warning) instead of being rejected by the loader.
 * The defaults here only have to keep `Config({})` valid; `resolveSettings` owns
 * the real defaults and the warnings.
 */
export const Config: z<Config> = z.object({
  projectRoot: z.any().default(''),
  artifactsRoot: z.any().default(''),
  detection: z.any().default({}),
  authorization: z.any().default({}),
  verify: z.any().default({}),
  submit: z.any().default({}),
  workdir: z.any().default({}),
  reportLanguage: z.any().default('zh'),
  pageChars: z.any().default(12_000),
})

/** The one-line reason from a caught value, for a warning message. */
function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Mount the plugin row: normalize the configuration and report every degraded
 * value as a warning. Never throws — this runs at boot, and a throw here is a
 * plugin-tree failure.
 */
export function apply(ctx: Context, config: Config): void {
  try {
    const { settings, warnings } = resolveSettings(config)
    for (const warning of warnings) ctx.logger.warn(`gme-clone-refactor: ${warning}`)
    if (settings.projectRoot === '') {
      ctx.logger.warn('gme-clone-refactor: no projectRoot is configured, so no clone-refactor tool is registered')
    }
  } catch (error) {
    // The guard is around the whole mount, not around an enumeration of bad
    // inputs: a `!!js` config expression can reach `resolveSettings` with a
    // value nothing there can foresee.
    ctx.logger.warn(`gme-clone-refactor: mounting stopped early (${reason(error)})`)
  }
}
