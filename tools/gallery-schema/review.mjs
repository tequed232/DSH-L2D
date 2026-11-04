#!/usr/bin/env node
/**
 * dsh-l2d · 语义标签审核 CLI（P3：needs_review → approved / rejected 人工流转闸门）
 *
 * 纪律（任务书 P3-5/6）：
 *  - 禁止未经人工确认自动将 needs_review 修改为 approved；
 *    本 CLI 是唯一流转入口，approve/reject 必须由人显式逐条执行；
 *  - 全部决策留痕（who/note/at 写入 evidence）；
 *  - rejected 保留原始标注不删除（审计可回溯）。
 *
 * 用法：
 *   node tools/gallery-schema/review.mjs list [--state needs_review] [--limit 20] [--item <file_name>]
 *   node tools/gallery-schema/review.mjs decide <label_id> approved|rejected [--note "..."]
 *   node tools/gallery-schema/review.mjs stats
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../../packages/dsh-l2d-db/src/db.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--state') args.state = argv[++i];
    else if (argv[i] === '--limit') args.limit = Number(argv[++i]);
    else if (argv[i] === '--item') args.item = argv[++i];
    else if (argv[i] === '--note') args.note = argv[++i];
    else args._.push(argv[i]);
  }
  return args;
}

function list(db, args) {
  const state = args.state ?? 'needs_review';
  const limit = args.limit ?? 20;
  const rows = db.prepare(`
    SELECT gl.id, gl.field, gl.value, gl.confidence, gl.evidence_level, gl.review_state,
           gi.file_name, gl.evidence
    FROM gallery_labels gl JOIN gallery_items gi ON gl.item_id = gi.id
    WHERE gl.review_state = ?
      ${args.item ? 'AND gi.file_name = ?' : ''}
    ORDER BY gl.id LIMIT ?
  `).all(...(args.item ? [state, args.item, limit] : [state, limit]));
  for (const r of rows) {
    const ev = r.evidence ? String(r.evidence).slice(0, 80) : '';
    console.log(`#${r.id} [${r.field}] ${r.value}  (${r.evidence_level}, conf=${r.confidence ?? '-'})  ${r.file_name}${ev ? `\n     evidence: ${ev}` : ''}`);
  }
  console.log(`\n${rows.length} label(s) in state '${state}'`);
}

function decide(db, args) {
  const [labelId, decision] = args._;
  if (!labelId || !['approved', 'rejected'].includes(decision)) {
    console.error('用法: review.mjs decide <label_id> approved|rejected [--note "..."]');
    process.exit(2);
  }
  const label = db.prepare('SELECT id, review_state, evidence FROM gallery_labels WHERE id = ?').get(Number(labelId));
  if (!label) { console.error(`标签 #${labelId} 不存在`); process.exit(1); }
  if (label.review_state !== 'needs_review') {
    console.error(`标签 #${labelId} 当前状态 '${label.review_state}'，已裁决的标签不允许覆写（保留审计链）`);
    process.exit(1);
  }
  const evidence = {
    ...(label.evidence ? JSON.parse(label.evidence) : {}),
    review: { decision, note: args.note ?? null, reviewedAt: new Date().toISOString(), reviewedBy: 'human-via-review-cli' },
  };
  db.prepare('UPDATE gallery_labels SET review_state = ?, evidence = ? WHERE id = ?')
    .run(decision, JSON.stringify(evidence), Number(labelId));
  console.log(`#${labelId} -> ${decision}${args.note ? `（${args.note}）` : ''}`);
}

function stats(db) {
  console.log('--- 标签审核状态 ---');
  console.log(db.prepare('SELECT review_state, COUNT(*) n FROM gallery_labels GROUP BY review_state').all());
  console.log('--- 图库条目复核状态 ---');
  console.log(db.prepare('SELECT review_state, COUNT(*) n FROM gallery_items GROUP BY review_state').all());
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const db = openDb({ startDir: REPO_ROOT });
  const [cmd] = args._;
  args._ = args._.slice(1);
  if (cmd === 'list') list(db, args);
  else if (cmd === 'decide') decide(db, args);
  else if (cmd === 'stats') stats(db);
  else { console.error('子命令: list | decide | stats'); process.exit(2); }
  db.close();
}

main();
