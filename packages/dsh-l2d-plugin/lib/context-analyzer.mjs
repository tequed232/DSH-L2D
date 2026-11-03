/**
 * dsh-l2d · Context Analyzer 初版（W1）
 *
 * 把「事实」（会话事件汇总、用户交互态、可选前台进程）推断成行为层可用的情境：
 *
 *   reading_code / editing_code / reviewing_changes / reading_documentation /
 *   running_command / debugging / waiting_for_approval / waiting_for_agent /
 *   agent_working / reviewing_result / task_completed / idle / away
 *   （证据不足时给 unknown，不硬猜成 idle/success）
 *
 * 约束（实现强制）：
 *   1. 纯函数、不读 IO、不调 Date.now（时钟从参数传入）；
 *   2. 每条结论带 confidence（0~1）与 evidence（来源路径/事件名/计数，不含自由文本）；
 *   3. 不靠单一关键词：能产生歧义的情境必须至少两条独立信号；
 *   4. 前台进程名是**弱信号**：`Code.exe` ≠ 用户正在写代码，本模块不会据此判 editing_code，
 *      只在 idle/unknown 的证据里注明"前台有进程，但不能据此推断编辑行为"。
 */
import { SESSION_SUBSTATE } from './session-events.mjs';

export const SITUATIONS = Object.freeze({
  READING_CODE: 'reading_code',
  EDITING_CODE: 'editing_code',
  REVIEWING_CHANGES: 'reviewing_changes',
  READING_DOCUMENTATION: 'reading_documentation',
  RUNNING_COMMAND: 'running_command',
  DEBUGGING: 'debugging',
  WAITING_FOR_APPROVAL: 'waiting_for_approval',
  WAITING_FOR_AGENT: 'waiting_for_agent',
  AGENT_WORKING: 'agent_working',
  REVIEWING_RESULT: 'reviewing_result',
  TASK_COMPLETED: 'task_completed',
  IDLE: 'idle',
  AWAY: 'away',
  UNKNOWN: 'unknown',
});

/** 工具名 → 行为类别（只按已知工具名归类，不做子串模糊匹配）。 */
const EDIT_TOOLS = new Set(['write', 'edit', 'str_replace_editor', 'apply_patch']);
const READ_TOOLS = new Set(['read', 'grep', 'glob', 'list_directory', 'search']);
const DOC_TOOLS = new Set(['web_fetch', 'web_search']);
const SHELL_TOOLS = new Set(['bash', 'pwsh', 'terminal_open', 'terminal_send', 'terminal_read', 'terminal_signal']);
const ASK_TOOLS = new Set(['ask_user_question']);
const FAILURE_STATUSES = new Set(['error', 'nonzero-exit', 'timeout', 'interrupted']);

export const DEFAULT_ANALYZER_THRESHOLDS = Object.freeze({
  taskCompletedWindowMs: 30000,
  reviewingWindowMs: 300000,
  recentToolWindowMs: 120000,
  idleAfterMs: 120000,
});

export function normalizeAnalyzerThresholds(thresholds) {
  const out = { ...DEFAULT_ANALYZER_THRESHOLDS };
  const input = thresholds && typeof thresholds === 'object' ? thresholds : {};
  for (const key of Object.keys(DEFAULT_ANALYZER_THRESHOLDS)) {
    const value = Number(input[key]);
    if (Number.isFinite(value) && value >= 0) out[key] = value;
  }
  return out;
}

function normalizeToolName(name) {
  return String(name || '')
    .replace(/^mcp__[^_]+__/, '')
    .toLowerCase();
}

function recentToolsWithin(summary, windowMs, now) {
  const tools = summary && Array.isArray(summary.recentTools) ? summary.recentTools : [];
  return tools.filter((tool) => {
    const time = Number(tool && tool.time);
    if (!Number.isFinite(time) || time <= 0) return false;
    return Math.max(0, now - time) <= windowMs;
  });
}

function hasTool(tools, names) {
  return tools.some((tool) => names.has(normalizeToolName(tool && tool.name)));
}

function evidenceOfTools(tools, names) {
  const hit = tools.filter((tool) => names.has(normalizeToolName(tool && tool.name)));
  return hit.length ? 'recentTools=' + [...new Set(hit.map((tool) => normalizeToolName(tool.name)))].join(',') : null;
}

function presenceStateOf(presence) {
  if (!presence || presence.available !== true || !presence.payload) return null;
  const state = String(presence.payload.state || '');
  return state || null;
}

/**
 * @param {{
 *   summary?: object|null,
 *   presence?: object|null,
 *   foreground?: {ok?: boolean, name?: string, at?: number}|null,
 *   now?: number,
 *   thresholds?: object,
 * }} [input]
 * @returns {{situation: string, confidence: number, evidence: string[]}}
 */
export function analyzeContext(input = {}) {
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  const t = normalizeAnalyzerThresholds(input.thresholds);
  const summary = input.summary && typeof input.summary === 'object' ? input.summary : null;
  const presenceState = presenceStateOf(input.presence);

  const evidence = [];
  const result = (situation, confidence, extra) => {
    const list = [...evidence];
    if (Array.isArray(extra)) list.push(...extra);
    return { situation, confidence: Math.max(0, Math.min(1, Number(confidence) || 0)), evidence: list.slice(0, 8) };
  };

  // 1) 离席：presence 是权威（overlay 由焦点/输入/离席判定）。
  if (presenceState === 'away') {
    evidence.push('presence.state=away');
    return result(SITUATIONS.AWAY, 0.9);
  }

  const lastEventAt = Number(summary && summary.lastEventAt) || 0;
  const ageMs = lastEventAt ? Math.max(0, now - lastEventAt) : null;
  if (summary) evidence.push('summary.state=' + String(summary.state || 'unknown'));
  if (ageMs !== null) evidence.push('agesSinceLastEvent=' + Math.round(ageMs / 1000) + 's');
  const tools = recentToolsWithin(summary, t.recentToolWindowMs, now);

  // 2) 等审批：来自 approval/asked 未配对的协议事实。
  const pendingApprovals = summary && summary.approvals ? Number(summary.approvals.pendingCount) || 0 : 0;
  if (pendingApprovals > 0) {
    evidence.push('approval.pending=' + pendingApprovals);
    return result(SITUATIONS.WAITING_FOR_APPROVAL, 0.95);
  }

  // 3) 等用户回答：在途 ask_user 工具（协议事实，不是文本关键词）。
  if (summary && summary.substate === SESSION_SUBSTATE.WAITING_ANSWER) {
    evidence.push('substate=waiting-answer');
    return result(SITUATIONS.WAITING_FOR_AGENT, 0.9);
  }

  // 4) 跑命令：在途 shell 工具，或后台 job 在跑。
  const pendingName = summary && summary.pendingTool ? normalizeToolName(summary.pendingTool.name) : '';
  const runningJobs = summary && summary.jobs ? Number(summary.jobs.runningCount) || 0 : 0;
  if (pendingName && SHELL_TOOLS.has(pendingName)) {
    evidence.push('pendingTool=' + pendingName);
    if (runningJobs > 0) evidence.push('jobs.running=' + runningJobs);
    return result(SITUATIONS.RUNNING_COMMAND, runningJobs > 0 ? 0.9 : 0.85);
  }
  if (runningJobs > 0) {
    evidence.push('jobs.running=' + runningJobs);
    return result(SITUATIONS.RUNNING_COMMAND, 0.75);
  }

  // 5) 调试：必须是「有失败证据 + 仍在活动」两条独立信号，避免单一 exit code 误判。
  const lastTool = summary && summary.lastTool ? summary.lastTool : null;
  const hadFailure = !!(
    (lastTool && FAILURE_STATUSES.has(String(lastTool.status || ''))) ||
    (summary && summary.hasError === true)
  );
  const stillActive = summary && (summary.state === 'working' || summary.state === 'thinking');
  const failureIsRecent = lastTool && Number(lastTool.time) ? Math.max(0, now - Number(lastTool.time)) <= t.recentToolWindowMs : false;
  if (hadFailure && failureIsRecent && stillActive) {
    if (lastTool) evidence.push('lastTool.status=' + String(lastTool.status || ''));
    if (summary.hasError) evidence.push('summary.hasError=true');
    return result(SITUATIONS.DEBUGGING, 0.6);
  }

  // 6) 刚完成一轮：turn/end completed 且很近（行为层最需要的"完成"时刻）。
  const turn = summary && summary.lastTurnEnd ? summary.lastTurnEnd : null;
  if (turn && turn.kind === 'completed' && ageMs !== null && ageMs <= t.taskCompletedWindowMs) {
    evidence.push('turn/end=completed');
    return result(SITUATIONS.TASK_COMPLETED, 0.9);
  }

  // 7) 编辑代码：agent 侧写工具/改动事件（强信号）。前台 Code.exe 不参与这条判断。
  const editEvidence = summary ? evidenceOfTools(tools, EDIT_TOOLS) : null;
  const changedRecently = !!(summary && summary.changes && summary.changes.at && Math.max(0, now - Number(summary.changes.at)) <= t.recentToolWindowMs);
  if (editEvidence) {
    evidence.push(editEvidence);
    if (changedRecently) evidence.push('workspace.changes.turn=' + String(summary.changes.turn));
    return result(SITUATIONS.EDITING_CODE, 0.8);
  }
  if (changedRecently && summary.state === 'working') {
    evidence.push('workspace.changes.turn=' + String(summary.changes.turn));
    evidence.push('summary.state=working');
    return result(SITUATIONS.EDITING_CODE, 0.6);
  }

  // 8) 读文档：web 检索/抓取工具（agent 侧）。
  const docEvidence = summary ? evidenceOfTools(tools, DOC_TOOLS) : null;
  if (docEvidence) {
    evidence.push(docEvidence);
    return result(SITUATIONS.READING_DOCUMENTATION, 0.7);
  }

  // 9) 读代码：只读类工具活跃。
  const readEvidence = summary ? evidenceOfTools(tools, READ_TOOLS) : null;
  if (readEvidence) {
    evidence.push(readEvidence);
    return result(SITUATIONS.READING_CODE, 0.6);
  }

  // 10) 审阅改动：有 workspace/changes、窗口内没有新的写工具，且 agent 已不在写。
  const changes = summary && summary.changes;
  if (changes && changes.at && Math.max(0, now - Number(changes.at)) <= t.reviewingWindowMs) {
    evidence.push('workspace.changes.turn=' + String(changes.turn));
    evidence.push('no-recent-edit-tools');
    return result(SITUATIONS.REVIEWING_CHANGES, 0.6);
  }

  // 11) 结果待看：turn 完成一段时间内、仍显示 attention。
  if (summary && summary.state === 'attention' && ageMs !== null && ageMs <= t.reviewingWindowMs) {
    if (summary.deliverables) evidence.push('deliverables.count=' + String(summary.deliverables.count));
    return result(SITUATIONS.REVIEWING_RESULT, 0.6);
  }

  // 12) agent 正在干活（无更具体情境时的兜底）。
  if (summary && (summary.state === 'working' || summary.state === 'thinking')) {
    return result(SITUATIONS.AGENT_WORKING, 0.7);
  }

  // 13) 空闲 / 未知：前台进程是弱信号，只写进证据，不改变结论。
  const fgName = input.foreground && input.foreground.ok === true ? String(input.foreground.name || '') : '';
  if (summary) {
    if (ageMs !== null) evidence.push('idle-threshold=' + Math.round(t.idleAfterMs / 1000) + 's');
    if (fgName) evidence.push('foreground=' + fgName + ' (weak; not proof of editing)');
    return result(SITUATIONS.IDLE, 0.7);
  }
  if (presenceState) evidence.push('presence.state=' + presenceState);
  if (fgName) evidence.push('foreground=' + fgName + ' (weak; not proof of editing)');
  return result(SITUATIONS.UNKNOWN, 0);
}
