/**
 * dsh-l2d · 会话事件分类（工具结果 / turn 结束 / W1 工作区事件）
 *
 * 只读解析 DSH 的 session 事件（tool/call、tool/result、turn/end、user/message…），
 * 给规划层提供「真实回执字段」而不是靠模型文本猜测：
 *
 *   1. 结构化失败：tool/result.data.error = { name, code }
 *      - AbortError / ABORTED            → 中断（用户取消、steer、hook）
 *      - ToolTimeoutError / TOOL_TIMEOUT → 工具调用超时
 *      - 其余 code                       → 报错（保留原名/码，如 SANDBOX_UNAVAILABLE）
 *   2. 非错误但失败：bash/pwsh 的退出码非零不是 isError，而是渲染文本里的
 *      `[exit code: N]`；执行器超时被 kill 时是 `[timed out after Nms]`；
 *      超时转后台是 `[still running after Nms; moved to background job X]`；
 *      被停止是 `[stopped: reason]`；被信号杀是 `[killed by signal: SIG]`；
 *      沙箱拒绝是 `[sandbox: …]`。这些标记由工具渲染层（dsh-tool-bash
 *      renderResult / dsh-tool-pwsh 同构）确定性地生成，属于回执协议的一部分，
 *      不是自由文本。
 *   3. W1 扩展事件（全部是 DSH 已持久化的事件类型，见 docs/W1-Workspace-Snapshot.md）：
 *      approval/asked|decided、job/registered|settled、command/run|done、
 *      todo/write、goal/change、workspace/changes、deliverables/presented、
 *      compaction/*、session/title。它们只产结构字段，不读自由文本。
 *
 * 只有一套扫描（summarizeSession），index.js 的旧 getAgentState 通过
 * legacyAgentState() 适配到原返回形状，避免两套老化规则漂移。
 *
 * 这些函数是纯函数，输入是已解析的事件数组（或单条事件），不碰 IO，便于单测。
 */

/** 归一化后的工具结果状态。 */
export const TOOL_STATUS = Object.freeze({
  OK: 'ok',
  ERROR: 'error',
  TIMEOUT: 'timeout',
  INTERRUPTED: 'interrupted',
  NONZERO: 'nonzero-exit',
  RUNNING: 'running',
});

const STATUS_LABEL = Object.freeze({
  [TOOL_STATUS.OK]: '成功',
  [TOOL_STATUS.ERROR]: '报错',
  [TOOL_STATUS.TIMEOUT]: '超时',
  [TOOL_STATUS.INTERRUPTED]: '中断',
  [TOOL_STATUS.NONZERO]: '非零退出',
  [TOOL_STATUS.RUNNING]: '进行中',
});

export function statusLabel(status) {
  return STATUS_LABEL[status] || '未知';
}

/** 子态：主状态之外的「在等谁」信息（不新增主状态，兼容现有编排层）。 */
export const SESSION_SUBSTATE = Object.freeze({
  WAITING_APPROVAL: 'waiting-approval',
  WAITING_ANSWER: 'waiting-answer',
});

/** 老化阈值（可被 options.thresholds 覆盖；W1 起不再写死在扫描里）。 */
export const DEFAULT_SESSION_THRESHOLDS = Object.freeze({
  idleAfterMs: 120000,
  errorHoldMs: 600000,
  waitingHoldMs: 600000,
  recentToolLimit: 12,
  maxApprovals: 20,
  maxJobs: 20,
  maxCommands: 20,
});

/** 合并并校验外部阈值（非法值回退默认，避免 0 变成"立即 idle"的意外）。 */
export function normalizeThresholds(thresholds) {
  const out = { ...DEFAULT_SESSION_THRESHOLDS };
  const input = thresholds && typeof thresholds === 'object' ? thresholds : {};
  for (const key of Object.keys(DEFAULT_SESSION_THRESHOLDS)) {
    const value = Number(input[key]);
    if (Number.isFinite(value) && value >= 0) out[key] = value;
  }
  return out;
}

/** 这些工具名（含 MCP 前缀）视为「角色动作」，用于上次动作回执摘要。 */
const ACTION_TOOL_RE = /l2d_(act|choreograph|emote|say|gaze|pose|set_expression|play_motion|reset|stop_keyframes|get_state)\b/;

export function isActionTool(name) {
  return ACTION_TOOL_RE.test(String(name || ''));
}

/** ask_user 系列工具（在途 = 等用户回答，子态 waiting-answer）。 */
const ASK_USER_RE = /(?:^|__)ask_user(?:_question)?$/;

export function isAskUserTool(name) {
  return ASK_USER_RE.test(String(name || ''));
}

/** job/settled.status 里视为失败的值（不知道全部枚举，只做保守匹配）。 */
const JOB_FAILURE_RE = /fail|error|cancel|timeout|abort/i;

/** 文本块 → 短文本（只用于既有 getAgentState 的展示字段，不进 W1 快照）。 */
export function extractText(value, limit = 90) {
  if (!value) return '';
  if (typeof value === 'string') return value.slice(0, limit);
  if (Array.isArray(value)) {
    for (const part of value) {
      const text = part && typeof part.text === 'string' ? part.text : '';
      if (text) return text.slice(0, limit);
    }
  }
  return '';
}

function textOfContent(content) {
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const item of content) {
    if (item && item.type === 'text' && typeof item.text === 'string') parts.push(item.text);
  }
  return parts.join('\n');
}

/**
 * 从工具渲染文本里提取机器标记（bash/pwsh 回执协议）。
 * 只认确定性标记，不猜自然语言。
 */
export function parseToolMarkers(text) {
  const out = { timedOut: false, promotedJobId: null, stopped: null, killedSignal: null, exitCode: null, sandbox: null };
  const s = String(text || '');
  const timed = /\[timed out after \d+ms\]/.exec(s);
  if (timed) out.timedOut = true;
  const promoted = /\[still running after \d+ms; moved to background job ([^\]\s]+)\]/.exec(s);
  if (promoted) out.promotedJobId = promoted[1];
  const stopped = /\[stopped: ([^\]\n]+)\]/.exec(s);
  if (stopped) out.stopped = stopped[1].trim();
  const killed = /\[killed by signal: ([^\]\n]+)\]/.exec(s);
  if (killed) out.killedSignal = killed[1].trim();
  const exit = /\[exit code: (\d+)\]/.exec(s);
  if (exit) out.exitCode = Number(exit[1]);
  const sandbox = /\[sandbox: ([^\]]+)\]/.exec(s);
  if (sandbox) out.sandbox = sandbox[1].trim();
  return out;
}

/**
 * 归一化文本标记 → 状态。
 * 优先级：超时 > 被停止 > 被信号 > 转后台（仍算超时）> 沙箱拒绝 > 非零退出 > 成功。
 */
export function classifyToolMarkers(text) {
  const m = parseToolMarkers(text);
  if (m.timedOut) return { status: TOOL_STATUS.TIMEOUT, code: 'EXEC_TIMEOUT', marker: 'timed-out' };
  if (m.stopped) return { status: TOOL_STATUS.INTERRUPTED, code: 'STOPPED', marker: 'stopped', detail: m.stopped };
  if (m.killedSignal) return { status: TOOL_STATUS.INTERRUPTED, code: 'SIGNAL', marker: 'killed', detail: m.killedSignal };
  if (m.promotedJobId) {
    return { status: TOOL_STATUS.TIMEOUT, code: 'PROMOTED', marker: 'promoted', detail: m.promotedJobId };
  }
  if (m.sandbox) return { status: TOOL_STATUS.ERROR, code: 'SANDBOX', marker: 'sandbox', detail: m.sandbox };
  if (m.exitCode !== null) {
    return { status: TOOL_STATUS.NONZERO, code: 'EXIT_CODE', marker: 'exit-code', detail: String(m.exitCode) };
  }
  return { status: TOOL_STATUS.OK, code: null, marker: null };
}

/**
 * 分类一条 tool/result。
 * @param {{ content?: Array, isError?: boolean, error?: {name?: string, code?: string}, toolName?: string }} input
 * @returns {{ status: string, code: string|null, tool: string, isError: boolean, detail?: string, marker?: string }}
 */
export function classifyToolResult(input = {}) {
  const tool = String(input.toolName || '');
  const text = textOfContent(input.content);
  const error = input.error && typeof input.error === 'object' ? input.error : null;
  const isError = input.isError === true || !!error;

  if (error) {
    const code = typeof error.code === 'string' ? error.code : '';
    const name = typeof error.name === 'string' ? error.name : '';
    if (code === 'ABORTED' || name === 'AbortError') {
      return { status: TOOL_STATUS.INTERRUPTED, code: code || 'ABORTED', tool, isError: true, detail: 'tool call aborted', marker: 'aborted' };
    }
    if (code === 'TOOL_TIMEOUT' || name === 'ToolTimeoutError') {
      return { status: TOOL_STATUS.TIMEOUT, code: code || 'TOOL_TIMEOUT', tool, isError: true, detail: 'tool call timed out', marker: 'tool-timeout' };
    }
    return { status: TOOL_STATUS.ERROR, code: code || name || 'ERROR', tool, isError: true };
  }

  const byMarker = classifyToolMarkers(text);
  if (isError && byMarker.status === TOOL_STATUS.OK) {
    return { status: TOOL_STATUS.ERROR, code: 'IS_ERROR', tool, isError: true, marker: 'is-error' };
  }
  return { ...byMarker, tool, isError };
}

/** 从 turn/end 的 data.reason 分类。真实取值见会话日志：completed / error / aborted / interrupted。 */
export function classifyTurnEnd(reason) {
  const r = reason && typeof reason === 'object' ? reason : {};
  const kind = typeof r.kind === 'string' ? r.kind : 'unknown';
  const error = r.error && typeof r.error === 'object' ? r.error : null;
  const code = error && typeof error.code === 'string' ? error.code : null;
  const message = error && typeof error.message === 'string' ? error.message.slice(0, 200) : '';
  if (kind === 'error') return { kind: 'error', code: code || 'TURN_ERROR', detail: message };
  if (kind === 'aborted') {
    const why = r.reason && typeof r.reason.kind === 'string' ? r.reason.kind : 'unknown';
    return { kind: 'aborted', code: 'ABORTED', detail: why };
  }
  if (kind === 'interrupted') return { kind: 'interrupted', code: 'INTERRUPTED' };
  if (kind === 'completed') return { kind: 'completed', code: null, detail: null };
  return { kind: 'unknown', code: code || null, detail: message || null };
}

const STATE_RANK = Object.freeze({ error: 5, attention: 4, working: 3, thinking: 2, idle: 1, unknown: 0 });

export function stateRank(state) {
  return STATE_RANK[state] ?? 0;
}

/** 多个工作区聚合：取最「需要关注」的状态。 */
export function aggregateState(states) {
  let best = 'unknown';
  for (const state of states) {
    if (stateRank(state) > stateRank(best)) best = state;
  }
  return best;
}

/**
 * 老化：只按「最近事件时间」降级，阈值可配。
 * waiting-* 子态在等待期内不把状态降成 idle（等审批/等回答是合法停留），
 * 超过 waitingHoldMs 才清掉子态并按常规老化。
 *
 * @param {{state?: string, substate?: string|null, lastEventAt?: number}} input
 * @param {{now?: number, thresholds?: object}} [options]
 * @returns {{state: string, substate: string|null, ageMs: number|null}}
 */
export function ageSummaryState(input = {}, options = {}) {
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const thresholds = normalizeThresholds(options.thresholds);
  let state = typeof input.state === 'string' && input.state ? input.state : 'idle';
  let substate = input.substate || null;
  const lastEventAt = Number(input.lastEventAt) || 0;
  const ageMs = lastEventAt ? Math.max(0, now - lastEventAt) : null;

  // 无时间戳（lastEventAt=0）无法判断新鲜度：一律视为陈旧，强制 idle 并清子态，
  // 避免 working/waiting-* 在「时间未知」的会话里永久冻结。
  if (ageMs === null) {
    return { state: 'idle', substate: null, ageMs: null };
  }

  if (substate && ageMs !== null && ageMs <= thresholds.waitingHoldMs) {
    return { state, substate, ageMs };
  }
  if (substate && ageMs !== null) substate = null;

  if (ageMs !== null) {
    if (state === 'error') {
      if (ageMs > thresholds.errorHoldMs) state = 'idle';
    } else if (ageMs > thresholds.idleAfterMs) {
      state = 'idle';
    }
  }
  if (state === 'idle') substate = null;
  return { state, substate, ageMs };
}

/**
 * 汇总一个会话的事件（一次线性扫描，供规划上下文 / W1 快照使用）。
 * @param {Array} events 已解析的 session 事件数组（按 seq 顺序）
 * @param {{ now?: number, thresholds?: object }} [options]
 */
export function summarizeSession(events, options = {}) {
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const thresholds = normalizeThresholds(options.thresholds);
  const list = Array.isArray(events) ? events : [];

  const calls = new Map(); // callId -> { name, time }
  const approvals = new Map(); // id -> { id, toolName, callId, reason, time }
  const jobs = new Map(); // jobId -> { jobId, owner, kind, label, startedAt, time }
  const commands = new Map(); // commandId -> { commandId, name, time }
  const recentTools = [];

  let state = 'idle';
  let lastEventAt = 0;
  let lastTool = null;
  let lastToolName = '';
  let pendingTool = null;
  let lastTurnEnd = null;
  let lastAction = null;
  let hasError = false;
  let sawUser = false;
  let lastUserText = '';
  let lastAssistantText = '';
  let lastError = '';
  let lastApprovalDecision = null;
  let lastJobSettled = null;
  let jobSettledCount = 0;
  let jobFailedCount = 0;
  let lastCommandRun = null;
  let lastCommandDone = null;
  let todos = null;
  let goals = null;
  let changes = null;
  let deliverables = null;
  let compaction = null;
  let title = '';

  for (const ev of list) {
    const type = ev && ev.type ? String(ev.type) : '';
    const data = ev && ev.data && typeof ev.data === 'object' ? ev.data : {};
    const time = Number(ev && ev.time) || 0;
    if (time > lastEventAt) lastEventAt = time;

    if (type === 'user/message') {
      const src = data.source && typeof data.source === 'object' ? data.source : null;
      if (!src || src.kind !== 'user-approval') {
        state = 'thinking';
        sawUser = true;
        const text = extractText(data.content || data.message?.content);
        if (text) lastUserText = text;
      }
    } else if (type === 'step/start') {
      state = 'thinking';
    } else if (type === 'assistant/message') {
      state = 'thinking';
      const text = extractText(data.message?.content);
      if (text) lastAssistantText = text;
    } else if (type === 'tool/call') {
      const callId = String(data.callId || '');
      const name = String(data.name || data.kind || '');
      calls.set(callId, { name, time });
      state = 'working';
      pendingTool = { name, callId, time };
      lastToolName = name;
    } else if (type === 'tool/result') {
      const message = data.message && typeof data.message === 'object' ? data.message : {};
      const callId = String(message.toolCallId || message.source?.callId || '');
      const call = calls.get(callId);
      const toolName = call ? call.name : '';
      const result = classifyToolResult({
        content: message.content,
        isError: message.isError === true,
        error: data.error,
        toolName,
      });
      const entry = {
        name: toolName,
        callId,
        status: result.status,
        code: result.code,
        detail: result.detail || null,
        time,
      };
      lastTool = entry;
      recentTools.push({ name: toolName, status: result.status, code: result.code, time });
      if (recentTools.length > thresholds.recentToolLimit) recentTools.splice(0, recentTools.length - thresholds.recentToolLimit);
      if (pendingTool && pendingTool.callId === callId) pendingTool = null;
      if (result.status === TOOL_STATUS.ERROR) hasError = true;
      if (isActionTool(toolName)) {
        lastAction = {
          name: toolName,
          status: result.status,
          code: result.code,
          detail: result.detail || null,
          summary: actionSummary(toolName, result),
          time,
        };
      }
      // 审批单在对应工具调用结束时视为已消费（即使 approval/decided 丢了）。
      if (callId) {
        for (const [id, item] of approvals) {
          if (item.callId && item.callId === callId) approvals.delete(id);
        }
      }
      state = 'working';
    } else if (type === 'turn/end') {
      const classified = classifyTurnEnd(data.reason);
      lastTurnEnd = { ...classified, time };
      if (classified.kind === 'error') {
        state = 'error';
        hasError = true;
        lastError = classified.detail || 'unknown error';
      } else if (classified.kind === 'completed') {
        state = 'attention';
      } else if (classified.kind === 'aborted' || classified.kind === 'interrupted') {
        state = 'idle';
      }
    } else if (type === 'approval/asked') {
      const id = String(data.id || '');
      if (id) {
        approvals.set(id, {
          id,
          toolName: String(data.toolName || ''),
          callId: String(data.callId || ''),
          reason: String(data.reason || '').slice(0, 200),
          time,
        });
      }
      if (state === 'idle' || state === 'unknown') state = 'working';
    } else if (type === 'approval/decided') {
      const id = String(data.id || '');
      approvals.delete(id);
      lastApprovalDecision = {
        id,
        outcome: typeof data.outcome === 'string' ? data.outcome : String(data.outcome || ''),
        time,
      };
    } else if (type === 'job/registered') {
      const jobId = String(data.jobId || '');
      if (!jobId) continue;
      jobs.set(jobId, {
        jobId,
        owner: String(data.owner || ''),
        kind: String(data.kind || ''),
        label: String(data.label || '').slice(0, 200),
        startedAt: Number(data.startedAt) || time,
        time,
      });
    } else if (type === 'job/settled') {
      const jobId = String(data.jobId || '');
      jobs.delete(jobId);
      const status = String(data.status || '');
      jobSettledCount++;
      if (JOB_FAILURE_RE.test(status)) jobFailedCount++;
      lastJobSettled = {
        jobId,
        kind: String(data.kind || ''),
        status,
        cause: String(data.cause || ''),
        startedAt: Number(data.startedAt) || null,
        finishedAt: Number(data.finishedAt) || time,
        time,
      };
    } else if (type === 'command/run') {
      const commandId = String(data.commandId || '');
      if (!commandId) continue;
      const name = String(data.name || '');
      commands.set(commandId, { commandId, name, time });
      lastCommandRun = { commandId, name, time };
    } else if (type === 'command/done') {
      const commandId = String(data.commandId || '');
      commands.delete(commandId);
      lastCommandDone = { commandId, kind: String(data.kind || ''), time };
    } else if (type === 'todo/write') {
      const items = Array.isArray(data.todos) ? data.todos : [];
      todos = { count: items.length, updatedAt: time };
    } else if (type === 'goal/change') {
      goals = {
        kind: String(data.kind || ''),
        operation: String(data.operation || ''),
        roundsStarted: Number(data.roundsStarted) || 0,
        version: Number(data.version) || 0,
        updatedAt: Number(data.updatedAt) || time,
        at: time,
      };
    } else if (type === 'workspace/changes') {
      const turn = Number(data.turn);
      changes = { turn: Number.isFinite(turn) ? turn : null, at: time };
    } else if (type === 'deliverables/presented') {
      const files = Array.isArray(data.files) ? data.files : [];
      deliverables = {
        count: files.length,
        turn: Number(data.turn) || null,
        callId: String(data.callId || ''),
        at: time,
      };
    } else if (type === 'compaction/start') {
      compaction = { inProgress: true, startedAt: time, lastAt: time, count: compaction ? compaction.count : 0 };
    } else if (type === 'compaction/end') {
      compaction = {
        inProgress: false,
        startedAt: compaction ? compaction.startedAt : null,
        endedAt: time,
        lastAt: time,
        count: (compaction ? compaction.count : 0) + 1,
      };
    } else if (type === 'compaction/summary' || type === 'compaction/prune') {
      if (compaction) compaction.lastAt = time;
    } else if (type === 'session/title') {
      const t = typeof data.title === 'string' ? data.title : '';
      if (t) title = t.slice(0, 80);
    }
  }

  const pendingList = [...approvals.values()].sort((a, b) => a.time - b.time).slice(-thresholds.maxApprovals);
  const runningJobs = [...jobs.values()]
    .sort((a, b) => (a.startedAt || a.time) - (b.startedAt || b.time))
    .slice(-thresholds.maxJobs);
  const runningCommands = [...commands.values()].slice(-thresholds.maxCommands);

  let substate = null;
  if (pendingList.length) substate = SESSION_SUBSTATE.WAITING_APPROVAL;
  else if (pendingTool && isAskUserTool(pendingTool.name)) substate = SESSION_SUBSTATE.WAITING_ANSWER;

  const aged = ageSummaryState({ state, substate, lastEventAt }, { now, thresholds });
  state = aged.state;
  substate = aged.substate;

  // 兼容旧 deriveAgentState：没有用户消息又已 idle 时，错误标记不再有意义。
  if (!sawUser && state === 'idle') hasError = false;

  return {
    state,
    substate,
    lastEventAt,
    ageMs: aged.ageMs,
    lastTool,
    lastToolName,
    pendingTool,
    lastTurnEnd,
    lastAction,
    hasError,
    lastUserText,
    lastAssistantText,
    lastError,
    title,
    approvals: {
      pendingCount: pendingList.length,
      pending: pendingList,
      lastDecision: lastApprovalDecision,
    },
    jobs: {
      runningCount: runningJobs.length,
      running: runningJobs,
      settledCount: jobSettledCount,
      failedCount: jobFailedCount,
      lastSettled: lastJobSettled,
    },
    commands: {
      runningCount: runningCommands.length,
      running: runningCommands,
      lastRun: lastCommandRun,
      lastDone: lastCommandDone,
    },
    todos,
    goals,
    changes,
    deliverables,
    compaction,
    recentTools,
    thresholds,
  };
}

/**
 * 把 W1 汇总适配成 index.js 旧 getAgentState 的返回形状（保持 overlay 契约不变）。
 * 注意：aborted/interrupted 的 turn 在旧实现里显示 attention，这里保留该行为。
 *
 * @param {ReturnType<typeof summarizeSession>} summary
 * @param {{ ageMs?: number, workspace?: string, thresholds?: object }} [options]
 */
export function legacyAgentState(summary, options = {}) {
  const thresholds = normalizeThresholds(options.thresholds);
  const ageMs = Number.isFinite(Number(options.ageMs))
    ? Math.max(0, Math.round(Number(options.ageMs)))
    : Math.max(0, Math.round(Number(summary && summary.ageMs) || 0));
  let state = summary && summary.state ? summary.state : 'idle';
  const turn = summary && summary.lastTurnEnd ? summary.lastTurnEnd : null;
  const age = summary && summary.ageMs != null ? summary.ageMs : null;
  if (
    turn &&
    (turn.kind === 'aborted' || turn.kind === 'interrupted') &&
    age !== null &&
    age <= thresholds.idleAfterMs
  ) {
    state = 'attention';
  }
  return {
    ok: true,
    state,
    workspace: options.workspace || null,
    ageMs,
    lastUserText: (summary && summary.lastUserText) || '',
    lastTool: (summary && summary.lastToolName) || '',
    lastAssistantText: (summary && summary.lastAssistantText) || '',
    lastError: (summary && summary.lastError) || '',
    lastEventAt: (summary && summary.lastEventAt) || 0,
  };
}

function actionSummary(toolName, result) {
  const short = String(toolName || '').replace(/^mcp__[^_]+__/, '').replace(/^mcp__dsh_l2d__/, '');
  return short + ' → ' + statusLabel(result.status) + (result.code ? '（' + result.code + '）' : '');
}
