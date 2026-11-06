/**
 * PR-D 真实完成事件总线单测（PRD-RUNTIME-EVENT）。
 * 运行：node --experimental-strip-types packages/renderer/src/app/action-completion.test.mjs
 * 纯逻辑模块，不需要浏览器实例。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompletionBus } from './action-completion.ts';

test('订阅者按 executionId 收到完成事件，退订后不再收到', () => {
  const bus = createCompletionBus();
  const got = [];
  const unsub = bus.subscribe((e) => got.push(e));
  assert.equal(bus.listenerCount(), 1);

  bus.emit({ kind: 'motion', executionId: '7', group: '竖手指打开', phase: 'end', owned: [] });
  assert.equal(got.length, 1);
  assert.equal(got[0].kind, 'motion');
  assert.equal(got[0].executionId, '7');
  assert.equal(got[0].phase, 'end');

  unsub();
  assert.equal(bus.listenerCount(), 0);
  bus.emit({ kind: 'keyframes', executionId: '7', group: '', phase: 'end', owned: ['ParamAngleZ'] });
  assert.equal(got.length, 1, '退订后不得再派发');
});

test('监听方异常不反噬派发方，其余监听者照常收到', () => {
  const bus = createCompletionBus();
  const got = [];
  bus.subscribe(() => {
    throw new Error('监听方故障');
  });
  bus.subscribe((e) => got.push(e));
  bus.emit({ kind: 'keyframes', executionId: '3', group: '', phase: 'end', owned: [] });
  assert.equal(got.length, 1, '坏监听者不能吞掉好监听者的事件');
  assert.equal(bus.listenerCount(), 2, '异常不触发退订');
});

test('派发中途注册的监听者不收当前事件，下一轮生效（快照遍历）', () => {
  const bus = createCompletionBus();
  const late = [];
  bus.subscribe(() => {
    bus.subscribe((e) => late.push(e));
  });
  bus.emit({ kind: 'motion', executionId: '1', group: 'g', phase: 'end', owned: [] });
  assert.equal(late.length, 0, '快照遍历：本轮注册者不收本轮事件');
  bus.emit({ kind: 'motion', executionId: '2', group: 'g', phase: 'end', owned: [] });
  assert.equal(late.length, 1, '下一轮起正常派发');
});

test('PR-A 三态：事件总线透传 end / interrupted / failed 与 reason', () => {
  const bus = createCompletionBus();
  const got = [];
  bus.subscribe((e) => got.push(e));
  bus.emit({ kind: 'motion', executionId: '10', group: 'g', phase: 'failed', reason: 'start-rejected', owned: [] });
  bus.emit({ kind: 'keyframes', executionId: '11', group: '', phase: 'interrupted', reason: 'stop-called', owned: [] });
  bus.emit({ kind: 'motion', executionId: '12', group: 'g', phase: 'end', owned: [] });
  assert.equal(got.length, 3);
  assert.equal(got[0].phase, 'failed');
  assert.equal(got[0].reason, 'start-rejected');
  assert.equal(got[1].phase, 'interrupted');
  assert.equal(got[1].reason, 'stop-called');
  assert.equal(got[2].phase, 'end');
  assert.equal(got[2].reason, undefined, 'end 事件不携带 reason');
  const phases = new Set(got.map((e) => e.phase));
  assert.equal(phases.size, 3, '三态必须是三种不同状态');
});
