/**
 * 动作注册表 Repository（OACA-2，schema v12）：action_manifests + compiled_actions。
 *
 * 职责边界（严格单向）：
 *  - 本文件是**纯 DB 层**：不 import 插件侧任何模块（action-compiler / nodegraph*），
 *    编译产物的组装由插件侧 lib/action-registry-sync.mjs 完成后再喂进来。
 *  - 只读写 action_manifests / compiled_actions 两张表，不触碰 bridge_actions 等其他表。
 *
 * 一致性纪律：
 *  - 一切写入走参数化 SQL + withTransaction（发布是"demote 旧 + 写新 manifest + 写动作行"
 *    三段原子操作，任何一步失败必须整体回滚，绝不能留下"两个 published"或半套动作）。
 *  - **每模型仅一个 published**：靠 ux_action_manifests_published（partial unique index）
 *    由 DB 兜底；语句顺序必须先 UPDATE demote 再 INSERT/UPSERT，否则撞唯一索引。
 *  - 可派发性只认 compiled_actions.status='published'：
 *      · 被拒动作（编译器 status='rejected'）**不入** compiled_actions（结论留在
 *        manifest_json 里可审计，但运行时不路由）；
 *      · 旧 revision 的遗留动作，以及**本次发布集合里不再出现的动作**（同 revision 重发收缩时
 *        也会发生），一并置 'stale'（不再可派发）；
 *      · 能力档案 revision 变化时由 markStaleByCapability 批量置 'stale'。
 *  - 幂等：同 (modelId, revision) 重复发布 = 覆盖同一行（ON CONFLICT DO UPDATE），
 *    不产生重复行、不抛错（Agent/用户重试编译不得把注册表撑爆）。
 *  - 时间列由本层显式传值（对齐 v7/v8/v9 风格，不用 DEFAULT 表达式），便于测试与回放。
 */
import { withTransaction } from './db.mjs';

const MANIFEST_COLS =
  'manifest_id, model_id, capability_revision, manifest_json, compiler_version, status, revision, created_at';

const ACTION_COLS =
  'model_id, action_id, graph_id, manifest_id, graph_hash, capability_revision, status, ' +
  'priority, triggers_json, parameters_json, requires_own_json, updated_at';

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

function assertPublishArgs({ modelId, revision, actions, manifest }) {
  if (!isNonEmptyString(modelId)) throw new Error('publishBundleToDb: modelId 必填且非空');
  if (!Number.isInteger(revision) || revision < 1) {
    throw new Error(`publishBundleToDb: revision 必须是 ≥1 的整数，收到 ${String(revision)}`);
  }
  if (!Array.isArray(actions)) throw new Error('publishBundleToDb: actions 必须是数组');
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('publishBundleToDb: manifest 必须是对象');
  }
}

/** manifest_id 生成规则：`${model_id}@rev${revision}`（与 schema 注释一致，唯一入口）。 */
export function manifestIdOf(modelId, revision) {
  return `${modelId}@rev${revision}`;
}

/**
 * 发布一次编译产物到注册表（单事务、幂等）。
 *
 * 语义：
 *  1. 该 model 现有 status='published' 且不是本次 manifest 的行 → 'superseded'；
 *  2. INSERT 或 UPSERT 本次 manifest（status='published'）；
 *  3. 只把 status==='compiled' 的动作写入 compiled_actions（status='published'），
 *     其余（rejected 等）跳过——结论仍留在 manifest_json 里可审计；
 *  4. 该 model 下属于**其它 manifest** 的 published 动作行 → 'stale'（不再可派发）。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{modelId: string, capabilityRevision?: string, compilerVersion?: string,
 *          revision: number, manifest: object, actions: object[]}} input
 * @returns {{manifestId: string, revision: number, publishedActions: string[]}}
 */
export function publishBundleToDb(db, input) {
  const { modelId, revision, manifest } = input || {};
  const actions = (input && input.actions) || [];
  assertPublishArgs({ modelId, revision, actions, manifest });

  const capabilityRevision = String(input.capabilityRevision ?? '');
  const compilerVersion = String(input.compilerVersion ?? '');
  const manifestId = manifestIdOf(modelId, revision);
  const now = Number.isInteger(input.now) ? input.now : Date.now();

  const compiled = actions.filter((a) => a && a.status === 'compiled' && isNonEmptyString(a.actionId));

  return withTransaction(db, () => {
    // 1) 先 demote：保证 partial unique index（每模型一个 published）在写入时不冲突。
    db.prepare(
      `UPDATE action_manifests SET status = 'superseded'
       WHERE model_id = ? AND status = 'published' AND manifest_id <> ?`,
    ).run(modelId, manifestId);

    // 2) 新 manifest 落库（幂等：同 manifestId 覆盖）。
    db.prepare(
      `INSERT INTO action_manifests (${MANIFEST_COLS})
       VALUES (?, ?, ?, ?, ?, 'published', ?, ?)
       ON CONFLICT(manifest_id) DO UPDATE SET
         capability_revision = excluded.capability_revision,
         manifest_json       = excluded.manifest_json,
         compiler_version    = excluded.compiler_version,
         status              = 'published',
         created_at          = excluded.created_at`,
    ).run(
      manifestId,
      modelId,
      capabilityRevision,
      JSON.stringify(manifest),
      compilerVersion,
      revision,
      now,
    );

    // 3) 可派发动作（仅 status='compiled'）逐条 UPSERT。
    const upsertAction = db.prepare(
      `INSERT INTO compiled_actions (${ACTION_COLS})
       VALUES (?, ?, ?, ?, ?, ?, 'published', ?, ?, ?, ?, ?)
       ON CONFLICT(model_id, action_id) DO UPDATE SET
         graph_id            = excluded.graph_id,
         manifest_id         = excluded.manifest_id,
         graph_hash          = excluded.graph_hash,
         capability_revision = excluded.capability_revision,
         status              = 'published',
         priority            = excluded.priority,
         triggers_json       = excluded.triggers_json,
         parameters_json     = excluded.parameters_json,
         requires_own_json   = excluded.requires_own_json,
         updated_at          = excluded.updated_at`,
    );
    for (const action of compiled) {
      upsertAction.run(
        modelId,
        action.actionId,
        String(action.graphId ?? ''),
        manifestId,
        String(action.graphHash ?? ''),
        String(action.capabilityRevision ?? capabilityRevision),
        String(action.priority ?? 'NORMAL'),
        JSON.stringify(Array.isArray(action.triggers) ? action.triggers : []),
        JSON.stringify(action.parameters && typeof action.parameters === 'object' ? action.parameters : {}),
        JSON.stringify(Array.isArray(action.requiresOwn) ? action.requiresOwn : []),
        now,
      );
    }

    // 4) 收缩置 stale：本模型下所有 status='published' 但**不在本次发布集合里**的动作行
    //    → 'stale'（不可再派发）。
    //    ⚠ QA-F9 修正：原实现按 `manifest_id <> 本次` 判断，同 revision 重发且动作被移除时
    //    manifest_id 相同 → 旧行漏网仍是 published（冒烟实证：nod 仍可派发）。改为按 action_id
    //    集合判定，既覆盖跨 revision 遗留、也覆盖同 revision 收缩；刚 UPSERT 的动作必在集合内，
    //    不会被误伤。
    const keep = compiled.map((a) => a.actionId);
    if (keep.length) {
      const placeholders = keep.map(() => '?').join(', ');
      db.prepare(
        `UPDATE compiled_actions SET status = 'stale', updated_at = ?
         WHERE model_id = ? AND status = 'published' AND action_id NOT IN (${placeholders})`,
      ).run(now, modelId, ...keep);
    } else {
      // 本次没有任何动作通过编译：该模型全部旧 published 行下线（不留下"幽灵可派发动作"）。
      db.prepare(
        `UPDATE compiled_actions SET status = 'stale', updated_at = ?
         WHERE model_id = ? AND status = 'published'`,
      ).run(now, modelId);
    }

    return { manifestId, revision, publishedActions: compiled.map((a) => a.actionId) };
  });
}

/**
 * 取单条可派发动作（运行时路由唯一查询入口）。
 * @returns {{modelId: string, actionId: string, graphId: string, graphHash: string,
 *            capabilityRevision: string, status: string, priority: string,
 *            triggers: any[], parameters: object, requiresOwn: any[],
 *            manifestId: string, updatedAt: number} | null}
 */
export function getPublishedAction(db, { modelId, actionId } = {}) {
  if (!isNonEmptyString(modelId) || !isNonEmptyString(actionId)) return null;
  const row = db
    .prepare(`SELECT ${ACTION_COLS} FROM compiled_actions WHERE model_id = ? AND action_id = ?`)
    .get(modelId, actionId);
  return row ? toActionDomain(row) : null;
}

/** 某模型全部可派发动作（status='published'；stale/rejected 一律不返回）。 */
export function listPublishedActions(db, { modelId } = {}) {
  if (!isNonEmptyString(modelId)) return [];
  const rows = db
    .prepare(
      `SELECT ${ACTION_COLS} FROM compiled_actions
       WHERE model_id = ? AND status = 'published'
       ORDER BY action_id ASC`,
    )
    .all(modelId);
  return rows.map(toActionDomain);
}

/** 当前 published manifest（含完整 manifest 快照）。 */
export function getCurrentManifest(db, { modelId } = {}) {
  if (!isNonEmptyString(modelId)) return null;
  const row = db
    .prepare(`SELECT ${MANIFEST_COLS} FROM action_manifests WHERE model_id = ? AND status = 'published'`)
    .get(modelId);
  return row ? toManifestDomain(row) : null;
}

/**
 * 能力档案 revision 变化 → 该模型旧 revision 的 published 动作全部置 stale。
 * @returns {{staled: number}}
 */
export function markStaleByCapability(db, { modelId, capabilityRevision } = {}) {
  if (!isNonEmptyString(modelId)) throw new Error('markStaleByCapability: modelId 必填');
  const revision = String(capabilityRevision ?? '');
  const r = db
    .prepare(
      `UPDATE compiled_actions SET status = 'stale', updated_at = ?
       WHERE model_id = ? AND status = 'published' AND capability_revision <> ?`,
    )
    .run(Date.now(), modelId, revision);
  return { staled: r.changes };
}

/**
 * 显式把某 manifest 置 superseded（回滚/测试用）。
 * @returns {boolean} 是否真的改到了一行（已 superseded 返回 false，幂等）
 */
export function supersedeManifest(db, { manifestId } = {}) {
  if (!isNonEmptyString(manifestId)) throw new Error('supersedeManifest: manifestId 必填');
  const r = db
    .prepare(`UPDATE action_manifests SET status = 'superseded' WHERE manifest_id = ? AND status = 'published'`)
    .run(manifestId);
  return r.changes > 0;
}

function parseJsonColumn(text, fallback) {
  if (text == null) return fallback;
  try {
    const value = JSON.parse(text);
    return value ?? fallback;
  } catch {
    return fallback; // 坏行不抛穿：返回 fallback，调用方按"无该字段"处理
  }
}

function toActionDomain(row) {
  return {
    modelId: row.model_id,
    actionId: row.action_id,
    graphId: row.graph_id,
    graphHash: row.graph_hash,
    capabilityRevision: row.capability_revision,
    status: row.status,
    priority: row.priority,
    triggers: parseJsonColumn(row.triggers_json, []),
    parameters: parseJsonColumn(row.parameters_json, {}),
    requiresOwn: parseJsonColumn(row.requires_own_json, []),
    manifestId: row.manifest_id,
    updatedAt: row.updated_at,
  };
}

function toManifestDomain(row) {
  return {
    manifestId: row.manifest_id,
    modelId: row.model_id,
    revision: row.revision,
    capabilityRevision: row.capability_revision,
    compilerVersion: row.compiler_version,
    status: row.status,
    createdAt: row.created_at,
    manifest: parseJsonColumn(row.manifest_json, null),
  };
}
