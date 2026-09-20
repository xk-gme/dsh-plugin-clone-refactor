/** GME clone refactor inside Harness: detection, judging, verification, submission. */
import type { Context } from '@deepseek-ai/cordis'
// Side-effect type import: loads the `declare module '@deepseek-ai/cordis'`
// augmentation that puts `systemPrompt` on `Context`.
import type {} from '@deepseek-ai/dsh-system-prompt'
import z from '@deepseek-ai/schemastery'
import { resolveSettings, type Settings } from './config.ts'
import { hostRunner } from './core/command-host.ts'
import { artifactsRootOf } from './core/run.ts'
import { registerTools } from './tools.ts'

export type { DetectionProvider, Priority, Settings, SubmitMode, VerifyPhase, VerifyStep } from './config.ts'

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
export const inject = ['tools', 'systemPrompt']

/**
 * Every field is intentionally loose: a row whose config fails validation takes
 * the whole plugin tree down at boot, so `resolveSettings` degrades bad values
 * with a warning instead. These defaults only keep `Config({})` valid.
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

export { resolveSettings } from './config.ts'

/** What the model is told while this plugin is mounted. */
export function guidanceText(settings: Settings, configured: boolean): string {
  if (!configured) {
    return [
      'GME clone refactor is installed but NOT available: no projectRoot is configured, so no clone_refactor tool was registered.',
      'To enable it the user must point the plugin at a GME work tree and restart Harness:',
      '1. Export GME_CLONE_REFACTOR_ROOT=<absolute path to the GME checkout> (optional: GME_CLONE_REFACTOR_ARTIFACTS=<run directory>) before Harness starts, or override the gme-clone-refactor row in $DSH_HOME/profiles/<profile>/cordis.patch.yml:',
      '   - id: gme-clone-refactor',
      '     config:',
      '       projectRoot: <absolute path to the GME checkout>',
      '       artifactsRoot: <run directory>   # optional',
      '2. Decide the detection source: detection.provider: csv with detection.csvPath pointing at an existing func_clone_<module>.csv (no Python needed), or detection.provider: python-pipeline with detection.scriptPath pointing at docs/.codex/skills/cpp-clone-detection/scripts/run_gme_clone_detection.py (needs Python, libclang and, for type 3-4, an embeddings endpoint).',
      '3. Patching source is off by default. To allow source changes, set authorization.enabled: true. authorization.maxPriority is the severity ceiling, and authorization.maxClusters caps how many clusters may hold LIVE authorization at the same time — it is not a count of patches over the run\'s life, so retracting a verdict frees a slot.',
      '4. clone_verify needs verify.steps: the build, test, format and restore commands for this site. Without them nothing can be verified and nothing may be submitted.',
      '5. Submissions are off by default (submit.mode: none); commit, push or pr must be chosen deliberately.',
      'Report these steps when the user asks for a clone refactor or asks why its tools are missing.',
    ].join('\n')
  }
  const lines = [
    'GME clone refactor: clone_scan produces the clone families of one module and is the coverage contract — every cluster must end with a verdict before clone_report closes the run.',
    'clone_check is read-only and is how progress is polled: clone_scan and clone_verify are background jobs, so a call returns accepted and the job record is the truth. A job left at running has no terminal record: either the run was interrupted, or its terminal status could not be written — a task that succeeded can leave that record behind. Neither is a success, so never report a job at running as done.',
    'Judge each cluster from the real source, not from the CSV excerpt. The clustering is structural only: it has no skeleton or risk-signal analysis, so the priority is yours to decide.',
    'A patched verdict needs confirm: true, authorization.enabled, the files it changed and evidence. A P0 cluster you leave unpatched needs evidence of the concrete blocker — "semantics unclear" is not evidence and is rejected.',
    'clone_verify reconciles the authorization ledger against the actual git diff first: a changed file the user never authorized freezes the run with UNAUTHORIZED_CHANGES. Never edit around that.',
    'Retracting authorization is not reverting the patch: re-assessing a patched cluster as report_only or skipped deletes its authorization record, but the file it changed stays changed in the work tree, so clone_verify freezes the run. Give the user both ways out — they restore the file themselves (git restore --source=HEAD -- <file>), or the cluster is recorded as patched again with replace: true and confirm: true. Nothing restores a file automatically: that is the design, not an oversight.',
    'Nothing may be submitted before a passing clone_verify, and clone_submit needs confirm: true. Report the outcome to the user; do not submit on your own initiative.',
  ]
  if (!settings.authorization.enabled) lines.push('Patching is DISABLED in this deployment: you may still scan, judge and report, but clone_assess rejects a patched verdict. Say so instead of editing files.')
  if (settings.verify.steps.length === 0) lines.push('verify.steps is empty, so no verification can run — patches cannot be validated and must not be submitted.')
  if (settings.authorization.enabled && settings.verify.steps.length === 0) lines.push('Patching is enabled but nothing can verify it: treat every patch as unverified and tell the user.')
  return lines.join('\n')
}

/** Register the clone-refactor tools and stance; must never throw. */
export function apply(ctx: Context, config: Config): void {
  try {
    const { settings, warnings } = resolveSettings(config)
    for (const warning of warnings) ctx.logger.warn(`gme-clone-refactor: ${warning}`)
    const configured = settings.projectRoot !== ''
    ctx.systemPrompt.section({ name, order: 148, text: guidanceText(settings, configured) })
    if (!configured) {
      ctx.logger.warn(
        'gme-clone-refactor: projectRoot is not configured, so no clone-refactor tools were registered. '
        + 'Set GME_CLONE_REFACTOR_ROOT before starting Harness, or override the gme-clone-refactor row in the profile patch. '
        + 'The model has been told these steps and will report them.',
      )
      return
    }
    // The only place the host-backed runner is constructed: every other module
    // receives it as a parameter, which is what keeps the capability modules
    // testable without a compiler or a subprocess provider.
    const runner = hostRunner(ctx, { maxBytes: settings.verify.outputMaxBytes, graceMs: settings.verify.graceMs })
    try {
      registerTools(ctx, settings, runner, artifactsRootOf(settings))
    } catch (error) {
      ctx.logger.warn(`gme-clone-refactor: the clone-refactor tools were not registered (${reason(error)})`)
    }
  } catch (error) {
    ctx.logger.warn(`gme-clone-refactor: mounting stopped early (${reason(error)})`)
  }
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
