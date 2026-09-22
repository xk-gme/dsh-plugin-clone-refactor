# dsh-gme-clone-refactor

English | [中文](README.zh.md)

A GME clone-detection-and-refactor workflow inside [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`): scan the clone families of one module, judge each one, apply an authorized minimal patch, verify it with a real build and test, and submit only what passed. It never guesses: an unverified patch cannot be submitted, and a changed file the user never authorized freezes the run.

Community plugin, not an official DeepSeek package.

## Tools

| Tool | What it does |
|---|---|
| `clone_scan` | Enumerate the clone families of one module into the run's coverage contract (background job) |
| `clone_check` | Read-only polling: the newest job, the clusters, the verdict ledger, the tail of the newest verification log |
| `clone_assess` | Record one verdict per cluster — `patched`, `report_only` or `skipped` — with the authorization gate and the evidence rule |
| `clone_verify` | Reconcile the authorization ledger against the real diff, then run the configured build/test steps (background job) |
| `clone_submit` | Commit, push and optionally open a PR — only after a passing verification, and only with `confirm: true` |
| `clone_report` | Close the run: write `report.md`, `findings.json` and `summary.json`, refusing to hide coverage gaps |

Every cluster the scan produces must end with a verdict before the run can close; `clone_report` refuses the rest unless the caller accepts `allow_partial: true`, which puts the gaps in the report instead of dropping them.

## How it works

The data flow of one run:

```
func_clone CSV (already existing, or produced by the python pipeline)
      ↓  function pairs: both sides' file / function / lines / snippet
         + similarity + detection-method mark
 connected components → clone families (one representative pair each)
      ↓  the model reads the real source and judges every family
         (patched / report_only / skipped)
 patched + user confirm → the authorization ledger
         (the only list of files that may be changed)
      ↓  reconcile (real git diff vs the ledger) → run the build / test
         steps you configured
 passed and the ledger unchanged → commit only the ledger's files → report
```

**Detection.** A "clone" is a pair of highly similar functions in one module. The plugin ships no detector of its own: the `csv` route reads a `func_clone_<module>.csv` GME already produced, and the `python-pipeline` route drives the existing `run_gme_clone_detection.py` (libclang-based) to produce the same format. Of the detector's type marks, types 1-2 are textual / parameterized similarity; types 3-4 are semantic and need embeddings.

**Clustering.** Function pairs are merged into **clone families** as connected components — a≈b and b≈c makes {a,b,c} one family — and each family keeps its most similar pair as the representative. Clustering is purely structural: it trusts the detector's similarity output and does no semantic analysis of its own.

**Judgement.** Each family goes to the session's model, which reads the **real source** (not the CSV snippets) to decide whether it is worth merging, at what priority, with evidence. A `patched` verdict additionally needs the user's `confirm: true` and the list of files it changed, and lands in the **authorization ledger** — the one list of "allowed changes" every later step consults, capped by `authorization.maxClusters` and `maxPriority`.

**Verification.** Two stages: first a **reconciliation** of the real `git diff` against the ledger — any change outside it freezes the run with `UNAUTHORIZED_CHANGES`; then the **real build / test commands** you configured in `verify.steps` run, each step logging to disk. On failure the configured **partitioned rollback** restores the ledger's tracked files to the baseline and deletes the files this run created — never `git reset --hard`.

**Submission.** Allowed only when the newest verification passed **and** the ledger, the cluster set and the scan revision are exactly what that attempt verified **and** its verify job succeeded; the commit uses `git commit --only`, so it contains **only the ledger's files**.

**State.** All state lives in append-only files under the run directory (`clusters.jsonl`, the ledgers, `verify/N/`); the six tools never call each other and meet only through those files.

## Install

```sh
# $dsh is the CLI entry point, <deepseek-harness>/apps/cli/lib/bin.js
node $dsh plugin --profile web add dsh-gme-clone-refactor
```

The command installs the package and appends its package name `dsh-gme-clone-refactor` to the profile's `dsh.profile.bundles` — a bundle entry is the bundle's package name. This package ships a `dsh.bundle.patch` layer, so **no profile file needs editing by hand**. Restart the profile afterwards.

Then confirm the row actually mounted, with its `!!js` expressions left unevaluated:

```sh
node $dsh --profile web --dump-config
```

An install that is not configured yet is not a failure: with no `projectRoot` the plugin registers no tools, logs one warning, and publishes the full configuration procedure to the model, so an agent asked for a clone refactor can tell you how to finish the setup. The local-checkout and tarball routes are in [docs/setup.md](docs/setup.md).

## Configure

Two environment variables, both optional:

| Variable | Meaning |
|---|---|
| `GME_CLONE_REFACTOR_ROOT` | Absolute path to the GME work tree this plugin may patch. Unset means the plugin registers no tools at all (that is the boot hazard the install test pins). |
| `GME_CLONE_REFACTOR_ARTIFACTS` | Run directory; defaults to `$DSH_HOME/gme-clone-refactor/runs`. |

```powershell
# read when Harness STARTS, not when a tool is called
$env:GME_CLONE_REFACTOR_ROOT      = 'D:/workspace/GME'
$env:GME_CLONE_REFACTOR_ARTIFACTS = 'D:/workspace/gme-clone-runs'   # optional
node $dsh web
```

Everything else is configured in the profile row, like any other bundle:

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

A patch row replaces only the keys it names, entire `config` included, so restate every field you keep. The complete key table (with defaults) and a worked GME profile example are in [`docs/setup.md`](docs/setup.md).

## Two detection providers

`detection.provider: csv` reads an existing `func_clone_<module>.csv` and needs nothing but Harness. `detection.provider: python-pipeline` drives the existing `run_gme_clone_detection.py` and is the only path to type 3-4 (embedding) clones; it needs a Python checkout with libclang and, for type 3-4, an embeddings endpoint. **The two never produce comparable cluster sets, so every report records which one ran.**

Type 3-4 also needs the **commercial** embedding channel selected: setting `detection.embeddingApiBase` (and `detection.embeddingApiKey` if your endpoint wants one) is what selects it. Leaving both unset keeps the pipeline on its own local channel, where no key is used at all — a key configured for a run that never selects commercial is a key carried on a command line for nothing.

**Credential exposure.** The persisted `run.json` snapshot does **not** contain the key: it is replaced with `[redacted]` at the single boundary where a record becomes bytes, so copying or publishing a run directory does not leak it. The residual exposure is the command line itself — the key travels to the detection script as an argument, so a pipeline that echoes its own argv can write it into the host's spill file, which lives outside the run directory and outside this plugin's reach. Read the credential-exposure note in [`docs/setup.md`](docs/setup.md) before sending a run directory or the files around it anywhere.

## What this plugin does NOT do

- It does not create git work trees. Verification runs in the work tree you point it at, because that is where the build and the tests must run; `authorization.enabled` decides whether it switches to a `clone-refactor/<run_id>` branch.
- It does not port the Python pipeline's body-skeleton comparison, behaviour signatures or risk-signal regexes: clustering here is structural, and judging risk from the real source is the model's job.
- It does not roll back files it never authorized, and it never runs `git reset --hard`.
- It does not revert a patch you retracted, and it does not decide anything for you: `clone_assess` records the model's verdict, `clone_submit` needs your `confirm: true`, and a cluster whose verdict was retracted freezes the run rather than being silently undone.

## Limits

- Scanning and verification occupy the work tree: do not switch branches or run your own build there while a job is running.
- Aborting a tool call stops waiting; it does not cancel the command. A job left at `running` has **no terminal record**: either the run was interrupted, or the record could not be written. Neither is a success, and the report names which job it was.
- `submit.mode` defaults to `none`, and `authorization.enabled` defaults to off.
- Patching is per-cluster and minimal. At most `authorization.maxClusters` clusters (default 1) may hold **live** authorization at a time — that is a cap on currently authorized clusters, not a count of patches over the run's life: retracting a verdict frees its slot.
- Retracting authorization is not reverting the patch. A cluster re-assessed away from `patched` loses its authorization record while the file it changed stays changed, so `clone_verify` freezes the run with `UNAUTHORIZED_CHANGES`. There are two ways out — restore the file yourself, or re-assess the cluster as `patched` with `replace: true` — and nothing is restored automatically.
- `projectRoot` must be the one git repository that tracks the files being refactored. A target inside a submodule belongs to that submodule's repository: the superproject's `git status` and `diff` cannot see it, so point `projectRoot` at the submodule itself.

## Development

```sh
pnpm install
pnpm run verify     # typecheck + build + vitest + the packaged-artefact smoke test
```

The full behaviour reference — every config key, the workflow, the run artifacts, rollback and retraction semantics, the release checklist and the troubleshooting table — is in [docs/setup.md](docs/setup.md). `src/index.ts` owns the config and the prompt section, `src/tools.ts` the six tool definitions, and the capability modules under `src/` never call each other: they meet only through the append-only files in the run directory.

## License

MIT — see [LICENSE](LICENSE).
