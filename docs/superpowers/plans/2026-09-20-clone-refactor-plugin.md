# 克隆重构 DSH 插件实现计划（dsh-gme-clone-refactor）

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `gme-pr-agent` 的克隆重构能力实现为可安装的 DSH 插件 `dsh-gme-clone-refactor`，覆盖检测 → 分簇 → 评估 → 授权最小 patch → 真实编译验证 → 提交/PR 全链路。

**Architecture:** 插件是组合根（`index.ts`）+ 6 个工具（`tools.ts`）+ 5 个互不依赖的能力模块（`detect` / `verify` / `git` / `submit` / `report`）。能力模块之间**不互相调用**，只通过 run 目录里的 append-only 文件交汇；对外只有两条接口：`CloneDetector`（检测来源）与 `CommandRunner`（命令执行），宿主实现只在组合根里被导入。不引入 git worktree —— 构建测试本来就必须在 `projectRoot`（主工作树）里跑，worktree 只能带来搬运/恢复层。

**Tech Stack:** TypeScript 6（`strict` + `exactOptionalPropertyTypes`）、Node 22.19+/24+、tsdown（打包）、vitest（测试）、Cordis 4（`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-system-prompt`、`@deepseek-ai/dsh-subprocess`、`@deepseek-ai/schemastery`）。

**Spec:** `docs/superpowers/specs/2026-09-20-clone-refactor-plugin-design.md`

## Global Constraints

- 包名 `dsh-gme-clone-refactor`；插件行 id `gme-clone-refactor`；工具名前缀 `clone_`；run 默认根 `$DSH_HOME/gme-clone-refactor/runs`。
- 所有 `@deepseek-ai/*` 官方包一律 **peerDependencies**（`@deepseek-ai/cordis` 用 `^4.0.1`，其余用 `>=0.1.2-alpha.1 <0.2.0-0`），并**同时**以精确版本 `0.1.2-alpha.5` 列进 devDependencies。漏掉 devDependencies 会让 pnpm 的 auto-install-peers 去装 `latest`（`@deepseek-ai/dsh-tools` 的 latest 是 `0.0.1-rc.1`）。
- `apply()` 与 `resolveSettings()` **永远不许抛错**：一条 config 校验失败会让整棵插件树失败（`dsh: 1 entry did not activate`）。坏值一律降级到文档化默认值 + warning。
- **目标仓库永不被插件写入**：除模型在 `projectRoot` 上打的 patch 外，所有写入落在 run 目录。`run_id` 逃逸 `artifactsRoot` 一律拒绝。
- 源码内导入使用 `.ts` 扩展名（`allowImportingTsExtensions`）；ESM only；所有文件 UTF-8 + LF 行尾。
- 工具参数 schema 用 DSH 方言：每个属性写 `required: true`，枚举写 `enum: [...]`（见 Task 13）。
- 每个任务结束时 `pnpm run verify` 必须退出码 0（`typecheck && build && test`）。

---

## File Structure

```
dsh-gme-clone-refactor/
├── package.json                     包清单（dsh.bundle.patch 指向 cordis.patch.yml）
├── cordis.patch.yml                 挂载层：insert 一行 gme-clone-refactor，路径全部走 !!js 表达式
├── tsconfig.json / tsdown.config.ts / vitest.config.ts / .gitignore / LICENSE
├── docs/
│   ├── setup.md / setup.zh.md       安装、配置参考、GME profile 示例、限制
│   └── superpowers/
│       ├── specs/2026-09-20-clone-refactor-plugin-design.md   设计稿（已存在）
│       └── plans/2026-09-20-clone-refactor-plugin.md          本文件
├── src/
│   ├── index.ts                     组合根：Config schema、resolveSettings、apply、空配置降级
│   ├── config.ts                    Settings 类型 + 防御式归一化（不抛错）
│   ├── tools.ts                     6 个工具：schema、路由、呈现（只调 core）
│   ├── core/
│   │   ├── artifacts.ts             run 目录布局、run_id 逃逸守卫、原子写、newRunId
│   │   ├── jsonl.ts                 append-only JSONL 读写（断行丢弃并报告）
│   │   ├── schema.ts                簇/判定/验证结果的数据结构 + requireText 等断言
│   │   ├── command.ts               CommandRunner 接口 + FakeRunner（测试用）
│   │   ├── command-host.ts          宿主实现：ctx.subprocess.spawn + 收集输出
│   │   ├── jobs.ts                  后台 job 注册表（异步轮询的状态来源）
│   │   ├── run.ts                   run 生命周期：创建/续跑、基线、projectRoot 校验
│   │   └── ledger.ts                账本：assessments / patches 的追加与覆盖契约
│   ├── detect/
│   │   ├── provider.ts              CloneDetector 接口
│   │   ├── cluster.ts               CSV 行 → 簇聚合（口径对齐 cluster_report.py）
│   │   ├── csv.ts                   直读已有 func_clone_<module>.csv
│   │   └── python.ts                驱动 run_gme_clone_detection.py
│   ├── verify/
│   │   └── engine.ts                步骤清单执行：phase/required/always/超时/日志/回滚
│   ├── git/
│   │   ├── baseline.ts              基线快照、工作区干净校验、分支
│   │   └── reconcile.ts             授权对账：diff vs 账本
│   ├── submit.ts                    commit / push / PR（按 mode）
│   └── report/
│       ├── report.ts                report.md
│       └── summary.ts               findings.json + summary.json
└── tests/
    ├── config.spec.ts  artifacts.spec.ts  ledger.spec.ts  cluster.spec.ts
    ├── engine.spec.ts  reconcile.spec.ts  report.spec.ts  workflow.spec.ts
    ├── install.spec.ts              挂载契约：真 patch 引擎 + 真 Loader 树
    └── fixtures/                    sample_func_clone.csv、sample_run/…
```

**依赖方向（严格单向，任何任务都不得违反）：**

```
tools → core → {detect, verify, git, submit, report}
detect / verify / git / submit / report → core/command.ts（接口，仅类型）
index.ts（组合根）→ 唯一的 core/command-host.ts 导入者
```

---

### Task 1: 插件骨架与配置归一化

**Files:**
- Create: `package.json`, `cordis.patch.yml`, `tsconfig.json`, `tsdown.config.ts`, `vitest.config.ts`, `.gitignore`, `LICENSE`
- Create: `src/config.ts`
- Test: `tests/config.spec.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `Settings`、`Priority`、`DetectionProvider`、`VerifyStep`、`SubmitMode`、`PRIORITIES`、`PROVIDERS`、`PHASES`、`SUBMIT_MODES`、`PRIORITY_RANK`、`resolveSettings(raw: unknown): { settings: Settings; warnings: string[] }`

- [ ] **Step 1: 建仓库骨架**

```powershell
cd D:\workspace\gme-dsh-plugin
New-Item -ItemType Directory -Force -Path dsh-gme-clone-refactor\src\core, dsh-gme-clone-refactor\tests\fixtures | Out-Null
cd dsh-gme-clone-refactor
git init -b main
```

`package.json`（照抄 `dsh-gme-defect-scan` 的形状，只改名字、描述、仓库地址与 peer 列表）：

```json
{
  "name": "dsh-gme-clone-refactor",
  "version": "0.1.0",
  "description": "GME clone-refactor workflow for DeepSeek Harness: scan clone clusters, assess them, apply one authorized minimal patch, verify it with a real build and test, and submit only what passed.",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "files": ["lib", "cordis.patch.yml", "docs", "!docs/superpowers", "README.md", "README.zh.md", "LICENSE"],
  "keywords": ["dsh", "dsh-plugin", "deepseek-harness", "gme", "clone-detection", "clone-refactor", "cpp"],
  "license": "MIT",
  "repository": { "type": "git", "url": "git+https://github.com/nuaaweixinye/dsh-gme-clone-refactor.git" },
  "homepage": "https://github.com/nuaaweixinye/dsh-gme-clone-refactor",
  "bugs": { "url": "https://github.com/nuaaweixinye/dsh-gme-clone-refactor/issues" },
  "publishConfig": { "registry": "https://registry.npmjs.org/", "access": "public" },
  "engines": { "node": "^22.19.0 || >=24.0.0", "dsh": ">=0.1.2-alpha.1 <0.2.0-0" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "scripts": {
    "build": "tsdown",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "verify": "npm run typecheck && npm run build && npm run test",
    "prepare": "tsdown",
    "prepack": "tsdown"
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.1",
    "@deepseek-ai/dsh-subprocess": ">=0.1.2-alpha.1 <0.2.0-0",
    "@deepseek-ai/dsh-system-prompt": ">=0.1.2-alpha.1 <0.2.0-0",
    "@deepseek-ai/dsh-tools": ">=0.1.2-alpha.1 <0.2.0-0",
    "@deepseek-ai/dsh-util-values": ">=0.1.2-alpha.1 <0.2.0-0",
    "@deepseek-ai/schemastery": "^3.18.1"
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "^4.0.2",
    "@deepseek-ai/cordis-plugin-include": "^1.0.7",
    "@deepseek-ai/cordis-plugin-loader": "^1.0.3",
    "@deepseek-ai/dsh-llm": "0.1.2-alpha.5",
    "@deepseek-ai/dsh-subprocess": "0.1.2-alpha.5",
    "@deepseek-ai/dsh-system-prompt": "0.1.2-alpha.5",
    "@deepseek-ai/dsh-tools": "0.1.2-alpha.5",
    "@deepseek-ai/dsh-util-values": "0.1.2-alpha.5",
    "@deepseek-ai/schemastery": "^3.18.2",
    "@types/js-yaml": "^4.0.9",
    "@types/node": "^22.20.0",
    "js-yaml": "^4.1.0",
    "tsdown": "^0.22.2",
    "typescript": "^6.0.3",
    "vitest": "^4.1.8"
  }
}
```

`tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "es2024",
    "lib": ["es2024"],
    "module": "esnext",
    "moduleResolution": "bundler",
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "esModuleInterop": true,
    "allowImportingTsExtensions": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src", "tests"]
}
```

`tsdown.config.ts`：

```ts
import { defineConfig } from 'tsdown'

/**
 * One Node ESM entry: `src/index.ts` bundles tools, core, detect, verify, git,
 * submit and report into `lib/index.js`. `@deepseek-ai/*` stays external — those
 * packages are the host's peers, so a bundled copy would shadow the services the
 * plugin injects.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: true,
})
```

`vitest.config.ts`：

```ts
import { defineConfig } from 'vitest/config'

/**
 * Node-only suite. The install suite mounts a real Cordis Loader tree and the
 * workflow suites drive subprocess-backed steps, so the default 5s timeout is
 * too tight on a cold Windows run.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
```

`.gitignore`：

```
node_modules/
lib/
*.tgz
coverage/
.DS_Store
```

`LICENSE`：MIT 全文，版权行 `Copyright (c) 2026 nuaaweixinye`。

`cordis.patch.yml`（注释按现有两个插件的风格写全，`values` 里不得出现作者机器路径）：

```yaml
# dsh-gme-clone-refactor bundle patch — the `dsh.bundle.patch` layer of this package.
#
#   dsh plugin --profile web add dsh-gme-clone-refactor
#
# installs the package and appends `dsh-gme-clone-refactor` to the profile's
# `dsh.profile.bundles`; the next boot merges THIS patch (a single `insert` of the
# plugin row). No profile file has to be edited by hand.
#
# The row is always mounted, and an empty projectRoot is a supported state rather
# than a failure: the plugin then registers no tools, logs one warning, and
# publishes the full configuration procedure to the model, so an agent asked for a
# clone refactor can tell the user how to finish the setup. It must never throw — a
# row whose config fails validation takes the entire plugin tree down with it
# ("dsh: 1 entry did not activate") — which is why every path below is read as an
# expression with a fallback instead of being required.
#
# Two ways to configure it.
#
# 1. Environment (this layer already reads it):
#      $env:GME_CLONE_REFACTOR_ROOT      = 'D:/workspace/GME'
#      $env:GME_CLONE_REFACTOR_ARTIFACTS = 'D:/workspace/gme-clone-runs'   # optional
#    These must be present when Harness STARTS, not when a tool is called.
#
# 2. A profile patch override. `- id:` replaces only the keys it names, whole
#    `config` included, so restate every field you keep:
#
#      - id: gme-clone-refactor
#        config:
#          projectRoot: D:/workspace/GME
#          artifactsRoot: D:/workspace/gme-clone-runs
#          detection:
#            provider: csv
#            csvPath: D:/workspace/clone-reports/func_clone_base.csv
#          authorization:
#            enabled: false
#            maxPriority: P0
#            maxClusters: 1
#          submit:
#            mode: none
- insert:
    - id: gme-clone-refactor
      name: 'dsh-gme-clone-refactor'
      config:
        projectRoot: !!js process.env.GME_CLONE_REFACTOR_ROOT ?? ''
        artifactsRoot: !!js process.env.GME_CLONE_REFACTOR_ARTIFACTS ?? ''
```

- [ ] **Step 2: 写失败的配置测试**

`tests/config.spec.ts`：

```ts
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
    expect(settings.projectRoot.endsWith('relative/repo')).toBe(true)
    expect(settings.projectRoot.includes('\\') || settings.projectRoot.includes('/')).toBe(true)
  })

  it('keeps a well-formed verify step list and drops malformed entries', () => {
    const { settings, warnings } = resolveSettings({
      verify: {
        keepFailedPatch: true,
        steps: [
          { name: 'build-debug', phase: 'build', command: 'msbuild tests.sln', required: true, timeoutMs: 600000 },
          { name: '', command: 'echo x' },
          { name: 'no-command' },
          { name: 'restore-config', phase: 'restore', command: 'restore.ps1', always: true },
        ],
      },
    })
    expect(settings.verify.keepFailedPatch).toBe(true)
    expect(settings.verify.steps.map(step => step.name)).toEqual(['build-debug', 'restore-config'])
    expect(settings.verify.steps[0]).toEqual({
      name: 'build-debug', phase: 'build', command: 'msbuild tests.sln',
      required: true, always: false, timeoutMs: 600000,
    })
    // `always` defaults to true for the restore phase: a restore step that is
    // skipped after a failure is the one thing a pipeline must never do.
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
```

- [ ] **Step 3: 运行测试确认失败**

Run: `cd D:\workspace\gme-dsh-plugin\dsh-gme-clone-refactor; pnpm install; pnpm vitest run tests/config.spec.ts`
Expected: FAIL —— `Cannot find module '../src/config.ts'`

- [ ] **Step 4: 实现 `src/config.ts`**

```ts
/**
 * Trusted, normalized deployment configuration.
 *
 * Every field is read defensively. A row whose config fails validation takes the
 * whole plugin tree down at boot ("dsh: 1 entry did not activate"), so a bad value
 * degrades to its documented default and is reported as a warning instead of
 * being rejected by the loader.
 */
import { resolve } from 'node:path'

export type Priority = 'P0' | 'P1' | 'P2' | 'PX'
export type DetectionProvider = 'csv' | 'python-pipeline'
export type VerifyPhase = 'setup' | 'build' | 'test' | 'check' | 'restore'
export type SubmitMode = 'none' | 'commit' | 'push' | 'pr'

export const PRIORITIES: readonly Priority[] = ['P0', 'P1', 'P2', 'PX']
export const PROVIDERS: readonly DetectionProvider[] = ['csv', 'python-pipeline']
export const PHASES: readonly VerifyPhase[] = ['setup', 'build', 'test', 'check', 'restore']
export const SUBMIT_MODES: readonly SubmitMode[] = ['none', 'commit', 'push', 'pr']

/** Rank order for authorization: lower is more severe. */
export const PRIORITY_RANK: Record<Priority, number> = { P0: 0, P1: 1, P2: 2, PX: 3 }

export interface VerifyStep {
  name: string
  phase: VerifyPhase
  command: string
  /** A failed required step fails the whole verification. */
  required: boolean
  /** Run even after an earlier step failed: the `finally` semantics. */
  always: boolean
  timeoutMs: number
}

export interface DetectionSettings {
  provider: DetectionProvider
  /** An existing `func_clone_<module>.csv` when the provider is `csv`. */
  csvPath: string
  pythonPath: string
  scriptPath: string
  libclang: string
  enableType34: boolean
  embeddingModel: string
  embeddingApiBase: string
  embeddingApiKey: string
  embeddingThreshold: number
}

export interface Settings {
  /** Main work tree. Empty means "not configured": no tool is registered. */
  projectRoot: string
  /** Where runs live. Empty means "DSH home". */
  artifactsRoot: string
  detection: DetectionSettings
  authorization: { enabled: boolean; maxPriority: Priority; maxClusters: number }
  verify: { steps: VerifyStep[]; keepFailedPatch: boolean; outputMaxBytes: number; graceMs: number }
  submit: { mode: SubmitMode; baseBranch: string; remote: string; commitMessageTemplate: string }
  workdir: { allowDirty: boolean; returnToOriginalBranch: boolean }
  reportLanguage: 'zh' | 'en'
  pageChars: number
}

/** What a warning prints in place of a value nothing here can describe. */
const UNRENDERABLE = '[unserializable]'

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/**
 * Render a value inside a warning. `JSON.stringify` throws on a BigInt, and a
 * `!!js` config expression can supply one, so the renderer that explains a bad
 * value must not itself be a way for `apply` to throw.
 */
function render(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, item: unknown) => (typeof item === 'bigint' ? `${item}n` : item))
  } catch {
    return UNRENDERABLE
  }
}

function text(value: unknown, fallback: string, label: string, warnings: string[]): string {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string') {
    warnings.push(`${label} must be a string; using ${render(fallback)}`)
    return fallback
  }
  return value.trim() === '' ? fallback : value.trim()
}

function integer(value: unknown, fallback: number, label: string, min: number, max: number, warnings: string[]): number {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    warnings.push(`${label} must be an integer in [${min}, ${max}]; using ${fallback}`)
    return fallback
  }
  return value
}

function number(value: unknown, fallback: number, label: string, min: number, max: number, warnings: string[]): number {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    warnings.push(`${label} must be a number in [${min}, ${max}]; using ${fallback}`)
    return fallback
  }
  return value
}

function boolean(value: unknown, fallback: boolean, label: string, warnings: string[]): boolean {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'boolean') {
    warnings.push(`${label} must be a boolean; using ${fallback}`)
    return fallback
  }
  return value
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T, label: string, warnings: string[]): T {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    warnings.push(`${label} must be one of ${render(allowed)}; using ${render(fallback)}`)
    return fallback
  }
  return value as T
}

const MAX_TIMEOUT_MS = 86_400_000

/** One step of the verification pipeline; malformed entries are dropped, never guessed. */
function verifySteps(value: unknown, warnings: string[]): VerifyStep[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    warnings.push('verify.steps must be an array; running no steps')
    return []
  }
  const steps: VerifyStep[] = []
  for (const [index, item] of value.entries()) {
    const raw = record(item)
    const name = typeof raw.name === 'string' ? raw.name.trim() : ''
    const command = typeof raw.command === 'string' ? raw.command.trim() : ''
    if (name === '' || command === '') {
      warnings.push(`verify.steps[${index}] needs non-empty name and command; dropped`)
      continue
    }
    const phase = oneOf(raw.phase, PHASES, 'build', `verify.steps[${index}].phase`, warnings)
    steps.push({
      name,
      phase,
      command,
      required: boolean(raw.required, true, `verify.steps[${index}].required`, warnings),
      // A restore step that is skipped after a failure is the one thing a
      // pipeline must never do, so `restore` defaults to always running.
      always: boolean(raw.always, phase === 'restore', `verify.steps[${index}].always`, warnings),
      timeoutMs: integer(raw.timeoutMs, 1_800_000, `verify.steps[${index}].timeoutMs`, 1_000, MAX_TIMEOUT_MS, warnings),
    })
  }
  return steps
}

function detectionSettings(value: unknown, warnings: string[]): DetectionSettings {
  const raw = record(value)
  return {
    provider: oneOf(raw.provider, PROVIDERS, 'csv', 'detection.provider', warnings),
    csvPath: text(raw.csvPath, '', 'detection.csvPath', warnings),
    pythonPath: text(raw.pythonPath, 'python', 'detection.pythonPath', warnings),
    scriptPath: text(raw.scriptPath, '', 'detection.scriptPath', warnings),
    libclang: text(raw.libclang, '', 'detection.libclang', warnings),
    enableType34: boolean(raw.enableType34, false, 'detection.enableType34', warnings),
    embeddingModel: text(raw.embeddingModel, '', 'detection.embeddingModel', warnings),
    embeddingApiBase: text(raw.embeddingApiBase, '', 'detection.embeddingApiBase', warnings),
    embeddingApiKey: text(raw.embeddingApiKey, '', 'detection.embeddingApiKey', warnings),
    embeddingThreshold: number(raw.embeddingThreshold, 0.8, 'detection.embeddingThreshold', 0, 1, warnings),
  }
}

/**
 * Normalize a profile row into settings. Never throws: this runs at boot, and a
 * throw here is a plugin-tree failure.
 */
export function resolveSettings(raw: unknown): { settings: Settings; warnings: string[] } {
  const warnings: string[] = []
  const source = record(raw)
  const projectRoot = text(source.projectRoot, '', 'projectRoot', warnings)
  const reportLanguage = oneOf(source.reportLanguage, ['zh', 'en'] as const, 'zh', 'reportLanguage', warnings)
  const authorization = record(source.authorization)
  const verify = record(source.verify)
  const submit = record(source.submit)
  const workdir = record(source.workdir)
  return {
    settings: {
      projectRoot: projectRoot === '' ? '' : resolve(projectRoot),
      artifactsRoot: text(source.artifactsRoot, '', 'artifactsRoot', warnings),
      detection: detectionSettings(source.detection, warnings),
      authorization: {
        enabled: boolean(authorization.enabled, false, 'authorization.enabled', warnings),
        maxPriority: oneOf(authorization.maxPriority, PRIORITIES, 'P0', 'authorization.maxPriority', warnings),
        maxClusters: integer(authorization.maxClusters, 1, 'authorization.maxClusters', 0, 100, warnings),
      },
      verify: {
        steps: verifySteps(verify.steps, warnings),
        keepFailedPatch: boolean(verify.keepFailedPatch, false, 'verify.keepFailedPatch', warnings),
        outputMaxBytes: integer(verify.outputMaxBytes, 4_194_304, 'verify.outputMaxBytes', 1024, 268_435_456, warnings),
        graceMs: integer(verify.graceMs, 5000, 'verify.graceMs', 0, 60_000, warnings),
      },
      submit: {
        mode: oneOf(submit.mode, SUBMIT_MODES, 'none', 'submit.mode', warnings),
        baseBranch: text(submit.baseBranch, '', 'submit.baseBranch', warnings),
        remote: text(submit.remote, 'origin', 'submit.remote', warnings),
        commitMessageTemplate: text(submit.commitMessageTemplate, '', 'submit.commitMessageTemplate', warnings),
      },
      workdir: {
        allowDirty: boolean(workdir.allowDirty, false, 'workdir.allowDirty', warnings),
        returnToOriginalBranch: boolean(workdir.returnToOriginalBranch, false, 'workdir.returnToOriginalBranch', warnings),
      },
      reportLanguage,
      pageChars: integer(source.pageChars, 12_000, 'pageChars', 256, 50_000, warnings),
    },
    warnings,
  }
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm vitest run tests/config.spec.ts`
Expected: PASS（6 个用例）

- [ ] **Step 6: 提交**

```bash
git add -A
git commit -m "feat: scaffold the plugin and normalize its configuration defensively"
```

---

### Task 2: 产物基元（run 目录、原子写、append-only JSONL）

**Files:**
- Create: `src/core/artifacts.ts`, `src/core/jsonl.ts`
- Test: `tests/artifacts.spec.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `RunPaths`、`runPaths(artifactsRoot, runId)`、`dshHome(env?)`、`defaultArtifactsRoot(env?)`、`newRunId(now?, rand?)`、`ensureDir(dir)`、`writeAtomic(file, text)`、`readJson<T>(file)`、`assertInsideRoot(root, runId)`、`appendJsonl(file, value)`、`readJsonl<T>(file)`

- [ ] **Step 1: 写失败的测试**

`tests/artifacts.spec.ts`：

```ts
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertInsideRoot, defaultArtifactsRoot, dshHome, newRunId, readJson, runPaths, writeAtomic,
} from '../src/core/artifacts.ts'
import { appendJsonl, readJsonl } from '../src/core/jsonl.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()!() })

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'clone-artifacts-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

describe('run paths', () => {
  it('derives every artifact path from the run id', () => {
    const paths = runPaths('D:/runs', 'run-1')
    expect(paths.dir.replaceAll('\\', '/')).toBe('D:/runs/run-1')
    expect(paths.clusters.endsWith('clusters.jsonl')).toBe(true)
    expect(paths.assessments.endsWith('assessments.jsonl')).toBe(true)
    expect(paths.patches.endsWith('patches.json')).toBe(true)
    expect(paths.runJson.endsWith('run.json')).toBe(true)
    expect(paths.reportMd.endsWith('report.md')).toBe(true)
  })

  it('refuses a run id that escapes the artifacts root', () => {
    expect(() => assertInsideRoot('D:/runs', '../evil')).toThrow(/escapes/)
    expect(() => assertInsideRoot('D:/runs', 'a/b')).toThrow(/escapes/)
    expect(() => assertInsideRoot('D:/runs', '..')).toThrow(/escapes/)
    expect(() => assertInsideRoot('D:/runs', 'ok-run.1')).not.toThrow()
  })

  it('defaults the artifacts root under DSH home', () => {
    expect(dshHome({ DSH_HOME: 'D:/home' })).toBe('D:/home')
    expect(defaultArtifactsRoot({ DSH_HOME: 'D:/home' }).replaceAll('\\', '/'))
      .toBe('D:/home/gme-clone-refactor/runs')
  })

  it('builds a sortable, unique run id', () => {
    const id = newRunId(new Date('2026-09-20T01:02:03Z'), () => 0.5)
    expect(id).toBe('20260920-010203-8000')
    expect(newRunId()).not.toBe(newRunId())
  })
})

describe('atomic writes and JSONL', () => {
  it('writes through a temp file and leaves no temp behind', async () => {
    const root = await tempRoot()
    const file = join(root, 'nested', 'run.json')
    await writeAtomic(file, '{"a":1}')
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ a: 1 })
    await expect(readFile(`${file}.tmp`, 'utf8')).rejects.toThrow()
  })

  it('reads a missing JSON file as undefined and rejects malformed JSON', async () => {
    const root = await tempRoot()
    expect(await readJson(join(root, 'absent.json'))).toBeUndefined()
    await writeAtomic(join(root, 'bad.json'), '{oops')
    await expect(readJson(join(root, 'bad.json'))).rejects.toThrow()
  })

  it('appends one record per line and reports torn lines instead of guessing', async () => {
    const root = await tempRoot()
    const file = join(root, 'clusters.jsonl')
    await appendJsonl(file, { id: 'C001' })
    await appendJsonl(file, { id: 'C002' })
    const read = await readJsonl<{ id: string }>(file)
    expect(read.records.map(item => item.id)).toEqual(['C001', 'C002'])
    expect(read.droppedLines).toEqual([])
    // A torn write is dropped and reported, never repaired silently.
    await writeAtomic(file, '{"id":"C001"}\n{broken\n\n{"id":"C003"}\n')
    const torn = await readJsonl<{ id: string }>(file)
    expect(torn.records.map(item => item.id)).toEqual(['C001', 'C003'])
    expect(torn.droppedLines).toEqual([2])
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run tests/artifacts.spec.ts`
Expected: FAIL —— `Cannot find module '../src/core/artifacts.ts'`

- [ ] **Step 3: 实现 `src/core/artifacts.ts`**

```ts
/** Where a run lives, and how its files are written. */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'

/** Every file one run owns, so callers never assemble paths by hand. */
export interface RunPaths {
  dir: string
  runJson: string
  clusters: string
  assessments: string
  patches: string
  detectionDir: string
  verifyDir: string
  reportMd: string
  findingsJson: string
  summaryJson: string
}

/** The Harness home: `$DSH_HOME` when set, `~/.dsh` otherwise. */
export function dshHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.DSH_HOME?.trim()
  return configured !== undefined && configured !== '' ? configured : join(homedir(), '.dsh')
}

/** Where runs live when `artifactsRoot` is unconfigured. */
export function defaultArtifactsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(dshHome(env), 'gme-clone-refactor', 'runs')
}

/** The artifact paths of one run. */
export function runPaths(artifactsRoot: string, runId: string): RunPaths {
  const dir = join(artifactsRoot, runId)
  return {
    dir,
    runJson: join(dir, 'run.json'),
    clusters: join(dir, 'clusters.jsonl'),
    assessments: join(dir, 'assessments.jsonl'),
    patches: join(dir, 'patches.json'),
    detectionDir: join(dir, 'detection'),
    verifyDir: join(dir, 'verify'),
    reportMd: join(dir, 'report.md'),
    findingsJson: join(dir, 'findings.json'),
    summaryJson: join(dir, 'summary.json'),
  }
}

/** `<YYYYMMDD-HHMMSS>-<4 hex>` in UTC: sortable, and unique enough for one machine. */
export function newRunId(now: Date = new Date(), rand: () => number = Math.random): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0')
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`
    + `-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
  return `${stamp}-${Math.floor(rand() * 0x10000).toString(16).padStart(4, '0')}`
}

/**
 * Reject a run id that is not a single path segment under the artifacts root.
 * A model-supplied id is untrusted input: a separator or a dot segment would let
 * a run write outside its own directory.
 */
export function assertInsideRoot(artifactsRoot: string, runId: string): void {
  const trimmed = runId.trim()
  if (trimmed === '' || trimmed === '.' || trimmed === '..'
    || trimmed.includes('/') || trimmed.includes('\\')
    || resolve(artifactsRoot, trimmed) !== join(resolve(artifactsRoot), trimmed)) {
    throw new Error(`run_id '${runId}' escapes the artifacts root; use a plain name such as 20260920-010203-ab12`)
  }
  const expected = resolve(artifactsRoot) + sep
  if (!`${resolve(artifactsRoot, trimmed)}${sep}`.startsWith(expected)) {
    throw new Error(`run_id '${runId}' escapes the artifacts root`)
  }
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
}

/** Write through a temp file and rename, so a crash cannot leave a half artifact. */
export async function writeAtomic(file: string, text: string): Promise<void> {
  await ensureDir(dirname(file))
  const temp = `${file}.tmp`
  await writeFile(temp, text, 'utf8')
  await rename(temp, file)
}

/** Parse a JSON file; a missing file is `undefined`, malformed JSON throws. */
export async function readJson<T>(file: string): Promise<T | undefined> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  return JSON.parse(text) as T
}
```

- [ ] **Step 4: 实现 `src/core/jsonl.ts`**

```ts
/** Append-only JSONL: the ledger survives an interrupted run. */
import { appendFile, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { ensureDir } from './artifacts.ts'

export interface JsonlRead<T> {
  records: T[]
  /** 1-based line numbers that were not valid JSON: a torn write is dropped, never guessed. */
  droppedLines: number[]
}

/** Append one record as its own line, creating the file's directory. */
export async function appendJsonl(file: string, value: unknown): Promise<void> {
  await ensureDir(dirname(file))
  await appendFile(file, `${JSON.stringify(value)}\n`, 'utf8')
}

/** Read a JSONL file: blank lines are skipped, malformed lines are reported and dropped. */
export async function readJsonl<T>(file: string): Promise<JsonlRead<T>> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { records: [], droppedLines: [] }
    throw error
  }
  const records: T[] = []
  const droppedLines: number[] = []
  text.split('\n').forEach((line, index) => {
    if (line.trim() === '') return
    try {
      records.push(JSON.parse(line) as T)
    } catch {
      droppedLines.push(index + 1)
    }
  })
  return { records, droppedLines }
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm vitest run tests/artifacts.spec.ts`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add -A
git commit -m "feat(core): add run paths, escape guard, atomic writes and append-only JSONL"
```

---

### Task 3: 数据模型与账本（覆盖契约）

**Files:**
- Create: `src/core/schema.ts`, `src/core/ledger.ts`
- Test: `tests/ledger.spec.ts`

**Interfaces:**
- Consumes: `RunPaths`（Task 2）、`appendJsonl` / `readJsonl`（Task 2）、`writeAtomic` / `readJson`（Task 2）
- Produces: `VERDICTS`、`Verdict`、`ClonePairSide`、`ClonePair`、`Cluster`、`Assessment`、`PatchRecord`、`StepResult`、`VerifyResult`、`requireText(value, label)`、`loadAssessments(paths)`、`recordAssessment(paths, assessment, options)`、`loadPatches(paths)`、`savePatches(paths, patches)`、`coverageGaps(clusterIds, latest)`

- [ ] **Step 1: 写失败的账本测试**

`tests/ledger.spec.ts`：

```ts
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runPaths } from '../src/core/artifacts.ts'
import {
  coverageGaps, loadAssessments, loadPatches, recordAssessment, savePatches,
  requireText, type Assessment, type PatchRecord,
} from '../src/core/ledger.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()!() })

async function paths(): Promise<ReturnType<typeof runPaths>> {
  const root = await mkdtemp(join(tmpdir(), 'clone-ledger-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  return runPaths(root, 'run-1')
}

function assessment(clusterId: string, verdict: Assessment['verdict'], files: string[] = []): Assessment {
  return { cluster_id: clusterId, verdict, priority: 'P0', reason: 'because', files_changed: files, recorded_at: '2026-09-20T00:00:00.000Z' }
}

describe('assessments', () => {
  it('reports missing, not-yet-assessed clusters as coverage gaps', async () => {
    const target = await paths()
    await recordAssessment(target, assessment('C001', 'report_only'), { replace: false })
    const { latest } = await loadAssessments(target)
    expect(coverageGaps(['C001', 'C002'], latest)).toEqual(['C002'])
    expect(coverageGaps(['C001'], latest)).toEqual([])
  })

  it('refuses a second verdict for the same cluster unless replace is set', async () => {
    const target = await paths()
    await recordAssessment(target, assessment('C001', 'report_only'), { replace: false })
    await expect(recordAssessment(target, assessment('C001', 'skipped'), { replace: false }))
      .rejects.toThrow(/already has a verdict/)
    await recordAssessment(target, assessment('C001', 'patched', ['src/a.cpp']), { replace: true })
    const { latest, history } = await loadAssessments(target)
    expect(history).toHaveLength(3)
    expect(latest.get('C001')?.verdict).toBe('patched')
  })

  it('keeps the newest record per cluster', async () => {
    const target = await paths()
    await recordAssessment(target, assessment('C001', 'report_only'), { replace: false })
    await recordAssessment(target, assessment('C002', 'skipped'), { replace: false })
    const { latest, droppedLines } = await loadAssessments(target)
    expect([...latest.keys()].sort()).toEqual(['C001', 'C002'])
    expect(droppedLines).toEqual([])
  })
})

describe('patches', () => {
  it('round-trips the authorization ledger', async () => {
    const target = await paths()
    const patches: PatchRecord[] = [{
      cluster_id: 'C003', priority: 'P0', files_changed: ['module/laws/src/a.cpp'],
      recorded_at: '2026-09-20T00:00:00.000Z',
    }]
    await savePatches(target, patches)
    expect(await loadPatches(target)).toEqual(patches)
    expect(await loadPatches(await paths())).toEqual([])
  })
})

describe('requireText', () => {
  it('trims and rejects an empty or non-string value', () => {
    expect(requireText('  x ', 'run_id')).toBe('x')
    expect(() => requireText('   ', 'run_id')).toThrow(/run_id is required/)
    expect(() => requireText(7, 'run_id')).toThrow(/run_id is required/)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run tests/ledger.spec.ts`
Expected: FAIL —— `Cannot find module '../src/core/schema.ts'`

- [ ] **Step 3: 实现 `src/core/schema.ts`**

```ts
/** The shared data model: the only truth the capability modules agree on. */
import type { Priority, VerifyPhase } from '../config.ts'

export const VERDICTS = ['patched', 'report_only', 'skipped'] as const
export type Verdict = typeof VERDICTS[number]

/** One side of a clone pair, exactly as the detection CSV or the model reports it. */
export interface ClonePairSide {
  file: string
  function: string
  /** The CSV's line-range string, e.g. `120-168`; may be empty. */
  lines: string
  /** Body excerpt when the CSV carries one; empty when the model must read the source. */
  body: string
}

export interface ClonePair {
  pair_id: string
  similarity: number | null
  detection_method: string
  left: ClonePairSide
  right: ClonePairSide
}

/** A clone family: one connected component of the pair graph, and the coverage unit. */
export interface Cluster {
  id: string
  size: number
  representative: ClonePair
  files: string[]
  functions: string[]
}

export interface Assessment {
  cluster_id: string
  verdict: Verdict
  priority: Priority
  reason: string
  files_changed: string[]
  recorded_at: string
}

/** The authorization ledger: what the user allowed, and what it touched. */
export interface PatchRecord {
  cluster_id: string
  priority: Priority
  files_changed: string[]
  recorded_at: string
}

export interface StepResult {
  name: string
  phase: VerifyPhase
  command: string
  required: boolean
  always: boolean
  exit_code: number | null
  ok: boolean
  timed_out: boolean
  log_file: string
  lossy: boolean
}

export interface VerifyResult {
  attempt: number
  ok: boolean
  started_at: string
  finished_at: string
  steps: StepResult[]
  rolled_back: boolean
  rollback_files: string[]
}

/** A required argument that a model may only supply as a non-empty string. */
export function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} is required`)
  return value.trim()
}
```

- [ ] **Step 4: 实现 `src/core/ledger.ts`**

```ts
/**
 * The append-only ledger. Clusters live in `clusters.jsonl`, verdicts in
 * `assessments.jsonl`, and the authorization records in `patches.json`; the
 * coverage contract is "every cluster has exactly one latest verdict".
 */
import { appendJsonl, readJsonl } from './jsonl.ts'
import { readJson, writeAtomic, type RunPaths } from './artifacts.ts'
import type { Assessment, PatchRecord } from './schema.ts'

export { requireText, VERDICTS } from './schema.ts'
export type { Assessment, PatchRecord } from './schema.ts'

export interface LedgerRead {
  /** Newest record per cluster id, in insertion order. */
  latest: Map<string, Assessment>
  history: Assessment[]
  droppedLines: number[]
}

/** Load every assessment; the newest record per cluster wins. */
export async function loadAssessments(paths: RunPaths): Promise<LedgerRead> {
  const { records, droppedLines } = await readJsonl<Assessment>(paths.assessments)
  const latest = new Map<string, Assessment>()
  for (const record of records) {
    if (typeof record?.cluster_id !== 'string' || record.cluster_id === '') continue
    // A later record always wins, including a `replace: true` correction.
    latest.delete(record.cluster_id)
    latest.set(record.cluster_id, record)
  }
  return { latest, history: records, droppedLines }
}

/** Append one verdict, refusing a silent overwrite of an existing cluster. */
export async function recordAssessment(
  paths: RunPaths,
  assessment: Assessment,
  options: { replace: boolean },
): Promise<{ replaced: boolean }> {
  const { latest } = await loadAssessments(paths)
  const replaced = latest.has(assessment.cluster_id)
  if (replaced && !options.replace) {
    throw new Error(`'${assessment.cluster_id}' already has a verdict. Pass replace: true to overwrite it.`)
  }
  await appendJsonl(paths.assessments, assessment)
  return { replaced }
}

/** The authorization ledger; a missing file is an empty ledger. */
export async function loadPatches(paths: RunPaths): Promise<PatchRecord[]> {
  return (await readJson<PatchRecord[]>(paths.patches)) ?? []
}

export async function savePatches(paths: RunPaths, patches: readonly PatchRecord[]): Promise<void> {
  await writeAtomic(paths.patches, `${JSON.stringify(patches, null, 2)}\n`)
}

/** Cluster ids with no verdict yet: what `clone_report` refuses to close over. */
export function coverageGaps(clusterIds: readonly string[], latest: ReadonlyMap<string, Assessment>): string[] {
  return clusterIds.filter(id => !latest.has(id))
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm vitest run tests/ledger.spec.ts`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add -A
git commit -m "feat(core): add the shared data model and the append-only ledger"
```

---

### Task 4: `CommandRunner` 接口与宿主实现

**Files:**
- Create: `src/core/command.ts`, `src/core/command-host.ts`, `tests/fixtures/fake-runner.ts`
- Test: `tests/command.spec.ts`

**Interfaces:**
- Consumes: nothing (the host implementation imports `@deepseek-ai/cordis` for the `Context` type)
- Produces: `CommandRequest`、`CommandResult`、`CommandRunner`、`fakeRunner(...)`、`hostRunner(ctx, defaults)`

**为什么是接口**：受限模式下 Node 自行 `spawn` 并捕获子进程管道输出会直接 EPERM，所以跑命令必须走宿主的 subprocess 服务；抽象出来后 `verify/`、`git/`、`detect/python.ts` 都能在测试里用假实现驱动，不需要真编译器。

- [ ] **Step 1: 写失败的测试**

`tests/fixtures/fake-runner.ts`：

```ts
/** A scriptable CommandRunner: tests never spawn a real compiler. */
import type { CommandRequest, CommandResult, CommandRunner } from '../../src/core/command.ts'

export interface FakeCall { argv: readonly string[]; cwd: string }

export interface FakeRunner extends CommandRunner {
  readonly calls: FakeCall[]
  /** Key: the joined argv prefix the test matched on. */
  readonly matched: string[]
}

/**
 * Answer commands by matching their argv prefix. An unmatched command is an
 * exit-127 result rather than a throw, so a test that forgot to script a command
 * fails on the assertion it was checking, not on an exception from the fixture.
 */
export function fakeRunner(script: Array<[prefix: string, result: Partial<CommandResult>]>): FakeRunner {
  const calls: FakeCall[] = []
  const matched: string[] = []
  return {
    calls,
    matched,
    async run(request: CommandRequest): Promise<CommandResult> {
      calls.push({ argv: request.argv, cwd: request.cwd })
      const key = request.argv.join(' ')
      for (const [prefix, result] of script) {
        if (key.startsWith(prefix)) {
          matched.push(prefix)
          return {
            argv: request.argv, cwd: request.cwd, exitCode: 0, signal: null,
            stdout: '', stderr: '', lossy: false, timedOut: false, spillPath: null,
            ...result,
          }
        }
      }
      return {
        argv: request.argv, cwd: request.cwd, exitCode: 127, signal: null,
        stdout: '', stderr: `no scripted answer for: ${key}`, lossy: false, timedOut: false, spillPath: null,
      }
    },
  }
}
```

`tests/command.spec.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { fakeRunner } from './fixtures/fake-runner.ts'

describe('fakeRunner', () => {
  it('answers by argv prefix and records every call', async () => {
    const runner = fakeRunner([['git status --porcelain', { stdout: ' M src/a.cpp\n' }]])
    const result = await runner.run({ argv: ['git', 'status', '--porcelain'], cwd: 'D:/repo', timeoutMs: 1000, signal: undefined })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe(' M src/a.cpp\n')
    expect(runner.calls).toEqual([{ argv: ['git', 'status', '--porcelain'], cwd: 'D:/repo' }])
    expect(runner.matched).toEqual(['git status --porcelain'])
  })

  it('returns exit 127 for an unscripted command instead of throwing', async () => {
    const runner = fakeRunner([])
    const result = await runner.run({ argv: ['msbuild', 'tests.sln'], cwd: 'D:/repo', timeoutMs: 1000, signal: undefined })
    expect(result.exitCode).toBe(127)
    expect(result.stderr).toMatch(/no scripted answer/)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run tests/command.spec.ts`
Expected: FAIL —— `Cannot find module '../../src/core/command.ts'`

- [ ] **Step 3: 实现 `src/core/command.ts`**

```ts
/**
 * The one seam through which this plugin executes anything.
 *
 * A confined Harness cannot have a plugin spawn a child and capture its pipes
 * directly, so the production implementation goes through the host's subprocess
 * service; everything else in the plugin takes this interface as a parameter.
 */

export interface CommandRequest {
  /** `argv[0]` is an executable name or path; the host resolves it. */
  argv: readonly string[]
  cwd: string
  timeoutMs: number
  /** Absent means "no caller cancellation". */
  signal: AbortSignal | undefined
}

export interface CommandResult {
  argv: readonly string[]
  cwd: string
  exitCode: number | null
  signal: string | null
  stdout: string
  stderr: string
  /** True when the retained output was truncated by the host's byte cap. */
  lossy: boolean
  timedOut: boolean
  /** When the host spilled the complete stream to disk, where it lives. */
  spillPath: string | null
}

export interface CommandRunner {
  run(request: CommandRequest): Promise<CommandResult>
}

/** The exit code of a command that never ran (host refused, no subprocess service). */
export const EXIT_NOT_RUN = -1
```

- [ ] **Step 4: 实现 `src/core/command-host.ts`**

```ts
/** The production CommandRunner: the host's subprocess service, and nothing else. */
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle, SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'
import { EXIT_NOT_RUN, type CommandRequest, type CommandResult, type CommandRunner } from './command.ts'

export interface HostRunnerDefaults {
  /** Retained bytes per stream; the host spills the rest to disk and marks it lossy. */
  maxBytes: number
  graceMs: number
}

/** True when the host exposes a subprocess provider at all. */
export function hasSubprocess(ctx: Context): boolean {
  return ctx.get('subprocess') !== undefined
}

/**
 * Run one command through the host. Every failure mode is a `CommandResult`
 * (exit code `EXIT_NOT_RUN`, or the exit facts the host reports) rather than a
 * throw: a missing compiler must produce a recorded failure, not an exception
 * that loses the run.
 */
export function hostRunner(ctx: Context, defaults: HostRunnerDefaults): CommandRunner {
  return {
    async run(request: CommandRequest): Promise<CommandResult> {
      const base = { argv: request.argv, cwd: request.cwd }
      const subprocess = ctx.get('subprocess')
      if (subprocess === undefined) {
        return { ...base, exitCode: EXIT_NOT_RUN, signal: null, stdout: '', stderr: 'This deployment has no subprocess provider, so no command could run.', lossy: false, timedOut: false, spillPath: null }
      }
      const [command, ...args] = request.argv
      if (command === undefined || command === '') {
        return { ...base, exitCode: EXIT_NOT_RUN, signal: null, stdout: '', stderr: 'The command is empty.', lossy: false, timedOut: false, spillPath: null }
      }
      const timeout = AbortSignal.timeout(request.timeoutMs)
      const signal = request.signal === undefined ? timeout : AbortSignal.any([request.signal, timeout])
      let executable: string
      try {
        executable = await subprocess.resolveExecutable(command)
      } catch (error) {
        return { ...base, exitCode: EXIT_NOT_RUN, signal: null, stdout: '', stderr: `Cannot resolve ${command}: ${message(error)}`, lossy: false, timedOut: false, spillPath: null }
      }
      let handle: SubprocessHandle
      try {
        handle = subprocess.spawn({
          argv: [executable, ...args],
          cwd: request.cwd,
          stdio: { stdin: 'ignore', stdout: { maxBytes: defaults.maxBytes }, stderr: { maxBytes: defaults.maxBytes } },
          graceMs: defaults.graceMs,
          signal,
        })
      } catch (error) {
        return { ...base, exitCode: EXIT_NOT_RUN, signal: null, stdout: '', stderr: `Cannot start ${command}: ${message(error)}`, lossy: false, timedOut: timeout.aborted, spillPath: null }
      }
      let outcome: SubprocessOutcome
      try {
        outcome = await handle.done
      } catch (error) {
        return { ...base, exitCode: EXIT_NOT_RUN, signal: null, stdout: '', stderr: `Subprocess failed before reporting an outcome: ${message(error)}`, lossy: false, timedOut: timeout.aborted, spillPath: null }
      }
      const out = handle.collected.stdout?.readFrom(0)
      const err = handle.collected.stderr?.readFrom(0)
      return {
        ...base,
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        stdout: out?.text ?? '',
        stderr: err?.text ?? '',
        lossy: out?.lossy === true || err?.lossy === true,
        // Our own deadline, not the caller's cancellation: a caller abort is a
        // cancellation, and must not be reported as a timeout the user can retry.
        timedOut: timeout.aborted && (request.signal === undefined || !request.signal.aborted),
        spillPath: out?.spillPath ?? err?.spillPath ?? null,
      }
    },
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
```

- [ ] **Step 5: 运行测试与类型检查**

Run: `pnpm vitest run tests/command.spec.ts; pnpm run typecheck`
Expected: PASS，且 typecheck 退出码 0

- [ ] **Step 6: 提交**

```bash
git add -A
git commit -m "feat(core): add the CommandRunner seam and its host implementation"
```

---

### Task 5: 基线与授权对账

**Files:**
- Create: `src/core/paths.ts`, `src/git/baseline.ts`, `src/git/reconcile.ts`
- Test: `tests/reconcile.spec.ts`

**Interfaces:**
- Consumes: `CommandRunner`（Task 4）
- Produces: `normalizePath(path)`（`src/core/paths.ts`，Task 7 的 `detect/cluster.ts` 也用它）、`parsePorcelain(text)`、`parseNameOnly(text)`、`readBaseline(runner, projectRoot)`、`createBranch(runner, projectRoot, branch)`、`checkoutFiles(runner, projectRoot, files)`、`Baseline`、`reconcile(...)`

- [ ] **Step 1: 写失败的测试**

`tests/reconcile.spec.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { parseNameOnly, parsePorcelain, readBaseline } from '../src/git/baseline.ts'
import { normalizePath } from '../src/core/paths.ts'
import { reconcile } from '../src/git/reconcile.ts'
import { fakeRunner } from './fixtures/fake-runner.ts'

describe('git output parsing', () => {
  it('reads porcelain status as repo-relative forward-slash paths', () => {
    expect(parsePorcelain(' M src/a.cpp\n?? src/b.cpp\nR  old.cpp -> new.cpp\n')).toEqual([
      'src/a.cpp', 'src/b.cpp', 'new.cpp',
    ])
  })

  it('reads a name-only diff', () => {
    expect(parseNameOnly('src/a.cpp\nmodule/laws/src/b.cpp\n\n')).toEqual(['src/a.cpp', 'module/laws/src/b.cpp'])
  })

  it('normalizes windows separators and redundant segments', () => {
    expect(normalizePath('src\\a.cpp')).toBe('src/a.cpp')
    expect(normalizePath('./src//a.cpp')).toBe('src/a.cpp')
    expect(normalizePath('src/../b.cpp')).toBe('b.cpp')
  })
})

describe('readBaseline', () => {
  it('captures head, branch and the dirty list', async () => {
    const runner = fakeRunner([
      ['git rev-parse HEAD', { stdout: 'abc123\n' }],
      ['git rev-parse --abbrev-ref HEAD', { stdout: 'main\n' }],
      ['git status --porcelain', { stdout: ' M src/a.cpp\n' }],
    ])
    const baseline = await readBaseline(runner, 'D:/repo')
    expect(baseline.head).toBe('abc123')
    expect(baseline.branch).toBe('main')
    expect(baseline.dirty).toEqual(['src/a.cpp'])
  })

  it('fails loudly when the directory is not a git work tree', async () => {
    const runner = fakeRunner([['git rev-parse HEAD', { exitCode: 128, stderr: 'not a git repository' }]])
    await expect(readBaseline(runner, 'D:/nope')).rejects.toThrow(/not a git repository|HEAD/i)
  })
})

describe('reconcile', () => {
  it('passes when every changed file is covered by the authorization ledger', () => {
    const result = reconcile(['src/a.cpp'], ['src/a.cpp'])
    expect(result).toEqual({ unauthorized: [], missing: [] })
  })

  it('flags a changed file the ledger never authorized', () => {
    const result = reconcile(['src/a.cpp', 'module/laws/src/b.cpp'], ['src/a.cpp'])
    expect(result.unauthorized).toEqual(['module/laws/src/b.cpp'])
    expect(result.missing).toEqual([])
  })

  it('flags an authorized file that is not actually changed', () => {
    const result = reconcile(['src/a.cpp'], ['src/a.cpp', 'src/gone.cpp'])
    expect(result.unauthorized).toEqual([])
    expect(result.missing).toEqual(['src/gone.cpp'])
  })

  it('ignores path flavour differences between the ledger and git', () => {
    const result = reconcile(['module\\laws\\src\\b.cpp'], ['module/laws/src/b.cpp'])
    expect(result).toEqual({ unauthorized: [], missing: [] })
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run tests/reconcile.spec.ts`
Expected: FAIL —— `Cannot find module '../src/git/baseline.ts'`

- [ ] **Step 3: 实现 `src/git/baseline.ts`**

```ts
/**
 * The baseline a run is measured against. Without it there is no way to tell
 * "what this run changed" from "what the user already had", and the whole
 * authorization story collapses.
 */
import { EXIT_NOT_RUN, type CommandRunner } from '../core/command.ts'

export interface Baseline {
  head: string
  branch: string
  /** Repo-relative forward-slash paths, dirty when the run started. */
  dirty: string[]
}

/** A porcelain v1 status line → its repo-relative path (renames keep the target). */
export function parsePorcelain(text: string): string[] {
  const files: string[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    const payload = line.length > 3 ? line.slice(3).trim() : line.trim()
    if (payload === '') continue
    const arrow = payload.lastIndexOf(' -> ')
    files.push(arrow === -1 ? payload : payload.slice(arrow + 4))
  }
  return files.map(file => file.replaceAll('\\', '/')).filter(Boolean)
}

/** `git diff --name-only` output → repo-relative forward-slash paths. */
export function parseNameOnly(text: string): string[] {
  return text.split('\n').map(line => line.trim().replaceAll('\\', '/')).filter(line => line !== '')
}

async function capture(runner: CommandRunner, cwd: string, argv: readonly string[]): Promise<string> {
  const result = await runner.run({ argv, cwd, timeoutMs: 60_000, signal: undefined })
  if (result.exitCode !== 0) {
    const detail = (result.stderr.trim() || result.stdout.trim() || `exit ${String(result.exitCode)}`).slice(0, 500)
    throw new Error(`${argv.join(' ')} failed in ${cwd}: ${detail}`)
  }
  return result.stdout
}

/** Read HEAD, the current branch and the dirty file list of one work tree. */
export async function readBaseline(runner: CommandRunner, projectRoot: string): Promise<Baseline> {
  const head = (await capture(runner, projectRoot, ['git', 'rev-parse', 'HEAD'])).trim()
  const branch = (await capture(runner, projectRoot, ['git', 'rev-parse', '--abbrev-ref', 'HEAD'])).trim()
  const status = await runner.run({ argv: ['git', 'status', '--porcelain'], cwd: projectRoot, timeoutMs: 60_000, signal: undefined })
  if (status.exitCode === EXIT_NOT_RUN) throw new Error(`Cannot read the git status of ${projectRoot}: ${status.stderr}`)
  return { head, branch, dirty: status.exitCode === 0 ? parsePorcelain(status.stdout) : [] }
}

/** Create and switch to the run's own branch; an existing branch is reused. */
export async function createBranch(runner: CommandRunner, projectRoot: string, branch: string): Promise<void> {
  const result = await runner.run({ argv: ['git', 'checkout', '-B', branch], cwd: projectRoot, timeoutMs: 60_000, signal: undefined })
  if (result.exitCode !== 0) {
    throw new Error(`Cannot create branch ${branch} in ${projectRoot}: ${(result.stderr || result.stdout).slice(0, 500)}`)
  }
}

/** Check out the baseline revision of exactly these files (the rollback path). */
export async function checkoutFiles(runner: CommandRunner, projectRoot: string, files: readonly string[]): Promise<void> {
  if (files.length === 0) return
  const result = await runner.run({ argv: ['git', 'checkout', '--', ...files], cwd: projectRoot, timeoutMs: 120_000, signal: undefined })
  if (result.exitCode !== 0) {
    throw new Error(`Cannot roll back ${files.join(', ')}: ${(result.stderr || result.stdout).slice(0, 500)}`)
  }
}
```

- [ ] **Step 3b: 实现 `src/core/paths.ts`（两个模块共用的唯一路径归一化）**

`detect/cluster.ts` 与 `git/reconcile.ts` 都要把路径归一化成"仓库相对 + 正斜杠"这一种拼写，因此归一化必须只有一份实现；`detect` 与 `git` 是互不依赖的兄弟模块，所以它落在 `core/`。

```ts
/**
 * The one spelling of a repo-relative path. Git, the detection CSV and the
 * authorization ledger all have to agree, or a file the user authorized looks
 * like a file nobody authorized.
 */
export function normalizePath(path: string): string {
  const collapsed: string[] = []
  for (const part of path.trim().replaceAll('\\', '/').split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..' && collapsed.length > 0 && collapsed[collapsed.length - 1] !== '..') collapsed.pop()
    else collapsed.push(part)
  }
  return collapsed.join('/')
}
```

- [ ] **Step 4: 实现 `src/git/reconcile.ts`**

```ts
/**
 * The authorization check: what git says changed versus what the ledger says the
 * user allowed. A mismatch freezes the run — the plugin cannot stop an edit, but
 * it can refuse to verify or submit one it never authorized.
 */
import { normalizePath } from '../core/paths.ts'

export interface ReconcileResult {
  /** Changed in the work tree, never authorized: the run freezes. */
  unauthorized: string[]
  /** Authorized but no longer changed: the ledger no longer describes reality. */
  missing: string[]
}

/** Compare the ledger's authorized files with git's actual changed files. */
export function reconcile(authorized: readonly string[], changed: readonly string[]): ReconcileResult {
  const allowed = new Set(authorized.map(normalizePath).filter(Boolean))
  const actual = new Set(changed.map(normalizePath).filter(Boolean))
  return {
    unauthorized: [...actual].filter(file => !allowed.has(file)).sort(),
    missing: [...allowed].filter(file => !actual.has(file)).sort(),
  }
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm vitest run tests/reconcile.spec.ts`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add -A
git commit -m "feat(git): add baseline capture and the authorization reconciliation"
```

---

### Task 6: run 生命周期（基线绑定）

**Files:**
- Create: `src/core/run.ts`
- Test: `tests/run.spec.ts`

**Interfaces:**
- Consumes: `Settings`（Task 1）、`runPaths` / `defaultArtifactsRoot` / `assertInsideRoot` / `newRunId` / `writeAtomic` / `readJson`（Task 2）、`readBaseline` / `createBranch`（Task 5）、`CommandRunner`（Task 4）
- Produces: `RunRecord`、`artifactsRootOf(settings, env?)`、`openRun(options)`、`loadRun(paths)`

**分支规则（写进使用文档）**：`authorization.enabled` 为真时，建 run 时切到 `clone-refactor/<run_id>`；为假时不切分支（只读 run 不该动用户的 checkout），`run.json` 里记下当时的分支名。

- [ ] **Step 1: 写失败的测试**

`tests/run.spec.ts`：

```ts
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveSettings } from '../src/config.ts'
import { artifactsRootOf, loadRun, openRun } from '../src/core/run.ts'
import { fakeRunner } from './fixtures/fake-runner.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()!() })

async function root(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'clone-run-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

const GIT_OK: Array<[string, { stdout?: string }]> = [
  ['git rev-parse HEAD', { stdout: 'abc123\n' }],
  ['git rev-parse --abbrev-ref HEAD', { stdout: 'main\n' }],
  ['git status --porcelain', { stdout: '' }],
  ['git checkout -B', { stdout: '' }],
]

describe('artifactsRootOf', () => {
  it('prefers the configured root and otherwise falls back to DSH home', () => {
    expect(artifactsRootOf(resolveSettings({ artifactsRoot: 'D:/runs' }).settings, { DSH_HOME: 'D:/home' })
      .replaceAll('\\', '/')).toContain('D:/runs')
    expect(artifactsRootOf(resolveSettings({}).settings, { DSH_HOME: 'D:/home' })
      .replaceAll('\\', '/')).toBe('D:/home/gme-clone-refactor/runs')
  })
})

describe('openRun', () => {
  it('creates a run, records the baseline, and stays on the current branch when patching is off', async () => {
    const artifactsRoot = await root()
    const runner = fakeRunner(GIT_OK)
    const { settings } = resolveSettings({ projectRoot: 'D:/repo' })
    const opened = await openRun({ settings, runner, artifactsRoot, runId: 'run-1' })
    expect(opened.created).toBe(true)
    expect(opened.record.baseline.head).toBe('abc123')
    expect(opened.record.branch).toBe('main')
    expect(opened.record.detection_provider).toBe('csv')
    expect(runner.calls.some(call => call.argv[0] === 'git' && call.argv[1] === 'checkout')).toBe(false)
    expect(await loadRun(opened.paths)).toEqual(opened.record)
  })

  it('switches to the run branch when patching is authorized', async () => {
    const artifactsRoot = await root()
    const runner = fakeRunner(GIT_OK)
    const { settings } = resolveSettings({ projectRoot: 'D:/repo', authorization: { enabled: true } })
    const opened = await openRun({ settings, runner, artifactsRoot, runId: 'run-2' })
    expect(opened.record.branch).toBe('clone-refactor/run-2')
    expect(opened.record.original_branch).toBe('main')
    expect(runner.calls.some(call => call.argv.join(' ') === 'git checkout -B clone-refactor/run-2')).toBe(true)
  })

  it('resumes an existing run instead of re-baselining it', async () => {
    const artifactsRoot = await root()
    const runner = fakeRunner(GIT_OK)
    const { settings } = resolveSettings({ projectRoot: 'D:/repo' })
    await openRun({ settings, runner, artifactsRoot, runId: 'run-3' })
    const callsAfterCreate = runner.calls.length
    const resumed = await openRun({ settings, runner, artifactsRoot, runId: 'run-3' })
    expect(resumed.created).toBe(false)
    expect(runner.calls.length).toBe(callsAfterCreate)
    expect(resumed.record.created_at).toBe(resumed.record.updated_at)
  })

  it('refuses to start on a dirty work tree unless the operator allowed it', async () => {
    const artifactsRoot = await root()
    const dirty: Array<[string, { stdout?: string }]> = [
      ['git rev-parse HEAD', { stdout: 'abc123\n' }],
      ['git rev-parse --abbrev-ref HEAD', { stdout: 'main\n' }],
      ['git status --porcelain', { stdout: ' M src/a.cpp\n' }],
    ]
    await expect(openRun({ settings: resolveSettings({ projectRoot: 'D:/repo' }).settings, runner: fakeRunner(dirty), artifactsRoot, runId: 'run-4' }))
      .rejects.toThrow(/not clean.*workdir\.allowDirty/is)
    const allowed = resolveSettings({ projectRoot: 'D:/repo', workdir: { allowDirty: true } }).settings
    const opened = await openRun({ settings: allowed, runner: fakeRunner(dirty), artifactsRoot, runId: 'run-5' })
    expect(opened.record.baseline.dirty).toEqual(['src/a.cpp'])
  })

  it('rejects a run id that escapes the artifacts root', async () => {
    const artifactsRoot = await root()
    await expect(openRun({ settings: resolveSettings({ projectRoot: 'D:/repo' }).settings, runner: fakeRunner(GIT_OK), artifactsRoot, runId: '../evil' }))
      .rejects.toThrow(/escapes/)
  })

  it('refuses to run without a project root', async () => {
    await expect(openRun({ settings: resolveSettings({}).settings, runner: fakeRunner(GIT_OK), artifactsRoot: 'D:/runs', runId: 'run-6' }))
      .rejects.toThrow(/projectRoot/)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run tests/run.spec.ts`
Expected: FAIL —— `Cannot find module '../src/core/run.ts'`

- [ ] **Step 3: 实现 `src/core/run.ts`**

```ts
/**
 * The run lifecycle. A run is bound to one work tree and one baseline: without
 * that binding the authorization reconciliation cannot tell this run's edits
 * from the user's own, and every later tool must keep using the same pair.
 */
import { resolve } from 'node:path'
import type { DetectionProvider, Settings } from '../config.ts'
import { assertInsideRoot, defaultArtifactsRoot, newRunId, readJson, runPaths, writeAtomic, type RunPaths } from './artifacts.ts'
import type { CommandRunner } from './command.ts'
import { createBranch, readBaseline, type Baseline } from '../git/baseline.ts'

export interface RunRecord {
  run_id: string
  project_root: string
  baseline: Baseline
  /** The branch this run works on: `clone-refactor/<id>` only when patching is authorized. */
  branch: string
  /** The branch the user was on when the run started. */
  original_branch: string
  detection_provider: DetectionProvider
  /** Which clustering implementation produced the clusters. */
  cluster_path: 'inline'
  created_at: string
  updated_at: string
  /** The configuration this run started with: a later config change must not rewrite history. */
  settings: Settings
}

/** Where this deployment's runs live: the configured root, else the DSH home default. */
export function artifactsRootOf(settings: Settings, env: NodeJS.ProcessEnv = process.env): string {
  return settings.artifactsRoot === '' ? defaultArtifactsRoot(env) : resolve(settings.artifactsRoot)
}

export async function loadRun(paths: RunPaths): Promise<RunRecord | undefined> {
  return await readJson<RunRecord>(paths.runJson)
}

export interface OpenRunOptions {
  settings: Settings
  runner: CommandRunner
  artifactsRoot: string
  runId?: string
  now?: Date
}

export interface OpenedRun {
  record: RunRecord
  paths: RunPaths
  created: boolean
}

/**
 * Create a run, or resume the one with this id. Resuming never re-reads the
 * baseline: the whole point of the record is that it is fixed at creation.
 */
export async function openRun(options: OpenRunOptions): Promise<OpenedRun> {
  const { settings, runner, artifactsRoot } = options
  if (settings.projectRoot === '') {
    throw new Error('projectRoot is not configured; set GME_CLONE_REFACTOR_ROOT before starting Harness or override the gme-clone-refactor row')
  }
  const runId = options.runId?.trim() ?? newRunId(options.now ?? new Date())
  assertInsideRoot(artifactsRoot, runId)
  const paths = runPaths(artifactsRoot, runId)
  const existing = await loadRun(paths)
  if (existing !== undefined) return { record: existing, paths, created: false }

  const baseline = await readBaseline(runner, settings.projectRoot)
  if (baseline.dirty.length > 0 && !settings.workdir.allowDirty) {
    throw new Error(
      `The work tree ${settings.projectRoot} is not clean (${baseline.dirty.length} changed file(s)). `
      + 'Commit or stash them, or set workdir.allowDirty: true to record a hashed baseline and reconcile against the ledger only.',
    )
  }
  const branch = settings.authorization.enabled ? `clone-refactor/${runId}` : baseline.branch
  if (settings.authorization.enabled) await createBranch(runner, settings.projectRoot, branch)
  const stamp = (options.now ?? new Date()).toISOString()
  const record: RunRecord = {
    run_id: runId,
    project_root: settings.projectRoot,
    baseline,
    branch,
    original_branch: baseline.branch,
    detection_provider: settings.detection.provider,
    cluster_path: 'inline',
    created_at: stamp,
    updated_at: stamp,
    settings,
  }
  await writeAtomic(paths.runJson, `${JSON.stringify(record, null, 2)}\n`)
  return { record, paths, created: true }
}

/** Persist a mutated run record (status, provider choice, timestamps). */
export async function saveRun(paths: RunPaths, record: RunRecord, now: Date = new Date()): Promise<RunRecord> {
  const updated: RunRecord = { ...record, updated_at: now.toISOString() }
  await writeAtomic(paths.runJson, `${JSON.stringify(updated, null, 2)}\n`)
  return updated
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run tests/run.spec.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "feat(core): add the run lifecycle with a fixed baseline and work tree"
```

---

### Task 7: 检测层 —— provider 接口与内联结构分簇

**Files:**
- Create: `src/detect/provider.ts`, `src/detect/cluster.ts`, `src/detect/csv.ts`
- Create: `tests/fixtures/sample_func_clone.csv`
- Test: `tests/cluster.spec.ts`

**Interfaces:**
- Consumes: `Cluster` / `ClonePair` / `ClonePairSide`（Task 3）、`Settings`（Task 1）
- Produces: `CloneDetector`、`DetectInput`、`parseCsv(text)`、`recordsOf(header, rows)`、`clustersFromRecords(records)`、`MAX_REPRESENTATIVE_BODY_CHARS`、`csvDetector()`

**范围声明（来自 spec §7）**：只做结构分簇 —— 列别名解析、路径归一化、配对图连通分量、代表对、证据截断。**不做** `body_skeleton` / `body_behavior_signature` 比对与 8 组风险正则；风险判断由模型读真实源码完成。

- [ ] **Step 1: 写夹具与失败的测试**

`tests/fixtures/sample_func_clone.csv`（四组列别名各出现一次，并用一个带逗号与换行的引号字段覆盖 CSV 转义）：

```csv
pair_id,Path1,Function1,line_range1,file2,func2_name,lines2,similarity,detection_method,code1,code2
p1,module/laws/src/a.cpp,ComputeArea,"10-20",module/laws/src/b.cpp,CalcArea,"30-40",0.95,type12,"int x, y;","int u, v;"
p2,module/laws/src/b.cpp,CalcArea,"30-40",module/laws/src/c.cpp,AreaHelper,"50-60",0.88,type34,"int u, v;","double scale;"
p3,module\laws\src\z.cpp,Orphan,"70-80",module/laws/src/y.cpp,Orphan2,"90-100",0.4,type12,,
p4,module/laws/src/a.cpp,ComputeArea,"10-20",module/laws/src/c.cpp,AreaHelper,"50-60",0.99,type34,"int x, y;","""quoted, value"""
```

`tests/cluster.spec.ts`：

```ts
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run tests/cluster.spec.ts`
Expected: FAIL —— `Cannot find module '../src/detect/cluster.ts'`

- [ ] **Step 3: 实现 `src/detect/cluster.ts`**

```ts
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

/** Group CSV records into clone families, in first-appearance order with P-prefixed ids. */
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
      functions: [...new Set([...nodes.values()].map(node => node.function).filter(name => name !== ''))].sort(),
    }
  })
}
```

- [ ] **Step 4: 实现 `src/detect/provider.ts` 与 `src/detect/csv.ts`**

`src/detect/provider.ts`：

```ts
/** Where candidate clusters come from. The only detection seam there is. */
import type { Cluster } from '../core/schema.ts'
import type { CommandRunner } from '../core/command.ts'
import type { Settings } from '../config.ts'
import type { RunPaths } from '../core/artifacts.ts'

export interface DetectInput {
  settings: Settings
  runner: CommandRunner
  paths: RunPaths
  /** GME module name. Only the python-pipeline provider reads this. */
  module: string
  /** An explicit CSV to read, overriding `detection.csvPath`. Only the csv provider reads this. */
  csvPath: string
  signal: AbortSignal | undefined
}

export interface DetectResult {
  clusters: Cluster[]
  /** Which implementation answered: recorded on the run and in every report. */
  provider: string
  /** Where the raw detection artifacts were kept. */
  artifacts: string[]
}

export interface CloneDetector {
  readonly id: string
  detect(input: DetectInput): Promise<DetectResult>
}
```

`src/detect/csv.ts`：

```ts
/** The zero-dependency detector: read a `func_clone_<module>.csv` that already exists. */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { clustersFromRecords, parseCsv, recordsOf } from './cluster.ts'
import type { CloneDetector, DetectInput, DetectResult } from './provider.ts'

/**
 * Resolve which CSV this call reads: the caller's explicit `csv_path` first, then
 * the configured `detection.csvPath`. The caller's `module` is deliberately NOT
 * consulted — with the csv provider a module name would resolve to a nonexistent
 * file next to the process working directory, and silently scanning the wrong
 * report is worse than refusing to scan at all.
 */
export function resolveCsvPath(input: DetectInput): string {
  const explicit = input.csvPath.trim()
  if (explicit !== '') return resolve(explicit)
  if (input.settings.detection.csvPath !== '') return resolve(input.settings.detection.csvPath)
  throw new Error('No CSV to scan: pass csv_path, or set detection.csvPath in the profile row')
}

export function csvDetector(): CloneDetector {
  return {
    id: 'csv',
    async detect(input: DetectInput): Promise<DetectResult> {
      const file = resolveCsvPath(input)
      const text = await readFile(file, 'utf8')
      const { header, rows } = parseCsv(text)
      const clusters = clustersFromRecords(recordsOf(header, rows))
      return { clusters, provider: 'csv', artifacts: [file] }
    },
  }
}
```

- [ ] **Step 5: 运行测试与类型检查**

Run: `pnpm vitest run tests/cluster.spec.ts; pnpm run typecheck`
Expected: PASS，且 typecheck 退出码 0

- [ ] **Step 6: 提交**

```bash
git add -A
git commit -m "feat(detect): add the detector seam and inline structural clustering"
```

---

### Task 8: Python 管线检测 provider

**Files:**
- Create: `src/detect/python.ts`
- Test: `tests/python-detect.spec.ts`

**Interfaces:**
- Consumes: `CloneDetector` / `DetectInput` / `DetectResult`（Task 7）、`clustersFromRecords` 等（Task 7）、`CommandRunner`（Task 4）、`RunPaths`（Task 2）
- Produces: `buildDetectionArgv(options)`、`redactArgv(argv, secrets)`、`pythonDetector()`

**为什么保留它**：Type3-4 的 embedding 语义克隆只有这条管线有；`csv` provider 覆盖不了它。两条路径的差异必须在报告里可见（`provider: python-pipeline` / `csv`）。

- [ ] **Step 1: 写失败的测试**

`tests/python-detect.spec.ts`：

```ts
import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveSettings } from '../src/config.ts'
import { runPaths } from '../src/core/artifacts.ts'
import { buildDetectionArgv, pythonDetector, redactArgv } from '../src/detect/python.ts'
import { fakeRunner } from './fixtures/fake-runner.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()!() })

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'clone-python-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

describe('buildDetectionArgv', () => {
  it('passes the module, the GME root, the output root and the embedding options', () => {
    const settings = resolveSettings({
      projectRoot: 'D:/gme',
      detection: { pythonPath: 'py.exe', scriptPath: 'D:/agent/docs/.codex/skills/cpp-clone-detection/scripts/run_gme_clone_detection.py', libclang: 'D:/llvm/libclang.dll', enableType34: true, embeddingApiBase: 'https://embed.example/v1', embeddingApiKey: 'secret-key' },
    }).settings
    const argv = buildDetectionArgv({ settings, module: 'base', outputRoot: 'D:/runs/r1/detection' })
    expect(argv.slice(0, 3)).toEqual(['py.exe', '-u', settings.detection.scriptPath])
    expect(argv).toContain('--module'); expect(argv).toContain('base')
    expect(argv).toContain('--gme-root'); expect(argv).toContain('D:/gme')
    expect(argv).toContain('--output-root'); expect(argv).toContain('D:/runs/r1/detection')
    expect(argv).toContain('--libclang'); expect(argv).toContain('D:/llvm/libclang.dll')
    expect(argv).toContain('--embedding-commercial-api-base')
    expect(argv).toContain('--enable-type34')
    expect(argv).toContain('--type34-threshold'); expect(argv).toContain('0.8')
  })

  it('asks for type 3-4 to be skipped when it is off', () => {
    const settings = resolveSettings({ projectRoot: 'D:/gme', detection: { scriptPath: 'x.py' } }).settings
    const argv = buildDetectionArgv({ settings, module: 'laws', outputRoot: 'D:/out' })
    expect(argv).toContain('--disable-type34')
    expect(argv).not.toContain('--enable-type34')
  })
})

describe('redactArgv', () => {
  it('replaces a secret wherever it appears', () => {
    expect(redactArgv(['py', '--key', 'secret-key', '--x', 'secret-key'], ['secret-key']))
      .toEqual(['py', '--key', '[redacted]', '--x', '[redacted]'])
  })
})

describe('pythonDetector', () => {
  it('runs the pipeline and reads the merged CSV it produced', async () => {
    const dir = await workspace()
    const paths = runPaths(dir, 'r1')
    const settings = resolveSettings({ projectRoot: 'D:/gme', detection: { pythonPath: 'py.exe', scriptPath: 'D:/agent/run.py' } }).settings
    // The pipeline writes <output-root>/<module>/func_clone_<module>.csv.
    await mkdir(join(paths.detectionDir, 'base'), { recursive: true })
    await writeFile(join(paths.detectionDir, 'base', 'func_clone_base.csv'),
      'pair_id,file1,func1_name,lines1,file2,func2_name,lines2,similarity\np1,a.cpp,f,1-2,b.cpp,g,3-4,0.9\n')
    const runner = fakeRunner([['py.exe -u D:/agent/run.py', { stdout: 'done\n' }]])
    const result = await pythonDetector().detect({
      settings, runner, paths, module: 'base', csvPath: '', signal: undefined,
    })
    expect(result.provider).toBe('python-pipeline')
    expect(result.clusters).toHaveLength(1)
    expect(result.artifacts[0]?.replaceAll('\\', '/')).toBe(join(paths.detectionDir, 'base', 'func_clone_base.csv').replaceAll('\\', '/'))
    expect(runner.calls[0]?.cwd).toBe('D:/gme')
  })

  it('fails with the pipeline log when the command exits non-zero', async () => {
    const dir = await workspace()
    const paths = runPaths(dir, 'r1')
    const settings = resolveSettings({ projectRoot: 'D:/gme', detection: { pythonPath: 'py.exe', scriptPath: 'D:/agent/run.py' } }).settings
    const runner = fakeRunner([['py.exe', { exitCode: 1, stderr: 'ModuleNotFoundError: libclang' }]])
    await expect(pythonDetector().detect({ settings, runner, paths, module: 'base', csvPath: '', signal: undefined }))
      .rejects.toThrow(/libclang/)
  })

  it('fails when the pipeline reports success but wrote no CSV', async () => {
    const dir = await workspace()
    const paths = runPaths(dir, 'r1')
    const settings = resolveSettings({ projectRoot: 'D:/gme', detection: { pythonPath: 'py.exe', scriptPath: 'D:/agent/run.py' } }).settings
    const runner = fakeRunner([['py.exe', { stdout: 'nothing to do\n' }]])
    await expect(pythonDetector().detect({ settings, runner, paths, module: 'base', csvPath: '', signal: undefined }))
      .rejects.toThrow(/func_clone_base\.csv/)
  })

  it('refuses to run when no script path is configured', async () => {
    const dir = await workspace()
    const settings = resolveSettings({ projectRoot: 'D:/gme' }).settings
    await expect(pythonDetector().detect({ settings, runner: fakeRunner([]), paths: runPaths(dir, 'r1'), module: 'base', csvPath: '', signal: undefined }))
      .rejects.toThrow(/detection\.scriptPath/)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run tests/python-detect.spec.ts`
Expected: FAIL —— `Cannot find module '../src/detect/python.ts'`

- [ ] **Step 3: 实现 `src/detect/python.ts`**

```ts
/**
 * The faithful detector: drive the existing GME clone-detection pipeline.
 *
 * It is the only path that produces type 3-4 (embedding) clones, and it requires
 * a Python checkout with libclang and, for type 3-4, an embeddings endpoint. The
 * `csv` detector is the self-contained alternative; which one answered is
 * recorded on the run and printed in the report, because two providers never
 * produce comparable cluster sets.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Settings } from '../config.ts'
import { ensureDir } from '../core/artifacts.ts'
import { clustersFromRecords, parseCsv, recordsOf } from './cluster.ts'
import type { CloneDetector, DetectInput, DetectResult } from './provider.ts'

export interface BuildArgvOptions {
  settings: Settings
  module: string
  outputRoot: string
}

/** The exact command line the pipeline documents, in one place. */
export function buildDetectionArgv(options: BuildArgvOptions): string[] {
  const { settings, module, outputRoot } = options
  const detection = settings.detection
  const argv = [detection.pythonPath, '-u', detection.scriptPath, '--module', module, '--output-root', outputRoot]
  if (settings.projectRoot !== '') argv.push('--gme-root', settings.projectRoot)
  if (detection.libclang !== '') argv.push('--libclang', detection.libclang)
  argv.push(detection.enableType34 ? '--enable-type34' : '--disable-type34')
  if (detection.enableType34) {
    if (detection.embeddingModel !== '') argv.push('--type34-model', detection.embeddingModel)
    if (detection.embeddingApiBase !== '') argv.push('--embedding-commercial-api-base', detection.embeddingApiBase)
    if (detection.embeddingApiKey !== '') argv.push('--embedding-commercial-api-key', detection.embeddingApiKey)
    argv.push('--type34-threshold', String(detection.embeddingThreshold))
  }
  return argv
}

/** Never write a credential into a log: replace every occurrence, wherever it sits. */
export function redactArgv(argv: readonly string[], secrets: readonly string[]): string[] {
  const present = secrets.filter(secret => secret !== '')
  return argv.map(arg => (present.some(secret => arg.includes(secret)) ? '[redacted]' : arg))
}

/** The merged CSV the pipeline writes for one module. */
export function mergedCsvPath(outputRoot: string, module: string): string {
  return join(outputRoot, module, `func_clone_${module}.csv`)
}

export function pythonDetector(): CloneDetector {
  return {
    id: 'python-pipeline',
    async detect(input: DetectInput): Promise<DetectResult> {
      const { settings, runner, paths, module, signal } = input
      if (settings.detection.scriptPath === '') {
        throw new Error('detection.scriptPath is not configured, so the python-pipeline provider cannot run; set it in the profile row or use detection.provider: csv')
      }
      const target = module.trim()
      if (target === '') throw new Error('The python-pipeline provider needs a module name, for example base or laws')
      await ensureDir(paths.detectionDir)
      const argv = buildDetectionArgv({ settings, module: target, outputRoot: paths.detectionDir })
      const result = await runner.run({
        argv, cwd: settings.projectRoot,
        timeoutMs: settings.verify.steps.length > 0 ? 3_600_000 : 3_600_000,
        signal,
      })
      // Keep the invocation next to its output, with the API key redacted: the
      // run directory is the only durable record of what produced these clusters.
      await writeFile(
        join(paths.detectionDir, 'detect-command.txt'),
        `${redactArgv(argv, [settings.detection.embeddingApiKey]).join(' ')}\nexit=${String(result.exitCode)}\n\n${result.stdout}\n${result.stderr}`,
        'utf8',
      )
      if (result.exitCode !== 0) {
        const detail = (result.stderr.trim() || result.stdout.trim() || `exit ${String(result.exitCode)}`).slice(0, 2000)
        throw new Error(`The clone-detection pipeline failed (${detail})`)
      }
      const csv = mergedCsvPath(paths.detectionDir, target)
      let text: string
      try {
        text = await readFile(csv, 'utf8')
      } catch {
        throw new Error(`The pipeline exited 0 but wrote no ${`func_clone_${target}.csv`}; inspect ${paths.detectionDir}`)
      }
      const { header, rows } = parseCsv(text)
      return {
        clusters: clustersFromRecords(recordsOf(header, rows)),
        provider: 'python-pipeline',
        artifacts: [csv, join(paths.detectionDir, 'detect-command.txt')],
      }
    },
  }
}
```

- [ ] **Step 4: 运行测试与类型检查**

Run: `pnpm vitest run tests/python-detect.spec.ts; pnpm run typecheck`
Expected: PASS，且 typecheck 退出码 0

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "feat(detect): drive the existing python clone-detection pipeline"
```

---

### Task 9: 验证引擎

**Files:**
- Create: `src/verify/engine.ts`
- Test: `tests/engine.spec.ts`

**Interfaces:**
- Consumes: `VerifyStep`（Task 1）、`StepResult` / `VerifyResult`（Task 3）、`CommandRunner`（Task 4）、`RunPaths`（Task 2）
- Produces: `runVerification(options)`、`logFileFor(paths, attempt, index, name)`、`PASS_CRITERIA`

**语义（来自 spec §9）**：按顺序执行；任一步失败后，后续 **非 `always`** 步骤跳过；`always` 步骤无论前面成功失败都执行；`ok` = 所有 `required` 步骤都成功；每步写一份日志；`format-check` 这类检查步骤就是普通步骤，是否通过由退出码决定。

- [ ] **Step 1: 写失败的测试**

`tests/engine.spec.ts`：

```ts
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runPaths } from '../src/core/artifacts.ts'
import { runVerification } from '../src/verify/engine.ts'
import type { VerifyStep } from '../src/config.ts'
import { fakeRunner } from './fixtures/fake-runner.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()!() })

async function paths(): Promise<ReturnType<typeof runPaths>> {
  const root = await mkdtemp(join(tmpdir(), 'clone-engine-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  return runPaths(root, 'run-1')
}

function step(name: string, command: string, extra: Partial<VerifyStep> = {}): VerifyStep {
  return { name, phase: 'build', command, required: true, always: false, timeoutMs: 60_000, ...extra }
}

describe('runVerification', () => {
  it('passes when every required step exits zero and logs each one', async () => {
    const target = await paths()
    const runner = fakeRunner([['msbuild', { stdout: 'built\n' }], ['tests.exe', { stdout: 'ok\n' }]])
    const result = await runVerification({
      runner, paths: target, attempt: 1, cwd: 'D:/repo', signal: undefined, steps: [
        step('build', 'msbuild tests.sln'),
        step('test', 'tests.exe', { phase: 'test' }),
      ],
    })
    expect(result.ok).toBe(true)
    expect(result.steps.map(item => item.name)).toEqual(['build', 'test'])
    expect(result.rolled_back).toBe(false)
    const log = await readFile(join(target.verifyDir, '1', '1-build.log'), 'utf8')
    expect(log).toContain('msbuild tests.sln')
    expect(log).toContain('built')
    expect(log).toContain('exit_code: 0')
  })

  it('stops after a failed required step but still runs the always step', async () => {
    const target = await paths()
    const runner = fakeRunner([
      ['msbuild', { exitCode: 1, stderr: 'error C2065' }],
      ['restore.ps1', { stdout: 'restored\n' }],
    ])
    const result = await runVerification({
      runner, paths: target, attempt: 2, cwd: 'D:/repo', signal: undefined, steps: [
        step('build', 'msbuild tests.sln'),
        step('test', 'tests.exe', { phase: 'test' }),
        step('restore-config', 'restore.ps1', { phase: 'restore', required: true, always: true }),
      ],
    })
    expect(result.ok).toBe(false)
    expect(result.steps.map(item => item.name)).toEqual(['build', 'restore-config'])
    expect(result.steps[0]?.exit_code).toBe(1)
    expect(result.steps[0]?.ok).toBe(false)
    expect(result.steps[1]?.ok).toBe(true)
  })

  it('keeps ok true when a non-required step fails', async () => {
    const target = await paths()
    const runner = fakeRunner([['optional.exe', { exitCode: 3 }]])
    const result = await runVerification({
      runner, paths: target, attempt: 1, cwd: 'D:/repo', signal: undefined,
      steps: [step('optional', 'optional.exe', { required: false })],
    })
    expect(result.ok).toBe(true)
    expect(result.steps[0]?.ok).toBe(false)
  })

  it('marks a timed-out step and never reports it as success', async () => {
    const target = await paths()
    const runner = fakeRunner([['slow.exe', { exitCode: null, signal: 'SIGTERM', timedOut: true }]])
    const result = await runVerification({
      runner, paths: target, attempt: 1, cwd: 'D:/repo', signal: undefined, steps: [step('slow', 'slow.exe')],
    })
    expect(result.ok).toBe(false)
    expect(result.steps[0]?.timed_out).toBe(true)
  })

  it('records the lossy flag so a truncated log is never mistaken for a full one', async () => {
    const target = await paths()
    const runner = fakeRunner([['noisy.exe', { lossy: true, spillPath: 'D:/spill.txt' }]])
    const result = await runVerification({
      runner, paths: target, attempt: 1, cwd: 'D:/repo', signal: undefined, steps: [step('noisy', 'noisy.exe')],
    })
    expect(result.steps[0]?.lossy).toBe(true)
    const log = await readFile(join(target.verifyDir, '1', '1-noisy.log'), 'utf8')
    expect(log).toContain('spill: D:/spill.txt')
  })

  it('runs the steps in a caller-supplied work directory', async () => {
    const target = await paths()
    const runner = fakeRunner([['msbuild', {}]])
    await runVerification({ runner, paths: target, attempt: 1, cwd: 'D:/repo', signal: undefined, steps: [step('build', 'msbuild x.sln')] })
    expect(runner.calls[0]?.cwd).toBe('D:/repo')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run tests/engine.spec.ts`
Expected: FAIL —— `Cannot find module '../src/verify/engine.ts'`

- [ ] **Step 3: 实现 `src/verify/engine.ts`**

```ts
/**
 * The verification pipeline: a declarative step list, not a port of the Python
 * backend's BuildTestPipeline.
 *
 * That pipeline exists to serialise parallel workers, parse compiler output and
 * write database rows. A single-run plugin whose model is in the loop needs none
 * of that: it has to run commands, judge exit codes, keep the logs as evidence,
 * and make sure a restore step runs even after a failure. Compile-error repair
 * is not ported either — the backend needed a `compile-fixer` strategy because it
 * was unattended, while here the model reads the log itself.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { VerifyStep } from '../config.ts'
import type { RunPaths } from '../core/artifacts.ts'
import type { CommandRunner } from '../core/command.ts'
import type { StepResult, VerifyResult } from '../core/schema.ts'

/** Humans read this in the report to know what "passed" meant. */
export const PASS_CRITERIA = 'Every required step exited 0; a step that times out or is killed never passes.'

export interface EngineOptions {
  runner: CommandRunner
  paths: RunPaths
  steps: readonly VerifyStep[]
  cwd: string
  attempt: number
  signal: AbortSignal | undefined
  now?: () => Date
  /** Called after each step, so a poller can report progress mid-pipeline. */
  onStep?: (result: StepResult) => Promise<void> | void
}

export function logFileFor(paths: RunPaths, attempt: number, index: number, name: string): string {
  const safe = name.replaceAll(/[^\w.-]+/g, '-')
  return join(paths.verifyDir, String(attempt), `${index}-${safe}.log`)
}

function renderLog(step: VerifyStep, result: StepResult, cwd: string, stdout: string, stderr: string, spillPath: string | null): string {
  const lines = [
    `step: ${step.name}`,
    `phase: ${step.phase}`,
    `command: ${step.command}`,
    `cwd: ${cwd}`,
    `required: ${String(step.required)}`,
    `always: ${String(step.always)}`,
    `exit_code: ${String(result.exit_code)}`,
    `signal: ${result.exit_code === null ? 'killed or never started' : 'none'}`,
    `timed_out: ${String(result.timed_out)}`,
    `lossy: ${String(result.lossy)}`,
  ]
  if (spillPath !== null) lines.push(`spill: ${spillPath}`)
  lines.push('', '--- stdout ---', stdout, '', '--- stderr ---', stderr, '')
  return lines.join('\n')
}

/** Run the configured steps and return the recorded outcome of one attempt. */
export async function runVerification(options: EngineOptions): Promise<VerifyResult> {
  const now = options.now ?? (() => new Date())
  const startedAt = now().toISOString()
  const attemptDir = join(options.paths.verifyDir, String(options.attempt))
  await mkdir(attemptDir, { recursive: true })
  const results: StepResult[] = []
  let failed = false
  for (const [index, step] of options.steps.entries()) {
    if (failed && !step.always) continue
    const result = await options.runner.run({
      // `command` is a whole command line by design: build and test invocations
      // differ per site, and every shipped profile is a documented example.
      argv: splitCommand(step.command),
      cwd: options.cwd,
      timeoutMs: step.timeoutMs,
      signal: options.signal,
    })
    const ok = result.exitCode === 0 && !result.timedOut
    const stepResult: StepResult = {
      name: step.name,
      phase: step.phase,
      command: step.command,
      required: step.required,
      always: step.always,
      exit_code: result.exitCode,
      ok,
      timed_out: result.timedOut,
      log_file: logFileFor(options.paths, options.attempt, index + 1, step.name),
      lossy: result.lossy,
    }
    await mkdir(attemptDir, { recursive: true })
    await writeFile(stepResult.log_file, renderLog(step, stepResult, options.cwd, result.stdout, result.stderr, result.spillPath), 'utf8')
    results.push(stepResult)
    // Only a required step can fail the run: an optional step that fails is
    // bookkeeping, not evidence about the patch. An `always` step that fails is
    // still recorded, and still counts when it is required.
    if (!ok && step.required) failed = true
    await options.onStep?.(stepResult)
  }
  return {
    attempt: options.attempt,
    ok: !results.some(result => result.required && !result.ok),
    started_at: startedAt,
    finished_at: now().toISOString(),
    steps: results,
    rolled_back: false,
    rollback_files: [],
  }
}

/**
 * Split a configured command line into argv. Quoted segments survive, because a
 * site path with spaces is the normal case on Windows.
 */
export function splitCommand(command: string): string[] {
  const argv: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let started = false
  for (const char of command) {
    if (quote !== null) {
      if (char === quote) quote = null
      else current += char
      continue
    }
    if (char === '"' || char === "'") { quote = char; started = true; continue }
    if (char === ' ' || char === '\t') {
      if (started || current !== '') { argv.push(current); current = ''; started = false }
      continue
    }
    current += char
    started = true
  }
  if (started || current !== '') argv.push(current)
  return argv
}
```

> 注：`failed` 只由 `required` 步骤置位；`always` 步骤即使失败也会被记录，并在它是 `required` 时照常计入。

- [ ] **Step 4: 运行测试与类型检查**

Run: `pnpm vitest run tests/engine.spec.ts; pnpm run typecheck`
Expected: PASS，且 typecheck 退出码 0

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "feat(verify): add the declarative step engine with always-restore semantics"
```

---

### Task 10: 持久化后台 job

**Files:**
- Create: `src/core/jobs.ts`
- Test: `tests/jobs.spec.ts`

**Interfaces:**
- Consumes: `RunPaths` / `writeAtomic` / `readJson`（Task 2）、`newRunId`（Task 2）
- Produces: `JOB_KINDS`、`JobKind`、`JobRecord`、`newJobId(kind, now?, rand?)`、`startJob(paths, runId, kind)`、`finishJob(paths, job, status, error, summary)`、`loadJob(paths, jobId)`、`latestJob(paths)`、`detach(paths, job, task, summarize?)`

**为什么落盘**：检测与验证都是分钟级任务，工具必须立即返回 `accepted` 并由 `clone_check` 轮询。进程被重载后内存里的状态就没了，而 run 目录是唯一可靠的进度来源 —— 一个停在 `running` 的 job 就是"被中断"，报告必须照实说，而不是假装成功。

- [ ] **Step 1: 写失败的测试**

`tests/jobs.spec.ts`：

```ts
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runPaths } from '../src/core/artifacts.ts'
import { detach, finishJob, latestJob, loadJob, newJobId, startJob } from '../src/core/jobs.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()!() })

async function paths(): Promise<ReturnType<typeof runPaths>> {
  const root = await mkdtemp(join(tmpdir(), 'clone-jobs-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  return runPaths(root, 'run-1')
}

describe('job records', () => {
  it('builds a sortable id that names its kind', () => {
    expect(newJobId('verify', new Date('2026-09-20T01:02:03Z'), () => 0.5)).toBe('verify-20260920-010203-8000')
  })

  it('round-trips a running then finished job', async () => {
    const target = await paths()
    const job = await startJob(target, 'run-1', 'scan')
    expect(job.status).toBe('running')
    expect((await loadJob(target, job.job_id))?.status).toBe('running')
    await finishJob(target, job, 'succeeded', null, '12 clusters')
    const stored = await loadJob(target, job.job_id)
    expect(stored?.status).toBe('succeeded')
    expect(stored?.summary).toBe('12 clusters')
    expect(stored?.finished_at).not.toBeNull()
    expect((await latestJob(target))?.job_id).toBe(job.job_id)
  })

  it('returns undefined when no job was ever recorded', async () => {
    expect(await latestJob(await paths())).toBeUndefined()
    expect(await loadJob(await paths(), 'nope')).toBeUndefined()
  })
})

describe('detach', () => {
  it('records success and the summary a poller reads', async () => {
    const target = await paths()
    const job = await startJob(target, 'run-1', 'scan')
    detach(target, job, async () => 42, value => `answered ${String(value)}`)
    for (let attempt = 0; attempt < 50 && (await loadJob(target, job.job_id))?.status === 'running'; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    const stored = await loadJob(target, job.job_id)
    expect(stored?.status).toBe('succeeded')
    expect(stored?.summary).toBe('answered 42')
    expect((await latestJob(target))?.job_id).toBe(job.job_id)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run tests/jobs.spec.ts`
Expected: FAIL —— `Cannot find module '../src/core/jobs.ts'`

- [ ] **Step 3: 实现 `src/core/jobs.ts`**

```ts
/**
 * Persisted job records: the only progress source that survives a reload.
 *
 * A job left `running` is an interrupted job, and the report says so. Anything
 * else would let a killed verification read as a passed one.
 */
import { join } from 'node:path'
import { readJson, writeAtomic, type RunPaths } from './artifacts.ts'

export const JOB_KINDS = ['scan', 'verify'] as const
export type JobKind = typeof JOB_KINDS[number]
export type JobStatus = 'running' | 'succeeded' | 'failed'

export interface JobRecord {
  job_id: string
  run_id: string
  kind: JobKind
  status: JobStatus
  started_at: string
  finished_at: string | null
  error: string | null
  summary: string
}

/** `<kind>-<YYYYMMDD-HHMMSS>-<4 hex>`: sortable, and obvious in a directory listing. */
export function newJobId(kind: JobKind, now: Date = new Date(), rand: () => number = Math.random): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0')
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`
    + `-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
  return `${kind}-${stamp}-${Math.floor(rand() * 0x10000).toString(16).padStart(4, '0')}`
}

function jobFile(paths: RunPaths, jobId: string): string {
  return join(paths.dir, 'jobs', `${jobId}.json`)
}

export async function loadJob(paths: RunPaths, jobId: string): Promise<JobRecord | undefined> {
  return await readJson<JobRecord>(jobFile(paths, jobId))
}

export async function saveJob(paths: RunPaths, job: JobRecord): Promise<void> {
  await writeAtomic(jobFile(paths, job.job_id), `${JSON.stringify(job, null, 2)}\n`)
}

/** Record a job as running before its work starts. */
export async function startJob(paths: RunPaths, runId: string, kind: JobKind, now: Date = new Date()): Promise<JobRecord> {
  const job: JobRecord = {
    job_id: newJobId(kind, now),
    run_id: runId,
    kind,
    status: 'running',
    started_at: now.toISOString(),
    finished_at: null,
    error: null,
    summary: '',
  }
  await saveJob(paths, job)
  return job
}

export async function finishJob(
  paths: RunPaths,
  job: JobRecord,
  status: Exclude<JobStatus, 'running'>,
  error: string | null,
  summary: string,
  now: Date = new Date(),
): Promise<JobRecord> {
  const finished: JobRecord = { ...job, status, error, summary, finished_at: now.toISOString() }
  await saveJob(paths, finished)
  return finished
}

/** The newest job of a run, by start time then id: what a poller reports. */
export async function latestJob(paths: RunPaths): Promise<JobRecord | undefined> {
  const { readdir } = await import('node:fs/promises')
  let names: string[]
  try {
    names = await readdir(join(paths.dir, 'jobs'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const jobs = (await Promise.all(names.filter(name => name.endsWith('.json')).map(name => loadJob(paths, name.slice(0, -5)))))
    .filter((job): job is JobRecord => job !== undefined)
  if (jobs.length === 0) return undefined
  return jobs.sort((left, right) => (left.started_at === right.started_at
    ? left.job_id.localeCompare(right.job_id)
    : left.started_at.localeCompare(right.started_at))).at(-1)
}

export interface SettleOptions {
  paths: RunPaths
  job: JobRecord
}

/**
 * Await one task under an existing job record, writing the terminal status in
 * both directions. `detach` reuses it for the background case, so success and
 * failure are recorded by exactly one code path.
 */
async function settle<T>(options: SettleOptions, task: () => Promise<T>, summarize?: (value: T) => string): Promise<T> {
  try {
    const value = await task()
    await finishJob(options.paths, options.job, 'succeeded', null, summarize?.(value) ?? '')
    return value
  } catch (error) {
    await finishJob(options.paths, options.job, 'failed', error instanceof Error ? error.message : String(error), '')
      .catch(() => { /* best effort: the record is gone but the caller's log still gets the error */ })
    throw error
  }
}

/**
 * Hand a job's work to the background, so a tool call can return `accepted`
 * immediately. Every outcome — including a rejection — lands in the record,
 * because the tool call is over by the time it happens and `clone_check` is the
 * only thing that will ever look at it again.
 */
export function detach<T>(paths: RunPaths, job: JobRecord, task: () => Promise<T>, summarize?: (value: T) => string): void {
  void settle({ paths, job }, task, summarize).catch(() => { /* recorded above */ })
}
```

- [ ] **Step 1b: 测试 `detach` 的失败也要落盘**

在 `tests/jobs.spec.ts` 追加：

```ts
it('records a detached failure without an unhandled rejection', async () => {
  const target = await paths()
  const job = await startJob(target, 'run-1', 'scan')
  detach(target, job, async () => { throw new Error('pipeline exploded') })
  // The record is written from a detached task, so poll rather than assume a tick.
  for (let attempt = 0; attempt < 50 && (await loadJob(target, job.job_id))?.status === 'running'; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  const stored = await loadJob(target, job.job_id)
  expect(stored?.status).toBe('failed')
  expect(stored?.error).toMatch(/pipeline exploded/)
})
```

- [ ] **Step 4: 运行测试与类型检查**

Run: `pnpm vitest run tests/jobs.spec.ts; pnpm run typecheck`
Expected: PASS，且 typecheck 退出码 0

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "feat(core): persist background job records for polling after a reload"
```

---

### Task 11: 报告（report.md / findings.json / summary.json）

**Files:**
- Create: `src/report/report.ts`, `src/report/summary.ts`
- Test: `tests/report.spec.ts`

**Interfaces:**
- Consumes: `RunRecord`（Task 6）、`Cluster` / `Assessment` / `PatchRecord` / `VerifyResult`（Task 3）、`coverageGaps`（Task 3）、`JobRecord`（Task 10）、`RunPaths` / `writeAtomic`（Task 2）
- Produces: `ReportInput`、`ReportSummary`、`summarizeReport(input)`、`renderReport(input)`、`writeReport(input)`

- [ ] **Step 1: 写失败的测试**

`tests/report.spec.ts`：

```ts
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runPaths } from '../src/core/artifacts.ts'
import { renderReport, summarizeReport, writeReport, type ReportInput } from '../src/report/report.ts'
import type { Assessment, Cluster, PatchRecord, VerifyResult } from '../src/core/schema.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()!() })

async function paths(): Promise<ReturnType<typeof runPaths>> {
  const root = await mkdtemp(join(tmpdir(), 'clone-report-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  return runPaths(root, 'run-1')
}

const CLUSTERS: Cluster[] = [
  {
    id: 'C001', size: 2, files: ['module/laws/src/a.cpp', 'module/laws/src/b.cpp'], functions: ['ComputeArea'],
    representative: {
      pair_id: 'p1', similarity: 0.95, detection_method: 'type12',
      left: { file: 'module/laws/src/a.cpp', function: 'ComputeArea', lines: '10-20', body: 'int x;' },
      right: { file: 'module/laws/src/b.cpp', function: 'ComputeArea', lines: '30-40', body: 'int y;' },
    },
  },
  {
    id: 'C002', size: 1, files: ['module/laws/src/y.cpp', 'module/laws/src/z.cpp'], functions: [],
    representative: {
      pair_id: 'p2', similarity: 0.4, detection_method: 'type12',
      left: { file: 'module/laws/src/z.cpp', function: 'Orphan', lines: '70-80', body: '' },
      right: { file: 'module/laws/src/y.cpp', function: 'Orphan2', lines: '90-100', body: '' },
    },
  },
]

function assessment(clusterId: string, verdict: Assessment['verdict']): Assessment {
  return { cluster_id: clusterId, verdict, priority: 'P0', reason: 'same body, no API change', files_changed: verdict === 'patched' ? ['module/laws/src/a.cpp'] : [], recorded_at: '2026-09-20T00:00:00.000Z' }
}

function input(overrides: Partial<ReportInput> = {}): ReportInput {
  return {
    run: {
      run_id: 'run-1', project_root: 'D:/gme', baseline: { head: 'abc123', branch: 'main', dirty: [] },
      branch: 'clone-refactor/run-1', original_branch: 'main', detection_provider: 'csv', cluster_path: 'inline',
      created_at: '2026-09-20T00:00:00.000Z', updated_at: '2026-09-20T00:00:00.000Z',
      settings: {} as ReportInput['run']['settings'],
    },
    clusters: CLUSTERS,
    assessments: new Map([['C001', assessment('C001', 'patched')]]),
    patches: [{ cluster_id: 'C001', priority: 'P0', files_changed: ['module/laws/src/a.cpp'], recorded_at: '2026-09-20T00:00:00.000Z' }] as PatchRecord[],
    verify: [],
    job: undefined,
    droppedLines: [],
    unauthorized: [],
    notes: '',
    allowPartial: false,
    language: 'zh',
    ...overrides,
  }
}

describe('summarizeReport', () => {
  it('counts verdicts, gaps and the detection path', () => {
    const summary = summarizeReport(input())
    expect(summary.clusters).toBe(2)
    expect(summary.recorded).toBe(1)
    expect(summary.missing).toBe(1)
    expect(summary.patched).toBe(1)
    expect(summary.detection_provider).toBe('csv')
    expect(summary.cluster_path).toBe('inline')
  })
})

describe('renderReport', () => {
  it('names the detection path, the baseline and the verification result', () => {
    const verify: VerifyResult = {
      attempt: 1, ok: true, started_at: '2026-09-20T00:00:00.000Z', finished_at: '2026-09-20T00:10:00.000Z',
      rolled_back: false, rollback_files: [],
      steps: [{ name: 'build', phase: 'build', command: 'msbuild x.sln', required: true, always: false, exit_code: 0, ok: true, timed_out: false, log_file: 'D:/runs/run-1/verify/1/1-build.log', lossy: false }],
    }
    const text = renderReport(input({ verify: [verify], assessments: new Map([['C001', assessment('C001', 'patched')], ['C002', assessment('C002', 'report_only')]]) }))
    expect(text).toContain('run-1')
    expect(text).toContain('abc123')
    expect(text).toContain('csv')
    expect(text).toContain('inline')
    expect(text).toContain('msbuild x.sln')
    expect(text).toContain('C002')
  })

  it('lists the coverage gaps instead of hiding them', () => {
    const text = renderReport(input())
    expect(text).toMatch(/C002/)
  })
})

describe('writeReport', () => {
  it('refuses to close a run while a cluster has no verdict', async () => {
    const target = await paths()
    await expect(writeReport(target, input())).rejects.toThrow(/C002 .*no verdict|no verdict.*C002/s)
  })

  it('writes the three artifacts when the coverage contract holds', async () => {
    const target = await paths()
    const complete = input({
      assessments: new Map([['C001', assessment('C001', 'patched')], ['C002', assessment('C002', 'report_only')]]),
    })
    const written = await writeReport(target, complete)
    expect(written.summary.missing).toBe(0)
    expect(written.digest).toMatch(/^[0-9a-f]{16}$/)
    expect(JSON.parse(await readFile(target.summaryJson, 'utf8')).clusters).toBe(2)
    expect(JSON.parse(await readFile(target.findingsJson, 'utf8'))).toHaveLength(2)
    expect(await readFile(target.reportMd, 'utf8')).toContain('# ')
  })

  it('closes a partial run only when the caller accepts the gaps', async () => {
    const target = await paths()
    const written = await writeReport(target, input({ allowPartial: true }))
    expect(written.summary.missing).toBe(1)
    expect(await readFile(target.reportMd, 'utf8')).toMatch(/C002/)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run tests/report.spec.ts`
Expected: FAIL —— `Cannot find module '../src/report/report.ts'`

- [ ] **Step 3: 实现 `src/report/summary.ts`**

```ts
/** The machine-readable counts: what a caller checks without parsing Markdown. */
import type { Assessment, Cluster, PatchRecord, VerifyResult } from '../core/schema.ts'

export interface SummaryInput {
  clusters: readonly Cluster[]
  assessments: ReadonlyMap<string, Assessment>
  patches: readonly PatchRecord[]
  verify: readonly VerifyResult[]
}

export interface Summary {
  clusters: number
  recorded: number
  missing: number
  patched: number
  report_only: number
  skipped: number
  authorized_files: number
  verify_attempts: number
  verify_ok: boolean
}

export function summarize(input: SummaryInput): Summary {
  const verdicts = [...input.assessments.values()]
  return {
    clusters: input.clusters.length,
    recorded: input.clusters.filter(cluster => input.assessments.has(cluster.id)).length,
    missing: input.clusters.filter(cluster => !input.assessments.has(cluster.id)).length,
    patched: verdicts.filter(item => item.verdict === 'patched').length,
    report_only: verdicts.filter(item => item.verdict === 'report_only').length,
    skipped: verdicts.filter(item => item.verdict === 'skipped').length,
    authorized_files: new Set(input.patches.flatMap(patch => patch.files_changed)).size,
    verify_attempts: input.verify.length,
    verify_ok: input.verify.length > 0 && input.verify.every(attempt => attempt.ok),
  }
}
```

- [ ] **Step 4: 实现 `src/report/report.ts`**

```ts
/**
 * The closing report. Its job is to make the run auditable: which detection path
 * produced the clusters, what the baseline was, what each cluster was judged to
 * be, which files the user authorized, what the build actually said, and which
 * clusters nobody looked at yet. A report that hides a gap is worse than no report.
 */
import { createHash } from 'node:crypto'
import { writeAtomic, type RunPaths } from '../core/artifacts.ts'
import type { Assessment, Cluster, PatchRecord, VerifyResult } from '../core/schema.ts'
import type { RunRecord } from '../core/run.ts'
import type { JobRecord } from '../core/jobs.ts'
import { summarize, type Summary } from './summary.ts'

export { summarize } from './summary.ts'
export type { Summary } from './summary.ts'

export interface ReportInput {
  run: RunRecord
  clusters: readonly Cluster[]
  assessments: ReadonlyMap<string, Assessment>
  patches: readonly PatchRecord[]
  verify: readonly VerifyResult[]
  job: JobRecord | undefined
  droppedLines: readonly number[]
  /** Files a reconcile audit found changed without authorization: never hidden. */
  unauthorized: readonly string[]
  notes: string
  allowPartial: boolean
  language: 'zh' | 'en'
}

export interface ReportSummary extends Summary {
  run_id: string
  baseline_head: string
  detection_provider: string
  cluster_path: string
  unauthorized_files: string[]
  unverified: boolean
  dropped_lines: number
}

/** The counts that go into summary.json, including what could NOT be confirmed. */
export function summarizeReport(input: ReportInput): ReportSummary {
  const base = summarize({ clusters: input.clusters, assessments: input.assessments, patches: input.patches, verify: input.verify })
  return {
    ...base,
    run_id: input.run.run_id,
    baseline_head: input.run.baseline.head,
    detection_provider: input.run.detection_provider,
    cluster_path: input.run.cluster_path,
    // Straight from the reconcile audits: a file git changed that the ledger never
    // authorized is the single most important thing a report can surface.
    unauthorized_files: [...new Set(input.unauthorized)].sort(),
    // A patched cluster whose verification never completed is not a success, and
    // the summary has to say so even when the job was interrupted rather than failed.
    unverified: base.patched > 0 && !base.verify_ok,
    dropped_lines: input.droppedLines.length,
  }
}

function clusterLine(cluster: Cluster, assessment: Assessment | undefined): string {
  const verdict = assessment?.verdict ?? 'MISSING'
  const priority = assessment?.priority ?? '-'
  const reason = assessment?.reason ?? 'no verdict recorded'
  const pair = cluster.representative
  return `| ${cluster.id} | ${priority} | ${verdict} | ${cluster.size} | \`${pair.left.file}\` ↔ \`${pair.right.file}\` | ${reason} |`
}

/** Render the human report. Pure: the same input always yields the same text. */
export function renderReport(input: ReportInput): string {
  const summary = summarizeReport(input)
  const gaps = input.clusters.filter(cluster => !input.assessments.has(cluster.id)).map(cluster => cluster.id)
  const lines: string[] = [
    `# 克隆重构报告 / Clone refactor report — ${input.run.run_id}`,
    '',
    `- project root: \`${input.run.project_root}\``,
    `- baseline: \`${input.run.baseline.head}\` on \`${input.run.original_branch}\` → branch \`${input.run.branch}\``,
    `- detection provider: **${input.run.detection_provider}**`,
    `- clustering: **${input.run.cluster_path}**（结构分簇，不含骨架/行为签名比对与风险正则；风险由模型读真实源码判断）`,
    `- created: ${input.run.created_at}`,
    '',
    '## 概览 / Overview',
    '',
    `- 簇总数 clusters: ${summary.clusters}`,
    `- 已判定 recorded: ${summary.recorded}（patched ${summary.patched} / report_only ${summary.report_only} / skipped ${summary.skipped}）`,
    `- 未判定 missing: ${summary.missing}`,
    `- 授权文件 authorized files: ${summary.authorized_files}`,
    `- 验证 attempts: ${summary.verify_attempts}（ok: ${String(summary.verify_ok)}）`,
    ...(summary.unverified ? ['- ⚠️ **有已 patch 的簇没有通过的验证**；这些改动不得提交'] : []),
    '',
  ]
  if (input.run.baseline.dirty.length > 0) {
    lines.push('## 基线不干净 / Dirty baseline', '', '- 开跑时工作区已有改动（`workdir.allowDirty` 已开启）：', ...input.run.baseline.dirty.map(file => `  - \`${file}\``), '')
  }
  lines.push('## 簇与判定 / Clusters', '', '| 簇 | 优先级 | 判定 | 对数 | 代表对 | 理由 |', '|---|---|---|---|---|---|',
    ...input.clusters.map(cluster => clusterLine(cluster, input.assessments.get(cluster.id))), '')
  if (gaps.length > 0) {
    lines.push('## 覆盖缺口 / Coverage gaps', '', ...gaps.map(id => `- \`${id}\` 没有判定`), '')
  }
  if (input.patches.length > 0) {
    lines.push('## 授权与改动 / Authorized changes', '', ...input.patches.flatMap(patch => [
      `- \`${patch.cluster_id}\` (${patch.priority}) → ${patch.files_changed.map(file => `\`${file}\``).join(', ')}`,
    ]), '')
  }
  if (input.verify.length > 0) {
    lines.push('## 验证 / Verification', '')
    for (const attempt of input.verify) {
      lines.push(`### attempt ${attempt.attempt} — ${attempt.ok ? 'PASS' : 'FAIL'}`, '')
      lines.push('| 步骤 | 阶段 | 命令 | 退出码 | 结果 | 日志 |', '|---|---|---|---|---|---|')
      for (const step of attempt.steps) {
        lines.push(`| ${step.name} | ${step.phase} | \`${step.command}\` | ${String(step.exit_code)} | ${step.ok ? 'ok' : 'FAIL'} | \`${step.log_file}\` |`)
      }
      if (attempt.rolled_back) lines.push('', `已回滚 / rolled back: ${attempt.rollback_files.map(file => `\`${file}\``).join(', ')}`)
      lines.push('')
    }
  } else {
    lines.push('## 验证 / Verification', '', '- 没有跑过验证：没有 `verified` 的簇不得提交。', '')
  }
  if (summary.unauthorized_files.length > 0) {
    lines.push('## 未授权改动 / Unauthorized changes', '',
      '- 这些文件被改动，但不在授权账本里；本 run 已冻结，不得验证或提交：',
      ...summary.unauthorized_files.map(file => `  - \`${file}\``), '')
  }
  if (input.job !== undefined) {
    lines.push('## 最近的后台任务 / Last job', '', `- \`${input.job.job_id}\` (${input.job.kind}) → **${input.job.status}**${input.job.error === null ? '' : `: ${input.job.error}`}`, ...(input.job.status === 'running' ? ['- 停在 running 说明任务被中断，不是成功。'] : []), '')
  }
  if (input.droppedLines.length > 0) {
    lines.push('## 跳过的账本行 / Dropped ledger lines', '', `- findings 中 ${input.droppedLines.length} 行不是合法 JSON（行号：${input.droppedLines.join(', ')}）`, '')
  }
  if (input.notes.trim() !== '') lines.push('## 备注 / Notes', '', input.notes.trim(), '')
  return `${lines.join('\n')}\n`
}

export interface WrittenReport {
  summary: ReportSummary
  digest: string
  report_path: string
  findings_path: string
  summary_path: string
}

/** Close the run: write the three artifacts, or refuse while a cluster has no verdict. */
export async function writeReport(paths: RunPaths, input: ReportInput): Promise<WrittenReport> {
  const summary = summarizeReport(input)
  const gaps = input.clusters.filter(cluster => !input.assessments.has(cluster.id)).map(cluster => cluster.id)
  if (gaps.length > 0 && !input.allowPartial) {
    throw new Error(`Cannot close the run: ${gaps.length} cluster(s) have no verdict (${gaps.slice(0, 10).join(', ')}). Record each one with clone_assess, or accept allow_partial: true to report the gaps explicitly.`)
  }
  const report = renderReport(input)
  const findings = input.clusters.map(cluster => ({
    ...cluster,
    verdict: input.assessments.get(cluster.id)?.verdict ?? null,
    priority: input.assessments.get(cluster.id)?.priority ?? null,
    reason: input.assessments.get(cluster.id)?.reason ?? null,
    files_changed: input.assessments.get(cluster.id)?.files_changed ?? [],
  }))
  const digest = createHash('sha256').update(report).digest('hex').slice(0, 16)
  await writeAtomic(paths.reportMd, report)
  await writeAtomic(paths.findingsJson, `${JSON.stringify(findings, null, 2)}\n`)
  await writeAtomic(paths.summaryJson, `${JSON.stringify({ ...summary, digest }, null, 2)}\n`)
  return { summary, digest, report_path: paths.reportMd, findings_path: paths.findingsJson, summary_path: paths.summaryJson }
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm vitest run tests/report.spec.ts`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add -A
git commit -m "feat(report): render the auditable report and refuse to hide coverage gaps"
```

---

### Task 12: 提交与推送

**Files:**
- Create: `src/submit.ts`
- Test: `tests/submit.spec.ts`

**Interfaces:**
- Consumes: `SubmitMode`（Task 1）、`CommandRunner`（Task 4）
- Produces: `SubmitInput`、`SubmitResult`、`renderCommitMessage(template, values)`、`submit(input)`

- [ ] **Step 1: 写失败的测试**

`tests/submit.spec.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { renderCommitMessage, submit } from '../src/submit.ts'
import { fakeRunner } from './fixtures/fake-runner.ts'

const BASE = {
  runner: fakeRunner([]), projectRoot: 'D:/repo', branch: 'clone-refactor/run-1',
  remote: 'origin', baseBranch: 'main', files: ['module/laws/src/a.cpp'],
  message: 'refactor: dedupe ComputeArea', title: 'Clone refactor run-1', body: 'Deduplicated one clone family.',
  signal: undefined,
}

describe('renderCommitMessage', () => {
  it('expands the documented placeholders', () => {
    expect(renderCommitMessage('clone({cluster_id}) {files_count} {timestamp}', { cluster_id: 'C001', files_count: '2', timestamp: 'T' }))
      .toBe('clone(C001) 2 T')
  })

  it('leaves an unknown placeholder alone instead of blanking it', () => {
    expect(renderCommitMessage('x {nope} y', {})).toBe('x {nope} y')
  })
})

describe('submit', () => {
  it('runs nothing at all in the none mode', async () => {
    const runner = fakeRunner([])
    const result = await submit({ ...BASE, runner, mode: 'none' })
    expect(result.steps).toEqual([])
    expect(runner.calls).toEqual([])
  })

  it('stages exactly the authorized files and commits', async () => {
    const runner = fakeRunner([['git add', {}], ['git commit', {}]])
    const result = await submit({ ...BASE, runner, mode: 'commit' })
    expect(result.committed).toBe(true)
    expect(result.pushed).toBe(false)
    expect(runner.calls.map(call => call.argv.join(' '))).toEqual([
      'git add -- module/laws/src/a.cpp',
      'git commit -m refactor: dedupe ComputeArea',
    ])
  })

  it('pushes the run branch when asked', async () => {
    const runner = fakeRunner([['git add', {}], ['git commit', {}], ['git push', { stdout: 'ok\n' }]])
    const result = await submit({ ...BASE, runner, mode: 'push' })
    expect(result.pushed).toBe(true)
    expect(runner.calls[2]?.argv.join(' ')).toBe('git push -u origin clone-refactor/run-1')
  })

  it('opens a pull request against the configured base branch', async () => {
    const runner = fakeRunner([['git add', {}], ['git commit', {}], ['git push', {}], ['gh pr create', { stdout: 'https://github.com/x/y/pull/7\n' }]])
    const result = await submit({ ...BASE, runner, mode: 'pr' })
    expect(result.pr_url).toBe('https://github.com/x/y/pull/7')
    expect(runner.calls[3]?.argv.join(' ')).toContain('--base main')
    expect(runner.calls[3]?.argv.join(' ')).toContain('--head clone-refactor/run-1')
  })

  it('stops before the pull request when the push fails', async () => {
    const runner = fakeRunner([['git add', {}], ['git commit', {}], ['git push', { exitCode: 1, stderr: 'rejected' }]])
    await expect(submit({ ...BASE, runner, mode: 'pr' })).rejects.toThrow(/rejected/)
    expect(runner.calls.some(call => call.argv[0] === 'gh')).toBe(false)
  })

  it('refuses to commit nothing', async () => {
    await expect(submit({ ...BASE, runner: fakeRunner([]), mode: 'commit', files: [] })).rejects.toThrow(/no authorized files/)
  })

  it('never puts a credential in argv', async () => {
    const runner = fakeRunner([['git add', {}], ['git commit', {}], ['git push', {}], ['gh pr create', { stdout: 'u\n' }]])
    await submit({ ...BASE, runner, mode: 'pr' })
    // The token belongs in the environment the host provides, never in a command
    // line that the run directory records.
    expect(runner.calls.flatMap(call => [...call.argv]).join(' ')).not.toMatch(/token|secret|ghp_/i)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run tests/submit.spec.ts`
Expected: FAIL —— `Cannot find module '../src/submit.ts'`

- [ ] **Step 3: 实现 `src/submit.ts`**

```ts
/**
 * Outward actions, one mode at a time. Every caller must have taken `confirm:
 * true` first, and the plugin never supplies a credential: `gh` and `git` read
 * the credentials the host already has, so no token can leak into a command line
 * that the run directory records.
 */
import type { SubmitMode } from './config.ts'
import type { CommandRunner } from './core/command.ts'

export interface SubmitInput {
  runner: CommandRunner
  projectRoot: string
  branch: string
  remote: string
  baseBranch: string
  /** Exactly the files the authorization ledger covers. */
  files: readonly string[]
  message: string
  title: string
  body: string
  mode: SubmitMode
  signal: AbortSignal | undefined
}

export interface SubmitResult {
  mode: SubmitMode
  committed: boolean
  pushed: boolean
  pr_url: string | null
  steps: string[]
}

/** Expand `{name}` placeholders; an unknown name is left visible, never blanked. */
export function renderCommitMessage(template: string, values: Record<string, string>): string {
  return template.replaceAll(/\{(\w+)\}/g, (match, name: string) => values[name] ?? match)
}

async function run(input: SubmitInput, argv: readonly string[], steps: string[]): Promise<string> {
  const result = await input.runner.run({ argv, cwd: input.projectRoot, timeoutMs: 600_000, signal: input.signal })
  if (result.exitCode !== 0) {
    const detail = (result.stderr.trim() || result.stdout.trim() || `exit ${String(result.exitCode)}`).slice(0, 1000)
    throw new Error(`${argv.join(' ')} failed: ${detail}`)
  }
  steps.push(argv.join(' '))
  return result.stdout.trim()
}

/** Commit, then push, then open a PR — as far as `mode` allows. */
export async function submit(input: SubmitInput): Promise<SubmitResult> {
  const steps: string[] = []
  const result: SubmitResult = { mode: input.mode, committed: false, pushed: false, pr_url: null, steps }
  if (input.mode === 'none') return result
  if (input.files.length === 0) throw new Error('Cannot commit: no authorized files. Record a patched verdict with files_changed first.')
  await run(input, ['git', 'add', '--', ...input.files], steps)
  await run(input, ['git', 'commit', '-m', input.message], steps)
  result.committed = true
  if (input.mode === 'commit') return result
  await run(input, ['git', 'push', '-u', input.remote, input.branch], steps)
  result.pushed = true
  if (input.mode === 'push') return result
  const base = input.baseBranch === '' ? 'main' : input.baseBranch
  const stdout = await run(input, ['gh', 'pr', 'create', '--base', base, '--head', input.branch, '--title', input.title, '--body', input.body], steps)
  result.pr_url = stdout.split('\n').map(line => line.trim()).filter(line => line.startsWith('http')).at(-1) ?? null
  return result
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run tests/submit.spec.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "feat(submit): commit, push and open a PR strictly by mode"
```

---

### Task 13: 六个工具与插件入口

**Files:**
- Create: `src/tools.ts`, `src/index.ts`
- Test: `tests/workflow.spec.ts`（Task 14 写完整链路，本任务先写工具级测试）

**Interfaces:**
- Consumes: 本计划前 12 个任务的全部导出
- Produces: `registerTools(ctx, settings, runner, artifactsRoot)`、`name`、`inject`、`Config`、`apply(ctx, config)`、`guidanceText(settings, configured)`

- [ ] **Step 1: 写工具级测试**

`tests/workflow.spec.ts`（完整链路版本在 Task 14 追加；这里先覆盖三个约束最容易被写错的地方）：

```ts
import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { apply } from '../src/index.ts'
import { resolveSettings } from '../src/config.ts'
import { runPaths } from '../src/core/artifacts.ts'
import type { CommandRunner } from '../src/core/command.ts'
import { fakeRunner } from './fixtures/fake-runner.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()!() })

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'clone-workflow-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

const CSV_HEADER = 'pair_id,file1,func1_name,lines1,file2,func2_name,lines2,similarity,detection_method\n'
const GIT_OK: Array<[string, { stdout?: string }]> = [
  ['git rev-parse HEAD', { stdout: 'abc123\n' }],
  ['git rev-parse --abbrev-ref HEAD', { stdout: 'main\n' }],
  ['git status --porcelain', { stdout: '' }],
  ['git diff --name-only', { stdout: 'module/laws/src/a.cpp\n' }],
]

/** Mount the real plugin into a real Tools/SystemPrompt context. */
async function mount(config: Record<string, unknown>, runner: CommandRunner) {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  const { settings } = resolveSettings(config)
  const { registerTools } = await import('../src/tools.ts')
  registerTools(ctx, settings, runner, String(config.artifactsRoot))
  return ctx
}

function call(ctx: Context, name: string, args: unknown) {
  return ctx.tools.execute({ name, arguments: args, signal: new AbortController().signal, callId: ToolCallId(`clone-${name}`) })
}

/**
 * Background jobs are detached, so a test must poll the record the way the model
 * does. A fixed sleep makes the suite flaky on a cold machine; polling makes it
 * wait exactly as long as the job needs.
 */
async function settle(ctx: Context, runId: string, attempts = 200): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const text = JSON.stringify(await call(ctx, 'clone_check', { run_id: runId, what: 'status' }))
    if (!text.includes('"status":"running"')) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`run ${runId} never settled`)
}

describe('clone_assess authorization rules', () => {
  it('refuses a patched verdict without confirm, and with patching disabled', async () => {
    const root = await workspace()
    const csv = join(root, 'func_clone_base.csv')
    await writeFile(csv, `${CSV_HEADER}p1,a.cpp,f,1-2,b.cpp,g,3-4,0.9,type12\n`)
    const ctx = await mount({ projectRoot: 'D:/repo', artifactsRoot: join(root, 'runs'), detection: { provider: 'csv', csvPath: csv } }, fakeRunner(GIT_OK))
    const scan = await call(ctx, 'clone_scan', { run_id: 'r1', module: 'base' })
    expect((scan as { result?: unknown }).isError).not.toBe(true)
    // The scan is a background job: poll until it settles before assessing.
    const assess = await call(ctx, 'clone_assess', { run_id: 'r1', cluster_id: 'C001', verdict: 'patched', priority: 'P0', reason: 'x', files_changed: ['a.cpp'], confirm: true })
    expect((assess as { isError?: boolean }).isError).toBe(true)
    expect(JSON.stringify(assess)).toMatch(/authorization\.enabled/)
  })

  it('requires evidence for a P0 report_only verdict', async () => {
    const root = await workspace()
    const csv = join(root, 'func_clone_base.csv')
    await writeFile(csv, `${CSV_HEADER}p1,a.cpp,f,1-2,b.cpp,g,3-4,0.9,type12\n`)
    const ctx = await mount({ projectRoot: 'D:/repo', artifactsRoot: join(root, 'runs'), detection: { provider: 'csv', csvPath: csv } }, fakeRunner(GIT_OK))
    await call(ctx, 'clone_scan', { run_id: 'r1', module: 'base' })
    await settle(ctx, 'r1')
    const assessed = await call(ctx, 'clone_assess', { run_id: 'r1', cluster_id: 'C001', verdict: 'report_only', priority: 'P0', reason: 'a virtual call diverges' })
    expect((assessed as { isError?: boolean }).isError).toBe(true)
    expect(JSON.stringify(assessed)).toMatch(/evidence/)
  })

  it('rejects an unknown cluster id and lists what it does know', async () => {
    const root = await workspace()
    const csv = join(root, 'func_clone_base.csv')
    await writeFile(csv, `${CSV_HEADER}p1,a.cpp,f,1-2,b.cpp,g,3-4,0.9,type12\n`)
    const ctx = await mount({ projectRoot: 'D:/repo', artifactsRoot: join(root, 'runs'), detection: { provider: 'csv', csvPath: csv } }, fakeRunner(GIT_OK))
    await call(ctx, 'clone_scan', { run_id: 'r1', module: 'base' })
    await settle(ctx, 'r1')
    const assessed = await call(ctx, 'clone_assess', { run_id: 'r1', cluster_id: 'C999', verdict: 'skipped', priority: 'PX', reason: 'nope' })
    expect((assessed as { isError?: boolean }).isError).toBe(true)
    expect(JSON.stringify(assessed)).toMatch(/C001/)
  })
})

describe('clone_submit', () => {
  it('refuses to act without confirm: true', async () => {
    const root = await workspace()
    const ctx = await mount({ projectRoot: 'D:/repo', artifactsRoot: join(root, 'runs') }, fakeRunner(GIT_OK))
    const submitted = await call(ctx, 'clone_submit', { run_id: 'r1' })
    expect((submitted as { isError?: boolean }).isError).toBe(true)
    expect(JSON.stringify(submitted)).toMatch(/confirm/)
  })
})

describe('clone_report', () => {
  it('refuses to close a run with an unassessed cluster', async () => {
    const root = await workspace()
    const csv = join(root, 'func_clone_base.csv')
    await writeFile(csv, `${CSV_HEADER}p1,a.cpp,f,1-2,b.cpp,g,3-4,0.9,type12\n`)
    const ctx = await mount({ projectRoot: 'D:/repo', artifactsRoot: join(root, 'runs'), detection: { provider: 'csv', csvPath: csv } }, fakeRunner(GIT_OK))
    await call(ctx, 'clone_scan', { run_id: 'r1', module: 'base' })
    await settle(ctx, 'r1')
    const reported = await call(ctx, 'clone_report', { run_id: 'r1' })
    expect((reported as { isError?: boolean }).isError).toBe(true)
    expect(JSON.stringify(reported)).toMatch(/no verdict/)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run tests/workflow.spec.ts`
Expected: FAIL —— `Cannot find module '../src/tools.ts'`

- [ ] **Step 3: 实现 `src/tools.ts`**

```ts
/** The six tools: argument validation, authorization gates and presentation. */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { PRIORITIES, PRIORITY_RANK, type Settings } from './config.ts'
import { loadJsonlClusters, saveJsonlClusters } from './core/clusters.ts'
import { coverageGaps, loadAssessments, loadPatches, recordAssessment, savePatches } from './core/ledger.ts'
import { detach, latestJob, startJob } from './core/jobs.ts'
import { loadRun, openRun, saveRun } from './core/run.ts'
import { requireText, VERDICTS, type Assessment, type PatchRecord } from './core/schema.ts'
import { assertInsideRoot, runPaths, writeAtomic } from './core/artifacts.ts'
import { csvDetector } from './detect/csv.ts'
import { pythonDetector } from './detect/python.ts'
import { checkoutFiles, parseNameOnly, parsePorcelain } from './git/baseline.ts'
import { normalizeRepoPath, reconcile } from './git/reconcile.ts'
import { loadUnauthorized, loadVerifyAttempts, readNewestVerifyLog } from './verify/artifacts.ts'
import { writeReport } from './report/report.ts'
import { renderCommitMessage, submit } from './submit.ts'
import { runVerification } from './verify/engine.ts'
import { join } from 'node:path'

const EVIDENCE = { type: 'object', additionalProperties: false, properties: {
  file: { type: 'string', required: true, description: 'A file the cluster actually touches.' },
  line: { type: 'integer', required: true, description: 'The line of the concrete blocker or of the applied change.' },
  snippet: { type: 'string', required: true },
} } as const

function output<S extends object>(schema: S) {
  return { schema, render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }] }
}

/** Reject an unknown cluster with the ids this run does have. */
function knownCluster(ids: readonly string[], requested: string): string {
  if (!ids.includes(requested)) {
    throw new Error(`Unknown cluster_id '${requested}'. ${ids.length === 0 ? 'This run has no clusters yet — call clone_scan first.' : `Known ids: ${ids.slice(0, 20).join(', ')}`}`)
  }
  return requested
}

export function registerTools(ctx: Context, settings: Settings, runner: import('./core/command.ts').CommandRunner, artifactsRoot: string): void {
  ctx.tools.register(defineTool({
    name: 'clone_scan',
    description: 'Scan one module for clone families and record them as this run's coverage contract. Runs in the background: the result is accepted, so poll clone_check until the job settles. Every cluster this produces must end with a verdict before clone_report will close the run.',
    parameters: {
      run_id: { type: 'string', description: 'Continue an existing run, or create one under this id when none exists; the result reports created.' },
      module: { type: 'string', description: 'python-pipeline provider only: the GME module name, for example base or laws.' },
      csv_path: { type: 'string', description: 'csv provider only: the func_clone CSV to read, overriding detection.csvPath.' },
      refresh: { type: 'boolean', description: 'Scan again even when this run already has clusters.' },
    },
    output: output({ type: 'object', additionalProperties: false, properties: {
      run_id: { type: 'string', required: true }, job_id: { type: 'string', required: true },
      accepted: { type: 'boolean', required: true }, created: { type: 'boolean', required: true },
      clusters: { type: 'integer', required: true }, provider: { type: 'string', required: true },
      guidance: { type: 'string', required: true },
    } }),
    async execute(args) {
      const requested = args.run_id?.trim() === '' || args.run_id === undefined ? undefined : args.run_id
      const opened = await openRun({ settings, runner, artifactsRoot, ...(requested === undefined ? {} : { runId: requested }) })
      const existing = await loadJsonlClusters(opened.paths)
      if (existing.length > 0 && args.refresh !== true) {
        return { run_id: opened.record.run_id, job_id: '', accepted: false, created: opened.created, clusters: existing.length, provider: opened.record.detection_provider, guidance: 'Clusters already exist for this run. Pass refresh: true to scan again.' }
      }
      const detector = settings.detection.provider === 'python-pipeline' ? pythonDetector() : csvDetector()
      const runId = opened.record.run_id
      const paths = opened.paths
      // Detached on purpose: detection is minutes long, and the tool call must
      // return so the model can poll. The job record is the durable progress.
      const job = await startJob(paths, runId, 'scan')
      detach(paths, job, async () => {
        const detected = await detector.detect({ settings, runner, paths, module: args.module ?? '', csvPath: args.csv_path ?? '', signal: undefined })
        await saveJsonlClusters(paths, detected.clusters)
        await saveRun(paths, { ...opened.record, detection_provider: detected.provider === 'python-pipeline' ? 'python-pipeline' : 'csv' })
        return detected
      }, detected => `${detected.clusters.length} cluster(s) via ${detected.provider}`)
      return {
        run_id: runId, job_id: job.job_id, accepted: true, created: opened.created,
        clusters: existing.length, provider: detector.id,
        guidance: `Scanning "${args.module ?? ''}" with ${detector.id}. Poll clone_check with what: status until the job leaves running.`,
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Clone refactor', kind: 'other', rawInput: `scan ${args.module ?? ''}` }),
  }))

  ctx.tools.register(defineTool({
    name: 'clone_check',
    description: 'Read-only progress and ledger inspection: the newest background job, the clusters, the verdict ledger, or the tail of the newest verification log. Never changes anything.',
    parameters: {
      run_id: { type: 'string', required: true },
      what: { type: 'string', required: true, enum: ['status', 'clusters', 'ledger', 'log'] },
      offset: { type: 'integer', description: 'clusters only: the index this page starts at.' },
      log_lines: { type: 'integer', description: 'log only: trailing lines to return (default 80).' },
    },
    output: output({ type: 'object', additionalProperties: true, properties: { run_id: { type: 'string', required: true }, what: { type: 'string', required: true } } }),
    async execute(args) {
      const runId = requireText(args.run_id, 'run_id')
      // A read-only tool must not create a run: `openRun` reads the baseline and
      // may switch branches, so it is a write. Inspect an existing run or fail.
      assertInsideRoot(artifactsRoot, runId)
      const paths = runPaths(artifactsRoot, runId)
      if (await loadRun(paths) === undefined) {
        throw new Error(`No run '${runId}' under ${artifactsRoot}. Call clone_scan first.`)
      }
      if (args.what === 'status') {
        return { run_id: runId, what: 'status', job: (await latestJob(paths)) ?? null }
      }
      if (args.what === 'ledger') {
        const { latest, droppedLines } = await loadAssessments(paths)
        return { run_id: runId, what: 'ledger', assessments: [...latest.values()], patches: await loadPatches(paths), dropped_lines: droppedLines }
      }
      if (args.what === 'log') {
        const tail = await readNewestVerifyLog(paths, Math.max(1, args.log_lines ?? 80))
        return { run_id: runId, what: 'log', log: tail }
      }
      // Bound the page by the configured character budget, not a fixed count: a
      // cluster carries a representative pair with two bodies, so a hundred of
      // them can dwarf any response the model can use.
      const clusters = await loadJsonlClusters(paths)
      const offset = Math.max(0, args.offset ?? 0)
      const page: typeof clusters = []
      let characters = 0
      for (const cluster of clusters.slice(offset)) {
        const size = JSON.stringify(cluster).length
        if (page.length > 0 && characters + size > settings.pageChars) break
        page.push(cluster)
        characters += size
      }
      const { latest } = await loadAssessments(paths)
      return {
        run_id: runId, what: 'clusters', total: clusters.length, offset,
        next_offset: offset + page.length < clusters.length ? offset + page.length : null,
        gaps: coverageGaps(clusters.map(cluster => cluster.id), latest),
        clusters: page,
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Clone refactor', kind: 'other', rawInput: `check ${args.what ?? ''}` }),
  }))

  ctx.tools.register(defineTool({
    name: 'clone_assess',
    description: 'Record one verdict for one cluster: patched, report_only or skipped. A patched verdict needs confirm: true, it needs authorization.enabled, and it needs the files it changed. A P0 report_only verdict needs evidence of the concrete blocker — a generic "unsure" is not a verdict.',
    parameters: {
      run_id: { type: 'string', required: true },
      cluster_id: { type: 'string', required: true },
      verdict: { type: 'string', required: true, enum: [...VERDICTS] },
      priority: { type: 'string', required: true, enum: [...PRIORITIES] },
      reason: { type: 'string', required: true, description: 'Why this verdict: the concrete blocker, or what the patch preserved.' },
      evidence: EVIDENCE,
      files_changed: { type: 'array', items: { type: 'string' }, description: 'Repo-relative files this patch touched; required for patched.' },
      replace: { type: 'boolean', description: 'Overwrite an earlier verdict for this cluster.' },
      confirm: { type: 'boolean', description: 'Required for a patched verdict: the user explicitly agreed to this source change.' },
    },
    output: output({ type: 'object', additionalProperties: false, properties: {
      run_id: { type: 'string', required: true }, cluster_id: { type: 'string', required: true },
      verdict: { type: 'string', required: true }, replaced: { type: 'boolean', required: true },
      covered: { type: 'integer', required: true }, total: { type: 'integer', required: true },
      remaining: { type: 'integer', required: true }, guidance: { type: 'string', required: true },
    } }),
    async execute(args) {
      const runId = requireText(args.run_id, 'run_id')
      const clusterId = requireText(args.cluster_id, 'cluster_id')
      const { paths } = await openRun({ settings, runner, artifactsRoot, runId })
      const clusters = await loadJsonlClusters(paths)
      knownCluster(clusters.map(cluster => cluster.id), clusterId)
      const reason = requireText(args.reason, 'reason')
      const files = (args.files_changed ?? []).map(normalizeRepoPath).filter(Boolean)
      if (args.verdict === 'patched') {
        if (args.confirm !== true) throw new Error('Recording a patched verdict needs confirm: true — source changes are the user\'s decision, not the model\'s.')
        if (!settings.authorization.enabled) throw new Error('Patching is disabled: set authorization.enabled: true in the profile row before any run may change source.')
        if (PRIORITY_RANK[args.priority] < PRIORITY_RANK[settings.authorization.maxPriority]) {
          throw new Error(`authorization.maxPriority is ${settings.authorization.maxPriority}, so a ${args.priority} cluster may not be patched in this deployment.`)
        }
        if (files.length === 0) throw new Error('A patched verdict needs files_changed: the authorization ledger is what clone_verify reconciles against.')
        if (args.evidence === undefined) throw new Error('A patched verdict needs evidence: the file, line and snippet of the change.')
        const patches = await loadPatches(paths)
        if (!patches.some(patch => patch.cluster_id === clusterId) && patches.length >= settings.authorization.maxClusters) {
          throw new Error(`authorization.maxClusters is ${settings.authorization.maxClusters}; this run already patched ${patches.length} cluster(s).`)
        }
      } else if (args.priority === 'P0' && args.evidence === undefined) {
        throw new Error('A P0 verdict that is not patched needs evidence of the concrete blocker (file, line, snippet). "Semantics unclear" is not evidence.')
      }
      const assessment: Assessment = {
        cluster_id: clusterId, verdict: args.verdict, priority: args.priority, reason,
        files_changed: files, recorded_at: new Date().toISOString(),
      }
      const { replaced } = await recordAssessment(paths, assessment, { replace: args.replace === true })
      if (args.verdict === 'patched') {
        const patches = await loadPatches(paths)
        if (!patches.some(patch => patch.cluster_id === clusterId)) {
          const added: PatchRecord = { cluster_id: clusterId, priority: args.priority, files_changed: files, recorded_at: assessment.recorded_at }
          await savePatches(paths, [...patches, added])
        }
      }
      const { latest } = await loadAssessments(paths)
      const covered = clusters.filter(cluster => latest.has(cluster.id)).length
      const remaining = clusters.length - covered
      return {
        run_id: runId, cluster_id: clusterId, verdict: args.verdict, replaced, covered, total: clusters.length, remaining,
        guidance: remaining === 0 ? 'Every cluster has a verdict: call clone_verify when a patch is authorized, then clone_report.' : `${remaining} cluster(s) still need a verdict.`,
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Clone refactor', kind: 'other', rawInput: `assess ${args.verdict ?? ''} ${args.cluster_id ?? ''}` }),
  }))

  ctx.tools.register(defineTool({
    name: 'clone_verify',
    description: 'Reconcile the authorization ledger against the actual diff, then run the configured build/test steps. Refuses outright when a changed file was never authorized. Runs in the background: poll clone_check. A patch that has not passed this cannot be submitted.',
    parameters: { run_id: { type: 'string', required: true } },
    output: output({ type: 'object', additionalProperties: true, properties: {
      run_id: { type: 'string', required: true }, job_id: { type: 'string', required: true },
      accepted: { type: 'boolean', required: true }, attempt: { type: 'integer', required: true },
      authorized_files: { type: 'array', required: true, items: { type: 'string' } },
    } }),
    async execute(args) {
      const runId = requireText(args.run_id, 'run_id')
      const { paths, record } = await openRun({ settings, runner, artifactsRoot, runId })
      const patches = await loadPatches(paths)
      const authorized = [...new Set(patches.flatMap(patch => patch.files_changed.map(normalizeRepoPath)))].sort()
      const status = await runner.run({ argv: ['git', 'status', '--porcelain'], cwd: record.project_root, timeoutMs: 60_000, signal: undefined })
      const diff = await runner.run({ argv: ['git', 'diff', '--name-only', record.baseline.head], cwd: record.project_root, timeoutMs: 60_000, signal: undefined })
      const changed = [...new Set([...parsePorcelain(status.stdout), ...parseNameOnly(diff.stdout)])]
      const audit = reconcile(authorized, changed)
      const attempt = (await loadVerifyAttempts(paths)).length + 1
      await writeAtomic(join(paths.verifyDir, String(attempt), 'reconcile.json'), `${JSON.stringify({ authorized, changed, ...audit }, null, 2)}\n`)
      if (audit.unauthorized.length > 0) {
        throw new Error(`UNAUTHORIZED_CHANGES: ${audit.unauthorized.join(', ')} changed but is not in the authorization ledger. This run is frozen: resolve or revert those files before verifying or submitting.`)
      }
      const job = await startJob(paths, runId, 'verify')
      detach(paths, job, async () => {
        const result = await runVerification({ runner, paths, steps: settings.verify.steps, cwd: record.project_root, attempt, signal: undefined })
        if (!result.ok && !settings.verify.keepFailedPatch && authorized.length > 0) {
          await checkoutFiles(runner, record.project_root, authorized)
          result.rolled_back = true
          result.rollback_files = authorized
        }
        await writeAtomic(join(paths.verifyDir, String(attempt), 'result.json'), `${JSON.stringify(result, null, 2)}\n`)
        return result
      }, result => `attempt ${result.attempt}: ${result.ok ? 'PASS' : 'FAIL'}`)
      return { run_id: runId, job_id: job.job_id, accepted: true, attempt, authorized_files: authorized }
    },
    presentCall: args => ({ card: 'generic', title: 'Clone refactor', kind: 'other', rawInput: `verify ${args.run_id ?? ''}` }),
  }))

  ctx.tools.register(defineTool({
    name: 'clone_submit',
    description: 'Commit, push and optionally open a pull request for the authorized files — only after a passing clone_verify. Requires confirm: true; without it the call fails and nothing outward happens.',
    parameters: {
      run_id: { type: 'string', required: true },
      confirm: { type: 'boolean', required: true, description: 'Set true only after the user explicitly agreed to this submission.' },
      mode: { type: 'string', enum: ['none', 'commit', 'push', 'pr'], description: 'Overrides submit.mode for this call.' },
      pr_title: { type: 'string' }, pr_body: { type: 'string' },
    },
    output: output({ type: 'object', additionalProperties: true, properties: { run_id: { type: 'string', required: true }, mode: { type: 'string', required: true } } }),
    async execute(args) {
      const runId = requireText(args.run_id, 'run_id')
      if (args.confirm !== true) throw new Error('clone_submit requires confirm: true — get the user\'s explicit consent before any outward action.')
      const { paths, record } = await openRun({ settings, runner, artifactsRoot, runId })
      const attempts = await loadVerifyAttempts(paths)
      const last = attempts.at(-1)
      if (last === undefined || !last.ok) throw new Error('No passing clone_verify for this run: nothing may be submitted before the build and tests pass.')
      const patches = await loadPatches(paths)
      const files = [...new Set(patches.flatMap(patch => patch.files_changed.map(normalizeRepoPath)))].sort()
      if (files.length === 0) throw new Error('The authorization ledger is empty: there is nothing to submit.')
      const mode = (args.mode ?? settings.submit.mode) as Settings['submit']['mode']
      const message = settings.submit.commitMessageTemplate === ''
        ? `clone refactor(${runId}): deduplicate ${files.length} file(s)`
        : renderCommitMessage(settings.submit.commitMessageTemplate, { run_id: runId, files_count: String(files.length), timestamp: new Date().toISOString() })
      const result = await submit({
        runner, projectRoot: record.project_root, branch: record.branch, remote: settings.submit.remote,
        baseBranch: settings.submit.baseBranch, files, message,
        title: args.pr_title ?? `Clone refactor ${runId}`, body: args.pr_body ?? `${files.length} file(s) deduplicated after a passing verification.`,
        mode, signal: undefined,
      })
      return { run_id: runId, mode: result.mode, committed: result.committed, pushed: result.pushed, pr_url: result.pr_url, steps: result.steps }
    },
    presentCall: args => ({ card: 'generic', title: 'Clone refactor', kind: 'other', rawInput: `submit ${args.mode ?? ''}` }),
  }))

  ctx.tools.register(defineTool({
    name: 'clone_report',
    description: 'Close the run: check that every cluster has a verdict, then write report.md, findings.json and summary.json under the run directory. Refuses an incomplete run unless allow_partial: true, which reports the gaps instead of hiding them.',
    parameters: {
      run_id: { type: 'string', required: true },
      notes: { type: 'string', description: 'Free text for the report preamble.' },
      allow_partial: { type: 'boolean', description: 'Render even when some clusters have no verdict; the gaps become part of the report.' },
    },
    output: output({ type: 'object', additionalProperties: true, properties: {
      run_id: { type: 'string', required: true }, report_path: { type: 'string', required: true },
      findings_path: { type: 'string', required: true }, summary_path: { type: 'string', required: true },
    } }),
    async execute(args) {
      const runId = requireText(args.run_id, 'run_id')
      const { paths, record } = await openRun({ settings, runner, artifactsRoot, runId })
      const clusters = await loadJsonlClusters(paths)
      const { latest, droppedLines } = await loadAssessments(paths)
      const written = await writeReport(paths, {
        run: record, clusters, assessments: latest, patches: await loadPatches(paths),
        verify: await loadVerifyAttempts(paths), job: await latestJob(paths), droppedLines,
        unauthorized: await loadUnauthorized(paths),
        notes: args.notes ?? '', allowPartial: args.allow_partial === true, language: settings.reportLanguage,
      })
      return { run_id: runId, report_path: written.report_path, findings_path: written.findings_path, summary_path: written.summary_path, summary: written.summary, digest: written.digest }
    },
    presentCall: args => ({ card: 'generic', title: 'Clone refactor', kind: 'other', rawInput: `report ${args.run_id ?? ''}` }),
  }))
}
```

工具文件还需要三个小编解码：把它们放在 `src/core/clusters.ts`、`src/verify/artifacts.ts` 里，作为独立的可测单元。

`src/core/clusters.ts`：

```ts
/** The cluster ledger: an append-only file that a resumed run replays. */
import { appendJsonl, readJsonl } from './jsonl.ts'
import { writeAtomic, type RunPaths } from './artifacts.ts'
import type { Cluster } from './schema.ts'

export async function loadJsonlClusters(paths: RunPaths): Promise<Cluster[]> {
  return (await readJsonl<Cluster>(paths.clusters)).records
}

/** A scan replaces the cluster set; a resumed run reads whatever is there. */
export async function saveJsonlClusters(paths: RunPaths, clusters: readonly Cluster[]): Promise<void> {
  await writeAtomic(paths.clusters, clusters.map(cluster => `${JSON.stringify(cluster)}\n`).join(''))
}

export { appendJsonl }
```

`src/verify/artifacts.ts`：

```ts
/** Verification attempt records on disk: the evidence `clone_submit` checks. */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { readJson, type RunPaths } from '../core/artifacts.ts'
import type { VerifyResult } from '../core/schema.ts'

export async function loadVerifyAttempts(paths: RunPaths): Promise<VerifyResult[]> {
  let names: string[]
  try {
    names = await readdir(paths.verifyDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const attempts = await Promise.all(names
    .filter(name => /^\d+$/.test(name))
    .map(async name => await readJson<VerifyResult>(join(paths.verifyDir, name, 'result.json'))))
  return attempts.filter((attempt): attempt is VerifyResult => attempt !== undefined)
    .sort((left, right) => left.attempt - right.attempt)
}

/** Every reconcile audit recorded so far, flattened: what the report calls unauthorized. */
export async function loadUnauthorized(paths: RunPaths): Promise<string[]> {
  let names: string[]
  try {
    names = await readdir(paths.verifyDir)
  } catch {
    return []
  }
  const audits = await Promise.all(names
    .filter(name => /^\d+$/.test(name))
    .map(async name => await readJson<{ unauthorized?: string[] }>(join(paths.verifyDir, name, 'reconcile.json'))))
  return [...new Set(audits.flatMap(audit => audit?.unauthorized ?? []))].sort()
}

/**
 * The tail of the newest step log of the newest attempt. A poller reads this
 * while a build runs, so it stays a bounded slice rather than the whole file.
 */
export async function readNewestVerifyLog(
  paths: RunPaths,
  lines: number,
): Promise<{ file: string; lines: string[] } | undefined> {
  const attempts = await loadVerifyAttempts(paths)
  const newest = attempts.at(-1)
  const directory = newest === undefined
    ? await newestAttemptDir(paths)
    : join(paths.verifyDir, String(newest.attempt))
  if (directory === undefined) return undefined
  const names = (await readdir(directory).catch(() => [])).filter(name => name.endsWith('.log')).sort()
  const file = names.at(-1)
  if (file === undefined) return undefined
  const absolute = join(directory, file)
  const text = await readFile(absolute, 'utf8').catch(() => '')
  const all = text.split('\n')
  return { file: absolute, lines: all.slice(Math.max(0, all.length - lines)) }
}

/** The highest-numbered attempt directory, when no result.json has been written yet. */
async function newestAttemptDir(paths: RunPaths): Promise<string | undefined> {
  const names = (await readdir(paths.verifyDir).catch(() => [])).filter(name => /^\d+$/.test(name))
  const highest = names.map(Number).sort((left, right) => left - right).at(-1)
  return highest === undefined ? undefined : join(paths.verifyDir, String(highest))
}
```

- [ ] **Step 4: 实现 `src/index.ts`**

```ts
/** GME clone refactor inside Harness: detection, judging, verification, submission. */
import type { Context } from '@deepseek-ai/cordis'
// Side-effect type import: loads the `declare module '@deepseek-ai/cordis'`
// augmentation that puts `systemPrompt` on `Context`.
import type {} from '@deepseek-ai/dsh-system-prompt'
import z from '@deepseek-ai/schemastery'
import { resolveSettings, type Settings } from './config.ts'
import { artifactsRootOf } from './core/run.ts'
import { hostRunner } from './core/command-host.ts'
import { registerTools } from './tools.ts'

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
  pageChars: z.any().default(12000),
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
      '3. Patching source is off by default. To allow one authorized P0 patch per run, set authorization.enabled: true (authorization.maxPriority, authorization.maxClusters).',
      '4. clone_verify needs verify.steps: the build, test, format and restore commands for this site. Without them nothing can be verified and nothing may be submitted.',
      '5. Submissions are off by default (submit.mode: none); commit, push or pr must be chosen deliberately.',
      'Report these steps when the user asks for a clone refactor or asks why its tools are missing.',
    ].join('\n')
  }
  const lines = [
    'GME clone refactor: clone_scan produces the clone families of one module and is the coverage contract — every cluster must end with a verdict before clone_report closes the run.',
    'clone_check is read-only and is how progress is polled: clone_scan and clone_verify are background jobs, so a call returns accepted and the job record is the truth. A job stuck at running was interrupted, not successful.',
    'Judge each cluster from the real source, not from the CSV excerpt. The clustering is structural only: it has no skeleton or risk-signal analysis, so the priority is yours to decide.',
    'A patched verdict needs confirm: true, authorization.enabled, the files it changed and evidence. A P0 cluster you leave unpatched needs evidence of the concrete blocker — "semantics unclear" is not evidence and is rejected.',
    'clone_verify reconciles the authorization ledger against the actual git diff first: a changed file the user never authorized freezes the run with UNAUTHORIZED_CHANGES. Never edit around that.',
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
```

- [ ] **Step 5: 运行测试与类型检查**

Run: `pnpm vitest run tests/workflow.spec.ts; pnpm run typecheck`
Expected: PASS，且 typecheck 退出码 0

- [ ] **Step 6: 提交**

```bash
git add -A
git commit -m "feat: register the six clone-refactor tools and mount the plugin"
```

---

### Task 14: 挂载契约与全链路测试

**Files:**
- Create: `tests/install.spec.ts`
- Modify: `tests/workflow.spec.ts`（追加全链路用例）
- Create: `tests/pack-smoke.mjs`
- Modify: `package.json`（`test:pack` 脚本，并把 `verify` 串上它）

**Interfaces:**
- Consumes: `apply` / `Config` / `name`（Task 13）、`cordis.patch.yml`（Task 1）、`tools.ts`（Task 13）
- Produces: 无（验证性任务）

- [ ] **Step 1: 写挂载契约测试**

`tests/install.spec.ts`（骨架照 `gme-test-generator/tests/install.spec.ts`，断言换成这个插件的契约）：

```ts
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

async function mount(row: EntryOptions): Promise<{ ctx: Context; imported: string[]; sections: PromptSection[] }> {
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
  return { ctx, imported, sections }
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
    const { ctx, imported, sections } = await mount(await insertedRow())
    expect(imported).toEqual([PACKAGE_NAME])
    expect((await call(ctx, 'clone_check', { run_id: 'r1', what: 'status' })).isError).toBe(true)
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
    // `clone_check` on a run that does not exist yet creates nothing and fails
    // with the tool's own guidance, which proves the tool is registered at all.
    const checked = await call(ctx, 'clone_check', { run_id: 'r1', what: 'status' })
    expect(checked.isError).toBe(true)
    expect(JSON.stringify(checked)).toBeTruthy()
    const scan = await call(ctx, 'clone_scan', { run_id: 'r1', module: 'base' })
    // projectRoot is a real directory but not a git work tree, so the run must
    // fail on the baseline rather than pretending to succeed.
    expect((scan as { isError?: boolean }).isError).toBe(true)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run tests/install.spec.ts`
Expected: FAIL —— `tests/install.spec.ts` 不存在

- [ ] **Step 3: 追加全链路用例到 `tests/workflow.spec.ts`**

```ts
describe('the whole chain', () => {
  it('scans, judges every cluster, verifies and reports', async () => {
    const root = await workspace()
    const csv = join(root, 'func_clone_base.csv')
    await writeFile(csv, `${CSV_HEADER}p1,module/laws/src/a.cpp,ComputeArea,10-20,module/laws/src/b.cpp,CalcArea,30-40,0.95,type12\n`)
    const gitAndBuild: Array<[string, { stdout?: string; exitCode?: number }]> = [
      ...GIT_OK,
      ['msbuild', { stdout: 'Build succeeded\n' }],
      ['tests.exe', { stdout: 'All tests passed\n' }],
    ]
    const ctx = await mount({
      projectRoot: 'D:/repo',
      artifactsRoot: join(root, 'runs'),
      detection: { provider: 'csv', csvPath: csv },
      verify: { steps: [
        { name: 'build', phase: 'build', command: 'msbuild tests.sln' },
        { name: 'test', phase: 'test', command: 'tests.exe' },
      ] },
    }, fakeRunner(gitAndBuild))

    const scan = await call(ctx, 'clone_scan', { run_id: 'r1', module: 'base' })
    expect((scan as { isError?: boolean }).isError).not.toBe(true)
    await settle(ctx, 'r1')

    const assessed = await call(ctx, 'clone_assess', {
      run_id: 'r1', cluster_id: 'C001', verdict: 'report_only', priority: 'P1',
      reason: 'renaming-only difference, but the callee is virtual',
      evidence: { file: 'module/laws/src/a.cpp', line: 12, snippet: 'virtual void draw();' },
    })
    expect((assessed as { isError?: boolean }).isError).not.toBe(true)

    const verify = await call(ctx, 'clone_verify', { run_id: 'r1' })
    expect((verify as { isError?: boolean }).isError).not.toBe(true)
    await settle(ctx, 'r1')

    const report = await call(ctx, 'clone_report', { run_id: 'r1' })
    expect((report as { isError?: boolean }).isError).not.toBe(true)
    const summaryPath = join(root, 'runs', 'r1', 'summary.json')
    const summary = JSON.parse(await readFile(summaryPath, 'utf8')) as { clusters: number; missing: number; verify_ok: boolean }
    expect(summary.clusters).toBe(1)
    expect(summary.missing).toBe(0)
    expect(summary.verify_ok).toBe(true)
    expect(await readFile(join(root, 'runs', 'r1', 'report.md'), 'utf8')).toContain('msbuild tests.sln')
  })

  it('freezes the run when a file outside the ledger changed', async () => {
    const root = await workspace()
    const csv = join(root, 'func_clone_base.csv')
    await writeFile(csv, `${CSV_HEADER}p1,module/laws/src/a.cpp,ComputeArea,10-20,module/laws/src/b.cpp,CalcArea,30-40,0.95,type12\n`)
    const ctx = await mount({
      projectRoot: 'D:/repo',
      artifactsRoot: join(root, 'runs'),
      detection: { provider: 'csv', csvPath: csv },
      authorization: { enabled: true },
      verify: { steps: [{ name: 'build', phase: 'build', command: 'msbuild tests.sln' }] },
    }, fakeRunner([
      ...GIT_OK,
      // a.cpp is authorized; sneaky.cpp is not.
      ['git status --porcelain', { stdout: ' M module/laws/src/a.cpp\n M module/laws/src/sneaky.cpp\n' }],
      ['git diff --name-only', { stdout: 'module/laws/src/a.cpp\nmodule/laws/src/sneaky.cpp\n' }],
    ]))
    await call(ctx, 'clone_scan', { run_id: 'r1', module: 'base' })
    await settle(ctx, 'r1')
    await call(ctx, 'clone_assess', {
      run_id: 'r1', cluster_id: 'C001', verdict: 'patched', priority: 'P0',
      reason: 'body identical, extracted a helper', files_changed: ['module/laws/src/a.cpp'],
      evidence: { file: 'module/laws/src/a.cpp', line: 12, snippet: 'static int area(const Rect& r)' },
      confirm: true,
    })
    const verify = await call(ctx, 'clone_verify', { run_id: 'r1' })
    expect((verify as { isError?: boolean }).isError).toBe(true)
    expect(JSON.stringify(verify)).toMatch(/UNAUTHORIZED_CHANGES/)
    expect(JSON.stringify(verify)).toMatch(/sneaky\.cpp/)
  })
})
```

`tests/workflow.spec.ts` 还需要一个导入：文件顶部的 `node:fs/promises` 导入加上 `readFile`。轮询助手 `settle(ctx, runId)` 已在 Task 13 的同一文件里定义，直接复用，不要再定义第二个。

- [ ] **Step 4: 运行全链路测试**

Run: `pnpm vitest run tests/install.spec.ts tests/workflow.spec.ts`
Expected: PASS

- [ ] **Step 5: 加打包冒烟测试**

`tests/pack-smoke.mjs`：

```js
/**
 * The packaged artefact must contain exactly what the plugin needs at runtime:
 * `lib/index.js` plus the patch layer. A missing patch file means a marketplace
 * install that silently does nothing.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], { encoding: 'utf8', shell: process.platform === 'win32' })
const [entry] = JSON.parse(raw)
const files = entry.files.map(file => file.path.replaceAll('\\', '/'))
for (const required of ['lib/index.js', 'cordis.patch.yml', 'README.md', 'LICENSE']) {
  if (!files.includes(required)) throw new Error(`the packaged artefact is missing ${required}`)
}
if (files.some(file => file.startsWith('docs/superpowers/'))) throw new Error('internal design docs must not be published')
const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
if (manifest.dsh?.bundle?.patch !== './cordis.patch.yml') throw new Error('dsh.bundle.patch must point at the committed patch layer')
console.log(`pack-smoke: ${files.length} file(s) verified`)
```

`package.json` 的 scripts 改成：

```json
    "test:pack": "node tests/pack-smoke.mjs",
    "verify": "npm run typecheck && npm run build && npm run test && npm run test:pack",
```

- [ ] **Step 6: 运行完整验证并提交**

Run: `pnpm run verify`
Expected: 退出码 0（typecheck + build + 全部测试 + 打包冒烟）

```bash
git add -A
git commit -m "test: pin the install contract, the whole chain and the packaged artefact"
```

---

### Task 15: 使用文档与发布准备

**Files:**
- Create: `README.md`, `README.zh.md`, `docs/setup.md`, `docs/setup.zh.md`
- Modify: `src/verify/engine.ts`（若 Task 9 的注释与实际代码不一致，以此任务为准做最后核对）

**Interfaces:**
- Consumes: 全部
- Produces: 无（文档与发布）

- [ ] **Step 1: 写双语 README**

`README.md` 结构（`README.zh.md` 为对应中文版，两者内容等价）：

````markdown
# dsh-gme-clone-refactor

A GME clone-detection-and-refactor workflow inside DeepSeek Harness: scan the clone
families of one module, judge each one, apply at most one authorized minimal patch,
verify it with a real build and test, and submit only what passed. It never guesses:
an unverified patch cannot be submitted, and a changed file the user never
authorized freezes the run.

Community plugin, not an official DeepSeek package.

## Tools

| Tool | What it does |
|---|---|
| `clone_scan` | Enumerate the clone families of one module into the run's coverage contract (background job) |
| `clone_check` | Read-only polling: job status, clusters, the verdict ledger, the newest verification log |
| `clone_assess` | Record one verdict per cluster: `patched`, `report_only` or `skipped` — with the authorization gate and the evidence rule |
| `clone_verify` | Reconcile the authorization ledger against the real diff, then run the configured build/test steps (background job) |
| `clone_submit` | Commit, push and optionally open a PR — only after a passing verification, and only with `confirm: true` |
| `clone_report` | Close the run: write `report.md`, `findings.json` and `summary.json`, refusing to hide coverage gaps |

## Install

```sh
dsh plugin --profile web add dsh-gme-clone-refactor
```

## Configure

...（环境变量表 + profile patch 示例 + 配置键表）

## Two detection providers

`detection.provider: csv` reads an existing `func_clone_<module>.csv` and needs nothing
but Harness. `detection.provider: python-pipeline` drives the existing
`run_gme_clone_detection.py` and is the only path to type 3-4 (embedding) clones; it
needs a Python checkout with libclang and, for type 3-4, an embeddings endpoint.
**The two never produce comparable cluster sets, so every report records which one ran.**

## What this plugin does NOT do

- It does not create git work trees. Verification runs in the work tree you point it
  at, because that is where the build and the tests must run; `authorization.enabled`
  decides whether it switches to a `clone-refactor/<run_id>` branch.
- It does not port the Python pipeline's body-skeleton comparison, behaviour
  signatures or risk-signal regexes: clustering here is structural, and judging risk
  from the real source is the model's job.
- It does not roll back files it never authorized, and it never runs `git reset --hard`.

## Limits

- Scanning and verification occupy the work tree: do not switch branches or run your
  own build there while a job is running.
- Aborting a tool call stops waiting; it does not cancel the command. A job left at
  `running` was interrupted, and the report says so.
- `submit.mode` defaults to `none`, and `authorization.enabled` defaults to off.
````

- [ ] **Step 2: 写配置参考 `docs/setup.md` / `docs/setup.zh.md`**

至少覆盖：环境变量与 profile patch 两种配置方式、§12 的完整配置键表、一份**完整的 GME profile 示例**（`verify.steps` 的 build/test/format/restore 取值）、首次自用的一次实测清单（见下）、以及 troubleshooting 表（`detection.scriptPath` 未配置、验证步骤为空、工作区不干净、run 停在 running、UNAUTHORIZED_CHANGES 的含义）。

首次自用的实测清单（必须照实写进文档，因为 GME 的构建命令在本计划中未经验证）：

1. `verify.steps` 先只放一条 `build`，跑一次 `clone_verify`，确认命令、工作目录与日志都对。
2. 再加 `test`、`format`、`restore`，逐条确认退出码判定与 `always` 语义。
3. 确认 `format-check` 用的是 GME 自己的 clang-format 版本（17.0.2），否则格式判定没有意义。
4. 在一个只读的 run 上确认 `submit.mode: none` 时 `clone_submit` 不做任何事。

- [ ] **Step 3: 核对实现与文档的一致性**

Run: `pnpm run verify`
Expected: 退出码 0

逐项确认（这就是本任务的验收）：

- `package.json` 的 `files` 包含 `lib`、`cordis.patch.yml`、`docs`、`README.md`、`README.zh.md`、`LICENSE`，且排除 `docs/superpowers`。
- README 的工具表与 `src/tools.ts` 注册的六个名字逐字一致。
- 配置键表与 `src/config.ts` 的 `Settings` 逐字段一致（含默认值）。
- `docs/setup.md` 与 `docs/setup.zh.md` 内容等价。

- [ ] **Step 4: 提交**

```bash
git add -A
git commit -m "docs: document installation, configuration, the two detection providers and the limits"
```

- [ ] **Step 5: 发布准备（只准备，不执行）**

按 `D:\workspace\gme-dsh-plugin\README.md` 的既有流程，创建远端仓库并打标签，**真正的 `npm publish` 与市场收录 PR 留给你确认后执行**：

```bash
git remote add origin git@github.com:nuaaweixinye/dsh-gme-clone-refactor.git
git push -u origin main --follow-tags
gh repo edit --add-topic dsh-plugin
npm pack --dry-run           # 确认清单后再考虑 npm publish
```

---

## Self-Review

**1. Spec 覆盖（逐节对照）**

| Spec 节 | 对应任务 |
|---|---|
| §1 目标 / 非目标 | 全部；非目标由"不做 worktree"（Task 6）与"不做骨架比对"（Task 7）落实 |
| §2 背景与两个关键事实 | Task 6（不建 worktree、基线绑定）、Task 7（分簇范围） |
| §3 架构、分层、两条接口 | Task 4（`CommandRunner`）、Task 7（`CloneDetector`）、Task 13（组合根只在此导入宿主实现） |
| §4 六个工具 | Task 13（`registerTools`）+ Task 14（挂载契约） |
| §5 产物布局 | Task 2（路径与原子写）、Task 10（`jobs/`）、Task 13（`verify/<n>/reconcile.json`） |
| §6 状态机 | Task 3（覆盖契约）、Task 13（`assess`/`verify`/`submit` 的前置条件） |
| §7 检测层与两个 provider | Task 7（`csv` + 结构分簇）、Task 8（`python-pipeline`） |
| §8 评估与三层授权 | Task 13（配置层 + 调用层 + 对账层）、Task 5（对账实现） |
| §9 验证闭环 | Task 9（引擎）、Task 13（对账与回滚接进 `clone_verify`） |
| §10 提交边界 | Task 12（四档 mode）、Task 13（`confirm: true` 与"无验证不得提交"） |
| §11 报告与覆盖契约 | Task 11 |
| §12 配置参考 | Task 1 |
| §13 错误处理与降级 | Task 1（坏值降级）、Task 13（空配置不注册工具 + guidance） |
| §14 测试策略 | Task 14（挂载 + 全链路 + 打包冒烟），其余每个任务自带单测 |
| §15 风险与开放问题 | 已在 spec 内更新；GME 实测清单落在 Task 15 Step 2 |
| §16 验收标准 | 1 → Task 14；2/3 → Task 3、13；4 → Task 14（freeze 用例）；5 → Task 9；6 → Task 12、13；7 → Task 11；8 → 每个任务的 `pnpm run verify` |

**2. 占位符扫描**

已扫过：本计划不含 TBD/TODO/"稍后实现"/"类似 Task N"。文档任务（Task 15）里 README 用 `...` 标出的是**待写散文的章节结构**，不是待实现的代码；配置键表、实测清单与验收项都已列明。

**3. 类型与命名一致性**

已在写作过程中就地修正的问题（留档，供审阅者核对）：

- `clone_scan` / `clone_verify` 原先用 `track(...)` 且 await 它，会破坏"立即返回 accepted"的语义 → 改为 `startJob` + `detach`。`track` 由此变成只有测试调用的死代码，已从 Task 10 移除（`detach` 与内部的 `settle` 共用同一套状态落盘，成功/失败只有一条代码路径），其成功用例改由 `detach` 覆盖。
- `clone_check` 的分页表达式是残句（`offset + settings.pageChars > 0 ? ... : ...`）→ 改为固定 `pageSize`。
- `clone_check` 引用了未定义的 `newestVerifyLog` / `readTextFile` → 改为 `verify/artifacts.ts` 的 `readNewestVerifyLog(paths, lines)`。
- `ReportInput` 缺少 `unauthorized` 字段，而 `clone_report` 传了它 → 补上字段，`summarizeReport` 改为直接读该字段（原先从 `rolled_back` 反推，逻辑不成立），报告新增"未授权改动"小节。
- `clone_assess` 里 `void record` 的未使用解构 → 去掉。
- `tools.ts` 的导入表去掉了 `readBaseline` / `readJson` / `track` / `VerifyResult` 等未使用项，补上 `detach` / `startJob` / `loadUnauthorized` / `loadVerifyAttempts` / `readNewestVerifyLog`。
- `verify/artifacts.ts` 补上 `readFile` 导入（`readNewestVerifyLog` 需要）。
- `engine.ts` 重复的 `if (!ok && step.required) failed = true` → 合并为一处。

**4. 与 spec 的已记录偏离**

- 分簇只做结构分簇（spec §7 与 §15 已更新，Task 7 的范围声明与此一致）。
- 验证不复刻 15 步流水线，改声明式步骤清单（spec §9 已如此设计）。
- 不引入 worktree（spec §2 的推理，Task 6 落实）。
