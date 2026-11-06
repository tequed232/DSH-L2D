/**
 * observer_dispatch_log 表的 Repository（SUPERVISOR-P12，P1 查重专用）。
 *
 * Outbox 纪律（SUPERVISOR-DECREE §2）：
 *  - recordDispatchPending 用 INSERT OR IGNORE 抢占：同 (workspace_id, event_id)
 *    重复投递只有第一次真的插入（返回 inserted:true）——dispatchOnce 查重的底座；
 *  - 状态推进单向：pending → dispatched（成功）| failed（失败，attempts 递增）；
 *    failed 行允许重试（重试走 markDispatched），pending 行是崩溃恢复的重放源；
 *  - 本 repo 只读写 observer_dispatch_log，不触碰其他表（隔离纪律同 bridge-repo）。
 */

const COLS = 'workspace_id, event_id, status, attempts, last_error, dispatched_at, created_at';

function assertKeys(workspaceId, eventId) {
  if (!workspaceId || typeof workspaceId !== 'string') throw new Error('observer-repo: workspaceId 必填');
  if (!eventId || typeof eventId !== 'string') throw new Error('observer-repo: eventId 必填');
}

/**
 * 登记 pending（幂等抢占）。inserted:false = 该事件已登记过，调用方不得重复调度。
 * @returns {{inserted: boolean, status: string|null}}
 */
export function recordDispatchPending(db, workspaceId, eventId, now = Date.now()) {
  assertKeys(workspaceId, eventId);
  const r = db
    .prepare(`INSERT OR IGNORE INTO observer_dispatch_log (workspace_id, event_id, status, attempts, created_at)
              VALUES (?, ?, 'pending', 0, ?)`)
    .run(workspaceId, eventId, now);
  if (r.changes > 0) return { inserted: true, status: 'pending' };
  const existing = findDispatch(db, workspaceId, eventId);
  return { inserted: false, status: existing ? existing.status : null };
}

/** @returns {{workspaceId, eventId, status, attempts, lastError, dispatchedAt, createdAt}|null} */
export function findDispatch(db, workspaceId, eventId) {
  assertKeys(workspaceId, eventId);
  const row = db
    .prepare(`SELECT ${COLS} FROM observer_dispatch_log WHERE workspace_id = ? AND event_id = ?`)
    .get(workspaceId, eventId);
  return row ? toDomain(row) : null;
}

/** pending/failed → dispatched。返回是否真的推进。 */
export function markDispatched(db, workspaceId, eventId, now = Date.now()) {
  assertKeys(workspaceId, eventId);
  const r = db
    .prepare(`UPDATE observer_dispatch_log
              SET status = 'dispatched', dispatched_at = ?, last_error = NULL
              WHERE workspace_id = ? AND event_id = ? AND status IN ('pending','failed')`)
    .run(now, workspaceId, eventId);
  return r.changes > 0;
}

/** pending → failed（调度回调抛错），attempts 递增，保留错误摘要供诊断。 */
export function markFailed(db, workspaceId, eventId, error, now = Date.now()) {
  assertKeys(workspaceId, eventId);
  const message = String(error ?? '').slice(0, 500) || 'dispatch-failed';
  const r = db
    .prepare(`UPDATE observer_dispatch_log
              SET status = 'failed', attempts = attempts + 1, last_error = ?
              WHERE workspace_id = ? AND event_id = ? AND status IN ('pending','failed')`)
    .run(message, workspaceId, eventId);
  return r.changes > 0;
}

/** 崩溃恢复重放源：全部 pending 行（按登记时间升序）。 */
export function listPending(db) {
  return db
    .prepare(`SELECT ${COLS} FROM observer_dispatch_log WHERE status = 'pending' ORDER BY created_at ASC`)
    .all()
    .map(toDomain);
}

function toDomain(row) {
  return {
    workspaceId: row.workspace_id,
    eventId: row.event_id,
    status: row.status,
    attempts: row.attempts,
    lastError: row.last_error,
    dispatchedAt: row.dispatched_at,
    createdAt: row.created_at,
  };
}
