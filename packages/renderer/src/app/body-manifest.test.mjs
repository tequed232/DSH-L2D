/**
 * [M1-g / G1] body-manifest 完整性测试（防漂移）。
 *
 * 断言分三层：
 *   1. **与源数据完全相等**：manifest 里的 30 个手臂物理输出 == physics3.json 中
 *      settings 72..81 的 Output 目标集合（逐侧精确相等，多一个少一个都失败）；
 *   2. **审计口径**：Param42 ∉ 物理输出 且 ∈ CROSS_DOMAIN；姿态层 ∉ 物理输出；
 *      共享枢纽 = 物理输出 ∩ 物理输入（ParamAngle 族 / ParamBodyAngle 族）+ S5 开关；
 *      根输入存在且不是物理输出；
 *   3. **生成物幂等**：磁盘上的 body-manifest.ts 与 renderModule(buildManifest(源数据)) 逐字节相同；
 *      篡改源数据副本必须被检测到（漂移守卫自检）。
 *
 * 运行：node --experimental-strip-types packages/renderer/src/app/body-manifest.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ARM_ALL_PHYSICS,
  ARM_LEFT_PHYSICS,
  ARM_LEFT_POSE,
  ARM_RIGHT_PHYSICS,
  ARM_RIGHT_POSE,
  CROSS_DOMAIN,
  MANIFEST_ALL_PHYSICS,
  ROOT_ONLY,
  SHARED_FORBIDDEN,
} from './body-manifest.ts';
import { buildManifest, renderModule } from '../../../../tools/gen-body-manifest.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..', '..');
const MODEL_DIR =
  process.env.DSH_L2D_MODEL_DIR || path.join(ROOT, 'DeepSeek免费公皮', 'DeepSeek');
const PHYSICS_FILE = path.join(MODEL_DIR, '大肥鱼.physics3.json');
const CDI_FILE = path.join(MODEL_DIR, '大肥鱼.cdi3.json');
const MANIFEST_FILE = path.join(HERE, 'body-manifest.ts');

function loadSources() {
  const physics = JSON.parse(fs.readFileSync(PHYSICS_FILE, 'utf8'));
  const cdi = JSON.parse(fs.readFileSync(CDI_FILE, 'utf8'));
  return { physics, cdi };
}

/** 直接按 setting 编号取 Output 目标（不经 manifest，独立复算）。 */
function outputsOfSettings(physics, nums) {
  const ids = new Set();
  for (const s of physics.PhysicsSettings || []) {
    const n = Number(String(s.Id || '').replace('PhysicsSetting', ''));
    if (!nums.includes(n)) continue;
    for (const o of s.Output || []) ids.add(o.Destination.Id);
  }
  return [...ids].sort();
}

function graphSets(physics) {
  const outputs = new Set();
  const inputs = new Set();
  for (const s of physics.PhysicsSettings || []) {
    for (const o of s.Output || []) outputs.add(o.Destination.Id);
    for (const i of s.Input || []) inputs.add(i.Source.Id);
  }
  return { outputs, inputs };
}

const sorted = (arr) => [...arr].sort();

test('手臂物理输出与 physics3 实际输出集合完全相等（左/右各 15）', () => {
  const { physics } = loadSources();
  assert.deepEqual(sorted(ARM_RIGHT_PHYSICS), outputsOfSettings(physics, [73, 75, 78, 79, 80]));
  assert.deepEqual(sorted(ARM_LEFT_PHYSICS), outputsOfSettings(physics, [72, 74, 76, 77, 81]));
  assert.equal(ARM_RIGHT_PHYSICS.length, 15);
  assert.equal(ARM_LEFT_PHYSICS.length, 15);
  // 左侧物理输出的名字是 LSleeveY（不是 LSleeveY1），右侧是 RSleeveY1..3
  assert.ok(ARM_LEFT_PHYSICS.includes('LSleeveY'));
  assert.ok(!ARM_LEFT_PHYSICS.includes('LSleeveY1'));
  assert.ok(ARM_RIGHT_PHYSICS.includes('RSleeveY1'));
});

test('ARM_ALL_PHYSICS = 左右并集（30，无重复），MANIFEST_ALL_PHYSICS 同集合', () => {
  assert.equal(ARM_ALL_PHYSICS.length, 30);
  assert.equal(new Set(ARM_ALL_PHYSICS).size, 30);
  assert.deepEqual(sorted(ARM_ALL_PHYSICS), sorted([...ARM_RIGHT_PHYSICS, ...ARM_LEFT_PHYSICS]));
  assert.equal(MANIFEST_ALL_PHYSICS.size, 30);
  for (const id of ARM_ALL_PHYSICS) assert.ok(MANIFEST_ALL_PHYSICS.has(id), id);
  // 姿态层/共享域/根输入都不得混进可 own 白名单
  for (const id of [...ARM_RIGHT_POSE, ...ARM_LEFT_POSE, ...CROSS_DOMAIN, ...SHARED_FORBIDDEN]) {
    assert.ok(!MANIFEST_ALL_PHYSICS.has(id), id + ' 不应在 limb 可 own 白名单里');
  }
});

test('参数42：不是物理输出，属 CROSS_DOMAIN（喂 PhysicsSetting131），不进姿态层', () => {
  const { physics } = loadSources();
  const { outputs } = graphSets(physics);
  assert.equal(outputs.has('Param42'), false, 'Param42 是姿态参数，不该是物理输出');
  assert.deepEqual([...CROSS_DOMAIN], ['Param42']);
  assert.equal(ARM_RIGHT_POSE.includes('Param42'), false);
  assert.equal(ARM_LEFT_POSE.includes('Param42'), false);
  // 它是 tail setting（131）的输入，这是"S4 跨域"的物理证据
  const tail = (physics.PhysicsSettings || []).find((s) => s.Id === 'PhysicsSetting131');
  assert.ok(tail, 'physics3 缺 PhysicsSetting131');
  assert.ok((tail.Input || []).some((i) => i.Source.Id === 'Param42'));
});

test('姿态层与共享域：11 个共享禁止项 = 7 个 ParamAngle*/ParamBodyAngle* 枢纽 + S5 开关', () => {
  const { physics } = loadSources();
  const { outputs, inputs } = graphSets(physics);
  const hubs = [...outputs].filter((id) => inputs.has(id) && /^Param(Body)?Angle/.test(id));
  assert.deepEqual(
    sorted(SHARED_FORBIDDEN),
    sorted([...hubs, 'Movement1', 'Movement2', 'Movement3', 'Param35']),
  );
  assert.equal(SHARED_FORBIDDEN.length, 11);
  // 姿态层里每个 id 都不是物理输出（否则它就该走 own 通道而不是普通写）
  for (const id of [...ARM_RIGHT_POSE, ...ARM_LEFT_POSE]) {
    assert.equal(outputs.has(id), false, id + ' 不应是物理输出');
  }
  assert.deepEqual(sorted([...ARM_RIGHT_POSE, ...ARM_LEFT_POSE]), [
    'Param36',
    'Param39',
    'Param40',
    'Param41',
    'Param43',
    'Param59',
    'Param60',
    'Param61',
    'Param62',
  ]);
});

test('ROOT_ONLY：头 3 个 / 躯干 4 个，都是物理 Source 且不是物理输出', () => {
  const { physics } = loadSources();
  const { outputs, inputs } = graphSets(physics);
  assert.deepEqual(sorted(ROOT_ONLY.head), ['AngleX', 'AngleY', 'AngleZ']);
  assert.deepEqual(sorted(ROOT_ONLY.torso), ['LeanInput', 'PositionX', 'PositionY', 'PositionZ']);
  for (const id of [...ROOT_ONLY.head, ...ROOT_ONLY.torso]) {
    assert.ok(inputs.has(id), id + ' 不是任何 physics setting 的 Source');
    assert.equal(outputs.has(id), false, id + ' 是物理输出，不能当根输入直写');
  }
});

test('生成物幂等：磁盘文件 == renderModule(buildManifest(源数据))', () => {
  const { physics, cdi } = loadSources();
  const expected = renderModule(buildManifest(physics, cdi));
  const actual = fs.readFileSync(MANIFEST_FILE, 'utf8');
  assert.equal(
    actual,
    expected,
    'body-manifest.ts 与源数据不一致：请运行 `node tools/gen-body-manifest.mjs`',
  );
  // 再算一次必须逐字节相同（纯函数，无时间戳/随机）
  assert.equal(renderModule(buildManifest(physics, cdi)), expected);
});

test('漂移守卫自检：篡改源数据副本必须被检测到（否则上面的守卫是假通过）', () => {
  const { physics, cdi } = loadSources();
  const baseline = renderModule(buildManifest(physics, cdi));

  // 删掉 RSleeveY1 这一条输出 → 生成物变化
  const mutated = JSON.parse(JSON.stringify(physics));
  const s79 = mutated.PhysicsSettings.find((s) => s.Id === 'PhysicsSetting79');
  s79.Output = s79.Output.filter((o) => o.Destination.Id !== 'RSleeveY1');
  const changed = renderModule(buildManifest(mutated, cdi));
  assert.notEqual(changed, baseline, '删掉一条物理输出后生成物没变 —— 漂移守卫失效');

  // 整个 setting 缺失 → 生成器必须报错（fail-closed，不静默降级）
  const missing = JSON.parse(JSON.stringify(physics));
  missing.PhysicsSettings = missing.PhysicsSettings.filter((s) => s.Id !== 'PhysicsSetting73');
  assert.throws(() => buildManifest(missing, cdi), /PhysicsSetting73/);

  // 姿态参数被改成物理输出 → 生成器必须报错（域划分漂移）
  const polluted = JSON.parse(JSON.stringify(physics));
  polluted.PhysicsSettings.push({
    Id: 'PhysicsSetting999',
    Input: [{ Source: { Target: 'Parameter', Id: 'Param36' }, Weight: 100, Type: 'Angle' }],
    Output: [
      {
        Destination: { Target: 'Parameter', Id: 'Param36' },
        VertexIndex: 1,
        Scale: 1,
        Weight: 100,
        Type: 'Angle',
      },
    ],
    Vertices: [],
    Normalization: { Position: { Minimum: -1, Default: 0, Maximum: 1 } },
  });
  assert.throws(() => buildManifest(polluted, cdi), /Param36/);
});
