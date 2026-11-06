/**
 * bridge_workspaces 表的 Repository（PR-A，B01-B04）。
 *
 * 独立文件最小侵入：repo.mjs 已是大文件，桥的持久化隔离在此。
 * 幂等纪律：upsert 用 INSERT OR REPLACE——同一 plugin_id 重复 import 复用同一行
 * （B02）；调用方保证 workspaceId 稳定后才落库（create 失败不落库，原子性）。
 *
 * 只读写 bridge_workspaces，不触碰宿主 Workspace 内部表（裁决书 §四）。
 */

const COLS = 'plugin_id, workspace_id, chat_session_id, control_session_id, created_at';
const SESSION_KEYS = new Set(['chat', 'control']);
const COLUMN_BY_KEY = { chat: 'chat_session_id', control: 'control_session_id' };

/**
 * 插件 → 工作区绑定（幂等）。已存在时整行替换（以最近一次成功创建的事实为准）。
 * @returns {{pluginId, workspaceId, chatSessionId, controlSessionId, createdAt}}
 */
export function upsertBridgeWorkspace(db, { pluginId, workspaceId, chatSessionId = '', controlSessionId = '' }) {
  if (!pluginId || typeof pluginId !== 'string') throw new Error('upsertBridgeWorkspace: pluginId 必填');
  if (!workspaceId || typeof workspaceId !== 'string') throw new Error('upsertBridgeWorkspace: workspaceId 必填');
  const createdAt = Date.now();
  db.prepare(`INSERT OR REPLACE INTO bridge_workspaces (${COLS}) VALUES (?, ?, ?, ?, ?)`)
    .run(pluginId, workspaceId, chatSessionId, controlSessionId, createdAt);
  return { pluginId, workspaceId, chatSessionId, controlSessionId, createdAt };
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
    controlSessionId: row.control_session_id,
    createdAt: row.created_at,
  };
}

const COL_WHITELIST = Object.freeze(new Set(['chat_session_id', 'control_session_id']));

/**
 * 会话 id 回填（ensureSession 后调用；只允许写两列会话列，白名单防注入）。
 * @returns boolean 是否真的更新了一行
 */
export function updateBridgeWorkspaceSession(db, pluginId, key, sessionId) {
  const column = COLUMN_BY_KEY[key];
  if (!column || !COL_WHITELIST.has(column)) throw new Error(`updateBridgeWorkspaceSession: 非法 key ${key}`);
  if (!sessionId || typeof sessionId !== 'string') throw new Error('updateBridgeWorkspaceSession: sessionId 必填');
  const r = db.prepare(`UPDATE bridge_workspaces SET ${column} = ? WHERE plugin_id = ?`).run(sessionId, pluginId);
  return r.changes > 0;
}

export const BRIDGE_SESSION_KEYS = SESSION_KEYS;
