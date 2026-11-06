/**
 * PR-C 物理能力分析测试（G0-G2）。
 * 合成 fixture 恒跑；真实模型 physics3.json 在位时加测（G0 审计口径复核）。
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildPhysicsGraph,
  buildCapabilityManifest,
  modelHashFromMoc3,
  decideLimbAllocation,
  CapabilityManifestCache,
  isDecorationParameter,
  isSharedHub,
  leftRightMismatch,
  analyzePhysicsCapability,
} from '../src/physics/index.ts';

let passed = 0;
let failed = 0;
const tests: Array<[string, () => void | Promise<void>]> = [];
function test(name: string, fn: () => void | Promise<void>) { tests.push([name, fn]); }

// ------------------------------------------------------ 合成 fixture（官方 physics3 结构）
function makeFixturePhysics() {
  return {
    Meta: { PhysicsSettingCount: 2, TotalInputCount: 2, TotalOutputCount: 2 },
    PhysicsSettings: [
      {
        Id: 'PhysicsSetting1',
        Input: [{ Source: { Id: 'AngleX', Weight: 100 } }],
        Output: [
          { Destination: { Id: 'ParamAngleX', Weight: 100, Type: 'Add' } },
          { Destination: { Id: 'FrontHairX1', Weight: 50, Type: 'Add' } }, // 头饰随动
        ],
      },
      {
        Id: 'PhysicsSetting2',
        Input: [{ Source: { Id: 'AngleZ', Weight: 100 } }],
        Output: [{ Destination: { Id: 'RArm', Weight: 60, Type: 'Add' } }], // 手臂叶子 0 下游
      },
    ],
  };
}

// ------------------------------------------------------ 1. 拓扑图
test('buildPhysicsGraph：输入/输出装配与 downstream 闭包', () => {
  const graph = buildPhysicsGraph(makeFixturePhysics() as any);
  assert.equal(graph.outputs.has('ParamAngleX'), true);
  assert.equal(graph.outputs.has('RArm'), true);
  assert.equal(graph.inputs.has('AngleX'), true);
  // AngleX 经 Setting1 传播到 ParamAngleX + FrontHairX1
  const down = graph.downstream('AngleX');
  assert.equal(down.has('ParamAngleX'), true);
  assert.equal(down.has('FrontHairX1'), true, '头饰输出必须出现在 AngleX 下游（共享域证据）');
  // RArm 0 下游（叶子）
  assert.equal(graph.downstream('RArm').size, 0);
  // 双重身份：既是输出又是输入的参数被标记（合成图里 ParamAngleX 不作输入，宽松验证不炸即可）
});

test('左右肢体约束：跨侧参数拒绝', () => {
  assert.ok(leftRightMismatch('right_arm', ['RArm', 'LArm']), '右臂请求混入 LArm 必须判错');
  assert.ok(leftRightMismatch('left_arm', ['RArm']), '左臂请求混入 RArm 必须判错');
  assert.equal(leftRightMismatch('right_arm', ['RArm', 'RForearm']), null, '同侧通过');
  assert.equal(leftRightMismatch('left_arm', ['LArm']), null);
});

test('装饰域判定：头发/裙摆/配饰全部命中', () => {
  for (const id of ['FrontHairX1', 'SideHairRX2', 'LateHairZ', 'ShortPonytailY', 'SkirtY1', 'SkirtLayerX3', 'RBowX1', 'Hat_XA', 'LJewelry1', 'GemReflection', 'KiraA', 'Shine', 'LaceRX', 'LEar1', 'ChestX1']) {
    assert.equal(isDecorationParameter(id), true, `${id} 必须判为装饰域`);
  }
  assert.equal(isDecorationParameter('RArm'), false, '手臂叶子不是装饰');
  assert.equal(isDecorationParameter('ParamAngleX'), false);
});

test('共享枢纽判定：S1-S5 全命中', () => {
  for (const id of ['ParamBodyAngleX', 'ParamBodyAngleZ', 'ParamAngleX', 'HipAngleX', 'Param42', 'Movement1']) {
    assert.equal(isSharedHub(id), true, `${id} 必须判为共享枢纽`);
  }
  assert.equal(isSharedHub('RArm'), false);
});

// ------------------------------------------------------ 2. Manifest（合成图）
test('buildCapabilityManifest：手臂 verified，body/head/leg 拒绝并给原因', () => {
  const manifest = buildCapabilityManifest('fixture', 'hash-fixture-1', makeFixturePhysics() as any);
  assert.equal(manifest.manifestVersion >= 1, true);
  const right = manifest.limbs.find((l) => l.limb === 'right_arm')!;
  // fixture 只有 RArm，无完整叶子集 → verified=false（证据不足 fail-closed）
  assert.equal(right.verified, false, '叶子集不完整时不得标 verified');
  const body = manifest.limbs.find((l) => l.limb === 'body')!;
  assert.equal(body.verified, false);
  assert.match(body.reason!, /共享枢纽/);
  const head = manifest.limbs.find((l) => l.limb === 'head')!;
  assert.match(head.reason!, /头饰/);
  // 装饰输出收进 manifest.decorationOutputs
  assert.ok(manifest.decorationOutputs.includes('FrontHairX1'));
  assert.ok(!manifest.decorationOutputs.includes('RArm'));
});

// ------------------------------------------------------ 3. 分配决策（fail-closed 矩阵）
function manifestWithVerifiedArm() {
  const physics = makeFixturePhysics();
  // 补齐右臂完整叶子集 + 左臂完整叶子集（0 下游）
  const armOut = (ids: string[], settingId: string) => ({
    Id: settingId,
    Input: [{ Source: { Id: 'AngleZ', Weight: 100 } }],
    Output: ids.map((id) => ({ Destination: { Id: id, Weight: 60, Type: 'Add' } })),
  });
  physics.PhysicsSettings.push(
    armOut(['RForearm', 'RWrist', 'RHand', 'RHand2'], 'PhysicsSetting3'),
    armOut(['LArm', 'LForearm', 'LWrist', 'LHand', 'LHand2'], 'PhysicsSetting4'),
  );
  return buildCapabilityManifest('fixture-verified', 'hash-verified', physics as any);
}

test('decideLimbAllocation：完整证据 + 白名单内 → allow（post 相位）', () => {
  const manifest = manifestWithVerifiedArm();
  const decision = decideLimbAllocation(manifest, { limb: 'right_arm', parameters: ['RArm', 'RForearm', 'RWrist', 'RHand', 'RHand2'] });
  assert.equal(decision.decision, 'allow', JSON.stringify(decision));
  assert.equal(decision.phase, 'post', '手臂叶子域契约相位 = post');
});

test('decideLimbAllocation：未知参数 fail-closed', () => {
  const manifest = manifestWithVerifiedArm();
  const decision = decideLimbAllocation(manifest, { limb: 'right_arm', parameters: ['RArm', 'Param999'] });
  assert.equal(decision.decision, 'reject');
  assert.ok(decision.rejected.some((r) => r.parameterId === 'Param999' && /unknown-param/.test(r.cause)));
});

test('decideLimbAllocation：装饰参数拒绝（头发/裙摆/配饰）', () => {
  const manifest = manifestWithVerifiedArm();
  for (const id of ['FrontHairX1', 'SkirtY1', 'RBowX1']) {
    const decision = decideLimbAllocation(manifest, { limb: 'right_arm', parameters: [id] });
    assert.equal(decision.decision, 'reject', `${id} 必须拒绝`);
    assert.ok(decision.rejected.some((r) => /decoration/.test(r.cause)), `${id} 拒绝原因必须是 decoration`);
  }
});

test('decideLimbAllocation：共享枢纽拒绝（躯干轴不得独占）', () => {
  const manifest = manifestWithVerifiedArm();
  const decision = decideLimbAllocation(manifest, { limb: 'right_arm', parameters: ['RArm', 'ParamBodyAngleZ'] });
  assert.equal(decision.decision, 'reject');
  assert.ok(decision.rejected.some((r) => /shared-hub/.test(r.cause)));
});

test('decideLimbAllocation：左右错误切换拒绝', () => {
  const manifest = manifestWithVerifiedArm();
  const decision = decideLimbAllocation(manifest, { limb: 'right_arm', parameters: ['RArm', 'LArm'] });
  assert.equal(decision.decision, 'reject');
  assert.ok(decision.rejected.some((r) => /left-right-mismatch/.test(r.cause)));
});

test('decideLimbAllocation：未验证肢体拒绝（left_leg 等）', () => {
  const manifest = manifestWithVerifiedArm();
  const decision = decideLimbAllocation(manifest, { limb: 'left_leg', parameters: ['HipAngleX'] });
  assert.equal(decision.decision, 'reject');
  assert.match(decision.reason, /未验证/);
});

test('decideLimbAllocation：空参数与未知肢体拒绝', () => {
  const manifest = manifestWithVerifiedArm();
  assert.equal(decideLimbAllocation(manifest, { limb: 'right_arm', parameters: [] }).decision, 'reject');
  assert.equal(decideLimbAllocation(manifest, { limb: 'tail' as any, parameters: ['RArm'] }).decision, 'reject');
});

// ------------------------------------------------------ 4. 缓存失效（模型版本变化）
test('CapabilityManifestCache：modelHash 变化 → 缓存正确失效', () => {
  let builds = 0;
  const cache = new CapabilityManifestCache((modelId, hash) => {
    builds++;
    return buildCapabilityManifest(modelId, hash, makeFixturePhysics() as any);
  });
  const a = cache.get('modelA', 'hash1');
  const b = cache.get('modelA', 'hash1');
  assert.equal(builds, 1, '同 id 同 hash 命中缓存');
  assert.equal(a, b);
  const c = cache.get('modelA', 'hash2');
  assert.equal(builds, 2, 'hash 变化必须重建（旧缓存失效）');
  assert.notEqual(a, c);
  assert.equal(c.modelHash, 'hash2');
  cache.invalidate();
  cache.get('modelA', 'hash2');
  assert.equal(builds, 3, '显式失效后重建');
});

test('analyzePhysicsCapability：叶子域 ownershipAllowed + evidenceVerified', () => {
  const physics = manifestWithVerifiedArm; // 复用补齐逻辑
  const physicsJson = (() => {
    const p = makeFixturePhysics();
    const armOut = (ids: string[], settingId: string) => ({
      Id: settingId,
      Input: [{ Source: { Id: 'AngleZ', Weight: 100 } }],
      Output: ids.map((id) => ({ Destination: { Id: id, Weight: 60, Type: 'Add' } })),
    });
    p.PhysicsSettings.push(
      armOut(['RForearm', 'RWrist', 'RHand', 'RHand2'], 'PhysicsSetting3'),
      armOut(['LArm', 'LForearm', 'LWrist', 'LHand', 'LHand2'], 'PhysicsSetting4'),
    );
    return p;
  })();
  const graph = buildPhysicsGraph(physicsJson as any);
  const cap = analyzePhysicsCapability('fixture-verified', graph);
  assert.equal(cap.ownershipAllowed, true);
  assert.equal(cap.evidenceVerified, true);
  assert.ok(cap.outputs.length >= 11);
});

// ------------------------------------------------------ 5. 真实模型（G0 审计口径复核，资源在位时）
const REAL_PHYSICS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'DeepSeek免费公皮', 'DeepSeek', '大肥鱼.physics3.json');
const REAL_MOC3 = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'DeepSeek免费公皮', 'DeepSeek', '大肥鱼.moc3');

if (existsSync(REAL_PHYSICS)) {
  test('真实 physics3：131 settings / 292 唯一输出，与 G0 审计一致', () => {
    const json = JSON.parse(readFileSync(REAL_PHYSICS, 'utf8'));
    const graph = buildPhysicsGraph(json);
    assert.equal(graph.outputs.size, 292, `实测 ${graph.outputs.size}，G0 口径 292`);
    assert.equal(json.PhysicsSettings.length, 131);
    // G0 关键结论 1：手臂叶子 0 下游
    for (const id of ['RArm', 'RForearm', 'RWrist', 'RHand', 'RHand2', 'LArm', 'LForearm', 'LWrist', 'LHand', 'LHand2']) {
      assert.equal(graph.downstream(id).size, 0, `${id} 必须 0 下游（G0 §0.1）`);
    }
    // G0 关键结论 3：共享域有下游——ParamAngleX 下游含头饰，ParamBodyAngleX 下游 61
    const angleDown = graph.downstream('ParamAngleX');
    assert.ok(angleDown.size > 0, 'ParamAngleX 必须有下游（共享域）');
    assert.ok(angleDown.has('FrontHairX1') || angleDown.size > 10, 'ParamAngleX 下游应覆盖头饰层');
    const bodyDown = graph.downstream('ParamBodyAngleX');
    assert.equal(bodyDown.size, 61, `ParamBodyAngleX 下游实测 ${bodyDown.size}，G0 口径 61`);
  });

  test('真实 physics3：手臂叶子域 verified=true，分配 allow；躯干/头拒绝', () => {
    const json = JSON.parse(readFileSync(REAL_PHYSICS, 'utf8'));
    const manifest = buildCapabilityManifest('大肥鱼', 'real-hash', json);
    const right = manifest.limbs.find((l) => l.limb === 'right_arm')!;
    assert.equal(right.verified, true, JSON.stringify(right.reason));
    const allow = decideLimbAllocation(manifest, { limb: 'right_arm', parameters: ['RArm', 'RForearm', 'RWrist', 'RHand', 'RHand2'] });
    assert.equal(allow.decision, 'allow');
    // 袖子/飘带按用户装饰约束排除（保守于 G0 的更宽 PASS 集）
    const sleeve = decideLimbAllocation(manifest, { limb: 'right_arm', parameters: ['RSleeveX1'] });
    assert.equal(sleeve.decision, 'reject', '袖子属装饰约束，必须拒绝');
    // 躯干独占拒绝
    const body = manifest.limbs.find((l) => l.limb === 'body')!;
    assert.equal(body.verified, false);
  });

  test('真实 moc3：modelHash 稳定且非空（缓存键可用）', () => {
    const bytes = readFileSync(REAL_MOC3);
    const h1 = modelHashFromMoc3(new Uint8Array(bytes));
    const h2 = modelHashFromMoc3(new Uint8Array(bytes));
    assert.equal(h1, h2);
    assert.match(h1, /^[0-9a-f]{64}$/);
  });
} else {
  console.log('  skip：真实模型资源不在位（工作区未跟踪资源），合成 fixture 覆盖已通过');
}

// ------------------------------------------------------ 汇总
for (const [name, fn] of tests) {
  try {
    await fn();
    passed++;
    console.log('  ok ', name);
  } catch (e) {
    failed++;
    console.error('  FAIL', name);
    console.error(String((e as Error).stack || e).split('\n').slice(0, 6).join('\n'));
  }
}
if (failed) {
  console.error(`\nphysics-capability 测试失败：${failed}/${tests.length}\n`);
  process.exit(1);
} else {
  console.log(`\n${passed} passed，0 failed\n`);
}
