import assert from 'node:assert/strict';
import { SITUATIONS, analyzeContext, normalizeAnalyzerThresholds } from './context-analyzer.mjs';
import { SESSION_SUBSTATE, summarizeSession } from './session-events.mjs';

const t0 = 1793700000000;
const now = t0 + 1000;

/** 手工构造 summary（字段语义与 summarizeSession 输出一致）。 */
function summaryOf(overrides = {}) {
  return {
    state: 'idle',
    substate: null,
    lastEventAt: t0,
    ageMs: 1000,
    lastTool: null,
    lastToolName: '',
    pendingTool: null,
    lastTurnEnd: null,
    lastAction: null,
    hasError: false,
    approvals: { pendingCount: 0, pending: [] },
    jobs: { runningCount: 0, running: [] },
    commands: { runningCount: 0, running: [], lastRun: null, lastDone: null },
    todos: null,
    goals: null,
    changes: null,
    deliverables: null,
    recentTools: [],
    ...overrides,
  };
}

const presence = (state) => ({
  available: true,
  stale: false,
  ageMs: 500,
  state,
  payload: { state, away: state === 'away', inputFocused: false, idleMs: 1000 },
});

// 1) away 优先级最高。
const away = analyzeContext({
  summary: summaryOf({ approvals: { pendingCount: 1, pending: [{ toolName: 'bash' }] } }),
  presence: presence('away'),
  now,
});
assert.equal(away.situation, SITUATIONS.AWAY);
assert.ok(away.confidence >= 0.8);
assert.deepEqual(away.evidence, ['presence.state=away']);

// 2) 等审批：协议事实，高置信。
const approval = analyzeContext({
  summary: summaryOf({ state: 'working', approvals: { pendingCount: 1, pending: [{ toolName: 'bash' }] } }),
  now,
});
assert.equal(approval.situation, SITUATIONS.WAITING_FOR_APPROVAL);
assert.equal(approval.confidence, 0.95);
assert.ok(approval.evidence.some((e) => e.includes('approval.pending=1')));

// 3) 等用户回答（ask_user 在途）。
const answer = analyzeContext({
  summary: summaryOf({ state: 'working', substate: SESSION_SUBSTATE.WAITING_ANSWER }),
  now,
});
assert.equal(answer.situation, SITUATIONS.WAITING_FOR_AGENT);
assert.ok(answer.confidence >= 0.8);

// 4) 跑命令：在途 shell 工具 / 后台 job。
const runningTool = analyzeContext({
  summary: summaryOf({
    state: 'working',
    pendingTool: { name: 'bash', callId: 'c1', time: t0 },
    jobs: { runningCount: 1, running: [{ kind: 'bash' }] },
  }),
  now,
});
assert.equal(runningTool.situation, SITUATIONS.RUNNING_COMMAND);
assert.equal(runningTool.confidence, 0.9);
assert.ok(runningTool.evidence.some((e) => e.includes('pendingTool=bash')));
assert.ok(runningTool.evidence.some((e) => e.includes('jobs.running=1')));

const backgroundJob = analyzeContext({ summary: summaryOf({ state: 'idle', jobs: { runningCount: 2, running: [] } }), now });
assert.equal(backgroundJob.situation, SITUATIONS.RUNNING_COMMAND);
assert.equal(backgroundJob.confidence, 0.75);

// 5) 调试：必须「失败 + 仍在活动」两条信号。
const debugging = analyzeContext({
  summary: summaryOf({
    state: 'working',
    hasError: true,
    lastTool: { name: 'bash', status: 'nonzero-exit', code: 'EXIT_CODE', time: now - 5000 },
    recentTools: [{ name: 'bash', status: 'nonzero-exit', time: now - 5000 }],
  }),
  now,
});
assert.equal(debugging.situation, SITUATIONS.DEBUGGING);
assert.ok(debugging.confidence >= 0.5 && debugging.confidence < 0.7);
assert.ok(debugging.evidence.some((e) => e.includes('lastTool.status=nonzero-exit')));
assert.ok(debugging.evidence.some((e) => e.includes('summary.hasError=true')));

// 单条失败证据（已不活动）不能判 debugging。
const failedButIdle = analyzeContext({
  summary: summaryOf({
    state: 'idle',
    hasError: true,
    lastTool: { name: 'bash', status: 'nonzero-exit', time: now - 5000 },
  }),
  now,
});
assert.notEqual(failedButIdle.situation, SITUATIONS.DEBUGGING);

// 6) 刚完成一轮 → task_completed；过窗口后变成 reviewing_result。
const completedNow = analyzeContext({
  summary: summaryOf({
    state: 'attention',
    lastEventAt: now - 5000,
    lastTurnEnd: { kind: 'completed', code: null, time: now - 5000 },
  }),
  now,
});
assert.equal(completedNow.situation, SITUATIONS.TASK_COMPLETED);
assert.ok(completedNow.confidence >= 0.9);

const completedAWhileAgo = analyzeContext({
  summary: summaryOf({
    state: 'attention',
    lastEventAt: now - 60000,
    lastTurnEnd: { kind: 'completed', code: null, time: now - 60000 },
  }),
  now,
});
assert.equal(completedAWhileAgo.situation, SITUATIONS.REVIEWING_RESULT);

// 7) 编辑代码：写工具是强信号；前台 Code.exe 不是证据。
const editing = analyzeContext({
  summary: summaryOf({
    state: 'working',
    recentTools: [{ name: 'str_replace_editor', status: 'ok', time: now - 3000 }],
  }),
  now,
});
assert.equal(editing.situation, SITUATIONS.EDITING_CODE);
assert.ok(editing.evidence.some((e) => e.includes('str_replace_editor')));

const onlyForeground = analyzeContext({
  summary: summaryOf({ state: 'idle', lastEventAt: now - 600000 }),
  presence: presence('idle'),
  foreground: { ok: true, name: 'Code.exe', at: now },
  now,
});
assert.equal(onlyForeground.situation, SITUATIONS.IDLE); // 不能推断成 editing_code
assert.ok(onlyForeground.evidence.some((e) => e.includes('foreground=Code.exe')));
assert.ok(onlyForeground.evidence.some((e) => e.includes('not proof of editing')));

const noSessionButForeground = analyzeContext({ summary: null, foreground: { ok: true, name: 'Code.exe' }, now });
assert.equal(noSessionButForeground.situation, SITUATIONS.UNKNOWN);
assert.equal(noSessionButForeground.confidence, 0);
assert.ok(noSessionButForeground.evidence.some((e) => e.includes('not proof of editing')));

// 8) 读文档 / 读代码。
const docs = analyzeContext({
  summary: summaryOf({ state: 'working', recentTools: [{ name: 'web_fetch', status: 'ok', time: now - 1000 }] }),
  now,
});
assert.equal(docs.situation, SITUATIONS.READING_DOCUMENTATION);
const reading = analyzeContext({
  summary: summaryOf({ state: 'working', recentTools: [{ name: 'grep', status: 'ok', time: now - 1000 }] }),
  now,
});
assert.equal(reading.situation, SITUATIONS.READING_CODE);

// 9) 审阅改动：有 changes、无新写工具、已不在写。
const reviewing = analyzeContext({
  summary: summaryOf({
    state: 'attention',
    lastEventAt: now - 60000,
    lastTurnEnd: { kind: 'completed', code: null, time: now - 60000 },
    changes: { turn: 4, at: now - 20000 },
    recentTools: [{ name: 'read', status: 'ok', time: now - 15000 }],
  }),
  now,
});
// read 只读工具先命中 reading_code；把 read 去掉再测 reviewing_changes。
assert.equal(reviewing.situation, SITUATIONS.READING_CODE);
const reviewingNoTools = analyzeContext({
  summary: summaryOf({
    state: 'attention',
    lastEventAt: now - 60000,
    lastTurnEnd: { kind: 'completed', code: null, time: now - 60000 },
    changes: { turn: 4, at: now - 20000 },
  }),
  now,
});
assert.equal(reviewingNoTools.situation, SITUATIONS.REVIEWING_CHANGES);

// 10) agent 正在干活。
const working = analyzeContext({
  summary: summaryOf({ state: 'working', lastEventAt: now - 2000, recentTools: [] }),
  now,
});
assert.equal(working.situation, SITUATIONS.AGENT_WORKING);

// 11) 空闲 / 未知。
const idle = analyzeContext({ summary: summaryOf({ state: 'idle', lastEventAt: now - 600000 }), now });
assert.equal(idle.situation, SITUATIONS.IDLE);
const unknown = analyzeContext({ summary: null, presence: null, now });
assert.equal(unknown.situation, SITUATIONS.UNKNOWN);
assert.equal(unknown.confidence, 0);
assert.deepEqual(unknown.evidence, []);

// 12) 置信度在 [0,1]、证据最多 8 条且不含自由文本。
for (const item of [away, approval, answer, runningTool, debugging, completedNow, editing, docs, reading, working, idle, unknown]) {
  assert.ok(item.confidence >= 0 && item.confidence <= 1, item.situation);
  assert.ok(item.evidence.length <= 8);
  assert.ok(item.evidence.every((e) => typeof e === 'string' && e.length <= 120));
  assert.ok(item.evidence.every((e) => !e.includes('把这个修一下')));
}

// 13) 阈值可配：task_completed 窗口调大后，60s 前的完成也算完成。
const customWindow = analyzeContext({
  summary: summaryOf({
    state: 'attention',
    lastEventAt: now - 60000,
    lastTurnEnd: { kind: 'completed', code: null, time: now - 60000 },
  }),
  now,
  thresholds: { taskCompletedWindowMs: 90000 },
});
assert.equal(customWindow.situation, SITUATIONS.TASK_COMPLETED);
assert.deepEqual(normalizeAnalyzerThresholds({ taskCompletedWindowMs: -1 }).taskCompletedWindowMs, 30000);

// 14) 情境枚举覆盖：用户要求能区分的 13 种 + unknown 兜底。
assert.deepEqual(Object.values(SITUATIONS).sort(), [
  'agent_working',
  'away',
  'debugging',
  'editing_code',
  'idle',
  'reading_code',
  'reading_documentation',
  'reviewing_changes',
  'reviewing_result',
  'running_command',
  'task_completed',
  'unknown',
  'waiting_for_agent',
  'waiting_for_approval',
].sort());

// 15) 与真实 summarizeSession 联调（构造事件，不读真实会话）。
const liveSummary = summarizeSession(
  [
    { type: 'user/message', time: t0, data: { content: [{ type: 'text', text: 'hi' }] } },
    { type: 'tool/call', time: t0 + 10, data: { callId: 'c1', name: 'bash' } },
    { type: 'approval/asked', time: t0 + 20, data: { id: 'ap1', toolName: 'bash', callId: 'c1' } },
  ],
  { now: t0 + 900 },
);
const live = analyzeContext({ summary: liveSummary, now: t0 + 1000 });
assert.equal(live.situation, SITUATIONS.WAITING_FOR_APPROVAL);

console.log('context-analyzer ok');
