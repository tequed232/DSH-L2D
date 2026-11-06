/**
 * dsh-l2d · Workspace Task Contract（P0-B）
 *
 * 依据：docs/architecture/PHASE-2-FOUNDATION-GAP-AND-EXECUTION-PLAN.md P0-B
 * 复用 bootstrap 域既有 `tasks` 表（不另建平行事实表），经适配层对齐契约：
 *  - 契约状态 pending/processing/completed/failed/cancelled
 *    ↔ DB 状态 pending/assigned|running/done/failed/cancelled（显式双向映射，未知状态拒绝）。
 *  - v4 已为 tasks 表补列：task_type / trace_id / attempt / max_attempts /
 *    input_payload / output_payload。
 *  - 输入输出按 taskType 对应的版本化 Schema 校验；未知 taskType fail-closed。
 *  - 并发领取：UPDATE ... WHERE status='pending' 原子抢占，重复领取报 CLAIM_CONFLICT。
 *  - 失败重试：retryable 且 attempt < maxAttempts → 回到 pending；否则终态 failed。
 *  - 三类工作区（chat/learning/runtime）经契约传业务数据，不共享动作链表写权限。
 */
import { withTransaction } from './db.mjs';

const nowIso = () => new Date().toISOString();

export const WORKSPACE_IDS = ['chat', 'learning', 'runtime'];
export const CONTRACT_STATUSES = ['pending', 'processing', 'completed', 'failed', 'cancelled'];

/** 契约状态 → tasks 表状态（显式映射；assigned 为 running 的领取中间态，由 claim 内部使用）。 */
export const DB_STATUS_BY_CONTRACT = {
  pending: 'pending',
  processing: 'running',
  completed: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
};

/** tasks 表状态 → 契约状态（未知状态必须拒绝，不静默转换）。 */
export function contractStatusOfDbStatus(dbStatus) {
  const map = {
    pending: 'pending',
    assigned: 'processing',
    running: 'processing',
    done: 'completed',
    failed: 'failed',
    cancelled: 'cancelled',
  };
  if (!(dbStatus in map)) throw new Error(`contractStatusOfDbStatus: 未知任务状态 ${dbStatus}`);
  return map[dbStatus];
}

// ---------------------------------------------------------------- 操作 Schema（版本化 v1）

/**
 * 轻量 Schema DSL：'string' | 'number' | 'boolean' | 'object' | 'array' | 'string[]'
 * version 字段用于 Schema 自身演进追溯（schemaVersion 1.x）。
 */
export const OPERATION_SCHEMAS = {
  'learning.ingest_gallery': {
    schemaVersion: '1.0',
    input: { assetPaths: 'string[]', sourceId: 'string', modelCapabilityId: 'string' },
    output: { jobId: 'string', state: 'string' },
  },
  'learning.status': {
    schemaVersion: '1.0',
    input: { jobId: 'string' },
    output: { jobId: 'string', state: 'string' },
  },
  'runtime.search_and_execute': {
    schemaVersion: '1.0',
    input: { intent: 'object', modelId: 'string', requireValidated: 'boolean' },
    output: { executionId: 'string', status: 'string' },
  },
  'runtime.execution_status': {
    schemaVersion: '1.0',
    input: { executionId: 'string' },
    output: { status: 'string' },
  },
  'runtime.cancel': {
    schemaVersion: '1.0',
    input: { executionId: 'string' },
    output: { cancelled: 'boolean' },
  },
};

/** 校验 value 是否匹配轻量 Schema；返回错误信息数组（空 = 通过）。 */
export function validateAgainstSchema(value, schema) {
  const errors = [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return ['payload 必须为结构化对象（禁止自由文本承载业务数据）'];
  }
  for (const [key, type] of Object.entries(schema)) {
    const v = value[key];
    if (type === 'string[]') {
      if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) errors.push(`${key}: 需为 string[]`);
    } else if (type === 'object') {
      if (typeof v !== 'object' || v === null || Array.isArray(v)) errors.push(`${key}: 需为 object`);
    } else if (typeof v !== type) {
      errors.push(`${key}: 需为 ${type}，实际 ${v === null ? 'null' : typeof v}`);
    }
  }
  return errors;
}

// ---------------------------------------------------------------- 契约仓储

export function createTaskContract(db) {
  function rowToContract(row) {
    if (!row) return null;
    return {
      taskId: row.task_id,
      taskType: row.task_type,
      workspaceId: row.assigned_workspace,
      traceId: row.trace_id,
      status: contractStatusOfDbStatus(row.status),
      dbStatus: row.status,
      attempt: row.attempt,
      maxAttempts: row.max_attempts,
      input: row.input_payload ? JSON.parse(row.input_payload) : null,
      output: row.output_payload ? JSON.parse(row.output_payload) : null,
      error: row.error ? JSON.parse(row.error) : null,
      deadline: row.deadline,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /** 创建任务。taskType 必须为已注册操作；input 按 Schema 校验。 */
  function create({ taskId, taskType, workspaceId, input, traceId, maxAttempts = 3, deadline = null, title = '', priority = 'NORMAL' }) {
    const schema = OPERATION_SCHEMAS[taskType];
    if (!schema) {
      const err = new Error(`create: 未注册的 taskType '${taskType}'（fail-closed）`);
      err.code = 'UNKNOWN_TASK_TYPE';
      throw err;
    }
    if (!WORKSPACE_IDS.includes(workspaceId)) {
      const err = new Error(`create: 未知 workspace '${workspaceId}'`);
      err.code = 'UNKNOWN_WORKSPACE';
      throw err;
    }
    const inputErrors = validateAgainstSchema(input, schema.input);
    if (inputErrors.length > 0) {
      const err = new Error(`create: input 校验失败（${taskType}）→ ${inputErrors.join('; ')}`);
      err.code = 'INPUT_SCHEMA_INVALID';
      throw err;
    }
    const id = taskId ?? globalThis.crypto?.randomUUID?.() ?? `task-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return withTransaction(db, () => {
      db.prepare(`
        INSERT INTO tasks (task_id, assigned_workspace, task_type, trace_id, title, status,
                           attempt, max_attempts, input_payload, deadline)
        VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
      `).run(id, workspaceId, taskType, traceId ?? null, title, maxAttempts, JSON.stringify(input), deadline);
      return get(id);
    });
  }

  /** 原子领取：pending → running（DB），attempt+1。重复领取报 CLAIM_CONFLICT。 */
  function claim(taskId, worker) {
    return withTransaction(db, () => {
      const info = db.prepare(`
        UPDATE tasks SET status = 'running', attempt = attempt + 1, updated_at = ?
        WHERE task_id = ? AND status = 'pending'
      `).run(nowIso(), taskId);
      if (info.changes === 0) {
        const row = db.prepare('SELECT status FROM tasks WHERE task_id = ?').get(taskId);
        const err = new Error(`claim: 任务不可领取（当前 DB 状态 ${row?.status ?? '不存在'}）`);
        err.code = 'CLAIM_CONFLICT';
        throw err;
      }
      db.prepare('UPDATE tasks SET assigned_skill = ? WHERE task_id = ?').run(worker ?? null, taskId);
      return get(taskId);
    });
  }

  /** 完成：running → done。output 按 taskType 的 output Schema 校验。 */
  function complete(taskId, output) {
    return withTransaction(db, () => {
      const row = db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId);
      if (!row) throw new Error(`complete: 任务不存在 ${taskId}`);
      if (row.status !== 'running') {
        const err = new Error(`complete: 非法转换 ${row.status} → done`);
        err.code = 'ILLEGAL_TRANSITION';
        throw err;
      }
      const schema = OPERATION_SCHEMAS[row.task_type];
      if (schema) {
        const outputErrors = validateAgainstSchema(output ?? {}, schema.output);
        if (outputErrors.length > 0) {
          const err = new Error(`complete: output 校验失败 → ${outputErrors.join('; ')}`);
          err.code = 'OUTPUT_SCHEMA_INVALID';
          throw err;
        }
      }
      db.prepare('UPDATE tasks SET status = ?, output_payload = ?, updated_at = ? WHERE task_id = ?')
        .run('done', JSON.stringify(output ?? {}), nowIso(), taskId);
      return get(taskId);
    });
  }

  /**
   * 失败：running → failed；retryable 且 attempt < maxAttempts → 回到 pending（重试）。
   * error 结构：{ code, message, retryable, details? }。
   */
  function fail(taskId, error) {
    if (!error || typeof error.code !== 'string' || typeof error.message !== 'string' || typeof error.retryable !== 'boolean') {
      throw new Error('fail: error 必须为 { code, message, retryable, details? } 结构');
    }
    return withTransaction(db, () => {
      const row = db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId);
      if (!row) throw new Error(`fail: 任务不存在 ${taskId}`);
      if (row.status !== 'running') {
        const err = new Error(`fail: 非法转换 ${row.status} → failed`);
        err.code = 'ILLEGAL_TRANSITION';
        throw err;
      }
      const canRetry = error.retryable && row.attempt < row.max_attempts;
      const nextStatus = canRetry ? 'pending' : 'failed';
      db.prepare('UPDATE tasks SET status = ?, error = ?, updated_at = ? WHERE task_id = ?')
        .run(nextStatus, JSON.stringify({ ...error, details: error.details ?? null }), nowIso(), taskId);
      return get(taskId);
    });
  }

  /** 取消：pending/running → cancelled（终态）。 */
  function cancel(taskId, reason = null) {
    return withTransaction(db, () => {
      const row = db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId);
      if (!row) throw new Error(`cancel: 任务不存在 ${taskId}`);
      if (!['pending', 'running'].includes(row.status)) {
        const err = new Error(`cancel: 非法转换 ${row.status} → cancelled`);
        err.code = 'ILLEGAL_TRANSITION';
        throw err;
      }
      db.prepare('UPDATE tasks SET status = ?, error = COALESCE(?, error), updated_at = ? WHERE task_id = ?')
        .run('cancelled', reason ? JSON.stringify({ code: 'CANCELLED', message: reason, retryable: false }) : null, nowIso(), taskId);
      return get(taskId);
    });
  }

  function get(taskId) {
    return rowToContract(db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId));
  }

  function listByTrace(traceId) {
    return db.prepare('SELECT * FROM tasks WHERE trace_id = ? ORDER BY created_at').all(traceId).map(rowToContract);
  }

  function listByWorkspace(workspaceId, status = null) {
    const rows = status
      ? db.prepare('SELECT * FROM tasks WHERE assigned_workspace = ? AND status = ? ORDER BY created_at').all(workspaceId, DB_STATUS_BY_CONTRACT[status] ?? status)
      : db.prepare('SELECT * FROM tasks WHERE assigned_workspace = ? ORDER BY created_at').all(workspaceId);
    return rows.map(rowToContract);
  }

  return { create, claim, complete, fail, cancel, get, listByTrace, listByWorkspace };
}
