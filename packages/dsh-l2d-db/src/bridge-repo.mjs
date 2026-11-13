/**
 * bridge_workspaces 表的 Repository（PR-A B01-B04；PR-1 扩 action session）。
 *
 * 独立文件最小侵入：repo.mjs 已是大文件，桥的持久化隔离在此。
 * 幂等纪律：upsert 用 INSERT OR REPLACE——同一 plugin_id 重复 import 复用同一行
 * （B02）；调用方保证 workspaceId 稳定后才落库（create 失败不落库，原子性）。
 *
 * 双会话纪律（PR-1）：
 *   - 活动会话 = chat + action 两个；control_session_id 是**只读兼容列**，
 *     只为旧库/旧调用方保留，v11 升级不回填（禁止未经检查复用旧 Control Session）。
 *   - 会话 id 回填分两条路径：`updateBridgeWorkspaceSession`（无条件写，兼容旧调用）
 *     与 `claimBridgeWorkspaceSession`（UPDATE ... WHERE 空 → SQL 级 CAS，并发安全）。
 *     新建会话一律走后者，避免并发导入各建一个会话。
 *
 * 只读写 bridge_workspaces，不触碰宿主 Workspace 内部表（裁决书 §四）。
 */

const COLS = 'plugin_id, workspace_id, chat_session_id, control_session_id, action_session_id, created_at';
/** 活动会话键（服务端语义）；'model-control' 为旧键，仅写兼容列。 */
const SESSION_KEYS = new Set(['chat', 'action', 'model-control']);
const COLUMN_BY_KEY = { chat: 'chat_session_id', action: 'action_session_id', 'model-control': 'control_session_id' };

/**
 * 插件 → 工作区绑定（幂等）。已存在时整行替换（以最近一次成功创建的事实为准）。
 * 注意：整行替换会把 action_session_id 清空——仅供 create 路径使用；
 * 已有会话 id 的行请走 update/claim，不要重新 upsert。
 * @returns {{pluginId, workspaceId, chatSessionId, controlSessionId, actionSessionId, createdAt}}
 */
export function upsertBridgeWorkspace(db, { pluginId, workspaceId, chatSessionId = '', controlSessionId = '', actionSessionId = '' }) {
  if (!pluginId || typeof pluginId !== 'string') throw new Error('upsertBridgeWorkspace: pluginId 必填');
  if (!workspaceId || typeof workspaceId !== 'string') throw new Error('upsertBridgeWorkspace: workspaceId 必填');
  const createdAt = Date.now();
  db.prepare(`INSERT OR REPLACE INTO bridge_workspaces (${COLS}) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(pluginId, workspaceId, chatSessionId, controlSessionId, actionSessionId, createdAt);
  return { pluginId, workspaceId, chatSessionId, controlSessionId, actionSessionId, createdAt };
}

/** @returns 工作区行（驼峰化）| null（未绑定 = 首次 import，B01） */
export function findBridgeWorkspace(db, pluginId) {
  if (!pluginId) return null;
  const row = db.prepare(`SELECT ${COLS} FROM bridge_workspaces WHERE plugin_id = ?`).get(pluginId);
  return row ? toDomain(row) : null;
}

/** @returns 工作区行 | null —— SessionController 按 A2A workspaceId 反查（表主键是 plugin_id） */
export function findBridgeWorkspaceByWorkspaceId(db, workspaceId) {
  if (!workspaceId) return null;
  const row = db.prepare(`SELECT ${COLS} FROM bridge_workspaces WHERE workspace_id = ?`).get(workspaceId);
  return row ? toDomain(row) : null;
}

function toDomain(row) {
  return {
    pluginId: row.plugin_id,
    workspaceId: row.workspace_id,
    chatSessionId: row.chat_session_id,
    /** @deprecated 只读兼容列；v11 起新写入走 actionSessionId。 */
    controlSessionId: row.control_session_id,
    actionSessionId: row.action_session_id,
    createdAt: row.created_at,
  };
}

const COL_WHITELIST = Object.freeze(new Set(['chat_session_id', 'control_session_id', 'action_session_id']));

/**
 * 会话 id 回填（无条件写；兼容旧调用方与"已知值覆盖"场景）。
 * 并发新建请改用 claimBridgeWorkspaceSession（CAS）。
 * @returns boolean 是否真的更新了一行
 */
export function updateBridgeWorkspaceSession(db, pluginId, key, sessionId) {
  const column = COLUMN_BY_KEY[key];
  if (!column || !COL_WHITELIST.has(column)) throw new Error(`updateBridgeWorkspaceSession: 非法 key ${key}`);
  if (!sessionId || typeof sessionId !== 'string') throw new Error('updateBridgeWorkspaceSession: sessionId 必填');
  const r = db.prepare(`UPDATE bridge_workspaces SET ${column} = ? WHERE plugin_id = ?`).run(sessionId, pluginId);
  return r.changes > 0;
}

/**
 * 会话 id 抢占式回填（SQL 级 CAS）：仅当目标列为空时写入。
 *
 * 并发导入两条链路各建了一个会话时，只有第一条 UPDATE 生效（changes=1），
 * 第二条 changes=0 → 调用方回读既有 id 并复用，保证"恰好一个"会话绑在行上。
 * 空判据同时覆盖 NULL 与 ''（v7 建表用空串占位，v11 新列默认空串）。
 * @returns {{claimed: boolean, sessionId: string}|null} null = 行不存在
 */
export function claimBridgeWorkspaceSession(db, pluginId, key, sessionId) {
  const column = COLUMN_BY_KEY[key];
  if (!column || !COL_WHITELIST.has(column)) throw new Error(`claimBridgeWorkspaceSession: 非法 key ${key}`);
  if (!sessionId || typeof sessionId !== 'string') throw new Error('claimBridgeWorkspaceSession: sessionId 必填');
  const r = db.prepare(
    `UPDATE bridge_workspaces SET ${column} = ? WHERE plugin_id = ? AND (${column} IS NULL OR ${column} = '')`,
  ).run(sessionId, pluginId);
  const row = db.prepare(`SELECT ${column} AS v FROM bridge_workspaces WHERE plugin_id = ?`).get(pluginId);
  if (!row) return null;
  return { claimed: r.changes > 0, sessionId: String(row.v || '') };
}

export const BRIDGE_SESSION_KEYS = SESSION_KEYS;
/** 活动会话键（chat + action）。control 不在其中：它是只读兼容列。 */
export const BRIDGE_ACTIVE_SESSION_KEYS = Object.freeze(['chat', 'action']);
