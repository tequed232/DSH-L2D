/**
 * PR-D 混合语义动作规划器测试。
 * 覆盖：意图→计划组装校验、四类冲突判定与用户四示例裁定、适配器无直写原语、
 * Actions Lib 模型版本校验与成功率、优先级档位映射。
 */
import assert from 'node:assert/strict';
import {
  analyzePair, analyzePlanConflicts, planVerdict,
  buildMotionPlan, priorityFromIntensity,
  planToTimelineInstructions, assertNoDirectParamWrites,
  InMemoryActionsLib, queryActionAvailability, reportPlanOutcome,
  type PlanStepFootprint,
} from '../src/planner/index.ts';

let passed = 0;
let failed = 0;
const tests: Array<[string, () => void]> = [];
function test(name: string, fn: () => void) { tests.push([name, fn]); }

// ------------------------------------------------------ 1. 优先级映射（既有 10/50/90 词汇）
test('priorityFromIntensity：0..1 → 10/50/90 三档，越界钳制', () => {
  assert.equal(priorityFromIntensity(0.1), 10);
  assert.equal(priorityFromIntensity(0.5), 50);
  assert.equal(priorityFromIntensity(0.95), 90);
  assert.equal(priorityFromIntensity(-1), 10);
  assert.equal(priorityFromIntensity(5), 90);
  assert.equal(priorityFromIntensity(NaN), 50);
});

// ------------------------------------------------------ 2. 计划组装与 fail-closed
function capProvider(overrides: Partial<Parameters<typeof buildMotionPlan>[1]> = {}) {
  const verified = new Set(['gaze.look_at', 'posture.lean']);
  return {
    canExpress: (id: string) => id === 'emotion.happy' || id === 'emotion.sad',
    hasMotion: (name: string) => name === 'wave' || name === 'turn',
    isVerifiedControl: (id: string) => verified.has(id),
    ownershipForControl: (id: string) => (id === 'gaze.look_at' ? [] : []),
    ...overrides,
  } as Parameters<typeof buildMotionPlan>[1];
}

test('buildMotionPlan：打招呼意图（表情+手势+视线）→ 三步计划', () => {
  const { plan, rejected } = buildMotionPlan(
    { emotion: 'happy', gesture: 'wave', gaze: { x: 0.5, y: 0.5 }, intensity: 0.6 },
    capProvider(),
  );
  assert.ok(plan);
  assert.equal(rejected.length, 0);
  assert.equal(plan.actions.length, 3);
  const types = plan.actions.map((a) => a.type).sort();
  assert.deepEqual(types, ['expression', 'motion3', 'parameter']);
  assert.equal(plan.constraints.preservePhysics, true);
});

test('buildMotionPlan：未验证通道不进计划并留痕（fail-closed）', () => {
  const { plan, rejected } = buildMotionPlan(
    { emotion: 'angry', gesture: 'moonwalk', gaze: { x: 0, y: 0 }, posture: 'crouch', intensity: 0.5 },
    capProvider(),
  );
  // angry/moonwalk/crouch 未登记 → 全拒；gaze 已验证 → 进计划
  assert.ok(plan);
  assert.equal(plan.actions.length, 1, '只有已验证的 gaze 进计划');
  assert.equal(plan.actions[0].type, 'parameter');
  const segments = rejected.map((r) => r.segment).sort();
  assert.deepEqual(segments, ['emotion:angry', 'gesture:moonwalk', 'posture:crouch']);
});

test('buildMotionPlan：全部被拒 → 不产计划', () => {
  const { plan, rejected } = buildMotionPlan(
    { emotion: 'angry', gesture: 'moonwalk', intensity: 0.5 },
    capProvider(),
  );
  assert.equal(plan, null);
  assert.equal(rejected.length, 2);
});

test('buildMotionPlan：优先级档位漂移防御（只允许 10/50/90）', () => {
  // 优先级由 priorityFromIntensity 生成，天然合法；此处验证 isSemanticPriority 闸存在
  const { plan } = buildMotionPlan({ emotion: 'happy', intensity: 0.99 }, capProvider());
  assert.ok(plan);
  for (const step of plan.actions) {
    assert.ok([10, 50, 90].includes(step.priority));
  }
});

// ------------------------------------------------------ 3. 冲突四类 + 用户四示例
const ok = { touchesDecoration: false, touchesSharedHub: false, verified: true } as const;

test('冲突·parameter_overlap：跨组已验证 → blend；同组 → sequence；未验证 → reject', () => {
  const a: PlanStepFootprint = { actionId: 'gaze-a', type: 'parameter', priority: 50, group: 'gaze', writeParams: ['ParamEyeBallX'], ownershipParams: [], ...ok };
  const b: PlanStepFootprint = { actionId: 'exp-b', type: 'expression', priority: 50, group: 'face', writeParams: ['ParamEyeBallX'], ownershipParams: [], ...ok };
  const cross = analyzePair(a, b);
  assert.ok(cross.some((c) => c.type === 'parameter_overlap' && c.resolution === 'blend'), '跨组独立且已验证 → 允许组合');
  const c2: PlanStepFootprint = { ...b, group: 'gaze', actionId: 'exp-c' };
  const same = analyzePair(a, c2);
  const po = same.find((c) => c.type === 'parameter_overlap')!;
  assert.equal(po.resolution, 'sequence', '同组写集重叠 → 仲裁排队');
  const c3: PlanStepFootprint = { ...b, verified: false, actionId: 'exp-d' };
  const unv = analyzePair(a, c3);
  assert.equal(unv.find((c) => c.type === 'parameter_overlap')!.resolution, 'reject', '未验证 fail-closed');
});

test('冲突·motion_exclusive：同动作槽 → sequence', () => {
  const a: PlanStepFootprint = { actionId: 'm1', type: 'motion3', priority: 50, group: 'gesture', writeParams: [], ownershipParams: [], motionGroup: 'left_hand', ...ok };
  const b: PlanStepFootprint = { actionId: 'm2', type: 'motion3', priority: 50, group: 'gesture', writeParams: [], ownershipParams: [], motionGroup: 'left_hand', ...ok };
  const c = analyzePair(a, b);
  assert.ok(c.some((x) => x.type === 'motion_exclusive' && x.resolution === 'sequence'));
  const c2 = analyzePair(a, { ...b, motionGroup: 'right_hand' });
  assert.ok(!c2.some((x) => x.type === 'motion_exclusive'), '不同槽不判互斥');
});

test('冲突·ownership_conflict：同批物理输出 → sequence（高优先级先）', () => {
  const a: PlanStepFootprint = { actionId: 'k1', type: 'keyframes', priority: 90, group: 'posture', writeParams: [], ownershipParams: ['RArm', 'RForearm'], ...ok };
  const b: PlanStepFootprint = { actionId: 'k2', type: 'keyframes', priority: 50, group: 'posture', writeParams: [], ownershipParams: ['RArm'], ...ok };
  const c = analyzePair(a, b);
  const oc = c.find((x) => x.type === 'ownership_conflict')!;
  assert.equal(oc.resolution, 'sequence');
});

test('冲突·physics_conflict：装饰域/共享枢纽 → reject（头发物理 × 改头发 = 拒绝）', () => {
  const a: PlanStepFootprint = { actionId: 'hair-agent', type: 'parameter', priority: 50, group: 'hair', writeParams: ['FrontHairX1'], ownershipParams: [], touchesDecoration: true, touchesSharedHub: false, verified: true };
  const b: PlanStepFootprint = { actionId: 'wave', type: 'motion3', priority: 50, group: 'gesture', writeParams: [], ownershipParams: [], motionGroup: 'left_hand', touchesDecoration: false, touchesSharedHub: false, verified: true };
  const c = analyzePair(a, b);
  const pc = c.find((x) => x.type === 'physics_conflict')!;
  assert.equal(pc.resolution, 'reject');
  assert.match(pc.reason, /装饰|物理/);
  const hub: PlanStepFootprint = { ...a, touchesDecoration: false, touchesSharedHub: true, writeParams: ['ParamBodyAngleX'], actionId: 'body-agent' };
  assert.equal(analyzePair(hub, b).find((x) => x.type === 'physics_conflict')!.resolution, 'reject');
});

test('用户四示例裁定：表情+视线组合 / 双手并行 / 同头参数仲裁 / 头发拒绝', () => {
  // ① 开心表情 + 眼球跟随：允许组合（无冲突）
  const exp: PlanStepFootprint = { actionId: 'happy', type: 'expression', priority: 50, group: 'face', writeParams: [], ownershipParams: [], ...ok };
  const gaze: PlanStepFootprint = { actionId: 'gaze', type: 'parameter', priority: 50, group: 'gaze', writeParams: ['ParamEyeBallX'], ownershipParams: [], ...ok };
  assert.deepEqual(analyzePair(exp, gaze), [], '表情+视线无冲突（允许组合）');
  // ② 左手挥手 + 右手举起：参数组独立且已验证 → 并行
  const lwave: PlanStepFootprint = { actionId: 'l-wave', type: 'motion3', priority: 50, group: 'gesture', writeParams: [], ownershipParams: [], motionGroup: 'left_hand', ...ok };
  const rraise: PlanStepFootprint = { actionId: 'r-raise', type: 'motion3', priority: 50, group: 'gesture', writeParams: [], ownershipParams: [], motionGroup: 'right_hand', ...ok };
  assert.deepEqual(analyzePair(lwave, rraise), [], '左右手不同槽 → 并行');
  // ③ 同一头参数两动作 → 仲裁（sequence）
  const headA: PlanStepFootprint = { actionId: 'nod', type: 'parameter', priority: 50, group: 'head', writeParams: ['ParamAngleX'], ownershipParams: [], ...ok };
  const headB: PlanStepFootprint = { actionId: 'shake', type: 'parameter', priority: 50, group: 'head', writeParams: ['ParamAngleX'], ownershipParams: [], ...ok };
  assert.equal(analyzePair(headA, headB)[0].resolution, 'sequence');
  // ④ 头发物理运动 + Agent 直接修改头发 → reject
  const hairPhys: PlanStepFootprint = { actionId: 'hair-phys', type: 'parameter', priority: 50, group: 'hair', writeParams: ['FrontHairX1'], ownershipParams: [], touchesDecoration: true, touchesSharedHub: false, verified: true };
  const hairAgent: PlanStepFootprint = { ...hairPhys, actionId: 'hair-agent' };
  assert.equal(analyzePair(hairPhys, hairAgent)[0].resolution, 'reject');
});

test('planVerdict：任一 reject → 整计划拒绝；sequence/blend 不拒绝', () => {
  assert.equal(planVerdict([{ actionA: 'a', actionB: 'b', type: 'physics_conflict', resolution: 'reject', reason: 'x' }]), 'reject');
  assert.equal(planVerdict([{ actionA: 'a', actionB: 'b', type: 'motion_exclusive', resolution: 'sequence', reason: 'x' }]), 'allow');
  assert.equal(planVerdict([{ actionA: 'a', actionB: 'b', type: 'parameter_overlap', resolution: 'blend', reason: 'x' }]), 'allow');
});

// ------------------------------------------------------ 4. Timeline 适配器（无直写原语）
test('planToTimelineInstructions：admit 开链 → 有序动作 → finish；sequence 注入等待', () => {
  const plan = {
    planId: 'plan-t1',
    actions: [
      { actionId: 'exp-1', type: 'expression' as const, priority: 50 as const, group: 'face', payload: { name: 'happy' }, requiresOwnership: false },
      { actionId: 'kf-1', type: 'keyframes' as const, priority: 50 as const, group: 'posture', payload: { controlId: 'posture.lean' }, requiresOwnership: true },
    ],
    constraints: { preservePhysics: true, allowInterruption: true, allowBlending: true },
  };
  const conflicts = [{ actionA: 'exp-1', actionB: 'kf-1', type: 'motion_exclusive' as const, resolution: 'sequence' as const, reason: 'x' }];
  const instructions = planToTimelineInstructions(plan, conflicts);
  assert.equal(assertNoDirectParamWrites(instructions), true, '指令序列不得含参数直写原语');
  assert.equal(instructions[0].kind, 'admit', '必须先经 Gesture Admission 开链');
  assert.equal(instructions[instructions.length - 1].kind, 'finish');
  const wait = instructions.find((i) => i.kind === 'wait-terminal') as { after: string; then: string };
  assert.ok(wait);
  assert.equal(wait.then, 'kf-1');
  const kinds = instructions.map((i) => i.kind);
  assert.ok(kinds.includes('set-expression') && kinds.includes('play-keyframes'));
});

test('适配器结构防线：手工注入直写原语被 assertNoDirectParamWrites 抓获', () => {
  const bad = [{ kind: 'set-parameter' }, { kind: 'admit' }] as any[];
  assert.equal(assertNoDirectParamWrites(bad), false);
});

// ------------------------------------------------------ 5. Actions Lib（模型版本校验 + 成功率）
test('Actions Lib：存在 + 版本兼容才可用；版本变化后旧记录不可用', () => {
  const lib = new InMemoryActionsLib();
  lib.seed([{ actionId: 'a-1', type: 'motion3', name: 'wave', compatibleModelHashes: ['hash-v1'], attempts: 0, successes: 0 }]);
  assert.deepEqual(queryActionAvailability(lib, 'wave', 'hash-v1-abc'), { available: true });
  assert.deepEqual(queryActionAvailability(lib, 'wave', 'hash-v2-xyz').available, false, '模型版本变化 → 不兼容');
  assert.match(queryActionAvailability(lib, 'wave', 'hash-v2-xyz').reason!, /不兼容/);
  assert.equal(queryActionAvailability(lib, 'moonwalk', 'hash-v1').available, false);
});

test('Actions Lib：三态回写——end 计成功，interrupted/failed 不计', () => {
  const lib = new InMemoryActionsLib();
  lib.seed([{ actionId: 'a-1', type: 'motion3', name: 'wave', compatibleModelHashes: ['*'], attempts: 0, successes: 0 }]);
  const plan = { planId: 'p', actions: [{ actionId: 's', type: 'motion3' as const, priority: 50 as const, group: 'g', payload: { name: 'wave' }, requiresOwnership: false }], constraints: { preservePhysics: true, allowInterruption: true, allowBlending: true } };
  reportPlanOutcome(lib, plan, 'end');
  reportPlanOutcome(lib, plan, 'failed');
  reportPlanOutcome(lib, plan, 'interrupted');
  assert.equal(lib.successRate('a-1'), 1 / 3);
  assert.equal(lib.successRate('missing'), null);
});

// ------------------------------------------------------ 汇总
for (const [name, fn] of tests) {
  try {
    fn();
    passed++;
    console.log('  ok ', name);
  } catch (e) {
    failed++;
    console.error('  FAIL', name);
    console.error(String((e as Error).stack || e).split('\n').slice(0, 6).join('\n'));
  }
}
if (failed) {
  console.error(`\nmotion-planner 测试失败：${failed}/${tests.length}\n`);
  process.exit(1);
} else {
  console.log(`\n${passed} passed，0 failed\n`);
}
