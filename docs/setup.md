# Setup and configuration

[中文](setup.zh.md) | English

`dsh-gme-clone-refactor` is a clone-detection-and-refactor workflow for DeepSeek Harness. This page is the full configuration and behaviour reference: install, the two environment variables, every config key, the six-tool workflow, where the run artifacts land, the two detection providers, the authorization and rollback rules, the credential exposure the plugin cannot close, the run scope, the first self-use checklist, the release checklist and the troubleshooting table.

## 1. What the plugin is

It turns "these functions look like copies of each other" into a repeatable, checkable workflow instead of an opinion:

1. `clone_scan` enumerates the clone families of one module into `clusters.jsonl`. That cluster list is the run's coverage contract.
2. `clone_assess` records one verdict per cluster — `patched`, `report_only` or `skipped` — and a `patched` verdict is what writes an authorization record.
3. `clone_verify` reconciles that authorization ledger against what git says actually changed, then runs the site's build and test steps as a real command list, keeping every log.
4. `clone_submit` commits, pushes and optionally opens a PR — for authorized files only, only after a passing verification, and only with `confirm: true`.
5. `clone_report` refuses to close the run while a cluster has no verdict, and writes `report.md`, `findings.json` and `summary.json`.

It never guesses. An unverified patch cannot be submitted, and a changed file nobody authorized freezes the run. The plugin never edits source itself: the model patches the work tree with the host's own tools, and the plugin's job is to record who authorized what, verify it, and refuse to go past a boundary.

**It never throws on a bad config.** A row whose config fails validation takes the whole plugin tree down with it (`dsh: 1 entry did not activate`), so every bad value degrades to its documented default with a warning instead. With no `projectRoot` the row is still mounted and simply registers no tools (section 2).

## 2. Install

**Through the DSH CLI:**

```sh
# $dsh is the CLI entry point, <deepseek-harness>/apps/cli/lib/bin.js
node $dsh plugin --profile web add dsh-gme-clone-refactor
```

The command installs the package and appends the **package name** `dsh-gme-clone-refactor` to the profile's `dsh.profile.bundles` — a bundle entry is the bundle's package name. This package ships a `dsh.bundle.patch` layer (`cordis.patch.yml`), so **no profile file has to be edited by hand**. Restart the profile afterwards.

Confirm what the profile will actually mount before restarting:

```sh
node $dsh --profile web --dump-config
```

The composed tree prints the `gme-clone-refactor` row with its `!!js` expressions verbatim, so an unresolved or overridden value is visible without booting. An unconfigured install is a supported state, not a failure: with no `projectRoot` the plugin registers **no** tools, logs exactly one warning, and publishes the full configuration procedure to the model as a system-prompt section.

**From a local checkout** — this repository, verified on Windows with pnpm 12:

```powershell
cd D:\path\to\dsh-gme-clone-refactor
pnpm install
pnpm run verify        # typecheck + build + vitest + the packaged-artefact smoke test
pnpm pack              # writes dsh-gme-clone-refactor-<version>.tgz
```

Then, in `$DSH_HOME\profiles\<profile>\` (for example `C:\Users\<you>\.dsh\profiles\web\`), add the tarball as a `file:` dependency and its package name to `dsh.profile.bundles`, and run `pnpm install` there. `pnpm install` resolves that `file:` spec from the manifest; `pnpm add` does not — on pnpm 12 a local path handed to `pnpm add` (absolute, relative, `file:`, `link:` or a `.tgz`) is parsed as a registry name and fails with `ERR_PNPM_PACKAGE_MANAGER_ADD_RESOLVE_LATEST`. The tarball must stay in the profile directory, because the dependency points at it; re-pack and re-install after changing the plugin.

**Without touching the profile**, a patch row in `$DSH_HOME/profiles/<profile>/cordis.patch.yml` pointing at the built package works too (the package still has to be resolvable by the profile, so install it as above first):

```yaml
- insert:
    - id: gme-clone-refactor
      name: 'dsh-gme-clone-refactor'
      config:
        projectRoot: D:/workspace/GME
```

A patch row replaces only the keys it names, entire `config` included, so restate every field you keep (section 4).

## 3. Environment variables

The shipped `cordis.patch.yml` reads these, so in most deployments they are the whole configuration. They are read when **Harness starts**, not when a tool is called:

```powershell
$env:GME_CLONE_REFACTOR_ROOT      = 'D:/workspace/GME'
$env:GME_CLONE_REFACTOR_ARTIFACTS = 'D:/workspace/gme-clone-runs'   # optional
node $dsh web
```

| Variable | Config key | Meaning |
|---|---|---|
| `GME_CLONE_REFACTOR_ROOT` | `projectRoot` | The GME work tree this plugin may patch; empty means no tool is registered |
| `GME_CLONE_REFACTOR_ARTIFACTS` | `artifactsRoot` | Where runs live; empty means the `$DSH_HOME` default |

The committed row reads them as expressions with a fallback, so an unset variable is an empty string rather than an error:

```yaml
# cordis.patch.yml — the committed row
- insert:
    - id: gme-clone-refactor
      name: 'dsh-gme-clone-refactor'
      config:
        projectRoot: !!js process.env.GME_CLONE_REFACTOR_ROOT ?? ''
        artifactsRoot: !!js process.env.GME_CLONE_REFACTOR_ARTIFACTS ?? ''
```

Everything the environment cannot carry — the detection provider, the authorization knobs, the verification steps — is set as a profile override:

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

## 4. Configuration reference

Every key is optional; an invalid value degrades to its default with a warning (`gme-clone-refactor: ...` in the Harness log) instead of failing the boot. A value that is present but blank counts as unset.

| Key | Default | Meaning |
|---|---|---|
| `projectRoot` | `""` | The GME work tree this plugin may patch. **Empty means no tool is registered at all** (section 2); relative paths are resolved against the process working directory, so give it an absolute path for the same reason you give the run scope one (section 11) |
| `artifactsRoot` | `""` | Where runs live. Empty means `$DSH_HOME/gme-clone-refactor/runs`, i.e. `~/.dsh/gme-clone-refactor/runs`. Every write goes under it, and a `run_id` that tries to escape it is refused |
| `detection.provider` | `"csv"` | Which detector answers: `csv` (read an existing clone report, nothing else needed) or `python-pipeline` (drive the GME detection script) |
| `detection.csvPath` | `""` | The `func_clone_<module>.csv` the `csv` provider reads. A `clone_scan` `csv_path` argument overrides it; with both empty the scan is refused, because guessing a filename next to the process working directory could silently scan the wrong report |
| `detection.pythonPath` | `"python"` | The Python interpreter that runs the detection script. It must be the environment that has libclang |
| `detection.scriptPath` | `""` | `run_gme_clone_detection.py`. Required by `python-pipeline`; unset, that provider refuses with a message naming this key, and `csv` keeps working |
| `detection.libclang` | `""` | libclang library path; passed to the script as `--libclang` only when non-empty |
| `detection.enableType34` | `false` | Turns type 3-4 (embedding) detection on (`--enable-type34`) or off (`--disable-type34`). Off, the run's report still records the provider, but says nothing about type 3-4 |
| `detection.embeddingModel` | `""` | Embedding model name for type 3-4 (`--type34-model`), when the endpoint wants one |
| `detection.embeddingApiBase` | `""` | The **commercial** channel's OpenAI-compatible base URL. Setting this **or** `detection.embeddingApiKey` is what selects the commercial channel (section 7) |
| `detection.embeddingApiKey` | `""` | Credential for that endpoint. Empty means the pipeline is left on its own local channel, where no key is used at all (section 10) |
| `detection.embeddingThreshold` | `0.8` | Similarity threshold for type 3-4 (`--type34-threshold`), 0–1 |
| `authorization.enabled` | `false` | Whether any run may change source. Off, `clone_assess` rejects a `patched` verdict; scanning, judging and reporting still work |
| `authorization.maxPriority` | `"P0"` | The **least severe** priority this deployment allows a patch to target — a ceiling, not a wish list. `P0` permits only P0, `P1` permits P0–P1, `P2` permits P0–P2, `PX` permits everything |
| `authorization.maxClusters` | `1` | How many clusters may hold **live** authorization at the same time. This is not a count of patches over the run's life: the ledger drops a cluster's record when its verdict moves away from `patched`, which frees the slot (range 0–100) |
| `verify.steps` | `[]` | The command list `clone_verify` runs, in order. **Empty is refused**: the engine reports `ok` for zero steps, so an empty list would make every patch look verified. See the field table below |
| `verify.keepFailedPatch` | `false` | When true, a failed verification leaves the patched files in place for inspection instead of rolling them back (section 8) |
| `verify.outputMaxBytes` | `4194304` | Retained bytes per stream for every command the plugin runs. Beyond it the host spills the rest to disk and the log is marked `lossy` (1024–268435456) |
| `verify.graceMs` | `5000` | How long the host waits after a timeout before killing a command outright (0–60000) |
| `submit.mode` | `"none"` | What `clone_submit` may do: `none`, `commit`, `push` or `pr`. The tool's own `mode` argument overrides it for one call |
| `submit.baseBranch` | `""` | The base branch of a PR. Empty means `main`. Ignored unless the mode is `pr` |
| `submit.remote` | `"origin"` | The remote `git push` uses. Ignored unless the mode is `push` or `pr` |
| `submit.commitMessageTemplate` | `""` | Commit message template. Empty means `clone refactor(<run_id>): deduplicate <n> file(s)`. The placeholders are `{run_id}`, `{files_count}` and `{timestamp}`; an unknown placeholder is left visible rather than blanked |
| `workdir.allowDirty` | `false` | Start a run on a work tree that already has changes. It records a hashed baseline and reconciles against the ledger only — and it **disables automatic rollback** (section 8) |
| `reportLanguage` | `"zh"` | Language of `report.md` and of the tool result digest: `zh` or `en` |
| `pageChars` | `12000` | The character budget of one `clone_check` clusters page (256–50000). A cluster carries two function bodies, so the page is bounded by characters, not by a fixed count |

A `verify.steps` entry is normalized field by field; an entry without a non-empty name and command is dropped with a warning, and so is an entry that is not an object:

| Step field | Default | Meaning |
|---|---|---|
| `verify.steps[].name` | — (required) | The step's name in the log filename and in `report.md` |
| `verify.steps[].phase` | `"build"` | One of `setup`, `build`, `test`, `check`, `restore`. Informational, and it decides the `always` default |
| `verify.steps[].command` | — (required) | A whole command line, split into argv on whitespace with quoted segments preserved. It is used literally: **there is no placeholder substitution**, so a step that must act on the files this run changed has to name them, or call a site script that reads the ledger itself |
| `verify.steps[].required` | `true` | Whether this step failing fails the whole attempt |
| `verify.steps[].always` | `true` for `phase: restore`, else `false` | Whether the step still runs after an earlier step failed. `restore` defaults to true because skipping cleanup after a failure is the one thing a pipeline must not do |
| `verify.steps[].timeoutMs` | `1800000` | Per-step timeout in milliseconds (1000–86400000). A step that times out never passes, and its log says so |

### A worked GME profile

The sample below is a complete, self-consistent starting point. The command lines are **site-specific and unverified here**: GME's real build and test invocations must be confirmed on your machine, which is what the checklist in section 12 is for. The angle-bracketed parts are command examples, not to-dos in the plugin.

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
          command: '<the command that points the test harness at this run>'
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
          command: '<the command that restores the test harness settings>'
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

## 5. The workflow

| Step | Tool | Behaviour |
|---|---|---|
| 1 | `clone_scan` | Optional `run_id` (resume an existing run, or create one under that id — `created` in the result says which), `module` (the `python-pipeline` provider needs it), `csv_path` (overrides `detection.csvPath`), `refresh` (scan again although clusters already exist). Returns `accepted`, the `job_id`, the provider and the current cluster count. Runs in the background: poll `clone_check` with `what: status` until the job leaves `running`, then read the clusters |
| 2 | `clone_check` | Read-only, never creates a run. `run_id` plus `what`: `status` (the newest job, or `null`, plus any job records it could not read), `clusters` (one page, with `offset`, `next_offset` and the coverage gaps), `ledger` (the effective verdict per cluster plus the authorization records), `log` (the tail of the newest step log, `log_lines` lines, default 80) |
| 3 | `clone_assess` | One verdict per cluster: `verdict`, `priority`, `reason`; optional `evidence` and `files_changed`, `replace: true` to overwrite an earlier verdict. A `patched` verdict needs `confirm: true`, `authorization.enabled`, at least one `files_changed` entry, `evidence`, and a priority inside `authorization.maxPriority`; a `P0` verdict that is **not** patched still needs evidence of the concrete blocker. Returns `covered` / `total` / `remaining` |
| 4 | `clone_verify` | Reconciles the authorization ledger against git's actual change set, writes `verify/<n>/reconcile.json`, refuses with `UNAUTHORIZED_CHANGES` if anything changed outside the ledger, and otherwise runs the configured steps in the background. Returns `accepted`, the `attempt` number and `authorized_files` |
| 5 | `clone_submit` | `confirm: true` is mandatory and is checked before anything else; a run whose newest verification attempt did not pass cannot be submitted, and an empty ledger gives nothing to submit. `mode` overrides `submit.mode` for this call |
| 6 | `clone_report` | Optional `notes` and `allow_partial`. Writes the three artifacts and returns their paths, the summary and a one-line digest |

The refusals are the point, not obstacles: an unknown `cluster_id` is rejected with the ids this run does have, a `patched` verdict without `confirm: true` is rejected, a verification with an empty step list is rejected before anything destructive could follow, and a `run_id` containing a path separator is refused so a model-supplied id cannot write outside the artifacts root.

## 6. Artifacts

One directory per run, `<artifactsRoot>/<run_id>/`, where `run_id` is `<YYYYMMDD-HHMMSS>-<4 hex>` in UTC unless the caller supplied one:

| File | Content |
|---|---|
| `run.json` | `run_id`, `project_root`, `baseline` (`head`, `branch`, `dirty`), `branch`, `original_branch`, `detection_provider`, `cluster_path`, `created_at`, `updated_at`, and the settings snapshot this run started with. `detection.embeddingApiKey` is stored as `[redacted]`, never in the clear (section 10) |
| `clusters.jsonl` | The scan's clusters, one JSON object per line, each with its representative clone pair and the truncated bodies |
| `assessments.jsonl` | The append-only verdict ledger, one record per verdict. A correction is a new line, and the newest line for a cluster wins |
| `patches.json` | The authorization ledger: one record per currently `patched` cluster (`cluster_id`, `priority`, `files_changed`, `recorded_at`). Retracting a verdict removes its record |
| `detection/` | The provider's own output: the pipeline's `func_clone_<module>.csv` and `detect-command.txt` (the invocation with the key redacted), or nothing for a `csv` scan whose report lives elsewhere |
| `verify/<n>/` | One directory per attempt: `<index>-<step>.log` per step, `result.json` (the attempt's outcome, including `rolled_back` and `rollback_files`) and `reconcile.json` (authorized vs actually changed) |
| `jobs/<job_id>.json` | The job records `clone_check` polls: `status` (`running` / `succeeded` / `failed`), `started_at`, `finished_at`, `error`, `summary` |
| `report.md` | The human report: overview, clusters grouped by priority with their evidence, coverage gaps, authorized changes, verification attempts, unauthorized changes, the last job, dropped ledger lines and your notes |
| `findings.json` | The machine-readable cluster list with each cluster's verdict, priority, reason and authorized files |
| `summary.json` | The counts: `clusters`, `recorded`, `missing`, `patched`, `report_only`, `skipped`, `by_priority`, `authorized_files`, `verify_attempts`, `verify_ok`, `unauthorized_files`, `unverified`, `dropped_lines`, plus the `digest` of the rendered report |

The default root is `$DSH_HOME/gme-clone-refactor/runs` (`~/.dsh/gme-clone-refactor/runs` when `DSH_HOME` is unset). Nothing outside it is ever written, except the patch the model applies to `projectRoot` and the rollback of the files that patch touched.

`dropped_lines` is a torn line the verdict reader skipped (a crash in the middle of an append leaves a half line). Without it a shrunken run would be indistinguishable from a complete one.

## 7. The two detection providers

`csv` reads a `func_clone_<module>.csv` that already exists. It needs nothing but Harness, it is the self-contained path, and it is the default.

`python-pipeline` drives the existing GME script (`detection.scriptPath`) with `detection.pythonPath`. It is the only path to type 3-4 (embedding) clones, and it needs a Python checkout with libclang, plus an embeddings endpoint for type 3-4.

**The two never produce comparable cluster sets, so the run records which one answered** (`detection_provider` in `run.json`, printed in `report.md`), and a report can only be read alongside that line.

Type 3-4 needs `detection.enableType34: true` **and** the commercial embedding channel selected. The channel is selected by `detection.embeddingApiBase` or `detection.embeddingApiKey` being non-empty: the plugin then passes `--embedding-provider commercial`. With both empty the plugin passes neither, and the script stays on its own `local` channel, where no key is used at all. A key configured for a run that never selects commercial is therefore a key carried on a command line for nothing (section 10).

Clustering here is structural: it does not port the Python pipeline's body-skeleton comparison, behaviour signatures or risk-signal regexes. The report labels it `cluster: inline` for exactly that reason, and judging the risk from the real source is the model's job.

## 8. Authorization, verification and rollback

**Three layers of consent.**

| Layer | Mechanism |
|---|---|
| Configuration | `authorization.enabled` (default false), `authorization.maxPriority`, `authorization.maxClusters` |
| Call | `clone_assess` records a `patched` verdict only with `confirm: true`, and only for a cluster inside `maxPriority` |
| Reconciliation | `clone_verify` compares git's actual change set with `patches.json`; anything extra is `UNAUTHORIZED_CHANGES` and freezes the run |

`authorization.maxPriority` is a **ceiling on severity**, not a wish list: `P0` permits only P0, `P1` permits P0–P1, `P2` permits P0–P2 and `PX` permits everything. Design section 8 also says a `PX` cluster should never be refactored at all, so setting `PX` to "allow everything" means "allow the plugin to patch even the clusters this workflow exists to leave alone" — do it only deliberately.

`authorization.maxClusters` counts the authorization records that are live **now**, not the patches made over the run's life. Retracting a verdict frees its slot.

**What a verification pass means.** Every `required: true` step must exit 0; a step that times out never passes, whatever its exit code. Steps that are not `always` are skipped after a failure, `restore` runs regardless, and the attempt's `result.json` records which steps ran, their exit codes, their logs and whether the pipeline was truncated.

**Rollback.** When an attempt fails, `verify.keepFailedPatch` is false, at least one file is authorized, and the run's baseline was clean, the plugin rolls the authorized files back to the baseline — in two parts, because the files are not all the same kind:

- files git tracks are restored with `git restore --source=HEAD --staged --worktree -- <files>`;
- files this run **created** are removed with `git clean -f -- <files>` (no `-x`, so files you had ignored are never touched).

Only `files_changed` from the authorization ledger is ever named, so the blast radius is exactly the set the user approved. If any part of the rollback fails it throws, and the failure is visible in the job record and the report — the report never claims a rollback that did not happen. The plugin never runs `git reset --hard`.

**`workdir.allowDirty: true` disables automatic rollback.** A dirty baseline means you already had uncommitted work when the run started; restoring tracked files would erase your edits, and cleaning untracked ones would delete files that were there before the run. The run records `rolled_back: false` and the report says the work tree was left as it is.

## 9. Retracting a verdict, and how to leave the freeze

Re-assessing a `patched` cluster as `report_only` or `skipped` **retracts its authorization**: the matching record is deleted from `patches.json`. It does **not** revert the patch. The file in the work tree is still changed, so `clone_verify` will (correctly) call it unauthorized and freeze the whole run with `UNAUTHORIZED_CHANGES`.

There are exactly **two** ways out, and the plugin will not take either for you:

1. **Restore the file yourself**: `git restore --source=HEAD -- <file>` in `projectRoot`.
2. **Re-authorize the cluster**: call `clone_assess` again with `verdict: patched`, `replace: true` and `confirm: true`, with the files it changed.

Nothing restores a file automatically. Going back and changing someone's code after they said "not this patch" is precisely the behaviour the consent gate exists to prevent. The model is told this in its prompt, so a user stuck on a freeze can ask why and get this answer.

## 10. Credential exposure

Two halves, and only one of them is closed.

**Closed: the run directory.** The plugin passes the embedding key to the detection script as a **command-line argument** (the script only reads `--embedding-commercial-api-key`, and the command interface carries no environment variables), and it redacts every occurrence of the key from the invocation file, the captured streams and any thrown message. The persisted `run.json` snapshot does not contain the key either: it is replaced with `[redacted]` at the single boundary where a record becomes bytes, and both the create and the save path go through that boundary. **Copying or publishing a run directory therefore does not leak the key**, and no tool returns the record or the settings.

**Residual: the command line around the run.** The key still travels on the child's `argv`, so a pipeline that echoes its own `argv` — a diagnostic dump, a crash report, a verbose script — can write it into the **host's spill file**. The host spills the part of a child's output it truncated to a file outside the run directory; the plugin can neither read nor redact that file. Treat the files around a run directory as potentially sensitive if your endpoint's key was supplied to a `python-pipeline` scan: the plugin's own logs are redacted, the host's spill file is not.

The plugin never supplies a GitHub credential to `clone_submit`: `git` and `gh` use the credentials the host already has, so no token reaches a command line that a run records.

## 11. Run scope: which git repository

`projectRoot` must be **the one git repository that tracks the files this run is about**. That is not a style preference — it is what makes the authorization reconciliation and the rollback correct:

- the baseline, the change set and the rollback are all read from that one repository;
- if a target lives in a submodule (for example `module/laws/**`), the superproject's `git ls-files`, `git status` and `git diff` cannot see it;
- so an authorized edit inside the submodule would look unauthorized to `clone_verify` and freeze the run, and the partitioned rollback would classify a real file as "created by this run" and delete it.

Point `projectRoot` at the submodule itself when the targets are inside it. A single run spanning a superproject and its submodule is out of scope for this release.

## 12. The first self-use checklist

GME's exact build and test commands are not verified by this plugin's own test suite — the plugin runs whatever command lines you configure. Do this once, deliberately, before trusting a run:

1. Put a **single `build` step** in `verify.steps` and run one `clone_verify`. Read `verify/1/1-<name>.log` and confirm the command, the working directory (it must be `projectRoot`) and the captured output are what you expect.
2. Add the `test`, `format` and `restore` steps one at a time, and confirm the exit-code judgement and the `always` semantics on each: a failing required step fails the attempt, a non-`always` step after it is skipped, and the `restore` step still runs.
3. Confirm `format-check` uses **GME's own clang-format version (17.0.2)**. A different version's formatting verdict is not a statement about the codebase.
4. On a read-only run, confirm that `clone_submit` with `submit.mode: none` does nothing at all — with `confirm: true` it returns `mode: none` and takes no outward action.

## 13. Release checklist (prepare only)

Preparing a release is not part of using the plugin. This is the sequence the workspace's own release notes describe, listed here so the steps are not improvised:

```sh
pnpm install
pnpm run verify                    # typecheck + build + vitest + the packaged-artefact smoke test
npm pack --dry-run                 # inspect the file list before publishing anything
git remote add origin git@github.com:nuaaweixinye/dsh-gme-clone-refactor.git
git tag -a v0.1.0 -m "dsh-gme-clone-refactor 0.1.0"
git push -u origin main --follow-tags
gh repo edit --add-topic dsh-plugin
npm publish --registry https://registry.npmjs.org
```

The packaged file list must contain `lib/`, `cordis.patch.yml`, `LICENSE`, both READMEs and `docs/setup.md` + `docs/setup.zh.md`, and must **not** contain `docs/superpowers/` (the internal plan and spec are not published). npm requires 2FA for publishing and a granular token with bypass-2FA cannot do account-level work; `npm publish` needs the account's 2FA set up first. `git push` needs a remote, and this checkout has none configured, so that step cannot happen by accident. Nothing in this list is run by the plugin, and none of it is run by a task that produces it: pushing and publishing are outward actions that need their own explicit decision.

## 14. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `detection.scriptPath is not configured, so the python-pipeline provider cannot run` | `detection.provider: python-pipeline` without the script path | Set `detection.scriptPath` to the pipeline's `run_gme_clone_detection.py`, or switch to `detection.provider: csv` |
| `verify.steps is empty, so nothing can be verified` | No verification steps configured | Add the build/test steps; an empty list would make every patch look verified, so `clone_verify` refuses outright |
| `The work tree ... is not clean (N changed file(s))` | `openRun` found unrelated uncommitted work | Commit or stash it, or set `workdir.allowDirty: true` — knowing that this disables automatic rollback (section 8) |
| A run sits at `running` forever | A job record with **no terminal status**: the command was interrupted, or the write of its terminal status failed (in which case the task itself may have succeeded — the failure is reported through a logger warning) | Neither is a success. Check the log tail with `clone_check` `what: log`; if the work really finished, the task's outcome is in `verify/<n>/result.json` even when the job record is stale. Do not submit on the strength of a `running` record |
| `UNAUTHORIZED_CHANGES: ... changed but is not in the authorization ledger` | A file changed in the work tree that no `patched` verdict authorized — including a file whose cluster's verdict was later retracted | This is a freeze, not a bug. Restore the file (`git restore --source=HEAD -- <file>`), or re-assess that cluster as `patched` with `replace: true` (section 9) |
| Type 3-4 found no clones, or a configured key has no effect | `detection.embeddingApiBase` / `detection.embeddingApiKey` are what select the **commercial** channel; with both empty the pipeline runs its own local channel and the key only sits on the command line | Set `detection.embeddingApiBase` (and the key if the endpoint wants one), keep `detection.enableType34: true`, and check `detect-command.txt` for the `--embedding-provider commercial` argument |
| A cluster you expected to patch is refused: `authorization.maxPriority is P0, so a P1 cluster may not be patched` | `maxPriority` is the **highest severity you allow**, not "the clusters I want refactored": `P0` permits only P0, `P1` permits P0–P1, `PX` permits everything | Raise `maxPriority` to exactly the severity you intend to allow — and remember that `PX` also allows the clusters design section 8 says should never be refactored |
| `authorization.maxClusters is N; this run already patched N cluster(s)` | The cap counts live authorization records, and you have that many | Retract a verdict to free a slot, or raise `maxClusters` deliberately |
| `Not a clone report` / `No CSV to scan` | The CSV's header names no `file1`/`file2` column pair, or no CSV path was configured | Point `detection.csvPath` (or the `csv_path` argument) at a real `func_clone_<module>.csv`; a silently empty cluster list would otherwise look like a clone-free module |
| `dsh: 1 entry did not activate` at boot, naming this entry | A hand-edited row whose config fails validation | Fix or remove the override; the shipped row degrades to its defaults with a warning instead of throwing |
| `run_id '...' escapes the artifacts root` | A run id containing a path separator or a `.` segment | Use a plain name such as `20260920-010203-ab12` |

## 15. Development

```sh
pnpm install
pnpm run verify        # tsc --noEmit + tsdown + vitest run + node tests/pack-smoke.mjs
```

`src/index.ts` owns the config, the defaulting and the prompt section; `src/tools.ts` the six tool definitions and their thin validation; `src/core/` the run directory, the append-only ledgers and the job records; `src/detect/` the two providers and the structural clustering; `src/verify/` the step engine and the attempt records; `src/git/` the baseline reads, the reconciliation and the rollback; `src/report/` the report and the counts. The capability modules never call each other: they meet only through the files in the run directory.

`tests/workflow.spec.ts` drives the six tools through a real Cordis `Tools`/`SystemPrompt` context with a fake command runner, `tests/install.spec.ts` composes the committed `cordis.patch.yml` through the real patch engine and mounts the resulting row in a real Loader tree, `tests/docs.spec.ts` checks the READMEs' tool table against the live tool registry and the setup docs against `resolveSettings`, and `tests/pack-smoke.mjs` checks the packaged artefact itself.
