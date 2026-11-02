import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentPlanContext, MAX_AGENT_PLAN_SEGMENTS, validateAgentPlan } from './action-planner.mjs';

const caps = { expressions: ['兔牙', '流冷汗'], motions: ['竖手指打开', '竖手指关闭'] };

test('accepts a valid dynamic multi-step plan and bounds bubble', () => {
  const result = validateAgentPlan({
    chain: [
      { kind: 'look', x: 0.2, y: 0.1 },
      { kind: 'expression', name: '兔牙', delayMs: 100 },
      { kind: 'motion', name: '竖手指打开', closeMotion: '竖手指关闭', closeAfterMs: 1800, delayMs: 120 },
    ],
    bubble: '  完成啦！  ',
    continue: true,
    rationale: 'positive response',
  }, caps);
  assert.equal(result.ok, true);
  assert.equal(result.chain.length, 3);
  assert.equal(result.bubble, '完成啦！');
  assert.equal(result.continue, true);
});

test('rejects invented expression, motion and unsupported low-level keyframes', () => {
  for (const step of [
    { kind: 'expression', name: 'not-in-model' },
    { kind: 'motion', name: 'not-in-model' },
    { kind: 'keyframes', tracks: [] },
  ]) {
    assert.equal(validateAgentPlan({ chain: [step] }, caps).ok, false);
  }
});

test('rejects too many steps and invalid motion close pair', () => {
  assert.equal(validateAgentPlan({ chain: Array(7).fill({ kind: 'look', x: 0, y: 0 }) }, caps).ok, false);
  assert.equal(validateAgentPlan({
    chain: [{ kind: 'motion', name: '竖手指打开', closeMotion: '抚胸手关闭', closeAfterMs: 900 }],
  }, caps).ok, false);
});

test('bounds context and receipt; caps segment index', () => {
  const context = buildAgentPlanContext({
    state: 'thinking',
    lastUserText: 'x'.repeat(900),
    segment: 99,
    receipt: { outcome: 'completed', notes: ['a', 'b', 'c', 'd', 'e'] },
  });
  assert.equal(context.lastUserText.length, 500);
  assert.equal(context.segment, MAX_AGENT_PLAN_SEGMENTS);
  assert.equal(context.receipt.notes.length, 4);
});
