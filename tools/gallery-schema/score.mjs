#!/usr/bin/env node
// gallery-scorer 规则引擎（GALLERY-BRIDGE-DECREE §2）
// 只读打开主库，对 gallery_items 全量计算规则分，读入 data/gallery-scores-draft.json
// 中的视觉分明细做合成（有视觉分：0.4×规则 + 0.6×视觉），输出/更新该 JSON。
// 零依赖，node:stdlib。禁写主库。用法：node tools/gallery-schema/score.mjs

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DB_PATH = process.env.DB_PATH ?? join(ROOT, 'data', 'bootstrap-state.sqlite');
const DRAFT_PATH = process.env.DRAFT_PATH ?? join(ROOT, 'data', 'gallery-scores-draft.json');
const GALLERY_DIR = process.env.GALLERY_DIR ?? 'D:/Temp/l2d-gallery-extract/';
// L6：GALLERY_DIR 不存在时大声告警（review 建议改相对仓库路径，但当前 105 张
// 提取图实际存放在该外部目录，改为不存在的仓库相对路径会让全量误判
// file_missing → 导入侧全跳过，比现状更糟；改为存在性守卫 + 告警，
// 是否迁移图库进仓库交由主理人裁定）。
if (!existsSync(GALLERY_DIR)) {
  console.error(`[warn] GALLERY_DIR 不存在：${GALLERY_DIR} —— 全部条目将标记 file_missing（导入侧会全部跳过）`);
}

const CLAMP = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ---- 主流程 ----
const db = new DatabaseSync(DB_PATH, { readOnly: true });
const items = db
  .prepare('SELECT id, file_name, source_class FROM gallery_items ORDER BY id')
  .all()
  .map((r) => ({ item_id: r.id, file_name: r.file_name, source_class: r.source_class }));
const labelRows = db
  .prepare('SELECT item_id, field, value, confidence, evidence_level, evidence, review_state FROM gallery_labels')
  .all();
db.close();

const labelsByItem = new Map();
for (const l of labelRows) {
  if (!labelsByItem.has(l.item_id)) labelsByItem.set(l.item_id, []);
  labelsByItem.get(l.item_id).push(l);
}

// 读 draft（视觉分明细，增量保留）。
// M3：解析失败 fail-fast 拒绝续跑——vision 打分是外部 Agent 的昂贵产物，
// 原实现按「空 draft」继续会把全量规则分覆盖写回，永久丢失已积累的视觉分明细。
const anomalies = [];
let draft = { items: [] };
if (existsSync(DRAFT_PATH)) {
  try {
    draft = JSON.parse(readFileSync(DRAFT_PATH, 'utf8'));
  } catch (e) {
    console.error(`[error] draft JSON 解析失败，拒绝覆盖写（fail-fast 保护视觉分明细）：${e.message}`);
    console.error(`[error] 请人工检查 ${DRAFT_PATH}（可能截断损坏）；如确认丢弃请手动删除后重跑`);
    process.exit(1);
  }
}
const visionByItem = new Map();
for (const it of draft.items ?? []) {
  // M2：三字段完整性守卫——body/clarity 缺失时合成公式得 NaN，NaN 写回 draft
  // 污染后续增量合成、导入侧 Number.isFinite 过滤后静默丢分。不完整 → 按纯
  // 规则分处理并计入 anomalies（可察觉，不静默）。
  const v = it && it.vision;
  const complete =
    v &&
    Number.isFinite(v.expression) &&
    Number.isFinite(v.body) &&
    Number.isFinite(v.clarity);
  if (complete) {
    visionByItem.set(it.item_id, v);
  } else if (v) {
    anomalies.push({ item_id: it.item_id, issue: 'vision_incomplete_fields_treated_as_rule' });
  }
}

// 合成
const outItems = [];
for (const it of items) {
  const labels = labelsByItem.get(it.item_id) ?? [];
  const exprCount = labels.filter((l) => l.field === 'expression' && l.review_state !== 'rejected').length;
  const poseCount = labels.filter((l) => l.field === 'pose' && l.review_state !== 'rejected').length;
  const cueCount = labels.filter((l) => l.field === 'motion_cue' && l.review_state !== 'rejected').length;

  const expression = CLAMP(exprCount * 12, 0, 36);
  const body = CLAMP(poseCount * 8 + cueCount * 15, 0, 35);
  const exact = labels.filter(
    (l) => (l.field === 'pose' || l.field === 'motion_cue') && l.evidence_level === 'source_exact' && l.review_state !== 'rejected',
  );
  const clarity = exact.length > 0 ? (exact.some((l) => l.confidence !== null && l.confidence < 0.5) ? 7 : 14) : 0;

  let textPenalty = 0;
  for (const l of labels) {
    if (l.review_state === 'rejected' || !l.evidence) continue;
    const bigText = /[\u4e00-\u9fff\w]{60,}/.test(l.evidence) && /抄录|transcript|ocr|原文/i.test(l.evidence);
    if (bigText) {
      textPenalty -= 5;
      break;
    }
  }

  const prior = { gif_reference: 15, fan_art: 10, screenshot: 5, photo: 0, other: 0, character_sheet: 0, poster: 0 }[it.source_class] ?? 0;

  const baseScore = CLAMP(expression + body + clarity + textPenalty + prior, 0, 100);
  const rule = { expression, body, clarity, text_penalty: textPenalty, prior, base_score: baseScore };

  const vision = visionByItem.get(it.item_id) ?? null;
  if (vision) {
    const total = Math.round(0.4 * vision.expression + 0.4 * vision.body + 0.2 * vision.clarity);
    vision.total = total;
  }

  let score = baseScore;
  let scorer = 'rule-engine-v1';
  if (vision) {
    score = Math.round((0.4 * baseScore + 0.6 * vision.total) * 10) / 10;
    scorer = 'blend-v1';
  }
  score = CLAMP(score, 0, 100);

  const fileMissing = !existsSync(join(GALLERY_DIR, it.file_name));
  if (fileMissing) anomalies.push({ item_id: it.item_id, file_name: it.file_name, issue: 'file_missing_in_GALLERY_DIR' });

  outItems.push({
    item_id: it.item_id,
    file_name: it.file_name,
    source_class: it.source_class,
    rule,
    vision,
    score,
    scorer,
    file_missing: fileMissing,
  });
}

const output = {
  schema: 'gallery-scores-draft/v1',
  updated_at: new Date().toISOString(),
  compose: { rule_weight: 0.4, vision_weight: 0.6, vision_total: '0.4*expression+0.4*body+0.2*clarity' },
  gallery_dir: GALLERY_DIR,
  items: outItems,
  anomalies,
};
// M3：原子写——先写 .tmp 再 renameSync 替换；进程中途崩溃 / 磁盘满不会把唯一
// 数据文件截断损坏（Windows renameSync 目标存在时直接替换，同盘原子性由 FS 保证）。
const tmpPath = `${DRAFT_PATH}.tmp`;
writeFileSync(tmpPath, JSON.stringify(output, null, 2) + '\n', 'utf8');
renameSync(tmpPath, DRAFT_PATH);

// ---- 自校验输出 ----
const scores = outItems.map((i) => i.score);
const min = Math.min(...scores);
const max = Math.max(...scores);
const outOfRange = scores.filter((s) => s < 0 || s > 100).length;
const bins = new Array(10).fill(0);
for (const s of scores) bins[CLAMP(Math.floor(s / 10), 0, 9)]++;
const bar = (n) => '#'.repeat(n);
console.log(`[score.mjs] 共 ${outItems.length} 条 → ${DRAFT_PATH}`);
console.log(`  视觉分覆盖：${visionByItem.size} 条 | 规则分：${outItems.length - visionByItem.size} 条 | score 范围 [${min}, ${max}]，越界 ${outOfRange} 条`);
console.log('  分数直方图（10 分/桶）:');
bins.forEach((n, i) => console.log(`    ${String(i * 10).padStart(2)}-${i * 10 + 9 | 0}: ${bar(n)} ${n}`));
if (outItems.length !== 105) console.error(`[warn] item 总数 ${outItems.length} ≠ 105`);
if (outOfRange > 0) process.exitCode = 1;
if (anomalies.length) console.warn(`  异常：${anomalies.map((a) => `#${a.item_id} ${a.issue}`).join('; ')}`);
