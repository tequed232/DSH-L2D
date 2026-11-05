/**
 * dsh-l2d-db · Safety Guard 双层边界测试（2026-11-05 用户裁决回归）
 * 运行：node packages/dsh-l2d-db/test/safety-guard.test.mjs
 */
import assert from 'node:assert/strict';
import { resolveInjectionWindow, checkInjection, checkInjectionBatch } from '../src/safety-guard.mjs';

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  [OK] ${name}`);
}

// 用户裁决案例：Param39 —— Hard [-1,1]（moc3），Soft [0, 0.322]（w3-registry 实测）
const PARAM39 = { param_id: 'Param39', min_value: -1, max_value: 1, soft_min: 0, soft_max: 0.322 };

test('Param39 dual-layer: value within soft envelope passes', () => {
  const r = checkInjection(PARAM39, 0.2);
  assert.equal(r.ok, true);
  assert.equal(r.layer, 'soft');
  assert.equal(r.value, 0.2);
});

test('Param39 dual-layer: 0.5 exceeds soft but within hard -> allowed (non-strict) with suggestion', () => {
  const r = checkInjection(PARAM39, 0.5);
  assert.equal(r.ok, true, 'Hard 内不硬拒');
  assert.equal(r.layer, 'soft_exceeded');
  assert.equal(r.suggestedValue, 0.322, '建议值 = Soft 上界');
  assert.equal(r.value, 0.5, '非 strict 不改写注入值');
});

test('Param39 dual-layer: strict mode clamps 0.5 to soft upper bound', () => {
  const r = checkInjection(PARAM39, 0.5, { strict: true });
  assert.equal(r.ok, true);
  assert.equal(r.code, 'SOFT_CLAMPED');
  assert.equal(r.value, 0.322);
});

test('Param39 dual-layer: below soft lower bound (negative side) also flags soft_exceeded', () => {
  const r = checkInjection(PARAM39, -0.5);
  assert.equal(r.ok, true);
  assert.equal(r.layer, 'soft_exceeded');
  assert.equal(r.suggestedValue, 0);
});

test('Param39 dual-layer: 1.5 breaks hard boundary -> REJECTED, never injected', () => {
  const r = checkInjection(PARAM39, 1.5);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'HARD_BOUNDARY_VIOLATION');
});

test('Param39 dual-layer: -1.001 (marginal) breaks hard boundary -> REJECTED', () => {
  const r = checkInjection(PARAM39, -1.001);
  assert.equal(r.ok, false);
});

test('no hard boundary -> fail-closed (read-only monitoring)', () => {
  const noRange = { min_value: null, max_value: null, soft_min: null, soft_max: null };
  const r = checkInjection(noRange, 0.1);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NO_HARD_BOUNDARY');
});

test('hard-only param (no soft envelope) passes within hard', () => {
  const hardOnly = { min_value: -45, max_value: 45, soft_min: null, soft_max: null };
  const r = checkInjection(hardOnly, 45);
  assert.equal(r.ok, true);
  assert.equal(r.layer, 'hard_only');
});

test('invalid value rejected', () => {
  const r = checkInjection(PARAM39, NaN);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'INVALID_VALUE');
});

test('batch: any hard violation rejects the whole batch (atomicity)', () => {
  const lookup = (id) => (id === 'P_OK' ? PARAM39 : { min_value: -10, max_value: 10, soft_min: null, soft_max: null });
  const batch = checkInjectionBatch(
    [{ paramId: 'P_OK', value: 0.1 }, { paramId: 'P_BAD', value: 99 }],
    lookup,
  );
  assert.equal(batch.ok, false);
  assert.equal(batch.violations.length, 1);
  assert.equal(batch.violations[0].code, 'HARD_BOUNDARY_VIOLATION');
});

test('batch: all within envelope passes', () => {
  const lookup = () => PARAM39;
  const batch = checkInjectionBatch(
    [{ paramId: 'a', value: 0.1 }, { paramId: 'b', value: 0.3 }],
    lookup,
  );
  assert.equal(batch.ok, true);
  assert.equal(batch.results.length, 2);
});

test('soft with inverted range is ignored (falls back to hard-only)', () => {
  const weird = { min_value: -1, max_value: 1, soft_min: 0.8, soft_max: 0.2 };
  const { soft } = resolveInjectionWindow(weird);
  assert.equal(soft, null);
  const r = checkInjection(weird, 0.5);
  assert.equal(r.ok, true);
  assert.equal(r.layer, 'hard_only');
});

console.log(`\nsafety-guard: ${passed} tests passed`);
