#!/usr/bin/env node
/**
 * gallery_scores v10 导入脚本（GALLERY-BRIDGE-DECREE §3，后端席唯一主库写入口）。
 *
 * 数据流：打分 Agent → data/gallery-scores-draft.json（中间文件）→ 本脚本 upsert 主库。
 * 纪律：
 *  - 打分 Agent 禁直写主库（§5）；本脚本经 gallery-repo（唯一 Repository 写入口）；
 *  - 幂等：按 item_id upsert；vision/blend 优先于 rule-engine（repo 守卫）；
 *  - draft 缺失/空集 → no-op + 提示退出 0（打分 Agent 尚未产出是正常状态）；
 *  - 顺带 seed prompt_templates motion-director-v1（§6 定稿正文，幂等）。
 *
 * 用法：node --experimental-sqlite packages/mcp-bridge/import-gallery-scores.mjs [--db <path>] [--dry-run]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, resolveDbPath } from '../dsh-l2d-db/src/db.mjs';
import { upsertGalleryScore, countGalleryScores, seedMotionDirectorTemplate } from '../dsh-l2d-db/src/gallery-repo.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const DRAFT_FILE = process.env.GALLERY_SCORES_DRAFT || path.join(ROOT, 'data', 'gallery-scores-draft.json');

const MOTION_DIRECTOR_V1 = [
  '你是 DSH Live2D 动作指挥。你将收到 1-3 张角色参考图（附 item_id 与分数）。',
  '流程：',
  '1. 读图：列出图中可见的表情（smile/angry/blush 等）与肢体姿态（举手/歪头/裙摆扬起等），禁止想象图中不存在的动作。',
  '2. 映射：优先映射到动作库 semantic_key（如 ear_twitch_independent / angry_flash_single）；无匹配链时用参数级指令（keyframes + ParamId）表达，参数仅限 capability scan 报告的安全参数族与 adapter 绑定参数。',
  '3. 下发：经 l2d_action_enqueue 提交，一次一条链，附 60 字内动作意图说明。',
  '4. 约束：不重复提交相同链；l2d_action_status 显示排队中时等待再提交；需要更多参考时经 l2d_gallery_top 请求，单次不超过 3 张。',
].join('\n');

function argOf(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : null;
}

/** 容错解析 draft：支持 {items:[...]}（camelCase/snake_case）或 {itemId: {...}} 映射两种形态。 */
function parseDraft(raw) {
  const parsed = JSON.parse(raw);
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.items) ? parsed.items : null;
  if (list) {
    return list.map((it) => ({
      itemId: Number(it.itemId ?? it.item_id),
      score: Number(it.score),
      breakdown: it.breakdown ?? (typeof it.breakdown_json === 'string' ? safeJson(it.breakdown_json) : {}),
      scorer: String(it.scorer || 'rule-engine-v1'),
      scoredAt: it.scoredAt ?? it.scored_at,
    })).filter((it) => Number.isInteger(it.itemId) && it.itemId > 0 && Number.isFinite(it.score));
  }
  if (parsed && typeof parsed === 'object') {
    return Object.entries(parsed)
      .map(([id, it]) => ({
        itemId: Number(id),
        score: Number(it?.score),
        breakdown: it?.breakdown ?? (typeof it?.breakdown_json === 'string' ? safeJson(it.breakdown_json) : {}),
        scorer: String(it?.scorer || 'rule-engine-v1'),
        scoredAt: it?.scoredAt ?? it?.scored_at,
      }))
      .filter((it) => Number.isInteger(it.itemId) && it.itemId > 0 && Number.isFinite(it.score));
  }
  return [];
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return {}; }
}

const dbArg = argOf('--db');
const db = openDb(dbArg ? { path: dbArg } : {});
const dryRun = process.argv.includes('--dry-run');

// 1. seed 模板（幂等，独立于 draft 是否就绪）
if (!dryRun) {
  seedMotionDirectorTemplate(db, MOTION_DIRECTOR_V1);
  console.log('[seed] prompt_templates motion-director-v1 就绪');
} else {
  console.log('[seed] dry-run：跳过 prompt_templates');
}

// 2. 导入 draft（缺失/空 → no-op + 提示）
if (!fs.existsSync(DRAFT_FILE)) {
  console.log(`[import] draft 不存在：${DRAFT_FILE}`);
  console.log('[import] no-op（打分 Agent 未产出是正常状态；产出后重跑本脚本即可）');
  process.exit(0);
}
const raw = fs.readFileSync(DRAFT_FILE, 'utf8').trim();
if (!raw) {
  console.log('[import] draft 为空文件 → no-op');
  process.exit(0);
}
let entries;
try {
  entries = parseDraft(raw);
} catch (err) {
  console.error(`[import] draft JSON 解析失败：${err.message}`);
  process.exit(1);
}
if (!entries.length) {
  console.log('[import] draft 无有效条目 → no-op');
  process.exit(0);
}

let applied = 0;
let skippedPrecedence = 0;
let skippedFk = 0;
for (const it of entries) {
  if (dryRun) { applied++; continue; }
  try {
    const r = upsertGalleryScore(db, it);
    if (r.applied) applied++;
    else skippedPrecedence++;
  } catch {
    skippedFk++; // item_id 不在 gallery_items（FK 拒绝）等
  }
}
console.log(`[import] 条目 ${entries.length}：applied=${applied} skipped(precision)=${skippedPrecedence} skipped(fk)=${skippedFk}`);
console.log(`[import] 库内 gallery_scores 总数=${dryRun ? '(dry-run)' : countGalleryScores(db)}`);
if (dryRun) console.log('[import] dry-run：未写库');
