# 配置与运行

[English](setup.md) | 中文

`dsh-gme-clone-refactor` 是 DeepSeek Harness 上的克隆重构工作流。本页是完整的配置与行为参考：安装、两个环境变量、每一个配置键、六工具工作流、run 工件落点、两条检测路径、授权与回滚规则、插件关不掉的凭据暴露面、运行范围、首次自用实测清单、发布清单与故障排查表。

## 1. 插件做什么

它把“这些函数看起来互为副本”变成一条可重复、可核对的流程，而不是一句意见：

1. `clone_scan` 把一个模块的克隆族枚举进 `clusters.jsonl`。这份簇清单就是本次 run 的覆盖度契约。
2. `clone_assess` 为每个簇记录一条判定——`patched`、`report_only` 或 `skipped`——其中 `patched` 才会写下授权记录。
3. `clone_verify` 把授权账本与 git 实际报出的改动对账，然后把本站的构建与测试步骤当作真实命令清单来跑，并保留每一份日志。
4. `clone_submit` 提交、推送、按需开 PR——只针对已授权的文件、只在验证通过之后，且必须 `confirm: true`。
5. `clone_report` 在还有簇没有判定时拒绝收口，收口时写出 `report.md`、`findings.json`、`summary.json`。

它从不猜。没有通过验证的 patch 不能提交，用户从未授权的被改文件会冻结整个 run。插件本身从不改源码：模型用宿主自己的工具在 work tree 上打 patch，插件的职责是记录谁授权了什么、验证它、并在边界前拒绝继续。

**配置写坏了它绝不抛错。** 一条 config 校验失败的行会把整棵插件树拖垮（`dsh: 1 entry did not activate`），所以每个非法值都降级为文档中的默认值并记一条 warning。没有 `projectRoot` 时条目依然挂载，只是不注册任何工具（第 2 节）。

## 2. 安装

**通过 DSH 命令行安装：**

```sh
# $dsh 指 CLI 入口：<deepseek-harness>/apps/cli/lib/bin.js
node $dsh plugin --profile web add dsh-gme-clone-refactor
```

该命令会安装本包，并把**包名** `dsh-gme-clone-refactor` 追加到 profile 的 `dsh.profile.bundles`——bundle 条目的值就是该 bundle 的包名。本包自带 `dsh.bundle.patch` 层（`cordis.patch.yml`），因此**无需手工编辑任何 profile 文件**。之后重启该 profile 即可。

重启前先确认 profile 实际会挂载什么：

```sh
node $dsh --profile web --dump-config
```

组合后的条目会原样打印 `gme-clone-refactor` 行及其 `!!js` 表达式，因此无需真正启动就能看出值是否被解析或被覆盖。未配置是一种受支持的状态，而不是故障：没有 `projectRoot` 时插件不注册**任何**工具、只记一条 warning，并把完整的配置步骤作为 system-prompt 段落写给模型。

**从本地检出安装**——也就是本仓库（Windows + pnpm 12 上实测）：

```powershell
cd D:\path\to\dsh-gme-clone-refactor
pnpm install
pnpm run verify        # 类型检查 + 构建 + vitest + 打包产物冒烟
pnpm pack              # 生成 dsh-gme-clone-refactor-<版本>.tgz
```

然后在 `$DSH_HOME\profiles\<profile>\`（例如 `C:\Users\<你>\.dsh\profiles\web\`）里，把 tarball 加成一条 `file:` 依赖，并把包名加进 `dsh.profile.bundles`，再在那里执行 `pnpm install`。`pnpm install` 会从 manifest 解析这个 `file:` 规格，`pnpm add` 不会——在 pnpm 12 上，交给 `pnpm add` 的本地路径（绝对、相对、`file:`、`link:` 或 `.tgz`）都会被当成注册表包名解析，报 `ERR_PNPM_PACKAGE_MANAGER_ADD_RESOLVE_LATEST`。tarball 必须留在 profile 目录里（依赖指向它）；插件改动后需要重新打包并重装。

**不改 profile 文件**也可以：在 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 里写一条指向已构建包的补丁条目（包仍需按上面的方式装好，profile 才能解析到它）：

```yaml
- insert:
    - id: gme-clone-refactor
      name: 'dsh-gme-clone-refactor'
      config:
        projectRoot: D:/workspace/GME
```

补丁条目只替换它写明的键（`config` 整体替换），所以想保留的字段要全部重述（见第 4 节）。

## 3. 环境变量

随包的 `cordis.patch.yml` 会读这两个变量，因此在多数部署里它们就是全部配置。它们在 **Harness 启动时**读取，不是调用工具时：

```powershell
$env:GME_CLONE_REFACTOR_ROOT      = 'D:/workspace/GME'
$env:GME_CLONE_REFACTOR_ARTIFACTS = 'D:/workspace/gme-clone-runs'   # 可选
node $dsh web
```

| 变量 | 配置键 | 含义 |
|---|---|---|
| `GME_CLONE_REFACTOR_ROOT` | `projectRoot` | 本插件允许改动的 GME 工作树；为空则不注册任何工具 |
| `GME_CLONE_REFACTOR_ARTIFACTS` | `artifactsRoot` | run 的存放目录；为空即 `$DSH_HOME` 下的默认值 |

仓库里的条目把两者读成带兜底值的表达式，因此变量缺失只会得到空字符串，而不是报错：

```yaml
# cordis.patch.yml —— 仓库里提交的条目
- insert:
    - id: gme-clone-refactor
      name: 'dsh-gme-clone-refactor'
      config:
        projectRoot: !!js process.env.GME_CLONE_REFACTOR_ROOT ?? ''
        artifactsRoot: !!js process.env.GME_CLONE_REFACTOR_ARTIFACTS ?? ''
```

环境变量装不下的东西——检测路径、授权开关、验证步骤——写成 profile 覆盖：

```yaml
- id: gme-clone-refactor
  config:
    projectRoot: D:/workspace/GME
    artifactsRoot: D:/workspace/gme-clone-runs
    detection:
      provider: csv
      csvPath: D:/workspace/clone-reports/func_clone_base.csv
    authorization:
      enabled: false
      maxPriority: P0
      maxClusters: 1
    submit:
      mode: none
```

## 4. 配置参考

每个键都是可选的；非法值降级为默认值并记一条 warning（Harness 日志里的 `gme-clone-refactor: <原因>`），而不是让启动失败。字符串键上“存在但只写了空白”等同于未设置。

| 键 | 默认 | 说明 |
|---|---|---|
| `projectRoot` | `""` | 本插件允许改动的 GME 工作树。**为空表示完全不注册工具**（第 2 节）；相对路径按进程工作目录解析，因此和运行范围一样，请给绝对路径（第 11 节） |
| `artifactsRoot` | `""` | run 的存放目录。为空即 `$DSH_HOME/gme-clone-refactor/runs`，也就是 `~/.dsh/gme-clone-refactor/runs`。所有写入都在它之下，试图逃出它的 `run_id` 会被拒绝 |
| `detection.provider` | `"csv"` | 由哪个检测器作答：`csv`（直读已有的克隆报告，不需要别的东西）或 `python-pipeline`（驱动 GME 检测脚本） |
| `detection.csvPath` | `""` | `csv` 路径要读的 `func_clone_<module>.csv`。`clone_scan` 的 `csv_path` 参数会覆盖它；两者都为空时扫描被拒绝，因为按进程工作目录猜一个文件名可能静默扫到错的报告 |
| `detection.pythonPath` | `"python"` | 运行检测脚本的 Python 解释器。它必须是装了 libclang 的那个环境 |
| `detection.scriptPath` | `""` | `run_gme_clone_detection.py`。`python-pipeline` 必填；未配置时该路径会以这个键名明确报错，而 `csv` 路径照常工作 |
| `detection.libclang` | `""` | libclang 库路径；非空时以 `--libclang` 传给脚本 |
| `detection.enableType34` | `false` | 打开（`--enable-type34`）或关闭（`--disable-type34`）3-4 型（embedding）检测。关闭时报告仍会记录检测路径，但不会声称做过 3-4 型 |
| `detection.embeddingModel` | `""` | 3-4 型用的 embedding 模型名（`--type34-model`），端点需要时填 |
| `detection.embeddingApiBase` | `""` | **commercial** 通道的 OpenAI 兼容 base URL。设置它**或** `detection.embeddingApiKey` 才会选中 commercial 通道（第 7 节） |
| `detection.embeddingApiKey` | `""` | 该端点的凭据。为空表示管线留在它自己的 local 通道上，此时根本不用 key（第 10 节） |
| `detection.embeddingThreshold` | `0.8` | 3-4 型的相似度阈值（`--type34-threshold`），0–1 |
| `authorization.enabled` | `false` | 是否允许任何 run 改动源码。关闭时 `clone_assess` 拒绝 `patched` 判定；扫描、判定与报告照常可用 |
| `authorization.maxPriority` | `"P0"` | 本部署允许 patch 的**最不严重**的那一档——这是上限，不是愿望清单。`P0` 只放 P0，`P1` 放 P0–P1，`P2` 放 P0–P2，`PX` 放开一切 |
| `authorization.maxClusters` | `1` | 同一时刻允许持有**有效**授权的簇数。它不是“本次 run 一共 patch 过几次”：某簇判定离开 `patched` 时账本会删除它的记录，名额随之腾出（取值 0–100） |
| `verify.steps` | `[]` | `clone_verify` 按序执行的命令清单。**为空会被拒绝**：零步骤时引擎报 `ok`，那会让每个 patch 都看起来通过了验证。字段见下表 |
| `verify.keepFailedPatch` | `false` | 为真时验证失败后保留现场供人工排查，而不回滚（第 8 节） |
| `verify.outputMaxBytes` | `4194304` | 插件跑的每条命令每路输出保留的字节数。超出部分由宿主落盘 spill，日志标记 `lossy`（1024–268435456） |
| `verify.graceMs` | `5000` | 超时后宿主在强杀命令前再等多久（0–60000） |
| `submit.mode` | `"none"` | `clone_submit` 允许做什么：`none`、`commit`、`push` 或 `pr`。工具自己的 `mode` 参数可对单次调用覆盖它 |
| `submit.baseBranch` | `""` | PR 的目标分支。为空即 `main`。只在 `pr` 模式下有意义 |
| `submit.remote` | `"origin"` | `git push` 用的远端。只在 `push` / `pr` 模式下有意义 |
| `submit.commitMessageTemplate` | `""` | 提交信息模板。为空即 `clone refactor(<run_id>): deduplicate <n> file(s)`。可用占位符为 `{run_id}`、`{files_count}`、`{timestamp}`；未知占位符保持原样可见，不会被清空 |
| `workdir.allowDirty` | `false` | 允许在工作区已有改动时开跑。它记录按哈希的基线，对账只认账本里的文件——并且**停用自动回滚**（第 8 节） |
| `reportLanguage` | `"zh"` | `report.md` 与工具结果摘要的语言：`zh` 或 `en` |
| `pageChars` | `12000` | 一次 `clone_check` 簇分页的字符预算（256–50000）。一个簇带两份函数体，所以分页按字符界而不是固定条数 |

`verify.steps` 的每个条目逐字段归一化；没有非空 name 和 command 的条目会被丢弃并记 warning，不是对象的条目同样如此：

| 步骤字段 | 默认 | 说明 |
|---|---|---|
| `verify.steps[].name` | —（必填） | 步骤名，出现在日志文件名与 `report.md` 里 |
| `verify.steps[].phase` | `"build"` | `setup`、`build`、`test`、`check`、`restore` 之一。它是说明性的，也决定 `always` 的默认值 |
| `verify.steps[].command` | —（必填） | 整条命令行，按空白切分成 argv，带引号的片段保持完整。它被**原样使用**：**没有任何占位符替换**，所以需要作用于“本次改动的文件”的步骤必须自己写明路径，或调用一个自己会读账本的站点脚本 |
| `verify.steps[].required` | `true` | 该步骤失败是否让整次尝试失败 |
| `verify.steps[].always` | `phase: restore` 时为 `true`，否则 `false` | 前序步骤失败后是否仍然执行。`restore` 默认为真，因为失败后跳过收尾是流水线唯一绝不能做的事 |
| `verify.steps[].timeoutMs` | `1800000` | 单步超时毫秒数（1000–86400000）。超时的步骤永不算通过，其日志会写明这一点 |

### 一份完整的 GME profile 示例

下面这份是一个完整、自洽的起点。其中的命令行是**站点相关、且在本计划中未经验证**的：GME 真实的构建与测试命令必须在你的机器上确认——第 12 节的清单正是为此存在。尖括号包起来的部分是命令示例，不是插件里的待办项。

```yaml
- id: gme-clone-refactor
  config:
    projectRoot: D:/workspace/GME
    artifactsRoot: D:/workspace/gme-clone-runs
    detection:
      provider: python-pipeline
      pythonPath: D:/Python311/python.exe
      scriptPath: D:/workspace/GME/docs/.codex/skills/cpp-clone-detection/scripts/run_gme_clone_detection.py
      libclang: D:/llvm/bin/libclang.dll
      enableType34: true
      embeddingModel: text-embedding-3-large
      embeddingApiBase: https://api.example.com/v1
      embeddingApiKey: !!js process.env.GME_EMBEDDING_KEY ?? ''
      embeddingThreshold: 0.8
    authorization:
      enabled: true
      maxPriority: P0
      maxClusters: 1
    verify:
      outputMaxBytes: 4194304
      graceMs: 5000
      keepFailedPatch: false
      steps:
        - name: configure
          phase: setup
          command: 'cmake -S . -B out -G "Visual Studio 17 2022"'
          required: true
        - name: build-debug
          phase: build
          command: 'cmake --build out --config Debug'
          required: true
          timeoutMs: 3600000
        - name: test-config
          phase: setup
          command: '<把测试宿主指向本次 run 的命令>'
          required: false
        - name: test-debug
          phase: test
          command: 'out/Debug/tests.exe'
          required: true
          timeoutMs: 1800000
        - name: format
          phase: build
          command: 'D:/llvm/bin/clang-format.exe -i module/laws/src/a.cpp'
          required: true
        - name: format-check
          phase: check
          command: 'D:/llvm/bin/clang-format.exe --dry-run -Werror module/laws/src/a.cpp'
          required: true
        - name: restore-config
          phase: restore
          command: '<恢复测试宿主设置的命令>'
          required: true
          always: true
    submit:
      mode: none
      baseBranch: main
      remote: origin
      commitMessageTemplate: 'clone refactor({run_id}): deduplicate {files_count} file(s)'
    workdir:
      allowDirty: false
    reportLanguage: zh
    pageChars: 12000
```

## 5. 工作流

| 步骤 | 工具 | 行为 |
|---|---|---|
| 1 | `clone_scan` | 可选 `run_id`（沿用既有 run，或以该 id 新建——结果里的 `created` 指出是哪一种）、`module`（`python-pipeline` 路径需要它）、`csv_path`（覆盖 `detection.csvPath`）、`refresh`（已有簇时仍重扫）。返回 `accepted`、`job_id`、provider 与当前簇数。它在后台跑：先用 `clone_check` 的 `what: status` 轮询到 job 离开 `running`，再读簇 |
| 2 | `clone_check` | 只读，且从不创建 run。`run_id` 加 `what`：`status`（最新的 job，或 `null`，以及读不出来的 `unreadable_jobs` 与 `unreadable_attempts` —— job 记录与验证记录各一份）、`clusters`（一页，带 `offset`、`next_offset` 与覆盖缺口）、`ledger`（每个簇的有效判定加授权记录）、`log`（最新步骤日志的尾部，`log_lines` 行，默认 80） |
| 3 | `clone_assess` | 每个簇一条判定：`verdict`、`priority`、`reason`；可选 `evidence` 与 `files_changed`，`replace: true` 覆盖既有判定。`patched` 判定需要 `confirm: true`、`authorization.enabled`、至少一个 `files_changed`、`evidence`，且优先级在 `authorization.maxPriority` 之内；**未**打 patch 的 `P0` 判定同样需要具体阻断点的证据。返回 `covered` / `total` / `remaining` |
| 4 | `clone_verify` | 先把授权账本与 git 实际改动集合对账，写出 `verify/<n>/reconcile.json`；账本之外有改动就以 `UNAUTHORIZED_CHANGES` 拒绝；否则在后台按配置执行步骤。返回 `accepted`、`attempt` 序号与 `authorized_files` |
| 5 | `clone_submit` | `confirm: true` 是强制项，且在别的检查之前先查；最新一次验证未通过的 run 不能提交，空账本则没有东西可提交。`mode` 对本次调用覆盖 `submit.mode` |
| 6 | `clone_report` | 可选 `notes` 与 `allow_partial`。写出三个工件，并返回它们的路径、摘要与一行 digest |

这些拒绝是设计的一部分，不是障碍：未知 `cluster_id` 会被拒并给出本次 run 确实有的 id；`patched` 判定没有 `confirm: true` 会被拒；步骤清单为空的验证会在任何有破坏性的动作之前被拒；含路径分隔符的 `run_id` 会被拒，从而让模型提供的 id 无法写到工件目录之外。

## 6. 工件

每个 run 一个目录 `<artifactsRoot>/<run_id>/`，`run_id` 默认为 UTC 的 `<YYYYMMDD-HHMMSS>-<4 位随机串>`（调用方也可以指定）：

| 文件 | 内容 |
|---|---|
| `run.json` | `run_id`、`project_root`、`baseline`（`head`、`branch`、`dirty`）、`branch`、`original_branch`、`detection_provider`、`cluster_path`、`created_at`、`updated_at`，以及本次 run 启动时的配置快照。`detection.embeddingApiKey` 存为 `[redacted]`，绝不落明文（第 10 节） |
| `clusters.jsonl` | 扫描得到的簇，一行一个 JSON 对象，每个簇带代表克隆对与截断后的函数体 |
| `assessments.jsonl` | 追加写的判定账本，一条判定一行。修正判定就是新写一行，同一簇以最后一行为准 |
| `patches.json` | 授权账本：每个当前处于 `patched` 的簇一条记录（`cluster_id`、`priority`、`files_changed`、`recorded_at`，以及该判定所依据的 `evidence`）。撤回判定会删掉对应记录 |
| `detection/` | 检测路径自己的产物：管线的 `func_clone_<module>.csv` 与 `detect-command.txt`（已脱敏的调用行）；`csv` 扫描的报告在别处时这里可以为空 |
| `verify/<n>/` | 每次尝试一个目录：每步一份 `<序号>-<步骤>.log`、`result.json`（本次尝试的结论，含 `rolled_back`、`rollback_files` 与本次运行的 `configured_steps`）与 `reconcile.json`（授权文件 vs 实际改动） |
| `jobs/<job_id>.json` | `clone_check` 轮询的 job 记录：`job_id`、`run_id`、`kind`（scan 或 verify）、`status`（running / succeeded / failed）、`started_at`、`finished_at`、`error`、`summary` |
| `report.md` | 人读报告：概览、按优先级分组的簇及其证据、覆盖缺口、已授权改动、验证尝试、未授权改动、最后的 job、跳过的账本行与你的备注 |
| `findings.json` | 机器可读的簇清单，每簇带判定、优先级、理由、`evidence`（文件、行号、片段；未记录时为 `null`）与已授权文件 |
| `summary.json` | 计数：`run_id`、`baseline_head`、`detection_provider`、`cluster_path`、`clusters`、`recorded`、`missing`、`patched`、`report_only`、`skipped`、`by_priority`、`authorized_files`、`verify_attempts`、`verify_ok`、`unauthorized_files`、`resolved_unauthorized_files`、`unreadable_records`、`unverified`、`dropped_lines`，以及渲染报告内容的 `digest` |

默认根目录是 `$DSH_HOME/gme-clone-refactor/runs`（未设 `DSH_HOME` 时即 `~/.dsh/gme-clone-refactor/runs`）。该目录之外不会写入任何东西，除了模型在 `projectRoot` 上打的 patch，以及该 patch 触及文件的回滚。

`dropped_lines` 是判定读取时被跳过的断行（追加写入途中崩溃会留下半行）。没有它，缩水的 run 与完整的 run 无法区分。

## 7. 两条检测路径

`csv` 直读一个已存在的 `func_clone_<module>.csv`。除 Harness 外什么都不需要，是自足的路径，也是默认值。

`python-pipeline` 用 `detection.pythonPath` 驱动现有的 GME 脚本（`detection.scriptPath`）。它是拿到 3-4 型（embedding）克隆的唯一路径，需要一个装了 libclang 的 Python 检出，3-4 型还需要一个 embeddings 端点。

**两者的簇集合永远不可比，所以 run 会记录本次是哪条路径作答**（`run.json` 里的 `detection_provider`，并打印在 `report.md` 里）；一份报告只有配上这一行才读得通。

3-4 型需要 `detection.enableType34: true` **并且**选中 commercial 嵌入通道。选中它的开关是 `detection.embeddingApiBase` 或 `detection.embeddingApiKey` 非空：此时插件会传 `--embedding-provider commercial`。两者都空时插件两个都不传，脚本留在它自己的 `local` 通道上，此时根本不用 key。因此，为一次从未选中 commercial 的 run 配了 key，就是让它白白躺在命令行上（第 10 节）。

这里的分簇是结构性的：它不复刻 Python 管线的函数体骨架比对、行为签名与风险信号正则。报告因此标注 `cluster: inline`，而从真实源码判断风险是模型的职责。

## 8. 授权、验证与回滚

**三层授权。**

| 层 | 机制 |
|---|---|
| 配置层 | `authorization.enabled`（默认 false）、`authorization.maxPriority`、`authorization.maxClusters` |
| 调用层 | `clone_assess` 只在 `confirm: true` 且簇在 `maxPriority` 之内时才记 `patched` |
| 对账层 | `clone_verify` 把 git 实际改动集合与 `patches.json` 比对；多出来的文件即 `UNAUTHORIZED_CHANGES`，冻结整条链路 |

`authorization.maxPriority` 是**严重度上限**，不是愿望清单：`P0` 只放 P0，`P1` 放 P0–P1，`P2` 放 P0–P2，`PX` 放开一切。设计 §8 同时明确说 `PX` 簇**任何时候都不该被重构**，所以把 `PX` 写成“允许一切”，等于允许插件去改那些这条工作流本来就要放过的簇——请只在明确知情时这么做。

`authorization.maxClusters` 数的是**此刻有效**的授权记录个数，不是这次 run 一共打过几次 patch。撤回一个判定就会腾出它的名额。

**一次验证通过意味着什么。** 每个 `required: true` 的步骤都必须退出码 0；超时的步骤无论退出码是什么永不算通过。非 `always` 的步骤在前序失败后被跳过，`restore` 无论前序结果都执行，本次尝试的 `result.json` 记录跑了哪些步骤、退出码、日志位置，以及流水线是否被截断。

**回滚。** 一次尝试失败、`verify.keepFailedPatch` 为假、至少有一个授权文件、且该 run 的基线干净时，插件把授权文件回滚到基线——分两部分做，因为这些文件并不都是同一类：

- git 跟踪的文件用 `git --literal-pathspecs restore --source=HEAD --staged --worktree -- <files>` 恢复；
- 本次 run **新建**的文件用 `git --literal-pathspecs clean -f -- <files>` 删除（不加 `-x`，因此你原本忽略的文件绝不会被动到）。

`--literal-pathspecs` 是有意的加固：文件名来自账本的 `files_changed`，git 否则会把其中一个元字符当成 pathspec 通配——账本路径里一个 `*` 就会把命令放大到整个仓库。这个标志让 git 把每个名字都当字面量。

被点名的文件只来自授权账本的 `files_changed`，所以爆炸半径正好是用户批准过的那一批。回滚任一步失败都会抛错，失败会体现在 job 记录与报告里——报告绝不会声称一次并未发生的回滚。插件永不执行 `git reset --hard`。

**`workdir.allowDirty: true` 会停用自动回滚。** 基线不干净意味着你开跑前手上就有未提交的工作；恢复被跟踪文件会抹掉你的改动，清理未跟踪文件会删掉开跑前就存在的文件。此时 run 会记录 `rolled_back: false`，报告写明工作区被原样留下。

## 9. 撤回判定，以及怎么走出冻结

把一个已 `patched` 的簇改判为 `report_only` 或 `skipped` 会**撤回它的授权**：`patches.json` 里对应记录被删除。它**不会**撤销补丁。工作树里那个文件仍然是改过的，因此 `clone_verify` 会（正确地）判它未授权，并以 `UNAUTHORIZED_CHANGES` 冻结整个 run。

出冻结有**两条**路，插件两条都不会替你做：

1. **你自己还原该文件**：在 `projectRoot` 里执行 `git restore --source=HEAD -- <file>`。
2. **重新授权该簇**：用 `replace: true` 与 `confirm: true` 再调一次 `clone_assess`，`verdict: patched`，并给出它改过的文件。

没有任何东西会自动还原文件。在用户说了“不要这个 patch”之后再去改他的代码，正是授权闸门存在的意义。模型在提示词里会读到这一条，所以卡在冻结上的用户问一句就能得到这个解释。

## 10. 凭据暴露面

两半，只有一半是关上的。

**已关上：run 目录。** 插件把 embedding key 以**命令行参数**的形式传给检测脚本（脚本只认 `--embedding-commercial-api-key`，而命令执行接口不传环境变量），并把 key 的每一处出现从调用记录、捕获的输出流、以及任何抛出的消息里脱敏。持久化的 `run.json` 快照同样不含 key：它在唯一的“记录变字节”边界上被替换为 `[redacted]`，创建与保存两条路径都走这个边界。**因此复制或发布一个 run 目录不会泄漏这个 key**，也没有任何工具返回 record 或 settings。

**残留：run 周边的命令行。** key 仍然在子进程的 `argv` 上，因此一个会回显自身 `argv` 的管线——诊断转储、崩溃报告、啰嗦的脚本——可能把它写进**宿主的 spill 文件**。宿主把被截断的那部分子进程输出落盘到 run 目录之外，插件既读不到也脱不了敏。如果你为一次 `python-pipeline` 扫描提供过端点 key，请把 run 目录周边的产物也当作潜在敏感物：插件自己的日志已脱敏，宿主的 spill 文件没有。

插件从不向 `clone_submit` 提供 GitHub 凭据：`git` 与 `gh` 用宿主本来就有的凭据，因此不会有 token 出现在被 run 记录下来的命令行上。

## 11. 运行范围：哪个 git 仓库

`projectRoot` 必须是**跟踪本次目标文件的那一个** git 仓库。这不是风格偏好——它决定授权对账与回滚是否正确：

- 基线、改动集合与回滚都只从这一个仓库读；
- 如果目标在子模块内（例如 `module/laws/**`），主工程的 `git ls-files`、`git status`、`git diff` 都看不到它；
- 于是子模块内一次已授权的改动在 `clone_verify` 眼里会是未授权、从而冻结 run，而分区回滚会把一个真实存在的文件当成“本次新建”删掉。

目标在子模块内时，把 `projectRoot` 指向该子模块本身。跨 superproject + submodule 的单次运行不在本期范围。

## 12. 首次自用实测清单

GME 精确的构建与测试命令并没有被插件自己的测试套件验证过——插件只跑你配置的命令行。在信任一次 run 之前，请有意地做一遍：

1. `verify.steps` 里**先只放一条 `build`**，跑一次 `clone_verify`。读 `verify/1/1-<name>.log`，确认命令、工作目录（必须是 `projectRoot`）与捕获的输出都符合预期。
2. 逐条加上 `test`、`format` 与 `restore`，并逐条确认退出码判定与 `always` 语义：一条必需的步骤失败会让整次尝试失败，其后的非 `always` 步骤被跳过，而 `restore` 步骤仍然执行。
3. 确认 `format-check` 用的是 **GME 自己的 clang-format 版本（17.0.2）**。换一个版本，它的格式判定就不再是关于这份代码库的结论。
4. 在一个只读的 run 上，确认 `submit.mode: none` 时 `clone_submit` 什么都不做——带 `confirm: true` 调用时它返回 `mode: none`，不产生任何外向动作。

## 13. 发布清单（只准备，不执行）

准备发布不属于“使用插件”。下面是本工作区自己的发布说明里的顺序，列在这里以免临场发挥：

```sh
pnpm install
pnpm run verify                    # 类型检查 + 构建 + vitest + 打包产物冒烟
npm pack --dry-run                 # 发布任何东西之前先看文件清单
git remote add origin git@github.com:nuaaweixinye/dsh-gme-clone-refactor.git
git tag -a v0.1.0 -m "dsh-gme-clone-refactor 0.1.0"
git push -u origin main --follow-tags
gh repo edit --add-topic dsh-plugin
npm publish --registry https://registry.npmjs.org
```

打包清单必须包含 `lib/`、`cordis.patch.yml`、`LICENSE`、两份 README，以及 `docs/setup.md` + `docs/setup.zh.md`，并且**不得**包含 `docs/superpowers/`（内部计划与设计稿不发布）。npm 发布强制 2FA，带 bypass-2FA 的 granular token 不能做账号级操作，因此 `npm publish` 需要账号先开好 2FA。`git push` 需要远端，而本检出没有配置任何远端，所以这一步不可能被误触。这份清单里没有任何一条由插件执行，也不由产出它的任务执行：推送与发布都是外向动作，需要各自明确的决定。

## 14. 故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 报 `detection.scriptPath is not configured, so the python-pipeline provider cannot run` | 配了 `detection.provider: python-pipeline` 但没配脚本路径 | 把 `detection.scriptPath` 指向管线的 `run_gme_clone_detection.py`，或改用 `detection.provider: csv` |
| 报 `verify.steps is empty, so nothing can be verified` | 没有配置任何验证步骤 | 补上构建/测试步骤；空清单会让每个 patch 都看起来通过了验证，所以 `clone_verify` 直接拒绝 |
| 报 `The work tree <路径> is not clean (N changed file(s))` | `openRun` 发现无关的未提交改动 | 提交或 stash 它们，或设 `workdir.allowDirty: true`——同时要知道这会停用自动回滚（第 8 节） |
| run 永远停在 `running` | 一条**没有终态**的 job 记录：命令被中断，或终态写盘失败（后者任务本身可能已经成功——这个失败会通过一条日志 warning 报出来） | 两者都不算成功。用 `clone_check` 的 `what: log` 看日志尾部；如果活儿其实干完了，任务结论在 `verify/<n>/result.json` 里，即使 job 记录是旧的。不要凭一条 `running` 记录去提交 |
| 报 `UNAUTHORIZED_CHANGES: <文件> changed but is not in the authorization ledger` | 工作树里有文件被改而没有任何 `patched` 判定授权它——包括判定后来被撤回的文件 | 这是冻结，不是 bug。还原该文件（`git restore --source=HEAD -- <file>`），或用 `replace: true` 把该簇重新判回 `patched`（第 9 节） |
| 3-4 型一个都没找到，或者 key 配了却毫无作用 | 选中 **commercial** 通道的是 `detection.embeddingApiBase` / `detection.embeddingApiKey`；两者都空时管线走它自己的 local 通道，key 只是白白躺在命令行上 | 设 `detection.embeddingApiBase`（端点需要时再加 key），保持 `detection.enableType34: true`，并在 `detect-command.txt` 里确认有 `--embedding-provider commercial` |
| 想要 patch 的簇被拒：`authorization.maxPriority is P0, so a P1 cluster may not be patched` | `maxPriority` 是**允许的最高严重度**，不是“我要重构这些”：`P0` 只放 P0，`P1` 放 P0–P1，`PX` 放开一切 | 把 `maxPriority` 提到你确实打算允许的那一档——并记住 `PX` 同时也会放行设计 §8 说任何时候都不该重构的那些簇 |
| 报 `authorization.maxClusters is N; this run already patched N cluster(s)` | 上限数的是有效授权记录，而你已经用满 | 撤回一个判定腾出名额，或者有意地调大 `maxClusters` |
| 报 `Not a clone report` / `No CSV to scan` | CSV 表头里没有 `file1`/`file2` 这一对列，或没有配置任何 CSV 路径 | 把 `detection.csvPath`（或 `csv_path` 参数）指向真实的 `func_clone_<module>.csv`；否则静默的空簇清单会被当成“这个模块没有克隆” |
| 启动时 `dsh: 1 entry did not activate` 并指向本条目 | 手工编辑过的条目配置校验失败 | 修正或删掉该覆盖；出厂条目会降级为默认值并记 warning，不会抛错 |
| 报 `run_id '<id>' escapes the artifacts root` | run id 含路径分隔符或 `.` 段 | 用普通名字，例如 `20260920-010203-ab12` |

## 15. 开发

```sh
pnpm install
pnpm run verify        # tsc --noEmit + tsdown + vitest run + node tests/pack-smoke.mjs
```

`src/index.ts` 负责配置、默认值与提示词段落；`src/tools.ts` 负责六个工具定义与其薄校验；`src/core/` 负责 run 目录、追加写账本与 job 记录；`src/detect/` 负责两条检测路径与结构分簇；`src/verify/` 负责步骤引擎与尝试记录；`src/git/` 负责基线读取、对账与回滚；`src/report/` 负责报告与计数。各能力模块之间互不调用：它们只通过 run 目录里的文件交汇。

`tests/workflow.spec.ts` 用真实 Cordis `Tools`/`SystemPrompt` 上下文加假命令执行器驱动六个工具；`tests/install.spec.ts` 用真实补丁引擎组合仓库里的 `cordis.patch.yml`，并把得到的条目挂进真实 Loader 树；`tests/docs.spec.ts` 把两份 README 的工具表与实时工具注册表对照，并把两份配置文档与 `resolveSettings` 对照；`tests/pack-smoke.mjs` 检查打包产物本身。
