import assert from 'node:assert/strict';
import {
  DEFAULT_SESSION_THRESHOLDS,
  SESSION_SUBSTATE,
  TOOL_STATUS,
  aggregateState,
  classifyToolMarkers,
  classifyToolResult,
  classifyTurnEnd,
  isActionTool,
  isAskUserTool,
  legacyAgentState,
  normalizeThresholds,
  parseToolMarkers,
  stateRank,
  statusLabel,
  summarizeSession,
} from './session-events.mjs';

// 1. bash/pwsh 非错误回执：靠机器标记区分退出码/超时/停止/信号（真实协议，
//    标记由 dsh-tool-bash renderResult 生成，不是模型自由文本）。
const okText = { content: [{ type: 'text', text: 'hello\nworld' }], isError: false };
assert.equal(classifyToolResult({ ...okText, toolName: 'bash' }).status, TOOL_STATUS.OK);

const exitText = { content: [{ type: 'text', text: 'boom\n[stderr]\nbad\n[exit code: 2]' }], isError: false };
const nonzero = classifyToolResult({ ...exitText, toolName: 'bash' });
assert.equal(nonzero.status, TOOL_STATUS.NONZERO);
assert.equal(nonzero.code, 'EXIT_CODE');
assert.equal(nonzero.detail, '2');

const timedOut = classifyToolResult({
  content: [{ type: 'text', text: 'partial\n[timed out after 120000ms]' }],
  isError: false,
  toolName: 'bash',
});
assert.equal(timedOut.status, TOOL_STATUS.TIMEOUT);
assert.equal(timedOut.code, 'EXEC_TIMEOUT');

const promoted = classifyToolResult({
  content: [{ type: 'text', text: '[still running after 120000ms; moved to background job job-7]\n...' }],
  isError: false,
  toolName: 'pwsh',
});
assert.equal(promoted.status, TOOL_STATUS.TIMEOUT);
assert.equal(promoted.code, 'PROMOTED');
assert.equal(promoted.detail, 'job-7');

const stopped = classifyToolResult({
  content: [{ type: 'text', text: '[stopped: tool call aborted]' }],
  isError: false,
  toolName: 'bash',
});
assert.equal(stopped.status, TOOL_STATUS.INTERRUPTED);
assert.equal(stopped.code, 'STOPPED');

const killed = classifyToolResult({
  content: [{ type: 'text', text: 'output\n[killed by signal: SIGTERM]' }],
  isError: false,
  toolName: 'bash',
});
assert.equal(killed.status, TOOL_STATUS.INTERRUPTED);
assert.equal(killed.code, 'SIGNAL');

assert.deepEqual(parseToolMarkers('x [exit code: 3] y'), { timedOut: false, promotedJobId: null, stopped: null, killedSignal: null, exitCode: 3, sandbox: null });
assert.equal(classifyToolMarkers('[sandbox: file access denied under workspace-write mode]').status, TOOL_STATUS.ERROR);

// 2. 结构化错误：data.error 是权威字段。
const aborted = classifyToolResult({
  content: [{ type: 'text', text: 'Error: tool call aborted' }],
  isError: true,
  error: { name: 'AbortError', code: 'ABORTED' },
  toolName: 'pwsh',
});
assert.equal(aborted.status, TOOL_STATUS.INTERRUPTED);
assert.equal(aborted.code, 'ABORTED');

const toolTimeout = classifyToolResult({
  content: [{ type: 'text', text: 'Error: tool call timed out after 30000ms' }],
  isError: true,
  error: { name: 'ToolTimeoutError', code: 'TOOL_TIMEOUT' },
  toolName: 'glob',
});
assert.equal(toolTimeout.status, TOOL_STATUS.TIMEOUT);

const fsError = classifyToolResult({
  content: [{ type: 'text', text: 'Error: file not found' }],
  isError: true,
  error: { name: 'FsError', code: 'FS_NOT_FOUND' },
  toolName: 'read',
});
assert.equal(fsError.status, TOOL_STATUS.ERROR);
assert.equal(fsError.code, 'FS_NOT_FOUND');

const bareError = classifyToolResult({ content: [{ type: 'text', text: 'Error: x' }], isError: true, toolName: 'x' });
assert.equal(bareError.status, TOOL_STATUS.ERROR);
assert.equal(bareError.code, 'IS_ERROR');

// 真实回执文本里同时出现 timed out 和 exit code 时，超时优先。
const both = classifyToolResult({
  content: [{ type: 'text', text: '[exit code: 1]\n[timed out after 500ms]' }],
  isError: false,
  toolName: 'bash',
});
assert.equal(both.status, TOOL_STATUS.TIMEOUT);

// 3. turn/end 分类：completed / error / aborted / interrupted。
assert.equal(classifyTurnEnd({ kind: 'completed' }).kind, 'completed');
assert.equal(classifyTurnEnd({ kind: 'error', error: { code: 'RATE_LIMIT' } }).code, 'RATE_LIMIT');
assert.equal(classifyTurnEnd({ kind: 'aborted', reason: { kind: 'user' } }).detail, 'user');
assert.equal(classifyTurnEnd({ kind: 'interrupted' }).kind, 'interrupted');
assert.equal(classifyTurnEnd(null).kind, 'unknown');

// 4. 动作工具识别。
assert.equal(isActionTool('mcp__dsh_l2d__l2d_act'), true);
assert.equal(isActionTool('l2d_choreograph'), true);
assert.equal(isActionTool('bash'), false);
assert.equal(statusLabel('timeout'), '超时');

// 5. 会话汇总：合成 fixture（与真实 session.v4.jsonl.zstd 的事件形状一致）。
const t0 = 1793627000000;
const events = [
  { type: 'session', time: t0, data: { id: 's1' } },
  { type: 'user/message', time: t0 + 1000, data: { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } } },
  { type: 'tool/call', time: t0 + 2000, data: { callId: 'c1', name: 'bash', arguments: '{"command":"sleep 1"}' } },
  {
    type: 'tool/result', time: t0 + 3000,
    data: {
      message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }], isError: false },
    },
  },
  { type: 'tool/call', time: t0 + 4000, data: { callId: 'c2', name: 'mcp__dsh_l2d__l2d_act', arguments: '{}' } },
  {
    type: 'tool/result', time: t0 + 5000,
    data: {
      message: { role: 'tool', toolCallId: 'c2', content: [{ type: 'text', text: '{"ok":true,"accepted":true,"runId":1,"events":[{"phase":"end"}]}' }], isError: false },
    },
  },
  { type: 'turn/end', time: t0 + 6000, data: { reason: { kind: 'completed' } } },
];

const summary = summarizeSession(events, { now: t0 + 7000 });
assert.equal(summary.state, 'attention');
assert.equal(summary.lastTool.name, 'mcp__dsh_l2d__l2d_act');
assert.equal(summary.lastTool.status, TOOL_STATUS.OK);
assert.equal(summary.pendingTool, null);
assert.equal(summary.lastTurnEnd.kind, 'completed');
assert.equal(summary.lastAction.name, 'mcp__dsh_l2d__l2d_act');
assert.ok(summary.lastAction.summary.includes('成功'));
assert.equal(summary.lastEventAt, t0 + 6000);
assert.equal(summary.hasError, false);

// 在途动作：只有 tool/call 没有 tool/result → pendingTool 非空（桥据此不打断）。
const pending = summarizeSession([{ type: 'tool/call', time: t0 + 100, data: { callId: 'c9', name: 'mcp__dsh_l2d__l2d_choreograph' } }], { now: t0 + 200 });
assert.equal(pending.pendingTool.name, 'mcp__dsh_l2d__l2d_choreograph');
assert.equal(pending.state, 'working');

// 错误回合：turn/end error → state error + hasError。
const errored = summarizeSession([
  { type: 'tool/call', time: t0, data: { callId: 'e1', name: 'bash' } },
  { type: 'tool/result', time: t0 + 10, data: { message: { toolCallId: 'e1', content: [{ type: 'text', text: 'x' }], isError: false }, error: { name: 'ToolTimeoutError', code: 'TOOL_TIMEOUT' } } },
  { type: 'turn/end', time: t0 + 20, data: { reason: { kind: 'error', error: { code: 'RATE_LIMIT' } } } },
], { now: t0 + 30 });
assert.equal(errored.state, 'error');
assert.equal(errored.hasError, true);
assert.equal(errored.lastTool.status, TOOL_STATUS.TIMEOUT);

// 老化：2 分钟无事件降 idle；error 超过 10 分钟也降 idle。
const staleIdle = summarizeSession([{ type: 'turn/end', time: t0, data: { reason: { kind: 'completed' } } }], { now: t0 + 200000 });
assert.equal(staleIdle.state, 'idle');
const staleError = summarizeSession([{ type: 'turn/end', time: t0, data: { reason: { kind: 'error', error: { code: 'X' } } } }], { now: t0 + 700000 });
assert.equal(staleError.state, 'idle');

// 6. 聚合：error > attention > working > thinking > idle。
assert.equal(aggregateState(['idle', 'working', 'error']), 'error');
assert.equal(aggregateState(['idle', 'thinking', 'working']), 'working');
assert.equal(aggregateState(['idle', 'idle']), 'idle');
assert.equal(stateRank('error') > stateRank('attention'), true);

// ---------------------------------------------------------------------------
// W1：新增事件分类（approval / job / command / todo / goal / changes / deliverables）
// 与子态（waiting-approval / waiting-answer）、可配置老化、统一扫描。
// ---------------------------------------------------------------------------
const t1 = 1793700000000;
const step = [{ type: 'step/start', time: t1 }];

// 7) 审批等待：approval/asked 未配对 → 子态 waiting-approval（主状态保持 working）。
const asked = summarizeSession(
  [
    ...step,
    { type: 'tool/call', time: t1 + 10, data: { callId: 'a1', name: 'bash' } },
    { type: 'approval/asked', time: t1 + 20, data: { id: 'ap1', toolName: 'bash', callId: 'a1', reason: 'rm -rf build' } },
  ],
  { now: t1 + 30 },
);
assert.equal(asked.state, 'working');
assert.equal(asked.substate, 'waiting-approval');
assert.equal(asked.approvals.pendingCount, 1);
assert.equal(asked.approvals.pending[0].toolName, 'bash');
assert.equal(asked.approvals.pending[0].callId, 'a1');

// 配对后清掉；decided 结果单独保留。
const decided = summarizeSession(
  [
    ...step,
    { type: 'tool/call', time: t1 + 10, data: { callId: 'a1', name: 'bash' } },
    { type: 'approval/asked', time: t1 + 20, data: { id: 'ap1', toolName: 'bash', callId: 'a1' } },
    { type: 'approval/decided', time: t1 + 40, data: { id: 'ap1', outcome: 'approved' } },
    { type: 'tool/result', time: t1 + 50, data: { message: { toolCallId: 'a1', content: [{ type: 'text', text: 'ok' }] } } },
  ],
  { now: t1 + 60 },
);
assert.equal(decided.substate, null);
assert.equal(decided.approvals.pendingCount, 0);
assert.equal(decided.approvals.lastDecision.outcome, 'approved');

// 审批单被对应工具调用消费（即使 approval/decided 丢了）也不该残留。
const consumed = summarizeSession(
  [
    { type: 'tool/call', time: t1, data: { callId: 'a2', name: 'pwsh' } },
    { type: 'approval/asked', time: t1 + 5, data: { id: 'ap2', toolName: 'pwsh', callId: 'a2' } },
    { type: 'tool/result', time: t1 + 9, data: { message: { toolCallId: 'a2', content: [] } } },
  ],
  { now: t1 + 10 },
);
assert.equal(consumed.approvals.pendingCount, 0);
assert.equal(consumed.substate, null);

// 8) 等用户回答：在途 ask_user 工具 → waiting-answer；结果回来即清。
const asking = summarizeSession(
  [
    ...step,
    { type: 'tool/call', time: t1 + 10, data: { callId: 'q1', name: 'mcp__dsh_tools__ask_user_question' } },
  ],
  { now: t1 + 20 },
);
assert.equal(asking.state, 'working');
assert.equal(asking.substate, 'waiting-answer');
const answered = summarizeSession(
  [
    ...step,
    { type: 'tool/call', time: t1 + 10, data: { callId: 'q1', name: 'ask_user_question' } },
    { type: 'tool/result', time: t1 + 30, data: { message: { toolCallId: 'q1', content: [{ type: 'text', text: '{"answer":1}' }] } } },
  ],
  { now: t1 + 40 },
);
assert.equal(answered.substate, null);
assert.equal(isAskUserTool('ask_user'), true);
assert.equal(isAskUserTool('mcp__x__ask_user_question'), true);
assert.equal(isAskUserTool('bash'), false);

// 9) 后台 job：registered → running；settled → 计数与失败判定。
const jobs = summarizeSession(
  [
    { type: 'job/registered', time: t1, data: { jobId: 'j1', owner: 's1', kind: 'bash', label: 'pnpm build', startedAt: t1 } },
    { type: 'job/registered', time: t1 + 5, data: { jobId: 'j2', owner: 's1', kind: 'bash', label: 'sleep 99', startedAt: t1 + 5 } },
    { type: 'job/settled', time: t1 + 20, data: { jobId: 'j1', status: 'completed', cause: 'exit', startedAt: t1, finishedAt: t1 + 20 } },
    { type: 'job/settled', time: t1 + 30, data: { jobId: 'j3', status: 'failed', cause: 'exit', startedAt: t1, finishedAt: t1 + 30 } },
  ],
  { now: t1 + 40 },
);
assert.equal(jobs.jobs.runningCount, 1);
assert.equal(jobs.jobs.running[0].jobId, 'j2');
assert.equal(jobs.jobs.settledCount, 2);
assert.equal(jobs.jobs.failedCount, 1);
assert.equal(jobs.jobs.lastSettled.status, 'failed');

// 10) 命令：run → running；done → 清掉并记录 kind。
const cmds = summarizeSession(
  [
    { type: 'command/run', time: t1, data: { commandId: 'c1', name: 'plan', args: '', source: {} } },
    { type: 'command/done', time: t1 + 5, data: { commandId: 'c1', kind: 'ok', text: '' } },
    { type: 'command/run', time: t1 + 8, data: { commandId: 'c2', name: 'clear', args: '', source: {} } },
  ],
  { now: t1 + 10 },
);
assert.equal(cmds.commands.runningCount, 1);
assert.equal(cmds.commands.running[0].name, 'clear');
assert.equal(cmds.commands.lastRun.name, 'clear');
assert.equal(cmds.commands.lastDone.kind, 'ok');

// 11) todo / goal / changes / deliverables。
const work = summarizeSession(
  [
    { type: 'todo/write', time: t1, data: { todos: [{}, {}, {}] } },
    { type: 'goal/change', time: t1 + 5, data: { kind: 'goal', operation: 'updated', roundsStarted: 2, version: 3, updatedAt: t1 + 5 } },
    { type: 'workspace/changes', time: t1 + 10, data: { turn: 7 } },
    { type: 'deliverables/presented', time: t1 + 15, data: { turn: 7, callId: 'd1', files: [{ path: 'a' }, { path: 'b' }] } },
  ],
  { now: t1 + 20 },
);
assert.equal(work.todos.count, 3);
assert.equal(work.goals.operation, 'updated');
assert.equal(work.goals.roundsStarted, 2);
assert.equal(work.changes.turn, 7);
assert.equal(work.deliverables.count, 2);

// 12) compaction：start → inProgress；end → 计数、结束。
const compacting = summarizeSession(
  [
    { type: 'compaction/start', time: t1, data: { compactionId: 'k1', turn: 1 } },
    { type: 'compaction/prune', time: t1 + 3, data: { shadowedSeqs: [] } },
    { type: 'compaction/end', time: t1 + 6, data: { compactionId: 'k1', turn: 1 } },
  ],
  { now: t1 + 10 },
);
assert.equal(compacting.compaction.inProgress, false);
assert.equal(compacting.compaction.count, 1);
assert.equal(compacting.compaction.startedAt, t1);
assert.equal(compacting.compaction.endedAt, t1 + 6);

// 13) 可配置老化：阈值来自 options，不再写死。
const turnDone = [{ type: 'turn/end', time: t1, data: { reason: { kind: 'completed' } } }];
assert.equal(summarizeSession(turnDone, { now: t1 + 5000, thresholds: { idleAfterMs: 1000 } }).state, 'idle');
assert.equal(summarizeSession(turnDone, { now: t1 + 5000 }).state, 'attention');
const turnError = [{ type: 'turn/end', time: t1, data: { reason: { kind: 'error', error: { code: 'X' } } } }];
assert.equal(summarizeSession(turnError, { now: t1 + 2000, thresholds: { errorHoldMs: 1000 } }).state, 'idle');
assert.equal(summarizeSession(turnError, { now: t1 + 2000 }).state, 'error');
assert.deepEqual(normalizeThresholds({ idleAfterMs: -1, errorHoldMs: 'x' }).idleAfterMs, DEFAULT_SESSION_THRESHOLDS.idleAfterMs);

// 14) 等待期内不老化：等审批 100s 仍是 waiting-approval；超过 waitingHoldMs 才清。
const longAsk = [
  { type: 'tool/call', time: t1, data: { callId: 'a9', name: 'bash' } },
  { type: 'approval/asked', time: t1 + 1, data: { id: 'ap9', toolName: 'bash', callId: 'a9' } },
];
assert.equal(summarizeSession(longAsk, { now: t1 + 100000, thresholds: { idleAfterMs: 1000 } }).substate, 'waiting-approval');
const staleAsk = summarizeSession(longAsk, { now: t1 + 100000, thresholds: { idleAfterMs: 1000, waitingHoldMs: 50000 } });
assert.equal(staleAsk.substate, null);
assert.equal(staleAsk.state, 'idle');

// 15) 统一扫描的旧契约适配：aborted/interrupted 仍显示 attention（overlay 旧行为），
//     字段形状保持 getAgentState 原样。
const abortedSummary = summarizeSession(
  [
    { type: 'user/message', time: t1, data: { content: [{ type: 'text', text: 'hi' }] } },
    { type: 'turn/end', time: t1 + 100, data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } },
  ],
  { now: t1 + 200 },
);
const legacy = legacyAgentState(abortedSummary, { ageMs: 200, workspace: 'ws' });
assert.equal(legacy.ok, true);
assert.equal(legacy.state, 'attention');
assert.equal(legacy.workspace, 'ws');
assert.equal(legacy.lastUserText, 'hi');
assert.equal(typeof legacy.lastTool, 'string');
assert.equal(typeof legacy.lastEventAt, 'number');

// 16) recentTools 上限可配（防止快照/分析器被长会话拖大）。
const manyTools = [];
for (let i = 0; i < 5; i++) {
  manyTools.push({ type: 'tool/call', time: t1 + i * 10, data: { callId: 'c' + i, name: 'read' } });
  manyTools.push({ type: 'tool/result', time: t1 + i * 10 + 1, data: { message: { toolCallId: 'c' + i, content: [{ type: 'text', text: 'x' }] } } });
}
assert.equal(summarizeSession(manyTools, { now: t1 + 100, thresholds: { recentToolLimit: 2 } }).recentTools.length, 2);

// 17) 空事件：不伪装成"成功"，状态 idle 且 age 未知。
const emptySummary = summarizeSession([], { now: t1 });
assert.equal(emptySummary.state, 'idle');
assert.equal(emptySummary.ageMs, null);
assert.equal(emptySummary.lastTool, null);
assert.equal(emptySummary.substate, null);

console.log('session-events ok');
