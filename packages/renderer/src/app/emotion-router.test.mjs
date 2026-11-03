import test from 'node:test';
import assert from 'node:assert/strict';
import { EmotionRouter } from './emotion-router.ts';

/**
 * 回归：error 状态必须能被「恢复信号」清掉。
 *
 * 旧实现只在 d.state === 'error' 时写 lastErrorAt，任何非 error 的 state
 * 信号都被忽略，于是 lastErrorAt 永不清零 —— 宿主 lastError 早已恢复空串，
 * 角色却一直停在 ctx=error / 挂着「流冷汗」。实机复现：重启后
 * get_state() 返回 emotion.ctx=error 而 lastError="none"。
 */
test('state=error 点火，state=恢复 清零', () => {
  const r = new EmotionRouter();
  const t0 = 5_000_000;

  r.ingest({ type: 'state', data: { state: 'error' }, at: t0 });
  assert.equal(r.getContext(), 'error', 'error 信号应让上下文进入 error');

  r.ingest({ type: 'state', data: { state: 'working' }, at: t0 + 100 });
  assert.notEqual(r.getContext(), 'error', '恢复信号必须清掉 error 上下文');
});

test('error 不因空 state 被误清', () => {
  const r = new EmotionRouter();
  const t0 = 6_000_000;

  r.ingest({ type: 'state', data: { state: 'error' }, at: t0 });
  // 缺 state 字段的信号不该被当成恢复
  r.ingest({ type: 'state', data: {}, at: t0 + 100 });
  assert.equal(r.getContext(), 'error');
});

test('error 10s 后自然过期（无恢复信号也能回退）', () => {
  const r = new EmotionRouter();
  const t0 = 7_000_000;

  r.ingest({ type: 'state', data: { state: 'error' }, at: t0 });
  r.tick(t0 + 11000);
  assert.notEqual(r.getContext(), 'error');
});
