/**
 * Workspace Action Protocol：契约校验 / 状态推导 / 摘要生成 / Agent 动作块提取。
 *
 * 全部纯函数。协议**复用**现有通信层（aiInbox callId 关联、W1 快照、host-guard），
 * 这里只验证"信封长什么样、状态怎么推、摘要怎么写给用户看"。
 */
import assert from 'node:assert/strict';
import {
  validateWorkspaceActionRequest,
  validateWorkspaceActionResponse,
  validateAgentActionBlock,
  deriveActionStatus,
  buildActionSummary,
  extractAgentActionBlock,
  trimWorkspaceContext,
  WORKSPACE_CONTEXT_MAX_CHARS,
} from '../src/workspace-protocol.ts';

let passed = 0;
const test = (name, fn) => {
  fn();
  passed++;
  console.log('  ok  ' + name);
};

const okRequest = {
  requestId: 'req_001',
  type: 'workspace.action',
  action: { name: 'l2d_play_motion', target: 'live2d_character', parameters: { group: '竖手指打开' } },
  workspace: { id: 'dsh-l2d', name: 'DSH-L2D', type: 'development' },
  user: { intent: '播放角色待机动画' },
  responseFormat: { requireAction: true, requireSummary: true, language: 'zh-CN' },
};

test('合法请求通过校验', () => {
  assert.deepEqual(validateWorkspaceActionRequest(okRequest), []);
});

test('非法请求逐项报错（不猜测、不补全）', () => {
  const errors = validateWorkspaceActionRequest({ type: 'workspace.action', action: {} });
  assert.ok(errors.some((e) => e.includes('requestId')));
  assert.ok(errors.some((e) => e.includes('action.name')));
  assert.ok(errors.some((e) => e.includes('workspace.id')));
});

test('响应信封：缺 summary 或 status 非法会被拦下', () => {
  const bad = validateWorkspaceActionResponse({ requestId: 'req_001', type: 'workspace.action.result', status: 'done', action: { name: 'x' }, summary: '' });
  assert.ok(bad.some((e) => e.includes('status')));
  assert.ok(bad.some((e) => e.includes('summary')));
  assert.deepEqual(validateWorkspaceActionResponse({
    requestId: 'req_001', type: 'workspace.action.result', status: 'completed',
    action: { name: 'l2d_play_motion' }, summary: '已切换动作。',
  }), []);
});

test('状态推导：accepted → executing → completed 全链', () => {
  assert.equal(deriveActionStatus({ queued: true }).status, 'accepted');
  assert.equal(deriveActionStatus({ queued: true, events: [{ phase: 'start' }] }).status, 'executing');
  assert.equal(deriveActionStatus({ queued: true, events: [{ phase: 'start' }], result: { ok: true } }).status, 'completed');
  assert.equal(deriveActionStatus({ queued: true, result: { ok: false, reason: 'write-failed' } }).status, 'failed');
});

test('状态推导：守卫拒绝 = rejected（不是 failed）', () => {
  const r = deriveActionStatus({ queued: false, guardMessage: 'unknown tool: x' });
  assert.equal(r.status, 'rejected');
  assert.equal(r.reason, 'unknown tool: x');
});

test('状态推导：interrupted 视为 failed 且原因可查', () => {
  const r = deriveActionStatus({ queued: true, events: [{ phase: 'interrupted', reason: 'preempted' }] });
  assert.equal(r.status, 'failed');
  assert.match(r.reason, /preempted/);
});

test('摘要面向用户：说"做了什么"，不暴露 JSON', () => {
  const s = buildActionSummary({
    applied: ['AngleX', 'ShoulderX', 'ShoulderZ'],
    owned: ['ShoulderZ'],
    skipped: [{ channel: 'leg.left.bend' }],
    degraded: [{ channel: 'torso.contraction' }],
    failed: [],
    durationMs: 3000,
  }, 'l2d_posture');
  assert.match(s, /已更新 3 个参数/);
  assert.match(s, /占用 1 个物理输出/);
  assert.match(s, /1 项能力不支持已跳过/);
  assert.ok(!s.includes('{'), '摘要里不应出现 JSON 片段');
});

test('Agent 动作块：从围栏里提取并校验（不可信输入 fail-closed）', () => {
  const text = '好的，我来处理。\n```json\n{"type":"workspace.action","requestId":"req_009","action":{"name":"l2d_look_at","parameters":{"x":0.2}}}\n```\n请查收。';
  const r = extractAgentActionBlock(text);
  assert.equal(r.ok, true);
  assert.equal(r.block.action.name, 'l2d_look_at');

  const bad = extractAgentActionBlock('```json\n{"type":"workspace.action","requestId":"x","action":{}}\n```');
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /invalid/);

  assert.equal(extractAgentActionBlock('没有动作块').ok, false);
});

test('上下文精简：只保留动作相关字段', () => {
  const ctx = trimWorkspaceContext(
    { activity: { situation: 'reviewing_result', confidence: 0.9 }, presence: { state: 'conversation' } },
    { id: 'dsh-l2d', name: 'DSH-L2D', type: 'development' },
  );
  assert.equal(ctx.id, 'dsh-l2d');
  assert.match(ctx.stateSummary, /reviewing_result/);
  assert.ok(JSON.stringify(ctx).length <= WORKSPACE_CONTEXT_MAX_CHARS);
  assert.ok(!('sessions' in ctx), '不应携带会话历史');
});

if (process.exitCode) console.error('\n协议测试失败\n');
else console.log(`\n${passed} passed\n`);
