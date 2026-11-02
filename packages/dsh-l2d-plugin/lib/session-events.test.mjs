import assert from 'node:assert/strict';
import {
  TOOL_STATUS,
  aggregateState,
  classifyToolMarkers,
  classifyToolResult,
  classifyTurnEnd,
  isActionTool,
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

console.log('session-events ok');
