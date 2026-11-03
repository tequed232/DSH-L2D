/**
 * webgl-recovery 逻辑测试（Node EventTarget，零 DOM 依赖）
 * 运行：node --experimental-strip-types packages/renderer/src/app/webgl-recovery.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { attachWebglRecovery } from './webgl-recovery.ts';

function dispatchLost(target, message = '') {
  const ev = new Event('webglcontextlost', { cancelable: true });
  if (message) ev.statusMessage = message;
  target.dispatchEvent(ev);
  return ev;
}

test('lost：preventDefault + 记录诊断 + onLost 通知', () => {
  const target = new EventTarget();
  const seen = [];
  const h = attachWebglRecovery(target, { onLost: (info) => seen.push(info) });

  const ev = dispatchLost(target, 'GPU驱动重置');
  assert.equal(ev.defaultPrevented, true, '必须 preventDefault 才会派发 restored');
  assert.equal(h.isLost(), true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].message, 'GPU驱动重置');
  assert.equal(h.lastLost().message, 'GPU驱动重置');
  assert.ok(typeof h.lastLost().at === 'number');
});

test('restored：onRestored 通知，状态复位', () => {
  const target = new EventTarget();
  let lostCalls = 0;
  let restoredCalls = 0;
  const h = attachWebglRecovery(target, {
    onLost: () => lostCalls++,
    onRestored: () => restoredCalls++,
  });

  dispatchLost(target, '驱动崩溃');
  target.dispatchEvent(new Event('webglcontextrestored'));
  assert.equal(lostCalls, 1);
  assert.equal(restoredCalls, 1);
  assert.equal(h.isLost(), false, '恢复后 lost 状态应复位');
  assert.equal(h.lastLost().message, '驱动崩溃', '诊断记录在恢复后保留');
});

test('没有 lost 就来 restored：不触发 onRestored', () => {
  const target = new EventTarget();
  let restoredCalls = 0;
  attachWebglRecovery(target, { onRestored: () => restoredCalls++ });
  target.dispatchEvent(new Event('webglcontextrestored'));
  assert.equal(restoredCalls, 0);
});

test('detach 后不再收事件', () => {
  const target = new EventTarget();
  let calls = 0;
  const h = attachWebglRecovery(target, {
    onLost: () => calls++,
    onRestored: () => calls++,
  });
  h.detach();
  dispatchLost(target);
  target.dispatchEvent(new Event('webglcontextrestored'));
  assert.equal(calls, 0, 'detach 后监听应已移除');
});

test('重复 lost 只记第一次；回调抛异常不炸事件处理', () => {
  const target = new EventTarget();
  const seen = [];
  const h = attachWebglRecovery(target, {
    onLost: (info) => {
      seen.push(info.message);
      throw new Error('callback boom');
    },
  });
  dispatchLost(target, 'first');
  dispatchLost(target, 'second');
  assert.deepEqual(seen, ['first']);
  assert.equal(h.isLost(), true);

  target.dispatchEvent(new Event('webglcontextrestored'));
  assert.equal(h.isLost(), false, '回调抛异常后 restored 仍应复位状态');
});

test('statusMessage 缺省为空串且不炸', () => {
  const target = new EventTarget();
  const h = attachWebglRecovery(target, { onLost: () => {} });
  dispatchLost(target);
  assert.equal(h.lastLost().message, '');
});
