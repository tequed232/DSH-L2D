/**
 * dsh-l2d · 会话事件分类（工具结果 / turn 结束）
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

/** 这些工具名（含 MCP 前缀）视为「角色动作」，用于上次动作回执摘要。 */
const ACTION_TOOL_RE = /l2d_(act|choreograph|emote|say|gaze|pose|set_expression|play_motion|reset|stop_keyframes|get_state)\b/;

export function isActionTool(name) {
  return ACTION_TOOL_RE.test(String(name || ''));
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
 *   - content：message.content（tool/result 里的原始内容块）
 *   - isError：message.isError
 *   - error：tool/result.data.error（结构化失败），没有就是 undefined
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
    // 结构化 error 缺失但 isError=true：按错误处理，但如实标注只有文本回执。
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

/** 事件顺序里取会话年龄（最后一条事件时间），用于 idle 判定。 */
function eventAge(events, now) {
  let lastAt = 0;
  for (const ev of events) {
    const t = Number(ev && ev.time) || 0;
    if (t > lastAt) lastAt = t;
  }
  return lastAt ? Math.max(0, now - lastAt) : null;
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
 * 汇总一个会话的事件（一次线性扫描，供规划上下文使用）。
 * @param {Array} events 已解析的 session 事件数组（按 seq 顺序）
 * @param {{ now?: number }} [options]
 * @returns {{
 *   state: string, lastEventAt: number, lastTool: object|null, pendingTool: object|null,
 *   lastTurnEnd: object|null, lastAction: object|null, hasError: boolean
 * }}
 */
export function summarizeSession(events, options = {}) {
  const now = Number(options.now) || Date.now();
  const list = Array.isArray(events) ? events : [];
  const calls = new Map(); // callId -> { name, time }
  let state = 'idle';
  let lastEventAt = 0;
  let lastTool = null;
  let pendingTool = null;
  let lastTurnEnd = null;
  let lastAction = null;
  let hasError = false;
  let sawUser = false;

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
      }
    } else if (type === 'step/start') {
      state = 'thinking';
    } else if (type === 'tool/call') {
      const callId = String(data.callId || '');
      const name = String(data.name || data.kind || '');
      calls.set(callId, { name, time });
      state = 'working';
      pendingTool = { name, callId, time };
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
      state = 'working';
    } else if (type === 'turn/end') {
      const classified = classifyTurnEnd(data.reason);
      lastTurnEnd = { ...classified, time };
      if (classified.kind === 'error') {
        state = 'error';
        hasError = true;
      } else if (classified.kind === 'completed') {
        state = 'attention';
      } else if (classified.kind === 'aborted' || classified.kind === 'interrupted') {
        state = 'idle';
      }
    }
  }

  // 与 deriveAgentState 保持同一套老化规则：2 分钟无事件降 idle；error 保留 10 分钟。
  const age = eventAge(list, now);
  if (age !== null) {
    if (state !== 'error' && age > 120000) state = 'idle';
    if (state === 'error' && age > 600000) state = 'idle';
  }
  if (!sawUser && state === 'idle') hasError = hasError && false;

  return { state, lastEventAt, lastTool, pendingTool, lastTurnEnd, lastAction, hasError };
}

function actionSummary(toolName, result) {
  const short = String(toolName || '').replace(/^mcp__[^_]+__/, '').replace(/^mcp__dsh_l2d__/, '');
  return short + ' → ' + statusLabel(result.status) + (result.code ? '（' + result.code + '）' : '');
}
