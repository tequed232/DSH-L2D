/**
 * 触发映射 Repository（schema v14，用户设计 2026-11-13）。
 *
 * 职责：emote / 系统事件 → programId 的确定性查表。
 * 原则（ACTION-PROGRAM-SPEC-DRAFT.md §1）：
 *   - 运行期可以"选择"程序，但不能"生成"或"修改"程序；
 *   - 映射在导入期生成（编译期产物），运行期只读；
 *   - 查不到匹配返回 no_match，**绝不回退到实时规划**。
 */
import { withTransaction } from './db.mjs';

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

/** 情绪词归一：查表与写入共用同一规则，避免 'Happy' 与 'happy' 因大小写各存一份。 */
function normalizeEmotion(v) {
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}

function assertRules(modelId, version, rules) {
  if (!isNonEmptyString(modelId)) throw new Error('setTriggerMap: modelId 必填');
  if (!Number.isInteger(version) || version < 1) {
    throw new Error(`setTriggerMap: version 必须 ≥1 整数，收到 ${String(version)}`);
  }
  if (!Array.isArray(rules) || rules.length === 0) {
    throw new Error('setTriggerMap: rules 必须是非空数组');
  }
  const seen = new Map(); // emotion → [min,max][] 用于重叠检测
  for (const rule of rules) {
    if (!rule || typeof rule !== 'object') throw new Error('setTriggerMap: rule 必须是对象');
    if (!isNonEmptyString(rule.emotion)) throw new Error('setTriggerMap: rule.emotion 必填');
    rule.emotion = normalizeEmotion(rule.emotion);
    if (!Array.isArray(rule.intensity) || rule.intensity.length !== 2
      || !rule.intensity.every((n) => typeof n === 'number' && Number.isFinite(n))
      || rule.intensity[0] > rule.intensity[1]) {
      throw new Error(`setTriggerMap: rule.intensity 必须是 [min,max] 且 min≤max（emotion=${rule.emotion}）`);
    }
    if (!isNonEmptyString(rule.programId)) throw new Error('setTriggerMap: rule.programId 必填');
    const list = seen.get(rule.emotion) || [];
    list.push([rule.intensity[0], rule.intensity[1]]);
    seen.set(rule.emotion, list);
  }
  // 区间不得重叠（同一 emotion 内）——重叠会让查表结果取决于遍历顺序，破坏确定性
  for (const [emotion, intervals] of seen) {
    intervals.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < intervals.length; i++) {
      if (intervals[i][0] < intervals[i - 1][1]) {
        throw new Error(
          `setTriggerMap: emotion="${emotion}" 的强度区间重叠（[${intervals[i - 1]}] 与 [${intervals[i]}]）`,
        );
      }
    }
  }
}

/**
 * 整体替换某模型某版本的映射（单事务）。导入期编译完成后调用；运行期只读。
 * @returns {{replaced: number, rules: number}}
 */
export function setTriggerMap(db, { modelId, version, rules }) {
  assertRules(modelId, version, rules);
  return withTransaction(db, () => {
    db.prepare('DELETE FROM trigger_map WHERE model_id = ? AND version = ?').run(modelId, version);
    const now = Date.now();
    const insert = db.prepare(
      `INSERT INTO trigger_map (model_id, version, emotion, intensity_min, intensity_max, program_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const rule of rules) insert.run(modelId, version, rule.emotion, rule.intensity[0], rule.intensity[1], rule.programId, now);
    return { replaced: 1, rules: rules.length };
  });
}

/**
 * 查表：emotion + intensity → programId。
 * @returns {{match: true, programId: string, version: number} | {match: false, reason: 'no_match'}}
 *          未命中一律 no_match（调用方不得回退到实时规划）。
 */
export function resolveEmoteProgram(db, { modelId, emotion, intensity }) {
  const emotionKey = normalizeEmotion(emotion);
  if (!isNonEmptyString(modelId) || !emotionKey) return { match: false, reason: 'no_match' };
  const value = typeof intensity === 'number' && Number.isFinite(intensity) ? intensity : null;
  if (value === null) return { match: false, reason: 'no_match' };
  const rows = db
    .prepare(
      `SELECT version, intensity_min, intensity_max, program_id
       -- 边界规则：闭区间在交界处有二义（如 [0,0.5] 与 [0.5,1] 的 0.5）。
       -- 约定：强度较高段优先（intensity_min DESC 先查），边界值归属更高强度——
       -- 与"强度越大反应越强"的直觉一致，且与遍历顺序无关（确定性）。
       FROM trigger_map WHERE model_id = ? AND emotion = ? ORDER BY version DESC, intensity_min DESC`,
    )
    .all(modelId, emotionKey);
  for (const row of rows) {
    if (value >= row.intensity_min && value <= row.intensity_max) {
      // fail-closed：命中规则还不够，指向的程序必须**当前确实可派发**。
      // 映射是导入期产物，程序可能已重编译/下线；放行一个不存在的 programId
      // 会让派发层报 404，而查表层却宣称命中——账实不符。
      const program = db
        .prepare("SELECT status FROM compiled_actions WHERE model_id = ? AND action_id = ?")
        .get(modelId, row.program_id);
      if (!program || program.status !== 'published') {
        return { match: false, reason: 'no_match', detail: `映射命中 ${row.program_id} 但该程序已不可派发（${program ? program.status : '不存在'}）` };
      }
      return { match: true, programId: row.program_id, version: row.version };
    }
  }
  return { match: false, reason: 'no_match' };
}

/** 读取某模型当前映射（取最大 version）。供导入期回显与巡检用。 */
export function getTriggerMap(db, { modelId } = {}) {
  if (!isNonEmptyString(modelId)) return { version: 0, rules: [] };
  const top = db
    .prepare('SELECT MAX(version) AS v FROM trigger_map WHERE model_id = ?')
    .get(modelId);
  if (!top || top.v === null) return { version: 0, rules: [] };
  const rows = db
    .prepare(
      `SELECT emotion, intensity_min, intensity_max, program_id
       FROM trigger_map WHERE model_id = ? AND version = ? ORDER BY emotion, intensity_min`,
    )
    .all(modelId, top.v);
  return {
    version: top.v,
    rules: rows.map((r) => ({ emotion: r.emotion, intensity: [r.intensity_min, r.intensity_max], programId: r.program_id })),
  };
}
