/**
 * [M1-b] PhysicsGate 验收用例（mock 帧序，Embodied-Behavior §1 帧序 + §5 确定性顺序）。
 *
 * 覆盖：
 *   1. flag 关（默认）= 现行为：pre/post 零副作用，Agent pre 写被物理覆盖（逐字节基线）；
 *   2. flag 开 + Agent 独占 HipAngleX（pre）：物理让位，次级链（裙摆类消费者）随 Agent 值；
 *   3. release / 到期：下一帧让位表清空，物理回接管（R8，无恢复逻辑）；
 *   4. limb 通道：resolve 非空 → stagePostWrite 登记（injector post 后写胜出语义）；
 *      空表 = 空帧无副作用；非有限值过滤；
 *   5. 让位登记表幂等 / 整体替换 / 清理。
 *
 * 运行：node --experimental-strip-types packages/renderer/src/app/physics-gate.test.mjs
 * （motion-adapter.ts 只 import core 纯函数与 physics-yield，无 SDK 依赖，node 可直跑；
 *   cubismphysics.ts 的让位行为由 vite 构建门禁 + 集成日真机验收覆盖。）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPhysicsGate, DEFAULT_EMBODIED_FLAGS } from './motion-adapter.ts';
import { physicsYield } from '../fw/physics/physics-yield.ts';

// ---------------------------------------------------------------- mock 帧环境

/**
 * mock 模型参数（简化）：HipAngleX 是被独占的 pre 通道参数；
 * SkirtX1 模拟 chained 消费者（physics3：PhysicsSetting67 HipAngleX→SkirtX1）；
 * RArm 模拟叶子四肢（post 覆盖）。
 */
function newParams() {
  return { HipAngleX: 0, SkirtX1: 0, RArm: 0 };
}

/**
 * mock 物理生产者/消费者（复刻 cubismphysics evaluate/interpolate 的让位契约）：
 * - 生产者 PhysicsSetting12：非让位帧写 HipAngleX = 物理值（随帧摆动）；
 *   让位帧跳过写入（evaluate 跳缓存回写 + interpolate 跳落写的合效果）。
 * - 消费者 PhysicsSetting67：无条件读 HipAngleX 当前值放大 2 倍写 SkirtX1（次级链随动）。
 */
function mockPhysics(params, frame) {
  const sway = Math.sin(frame / 10) * 3; // 物理值轨迹
  if (!physicsYield.ids.has('HipAngleX')) params.HipAngleX = sway;
  params.SkirtX1 = params.HipAngleX * 2;
  return sway;
}

/** mock injector pre 通道：独占的 pre 相位参数落 Agent 值（injector.apply('pre') 语义）。 */
function mockInjectorPre(params, owned) {
  for (const [id, value] of owned) params[id] = value;
}

/**
 * 一帧完整序列（对齐 Embodied-Behavior §1）：
 * saveParameters 恢复基底 → pre 注入(Agent) → gate.pre → Physics600 → post: gate.post → post 注入。
 * 返回本帧物理值轨迹（供对照）。
 */
function runFrame(params, frame, gate, ownedPre) {
  physicsYield.clear();
  mockInjectorPre(params, ownedPre); // injector.apply(core, 'pre')
  gate.pre(params); // [M1-b] 让位登记
  const sway = mockPhysics(params, frame); // Physics600（evaluate + interpolate）
  gate.post(params); // [M1-b] limb 覆盖登记（随后的 injector.apply('post') 后写胜出）
  return sway;
}

/** 构造带可变 ownership 与 fake limb 的 deps。 */
function makeDeps() {
  const deps = {
    owned: [], // Array<[id, value]>：pre 相位独占
    limb: null,
    staged: [], // stagePostWrite 调用记录
    limbResolveCalls: 0,
  };
  deps.preOwnedIds = () => deps.owned.map(([id]) => id);
  deps.stagePostWrite = (core, id, value) => deps.staged.push({ core, id, value });
  return deps;
}

/** 让 gate.post 在测试里用注入的 limb resolve 结果（fake LimbControlLike）。 */
function gateWithLimb(flags, deps) {
  const fakeLimb = {
    acquire: () => [],
    release: () => [],
    resolve: () => {
      deps.limbResolveCalls++;
      return deps.limbWrites || new Map();
    },
  };
  return createPhysicsGate(flags, { ...deps, limb: fakeLimb });
}

// ---------------------------------------------------------------- 1. flag 关 = 现行为

test('flag 关（默认）：pre/post 零副作用，Agent pre 写被物理覆盖（基线逐字节）', () => {
  physicsYield.clear();
  const gate = createPhysicsGate(DEFAULT_EMBODIED_FLAGS); // 无 deps
  const deps = makeDeps();
  deps.owned = [['HipAngleX', 10]];
  const gateOffWithDeps = createPhysicsGate({ 'embodied.m1': false }, {
    preOwnedIds: deps.preOwnedIds,
    stagePostWrite: deps.stagePostWrite,
  });

  const params = newParams();
  const trace = [];
  for (let f = 0; f < 4; f++) {
    runFrame(params, f, gateOffWithDeps, deps.owned);
    trace.push({ hip: params.HipAngleX, skirt: params.SkirtX1 });
  }
  // flag 关：让位表从未被触碰（恒空）→ 物理每帧写 HipAngleX，Agent 值被覆盖
  assert.equal(physicsYield.ids.size, 0);
  for (let f = 0; f < 4; f++) {
    const sway = Math.sin(f / 10) * 3;
    assert.ok(Math.abs(trace[f].hip - sway) < 1e-12, `frame ${f} hip=${trace[f].hip} 期望物理值 ${sway}`);
    assert.ok(Math.abs(trace[f].skirt - sway * 2) < 1e-12);
  }
  // post 通道也不得触发
  assert.equal(deps.limbResolveCalls, 0);
  assert.equal(deps.staged.length, 0);
  // 无 deps 的缺省 gate 同样零副作用
  gate.pre(newParams());
  gate.post(newParams());
  gate.dispose();
  assert.equal(physicsYield.ids.size, 0);
});

// ------------------------------------------------- 2. flag 开：让位 + 次级链随动

test('flag 开 + Agent 独占 HipAngleX（pre）：物理让位，裙摆链随 Agent 值', () => {
  physicsYield.clear();
  const deps = makeDeps();
  const gate = createPhysicsGate({ 'embodied.m1': true }, {
    preOwnedIds: deps.preOwnedIds,
    stagePostWrite: deps.stagePostWrite,
  });
  const params = newParams();
  deps.owned = [['HipAngleX', 10]];

  const trace = [];
  for (let f = 0; f < 4; f++) {
    runFrame(params, f, gate, deps.owned);
    trace.push({ hip: params.HipAngleX, skirt: params.SkirtX1 });
  }
  // Agent pre 值存活（物理不覆盖），次级链（SkirtX1）读到 Agent 值
  for (let f = 0; f < 4; f++) {
    assert.equal(trace[f].hip, 10, `frame ${f} HipAngleX 应为 Agent 值`);
    assert.equal(trace[f].skirt, 20, `frame ${f} SkirtX1 应随 Agent 值`);
  }
  // 让位表内容 = pre 相位独占集合
  assert.deepEqual([...physicsYield.ids].sort(), ['HipAngleX']);
});

test('release / 到期：下一帧让位表清空，物理回接管（R8）', () => {
  physicsYield.clear();
  const deps = makeDeps();
  const gate = createPhysicsGate({ 'embodied.m1': true }, {
    preOwnedIds: deps.preOwnedIds,
    stagePostWrite: deps.stagePostWrite,
  });
  const params = newParams();

  // 帧 0-1：独占
  deps.owned = [['HipAngleX', 10]];
  runFrame(params, 0, gate, deps.owned);
  assert.equal(params.HipAngleX, 10);

  // 帧 1：释放（ownership 空）→ 让位表清空 → 物理接管
  deps.owned = [];
  const sway = runFrame(params, 1, gate, deps.owned);
  assert.equal(physicsYield.ids.size, 0);
  assert.ok(Math.abs(params.HipAngleX - sway) < 1e-12, '释放后 HipAngleX 回物理轨迹');
  assert.ok(Math.abs(params.SkirtX1 - sway * 2) < 1e-12, '次级链回物理轨迹');
});

// ---------------------------------------------------------- 3. 确定性 / 空帧

test('gate.pre 幂等：同 ownership 重复调用 → 登记表逐字节相同；空帧清表无副作用', () => {
  physicsYield.clear();
  const deps = makeDeps();
  const gate = createPhysicsGate({ 'embodied.m1': true }, { preOwnedIds: deps.preOwnedIds });
  deps.owned = [['HipAngleX', 10], ['HipAngleZ', -4]];
  const core = newParams();
  gate.pre(core);
  const once = [...physicsYield.ids].sort();
  gate.pre(core);
  const twice = [...physicsYield.ids].sort();
  assert.deepEqual(twice, once);
  assert.deepEqual(once, ['HipAngleX', 'HipAngleZ']);

  // 空帧（无人独占）：整体替换为空 = 全部恢复物理写入
  deps.owned = [];
  gate.pre(core);
  assert.equal(physicsYield.ids.size, 0);
});

test('flag 开但未提供 preOwnedIds：安全缺省 = 清空让位表（等效无人独占）', () => {
  physicsYield.clear();
  physicsYield.replace(['HipAngleX']); // 预置脏状态
  const gate = createPhysicsGate({ 'embodied.m1': true });
  gate.pre(newParams());
  assert.equal(physicsYield.ids.size, 0);
});

// ---------------------------------------------------------------- 4. limb 通道

test('flag 开 + limb.resolve 非空：逐项 stagePostWrite（post 后写胜出语义），core 原样透传', () => {
  physicsYield.clear();
  const deps = makeDeps();
  deps.limbWrites = new Map([['RArm', 0.8], ['LArm', -0.5]]);
  const gate = gateWithLimb({ 'embodied.m1': true }, deps);
  const core = newParams();
  gate.post(core);
  assert.equal(deps.limbResolveCalls, 1);
  assert.deepEqual(deps.staged, [
    { core, id: 'RArm', value: 0.8 },
    { core, id: 'LArm', value: -0.5 },
  ]);
});

test('limb 空表 = 空帧无副作用；非有限值过滤；flag 关不触发 resolve', () => {
  physicsYield.clear();
  const deps = makeDeps();
  const gateOn = gateWithLimb({ 'embodied.m1': true }, deps);

  deps.limbWrites = new Map();
  gateOn.post(newParams());
  assert.equal(deps.limbResolveCalls, 1);
  assert.equal(deps.staged.length, 0);

  deps.limbWrites = new Map([['RArm', NaN], ['LArm', Infinity], ['RHand', 0.25]]);
  gateOn.post(newParams());
  assert.deepEqual(deps.staged, [{ core: deps.staged[0].core, id: 'RHand', value: 0.25 }]);

  const gateOff = gateWithLimb({ 'embodied.m1': false }, deps);
  const callsBefore = deps.limbResolveCalls;
  gateOff.post(newParams());
  assert.equal(deps.limbResolveCalls, callsBefore, 'flag 关不得触发 resolve');
});

// ---------------------------------------------------------------- 5. 登记表与 dispose

test('physicsYield.replace 整体替换（不残留旧集合）；dispose 清理', () => {
  physicsYield.clear();
  const deps = makeDeps();
  const gate = createPhysicsGate({ 'embodied.m1': true }, { preOwnedIds: deps.preOwnedIds });

  deps.owned = [['HipAngleX', 1]];
  gate.pre(newParams());
  assert.deepEqual([...physicsYield.ids].sort(), ['HipAngleX']);

  deps.owned = [['HipAngleZ', 1], ['HipAngleY', 1]];
  gate.pre(newParams());
  assert.deepEqual([...physicsYield.ids].sort(), ['HipAngleY', 'HipAngleZ'], '旧集合不得残留');

  gate.dispose();
  assert.equal(physicsYield.ids.size, 0);
});
