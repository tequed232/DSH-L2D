/**
 * Phase 5a · 旧决策层观测指标测试。
 *
 * 直跑：node packages/mcp-bridge/tests/legacy-metrics.test.mjs
 * 守的是"能不能放行删文件"这件事：legacyDecisionCount / legacyBlockedCount 必须真实可读，
 * 且 reset 后归零 —— 否则 7 天观察期拿不到可信数据。
 */
import assert from 'node:assert/strict';
import { COUNTER_NAMES, createMetrics } from '../metrics.mjs';

let passed = 0;
function it(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err && err.message}`);
    process.exitCode = 1;
  }
}

console.log('Phase 5a 旧决策层观测');

it('两个旧决策计数器已注册（否则增量永远取不到）', () => {
  assert.ok(COUNTER_NAMES.includes('legacyDecisionCount'));
  assert.ok(COUNTER_NAMES.includes('legacyBlockedCount'));
});

it('snapshot 初始为 0，且随 increment 递增', () => {
  const m = createMetrics();
  assert.equal(m.snapshot().counters.legacyDecisionCount, 0);
  m.increment('legacyDecisionCount');
  m.increment('legacyDecisionCount');
  m.increment('legacyBlockedCount');
  const snap = m.snapshot();
  assert.equal(snap.counters.legacyDecisionCount, 2);
  assert.equal(snap.counters.legacyBlockedCount, 1);
});

it('未知计数器名仍然抛错（不允许悄悄吞掉拼写错误）', () => {
  const m = createMetrics();
  assert.throws(() => m.increment('legacyDecisionCont'), /未知|unknown/i);
});

it('reset 后两个计数器归零（观察期重新计数）', () => {
  const m = createMetrics();
  m.increment('legacyDecisionCount', 5);
  m.increment('legacyBlockedCount', 3);
  m.reset();
  const snap = m.snapshot();
  assert.equal(snap.counters.legacyDecisionCount, 0);
  assert.equal(snap.counters.legacyBlockedCount, 0);
});

it('放行判据可用：两个计数器同时为 0 才允许进入删文件阶段', () => {
  const m = createMetrics();
  const gateOpen = () =>
    m.snapshot().counters.legacyDecisionCount === 0 && m.snapshot().counters.legacyBlockedCount === 0;
  assert.equal(gateOpen(), true);
  m.increment('legacyDecisionCount');
  assert.equal(gateOpen(), false, '还有旧决策调用时不得放行');
});

console.log('');
if (process.exitCode) {
  console.error('legacy-metrics: 存在失败');
  process.exit(1);
}
console.log(`legacy-metrics: ${passed} 项全部通过`);
