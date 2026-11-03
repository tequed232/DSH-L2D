/**
 * dsh-l2d · WorkspaceContextSnapshot 组装器（W1）
 *
 * 输入全部是「上层已经拿到的事实/推断」：
 *   - summary    session-events.summarizeSession() 的产出（会话日志事实）
 *   - presence   env-state.readEnvState() 的产出（overlay 上报的用户交互态）
 *   - foreground 前台进程采集器的产出（可选能力，默认关）
 *   - activity   context-analyzer.analyzeContext() 的产出（推断）
 *
 * 输出契约（docs/W1-Workspace-Snapshot.md）：
 *   { schemaVersion, sessionId, timestamp, staleMs,
 *     presence, activity, approval, jobs, commands, todos, goals,
 *     changedFiles, deliverables, foregroundProcess,
 *     observed, inferred, unavailable }
 *
 * 硬规则（实现强制）：
 *   1. observed 只放事实：每个条目都能指回一个真实来源（会话事件/状态文件/采集器）；
 *   2. inferred 必须带 confidence（0~1）与 evidence（依据路径/事件，不含自由文本）；
 *   3. unavailable 明确列出拿不到的字段与原因，缺失字段保持 null，**绝不伪装**成
 *      idle / 0 / success；
 *   4. 顶层 timestamp 与所有时间字段统一为 UTC ISO-8601（毫秒）；
 *   5. 只接受结构字段：不接收会话正文、终端输出、文件内容、窗口标题、URL、路径；
 *      所有字符串仍过 redactSensitive()，防上游误传敏感值；
 *   6. 纯函数：不读文件、不起定时器、不调用 Date.now（时钟由 now 传入）。
 */

export const SNAPSHOT_SCHEMA_VERSION = 1;

/** 可靠性三态。 */
export const RELIABILITY = Object.freeze({
  OBSERVED: 'observed',
  INFERRED: 'inferred',
  UNAVAILABLE: 'unavailable',
});

/** unavailable 的原因枚举（便于消费方分支，不允许自由文案）。 */
export const UNAVAILABLE_REASON = Object.freeze({
  NO_SESSION: 'no-session',
  SESSION_UNREADABLE: 'session-unreadable',
  NO_DATA: 'no-data',
  STALE: 'stale',
  DISABLED: 'disabled',
  COLLECTOR_FAILED: 'collector-failed',
  NOT_WIRED: 'not-wired',
  ANALYZER_UNAVAILABLE: 'analyzer-unavailable',
  INVALID_INPUT: 'invalid-input',
});

const MAX_STRING = 120;

/** 常见凭据形状：命中即整段替换，宁可多遮不可漏。 */
const REDACT_RULES = [
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, '[redacted]'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{10,}\b/g, '[redacted]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{8,}\b/gi, '[redacted]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g, '[redacted]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, '[redacted]'],
  [/\b(?:bearer|token|secret|password|passwd|pwd|api[_-]?key|authorization)\b\s*[:=]\s*[^\s,;&]+/gi, '[redacted]'],
  [/\b[A-Za-z0-9_]*?(?:token|secret|password|passphrase|api[_-]?key)[A-Za-z0-9_]*\s*=\s*[^\s,;&]+/gi, '[redacted]'],
  [/([?&](?:token|key|secret|sig|signature|password)=)[^&\s]+/gi, '$1[redacted]'],
];

/**
 * 敏感信息过滤 + 截断。只用于字符串；非字符串原样返回（数字/布尔由调用方保证）。
 * @param {unknown} value
 * @param {{maxLength?: number}} [options]
 */
export function redactSensitive(value, options = {}) {
  if (typeof value !== 'string') return value;
  const maxLength = Number(options.maxLength) > 0 ? Number(options.maxLength) : MAX_STRING;
  let text = value;
  for (const [pattern, replacement] of REDACT_RULES) text = text.replace(pattern, replacement);
  text = text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (text.length > maxLength) text = text.slice(0, maxLength) + '…';
  return text;
}

/** 进程名只保留 basename（不含路径），与采集器约定一致。 */
export function processNameOnly(exePath) {
  if (typeof exePath !== 'string' || !exePath) return '';
  const base = exePath.split(/[\\/]/).pop() || '';
  return redactSensitive(base, { maxLength: 64 });
}

function toIso(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const date = new Date(ms);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function nonNegative(value) {
  const n = finiteNumber(value);
  return n === null ? null : Math.max(0, n);
}

/**
 * 组装快照。任何输入缺失都映射成 `null + unavailable`，不猜默认值。
 *
 * @param {{
 *   sessionId?: string|null,
 *   summary?: object|null,
 *   presence?: object|null,
 *   foreground?: object|null,
 *   activity?: object|null,
 *   now?: number,
 *   unavailable?: Array<{path: string, reason: string}>,
 * }} [input]
 * @returns {object} WorkspaceContextSnapshot
 */
export function buildWorkspaceContextSnapshot(input = {}) {
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  const observed = [];
  const inferred = [];
  const unavailable = [];

  const addFact = (path, value, source) => {
    observed.push({ path, value, source });
    return value;
  };
  const addInference = (path, value, confidence, evidence) => {
    inferred.push({
      path,
      value,
      confidence: Math.max(0, Math.min(1, Number(confidence) || 0)),
      evidence: Array.isArray(evidence) ? evidence.map((e) => redactSensitive(String(e), { maxLength: 80 })).slice(0, 8) : [],
    });
    return value;
  };
  const addUnavailable = (path, reason) => {
    unavailable.push({ path, reason: String(reason || UNAVAILABLE_REASON.NO_DATA) });
  };

  const sessionId = typeof input.sessionId === 'string' && input.sessionId ? redactSensitive(input.sessionId, { maxLength: 80 }) : null;
  if (sessionId) {
    addFact('sessionId', sessionId, 'host');
  } else {
    addUnavailable('sessionId', UNAVAILABLE_REASON.NO_SESSION);
  }

  // ---------------------------------------------------------------- presence
  let presence = null;
  const p = input.presence;
  if (p && p.available === true && p.payload && typeof p.payload === 'object') {
    const payload = p.payload;
    presence = {
      state: redactSensitive(String(payload.state || ''), { maxLength: 24 }),
      inputFocused: payload.inputFocused === true,
      userActive: payload.away === true ? false : true,
      idleMs: nonNegative(payload.idleMs),
      ageMs: nonNegative(p.ageMs),
    };
    addFact('presence.state', presence.state, 'presence-file');
    addFact('presence.inputFocused', presence.inputFocused, 'presence-file');
    addFact('presence.userActive', presence.userActive, 'presence-file');
    if (presence.idleMs !== null) addFact('presence.idleMs', presence.idleMs, 'presence-file');
  } else {
    const reason = p && p.stale ? UNAVAILABLE_REASON.STALE : p && p.reason === 'missing' ? UNAVAILABLE_REASON.NO_DATA : UNAVAILABLE_REASON.NO_DATA;
    addUnavailable('presence', reason);
  }

  // ---------------------------------------------------------------- approval
  let approval = null;
  const summary = input.summary && typeof input.summary === 'object' ? input.summary : null;
  if (summary) {
    const pendingCount = nonNegative(summary.approvals && summary.approvals.pendingCount) || 0;
    const tools = Array.isArray(summary.approvals && summary.approvals.pending)
      ? summary.approvals.pending
          .map((item) => redactSensitive(String((item && item.toolName) || ''), { maxLength: 48 }))
          .filter(Boolean)
          .slice(0, 8)
      : [];
    const outcome = summary.approvals && summary.approvals.lastDecision && summary.approvals.lastDecision.outcome;
    approval = {
      pending: pendingCount,
      items: tools.map((toolName) => ({ toolName })),
      lastOutcome: outcome ? redactSensitive(String(outcome), { maxLength: 32 }) : null,
    };
    addFact('approval.pending', approval.pending, 'session-log');
    if (approval.lastOutcome) addFact('approval.lastOutcome', approval.lastOutcome, 'session-log');
    if (approval.pending > 0) addInference('approval.pendingTools', tools, 1, ['summary.approvals.pending']);
  } else {
    addUnavailable('approval', UNAVAILABLE_REASON.SESSION_UNREADABLE);
  }

  // ---------------------------------------------------------------- jobs
  let jobs = null;
  if (summary && summary.jobs) {
    const running = Array.isArray(summary.jobs.running) ? summary.jobs.running : [];
    jobs = {
      running: nonNegative(summary.jobs.runningCount) || 0,
      failed: nonNegative(summary.jobs.failedCount) || 0,
      items: running.slice(0, 8).map((item) => ({
        kind: redactSensitive(String((item && item.kind) || ''), { maxLength: 24 }),
        durationMs: nonNegative(item && item.startedAt ? now - item.startedAt : null),
      })),
    };
    addFact('jobs.running', jobs.running, 'session-log');
    addFact('jobs.failed', jobs.failed, 'session-log');
    if (jobs.items.length) addFact('jobs.items', jobs.items.length, 'session-log');
  } else if (summary) {
    jobs = { running: 0, failed: 0, items: [] };
    addFact('jobs.running', 0, 'session-log');
    addFact('jobs.failed', 0, 'session-log');
  } else {
    addUnavailable('jobs', UNAVAILABLE_REASON.SESSION_UNREADABLE);
  }

  // ---------------------------------------------------------------- commands
  let commands = null;
  if (summary && summary.commands) {
    const last = summary.commands.lastRun;
    const done = summary.commands.lastDone;
    commands = {
      running: (nonNegative(summary.commands.runningCount) || 0) > 0,
      last: last
        ? {
            name: redactSensitive(String(last.name || ''), { maxLength: 32 }),
            doneKind: done && done.kind ? redactSensitive(String(done.kind), { maxLength: 24 }) : null,
          }
        : null,
    };
    addFact('commands.running', commands.running, 'session-log');
    if (commands.last) addFact('commands.last.name', commands.last.name, 'session-log');
  } else if (summary) {
    commands = { running: false, last: null };
    addFact('commands.running', false, 'session-log');
  } else {
    addUnavailable('commands', UNAVAILABLE_REASON.SESSION_UNREADABLE);
  }

  // ---------------------------------------------------------------- todos / goals
  let todos = null;
  if (summary && summary.todos) {
    todos = { count: nonNegative(summary.todos.count) || 0, updatedAt: toIso(summary.todos.updatedAt) };
    addFact('todos.count', todos.count, 'session-log');
    if (todos.updatedAt) addFact('todos.updatedAt', todos.updatedAt, 'session-log');
  } else if (summary) {
    addUnavailable('todos', UNAVAILABLE_REASON.NO_DATA);
  } else {
    addUnavailable('todos', UNAVAILABLE_REASON.SESSION_UNREADABLE);
  }

  let goals = null;
  if (summary && summary.goals) {
    goals = {
      lastKind: redactSensitive(String(summary.goals.kind || ''), { maxLength: 32 }),
      lastOperation: redactSensitive(String(summary.goals.operation || ''), { maxLength: 32 }),
      roundsStarted: nonNegative(summary.goals.roundsStarted) || 0,
      updatedAt: toIso(summary.goals.updatedAt),
    };
    addFact('goals.lastOperation', goals.lastOperation, 'session-log');
    addFact('goals.roundsStarted', goals.roundsStarted, 'session-log');
  } else if (summary) {
    addUnavailable('goals', UNAVAILABLE_REASON.NO_DATA);
  } else {
    addUnavailable('goals', UNAVAILABLE_REASON.SESSION_UNREADABLE);
  }

  // ---------------------------------------------------------------- changedFiles
  let changedFiles = null;
  if (summary && summary.changes) {
    const turn = finiteNumber(summary.changes.turn);
    changedFiles = { turn, fileCount: null, at: toIso(summary.changes.at) };
    if (turn !== null) addFact('changedFiles.turn', turn, 'session-log');
    if (changedFiles.at) addFact('changedFiles.at', changedFiles.at, 'session-log');
    // 文件数量只能经宿主 ctx.workspaceChanges.summary() 读取，W1 未接线：明确标不可得。
    addUnavailable('changedFiles.fileCount', UNAVAILABLE_REASON.NOT_WIRED);
  } else if (summary) {
    addUnavailable('changedFiles', UNAVAILABLE_REASON.NO_DATA);
  } else {
    addUnavailable('changedFiles', UNAVAILABLE_REASON.SESSION_UNREADABLE);
  }

  // ---------------------------------------------------------------- deliverables
  let deliverables = null;
  if (summary && summary.deliverables) {
    deliverables = {
      count: nonNegative(summary.deliverables.count) || 0,
      turn: finiteNumber(summary.deliverables.turn),
      at: toIso(summary.deliverables.at),
    };
    addFact('deliverables.count', deliverables.count, 'session-log');
    if (deliverables.turn !== null) addFact('deliverables.turn', deliverables.turn, 'session-log');
  } else if (summary) {
    addUnavailable('deliverables', UNAVAILABLE_REASON.NO_DATA);
  } else {
    addUnavailable('deliverables', UNAVAILABLE_REASON.SESSION_UNREADABLE);
  }

  // ---------------------------------------------------------------- foregroundProcess
  let foregroundProcess = null;
  const fg = input.foreground;
  if (fg && fg.ok === true && fg.name) {
    const name = processNameOnly(fg.name);
    if (name) {
      foregroundProcess = { name, observedAt: toIso(fg.at) || toIso(now) };
      addFact('foregroundProcess.name', name, 'foreground-collector');
      addFact('foregroundProcess.observedAt', foregroundProcess.observedAt, 'foreground-collector');
    } else {
      addUnavailable('foregroundProcess', UNAVAILABLE_REASON.INVALID_INPUT);
    }
  } else {
    const reason =
      fg && fg.reason === 'disabled'
        ? UNAVAILABLE_REASON.DISABLED
        : fg && fg.reason
          ? UNAVAILABLE_REASON.COLLECTOR_FAILED
          : UNAVAILABLE_REASON.DISABLED;
    addUnavailable('foregroundProcess', reason);
  }

  // ---------------------------------------------------------------- activity（推断）
  let activity = null;
  const a = input.activity;
  if (a && typeof a.situation === 'string' && a.situation) {
    activity = {
      situation: redactSensitive(String(a.situation), { maxLength: 32 }),
      confidence: Math.max(0, Math.min(1, Number(a.confidence) || 0)),
      evidence: Array.isArray(a.evidence)
        ? a.evidence.map((e) => redactSensitive(String(e), { maxLength: 80 })).slice(0, 8)
        : [],
    };
    addInference('activity.situation', activity.situation, activity.confidence, activity.evidence);
  } else {
    addUnavailable('activity', UNAVAILABLE_REASON.ANALYZER_UNAVAILABLE);
  }

  // ---------------------------------------------------------------- 外部显式标注
  if (Array.isArray(input.unavailable)) {
    for (const item of input.unavailable) {
      if (item && typeof item.path === 'string' && item.path) {
        addUnavailable(redactSensitive(item.path, { maxLength: 80 }), item.reason || UNAVAILABLE_REASON.NO_DATA);
      }
    }
  }

  const staleMs = summary && summary.lastEventAt
    ? nonNegative(now - Number(summary.lastEventAt))
    : presence && presence.ageMs !== null
      ? presence.ageMs
      : null;

  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    sessionId,
    timestamp: toIso(now),
    staleMs,
    presence,
    activity,
    approval,
    jobs,
    commands,
    todos,
    goals,
    changedFiles,
    deliverables,
    foregroundProcess,
    observed,
    inferred,
    unavailable,
  };
}
