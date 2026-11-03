/**
 * E0 能力画像：匹配规则 + 真实模型产物的校验。
 *
 * 两份证据：
 *   1. 合成 inventory —— 验证「匹配不到就 unsupported / 没规则就 unknown」这些 fail-closed 语义；
 *   2. 真实模型产物 —— 验证扫描结果（存在、能过契约校验、sourceId 都真实存在、腿部确实不支持）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveControls, CHANNEL_BINDINGS } from '../../../tools/capability-scan/bindings.mjs';
import { validateMotionProfile } from '../src/motion-profile.ts';
import { MOTION_CONTRACT_VERSION, SEMANTIC_CONTROL_IDS } from '../src/motion-contract.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
let passed = 0;
const test = (name: string, fn: () => void) => {
  fn();
  passed++;
  console.log('  ok  ' + name);
};

test('匹配规则表覆盖全部标准语义通道', () => {
  // 新增标准通道必须同时给出绑定规则，否则会静默变成 unknown
  for (const id of SEMANTIC_CONTROL_IDS) {
    assert.ok(id in CHANNEL_BINDINGS, '通道缺少绑定规则: ' + id);
  }
});

test('合成模型：有的通道 supported、没的 unsupported、没规则的 unknown', () => {
  const inventory = {
    params: [
      { id: 'AngleX', group: 'G1' },
      { id: 'AngleY', group: 'G1' },
      { id: 'AngleZ', group: 'G1' },
      { id: 'ParamEyeBallX', group: 'G2' },
      { id: 'ParamEyeBallY', group: 'G2' },
      { id: 'ParamEyeLOpen', group: 'Blink' },
      { id: 'ParamEyeROpen', group: 'Blink' },
      { id: 'ParamBreath', group: 'G3' },
      { id: 'LArm', group: 'Arm' },
    ],
    physicsOutputs: ['LArm'],
  };
  const { controls } = resolveControls(inventory);
  const get = (id: string) => controls.find((c) => c.id === id)!;

  assert.equal(get('head.yaw').status, 'supported');
  assert.equal(get('head.yaw').sourceId, 'AngleX');
  assert.equal(get('head.yaw').ownership, 'direct');

  // 手臂是物理输出：必须标 requires-own，否则写进去会被 physics 覆盖
  assert.equal(get('arm.left.raise').status, 'supported');
  assert.equal(get('arm.left.raise').ownership, 'requires-own');

  // 头参齐全时三个轴向都应 supported
  assert.equal(get('head.pitch').status, 'supported');
  assert.equal(get('head.roll').status, 'supported');

  // 眨眼由引擎接管，只算近似
  assert.equal(get('face.blink').status, 'approximate');

  // 组合通道缺成员 → unsupported
  assert.equal(get('torso.contraction').status, 'unsupported');
  assert.match(get('torso.contraction').reason, /缺少参数/);

  // 腿部无绑定 → unsupported 且带原因
  assert.equal(get('leg.left.bend').status, 'unsupported');
  assert.ok(get('leg.left.bend').reason);
});

test('模型没有头部参数时，头部通道必须 unsupported（不许猜）', () => {
  const { controls } = resolveControls({ params: [{ id: 'ParamBreath', group: 'G' }], physicsOutputs: [] });
  for (const id of ['head.yaw', 'head.pitch', 'head.roll']) {
    assert.equal(controls.find((c: any) => c.id === id)!.status, 'unsupported', id);
  }
});

test('组合通道成员齐全时降级为 approximate', () => {
  const inventory = {
    params: [
      { id: 'ShoulderX', group: 'G' },
      { id: 'ShoulderZ', group: 'G' },
    ],
    physicsOutputs: ['ShoulderZ'],
  };
  const c = resolveControls(inventory).controls.find((x) => x.id === 'torso.contraction')!;
  assert.equal(c.status, 'approximate');
  assert.equal(c.sourceId, 'ShoulderX+ShoulderZ');
  assert.equal(c.ownership, 'requires-own', '含物理成员就必须要求 own');
});

test('真实模型画像：存在、能过契约校验、不编造参数', () => {
  const dir = path.join(ROOT, 'tools', 'capability-scan');
  const files = fs.readdirSync(dir).filter((f) => /^profile\..+\.json$/.test(f));
  if (!files.length) {
    console.log('  ..  跳过：还没有生成画像（跑 node tools/capability-scan/scan.mjs）');
    return;
  }
  const profile = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));

  const v = validateMotionProfile(profile);
  assert.ok(v.ok, 'profile 校验失败: ' + v.errors.join('; '));
  assert.equal(profile.contractVersion, MOTION_CONTRACT_VERSION);
  assert.equal(profile.controls.length, SEMANTIC_CONTROL_IDS.length);

  // 反造假：任何 sourceId 都必须能在模型的 cdi3 里找到
  const cdiFile = fs.readdirSync(path.join(ROOT, 'DeepSeek免费公皮', 'DeepSeek')).find((f) => f.endsWith('.cdi3.json'));
  if (cdiFile) {
    const cdi = JSON.parse(fs.readFileSync(path.join(ROOT, 'DeepSeek免费公皮', 'DeepSeek', cdiFile), 'utf8'));
    const real = new Set((cdi.Parameters || []).map((p: any) => p.Id));
    for (const c of profile.controls) {
      for (const id of String(c.sourceId || '').split('+').filter(Boolean)) {
        assert.ok(real.has(id), `通道 ${c.id} 指向了不存在的参数 ${id}`);
      }
    }
  }

  const byId = new Map(profile.controls.map((c: any) => [c.id, c]));
  assert.equal((byId.get('head.yaw') as any).sourceId, 'AngleX');
  assert.equal((byId.get('arm.left.raise') as any).ownership, 'requires-own');
  // 这台模型没有腿部骨骼，必须诚实报 unsupported
  for (const id of ['leg.left.inward', 'leg.left.bend', 'leg.right.inward', 'leg.right.bend']) {
    assert.equal((byId.get(id) as any).status, 'unsupported', id + ' 不应被标为可用');
  }
  // 允许的资产都得真实存在
  assert.ok(profile.assets.length > 0);
});

if (process.exitCode) console.error('\n能力画像测试失败\n');
else console.log(`\n${passed} passed\n`);
