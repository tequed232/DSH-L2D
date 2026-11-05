#!/usr/bin/env node
/**
 * dsh-l2d · 标签审核报告生成器（P2：独立验收——可读审核报告）
 *
 * 纪律（独立验收任务书 P2）：
 *  - 只读：本脚本绝不修改任何标签状态（不自动批准、不自动拒绝）；
 *  - 按素材、标签字段、证据来源分组；
 *  - 标记低置信度（confidence < LOW_CONF）与争议项（同类素材同字段同值但证据等级不一）；
 *  - 已裁决（approved/rejected）标签列出但不允许在此流程中变更；
 *  - 需要人工决策的项目单独列出，供 review.mjs decide 逐条处置。
 *
 * 用法：
 *   node tools/gallery-schema/audit-report.mjs                 # 输出到 docs/REVIEW-AUDIT-REPORT.md
 *   node tools/gallery-schema/audit-report.mjs --out <path>    # 自定义输出
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../../packages/dsh-l2d-db/src/db.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LOW_CONF = 0.7; // 低于此置信度视为低置信度，需重点人工复核

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') args.out = argv[++i];
    if (argv[i] === '--low-conf') args.lowConf = Number(argv[++i]);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const lowConf = args.lowConf ?? LOW_CONF;
  const db = openDb({ startDir: REPO_ROOT });

  const rows = db.prepare(`
    SELECT gl.id, gl.field, gl.value, gl.confidence, gl.evidence_level, gl.evidence, gl.review_state, gl.linked_node_id,
           gi.file_name, gi.source_class
    FROM gallery_labels gl JOIN gallery_items gi ON gl.item_id = gi.id
    ORDER BY gi.source_class, gi.file_name, gl.field, gl.id
  `).all();

  const now = new Date().toISOString();
  const lines = [];
  lines.push('# DSH-L2D 标签审核报告（独立验收 P2）');
  lines.push('');
  lines.push(`- 生成时间：${now}`);
  lines.push(`- 生成者：audit-report.mjs（只读，未修改任何标签状态）`);
  lines.push(`- 低置信度阈值：confidence < ${lowConf}`);
  lines.push(`- 标签总量：${rows.length}`);
  lines.push('');

  // ---- 总览 ----
  const byState = {};
  const byEvidence = {};
  const byField = {};
  for (const r of rows) {
    byState[r.review_state] = (byState[r.review_state] ?? 0) + 1;
    byEvidence[r.evidence_level] = (byEvidence[r.evidence_level] ?? 0) + 1;
    byField[r.field] = (byField[r.field] ?? 0) + 1;
  }
  lines.push('## 总览');
  lines.push('');
  lines.push('| 维度 | 分布 |');
  lines.push('| --- | --- |');
  lines.push(`| 审核状态 | ${Object.entries(byState).map(([k, v]) => `${k}=${v}`).join('，')} |`);
  lines.push(`| 证据来源 | ${Object.entries(byEvidence).map(([k, v]) => `${k}=${v}`).join('，')} |`);
  lines.push(`| 标签字段 | ${Object.entries(byField).map(([k, v]) => `${k}=${v}`).join('，')} |`);
  lines.push('');

  const lowConfRows = rows.filter((r) => r.review_state === 'needs_review' && (r.confidence ?? 0) < lowConf);
  const disputed = findDisputed(rows);
  const needDecision = rows.filter((r) => r.review_state === 'needs_review');

  // ---- 重点：低置信度 ----
  lines.push('## ⚠️ 低置信度标签（重点人工复核）');
  lines.push('');
  if (lowConfRows.length === 0) lines.push('（无）');
  else {
    lines.push('| # | 素材 | 字段 | 值 | 置信度 | 证据来源 |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const r of lowConfRows) {
      lines.push(`| #${r.id} | ${r.file_name} | ${r.field} | ${r.value} | ${r.confidence ?? '-'} | ${r.evidence_level} |`);
    }
  }
  lines.push('');

  // ---- 重点：争议项（同字段同值在不同素材上置信度差异 > 0.25 或证据等级不一致） ----
  lines.push('## ⚠️ 争议项（同语义跨素材证据不一致）');
  lines.push('');
  if (disputed.length === 0) lines.push('（无）');
  else {
    for (const d of disputed) {
      lines.push(`- **${d.field}=${d.value}**：${d.detail}`);
    }
  }
  lines.push('');

  // ---- 需人工决策清单 ----
  lines.push('## 🖐️ 需人工决策清单（逐条 review.mjs decide）');
  lines.push('');
  lines.push('以下每一条都必须由人显式执行 `node tools/gallery-schema/review.mjs decide <id> approved|rejected [--note "..."]`。');
  lines.push('本报告与任何自动化流程均不会代为决策。');
  lines.push('');
  let curItem = null;
  for (const r of needDecision) {
    if (r.file_name !== curItem) {
      curItem = r.file_name;
      lines.push(`### ${r.file_name}（${r.source_class}）`);
      lines.push('');
    }
    const flags = [];
    if ((r.confidence ?? 0) < lowConf) flags.push('低置信度');
    if (r.linked_node_id) flags.push(`已关联节点 ${r.linked_node_id}`);
    lines.push(`- #${r.id} [${r.field}] ${r.value} — conf=${r.confidence ?? '-'}，${r.evidence_level}${flags.length ? `（${flags.join('，')}）` : ''}`);
  }
  lines.push('');

  // ---- 已裁决（不可覆写，仅列出） ----
  const decided = rows.filter((r) => r.review_state === 'approved' || r.review_state === 'rejected');
  lines.push('## 🔒 已裁决标签（不可覆写，仅存档展示）');
  lines.push('');
  if (decided.length === 0) lines.push('（当前无已裁决标签）');
  else {
    for (const r of decided) {
      lines.push(`- #${r.id} [${r.field}] ${r.value} → **${r.review_state}**（${r.file_name}）`);
    }
  }
  lines.push('');

  // ---- 明细（按素材分组） ----
  lines.push('## 明细（按素材分组）');
  lines.push('');
  let cur = null;
  for (const r of rows) {
    if (r.file_name !== cur) {
      cur = r.file_name;
      lines.push(`### ${cur}（${r.source_class}）`);
      lines.push('');
      lines.push('| # | 字段 | 值 | 置信度 | 证据来源 | 状态 | 关联节点 |');
      lines.push('| --- | --- | --- | --- | --- | --- | --- |');
    }
    lines.push(`| #${r.id} | ${r.field} | ${r.value} | ${r.confidence ?? '-'} | ${r.evidence_level} | ${r.review_state} | ${r.linked_node_id ?? '-'} |`);
  }
  lines.push('');

  db.close();
  const out = args.out ?? path.join(REPO_ROOT, 'docs', 'REVIEW-AUDIT-REPORT.md');
  fs.writeFileSync(out, lines.join('\n'), 'utf8');
  console.log(`报告已写入：${out}`);
  console.log(`标签 ${rows.length} 条；低置信度 ${lowConfRows.length}；争议 ${disputed.length}；待人工决策 ${needDecision.length}；已裁决 ${decided.length}`);
}

/** 争议检测：同一 (field, value) 跨素材出现，但置信度极差 > 0.25 或证据等级不一致。 */
function findDisputed(rows) {
  const groups = new Map();
  for (const r of rows) {
    const k = `${r.field}=${r.value}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const out = [];
  for (const [k, g] of groups) {
    if (g.length < 2) continue;
    const confs = g.map((r) => r.confidence ?? 0);
    const spread = Math.max(...confs) - Math.min(...confs);
    const levels = [...new Set(g.map((r) => r.evidence_level))];
    if (spread > 0.25 || levels.length > 1) {
      out.push({
        field: g[0].field, value: g[0].value,
        detail: `${g.length} 条标签（${g.map((r) => `#${r.id}@${r.file_name}`).join('，')}）；` +
          `置信度范围 ${Math.min(...confs).toFixed(2)}~${Math.max(...confs).toFixed(2)}（极差 ${spread.toFixed(2)}）；` +
          `证据等级 ${levels.join('/')}`,
      });
    }
  }
  return out;
}

main();
