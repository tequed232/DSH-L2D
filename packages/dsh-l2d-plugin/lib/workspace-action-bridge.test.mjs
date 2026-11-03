/**
 * Workspace Action 桥闭环：Agent 回复文本 → extractAgentActionBlock → submit（假通道）→ 回投内容。
 * 纯单测，不依赖真机 / 会话日志 / DSH 宿主。
 */
import assert from 'node:assert/strict';
import { handleAgentReplyText, messageText } from './workspace-agent.mjs';

let passed = 0;
const test = (name, fn) => {
  fn();
  passed++;
  console.log('  ok  ' + name);
};

/** 伪造一段含 ```json 围栏动作块的 Agent 回复。 */
function replyWithAction(requestId = 'req_loop_1', extra = {}) {
  const block = {
    type: 'workspace.action',
    requestId,
    action: { name: 'l2d_set_expression', parameters: { name: '兔牙' } },
    ...extra,
  };
  return '好的，我来切换表情。\n```json\n' + JSON.stringify(block) + '\n```\n已请求执行。';
}

function makeSubmit(resp) {
  const calls = [];
  const submitAction = (request) => {
    calls.push(request);
    if (resp instanceof Error) throw resp;
    return typeof resp === 'function' ? resp(request) : resp;
  };
  return { calls, submitAction };
}

const COMPLETED = {
  requestId: 'req_loop_1',
  type: 'workspace.action.result',
  status: 'completed',
  action: { name: 'l2d_set_expression' },
  summary: 'l2d_set_expression：已更新 1 个参数。',
};

test('合法动作块 → 提交（信封补全）→ 回投含摘要与 requestId/status', () => {
  const { calls, submitAction } = makeSubmit(COMPLETED);
  const acked = new Set();
  const outcome = handleAgentReplyText(replyWithAction(), { submitAction, acked });
  assert.ok(outcome);
  assert.equal(calls.length, 1);
  // 信封补全：submit 收到的是完整请求（type/requestId/action/workspace/user/responseFormat）
  assert.equal(calls[0].type, 'workspace.action');
  assert.equal(calls[0].requestId, 'req_loop_1');
  assert.equal(calls[0].action.name, 'l2d_set_expression');
  assert.equal(calls[0].workspace.id, 'dsh-l2d');
  assert.ok(calls[0].user);
  assert.ok(calls[0].responseFormat);
  // 回投内容
  assert.match(outcome.feedback, /你请求的动作已执行/);
  assert.match(outcome.feedback, /已更新 1 个参数/);
  assert.match(outcome.feedback, /requestId=req_loop_1/);
  assert.match(outcome.feedback, /status=completed/);
  assert.equal(outcome.status, 'completed');
  assert.equal(acked.has('req_loop_1'), true);
});

test('回投文本不含 ``` 围栏（防回环）', () => {
  const { submitAction } = makeSubmit((req) => ({
    ...COMPLETED,
    requestId: req.requestId,
    summary: '摘要里混入```json围栏```也要被清洗。',
  }));
  const outcome = handleAgentReplyText(replyWithAction('req_fence'), { submitAction, acked: new Set() });
  assert.ok(outcome);
  assert.equal(outcome.feedback.includes('```'), false);
  assert.equal(outcome.feedback.includes("'''"), true);
});

test('同一 requestId 只回投一次（acked 去重）', () => {
  const { calls, submitAction } = makeSubmit(COMPLETED);
  const acked = new Set();
  const text = replyWithAction('req_dup');
  assert.ok(handleAgentReplyText(text, { submitAction, acked }));
  assert.equal(handleAgentReplyText(text, { submitAction, acked }), null, '第二次返回 null');
  assert.equal(calls.length, 1, 'submit 只调一次');
});

test('无动作块 / 非法块 → null，submit 不被调用', () => {
  const { calls, submitAction } = makeSubmit(COMPLETED);
  assert.equal(handleAgentReplyText('今天天气不错，没有动作。', { submitAction, acked: new Set() }), null);
  // 缺 requestId → validateAgentActionBlock 拒绝
  const bad = '```json\n{"type":"workspace.action","action":{"name":"l2d_say"}}\n```';
  assert.equal(handleAgentReplyText(bad, { submitAction, acked: new Set() }), null);
  assert.equal(calls.length, 0);
});

test('submit 抛错 → status=failed，回投带错误信息（不重试同 requestId）', () => {
  const { calls, submitAction } = makeSubmit(new Error('channel down'));
  const acked = new Set();
  const text = replyWithAction('req_err');
  const outcome = handleAgentReplyText(text, { submitAction, acked });
  assert.ok(outcome);
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.feedback, /status=failed/);
  assert.match(outcome.feedback, /channel down/);
  assert.equal(handleAgentReplyText(text, { submitAction, acked }), null);
  assert.equal(calls.length, 1);
});

test('submit 返回 null/无信封 → status=failed + 执行结果未知', () => {
  const { submitAction } = makeSubmit(null);
  const outcome = handleAgentReplyText(replyWithAction('req_null'), { submitAction, acked: new Set() });
  assert.ok(outcome);
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.feedback, /执行结果未知/);
});

test('块内自带合法 workspace/user → 原样透传，不被覆盖', () => {
  const { calls, submitAction } = makeSubmit(COMPLETED);
  handleAgentReplyText(replyWithAction('req_ws', { workspace: { id: 'custom', name: 'X', type: 'game' }, user: { intent: '测试' } }), { submitAction, acked: new Set() });
  assert.equal(calls[0].workspace.id, 'custom');
  assert.equal(calls[0].user.intent, '测试');
});

test('空文本 / 非 submitAction → null', () => {
  assert.equal(handleAgentReplyText('', { submitAction: () => COMPLETED, acked: new Set() }), null);
  assert.equal(handleAgentReplyText(replyWithAction('req_no_fn'), { submitAction: null, acked: new Set() }), null, '未注入通道时安全降级为 null');
});

test('数组形式围栏（[block]）也能提取处理', () => {
  const { calls, submitAction } = makeSubmit(COMPLETED);
  const text = '```json\n[' + JSON.stringify({ type: 'workspace.action', requestId: 'req_arr', action: { name: 'l2d_say', parameters: { text: '嗨' } } }) + ']\n```';
  const outcome = handleAgentReplyText(text, { submitAction, acked: new Set() });
  assert.ok(outcome);
  assert.equal(calls[0].requestId, 'req_arr');
});

test('messageText：字符串与 {type:text} 数组', () => {
  assert.equal(messageText('plain'), 'plain');
  assert.equal(messageText([{ type: 'text', text: 'a' }, { type: 'image', url: 'x' }, { type: 'text', text: 'b' }]), 'a\nb');
  assert.equal(messageText([{ type: 'tool_use' }]), '');
  assert.equal(messageText(null), '');
});

console.log('\n' + passed + ' passed');
