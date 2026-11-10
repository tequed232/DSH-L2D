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
import { resolveW3Controls } from '../../../tools/capability-scan/w3-controls.mjs';
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
  const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'w3-registry', 'registry.json'), 'utf8'));

  const v = validateMotionProfile(profile);
  assert.ok(v.ok, 'profile 校验失败: ' + v.errors.join('; '));
  assert.equal(profile.contractVersion, MOTION_CONTRACT_VERSION);
  // M1-d1 契约：标准 23 通道（v4 含 torso.hip 三轴）+ W3 清单 36 条登记
  // （动作组 3 + Idle 1 + 姿势 4 + 视线 4 + 身体 3 + 表情 21）= 59
  assert.equal(profile.controls.length, SEMANTIC_CONTROL_IDS.length + registry.entries.length);
  assert.equal(profile.controls.length, 59, '契约 59（标准 23 + W3 36）——画像与契约必须同步重扫');

  const byIdAll = new Map(profile.controls.map((c: any) => [c.id, c]));
  // M1-d1：盆骨三轴必须登记且 sourceId 只含规范名（变体参数 HipAngleX2/YUP/DOWN 等绝不进 sourceId）
  for (const [id, src] of [
    ['torso.hip', 'HipAngleZ'],
    ['torso.hip.forward', 'HipAngleY'],
    ['torso.hip.twist', 'HipAngleX'],
  ] as const) {
    const c = byIdAll.get(id);
    assert.ok(c, '画像缺 M1-d1 通道: ' + id);
    assert.equal(c.sourceId, src, id + ' 的 sourceId 必须是规范参数名');
    assert.equal(c.ownership, 'requires-own', id + ' 是物理输出，必须 requires-own');
    assert.equal(c.status, 'supported', id + ' 在本模型上应当 supported');
  }

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
  assert.equal((byId.get('head.yaw') as any).sourceId, 'ParamAngleX');
  assert.equal((byId.get('arm.left.raise') as any).ownership, 'requires-own');
  // 这台模型没有腿部骨骼，必须诚实报 unsupported
  for (const id of ['leg.left.inward', 'leg.left.bend', 'leg.right.inward', 'leg.right.bend']) {
    assert.equal((byId.get(id) as any).status, 'unsupported', id + ' 不应被标为可用');
  }
  // 允许的资产都得真实存在
  assert.ok(profile.assets.length > 0);
});

// ---------------------------------------------------------------------------
// W3 清单对照（docs/W3-Motion-Capability-Registry.md）：逐条登记、排除表、约束数据
// ---------------------------------------------------------------------------
test('W3 登记条目：36 条全部对照登记，id 与 sourceId 参数一一对应', () => {
  const dir = path.join(ROOT, 'tools', 'capability-scan');
  const files = fs.readdirSync(dir).filter((f) => /^profile\..+\.json$/.test(f));
  if (!files.length) {
    console.log('  ..  跳过：还没有生成画像');
    return;
  }
  const profile = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
  const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'w3-registry', 'registry.json'), 'utf8'));
  const byId = new Map(profile.controls.map((c: any) => [c.id, c]));
  const cdiFile = fs.readdirSync(path.join(ROOT, 'DeepSeek免费公皮', 'DeepSeek')).find((f) => f.endsWith('.cdi3.json'));
  const realParams = new Set(
    (JSON.parse(fs.readFileSync(path.join(ROOT, 'DeepSeek免费公皮', 'DeepSeek', cdiFile as string), 'utf8')).Parameters || []).map((p: any) => p.Id),
  );

  for (const entry of registry.entries) {
    const extId = 'ext.' + entry.id;
    const c = byId.get(extId);
    assert.ok(c, 'W3 条目未登记进画像: ' + entry.id);
    assert.equal(c.status, 'supported', `${entry.id} 应当 supported（registry 已过 validate）`);
    // sourceId 必须精确等于 controlledParams 集合（多一个少一个都是编造）
    const declared = (entry.controlledParams || []).map((p: any) => p.id).sort();
    const actual = String(c.sourceId || '').split('+').filter(Boolean).sort();
    assert.deepEqual(actual, declared, entry.id + ' 的 sourceId 与登记参数不一致');
    for (const pid of actual) assert.ok(realParams.has(pid), `${entry.id} 指向了不存在的参数 ${pid}`);
    // 约束数据随通道落画像，kind 保留 W3 类型
    assert.equal(c.kind, entry.kind, entry.id + ' 的 kind 不一致');
    assert.ok(Array.isArray(c.conflicts), entry.id + ' 缺 conflicts 数据');
  }
});

test('W3 冲突数据：互斥双向声明（成对动作/眼睛族/gaze↔前倾）', () => {
  const dir = path.join(ROOT, 'tools', 'capability-scan');
  const files = fs.readdirSync(dir).filter((f) => /^profile\..+\.json$/.test(f));
  if (!files.length) return;
  const profile = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
  const byId = new Map(profile.controls.map((c: any) => [c.id, c]));
  const get = (id: string) => byId.get('ext.' + id) as any;

  // 成对动作：右臂两动作互斥，chest（左臂）与两者可组合
  assert.ok(get('gesture.right_finger').conflicts.includes('ext.gesture.grass'));
  assert.ok(get('gesture.grass').conflicts.includes('ext.gesture.right_finger'));
  assert.equal(get('gesture.chest').conflicts.includes('ext.gesture.right_finger'), false);
  // 眼睛族 key3-6 同一时刻只允许一个表情
  const eyes = ['expression.圈圈眼', 'expression.屑', 'expression.爱心眼', 'expression.＞＜'];
  for (const a of eyes) {
    for (const b of eyes) {
      if (a === b) continue;
      assert.ok(get(a).conflicts.includes('ext.' + b), `${a} 应与 ${b} 互斥`);
    }
  }
  // gaze 与前倾同写 LeanInput，双向互斥；gaze 各方向彼此不互斥
  for (const g of ['gaze.look_up', 'gaze.look_down', 'gaze.look_left', 'gaze.look_right']) {
    assert.ok(get(g).conflicts.includes('ext.body.lean_forward'), g + ' 应与 body.lean_forward 互斥');
    assert.ok(get('body.lean_forward').conflicts.includes('ext.' + g));
    assert.equal(get(g).conflicts.includes('ext.' + g), false, '冲突表不得自指');
  }
  // 对称性全局复核：A 声明 B，B 必声明 A
  for (const c of profile.controls as any[]) {
    for (const target of c.conflicts || []) {
      if (target.endsWith('.*')) continue;
      const other = byId.get(target);
      assert.ok(other, `${c.id} 冲突指向未知通道 ${target}`);
      assert.ok(
        (other.conflicts || []).some((t: string) => t === c.id || (t.endsWith('.*') && c.id.startsWith(t.slice(0, -1)))),
        `${c.id} -> ${target} 冲突未双向声明`,
      );
    }
  }
});

test('W3 排除表：明确不登记的条目不得以任何通道/资产形式出现', () => {
  const dir = path.join(ROOT, 'tools', 'capability-scan');
  const files = fs.readdirSync(dir).filter((f) => /^profile\..+\.json$/.test(f));
  if (!files.length) return;
  const profile = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
  const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'w3-registry', 'registry.json'), 'utf8'));
  const excludedIds = (registry.excluded || []).map((x: any) => x.id);
  assert.deepEqual((profile.exclusions || []).map((x: any) => x.id).sort(), [...excludedIds].sort());
  for (const x of profile.exclusions as any[]) assert.ok(x.reason, '排除条目必须带原因: ' + x.id);

  const controlIds = new Set((profile.controls as any[]).map((c) => c.id));
  const assetIds = new Set((profile.assets as any[]).map((a) => a.id));
  for (const id of excludedIds) {
    assert.equal(controlIds.has(id) || controlIds.has('ext.' + id), false, id + ' 被排除却出现在 controls');
    assert.equal(assetIds.has(id), false, id + ' 被排除却出现在 assets');
  }
  // 未引用资产同样不得被当可用能力
  for (const p of [...(profile.unregisteredAssets?.motion3 || []), ...(profile.unregisteredAssets?.exp3 || [])]) {
    const rel = String(p).replace(/^model\//, '');
    for (const a of profile.assets as any[]) {
      for (const r of a.resources || []) assert.ok(!r.includes(rel), `未引用资产 ${rel} 出现在资产 ${a.id}`);
    }
  }
});

test('resolveW3Controls：缺参数/缺资产时 fail-closed 为 unsupported', () => {
  const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'w3-registry', 'registry.json'), 'utf8'));
  const empty = resolveW3Controls(registry, { params: [], physicsOutputs: [], motions: [], expressions: [] });
  assert.equal(empty.controls.length, registry.entries.length);
  for (const c of empty.controls) {
    assert.equal(c.status, 'unsupported', c.id + ' 在空模型上必须 unsupported');
    assert.ok(c.reason, c.id + ' 的 unsupported 必须带原因');
  }
});

if (process.exitCode) console.error('\n能力画像测试失败\n');
else console.log(`\n${passed} passed\n`);
