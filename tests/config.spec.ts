import { describe, expect, it } from 'vitest'
import { resolveSettings } from '../src/config.ts'

describe('resolveSettings', () => {
  it('returns the documented defaults for an empty row', () => {
    const { settings, warnings } = resolveSettings({})
    expect(warnings).toEqual([])
    expect(settings.projectRoot).toBe('')
    expect(settings.artifactsRoot).toBe('')
    expect(settings.detection.provider).toBe('csv')
    expect(settings.detection.enableType34).toBe(false)
    expect(settings.authorization).toEqual({ enabled: false, maxPriority: 'P0', maxClusters: 1 })
    expect(settings.verify.steps).toEqual([])
    expect(settings.verify.keepFailedPatch).toBe(false)
    expect(settings.submit.mode).toBe('none')
    expect(settings.workdir).toEqual({ allowDirty: false, returnToOriginalBranch: false })
    expect(settings.pageChars).toBe(12000)
  })

  it('degrades wrong-typed values to their defaults with a warning instead of throwing', () => {
    const { settings, warnings } = resolveSettings({ projectRoot: 42, pageChars: 'wide' })
    expect(settings.projectRoot).toBe('')
    expect(settings.pageChars).toBe(12000)
    expect(warnings.join('\n')).toMatch(/projectRoot must be a string/)
    expect(warnings.join('\n')).toMatch(/pageChars must be an integer/)
  })

  it('drops an unknown detection provider instead of accepting it', () => {
    const { settings, warnings } = resolveSettings({ detection: { provider: 'magic' } })
    expect(settings.detection.provider).toBe('csv')
    expect(warnings.join('\n')).toMatch(/detection\.provider/)
  })

  it('resolves projectRoot against the process cwd', () => {
    const { settings } = resolveSettings({ projectRoot: 'relative/repo' })
    // `node:path.resolve` answers in the platform's own separators, so the
    // assertion reads the resolved path in that same normal form.
    expect(settings.projectRoot.replaceAll('\\', '/')).toBe(`${process.cwd().replaceAll('\\', '/')}/relative/repo`)
  })

  it('warns about a nested section that is not an object instead of silently defaulting it', () => {
    const { settings, warnings } = resolveSettings({ detection: 42, verify: 'nope' })
    expect(settings.detection.provider).toBe('csv')
    expect(settings.verify.steps).toEqual([])
    expect(warnings.join('\n')).toMatch(/detection must be an object/)
    expect(warnings.join('\n')).toMatch(/verify must be an object/)
  })

  it('keeps a well-formed verify step list and drops malformed entries', () => {
    const { settings, warnings } = resolveSettings({
      verify: {
        keepFailedPatch: true,
        steps: [
          { name: 'build-debug', phase: 'build', command: 'msbuild tests.sln', required: true, timeoutMs: 600000 },
          { name: '', command: 'echo x' },
          { name: 'no-command' },
          // No `always` key on purpose: the default is what this case exists to pin.
          { name: 'restore-config', phase: 'restore', command: 'restore.ps1' },
        ],
      },
    })
    expect(settings.verify.keepFailedPatch).toBe(true)
    expect(settings.verify.steps.map(step => step.name)).toEqual(['build-debug', 'restore-config'])
    expect(settings.verify.steps[0]).toEqual({
      name: 'build-debug', phase: 'build', command: 'msbuild tests.sln',
      required: true, always: false, timeoutMs: 600000,
    })
    // `always` defaults to true only for the restore phase — a restore step that
    // is skipped after a failure is the one thing a pipeline must never do. Both
    // halves are asserted: passing `always: true` explicitly would test nothing.
    expect(settings.verify.steps[1]?.always).toBe(true)
    expect(warnings.join('\n')).toMatch(/verify\.steps\[1\]/)
    expect(warnings.join('\n')).toMatch(/verify\.steps\[2\]/)
  })

  it('never throws for missing or nullish input', () => {
    expect(() => resolveSettings(undefined)).not.toThrow()
    expect(() => resolveSettings(null)).not.toThrow()
    expect(resolveSettings(undefined).settings.projectRoot).toBe('')
  })
})
