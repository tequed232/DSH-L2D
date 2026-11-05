/**
 * gallery_scores 表的 Repository（GALLERY-BRIDGE，v10）。
 *
 * 纪律（裁决书 §3/§5）：
 *  - 唯一写入口：打分 Agent 只产 data/gallery-scores-draft.json，主库写入全部经本 repo；
 *  - 导入幂等：按 item_id upsert；来源优先级 vision-agent-v1 / blend-v1 > rule-engine-v1
 *    ——已有高分来源行时，rule-engine 重导入不覆盖（不静默降级已评估结果）；
 *  - 只读写 gallery_scores，情绪摘要经 gallery_labels 只读 JOIN（field='expression'）。
 */

const HIGH_PRECEDENCE = Object.freeze(['vision-agent-v1', 'blend-v1']);
const SCORERS = Object.freeze(['rule-engine-v1', 'vision-agent-v1', 'blend-v1']);

function assertScore(score) {
  const n = Number(score);
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new Error(`upsertGalleryScore: score 须在 [0,100]，收到 ${String(score)}`);
  return n;
}

function scorerRank(scorer) {
  if (HIGH_PRECEDENCE.includes(scorer)) return 2;
  if (scorer === 'rule-engine-v1') return 1;
  return 0;
}

/**
 * upsert 一条打分。同 item 已有更高优先级来源时不覆盖，返回 {applied:false}。
 * @param {{itemId:number, score:number, breakdown:object, scorer:string, scoredAt?:string}} input
 * @returns {{applied: boolean, score: number, scorer: string}}
 */
export function upsertGalleryScore(db, input) {
  const itemId = Number(input && input.itemId);
  if (!Number.isInteger(itemId) || itemId <= 0) throw new Error('upsertGalleryScore: itemId 必须是正整数');
  const score = assertScore(input.score);
  const scorer = String(input.scorer || '');
  if (!SCORERS.includes(scorer)) throw new Error(`upsertGalleryScore: scorer 须为 ${SCORERS.join('|')}，收到 ${scorer}`);
  const breakdownJson = JSON.stringify(input.breakdown ?? {});
  const scoredAt = String(input.scoredAt || new Date().toISOString());

  const existing = db.prepare('SELECT scorer FROM gallery_scores WHERE item_id = ?').get(itemId);
  if (existing && scorerRank(existing.scorer) > scorerRank(scorer)) {
    return { applied: false, score, scorer }; // vision/blend 优先，rule-engine 重导入不覆盖
  }
  db.prepare(
    `INSERT INTO gallery_scores (item_id, score, breakdown_json, scorer, scored_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(item_id) DO UPDATE SET score = excluded.score, breakdown_json = excluded.breakdown_json,
       scorer = excluded.scorer, scored_at = excluded.scored_at`
  ).run(itemId, score, breakdownJson, scorer, scoredAt);
  return { applied: true, score, scorer };
}

/** 打分总数（导入校验/工具空集判定用）。 */
export function countGalleryScores(db) {
  return db.prepare('SELECT COUNT(*) AS n FROM gallery_scores').get().n;
}

/**
 * top-N 打分图（l2d_gallery_top / matcher 附图消费）。
 * @param {{emotion?: string, limit?: number}} [options]
 *   emotion 给定时：只取带该 expression 标签的 item（gallery_labels.field='expression'，
 *   值精确匹配；同一 item 多条标签不去重影响——DISTINCT item）。
 * @returns Array<{itemId, score, scorer, sourceClass, fileName, emotionSummary}>
 *   emotionSummary = 该 item 的 expression 标签值（逗号连接，最多 3 个；无标签空串）。
 */
export function listTopGalleryItems(db, { emotion, limit = 3 } = {}) {
  // L8：limit 为 0/负数显式返回空集（「上限 clamp」语义下 0 条请求 ≠ 回退取 3 条）
  if (Number.isInteger(limit) && limit <= 0) return [];
  const n = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 3) : 3;
  const base = `
    SELECT s.item_id AS itemId, s.score AS score, s.scorer AS scorer,
           i.source_class AS sourceClass, i.file_name AS fileName,
           (SELECT group_concat(value, ',') FROM (
              SELECT value FROM gallery_labels
              WHERE item_id = s.item_id AND field = 'expression' ORDER BY id LIMIT 3
            )) AS emotionSummary
    FROM gallery_scores s
    JOIN gallery_items i ON i.id = s.item_id
  `;
  const filter = emotion
    ? `WHERE EXISTS (SELECT 1 FROM gallery_labels l
                     WHERE l.item_id = s.item_id AND l.field = 'expression' AND l.value = ?)
            OR EXISTS (SELECT 1 FROM gallery_labels l
                     WHERE l.item_id = s.item_id AND l.field = 'motion_cue' AND l.value = ?)`
    : '';
  const sql = `${base} ${filter} ORDER BY s.score DESC, s.item_id ASC LIMIT ?`;
  const rows = emotion ? db.prepare(sql).all(String(emotion), String(emotion), n) : db.prepare(sql).all(n);
  return rows.map((r) => ({
    itemId: r.itemId,
    score: r.score,
    scorer: r.scorer,
    sourceClass: r.sourceClass,
    fileName: r.fileName,
    emotionSummary: r.emotionSummary || '',
  }));
}

/**
 * seed prompt_templates（GALLERY-BRIDGE §6 motion-director-v1 定稿正文）。
 * 幂等：同 (template_id, version) 重复 seed 更新正文（模板进化按版本追溯）。
 */
export function seedMotionDirectorTemplate(db, body, { templateId = 'motion-director-v1', version = '1' } = {}) {
  if (typeof body !== 'string' || !body.trim()) throw new Error('seedMotionDirectorTemplate: body 必填');
  db.prepare(
    `INSERT INTO prompt_templates (template_id, version, target_class, body, status)
     VALUES (?, ?, 'other', ?, 'active')
     ON CONFLICT(template_id) DO UPDATE SET version = excluded.version, body = excluded.body, status = 'active'`
  ).run(templateId, version, body);
  return { templateId, version };
}
