/**
 * Workspace Action Channel：信封提交 / 去重 / 守卫拒绝 / 状态推导 的胶水测试。
 * 用假 aiInbox + 假守卫，不依赖真机。
 */
import assert from 'node:assert/strict';
import { createWorkspaceActionChannel } from './workspace-action.mjs';
import { createAiInbox } from './ai-inbox.mjs';

let passed = 0;
const test = (name, fn) => {
  fn();
  passed++;
  console.log('  ok  ' + name);
};

const OK_REQUEST = {
  requestId: 'req_001',
  type: 'workspace.action',
  action: { name: 'l2d_look_at', parameters: { x: 0.2, y: 0 } },
  workspace: { id: 'dsh-l2d', name: 'DSH-L2D', type: 'development' },
  user: { intent: '看向右侧' },
  responseFormat: { requireAction: true, requireSummary: true, language: 'zh-CN' },
};

function makeChannel({ guard } = {}) {
  const aiInbox = createAiInbox();
  const guardCalls = [];
  const guardAiCall = guard || ((call) => {
    guardCalls.push(call);
    return { ok: true };
  });
  const channel = createWorkspaceActionChannel({
    aiInbox,
    guardAiCall,
    getSnapshot: () => ({ activity: { situation: 'reviewing_result', confidence: 0.9 }, presence: { state: 'conversation' } }),
  });
  return { channel, aiInbox, guardCalls };
}

test('合法提交 → accepted + callId，且动作过守卫', () => {
  const { channel, guardCalls } = makeChannel();
  const resp = channel.submit(OK_REQUEST);
  assert.equal(resp.status, 'accepted');
  assert.equal(resp.requestId, 'req_001');
  assert.ok(resp.callId > 0);
  assert.equal(resp.summary.includes('l2d_look_at'), true);
  assert.equal(guardCalls.length, 1);
  assert.equal(guardCalls[0].name, 'l2d_look_at');
});

test('未完结前重复 requestId → 去重（同一 callId）', () => {
  const { channel, aiInbox } = makeChannel();
  const r1 = channel.submit(OK_REQUEST);
  const r2 = channel.submit(OK_REQUEST);
  assert.equal(r2.duplicate, true);
  assert.equal(r2.callId, r1.callId);
  assert.equal(aiInbox.poll().calls.length, 1, '只入队一次');
});

test('守卫拒绝 → rejected 信封（不产生写入）', () => {
  const { channel } = makeChannel({ guard: () => ({ ok: false, message: 'unknown tool: hack' }) });
  const resp = channel.submit(OK_REQUEST);
  assert.equal(resp.status, 'rejected');
  assert.match(resp.summary, /unknown tool: hack/);
  assert.equal(resp.callId, undefined);
});

test('非法信封 → rejected（invalid-request）', () => {
  const { channel } = makeChannel();
  const resp = channel.submit({ requestId: 'x', type: 'workspace.action', action: {} });
  assert.equal(resp.status, 'rejected');
  assert.match(resp.summary, /invalid-request/);
});

test('result：入队未执行 → accepted；start 事件 → executing', () => {
  const { channel, aiInbox } = makeChannel();
  const accepted = channel.submit(OK_REQUEST);
  const r1 = channel.result('req_001');
  assert.equal(r1.status, 'accepted');
  aiInbox.post({ id: accepted.callId, event: { type: 'action-done', phase: 'start' } });
  assert.equal(channel.result('req_001').status, 'executing');
});

test('result：执行回执 ok → completed + 面向用户的摘要', () => {
  const { channel, aiInbox } = makeChannel();
  const accepted = channel.submit(OK_REQUEST);
  aiInbox.post({ id: accepted.callId, event: { type: 'action-done', phase: 'start' } });
  aiInbox.post({
    id: accepted.callId,
    result: { ok: true, applied: ['AngleX'], failed: [], owned: [], skipped: [], degraded: [], durationMs: 1200 },
  });
  const r = channel.result('req_001');
  assert.equal(r.status, 'completed');
  assert.equal(r.result.success, true);
  assert.match(r.summary, /已更新 1 个参数/);
  assert.ok(!r.summary.includes('{'));
});

test('result：执行失败 → failed + 原因', () => {
  const { channel, aiInbox } = makeChannel();
  const accepted = channel.submit(OK_REQUEST);
  aiInbox.post({ id: accepted.callId, result: { ok: false, reason: 'unknown-expression' } });
  const r = channel.result('req_001');
  assert.equal(r.status, 'failed');
  assert.equal(r.result.success, false);
  assert.match(r.result.message, /unknown-expression/);
});

test('result：非终态附带 progress，终态信封不带；多次轮询不回退', () => {
  const { channel, aiInbox } = makeChannel();
  const accepted = channel.submit(OK_REQUEST);
  // 真实形状：页面受理即回 start 事件 + settled:false 受理回执，链随后才播完
  aiInbox.post({ id: accepted.callId, event: { type: 'action-done', phase: 'start', ts: Date.now() } });
  aiInbox.post({ id: accepted.callId, result: { ok: true, accepted: true, settled: false, outcome: 'pending', runId: 8, steps: 2 } });
  const running = channel.result('req_001');
  assert.equal(running.status, 'executing', 'settled:false 受理回执不能提前 completed');
  assert.ok(running.progress, '非终态要带 progress');
  assert.equal(running.progress.phase, 'pre');
  assert.equal(typeof running.progress.percent, 'number');
  // read 是破坏性读取，但已看到的 start 累积在 entry 里：再次轮询仍是 executing（不回退成 accepted）
  assert.equal(channel.result('req_001').status, 'executing');
  assert.ok(channel.result('req_001').progress, '第二次轮询仍带 progress');
  // 链播完：end 事件收敛
  aiInbox.post({ id: accepted.callId, event: { type: 'action-done', phase: 'end', ts: Date.now() } });
  const done = channel.result('req_001');
  assert.equal(done.status, 'completed');
  assert.equal(done.progress, undefined, '终态信封保持轻量，不带 progress');
});

test('未知 requestId → null（不猜）', () => {
  const { channel } = makeChannel();
  assert.equal(channel.result('req_nope'), null);
});

if (process.exitCode) console.error('\n通道测试失败\n');
else console.log(`\n${passed} passed\n`);
