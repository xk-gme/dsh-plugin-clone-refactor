# dsh-gme-clone-refactor

[English](README.md) | 中文

在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）里做 GME 克隆重构：扫描一个模块的克隆族，逐簇判定，只打一个经用户授权的最小 patch，用真实的构建与测试验证它，并且只提交通过验证的部分。它从不猜：没有通过验证的 patch 不允许提交，而任何一个用户从未授权过的被改文件都会冻结整个 run。

这是一个社区插件，不是 DeepSeek 官方包。

## 工具

| 工具 | 作用 |
|---|---|
| `clone_scan` | 把一个模块的克隆族枚举成本次 run 的覆盖度契约（后台任务） |
| `clone_check` | 只读轮询：最新的 job、簇、判定账本、最新一次验证日志的尾部 |
| `clone_assess` | 为每个簇记录一条判定——`patched`、`report_only` 或 `skipped`——并执行授权闸门与证据规则 |
| `clone_verify` | 先把授权账本与真实 diff 对账，再执行配置好的构建/测试步骤（后台任务） |
| `clone_submit` | 提交、推送，按需开 PR——只在有通过的验证之后，且必须 `confirm: true` |
| `clone_report` | 关单：写出 `report.md`、`findings.json`、`summary.json`，拒绝隐藏覆盖缺口 |

扫描产出的每个簇都必须先有判定，run 才能收口；否则 `clone_report` 会拒绝，除非调用方接受 `allow_partial: true`——此时缺口会写进报告，而不是被丢掉。

## 安装

```sh
# $dsh 指 CLI 入口：<deepseek-harness>/apps/cli/lib/bin.js
node $dsh plugin --profile web add dsh-gme-clone-refactor
```

该命令会安装本包，并把它的包名 `dsh-gme-clone-refactor` 追加到 profile 的 `dsh.profile.bundles`——bundle 条目的值就是该 bundle 的包名。本包自带 `dsh.bundle.patch` 层，因此**无需手工编辑任何 profile 文件**。之后重启该 profile 即可。

然后确认条目真的挂上了，且 `!!js` 表达式保持未求值：

```sh
node $dsh --profile web --dump-config
```

尚未配置并不是故障：没有 `projectRoot` 时插件不注册任何工具、只记一条 warning，并把完整的配置步骤写给模型，因此被问到克隆重构的 agent 能告诉你如何把配置补完。本地检出与 tarball 两条安装路线见 [docs/setup.zh.md](docs/setup.zh.md)。

## 配置

两个环境变量，都可选：

| 变量 | 含义 |
|---|---|
| `GME_CLONE_REFACTOR_ROOT` | 本插件允许改动的 GME 工作树绝对路径。未设置时插件完全不注册工具（正是安装测试盯住的启动风险）。 |
| `GME_CLONE_REFACTOR_ARTIFACTS` | run 目录；默认 `$DSH_HOME/gme-clone-refactor/runs`。 |

```powershell
# 在 Harness 启动时读取，不是调用工具时
$env:GME_CLONE_REFACTOR_ROOT      = 'D:/workspace/GME'
$env:GME_CLONE_REFACTOR_ARTIFACTS = 'D:/workspace/gme-clone-runs'   # 可选
node $dsh web
```

其余全部写在 profile 条目里，和其他 bundle 一样：

```yaml
# $DSH_HOME/profiles/web/cordis.patch.yml
- id: gme-clone-refactor
  config:
    projectRoot: D:/workspace/GME
    artifactsRoot: D:/workspace/gme-clone-runs
    detection:
      provider: csv
      csvPath: D:/workspace/clone-reports/func_clone_base.csv
```

补丁条目只替换它写明的键（`config` 整体替换），所以想保留的字段要全部重述。完整的配置键表（含默认值）与一份可用的 GME profile 示例见 [`docs/setup.zh.md`](docs/setup.zh.md)。

## 两条检测路径

`detection.provider: csv` 直读一个已存在的 `func_clone_<module>.csv`，除 Harness 外什么都不需要。`detection.provider: python-pipeline` 驱动现有的 `run_gme_clone_detection.py`，是拿到 3-4 型（embedding）克隆的唯一路径；它需要一个装了 libclang 的 Python 检出，3-4 型还需要一个 embeddings 端点。**两者的簇集合永远不可比，所以每份报告都会记录本次走的是哪条路径。**

3-4 型还要求选中 **commercial** 嵌入通道：设置 `detection.embeddingApiBase`（若你的端点需要 key，再加 `detection.embeddingApiKey`）才是选中它的开关。两者都留空时管线走它自己的 local 通道，此时根本不用 key——为一次从未选中 commercial 的 run 配了 key，只是让它白白躺在命令行上。

**凭据暴露面。** 持久化的 `run.json` 快照里**没有**这个 key：它在唯一的“记录变字节”边界上被替换为 `[redacted]`，所以复制或发布 run 目录不会泄漏它。残留的暴露面是命令行本身——key 以参数形式传给检测脚本，因此一个会回显自身 argv 的管线可能把它写进宿主的 spill 文件，而那个文件在 run 目录之外，也在这个插件的能力之外。把 run 目录或它周边的产物外发之前，请先读 [`docs/setup.zh.md`](docs/setup.zh.md) 里的凭据暴露一节。

## 本插件不做什么

- 不建 git worktree。验证在**你指定的**那棵工作树里跑，因为构建与测试本来就必须在那里跑；`authorization.enabled` 只决定要不要切到 `clone-refactor/<run_id>` 分支。
- 不复刻 Python 管线的函数体骨架比对、行为签名与风险信号正则：这里的分簇只是结构性的，从真实源码判断风险是模型的职责。
- 不回滚它从未授权的文件，也永不执行 `git reset --hard`。
- 不会撤销一个已被撤回授权的 patch，也不会替你做决定：`clone_assess` 只记录模型的判定，`clone_submit` 需要你的 `confirm: true`，而判定被撤回的簇会冻结 run，而不是被悄悄还原。

## 边界与限制

- 扫描与验证会占用工作树：任务运行期间不要在那里切分支或跑你自己的构建。
- 中止工具调用只是停止等待，不会取消命令。停在 `running` 的 job **没有终态记录**：要么任务被中断，要么终态写盘失败。两者都不算成功，报告会写明是哪个 job。
- `submit.mode` 默认 `none`，`authorization.enabled` 默认关闭。
- patch 按簇、且最小化。同一时刻最多 `authorization.maxClusters` 个簇（默认 1）持有**有效**授权——这是“当前授权中的簇数上限”，不是“本次 run 一共 patch 过几次”：撤回一个判定会腾出一个名额。
- 撤回授权不等于撤销补丁。一个簇被改判离开 `patched` 后，它的授权记录被删除，但它改过的文件仍然是改过的，于是 `clone_verify` 会判未授权并以 `UNAUTHORIZED_CHANGES` 冻结 run。出冻结有两条路——你自己还原该文件，或用 `replace: true` 把它重新判回 `patched`——**没有任何东西会自动还原**。
- `projectRoot` 必须是跟踪本次目标文件的**那个** git 仓库。子模块内的目标属于子模块自己的仓库：主工程的 `git status` 与 `diff` 看不到它，所以 `projectRoot` 要指向子模块本身。

## 开发

```sh
pnpm install
pnpm run verify     # 类型检查 + 构建 + vitest + 打包产物冒烟
```

完整行为参考——每一个配置键、工作流、run 工件、回滚与撤回语义、发布清单与故障排查表——见 [docs/setup.zh.md](docs/setup.zh.md)。`src/index.ts` 负责配置与提示词段落，`src/tools.ts` 负责六个工具定义；`src/` 下的各能力模块之间互不调用，只通过 run 目录里的追加写文件交汇。

## 许可证

MIT —— 见 [LICENSE](LICENSE)。
