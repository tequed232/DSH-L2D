/**
 * E1 语义姿态：从「通道值」到「参数写入计划」。
 *
 * 重点验证三件事：
 *   1. 不支持的能力必须**显式跳过**并给原因，不能悄悄写别的参数凑数；
 *   2. 命中物理输出的写入必须标 requires-own / post，否则会被 physics 覆盖；
 *   3. 真实模型画像下，「害羞」这组通道能被正确拆成可执行与不可执行两部分。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planSemanticPosture, canExpress } from '../src/semantic-binding.ts';
import type { ModelMotionProfile } from '../src/motion-contract.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
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

test('直写通道：单参数、pre 相位、不需要 own', () => {
  const plan = planSemanticPosture(fixture, { 'head.yaw': 0.5 });
  assert.equal(plan.writes.length, 1);
  const w = plan.writes[0];
  assert.equal(w.params.length, 1);
  assert.deepEqual(w.params[0], { id: 'AngleX', value: 0.5 });
  assert.equal(w.phase, 'pre');
  assert.equal(w.ownership, 'direct');
  assert.deepEqual(plan.owns, []);
});

test('物理输出通道：post 相位且要求 own', () => {
  const plan = planSemanticPosture(fixture, { 'arm.left.raise': 0.8 });
  assert.equal(plan.writes[0].phase, 'post');
  assert.deepEqual(plan.owns, ['LArm']);
});

test('组合通道：拆成多个参数，标 approximate', () => {
  const plan = planSemanticPosture(fixture, { 'torso.contraction': 0.7 });
  const w = plan.writes[0];
  assert.equal(w.status, 'approximate');
  assert.deepEqual(w.params.map((p) => p.id), ['ShoulderX', 'ShoulderZ']);
  assert.deepEqual(plan.owns, ['ShoulderX', 'ShoulderZ']);
});

test('不支持 / 未知通道必须跳过并给原因，不得写别的参数', () => {
  const plan = planSemanticPosture(fixture, { 'leg.left.bend': 1, 'gaze.x': 0.5, 'hand.left.pose': 1 });
  assert.equal(plan.writes.length, 0, '不支持的能力不能产生任何写入');
  assert.equal(plan.skipped.length, 3);
  const bend = plan.skipped.find((s) => s.channel === 'leg.left.bend')!;
  assert.equal(bend.status, 'unsupported');
  assert.match(bend.reason, /膝关节/);
  const unknown = plan.skipped.find((s) => s.channel === 'hand.left.pose')!;
  assert.equal(unknown.status, 'unknown');
});

test('归一化值越界会被夹到通道量程内', () => {
  const plan = planSemanticPosture(fixture, { 'head.yaw': 9 });
  assert.equal(plan.writes[0].params[0].value, 1);
  const plan2 = planSemanticPosture(fixture, { 'head.yaw': -9 });
  assert.equal(plan2.writes[0].params[0].value, -1);
});

test('canExpress 与 profile 状态一致', () => {
  assert.equal(canExpress(fixture, 'head.yaw'), true);
  assert.equal(canExpress(fixture, 'torso.contraction'), true);
  assert.equal(canExpress(fixture, 'leg.left.bend'), false);
  assert.equal(canExpress(fixture, 'gaze.x'), false);
  assert.equal(canExpress(fixture, 'nope'), false);
});

test('真实模型：害羞姿态能拆成可执行 + 明确降级两部分', () => {
  const dir = path.join(ROOT, 'tools', 'capability-scan');
  const files = fs.readdirSync(dir).filter((f) => /^profile\..+\.json$/.test(f));
  if (!files.length) {
    console.log('  ..  跳过：还没有生成画像');
    return;
  }
  const profile = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8')) as ModelMotionProfile;

  // 害羞：低头、视线回避、缩肩、双臂内收、身体略后仰；腿并拢在本模型上不可表达
  const shy = {
    'head.pitch': 0.6,
    'head.yaw': -0.25,
    'gaze.x': -0.7,
    'gaze.y': -0.3,
    'torso.contraction': 0.8,
    'torso.lean': -0.2,
    'arm.left.inward': 0.9,
    'arm.right.inward': 0.9,
    'leg.left.inward': 0.8,
    'leg.right.inward': 0.8,
  };
  const plan = planSemanticPosture(profile, shy);

  const written = new Set(plan.writes.map((w) => w.channel));
  for (const id of ['head.pitch', 'gaze.x', 'torso.contraction', 'arm.left.inward', 'arm.right.inward']) {
    assert.ok(written.has(id), '这条通道应当可表达: ' + id);
  }
  const legs = plan.skipped.filter((s) => s.channel.startsWith('leg.'));
  assert.equal(legs.length, 2, '腿部必须是显式降级，而不是被静默忽略');
  for (const l of legs) assert.equal(l.status, 'unsupported');

  // 物理输出必须进 owns，否则写进去会被物理覆盖
  assert.ok(plan.owns.length > 0, '至少手臂是物理输出');
  for (const id of plan.owns) assert.ok(profile.controls.some((c) => String(c.sourceId || '').split('+').includes(id)));
});

if (process.exitCode) console.error('\n语义绑定测试失败\n');
else console.log(`\n${passed} passed\n`);
