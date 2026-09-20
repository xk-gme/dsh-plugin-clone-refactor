# 克隆重构 DSH 插件设计（dsh-gme-clone-refactor）

- 日期：2026-09-20
- 状态：**待审阅设计稿**（尚未创建仓库、未写任何实现代码）
- 来源：`D:\workspace\gme-pr-agent\Agent` 的克隆重构工作流
- 目标工作区：`D:\workspace\gme-dsh-plugin\dsh-gme-clone-refactor\`

---

## 1. 目标与非目标

### 目标

1. 把 `gme-pr-agent` 的"克隆重构"能力搬到 DeepSeek Harness，成为一个独立插件（独立 git 仓库、独立 npm 包、市场可收录）。
2. 覆盖**全链路**：检测 → 分簇 → 评估 → 最小 patch → 编译验证 → 提交/PR。
3. 结构清晰、耦合低、先自用但按可发布设计（依赖全部可配置、缺失时降级而不是报错）。

### 非目标

- **不重写检测算法**。Type1-2 的 token/结构比对与 Type3-4 的 embedding 语义克隆继续由现有 Python 管线产出。
- **不重写宿主的编辑、命令执行、git 能力**。插件只做记账、闸门、验证编排与报告。
- **不做 GUI**。DSH Web GUI 就是宿主。
- **不做多模块并行重构**。将来要做时，每个 run 一个隔离目录才是真的必需（那时再评估附加工作树）。

---

## 2. 背景：被替代的实现与两个关键事实

### 被替代的组成

| 原实现 | 职责 | 本插件如何处理 |
|---|---|---|
| `src/orchestrators/clone_refactor_orchestrator.py` | execution 记录、环境清理、worktree、统一提交 | 由插件的 run 生命周期 + `clone_submit` 承担 |
| `src/orchestrators/clone_refactor_workflow.py` | 写 skill 请求 JSON、解析 skill 结果、状态映射 | 由会话模型 + `clone_assess` 账本承担 |
| `strategies/codex/clone_refactor.py` | 调用 `$gme-clone-refactor` skill | 不再需要：DSH 里模型就是执行者 |
| `docs/.codex/skills/gme-clone-refactor/**` | **评估规则与最小 patch 规则**（智能所在） | **搬到插件的立场文档 + 工具约束**（见 §8） |
| `src/managers/clone/detection/**` | libclang 切片、Type1-2 token/结构、Type3-4 embedding、合并去重 | **保留**，作为检测层 provider 之一（§7） |
| `src/managers/clone/refactor/*.py` | CSV → 簇聚合、风险信号评分、初筛报告（实际 520 行领域逻辑，不是轻量聚合） | **只移植结构分簇**（列别名解析 + 路径归一化 + 配对图连通分量 + 代表对 + 证据截断，约 150 行 TS）。风险信号评分与初筛报告**不移植** —— 那 8 组正则产出的只是提示，而优先级判断本来就是模型的职责（见 §8），移植一份启发式与模型抢同一件事是重复投资。分簇路径在报告中标注为 `inline` |
| `BuildTestPipeline` + `CriticalSectionManager` | 临界区、编译测试流水线 | **不复刻**，改为声明式步骤清单 + 通用执行引擎（§9） |

### 关键事实 1：智能在 skill 里，不在后端

`gme-clone-refactor/SKILL.md` 定义的全部内容 —— 读簇、判 `P0/P1/P2/PX`、读真实源码确认行为等价、写最小 patch、生成 Markdown + JSON —— 在 DSH 里**是宿主自带能力**。插件只需要补"记账 + 授权闸门 + 验证 + 报告"。

### 关键事实 2：构建测试永远跑在主工程根目录

证据：

- `BuildTestPipeline.__init__`：`self.project_root = config.get_target_project_root()` —— 从不指向 worktree。
- `CriticalSectionManager.acquire()`：`main_file_path = os.path.join(self.target_project_root, target_file)`，`worktree_file_path = os.path.join(worktree_path, worktree_relative_file)` —— 把 worktree 的改动**复制进主目录**编译，退出时用备份 / `git stash` 恢复。
- 流水线 15 步：Step 1 搬进主目录 → Step 10 主目录 `git stash` → Step 13 format 后文件搬回 worktree → Step 14 恢复主目录。

**结论**：worktree 在原系统里解决的是"多 worker 并行 + 提交前暂存"，**不是隔离验证** —— 隔离验证从未发生，代价却是 530 行 `CriticalSectionManager` + 973 行流水线维护搬运/恢复。

**因此本插件不引入 worktree**，采用 **inplace + 独立分支**（见 §3）。这是唯一能绕开搬运层的形态，而且能复用主工作树已有的构建缓存。

---

## 3. 架构总览

### 形态

形态 3（原地替代）为主 + 形态 2 的检测后端：

- 插件**不**自带 Python 服务、**不**自带 Electron；
- 读/改源码、跑命令、git 操作全部经由宿主或宿主服务；
- 插件负责：run 生命周期、账本、覆盖契约、授权闸门与对账、验证编排、报告。

### 三个概念

| 概念 | 定义 |
|---|---|
| **projectRoot** | 主工程根目录（工作树）。构建/测试在这里跑，patch 也打在这里 |
| **基线（baseline）** | 开跑时记录的 HEAD SHA + 工作区干净状态。判断"本次 run 改了什么"的唯一参照 |
| **run** | 一次重构尝试。产物全部落在 `<artifactsRoot>/<run_id>/`，与 projectRoot 基线强绑定 |

### 工作模式

**inplace + 独立分支**：

1. 开跑前校验：`projectRoot` 是 git 仓库、当前分支不是保护分支、工作区干净（否则拒绝，除非 `allowDirty: true` 且记录基线哈希）。
2. 建分支 `clone-refactor/<run_id>`。
3. 模型在该工作树上打 patch。
4. 原生构建/测试验证（复用构建缓存）。
5. 闸门后 commit/push/PR。
6. 跑完明确交还现场：留在该分支，或按配置切回原分支（分支保留）。

放弃 worktree 的代价（必须写进使用文档）：

- 扫描 + 验证期间该工作树被独占，用户不能同时切分支或跑自己的构建（由于构建本身就要独占主工程根目录，这条基本躲不掉）。
- 插件会切换分支。
- 崩溃可能留下脏现场 → 靠基线恢复。

### 分层与依赖方向

```
tools → core → {detect, verify, git, submit, report}
```

- `tools` 只调 `core`，**不碰 fs / git / 进程**。
- `detect`、`verify`、`git`、`submit`、`report` **互不依赖**。
- 它们通过 **run 目录里的文件**交汇，而不是互相调用：检测只写 `clusters.jsonl`，评估只写 `assessments.jsonl`，验证只读账本并写 `verify/N/`。

### 两条外部接口（唯一的耦合点）

| 接口 | 职责 | 实现 |
|---|---|---|
| `CloneDetector` | 产出候选簇 | `python.ts`（驱动现有管线）、`csv.ts`（直读已有 CSV）、未来 `ts.ts` |
| `CommandRunner` | 执行一条命令并返回退出码/输出/超时 | `core/command-host.ts`（宿主 subprocess 服务）、测试用假实现 |

`CommandRunner` 定义在 `core/command.ts` 而不是 `verify/`：`verify/`、`git/`、`detect/python.ts` 都要执行命令，若接口留在 `verify/` 就会产生反向依赖。宿主实现只在 `index.ts`（组合根）里被导入，其余模块一律通过参数接收该接口。

**为什么 `CommandRunner` 必须是接口**：受限模式下 Node 自行 spawn 并捕获子进程管道输出会直接 EPERM；跑命令必须经由宿主服务。抽象出来后，测试不需要真编译器，引擎也不焊死在宿主上。

---

## 4. 工具集（6 个）

| 工具 | 类型 | 输入要点 | 输出/副作用 |
|---|---|---|---|
| `clone_scan` | 动作（不动源码，**异步**） | `run_id?`、`projectRoot`、`module` 或 `target`、`provider?`、`refresh?` | 写 `detection/` 与 `clusters.jsonl`；返回 `accepted` + job 标识或分页簇摘要 |
| `clone_check` | **只读轮询** | `run_id`、`offset?`、`what`（progress/clusters/ledger/log） | 检测/验证进度、日志尾部、簇与账本状态、覆盖缺口；分页用 `next_offset` |
| `clone_assess` | 记账 | `run_id`、`cluster_id`、`verdict`（`patched`/`report_only`/`skipped`）、`priority`、`reason`、`evidence`、`files_changed?`、`confirm?` | 追加 `assessments.jsonl`；`patched` 需 `confirm: true` 且写 `patches.json` |
| `clone_verify` | 动作（长时，**异步**） | `run_id`、`steps?` | 先授权对账，再按步骤清单执行；写 `verify/N/`。**不需要 `confirm`** —— 它不产生外向动作，失败回滚也只影响账本里记录的文件 |
| `clone_submit` | 外向（**`confirm: true` 必需**） | `run_id`、`mode?`（none/commit/push/pr）、`pr` 参数 | commit / push / PR |
| `clone_report` | 关单 | `run_id`、`allow_partial?` | 校验覆盖契约后写 `report.md` / `findings.json` / `summary.json` |

**覆盖契约**：`clusters.jsonl` 里的每个簇最终必须有且只有一个判定（`patched` / `report_only` / `skipped` + 理由）。有簇没有判定时 `clone_report` 拒绝关单，除非显式 `allow_partial: true`（缺口会写进报告，而不是被隐藏）。

**空配置行为**：行始终挂载；`projectRoot` 未配置时不注册任何工具、记一条 warning，并把配置步骤作为 system-prompt 段落写给模型。**任何配置错误都降级到文档化的默认值 + warning，绝不抛错** —— 一条 config 校验失败会让整棵插件树挂掉。

---

## 5. 数据与产物

```
<artifactsRoot>/<run_id>/          默认 artifactsRoot = $DSH_HOME/gme-clone-refactor/runs
├── run.json          run 元数据：projectRoot、基线 HEAD、分支名、provider、配置快照、状态、时间戳
├── clusters.jsonl    append-only：候选簇（含代表 clone pair 证据）
├── assessments.jsonl append-only：每簇一条判定账本
├── patches.json      授权账本：cluster_id、优先级、files_changed、授权方式、时间
├── detection/        检测原始产物（func_clone_<模块>.csv、初筛 CSV/HTML）
├── verify/1/         第 N 次验证：step-<name>.log、result.json、rollback.json
├── report.md         关单产物：概览、按优先级分组的簇、证据、验证结论、覆盖与缺口
├── findings.json     关单产物：机器可读簇清单与判定
└── summary.json      计数：簇总数、各判定数、各优先级数、是否未授权改动、走的哪条检测路径
```

规则：

- **目标仓库永不被插件写入**（除了模型在 projectRoot 上打的 patch 本身）。
- `run_id` 逃逸 `artifactsRoot` 一律拒绝。
- 账本是 **append-only JSONL** → 中断后可重放续跑，不需要重跑检测。
- **run ↔ projectRoot + 基线强绑定**：写进 `run.json`，之后所有工具只认它，不接受中途更换（否则授权对账会错位）。
- 幂等：同 run、同输入、同 provider 的重复 `clone_scan` 返回已有簇，除非 `refresh: true`。

---

## 6. 状态机

每个簇独立推进：

```
scanned ──► assessed ──► patched ──► verified ──► submitted
                │            │           │
                ├─► report_only          └─► verification_failed ──► (回滚) rolled_back
                ├─► skipped(reason)
                └─► unauthorized  ── 冻结整条链路
```

不变式：

1. 没有 `verified` 的簇**永远不能**进入 `submitted`。
2. `patch` 数量不得超过 `authorization.maxClusters`，优先级不得超过 `authorization.maxPriority`。
3. 出现 ledger 之外的改动 → `unauthorized`，冻结。
4. 报告必须能回答"这一簇停在哪个状态、为什么"。

---

## 7. 检测层（provider）

```ts
interface CloneDetector {
  readonly id: string;                       // 'python-pipeline' | 'csv'
  detect(input: DetectInput): Promise<Cluster[]>;
}
```

- `python.ts`：调用现有 `docs/.codex/skills/cpp-clone-detection/scripts/run_gme_clone_detection.py`（经 `CommandRunner`），`--output-root` 指向 run 目录的 `detection/`，读回 `func_clone_<模块>.csv`。保留 Type3-4（embedding 端点由配置提供）。
- `csv.ts`：直读调用方给定的 `func_clone_<模块>.csv`，零额外依赖 —— 这是"可发布"的降级路径。
- `cluster.ts`：CSV 行 → 克隆族的**结构分簇**：列别名解析（大小写不敏感，`file1`/`path1`/`file_1`…、`func1_name`/`function1`…、`lines1`/`line_range1`…、`similarity`/`combined_similarity`/`embedding_similarity`…）、路径归一化、以 `(file, function, lines)` 为节点、克隆对为无向边的连通分量、每族代表对（相似度最高，同分取先出现者）、证据截断 3000 字符。
  **明确不做**：`body_skeleton` / `body_behavior_signature` 比对、8 组风险信号正则、module pair 统计、初筛 Markdown/CSV/HTML。这些在原链路上产出的是"机器初筛提示"，其判断职责由会话模型承担（§8）。因此本插件的分簇与 `cluster_report.py` **不是逐字段等价**，报告必须标注 `cluster: inline`。
- 未来 `ts.ts`：纯 TS 的 Type1-2 检测，接口位置已留好，**本阶段不实现**。

**强制要求**：`run.json` 与最终报告都必须记录**本次走的哪条检测路径** —— 不同 provider 的检测结果不可比，不记录就无法解释历史报告。

---

## 8. 评估与 patch 授权

评估由会话模型按插件立场完成（对应原 `SKILL.md` + `references/decision-rules.md` + `references/risk-rules.md`）：

- 优先级语义：`P0` 高收益低风险模式明确，可自动重构；`P1` 需人工确认；`P2` 技术债记录；`PX` 不建议重构。
- `P0` 候选若未打 patch，**必须给出具体阻断点**（具体语句、调用、分配/释放、宏分支、返回值差异、所有权/生命周期边界、API/ABI 风险，或明确说明达到 `maxClusters` 限制），不接受"语义不确定"这类泛化理由。

三层授权：

| 层 | 机制 |
|---|---|
| 配置层 | `authorization.enabled`（**默认 false**）、`maxPriority`（默认 `P0`）、`maxClusters`（默认 1） |
| 调用层 | `clone_assess` 记 `patched` 需 `confirm: true`，否则拒绝记账 |
| 对账层 | `clone_verify` 比对"相对基线的 diff"与 `ledger.files_changed`；多出文件 → `UNAUTHORIZED_CHANGES`，冻结整条链路 |

**patch 本身不由插件工具执行**：模型用宿主 `edit`/`write` 改 projectRoot 里的源码，`clone_assess` 只做声明 + 授权校验 + 记账。插件无法阻止越权编辑，但能在验证时用 git diff 把越权改动抓出来并冻结 —— 与原后端 `UNAUTHORIZED_CHANGES` 语义一致。

---

## 9. 验证闭环

**不复刻后端流水线**，改为声明式步骤清单 + 通用执行引擎。理由：后端那层的价值在于串行化并行 worker、解析输出、写数据库；插件是单 run、模型在环，只需要"跑命令、判退出码、存日志、把日志给模型"。**编译失败后的自动修复也不需要复刻** —— 后端要 `compile-fixer` 是因为它无人值守，插件的模型本来就能看日志自己改。

步骤清单（通用引擎，随包给 GME profile 示例）：

```yaml
verify:
  steps:
    - { name: configure,    phase: setup,   command: 'cmake -S . -B out -G "Visual Studio 17"', required: true }
    - { name: build-debug,  phase: build,   command: 'msbuild tests.sln /p:Configuration=Debug', required: true, timeoutMs: 3600000 }
    - { name: test-config,  phase: setup,   command: '<改测试启动参数>', required: false }
    - { name: test-debug,   phase: test,    command: 'out/Debug/tests.exe', required: true }
    - { name: restore-config, phase: restore, command: '<恢复测试启动参数>', required: true, always: true }
    - { name: format,       phase: build,   command: 'clang-format -i <changed files>', required: true }
    - { name: format-check, phase: check,   command: 'clang-format --dry-run -Werror', required: true }
```

- `phase: restore` 的步骤**无论前序成功失败都执行**（＝原后端 `try/finally` 的职责）。
- 上面 YAML 里 `<改测试启动参数>` 这类尖括号内容是**站点相关的命令占位示例**，不是待办项：GME profile 的完整取值随文档给出，其余环境由使用者自行配置。
- GME 专有的东西（测试配置切换、`main.cpp` 启动语句替换、mmgr 内存泄漏检查）全部用命令模板表达，**不写死在插件里**；随包提供 GME profile 示例。
- **PASS 口径**：所有 `required: true` 步骤退出码 0，且 `format-check` 无 diff。

失败处理与回滚：

1. 任一步失败 → 记录退出码与日志 → 停止后续非 `restore` 步骤 → 执行 `restore` 阶段 → 状态 `verification_failed`。
2. **默认回滚到基线**，且**只回滚 `ledger.files_changed` 里的文件**（`git checkout -- <files>`）；**绝不 `git reset --hard`**。
3. `keepFailedPatch: true` 可改为保留现场供人工查看。

长时机制：一次验证可能几十分钟，工具调用不能干等。`clone_verify` 立即返回 `accepted: true` + job 标识，由 `clone_check` 轮询。**中断等待不等于取消命令** —— 这一点必须写进使用文档。

---

## 10. 提交与推送边界

| mode | 行为 |
|---|---|
| `none`（默认） | 什么都不做，patch 留在工作区 |
| `commit` | 在 `clone-refactor/<run_id>` 上本地 commit |
| `push` | + push 到 origin |
| `pr` | + 创建 PR（`gh` 或 GitHub API） |

- `clone_submit` 每次都要 `confirm: true`；无 `confirm` 的调用直接失败并给出指引，不触达任何外向动作。
- 凭据（GitHub token）只从环境/配置读取，**绝不出现在工具参数、日志或报告里**。
- 提交范围只包含 `verified` 且对账通过的簇的文件。

---

## 11. 报告与覆盖契约

`clone_report` 关单前检查：`clusters.jsonl` 中每个簇都有判定。缺口存在时拒绝关单，除非 `allow_partial: true`（缺口写入报告）。

报告必须包含：

1. 概览：簇总数、各优先级计数、已 patch 数、验证结论、**本次检测路径**。
2. 按优先级分组的簇，每个 defect/patch 带证据（文件、行、片段、理由）。
3. 验证：跑过哪些步骤、结果、日志位置。
4. 未授权改动（如有）与未复核簇。
5. 覆盖与缺口。

---

## 12. 配置参考

| key | 默认 | 含义 |
|---|---|---|
| `projectRoot` | *（未配置则工具不注册）* | 主工程根目录 |
| `artifactsRoot` | `$DSH_HOME/gme-clone-refactor/runs` | run 产物根 |
| `detection.provider` | `csv` | `python-pipeline` / `csv` |
| `detection.pythonPath` | `python` | Python 解释器（provider = python-pipeline 时） |
| `detection.scriptPath` | — | `run_gme_clone_detection.py` 路径 |
| `detection.libclang` | — | libclang 动态库路径 |
| `detection.embedding.*` | — | Type3-4 的 OpenAI 兼容端点与模型（未配置则跳过 Type3-4 并记 warning） |
| `authorization.enabled` | `false` | 是否允许自动 patch |
| `authorization.maxPriority` | `P0` | 允许 patch 的最高优先级 |
| `authorization.maxClusters` | `1` | 一次 run 最多 patch 的簇数 |
| `verify.steps` | 空 | 步骤清单（见 §9） |
| `verify.keepFailedPatch` | `false` | 验证失败是否保留现场 |
| `submit.mode` | `none` | none/commit/push/pr |
| `submit.baseBranch` | — | PR 目标分支 |
| `workdir.allowDirty` | `false` | 允许在工作区不干净时开跑（此时按文件哈希记录基线，对账只认账本里的文件） |
| `workdir.returnToOriginalBranch` | `false` | 跑完是否切回原分支（`clone-refactor/<run_id>` 分支始终保留） |
| `pageChars` | `12000` | 每次返回报告的分页字符数 |

环境变量回退：`GME_CLONE_REFACTOR_ROOT`、`GME_CLONE_REFACTOR_ARTIFACTS` 等，与现有两个插件的风格一致。

---

## 13. 错误处理与降级

- 配置非法 → 降级到默认值 + warning（**绝不抛错**）。
- `projectRoot` 未配置 → 不注册工具 + warning + system-prompt 写配置步骤。
- 工作区不干净 → 拒绝开跑（除非 `allowDirty: true`）。
- 检测管线不可用（无 Python / 无 libclang）→ 若 provider 为 `csv` 则正常；为 `python-pipeline` 则明确报错并给出替代路径。
- 未授权改动 → 冻结论证与提交，报告显式标出。
- run 目录不可写 → 拒绝开跑，不留下半成品状态。

---

## 14. 测试策略

| 层 | 内容 |
|---|---|
| 纯函数/引擎单测 | 覆盖契约、授权对账、步骤引擎（`always`、超时、失败传播、回滚范围） |
| 全链路状态机 | 假 `CloneDetector` + 假 `CommandRunner`，不需要 GME、不需要编译器 |
| 挂载测试 | 照 `gme-test-generator/tests/install.spec.ts`：用真实 patch 引擎组合 `cordis.patch.yml` 并 mount 进真实 Loader 树 |
| 降级测试 | 空配置 / 非法配置下的挂载行为 |
| 结构分簇 | 固定 CSV 夹具：四组列别名的解析、路径归一化、连通分量划分、代表对选取、3000 字符截断 |

`pnpm run verify` = typecheck + build + tests。

---

## 15. 风险与开放问题

| 项 | 说明 | 处置 |
|---|---|---|
| GME 构建配置未知 | 插件用命令模板，但真实 GME profile 需要人工填写并实测 | 首次自用时把 GME profile 写成文档示例 |
| 分簇口径与现有管线不同 | 本插件只做结构分簇，不含 `cluster_report.py` 的骨架/行为签名比对与 8 组风险正则，因此簇的划分与提示信息不会逐字段一致 | 报告强制标注 `cluster: inline`；风险判断由模型读真实源码完成。将来若需要逐字段一致，可再补一个"调用现有脚本"的 provider（接口位置与检测层同构） |
| Type3-4 依赖 embedding 服务 | 未配置时静默降级会让人误以为跑全了 | 报告强制记录检测路径与是否启用 Type3-4 |
| inplace 占用工作树 | 用户可能同时用该目录 | 写进使用文档；将来做多模块并行时再引入隔离目录 |
| 越权编辑无法阻止 | 插件只能在验证时对账抓出 | 对账失败即冻结；报告显式标出 `UNAUTHORIZED_CHANGES` |
| 崩溃留下脏现场 | 无 worktree 时风险更高 | 基线写盘 + 提供按 baseline 的回滚动作 |
| 运行范围 = 单个 git 仓库 | 基线与回滚都作用在 `projectRoot` 这一个仓库上；**子模块**内的目标文件（例如 `module/laws/**`）由子模块自己的仓库跟踪，主工程的 `git ls-files` / `status` / `diff` 都看不到它们，授权对账会把它们判为未授权、分区回滚会把它们误判为"本次新建" | `projectRoot` 必须指向**跟踪本次目标文件的那个仓库**（目标在子模块内时即指向该子模块）；跨 superproject + submodule 的单次运行不在本期范围，使用文档明确写清 |
| 回滚是分区的，且失败会抛错 | 被跟踪的文件用 `git restore --source=HEAD --staged --worktree` 恢复，本次新建的文件用 `git clean -f` 删除（不加 `-x`，用户自己的 ignored 文件不动）；任一环失败即抛错，而不是留下一份"看起来回滚过"的报告 | 回滚失败会浮到 job 记录与报告里；文件清单只来自授权账本，爆炸半径锁在用户批准过的文件上 |
| 自动回滚只在**干净基线**上安全 | `workdir.allowDirty: true` 允许开跑时工作区就是脏的，此时"回滚到基线"没有意义：对被跟踪文件是 `git restore --source=HEAD`（抹掉操作者开跑前的未提交改动），对未跟踪文件是 `git clean`（删掉他开跑前就存在的文件）。而选择 `allowDirty` 的人，往往正是手上有在改的工作 | 基线不干净时**不自动回滚**：只记录验证失败并置 `rolled_back: false`，把工作区原样留给操作者；`report.md` 明确写出"未回滚，原因：基线不干净"；使用文档写清这一边界 |

---

## 16. 验收标准

1. 未配置时：`dsh web` 正常启动，不注册工具，记 warning，模型能看到配置步骤。
2. 给定一个已有 `func_clone_<模块>.csv`：`clone_scan` → `clone_assess`（逐簇）→ `clone_report` 能产出完整报告，且**不触碰源码**。
3. 配置 `authorization.enabled = true`、`maxClusters = 1`：能对一个 P0 簇打 patch、记账、通过授权对账。
4. 手工制造 ledger 之外的改动：`clone_verify` 判 `UNAUTHORIZED_CHANGES`，不验证、不提交，报告标出。
5. 验证步骤含 `always: true` 的 `restore`：某步失败时 `restore` 仍执行，且回滚只影响 ledger 里的文件。
6. `submit.mode = pr` 且带 `confirm: true`：产出 PR；不带 `confirm` 时立即失败且无任何外向动作。
7. `clone_report` 在存在未判定簇时拒绝关单；`allow_partial: true` 时缺口出现在报告里。
8. `pnpm run verify` 全绿。

---

## 17. 已知与本设计的偏离（供审阅者注意）

- 本设计**放弃了原后端的 worktree + 临界区模型**，理由是它并不提供隔离验证（见 §2）。如果将来要做多模块并行重构，需要重新评估。
- 本设计**不复刻** `BuildTestPipeline` 的 15 步流水线，GME 专有步骤以命令模板 + 示例 profile 表达。真实 GME 环境的可用性需要一次实测。
- 检测层的 TS 原生实现（零 Python 依赖）**留了接口位置但不在本期实现**。
