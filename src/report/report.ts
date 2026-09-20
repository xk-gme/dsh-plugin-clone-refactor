/**
 * The closing report. Its job is to make the run auditable: which detection path
 * produced the clusters, what the baseline was, what each cluster was judged to
 * be, which files the user authorized, what the build actually said, and which
 * clusters nobody looked at yet. A report that hides a gap is worse than no report.
 */
import { createHash } from 'node:crypto'
import { writeAtomic, type RunPaths } from '../core/artifacts.ts'
import { PRIORITIES } from '../config.ts'
import type { Assessment, Cluster, PatchRecord, VerifyResult } from '../core/schema.ts'
import type { RunRecord } from '../core/run.ts'
import type { JobRecord } from '../core/jobs.ts'
import { coverageGaps } from '../core/ledger.ts'
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
  return `| \`${cluster.id}\` | ${priority} | ${verdict} | ${cluster.size} | \`${pair.left.file}\` ↔ \`${pair.right.file}\` | ${reason} |`
}

/** Render the human report. Pure: the same input always yields the same text. */
export function renderReport(input: ReportInput): string {
  const summary = summarizeReport(input)
  const gaps = coverageGaps(input.clusters.map(cluster => cluster.id), input.assessments)
  const gapIds = new Set(gaps)
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
  // 按优先级分组（spec §11："按优先级分组的簇"）。一张平铺表会把 P0 埋在 P2 中间，而报告
  // 的第一用途就是让人先看到最该看的那些。未判定的簇单独成组，免得与"已评估为 PX"混同。
  lines.push('## 簇与判定 / Clusters', '')
  const groups: Array<{ title: string; clusters: Cluster[] }> = [
    ...PRIORITIES.map(priority => ({
      title: priority,
      clusters: input.clusters.filter(cluster => input.assessments.get(cluster.id)?.priority === priority),
    })),
    {
      title: '未判定 / no verdict',
      clusters: input.clusters.filter(cluster => gapIds.has(cluster.id)),
    },
  ]
  for (const group of groups) {
    if (group.clusters.length === 0) continue
    lines.push(`### ${group.title}（${group.clusters.length}）`, '',
      '| 簇 | 优先级 | 判定 | 对数 | 代表对 | 理由 |', '|---|---|---|---|---|---|',
      ...group.clusters.map(cluster => clusterLine(cluster, input.assessments.get(cluster.id))), '')
  }
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
      // The engine returns only the steps it executed, and StepResult has no `skipped`
      // field, so a reader could not otherwise tell "not configured" from "skipped after
      // an earlier failure". The run's own settings snapshot carries the configured
      // list, so the difference is derivable and must be shown — a report that silently
      // omits a step nobody ran is the same lie as a hidden coverage gap. The defensive
      // read also survives an older `run.json` whose settings shape predates this field.
      const ran = new Set(attempt.steps.map(step => step.name))
      const configured = (input.run.settings?.verify?.steps ?? []).map(step => step.name)
      const notRun = configured.filter(name => !ran.has(name))
      if (notRun.length > 0) {
        lines.push('', `未执行 / not run: ${notRun.map(name => `\`${name}\``).join(', ')} —— 前序必需步骤失败后按规则跳过（本次共配置 ${configured.length} 步，实际执行 ${attempt.steps.length} 步）`)
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
  const gaps = coverageGaps(input.clusters.map(cluster => cluster.id), input.assessments)
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
