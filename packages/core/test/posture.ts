/**
 * E2 l2d_posture 纯函数层测试：不依赖真机、不依赖 overlay。
 *
 * 重点验证四件事：
 *   1. 归一化值越界被夹取到 -1..1，durationMs 缺省 4000；
 *   2. unsupported / unknown 通道不产生任何写入，只进 skipped；
 *   3. owns 收集正确：requires-own 必进，own:true 把 direct 也收进来；
 *   4. 回执对账：skipped / degraded 显式可见，执行结果不静默丢失。
 *
 * 注意：fixture 里的 AngleX / LArm 等是测试素材，不允许出现在 src 实现里。
 */
import assert from 'node:assert/strict';
import {
  normalizePostureInput,
  planPostureExecution,
  shapePostureReceipt,
  POSTURE_DURATION_DEFAULT_MS,
  POSTURE_DURATION_MIN_MS,
  POSTURE_DURATION_MAX_MS,
} from '../src/posture.ts';
import type { ModelMotionProfile } from '../src/motion-contract.ts';

let passed = 0;
const test = (name: string, fn: () => void) => {
  fn();
  passed++;
  console.log('  ok  ' + name);
};

const fixture: ModelMotionProfile = {
  contractVersion: 3,
  modelId: 'fixture',
  adapterId: 'cubism',
  profileRevision: 'r-test',
  controls: [
    { id: 'head.yaw', status: 'supported', min: -1, max: 1, neutral: 0, confidence: 0.95, sourceId: 'AngleX', ownership: 'direct' },
    { id: 'arm.left.raise', status: 'supported', min: -1, max: 1, neutral: 0, confidence: 0.8, sourceId: 'LArm', ownership: 'requires-own' },
    { id: 'torso.contraction', status: 'approximate', min: -1, max: 1, neutral: 0, confidence: 0.6, sourceId: 'ShoulderX+ShoulderZ', ownership: 'requires-own' },
    { id: 'leg.left.bend', status: 'unsupported', min: -1, max: 1, neutral: 0, confidence: 0, reason: '模型无膝关节参数' },
    { id: 'gaze.x', status: 'unknown', min: -1, max: 1, neutral: 0, confidence: 0, reason: '尚未探测' },
  ],
  assets: [],
} as ModelMotionProfile;

test('values 越界被夹取到 -1..1，非数值回落 0', () => {
  const n = normalizePostureInput({ values: { 'head.yaw': 7, 'arm.left.raise': -3, 'gaze.x': Number.NaN } });
  assert.equal(n.values['head.yaw'], 1);
  assert.equal(n.values['arm.left.raise'], -1);
  assert.equal(n.values['gaze.x'], 0);
});

test('durationMs 缺省 4000，越界夹到 500~30000', () => {
  assert.equal(normalizePostureInput({ values: {} }).durationMs, POSTURE_DURATION_DEFAULT_MS);
  assert.equal(normalizePostureInput({ values: {}, durationMs: 100 }).durationMs, POSTURE_DURATION_MIN_MS);
  assert.equal(normalizePostureInput({ values: {}, durationMs: 99999 }).durationMs, POSTURE_DURATION_MAX_MS);
  assert.equal(normalizePostureInput({ values: {}, durationMs: 2500 }).durationMs, 2500);
  // 非数值一律回落缺省
  assert.equal(normalizePostureInput({ values: {}, durationMs: Number.NaN }).durationMs, POSTURE_DURATION_DEFAULT_MS);
});

test('fadeMs 缺省 undefined，超过 durationMs 被夹到 durationMs', () => {
  assert.equal(normalizePostureInput({ values: {} }).fadeMs, undefined);
  assert.equal(normalizePostureInput({ values: {}, fadeMs: 300, durationMs: 1000 }).fadeMs, 300);
  assert.equal(normalizePostureInput({ values: {}, fadeMs: 5000, durationMs: 1000 }).fadeMs, 1000);
});

test('unsupported / unknown 通道不产生任何写入，只进 skipped', () => {
  const exec = planPostureExecution(fixture, { values: { 'leg.left.bend': 1, 'gaze.x': 0.5 } });
  assert.equal(exec.plan.writes.length, 0);
  assert.equal(exec.pre.length + exec.post.length, 0);
  assert.equal(exec.owns.length, 0);
  assert.equal(exec.skipped.length, 2);
  const bend = exec.skipped.find((s) => s.channel === 'leg.left.bend')!;
  assert.equal(bend.status, 'unsupported');
  assert.ok(bend.reason.length > 0, 'skipped 必须带 reason');
  assert.equal(exec.skipped.find((s) => s.channel === 'gaze.x')!.status, 'unknown');
});

test('owns 收集正确：requires-own 必进且去重，direct 不进', () => {
  const exec = planPostureExecution(fixture, { values: { 'head.yaw': 0.4, 'arm.left.raise': 0.8, 'torso.contraction': 0.6 } });
  assert.deepEqual(exec.owns.sort(), ['LArm', 'ShoulderX', 'ShoulderZ']);
  // 分相位：direct → pre，requires-own → post
  assert.deepEqual(exec.pre.map((w) => w.channel), ['head.yaw']);
  assert.deepEqual(exec.post.map((w) => w.channel).sort(), ['arm.left.raise', 'torso.contraction']);
});

test('own:true 把 direct 参数也收进 owns；own 不影响 skipped', () => {
  const exec = planPostureExecution(fixture, { values: { 'head.yaw': 0.4, 'leg.left.bend': 1 }, own: true });
  assert.deepEqual(exec.owns, ['AngleX']);
  assert.equal(exec.skipped.length, 1);
});

test('approximate 通道标 degraded 且回执可见', () => {
  const exec = planPostureExecution(fixture, { values: { 'torso.contraction': 0.6, 'head.yaw': 0.2 } });
  assert.deepEqual(exec.degraded, [{ channel: 'torso.contraction', status: 'approximate', params: ['ShoulderX', 'ShoulderZ'] }]);
});

test('回执对账：applied / failed / skipped / degraded 全部显式', () => {
  const exec = planPostureExecution(fixture, { values: { 'head.yaw': 0.4, 'arm.left.raise': 0.8, 'leg.left.bend': 1 } });
  const receipt = shapePostureReceipt(exec, ['AngleX', 'LArm'], []);
  assert.equal(receipt.ok, true);
  assert.deepEqual(receipt.applied.map((a) => a.id).sort(), ['AngleX', 'LArm']);
  assert.equal(receipt.failed.length, 0);
  assert.deepEqual(receipt.owned, ['LArm']);
  assert.equal(receipt.skipped.length, 1);
  assert.equal(receipt.durationMs, POSTURE_DURATION_DEFAULT_MS);
});

test('回执对账：漏报的参数按 no-result 进 failed，不静默丢失', () => {
  const exec = planPostureExecution(fixture, { values: { 'head.yaw': 0.4, 'arm.left.raise': 0.8 } });
  const receipt = shapePostureReceipt(exec, ['AngleX'], [{ id: 'LArm', reason: 'ownership-busy' }]);
  assert.equal(receipt.ok, false, '有失败写入时 ok 必须是 false');
  assert.deepEqual(receipt.failed, [{ id: 'LArm', value: 0.8, channel: 'arm.left.raise', reason: 'ownership-busy' }]);
  const silent = shapePostureReceipt(exec, ['AngleX'], []);
  assert.equal(silent.failed[0].reason, 'no-result');
});

test('全 skipped 时回执 ok=true 但 applied 为空，降级不静默', () => {
  const exec = planPostureExecution(fixture, { values: { 'leg.left.bend': 1 } });
  const receipt = shapePostureReceipt(exec, [], []);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.applied.length, 0);
  assert.equal(receipt.skipped.length, 1);
  assert.ok(receipt.skipped[0].reason.length > 0);
});

if (process.exitCode) console.error('\nposture 测试失败\n');
else console.log(`\n${passed} passed\n`);
