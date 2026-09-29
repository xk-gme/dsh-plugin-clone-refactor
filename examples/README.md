# examples / 示例

Site-specific configuration examples for this plugin: the python-pipeline
detection config and a scoped build-verification script. **The paths in these
files are examples** — copy them, then replace every path with your machine's
real ones. Real site configuration never belongs in the package; these exist so
a new machine can be made reproducible instead of reconstructed from memory.

本目录是**站点配置示例**：`python-pipeline` 检测源的配置 JSON 与一个作用域化的构建验证脚本。文件里的路径都是示例值——复制出去后把每处路径换成你机器上的真实路径。真实配置不要进包，放本机即可；这里收的是“方法”，让新机器可复现，而不是靠回忆拼出来。

## 1. libclang 检测环境（python-pipeline 检测源的前置）

```sh
python -m venv venv-clone-detection
venv-clone-detection\Scripts\python -m pip install libclang pandas numpy scikit-learn
```

`pip install libclang` 的 wheel **自带 libclang.dll**（约 80 MB），不需要单独安装 LLVM。

然后把 [`detection-config.example.json`](detection-config.example.json) 复制为本机的 `detection-config.local.json`，改三处：

- `gme_root` — 目标 GME 工作树；
- `libclang.file` — 指向 **venv 里**的 `libclang.dll`（`...\site-packages\clang\native\libclang.dll`）；
- `output_root` / `include_dirs` — 你的输出目录与 GME 的 include 根。

`clone_detection.enabled` 保持 `false` 即可跑 1-2 型检测（不需要 embedding）；要跑 3-4 型（语义级、需要 embedding 端点）再把它改为 `true` 并填 `api_url` / `model_name` / `api_key`。**注意**：这台脚本不认识命令行的 `--libclang` 参数，DLL 路径只能走这份配置 JSON——因此插件配置里的 `detection.libclang` 必须留空。

最后在插件行里指向脚本与本机配置：

```yaml
detection:
  provider: python-pipeline
  pythonPath: D:/workspace/gme-tools/venv-clone-detection/Scripts/python.exe
  scriptPath: D:/workspace/GME-Skills/.dsh/skills/cpp-clone-detection/scripts/run_gme_clone_detection.py
```

## 2. 作用域化的构建验证（verify.steps）

[`verify-single-tu.cmd.example`](verify-single-tu.cmd.example) 是一个**单翻译单元**编译脚本：用 MSVC 编译被补丁改动的那一个 `.cpp`，退出码即验证结论。它比全量构建快几个数量级，适合作为“补丁能否通过编译”的快速闸门；全量构建/测试请按站点自行追加步骤。

复制为 `verify-base.cmd`（去掉 `.example`），按机器改三处：vcvars64 路径、目标文件、include 目录。然后在插件行里：

```yaml
verify:
  steps:
    - name: compile
      phase: build
      command: D:/workspace/gme-tools/verify-base.cmd
      required: true
```

两个已知的诚实边界：这只验证**改动文件的编译**，不是全量构建；脚本注释里也写明 `verify.steps` 的命令由宿主以无环境变量的方式执行，所以 vcvars 必须在脚本内部完成。
