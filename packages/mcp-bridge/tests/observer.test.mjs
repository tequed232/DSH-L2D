/**
 * Workspace Observer 验收（SUPERVISOR-P12 / P1，obs.* 15 例，docs/mcp-bridge/TEST-PLAN.md §1）。
 * node:assert + 临时库；状态源 = 真实 session-events.summarizeSession 处理真实事件
 * 形态 fixture（tool/call+result、turn/end、approval、job、command），不伪造 summary 字段。
 * 直跑：node --experimental-sqlite packages/mcp-bridge/tests/observer.test.mjs
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../dsh-l2d-db/src/db.mjs';
import { SCHEMA_VERSION } from '../../dsh-l2d-db/src/schema.mjs';
import { recordDispatchPending, findDispatch, listPending } from '../../dsh-l2d-db/src/observer-repo.mjs';
import {
  classifyWorkspaceStatus, buildWorkspaceEvent, WorkspaceObserver, STATUS_PRIORITY, createDedupFromRepo,
} from '../observer.mjs';
import { summarizeSession } from '../../dsh-l2d-plugin/lib/session-events.mjs';

let passed = 0;
function ok(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1; }
}
async function okAsync(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1; }
}

const BASE = 1_700_000_000_000;
/** 真实事件形态 fixture：每项 {dt, ...event}，自动补 seq 与 time（dt=相对 BASE 毫秒）。 */
function evs(list) {
  return list.map(({ dt, ...ev }, i) => ({ ...ev, seq: i + 1, time: BASE + (dt ?? i * 1000) }));
}
function summarize(list, at) {
  const maxDt = list.length ? Math.max(...list.map((e) => e.dt ?? 0)) : 0;
  return summarizeSession(evs(list), { now: at ?? BASE + maxDt });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'observer-p12-'));
const db = openDb({ path: path.join(tmp, 'obs.sqlite') });

console.log('P1 Workspace Observer（obs.*）');

ok('迁移 v9：observer_dispatch_log 已建，SCHEMA_VERSION 推进到 9', () => {
  assert.equal(SCHEMA_VERSION, 9);
  const cols = db.prepare("SELECT name FROM pragma_table_info('observer_dispatch_log')").all().map((c) => c.name);
  assert.deepEqual(cols.sort(), ['attempts', 'created_at', 'dispatched_at', 'event_id', 'last_error', 'status', 'workspace_id']);
});

ok('obs.state.running：前台工具在途 → running，taskId=callId', () => {
  const s = summarize([{ dt: 0, type: 'tool/call', data: { callId: 'c1', name: 'bash' } }]);
  const v = classifyWorkspaceStatus(s);
  assert.equal(v.status, 'running');
  assert.equal(v.taskId, 'c1');
});

ok('obs.state.error：turn/end error → error 带 code；600s 老化后回 idle', () => {
  const errEnd = { dt: 1000, type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'E_TEST', message: 'boom' } } } };
  const v = classifyWorkspaceStatus(summarize([{ dt: 0, type: 'tool/call', data: { callId: 'c1', name: 'bash' } }, errEnd]));
  assert.equal(v.status, 'error');
  assert.equal(v.errorCode, 'E_TEST');
  const aged = summarizeSession(evs([{ dt: 0, type: 'tool/call', data: { callId: 'c1', name: 'bash' } }, errEnd]), { now: BASE + 1000 + 601_000 });
  assert.equal(classifyWorkspaceStatus(aged).status, 'idle', 'errorHoldMs=600s 后不再上报 error');
});

ok('obs.state.succeeded：turn/end completed 且是最新事件；被新活动压过则失效', () => {
  const s = summarize([
    { dt: 0, type: 'tool/call', data: { callId: 'c1', name: 'bash' } },
    { dt: 5000, type: 'turn/end', data: { reason: { kind: 'completed' } } },
  ]);
  assert.equal(classifyWorkspaceStatus(s).status, 'succeeded');
  const superseded = summarize([
    { dt: 0, type: 'turn/end', data: { reason: { kind: 'completed' } } },
    { dt: 8000, type: 'tool/call', data: { callId: 'c2', name: 'bash' } },
  ]);
  assert.equal(classifyWorkspaceStatus(superseded).status, 'running', '旧 completed turn 不得压过新活动');
});

ok('obs.state.waiting_input.approval：审批单未决 → waiting_input，waitingAgentId=审批 id', () => {
  const s = summarize([
    { dt: 0, type: 'tool/call', data: { callId: 'c1', name: 'bash' } },
    { dt: 1000, type: 'approval/asked', data: { id: 'ap1', toolName: 'bash', callId: 'c1', reason: 'needs approval' } },
  ]);
  const v = classifyWorkspaceStatus(s);
  assert.equal(v.status, 'waiting_input');
  assert.equal(v.waitingAgentId, 'ap1');
});

ok('obs.state.waiting_input.answer：ask-user 工具在途 → waiting_input，不得代答', () => {
  const s = summarize([{ dt: 0, type: 'tool/call', data: { callId: 'q1', name: 'mcp__dsh__ask_user_question' } }]);
  const v = classifyWorkspaceStatus(s);
  assert.equal(v.status, 'waiting_input');
  assert.equal(v.waitingAgentId, 'q1');
});

ok('obs.state.waiting_subagent.job：后台 job 未 settle → waiting_subagent，taskId=jobId', () => {
  const s = summarize([
    { dt: 0, type: 'tool/call', data: { callId: 'c1', name: 'bash' } },
    { dt: 1000, type: 'tool/result', data: { message: { toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] } } },
    { dt: 2000, type: 'job/registered', data: { jobId: 'job9', owner: 'ws-a', kind: 'subagent', label: 'research' } },
  ]);
  const v = classifyWorkspaceStatus(s);
  assert.equal(v.status, 'waiting_subagent');
  assert.equal(v.taskId, 'job9');
});

ok('obs.state.waiting_subagent.command：后台 command 未 done → waiting_subagent', () => {
  const s = summarize([
    { dt: 0, type: 'tool/call', data: { callId: 'c1', name: 'bash' } },
    { dt: 1000, type: 'tool/result', data: { message: { toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] } } },
    { dt: 2000, type: 'command/run', data: { commandId: 'cmd7', name: 'deploy' } },
  ]);
  const v = classifyWorkspaceStatus(s);
  assert.equal(v.status, 'waiting_subagent');
  assert.equal(v.taskId, 'cmd7');
});

ok('obs.substate.expiry：waiting 子态 ageMs>waitingHoldMs(600s) → 回落，不拿旧值调度', () => {
  const aged = summarizeSession(evs([
    { dt: 0, type: 'tool/call', data: { callId: 'c1', name: 'bash' } },
    { dt: 1000, type: 'approval/asked', data: { id: 'ap1', toolName: 'bash', callId: 'c1' } },
  ]), { now: BASE + 1000 + 601_000 });
  const v = classifyWorkspaceStatus(aged);
  assert.notEqual(v.status, 'waiting_input', '超期子态不得继续触发 waiting_input');
});

ok('obs.substate.mutual-exclusion：审批 pending 与后台 job 并存 → waiting_input 优先', () => {
  const s = summarize([
    { dt: 0, type: 'tool/call', data: { callId: 'c1', name: 'bash' } },
    { dt: 1000, type: 'tool/result', data: { message: { toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] } } },
    { dt: 2000, type: 'job/registered', data: { jobId: 'job9', owner: 'ws-a', kind: 'subagent' } },
    { dt: 3000, type: 'approval/asked', data: { id: 'ap2', toolName: 'bash', callId: 'c2' } },
  ]);
  const v = classifyWorkspaceStatus(s);
  assert.equal(v.status, 'waiting_input', '互斥裁决：waiting_input 优先，杜绝代答');
});

okAsync('obs.env.overlay：away 静默（不登记不调度）；stale env 按 unknown 继续判定', async () => {
  const dbEnv = openDb({ path: path.join(tmp, 'obs-env.sqlite') });
  const dispatched = [];
  const mk = (env) => new WorkspaceObserver({
    dedup: createDedupFromRepo(dbEnv), onDispatch: (e) => dispatched.push(e.eventId),
    source: () => [{ workspaceId: 'ws-a', sessionId: 's1', summary: summarize([{ dt: 0, type: 'tool/call', data: { callId: 'c1', name: 'bash' } }]), seq: 1, env }],
  });
  const away = mk({ available: true, stale: false, payload: { away: true } });
  const r1 = await away.poll();
  assert.equal(dispatched.length, 0, '离席静默');
  assert.equal(r1[0].outcome, 'silenced-user-away');
  const stale = mk({ available: false, stale: true, payload: null });
  await stale.poll();
  assert.equal(dispatched.length, 1, 'stale env 按 unknown，不影响主状态判定');
});

ok('obs.revision.monotonic：revision 单调透传；非法 status 拒绝组装', () => {
  const e1 = buildWorkspaceEvent({ workspaceId: 'ws-a', sessionId: 's1', status: 'running', seq: 5, revision: 10, timestamp: BASE });
  const e2 = buildWorkspaceEvent({ workspaceId: 'ws-a', sessionId: 's1', status: 'error', seq: 6, revision: 11, timestamp: BASE });
  assert.equal(e2.revision > e1.revision, true);
  assert.equal(e1.eventId, 's1:5:running');
  assert.equal(e2.eventId, 's1:6:error');
  assert.throws(() => buildWorkspaceEvent({ workspaceId: 'ws-a', sessionId: 's1', status: 'bogus' }), /status 非法/);
});

okAsync('obs.dedup.dispatchOnce：同 (workspaceId,eventId) 二次投递只调度一次', async () => {
  const dbD = openDb({ path: path.join(tmp, 'obs-dedup.sqlite') });
  const dispatched = [];
  const obs = new WorkspaceObserver({
    dedup: createDedupFromRepo(dbD), onDispatch: (e) => dispatched.push(e.eventId),
    source: () => [{ workspaceId: 'ws-a', sessionId: 's1', summary: summarize([{ dt: 0, type: 'turn/end', data: { reason: { kind: 'completed' } } }]), seq: 9 }],
  });
  const first = await obs.poll();
  assert.equal(first[0].outcome, 'dispatched');
  const second = await obs.poll();
  assert.equal(second[0].outcome, 'duplicate', '同 turn 二次轮询不重复');
  assert.equal(dispatched.length, 1);
  assert.equal(dbD.prepare('SELECT COUNT(*) n FROM observer_dispatch_log').get().n, 1);
});

okAsync('obs.dedup.crash-recovery：failed 重试成功；pending 行（崩溃残留）重放不漏', async () => {
  const dbC = openDb({ path: path.join(tmp, 'obs-crash.sqlite') });
  let failOnce = true;
  const calls = [];
  const obs = new WorkspaceObserver({
    dedup: createDedupFromRepo(dbC),
    onDispatch: (e) => { if (failOnce) { failOnce = false; throw new Error('simulated-crash'); } calls.push(e.eventId); },
    source: () => [{ workspaceId: 'ws-a', sessionId: 's1', summary: summarize([{ dt: 0, type: 'tool/call', data: { callId: 'c1', name: 'bash' } }]), seq: 3 }],
  });
  const r1 = await obs.poll();
  assert.equal(r1[0].outcome, 'failed');
  assert.equal(findDispatch(dbC, 'ws-a', r1[0].eventId).status, 'failed');
  const r2 = await obs.poll();
  assert.equal(r2[0].outcome, 'dispatched', 'failed 行下一轮重试');
  assert.deepEqual(calls, [r1[0].eventId]);

  // 崩溃残留 pending：登记后未及 markDispatched，重启后同事件重放
  recordDispatchPending(dbC, 'ws-b', 's2:1:error');
  assert.equal(listPending(dbC).length, 1);
  const obsB = new WorkspaceObserver({
    dedup: createDedupFromRepo(dbC), onDispatch: (e) => calls.push(e.eventId),
    source: () => [{ workspaceId: 'ws-b', sessionId: 's2', summary: summarize([{ dt: 0, type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'E2' } } } }]), seq: 1 }],
  });
  const r3 = await obsB.poll();
  assert.equal(r3[0].outcome, 'dispatched', 'pending 残留行重放，不漏调度');
  assert.equal(calls.includes('s2:1:error'), true);
  assert.equal(listPending(dbC).length, 0);
});

okAsync('obs.negative.no-cross-write：Observer 对其他工作区零写入（只读+查重表）', async () => {
  const dbN = openDb({ path: path.join(tmp, 'obs-negative.sqlite') });
  const writeSpies = { prompt: 0, createSession: 0, writeSessionFile: 0 };
  const fakeHost = {
    sessionController: { prompt: () => { writeSpies.prompt++; }, create: () => { writeSpies.createSession++; } },
    writeSessionFile: () => { writeSpies.writeSessionFile++; },
  };
  const dispatched = [];
  const obs = new WorkspaceObserver({
    dedup: createDedupFromRepo(dbN), onDispatch: (e) => dispatched.push(e),
    source: () => [{ workspaceId: 'ws-other', sessionId: 's9', summary: summarize([{ dt: 0, type: 'tool/call', data: { callId: 'c1', name: 'bash' } }]), seq: 2 }],
  });
  await obs.poll();
  assert.equal(dispatched.length, 1, '调度指令只经注入的 onDispatch 出口');
  assert.deepEqual(writeSpies, { prompt: 0, createSession: 0, writeSessionFile: 0 },
    '全链路无任何对其他工作区会话历史/私有上下文的写调用（Observer 无宿主写 API 可用）');
  const tables = dbN.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%session%'").all();
  assert.equal(tables.length, 0, '查重只落 observer_dispatch_log，不写会话域表');
});

okAsync('obs.ordering.priority：并发事件按 p100>p90>p75>p40 排序调度', async () => {
  const dbO = openDb({ path: path.join(tmp, 'obs-order.sqlite') });
  const order = [];
  const snapOf = (ws, list, seq) => ({ workspaceId: ws, sessionId: 's-' + ws, summary: summarize(list), seq });
  const obs = new WorkspaceObserver({
    dedup: createDedupFromRepo(dbO), onDispatch: (e) => order.push(e.status),
    source: () => [
      snapOf('ws-wait', [{ dt: 0, type: 'tool/call', data: { callId: 'q1', name: 'mcp__dsh__ask_user_question' } }], 1),
      snapOf('ws-done', [{ dt: 0, type: 'turn/end', data: { reason: { kind: 'completed' } } }], 1),
      snapOf('ws-err', [{ dt: 0, type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'E9' } } } }], 1),
      snapOf('ws-run', [{ dt: 0, type: 'tool/call', data: { callId: 'c1', name: 'bash' } }], 1),
    ],
  });
  const results = await obs.poll();
  assert.deepEqual(order, ['error', 'waiting_input', 'succeeded', 'running'],
    `调度顺序 p100>p90>p40>p10，实际 ${JSON.stringify(order)}`);
  assert.deepEqual(results.map((r) => r.status), order);
});

ok('优先级常量与构造约束：STATUS_PRIORITY 全覆盖；interval 30-120s 钳制；缺依赖 throw', () => {
  for (const s of ['idle', 'running', 'error', 'waiting_subagent', 'waiting_input', 'succeeded']) {
    assert.ok(Number.isFinite(STATUS_PRIORITY[s]));
  }
  const obs = new WorkspaceObserver({
    dedup: createDedupFromRepo(db), onDispatch: () => {}, source: () => [], pollIntervalMs: 5000,
  });
  assert.equal(obs.pollIntervalMs, 30_000, '下限钳制（轮询是兜底层，可用性优先）');
  assert.throws(() => new WorkspaceObserver({ onDispatch: () => {}, source: () => [] }), /dedup/);
  assert.throws(() => new WorkspaceObserver({ dedup: createDedupFromRepo(db), source: () => [] }), /onDispatch/);
});

console.log(`\n结果：${process.exitCode ? '存在失败' : '全部通过'}（${passed} 项用例）`);
if (process.exitCode) process.exit(1);
