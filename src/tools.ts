/** The six tools: argument validation, authorization gates and presentation. */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { join } from 'node:path'
import { PRIORITIES, PRIORITY_RANK, type Settings } from './config.ts'
import { writeAtomic } from './core/artifacts.ts'
import { loadJsonlClusters, loadScanRevision, saveJsonlClusters } from './core/clusters.ts'
import { coverageGaps, loadAssessments, loadPatches, recordAssessment, savePatches } from './core/ledger.ts'
import { detach, latestJob, latestVerifyJob, startJob, type PersistFailure } from './core/jobs.ts'
import { normalizePath } from './core/paths.ts'
import { newRunId } from './core/artifacts.ts'
import { openRun, requireRun, saveRun } from './core/run.ts'
import { requireText, VERDICTS, type Assessment, type PatchRecord } from './core/schema.ts'
import { csvDetector } from './detect/csv.ts'
import { pythonDetector } from './detect/python.ts'
import { changedFiles, checkoutFiles } from './git/baseline.ts'
import { reconcile } from './git/reconcile.ts'
import { writeReport } from './report/report.ts'
import { renderCommitMessage, submit } from './submit.ts'
import { loadReconcileAudits, loadUnauthorized, loadVerifyAttempts, newestAttemptNumber, nextAttemptNumber, readNewestVerifyLog } from './verify/artifacts.ts'
import { submitGate } from './verify/gate.ts'
import { runVerification } from './verify/engine.ts'

const EVIDENCE = { type: 'object', additionalProperties: false, properties: {
  file: { type: 'string', required: true, description: 'A file the cluster actually touches.' },
  line: { type: 'integer', required: true, description: 'The line of the concrete blocker or of the applied change.' },
  snippet: { type: 'string', required: true },
} } as const

function output<S extends object>(schema: S) {
  return { schema, render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }] }
}

/**
 * The one thing a detached job cannot tell the caller is that its terminal
 * status never reached disk: the tool call that started it returned long ago.
 * Logging it is what keeps the run honest — `clone_check` will otherwise keep
 * reporting a job as running, and the operator needs to know the record, not the
 * task, is what stalled.
 */
function reportPersistFailure(ctx: Context, info: PersistFailure): void {
  ctx.logger.warn(
    `gme-clone-refactor: job ${info.job.job_id} (${info.job.kind}) could not be persisted: `
    + `${info.error.message}. ${info.note}; treat the on-disk record as stale and this job as settled.`,
  )
}

/**
 * The plain-JSON projection of a value that is already JSON-serializable.
 *
 * A `clone_check` result and a report summary are contractually lossless JSON —
 * no `Date`, no `undefined`, no toJSON — but their interfaces declare no index
 * signature, so an open output schema (which infers
 * `{declared keys} & Record<string, JsonValue>`) rejects them. Intersecting the
 * value's own type back in keeps each declared key required while the JSON
 * projection supplies the index signature. The round trip is the erasure, done
 * once here rather than at four call sites; a test pins that it preserves every
 * field at runtime.
 */
function asJson<T>(value: T): T & Record<string, JsonValue> {
  return JSON.parse(JSON.stringify(value)) as T & Record<string, JsonValue>
}

/** Reject an unknown cluster with the ids this run does have. */
function knownCluster(ids: readonly string[], requested: string): string {
  if (!ids.includes(requested)) {
    throw new Error(`Unknown cluster_id '${requested}'. ${ids.length === 0 ? 'This run has no clusters yet — call clone_scan first.' : `Known ids: ${ids.slice(0, 20).join(', ')}`}`)
  }
  return requested
}

/**
 * One revision-consistent view of a run: the current cluster set, its revision,
 * the verdicts and the authorizations that still count for it.
 *
 * A verdict (or authorization) recorded under an older revision is invisible to
 * the coverage contract and to `clone_verify`: cluster ids are positional, so
 * after a refresh `C001` can name a different family, and an old verdict would
 * otherwise close the run while attributing its text to the wrong cluster.
 */
async function currentLedger(paths: import('./core/artifacts.ts').RunPaths) {
  const revision = await loadScanRevision(paths)
  const clusters = await loadJsonlClusters(paths)
  const { latest, history, droppedLines } = await loadAssessments(paths, revision)
  const patches = await loadPatches(paths, revision)
  return { clusters, revision, latest, history, droppedLines, patches }
}

/**
 * The files the user authorized, in one spelling. Both `clone_verify` (what may
 * be reconciled) and `clone_submit` (what may be committed) must derive this the
 * same way, or a file the user authorized would look unauthorized to one of them.
 */
function authorizedFiles(patches: readonly PatchRecord[]): string[] {
  return [...new Set(patches.flatMap(patch => patch.files_changed.map(normalizePath)))].sort()
}

export function registerTools(ctx: Context, settings: Settings, runner: import('./core/command.ts').CommandRunner, artifactsRoot: string): void {
  ctx.tools.register(defineTool({
    name: 'clone_scan',
    description: 'Scan one module for clone families and record them as this run\'s coverage contract. Runs in the background: the result is accepted, so poll clone_check until the job settles. Every cluster this produces must end with a verdict before clone_report will close the run.',
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
      // A scan is a new REVISION of this run's coverage contract. Cluster ids are
      // positional, so the ids alone cannot say whether a verdict still speaks
      // about the same family: every scan gets a fresh revision, and a verdict or
      // authorization from an older one stops counting (`seenAtRevision`). A scan
      // that detects nothing still counts as a revision, which is what makes a
      // previous verdict stop covering a now-empty cluster set.
      const scanRevision = newRunId()
      // Detached on purpose: detection is minutes long, and the tool call must
      // return so the model can poll. The job record is the durable progress.
      const job = await startJob(paths, runId, 'scan')
      detach(paths, job, async () => {
        const detected = await detector.detect({ settings, runner, paths, module: args.module ?? '', csvPath: args.csv_path ?? '', signal: undefined })
        await saveJsonlClusters(paths, detected.clusters, scanRevision)
        await saveRun(paths, { ...opened.record, detection_provider: detected.provider === 'python-pipeline' ? 'python-pipeline' : 'csv' })
        return detected
      }, detected => `${detected.clusters.length} cluster(s) via ${detected.provider}`, info => { reportPersistFailure(ctx, info) })
      return {
        run_id: runId, job_id: job.job_id, accepted: true, created: opened.created,
        // The count at ACCEPT time, not the post-scan count: detection is the
        // detached job `job_id` names, so the new cluster count does not exist yet
        // when this returns. It is reported once the clusters are on disk — the job
        // record's summary (`clone_check` with what: status) and `clone_check` with
        // what: clusters. A refresh therefore reports the count it is replacing.
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
      const { paths } = await requireRun(artifactsRoot, runId)
      if (args.what === 'status') {
        // `null`, never `undefined`: an absent key would vanish from the JSON the
        // model reads, and a poller could not tell "no job yet" from a lost field.
        // A corrupt `<id>.json` is skipped rather than failing the poll, and its name
        // is reported here: a silent skip would present an older job as the newest.
        const unreadableJobs: string[] = []
        const job = await latestJob(paths, (name, error) => {
          unreadableJobs.push(name)
          ctx.logger.warn(`gme-clone-refactor: ignoring unreadable job record ${name}: ${error.message}`)
        })
        // The verify records come from the same poll and follow the same rule: a
        // damaged `verify/<n>/result.json` must be skip-and-name, not an exception
        // that takes down the only progress interface this plugin has.
        const unreadableAttempts: string[] = []
        await loadVerifyAttempts(paths, (name, error) => {
          unreadableAttempts.push(name)
          ctx.logger.warn(`gme-clone-refactor: ignoring unreadable verification record ${name}: ${error.message}`)
        })
        return asJson({
          run_id: runId, what: 'status', job: job ?? null,
          unreadable_jobs: unreadableJobs, unreadable_attempts: unreadableAttempts,
        })
      }
      if (args.what === 'ledger') {
        const { latest, droppedLines, patches } = await currentLedger(paths)
        return asJson({ run_id: runId, what: 'ledger', assessments: [...latest.values()], patches, dropped_lines: droppedLines })
      }
      if (args.what === 'log') {
        const tail = await readNewestVerifyLog(paths, Math.max(1, args.log_lines ?? 80))
        return asJson({ run_id: runId, what: 'log', log: tail ?? null })
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
      const { latest } = await currentLedger(paths)
      return asJson({
        run_id: runId, what: 'clusters', total: clusters.length, offset,
        next_offset: offset + page.length < clusters.length ? offset + page.length : null,
        gaps: coverageGaps(clusters.map(cluster => cluster.id), latest),
        clusters: page,
      })
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
      replace: { type: 'boolean', description: 'Overwrite a verdict this cluster already has under the CURRENT scan revision. A verdict from before a refresh no longer covers the new cluster set, so re-recording it after a refresh needs no replace.' },
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
      const { paths, record } = await requireRun(artifactsRoot, runId)
      const { clusters, patches: existingPatches, revision } = await currentLedger(paths)
      knownCluster(clusters.map(cluster => cluster.id), clusterId)
      const reason = requireText(args.reason, 'reason')
      const files = (args.files_changed ?? []).map(normalizePath).filter(Boolean)
      if (args.verdict === 'patched') {
        if (args.confirm !== true) throw new Error('Recording a patched verdict needs confirm: true — source changes are the user\'s decision, not the model\'s.')
        // 授权读的是 run 自己的配置快照，不是实时 settings（R28）。"这个 run 能不能改源码、
        // 最高到哪个优先级、最多几个簇"是用户在**建 run 时**做出的同意决定；允许它在 run
        // 存活期间被一次 profile 编辑翻转，正是快照存在的意义。而 verify.steps 与
        // reportLanguage 属于操作者工具链，继续读实时 settings —— 修好一个坏掉的构建命令
        // 不该逼人放弃整个 run。
        const authorization = record.settings.authorization
        if (!authorization.enabled) throw new Error('Patching is disabled: set authorization.enabled: true in the profile row before any run may change source.')
        // `maxPriority` 是**严重度上限**：本部署允许被 patch 的**最不严重**的那一档。
        // P0 的 rank 是 0，所以"到 P1 为止"意味着 rank ≤ 1。原来的 `<` 写反了 —— 在随包
        // 默认值 `maxPriority: 'P0'` 下它什么都不拒绝（连 §8 明说不得重构的 PX 都放行），
        // 而一旦生效，它禁止的反而是**更严重**的那些簇。R48。
        if (PRIORITY_RANK[args.priority] > PRIORITY_RANK[authorization.maxPriority]) {
          throw new Error(`authorization.maxPriority is ${authorization.maxPriority}, so a ${args.priority} cluster may not be patched in this deployment.`)
        }
        if (files.length === 0) throw new Error('A patched verdict needs files_changed: the authorization ledger is what clone_verify reconciles against.')
        if (args.evidence === undefined) throw new Error('A patched verdict needs evidence: the file, line and snippet of the change.')
        if (!existingPatches.some(patch => patch.cluster_id === clusterId) && existingPatches.length >= authorization.maxClusters) {
          throw new Error(`authorization.maxClusters is ${authorization.maxClusters}; this run already patched ${existingPatches.length} cluster(s).`)
        }
      } else if (args.priority === 'P0' && args.evidence === undefined) {
        throw new Error('A P0 verdict that is not patched needs evidence of the concrete blocker (file, line, snippet). "Semantics unclear" is not evidence.')
      }
      const assessment: Assessment = {
        cluster_id: clusterId, verdict: args.verdict, priority: args.priority, reason,
        files_changed: files, recorded_at: new Date().toISOString(),
        // The evidence is the justification the caller supplied — and it reached NO
        // durable artefact before this, even though a patched verdict and a P0
        // report_only verdict cannot be recorded without it. Absent for a verdict
        // that needs none: an invented empty record would be worse than none.
        ...(args.evidence === undefined ? {} : { evidence: args.evidence }),
        // The revision this verdict speaks about. A later refresh changes the
        // revision, which is what makes this verdict stop covering the new set.
        ...(revision === undefined ? {} : { scan_revision: revision }),
      }
      const { replaced } = await recordAssessment(paths, assessment, { replace: args.replace === true })
      if (args.verdict === 'patched') {
        // Upsert, not insert-if-absent. A `replace: true` correction of
        // `files_changed` must reach the ledger: `clone_verify` authorizes from
        // `patches` alone, so a stale record would freeze a corrected run with
        // UNAUTHORIZED_CHANGES that no further `clone_assess` could clear, and a
        // too-wide one would let `clone_submit` commit files nobody authorized.
        // The record keeps its position in the ledger so the ordering stays stable.
        // An authorization from an older revision is dropped: it points at a
        // family this scan revision no longer contains.
        const patches = await loadPatches(paths)
        const updated: PatchRecord = {
          cluster_id: clusterId, priority: args.priority,
          files_changed: files, recorded_at: assessment.recorded_at,
          // The authorization carries the same evidence as the verdict behind it, so
          // `patches.json` alone is enough to audit why a file was allowed to change.
          ...(args.evidence === undefined ? {} : { evidence: args.evidence }),
          ...(revision === undefined ? {} : { scan_revision: revision }),
        }
        const existing = patches.findIndex(patch => patch.cluster_id === clusterId)
        await savePatches(paths, existing === -1
          ? [...patches, updated]
          : patches.map((patch, index) => (index === existing ? updated : patch)))
      } else {
        // Retract the authorization when a cluster is re-assessed away from
        // `patched` (R49). Leaving the record would be a stale authorization: the
        // latest verdict says this cluster must not be patched, while
        // `clone_verify` still authorizes its files, `clone_submit` stages and
        // commits them, and the report lists them under authorized changes. The
        // tooling is the half that acts, so it must follow the verdict. Dropping
        // the record is what makes acting on the stale consent impossible.
        const patches = await loadPatches(paths)
        const retained = patches.filter(patch => patch.cluster_id !== clusterId)
        if (retained.length !== patches.length) await savePatches(paths, retained)
      }
      const { latest } = await currentLedger(paths)
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
      const { paths, record } = await requireRun(artifactsRoot, runId)
      // An empty step list must never become a vacuous "verified": the engine reports
      // ok for zero steps (nothing required failed), and clone_submit reads that as a
      // passing verification. Refuse loudly here, before anything destructive can
      // follow — the rollback branch below would otherwise delete the patch over a
      // configuration problem rather than a failing test.
      if (settings.verify.steps.length === 0) {
        throw new Error('verify.steps is empty, so nothing can be verified: configure this site\'s build/test steps before running clone_verify. An unverified patch must not be submitted.')
      }
      const { patches, revision } = await currentLedger(paths)
      const authorized = authorizedFiles(patches)
      // The moment the authorization set THIS attempt verifies was read. A patch
      // recorded after it was not part of that set, whatever the file lists say later,
      // and `clone_submit` refuses on exactly this timestamp — recording the fact is
      // what makes "authorized after the verification" detectable at all.
      const reconciledAt = new Date().toISOString()
      // One guarded read, in `git/baseline.ts`, for exactly this reconcile. The
      // authorization gate is only as good as the change set it reads: an
      // unreadable status or diff leaves `stdout` empty or partial, `reconcile`
      // then reports `unauthorized: []`, and the freeze below can never fire. The
      // guard refuses such a read instead of reconciling against it.
      const changed = await changedFiles(runner, record.project_root, record.baseline.head)
      const audit = reconcile(authorized, changed)
      // One past the highest attempt DIRECTORY, never the count of result.json files:
      // an attempt killed before its result write would otherwise have its number
      // reused, overwriting its step logs and reconcile.json.
      const attempt = await nextAttemptNumber(paths)
      await writeAtomic(join(paths.verifyDir, String(attempt), 'reconcile.json'), `${JSON.stringify({
        authorized, changed, ...audit,
        cluster_ids: patches.map(patch => patch.cluster_id),
        ...(revision === undefined ? {} : { scan_revision: revision }),
        recorded_at: reconciledAt,
      }, null, 2)}\n`)
      if (audit.unauthorized.length > 0) {
        // Which of these the run's OWN ledger authorized — under an earlier scan
        // revision. The freeze is right either way (the current revision authorizes
        // nothing here), but the remedy is not: telling an operator to revert a file
        // the user authorized is telling them to undo consented work, and it hides the
        // one call that resolves it. `patches` above is filtered to the current
        // revision by design, so this second read is the whole ledger.
        const everAuthorized = new Set((await loadPatches(paths)).flatMap(patch => patch.files_changed.map(normalizePath)))
        const stale = audit.unauthorized.filter(file => everAuthorized.has(file))
        const fresh = audit.unauthorized.filter(file => !everAuthorized.has(file))
        const staleNote = stale.length === 0 ? '' : ` ${stale.join(', ')} ${stale.length === 1 ? 'is' : 'are'} still authorized under an EARLIER scan revision,`
          + ' which no longer counts after a refresh: re-assess the cluster with clone_assess to record it under the current revision, instead of reverting a file the run\'s own ledger authorized.'
        const freshNote = fresh.length === 0 ? '' : ` Revert ${fresh.join(', ')} or record a patched verdict that lists ${fresh.length === 1 ? 'it' : 'them'}.`
        throw new Error(`UNAUTHORIZED_CHANGES: ${audit.unauthorized.join(', ')} changed but is not in the authorization ledger. This run is frozen: resolve each file before verifying or submitting.${staleNote}${freshNote}`)
      }
      const job = await startJob(paths, runId, 'verify')
      detach(paths, job, async () => {
        const result = await runVerification({ runner, paths, steps: settings.verify.steps, cwd: record.project_root, attempt, signal: undefined })
        const resultPath = join(paths.verifyDir, String(attempt), 'result.json')
        // Persist the outcome BEFORE the rollback. `checkoutFiles` throws when git
        // refuses, and a throw here rejects the detached task, so writing last would
        // leave the attempt with step logs but no result.json: the report would say
        // no verification ran, and the next attempt would reuse this number and
        // overwrite those logs. The evidence that verification ran is not the
        // rollback's to erase.
        await writeAtomic(resultPath, `${JSON.stringify(result, null, 2)}\n`)
        // 自动回滚只在干净基线上才安全。`workdir.allowDirty` 意味着操作者手上本来就有
        // 未提交的工作：对被跟踪文件执行 `git restore --source=HEAD` 会抹掉他开跑前的
        // 改动，对未跟踪文件执行 `git clean` 会删掉他开跑前就存在的文件。此时只记录
        // 失败、把工作区原样留给他处理（`rolled_back: false` 会出现在报告里）。
        if (!result.ok && !record.settings.verify.keepFailedPatch && authorized.length > 0 && record.baseline.dirty.length === 0) {
          let rollbackError: unknown
          try {
            await checkoutFiles(runner, record.project_root, authorized)
            result.rolled_back = true
            result.rollback_files = authorized
          } catch (error) {
            // The failure is recorded HERE as well as in the job error: the job error
            // can be superseded by a later job, and the report would otherwise fall
            // through to "no rollback files were recorded" — telling the operator
            // nothing needed rolling back while the failed patch is still in the tree.
            rollbackError = error
            result.rollback_error = error instanceof Error ? error.message : String(error)
          }
          // Written in both directions: the outcome of the rollback is what the
          // report reads, whichever way it went.
          await writeAtomic(resultPath, `${JSON.stringify(result, null, 2)}\n`)
          if (rollbackError !== undefined) throw rollbackError
        }
        return result
      }, result => `attempt ${result.attempt}: ${result.ok ? 'PASS' : 'FAIL'}`, info => { reportPersistFailure(ctx, info) })
      return { run_id: runId, job_id: job.job_id, accepted: true, attempt, authorized_files: authorized }
    },
    presentCall: args => ({ card: 'generic', title: 'Clone refactor', kind: 'other', rawInput: `verify ${args.run_id ?? ''}` }),
  }))

  ctx.tools.register(defineTool({
    name: 'clone_submit',
    description: 'Commit, push and optionally open a pull request for the authorized files — only after a passing clone_verify, and only for the ledger and tree that verification reconciled: a patch authorized after it (a widened files_changed, a new cluster, a retracted one, a rescan) is refused and needs a fresh clone_verify. Requires confirm: true; without it the call fails and nothing outward happens.',
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
      const { paths, record } = await requireRun(artifactsRoot, runId)
      const { patches, revision } = await currentLedger(paths)
      const files = authorizedFiles(patches)
      // An empty ledger is nothing to submit whatever the verify ledger says, so this
      // check comes FIRST: a retracted authorization (R49) is then refused for the
      // reason that is actually true, instead of being told no verification passed.
      if (files.length === 0) throw new Error('The authorization ledger is empty: there is nothing to submit.')
      // Every verify record is read through the visible-skip hook, so a damaged file
      // refuses submission with a readable reason rather than a JSON parse error.
      const unreadable: string[] = []
      const noteUnreadable = (name: string, error: Error): void => {
        unreadable.push(name)
        ctx.logger.warn(`gme-clone-refactor: ignoring unreadable verification record ${name}: ${error.message}`)
      }
      const attempts = await loadVerifyAttempts(paths, noteUnreadable)
      const newestAttempt = await newestAttemptNumber(paths)
      const audits = await loadReconcileAudits(paths, noteUnreadable)
      // The precondition is not "some attempt passed": it is that the attempt passed,
      // its JOB settled successfully, and the ledger and tree it reconciled are still
      // the ledger and tree this commit would take (see `src/verify/gate.ts`).
      const gate = submitGate({
        attempts,
        newestAttempt,
        verifyJob: await latestVerifyJob(paths, noteUnreadable),
        audit: newestAttempt === undefined ? undefined : audits.get(newestAttempt),
        patches, revision, files, unreadable,
      })
      if (!gate.allowed) throw new Error(gate.reason)
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
      const { paths, record } = await requireRun(artifactsRoot, runId)
      // One revision-consistent view of the run: the clusters, the verdicts and the
      // authorizations must all belong to the same scan revision, or the closing
      // report pairs a new cluster with an old cluster's verdict text.
      const { clusters, latest, droppedLines, patches } = await currentLedger(paths)
      // Every durable record is read through the visible-skip hook: a corrupt file is
      // reported by name rather than dropped. Without it a corrupt NEWEST job record
      // made this report present an older job as the run's last one.
      const unreadableRecords: string[] = []
      const noteUnreadable = (name: string, error: Error): void => {
        unreadableRecords.push(name)
        ctx.logger.warn(`gme-clone-refactor: ignoring unreadable record ${name}: ${error.message}`)
      }
      const verify = await loadVerifyAttempts(paths, noteUnreadable)
      const job = await latestJob(paths, noteUnreadable)
      // The newest VERIFY job record, not `job`: the two are written on the same
      // separate path but of different kinds, and a scan that settled after the
      // verification says nothing about whether the verification did.
      const verifyJob = await latestVerifyJob(paths, noteUnreadable)
      // The freeze claim is the newest attempt's, the same one the submit gate reads —
      // not the union of every attempt, which made a finished run read as frozen.
      // `newestAttempt` and `reconciledAttempt` are what let the report say "there is
      // no newest reconcile" instead of printing an unbacked "not frozen", and
      // `newestAudit` is that same record, which the summary's `verify_ok` is
      // computed from: the gate's verdict, not a second opinion about it.
      const unauthorized = await loadUnauthorized(paths, noteUnreadable)
      const written = await writeReport(paths, {
        run: record, clusters, assessments: latest, patches, verify,
        newestAttempt: unauthorized.newestAttempt, verifyJob, audit: unauthorized.newestAudit,
        job, droppedLines,
        unauthorized: unauthorized.files,
        resolvedUnauthorized: unauthorized.resolved,
        missingReconcileAttempt: unauthorized.newestAttempt !== undefined && unauthorized.newestAttempt !== unauthorized.reconciledAttempt
          ? unauthorized.newestAttempt
          : undefined,
        unreadableRecords,
        notes: args.notes ?? '', allowPartial: args.allow_partial === true, language: settings.reportLanguage,
      })
      return asJson({ run_id: runId, report_path: written.report_path, findings_path: written.findings_path, summary_path: written.summary_path, summary: written.summary, digest: written.digest })
    },
    presentCall: args => ({ card: 'generic', title: 'Clone refactor', kind: 'other', rawInput: `report ${args.run_id ?? ''}` }),
  }))
}
