/**
 * 身体部位规划器 / 分配求解器测试（M1-g / G2）。
 *
 * 用例编号 LP-xx 与 docs/M1-G-LIMB-ALLOCATION-ROADMAP.md §G2「Required tests」逐条对照：
 *   LP-01 → 显式右侧永不复用左侧（规则 1）
 *   LP-02 → auto 只在有校准证据的变体里选（规则 1/6）
 *   LP-03 → both 原子：任一侧不可用 → 整单拒绝（规则 7）
 *   LP-04 → 左右独立域可并存（规则 5）
 *   LP-05 → 共享域不可双重持有；共享枢纽静态禁占（规则 7）
 *   LP-06 → 自主按策略让位于 Agent / Interaction（规则 2/3/4）
 *   LP-07 → Interaction 抢占取消旧持有 + 旧代次回调被 fence（规则 3/9）
 *   LP-08 → 未请求部位的物理输出继续（规则 5）
 *   LP-09 → 只接管精确域，多一个参数都不行（规则 7）
 *   LP-10 → 释放后无残留租约，可重新准入（规则 8/10）
 *   LP-11 → 未知参数 / 未知能力拒绝（规则 6）
 *   LP-12 → 模型未就绪 = BLOCKED，绝不 PASS
 * 扩展用例（本仓现实）：
 *   LP-13 → 姿态域 / 物理域分离（G1 判定实验结论：主战场是姿态层）
 *   LP-14 → 跨域耦合参数（Param42 型）不默认占用、必须显式 ack
 *   LP-15 → generation fencing（旧代次请求/回调）
 *   LP-16 → 确定性（同输入同输出、不修改入参）
 *   LP-17 → feature flag 关 = 零行为
 *   LP-18 → 到期兜底（tick 后不再阻塞）
 *   LP-19 → 红线：源码零参数写入、零时间/随机/宿主依赖
 *
 * fixture 里的 arm.left/arm.right、R-POSE-1 等是**测试素材**，不允许出现在 src 实现里。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  emptyLimbPlan,
  findLimbHold,
  planMotionAllocation,
  settleLimbHold,
  tickLimbPlan,
} from '../src/limb-plan.ts';
import type {
  LimbManifest,
  LimbMotionCapability,
  LimbPlanState,
  MotionRequest,
} from '../src/limb-plan.ts';

let passed = 0;
const test = (name: string, fn: () => void) => {
  fn();
  passed++;
  console.log('  ok  ' + name);
};

const NOW = 1000;
const OPTS = { enabled: true } as const;

const MANIFEST: LimbManifest = {
  modelFingerprint: 'fixture',
  parts: [
    {
      id: 'arm.left',
      family: 'arm',
      side: 'left',
      poseDomain: ['L-POSE-1', 'L-POSE-2'],
      physicsDomain: ['L-OUT-1', 'L-OUT-2'],
      crossDomain: [],
      sharedForbidden: ['SHARED-HUB'],
      calibrated: true,
    },
    {
      id: 'arm.right',
      family: 'arm',
      side: 'right',
      poseDomain: ['R-POSE-1', 'R-POSE-2'],
      physicsDomain: ['R-OUT-1', 'R-OUT-2', 'R-OUT-3'],
      crossDomain: ['R-CROSS'],
      sharedForbidden: ['SHARED-HUB'],
      calibrated: true,
    },
  ],
};

/** 同形状 manifest，只是右侧无校准证据（auto 不得选右）。 */
const MANIFEST_NO_RIGHT_EVIDENCE: LimbManifest = {
  ...MANIFEST,
  parts: MANIFEST.parts.map((p) => (p.id === 'arm.right' ? { ...p, calibrated: false } : p)),
};

/** 两侧都无校准证据。 */
const MANIFEST_NO_EVIDENCE: LimbManifest = {
  ...MANIFEST,
  parts: MANIFEST.parts.map((p) => ({ ...p, calibrated: false })),
};

const CATALOG: readonly LimbMotionCapability[] = [
  { motionId: 'wave', family: 'arm', variants: { 'arm.left': {}, 'arm.right': {} } },
  { motionId: 'wave.left', family: 'arm', variants: { 'arm.left': {} } },
  { motionId: 'wave.right', family: 'arm', variants: { 'arm.right': {} } },
  {
    motionId: 'wave.narrow',
    family: 'arm',
    variants: {
      'arm.left': { poseParams: ['L-POSE-1'] },
      'arm.right': { poseParams: ['R-POSE-1'] },
    },
  },
  {
    motionId: 'wave.direct',
    family: 'arm',
    directOutput: true,
    variants: { 'arm.right': { poseParams: ['R-POSE-1'], physicsParams: ['R-OUT-1'] } },
  },
  {
    motionId: 'wave.cross',
    family: 'arm',
    variants: { 'arm.right': { poseParams: ['R-POSE-1', 'R-CROSS'] } },
  },
  { motionId: 'wave.bad-param', family: 'arm', variants: { 'arm.right': { poseParams: ['NOPE'] } } },
  { motionId: 'wave.shared', family: 'arm', variants: { 'arm.right': { poseParams: ['SHARED-HUB'] } } },
  { motionId: 'wave.unknown-part', family: 'arm', variants: { 'arm.leg': {} } },
];

const req = (over: Partial<MotionRequest> = {}): MotionRequest => ({
  executionId: 'e1',
  generation: 1,
  source: 'agent',
  motionId: 'wave',
  side: 'right',
  priority: 50,
  durationMs: 500,
  ...over,
});

const plan = (
  state: LimbPlanState | null,
  request: MotionRequest,
  over: {
    manifest?: LimbManifest;
    catalog?: readonly LimbMotionCapability[];
    options?: { enabled?: boolean; modelReady?: boolean; allowInteractionPreemptAgent?: boolean };
    now?: number;
  } = {},
) =>
  planMotionAllocation(
    state,
    request,
    over.manifest ?? MANIFEST,
    over.catalog ?? CATALOG,
    over.now ?? NOW,
    { ...OPTS, ...(over.options ?? {}) },
  );

// ---------------------------------------------------------------- LP-01 规则 1
test('LP-01 显式右侧永不复用左侧：该侧无变体即拒绝，selectedParts 为空', () => {
  const r = plan(emptyLimbPlan(), req({ side: 'right', motionId: 'wave.left' }));
  assert.equal(r.decision.accepted, false);
  assert.equal(r.decision.reason, 'side-unavailable');
  assert.deepEqual(r.decision.selectedParts, [], '绝不回退到左侧');
  assert.deepEqual(r.decision.selectedPartIds, []);
  assert.deepEqual(r.decision.parameterDomains, []);
  assert.deepEqual(r.state.holds, [], '拒绝不产生任何持有');

  const ok = plan(emptyLimbPlan(), req({ side: 'right' }));
  assert.equal(ok.decision.accepted, true);
  assert.deepEqual(ok.decision.selectedPartIds, ['arm.right'], '只选显式侧');
  assert.equal(ok.decision.selectedParts[0].via, 'explicit');
});

// ---------------------------------------------------------------- LP-02 规则 1/6
test('LP-02 auto 只在有校准证据的变体里选边；无证据 fail-closed', () => {
  const left = plan(emptyLimbPlan(), req({ side: 'auto' }), { manifest: MANIFEST_NO_RIGHT_EVIDENCE });
  assert.equal(left.decision.accepted, true);
  assert.deepEqual(left.decision.selectedPartIds, ['arm.left'], '右侧无证据 → 只能左');
  assert.equal(left.decision.selectedParts[0].via, 'auto-calibrated');

  const blocked = plan(emptyLimbPlan(), req({ side: 'auto' }), { manifest: MANIFEST_NO_EVIDENCE });
  assert.equal(blocked.decision.accepted, false);
  assert.equal(blocked.decision.reason, 'no-calibration');
  assert.deepEqual(blocked.decision.selectedParts, [], '无证据不得猜边');

  // 两侧都有证据且负载相同 → 按 manifest 声明序稳定选边（确定性，不随机）
  const both = plan(emptyLimbPlan(), req({ side: 'auto' }));
  assert.deepEqual(both.decision.selectedPartIds, ['arm.left']);

  // 负载因子：左侧已被占用 → 选右侧（仍是确定性规则，非随机）
  const first = plan(emptyLimbPlan(), req({ side: 'left', executionId: 'hold-left' }));
  const second = plan(first.state, req({ side: 'auto', executionId: 'e2' }), { now: NOW + 1 });
  assert.deepEqual(second.decision.selectedPartIds, ['arm.right']);
});

// ---------------------------------------------------------------- LP-03 规则 7
test('LP-03 both 原子：任一侧不可用 / 被高优先级占用 → 整单拒绝，不做半批', () => {
  const missing = plan(emptyLimbPlan(), req({ side: 'both', motionId: 'wave.left' }));
  assert.equal(missing.decision.reason, 'side-unavailable');
  assert.deepEqual(missing.decision.selectedPartIds, []);

  const busy = plan(emptyLimbPlan(), req({ side: 'left', executionId: 'busy-left', priority: 90 }));
  const atomic = plan(busy.state, req({ side: 'both', executionId: 'e2', priority: 50 }), { now: NOW + 1 });
  assert.equal(atomic.decision.accepted, false);
  assert.equal(atomic.decision.reason, 'priority-blocked');
  assert.deepEqual(atomic.decision.selectedPartIds, [], '右侧也不得单独批准');
  assert.deepEqual(atomic.state.holds.map((h) => h.executionId), ['busy-left'], '状态零变化');

  const ok = plan(emptyLimbPlan(), req({ side: 'both' }));
  assert.equal(ok.decision.accepted, true);
  assert.deepEqual(ok.decision.selectedPartIds, ['arm.left', 'arm.right'], '两侧同批准入');
  assert.deepEqual(ok.decision.selectedParts.map((p) => p.via), ['both', 'both']);
});

// ---------------------------------------------------------------- LP-04 规则 5
test('LP-04 左右独立域可并存，互不抢占', () => {
  const left = plan(emptyLimbPlan(), req({ side: 'left', executionId: 'e-left' }));
  const both = plan(left.state, req({ side: 'right', executionId: 'e-right' }), { now: NOW + 1 });
  assert.equal(both.decision.accepted, true);
  assert.deepEqual(both.decision.preempted, [], '独立域不构成冲突');
  assert.deepEqual(both.state.holds.map((h) => h.executionId), ['e-left', 'e-right']);
  assert.deepEqual(findLimbHold(both.state, 'e-left')?.domains, ['L-POSE-1', 'L-POSE-2']);
});

// ---------------------------------------------------------------- LP-05 规则 7
test('LP-05 共享域不可双重持有；共享枢纽/开关静态禁占', () => {
  const first = plan(emptyLimbPlan(), req({ executionId: 'e1' }));
  const second = plan(first.state, req({ executionId: 'e2', priority: 50 }), { now: NOW + 1 });
  assert.equal(second.decision.accepted, true);
  assert.deepEqual(second.decision.preempted, ['e1'], '同域后到替换（同级可打断）');
  assert.equal(second.state.holds.length, 1, '任何时刻只有一个持有者，不存在双重持有');

  const overlapping = second.state.holds.filter((h) =>
    h.domains.some((id) => findLimbHold(first.state, 'e1')!.domains.includes(id)),
  );
  assert.equal(overlapping.length, 1);

  const shared = plan(emptyLimbPlan(), req({ motionId: 'wave.shared' }));
  assert.equal(shared.decision.reason, 'shared-domain-forbidden');
  assert.deepEqual(shared.decision.parameterDomains, [], '共享枢纽一个参数都不预留');
});

// ---------------------------------------------------------------- LP-06 规则 2/3/4
test('LP-06 自主让位策略：Agent 压自主、Interaction 压 Agent 需显式策略、自主永不抢占', () => {
  const auto = plan(emptyLimbPlan(), req({ source: 'autonomous', executionId: 'idle', priority: 90 }));
  assert.equal(auto.decision.accepted, true, '空闲部位上自主可入场');

  const agent = plan(auto.state, req({ source: 'agent', executionId: 'act', priority: 10 }), { now: NOW + 1 });
  assert.equal(agent.decision.accepted, true, '规则 2：Agent 显式压过自主（跨源主序，不看数值优先级）');
  assert.deepEqual(agent.decision.preempted, ['idle']);

  const denied = plan(agent.state, req({ source: 'interaction', executionId: 'ui', priority: 90 }), { now: NOW + 2 });
  assert.equal(denied.decision.accepted, false);
  assert.equal(denied.decision.reason, 'interaction-preempt-denied', '规则 3：缺省策略不得抢占 Agent');

  const allowed = plan(agent.state, req({ source: 'interaction', executionId: 'ui', priority: 50 }), {
    now: NOW + 2,
    options: { allowInteractionPreemptAgent: true },
  });
  assert.equal(allowed.decision.accepted, true, '显式策略下 Interaction 可抢占');
  assert.deepEqual(allowed.decision.preempted, ['act']);

  const idleOnBusy = plan(allowed.state, req({ source: 'autonomous', executionId: 'idle2', priority: 90 }), {
    now: NOW + 3,
  });
  assert.equal(idleOnBusy.decision.accepted, false, '规则 4：自主永不抢占忙部位（哪怕 priority 更高）');
  assert.equal(idleOnBusy.decision.reason, 'autonomous-no-preempt');
});

// ---------------------------------------------------------------- LP-07 规则 3/9
test('LP-07 抢占取消旧持有（旧回调幂等无害）+ 旧代次回调被 fence', () => {
  const agent = plan(emptyLimbPlan(), req({ source: 'agent', executionId: 'act', generation: 5 }));
  const preempt = plan(agent.state, req({ source: 'interaction', executionId: 'ui', generation: 1 }), {
    now: NOW + 1,
    options: { allowInteractionPreemptAgent: true },
  });
  assert.deepEqual(preempt.decision.preempted, ['act']);
  assert.equal(findLimbHold(preempt.state, 'act'), null, '旧持有立即释放（R7 打断即释放）');

  const late = settleLimbHold(preempt.state, { executionId: 'act', generation: 5, outcome: 'cancelled' }, NOW + 2);
  assert.deepEqual(late.released, [], '迟到回调不产生第二次释放');
  assert.equal(late.reason, 'unknown-hold', '已释放 = 幂等，不是错误');

  // 同 executionId 的代次升级：旧代次的 settle 被 fence，状态零变化
  const v3 = plan(emptyLimbPlan(), req({ executionId: 'e1', generation: 3 }));
  const v5 = plan(v3.state, req({ executionId: 'e1', generation: 5 }), { now: NOW + 1 });
  assert.equal(v5.decision.accepted, true, '新代次刷新同一执行');
  assert.deepEqual(v5.decision.preempted, [], '自我刷新不算抢占');
  assert.equal(v5.state.holds.length, 1);

  const fenced = settleLimbHold(v5.state, { executionId: 'e1', generation: 3, outcome: 'completed' }, NOW + 2);
  assert.equal(fenced.fenced, true);
  assert.equal(fenced.reason, 'stale-generation');
  assert.deepEqual(fenced.released, []);
  assert.deepEqual(fenced.state.holds, v5.state.holds, 'fence 时状态零变化');

  const current = settleLimbHold(v5.state, { executionId: 'e1', generation: 5, outcome: 'completed' }, NOW + 2);
  assert.equal(current.released.length, 1, '当前代次才能结算');
});

// ---------------------------------------------------------------- LP-08 规则 5
test('LP-08 未请求部位的物理输出继续：状态原样保留，决策不声明其域', () => {
  const left = plan(emptyLimbPlan(), req({ side: 'left', executionId: 'e-left', directOutput: true }));
  assert.equal(left.decision.accepted, true);
  const leftHoldBefore = JSON.parse(JSON.stringify(findLimbHold(left.state, 'e-left')));

  const right = plan(left.state, req({ side: 'right', executionId: 'e-right', directOutput: true }), {
    now: NOW + 1,
  });
  assert.equal(right.decision.accepted, true);
  assert.ok(
    !right.decision.parameterDomains.some((id) => id.startsWith('L-')),
    '决策不触碰左侧任何域（规则 5）',
  );
  assert.deepEqual(findLimbHold(right.state, 'e-left'), leftHoldBefore, '未请求部位保持原控制源');
  assert.deepEqual(right.state.holds.map((h) => h.executionId), ['e-left', 'e-right']);
});

// ---------------------------------------------------------------- LP-09 规则 7
test('LP-09 只接管精确域：多一个物理输出参数都不行', () => {
  const r = plan(emptyLimbPlan(), req({ motionId: 'wave.direct' }));
  assert.equal(r.decision.accepted, true);
  const part = r.decision.selectedParts[0];
  assert.deepEqual(part.physicsDomain, ['R-OUT-1'], '只声明变体要求的物理输出');
  assert.deepEqual(part.poseDomain, ['R-POSE-1']);
  assert.deepEqual(r.decision.parameterDomains, ['R-OUT-1', 'R-POSE-1']);
  assert.ok(!r.decision.parameterDomains.includes('R-OUT-2'), '不得顺手整族接管');
  assert.ok(!r.decision.parameterDomains.includes('R-OUT-3'));
});

// ---------------------------------------------------------------- LP-10 规则 8/10
test('LP-10 释放无残留租约，可重新准入；准入≠完成', () => {
  const r = plan(emptyLimbPlan(), req({ executionId: 'e1' }));
  assert.equal(r.decision.phase, 'admitted', '规则 10：准入只到 admitted');
  assert.equal(findLimbHold(r.state, 'e1')?.endAt, NOW + 500, '完成时间由 durationMs 兜底，不由准入决定');

  const released = settleLimbHold(r.state, { executionId: 'e1', outcome: 'completed' }, NOW + 10);
  assert.equal(released.released.length, 1);
  assert.deepEqual(released.state.holds, [], '无残留租约');

  const again = settleLimbHold(released.state, { executionId: 'e1', outcome: 'completed' }, NOW + 11);
  assert.deepEqual(again.released, [], '重复释放幂等');
  assert.deepEqual(again.state.holds, []);

  const reacquire = plan(released.state, req({ executionId: 'e2' }), { now: NOW + 12 });
  assert.equal(reacquire.decision.accepted, true, '释放后物理恢复，部位可再次准入');
});

// ---------------------------------------------------------------- LP-11 规则 6
test('LP-11 未知能力 / 未知部位 / 未知参数一律拒绝（不按名字推断）', () => {
  const unknownMotion = plan(emptyLimbPlan(), req({ motionId: 'never-heard-of' }));
  assert.equal(unknownMotion.decision.reason, 'unknown-capability');

  const unknownPart = plan(emptyLimbPlan(), req({ motionId: 'wave.unknown-part', side: 'auto' }));
  assert.equal(unknownPart.decision.accepted, false);
  assert.ok(
    ['unknown-part', 'no-calibration'].includes(unknownPart.decision.reason as string),
    '未知部位绝不被当成可用',
  );

  const unknownParam = plan(emptyLimbPlan(), req({ motionId: 'wave.bad-param' }));
  assert.equal(unknownParam.decision.reason, 'unknown-parameter');

  const emptyCatalog = plan(emptyLimbPlan(), req(), { catalog: [] });
  assert.equal(emptyCatalog.decision.reason, 'unknown-capability');

  const emptyManifest = plan(emptyLimbPlan(), req(), { manifest: { parts: [] } });
  assert.equal(emptyManifest.decision.reason, 'unknown-capability');
});

// ---------------------------------------------------------------- LP-12
test('LP-12 模型未就绪 = BLOCKED，绝不 PASS', () => {
  const r = plan(emptyLimbPlan(), req(), { options: { modelReady: false } });
  assert.equal(r.decision.accepted, false);
  assert.equal(r.decision.outcome, 'blocked', 'BLOCKED 与 rejected 区分，不得写成 PASS');
  assert.equal(r.decision.reason, 'model-not-ready');
  assert.deepEqual(r.state.holds, []);
});

// ---------------------------------------------------------------- LP-13 姿态/物理分离
test('LP-13 姿态域是主战场：缺省请求只占姿态域，物理域为空', () => {
  const r = plan(emptyLimbPlan(), req());
  const part = r.decision.selectedParts[0];
  assert.deepEqual(part.poseDomain, ['R-POSE-1', 'R-POSE-2'], '姿态域 = manifest 该侧全部姿态参数');
  assert.deepEqual(part.physicsDomain, [], '不直写输出时物理域为空（静息增益≈0，不浪费 own）');
  assert.deepEqual(r.state.holds[0].domains, part.poseDomain, '租约 = 姿态域');

  const direct = plan(emptyLimbPlan(), req({ directOutput: true }));
  const dp = direct.decision.selectedParts[0];
  assert.ok(dp.poseDomain.length > 0 && dp.physicsDomain.length > 0, '直写输出时两域并存');
  assert.ok(
    dp.poseDomain.every((id) => !dp.physicsDomain.includes(id)),
    '姿态层与物理输出层互不相交（G1 判定实验结论）',
  );
});

// ---------------------------------------------------------------- LP-14 跨域
test('LP-14 跨域耦合参数（Param42 型）不默认占用，必须显式 ack', () => {
  const noAck = plan(emptyLimbPlan(), req({ motionId: 'wave.cross' }));
  assert.equal(noAck.decision.reason, 'cross-domain-unacknowledged');
  assert.deepEqual(noAck.decision.parameterDomains, [], '未 ack 一个参数都不预留');

  const ack = plan(emptyLimbPlan(), req({ motionId: 'wave.cross', crossDomainAck: true }));
  assert.equal(ack.decision.accepted, true);
  const part = ack.decision.selectedParts[0];
  assert.deepEqual(part.crossDomain, ['R-CROSS'], '决策显式声明耦合');
  assert.deepEqual(part.poseDomain, ['R-POSE-1'], '跨域参数不混进姿态域');
  assert.ok(ack.decision.parameterDomains.includes('R-CROSS'), '仍被原子预留（冲突域含跨域）');
});

// ---------------------------------------------------------------- LP-15 generation
test('LP-15 旧代次请求被 fence：不得用旧代次覆盖新持有', () => {
  const v5 = plan(emptyLimbPlan(), req({ executionId: 'e1', generation: 5 }));
  const stale = plan(v5.state, req({ executionId: 'e1', generation: 3 }), { now: NOW + 1 });
  assert.equal(stale.decision.accepted, false);
  assert.equal(stale.decision.reason, 'stale-generation');
  assert.deepEqual(stale.state.holds, v5.state.holds);
});

// ---------------------------------------------------------------- LP-16 确定性
test('LP-16 确定性：同输入同输出，且不修改入参', () => {
  const state = plan(emptyLimbPlan(), req({ side: 'left', executionId: 'e-left' })).state;
  const snapshot = JSON.stringify(state);

  const a = plan(state, req({ side: 'right', executionId: 'e-right' }));
  const b = plan(state, req({ side: 'right', executionId: 'e-right' }));
  assert.deepEqual(a.decision, b.decision, '决策逐字段一致');
  assert.deepEqual(a.state, b.state, '状态逐字段一致');
  assert.equal(JSON.stringify(state), snapshot, '入参状态未被修改');

  const manifestSnapshot = JSON.stringify(MANIFEST);
  plan(state, req({ side: 'right', executionId: 'e-right2' }));
  assert.equal(JSON.stringify(MANIFEST), manifestSnapshot, 'manifest 未被修改');
});

// ---------------------------------------------------------------- LP-17 flag
test('LP-17 feature flag 关：决策恒 rejected(disabled)，状态零变化', () => {
  const r = planMotionAllocation(emptyLimbPlan(), req(), MANIFEST, CATALOG, NOW);
  assert.equal(r.decision.accepted, false);
  assert.equal(r.decision.reason, 'disabled');
  assert.deepEqual(r.decision.parameterDomains, []);

  const held = plan(emptyLimbPlan(), req({ executionId: 'e1' })).state;
  const off = planMotionAllocation(held, req({ executionId: 'e2' }), MANIFEST, CATALOG, NOW + 1);
  assert.deepEqual(off.state.holds, held.holds, 'flag 关不得改变既有持有');
});

// ---------------------------------------------------------------- LP-18 到期
test('LP-18 到期兜底：tick 释放过期持有，空出的部位可再准入', () => {
  const r = plan(emptyLimbPlan(), req({ executionId: 'e1', durationMs: 100 }));
  const tick = tickLimbPlan(r.state, NOW + 100);
  assert.equal(tick.expired.length, 1, 'endAt <= now 视为已释放（INV-5）');
  assert.deepEqual(tick.state.holds, []);

  const reuse = plan(tick.state, req({ executionId: 'e2' }), { now: NOW + 101 });
  assert.equal(reuse.decision.accepted, true);

  const timeout = settleLimbHold(r.state, { executionId: 'e1', outcome: 'timeout' }, NOW + 100);
  assert.deepEqual(timeout.released, [], '超时后再 settle 幂等（已按到期释放）');
  assert.equal(timeout.reason, 'unknown-hold');
});

// ---------------------------------------------------------------- LP-19 红线
test('LP-19 红线：源码无参数写入、无时间/随机/宿主依赖', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, '..', 'src', 'limb-plan.ts'), 'utf8');
  const banned = [
    'setParameterValueById',
    'Date.now',
    'Math.random',
    'document.',
    'window.',
    'requestAnimationFrame',
    'setTimeout',
    'fetch(',
  ];
  for (const token of banned) assert.ok(!src.includes(token), '禁止出现 ' + token);

  const ids = ['RArm', 'LArm', 'Param36', 'Param42', 'Param59'];
  for (const id of ids) assert.ok(!src.includes(id), 'src 不得硬编码参数名 ' + id);
});

// ---------------------------------------------------------------- LP-20 settle 输入
test('LP-20 settle 非法输入 fail-closed（不抛出、不改状态）', () => {
  const held = plan(emptyLimbPlan(), req({ executionId: 'e1' })).state;
  const bad = settleLimbHold(held, { executionId: '', outcome: 'completed' }, NOW + 1);
  assert.equal(bad.reason, 'invalid-settle');
  assert.deepEqual(bad.state.holds, held.holds);
  assert.deepEqual(bad.released, []);
});

console.log('\nlimb-plan: ' + passed + ' cases passed');
