/**
 * bridge_actions 表的 Repository（PR-C，B10-B18）。
 *
 * 幂等纪律：insertRequest 用 INSERT OR IGNORE——同 request_id 重复入队返回既有行
 * （B15：Agent 重试不得执行两次）；状态推进只允许沿状态机方向
 * （queued → running → 终态；重启恢复 → interrupted），不提供任意状态写。
 *
 * 只读写 bridge_actions，不触碰其他表（隔离纪律同 bridge-repo）。
 */

const COLS =
  'request_id, workspace_id, control_session_id, action, args_json, state, execution_id, created_at, started_at, completed_at, memory_revision, error, result_json';

const TERMINAL_STATES = Object.freeze(['completed', 'failed', 'cancelled', 'interrupted']);
const UNFINISHED_STATES = Object.freeze(['queued', 'running']);

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

function assertRequest(request) {
  if (!request || !isNonEmptyString(request.requestId)) throw new Error('insertRequest: requestId 必填');
  if (!isNonEmptyString(request.workspaceId)) throw new Error('insertRequest: workspaceId 必填');
  if (!isNonEmptyString(request.action)) throw new Error('insertRequest: action 必填');
}

/**
 * 入队落库（幂等）。同 requestId 已存在时**不覆盖**，返回既有行。
 * @returns {{row: object, inserted: boolean}}
 */
export function insertRequest(db, request) {
  assertRequest(request);
  const createdAt = Number.isInteger(request.createdAt) ? request.createdAt : Date.now();
  const argsJson = JSON.stringify(request.args ?? {});
  db.prepare(
    `INSERT OR IGNORE INTO bridge_actions (${COLS}) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, NULL, NULL, ?, NULL, NULL)`
  ).run(
    request.requestId,
    request.workspaceId,
    String(request.controlSessionId ?? ''),
    request.action,
    argsJson,
    request.executionId ?? null,
    createdAt,
    Number.isInteger(request.memoryRevision) ? request.memoryRevision : 0
  );
  const row = findById(db, request.requestId);
  // INSERT OR IGNORE 后必能查到；防御式断言保持与 db 层一致性契约
  if (!row) throw new Error(`insertRequest: 写入后读取失败 requestId=${request.requestId}`);
  return { row, inserted: row.createdAt === createdAt };
}

/** queued → running。返回是否真的推进了一行。 */
export function markRunning(db, requestId, startedAt = Date.now()) {
  if (!isNonEmptyString(requestId)) throw new Error('markRunning: requestId 必填');
  const r = db
    .prepare(`UPDATE bridge_actions SET state = 'running', started_at = ? WHERE request_id = ? AND state = 'queued'`)
    .run(startedAt, requestId);
  return r.changes > 0;
}

/**
 * running → 终态（completed | failed | cancelled | interrupted）。
 * @param {object} opts
 * @param {string} [opts.error]
 * @param {unknown} [opts.result] 任意可 JSON 序列化的结果
 * @param {string} [opts.executionId] Runtime 侧执行标识回填
 */
export function markTerminal(db, requestId, state, opts = {}) {
  if (!isNonEmptyString(requestId)) throw new Error('markTerminal: requestId 必填');
  if (!TERMINAL_STATES.includes(state)) throw new Error(`markTerminal: state 必须是终态，收到 ${String(state)}`);
  const error = opts.error != null ? String(opts.error) : null;
  const resultJson = opts.result !== undefined ? JSON.stringify(opts.result) : null;
  const executionId = opts.executionId ?? null;
  const r = db
    .prepare(
      `UPDATE bridge_actions
       SET state = ?, completed_at = ?, error = ?, result_json = ?,
           execution_id = COALESCE(?, execution_id)
       WHERE request_id = ? AND state IN ('queued','running')`
    )
    .run(state, Date.now(), error, resultJson, executionId, requestId);
  return r.changes > 0;
}

/** @returns 动作行（驼峰化，args/result 已解析）| null */
export function findById(db, requestId) {
  if (!isNonEmptyString(requestId)) return null;
  const row = db.prepare(`SELECT ${COLS} FROM bridge_actions WHERE request_id = ?`).get(requestId);
  return row ? toDomain(row) : null;
}

/** 未完成行（queued | running）——重启恢复扫描用（B17）。 */
export function findUnfinished(db) {
  const rows = db
    .prepare(`SELECT ${COLS} FROM bridge_actions WHERE state IN ('queued','running') ORDER BY created_at ASC`)
    .all();
  return rows.map(toDomain);
}

/** 重启恢复：全部未完成 → interrupted（B17，不重放）。@returns 恢复条数 */
export function markInterruptedAll(db) {
  const r = db
    .prepare(
      `UPDATE bridge_actions
       SET state = 'interrupted', completed_at = ?, error = COALESCE(error, 'restart-recovery')
       WHERE state IN ('queued','running')`
    )
    .run(Date.now());
  return r.changes;
}

function toDomain(row) {
  let args = {};
  let result = null;
  try { args = JSON.parse(row.args_json || '{}'); } catch { /* 坏行保持 {} */ }
  if (row.result_json != null) {
    try { result = JSON.parse(row.result_json); } catch { result = null; }
  }
  return {
    requestId: row.request_id,
    workspaceId: row.workspace_id,
    controlSessionId: row.control_session_id,
    action: row.action,
    args,
    state: row.state,
    executionId: row.execution_id,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    memoryRevision: row.memory_revision,
    error: row.error,
    result,
  };
}

export const BRIDGE_ACTION_TERMINAL_STATES = TERMINAL_STATES;
export const BRIDGE_ACTION_UNFINISHED_STATES = UNFINISHED_STATES;
