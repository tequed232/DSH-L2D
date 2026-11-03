/**
 * Motion Engine 契约 v2 单测（PR #10 review fix）：
 * 契约常量 / profile 校验正负例 / 能力解析 / 语义帧 → intent 降级 / 轨迹编译与采样。
 *
 * 帧循环相关的约定（validate-once、不 throw、段缓动归属左端点）都在这里钉住。
 */
import assert from 'node:assert/strict';
import {
  MOTION_CONTRACT_VERSION, SEMANTIC_CONTROL_IDS, SEMANTIC_PRIORITIES, SEMANTIC_SOURCE_RANK,
  isSemanticControlId, isSemanticPriority, isSemanticSource,
  type ModelMotionProfile, type SemanticControlCapability,
} from '../src/motion-contract.ts';
import {
  clampSemanticValue, hasAsset, resolveSemanticControl, selectMotionAdapter, validateMotionProfile,
} from '../src/motion-profile.ts';
import {
  PRE_ONLY_PARAMS, defaultPhaseForParam, lowerFrameToIntents, validateChannelBindings,
  type ChannelBinding,
} from '../src/motion-intent.ts';
import {
  compileTrajectory, compileTrajectoryCached, easeAt, sampleCompiled, sampleTrajectory,
  sampleTrajectorySafe, validateTrajectory,
} from '../src/motion-trajectory.ts';

// ---------------------------------------------------------------------------
// 1) 契约常量：与既有优先级/source 秩同一份，不新增词汇
// ---------------------------------------------------------------------------
assert.equal(MOTION_CONTRACT_VERSION, 2);
assert.deepEqual([...SEMANTIC_PRIORITIES], [10, 50, 90]); // = ACT_PRIORITY_RANK
assert.equal(SEMANTIC_SOURCE_RANK.motion, 2);
assert.equal(SEMANTIC_SOURCE_RANK.gaze, 5);
assert.equal(SEMANTIC_SOURCE_RANK.limb, 6);
assert.equal(SEMANTIC_CONTROL_IDS.length, 13);
assert.ok(isSemanticControlId('head.yaw'));
assert.ok(isSemanticControlId('face.blink'));
assert.ok(isSemanticControlId('body.breathing'));
assert.ok(isSemanticControlId('ext.vrm.jaw'));
assert.equal(isSemanticControlId('head.wrong'), false);
assert.equal(isSemanticControlId(''), false);
assert.equal(isSemanticPriority(50), true);
assert.equal(isSemanticPriority(70), false); // 第四套优先级数值一律拒绝
assert.equal(isSemanticSource('limb'), true);
assert.equal(isSemanticSource('physics'), false); // physics 是裁决者不是生产者

// ---------------------------------------------------------------------------
// 2) Profile 校验：正例 + 负例（旧测试只有正例，跑绿也发现不了问题）
// ---------------------------------------------------------------------------
const profile: ModelMotionProfile = {
  contractVersion: MOTION_CONTRACT_VERSION,
  modelId: 'fixture-model-a',
  adapterId: 'cubism-web',
  profileRevision: 'fixture-1',
  controls: [
    { id: 'head.yaw', status: 'supported', min: -1, max: 1, neutral: 0, confidence: 1, sourceId: 'AngleX' },
    { id: 'arm.right.raise', status: 'unsupported', min: -1, max: 1, neutral: 0, confidence: 0, reason: 'no writable arm control' },
    { id: 'ext.vrm.jaw', status: 'unknown', min: -1, max: 1, neutral: 0, confidence: 0.2, reason: 'not verified on this model' },
  ],
  assets: [{ id: 'wave-motion', kind: 'motion', status: 'supported', resources: ['arm.right'], interruptible: true, loopable: false }],
};
const valid = validateMotionProfile(profile);
assert.equal(valid.ok, true, JSON.stringify(valid.errors));
assert.deepEqual(valid.errors, []);
// unknown 是合法状态（文档要求 fail-closed 的"不知道"）
assert.equal(validateMotionProfile({ ...profile, controls: [profile.controls[2]] }).ok, true);

const errorish = (patch: Record<string, unknown>) => validateMotionProfile({ ...profile, ...patch });
assert.equal(errorish({ contractVersion: 1 }).ok, false); // v1 → v2 不互通
assert.equal(errorish({ modelId: '' }).ok, false);
assert.equal(errorish({ profileRevision: '' }).ok, false);
assert.equal(errorish({ controls: 'nope' }).ok, false);
assert.equal(errorish({ metadata: [] }).ok, false);
assert.equal(errorish({ metadata: { bad: { nested: true } } }).ok, false);

const controlError = (control: Record<string, unknown>) =>
  validateMotionProfile({ ...profile, controls: [{ ...profile.controls[0], ...control }] }).errors.join('; ');
assert.match(controlError({ status: 'maybe' }), /status is invalid/);
assert.match(controlError({ id: 'head.wrong' }), /not a semantic control id/);
assert.match(controlError({ neutral: 9 }), /invalid range or neutral/);
assert.match(controlError({ confidence: 2 }), /confidence/);
const duplicateControls = validateMotionProfile({ ...profile, controls: [profile.controls[0], profile.controls[0]] });
assert.match(duplicateControls.errors.join('; '), /duplicate control/);
// supported 没有 sourceId 只告警不报错（adapter 可能在内部解析）
const noSource = validateMotionProfile({ ...profile, controls: [{ id: 'head.yaw', status: 'supported', min: -1, max: 1, neutral: 0, confidence: 1 }] });
assert.equal(noSource.ok, true);
assert.match(noSource.warnings.join('; '), /no sourceId/);

const assetError = (asset: Record<string, unknown>) =>
  validateMotionProfile({ ...profile, assets: [{ ...profile.assets[0], ...asset }] }).errors.join('; ');
assert.match(assetError({ kind: 'dance' }), /kind is invalid/);
assert.match(assetError({ status: 'unsupported' }), /status is invalid/);
assert.match(assetError({ resources: 'arm' }), /resources must be string/);
assert.match(assetError({ interruptible: 'yes' }), /interruptible must be boolean/);
assert.match(assetError({ loopable: undefined }), /loopable must be boolean/);
assert.match(assetError({ durationMs: -1 }), /durationMs/);

// ---------------------------------------------------------------------------
// 3) 能力解析：unknown/unsupported 一律不可写（fail-closed）
// ---------------------------------------------------------------------------
assert.equal(resolveSemanticControl(profile, 'head.yaw')?.sourceId, 'AngleX');
assert.equal(resolveSemanticControl(profile, 'arm.right.raise'), null);
assert.equal(resolveSemanticControl(profile, 'ext.vrm.jaw'), null); // unknown ≠ 可写
assert.equal(resolveSemanticControl(profile, 'no.such'), null);
assert.equal(resolveSemanticControl(null, 'head.yaw'), null);
assert.equal(resolveSemanticControl({ controls: 'nope' } as never, 'head.yaw'), null);

const yaw: SemanticControlCapability = profile.controls[0];
assert.equal(clampSemanticValue(yaw, 2), 1);
assert.equal(clampSemanticValue(yaw, -9), -1);
assert.equal(clampSemanticValue(yaw, 0.25), 0.25);
assert.equal(clampSemanticValue(yaw, Number.NaN), null);
assert.equal(clampSemanticValue(profile.controls[1], 0.5), null); // unsupported
assert.equal(clampSemanticValue(profile.controls[2], 0.5), null); // unknown
assert.equal(clampSemanticValue({ ...yaw, min: 5, max: -5 }, 0), null); // 非法区间不产出 NaN
assert.equal(clampSemanticValue({ ...yaw, min: Number.NaN } as never, 0), null);
assert.equal(clampSemanticValue(null, 0), null);

assert.equal(hasAsset(profile, 'wave-motion'), true);
assert.equal(hasAsset(profile, 'nope'), false);
assert.equal(hasAsset(null, 'wave-motion'), false);

// Adapter 选择：无匹配 → null；supports() 抛异常继续试下一个，但必须留告警
const adapterA = { id: 'a' } as never;
const adapterB = { id: 'b' } as never;
assert.equal(selectMotionAdapter('m', [
  { adapter: adapterA, supports: () => false },
  { adapter: adapterB, supports: (model) => model === 'm' },
])?.adapter, adapterB);
assert.equal(selectMotionAdapter('m', [{ adapter: adapterA, supports: () => false }]), null);
assert.equal(selectMotionAdapter('m', []), null);
assert.equal(selectMotionAdapter('m', null as never), null);
const warnings: string[] = [];
const chosen = selectMotionAdapter('m', [
  { adapter: adapterA, supports: () => { throw new Error('boom'); } },
  { adapter: adapterB, supports: (model) => model === 'm' },
], { warnings });
assert.equal(chosen?.adapter, adapterB);
assert.match(warnings.join('; '), /supports\(\) threw: boom/);

// ---------------------------------------------------------------------------
// 4) 绑定表校验（Adapter 装配期一次，不进帧循环）
// ---------------------------------------------------------------------------
const bindings: ChannelBinding[] = [
  { controlId: 'head.yaw', paramId: 'AngleX', scale: 30, bounds: [-30, 30] },
  { controlId: 'head.pitch', paramId: 'AngleY', scale: 30, bounds: [-30, 30] },
  { controlId: 'torso.lean', paramId: 'LeanInput', scale: 30, bounds: [-30, 30] },
  { controlId: 'torso.sway', paramId: 'PositionX', scale: 10, bounds: [-10, 10] },
  { controlId: 'gaze.x', paramId: 'ParamEyeBallX', source: 'gaze' },
  { controlId: 'arm.right.raise', paramId: 'Param36', source: 'limb', phase: 'post' },
];
assert.deepEqual(validateChannelBindings(bindings), { ok: true, errors: [] });
assert.equal(validateChannelBindings('nope').ok, false);
assert.match(validateChannelBindings([{ controlId: 'head.yaw' }]).errors.join('; '), /paramId is required/);
assert.match(validateChannelBindings([{ ...bindings[0], controlId: 'head.wrong' }]).errors.join('; '), /not a semantic control id/);
assert.match(validateChannelBindings([{ ...bindings[0], bounds: [5, -5] }]).errors.join('; '), /bounds must be/);
assert.match(validateChannelBindings([bindings[0], bindings[0]]).errors.join('; '), /duplicate binding/);

// ---------------------------------------------------------------------------
// 5) 语义帧 → intent：唯一降级路径，字段严格对齐既有 intent 契约
// ---------------------------------------------------------------------------
const lower = (frame: unknown, table = bindings) => lowerFrameToIntents(frame as never, table);

const yawFrame = lower({ decisionId: 'd-1', controls: { 'head.yaw': 0.5 }, runId: 'run-7' });
assert.deepEqual(yawFrame.rejected, []);
assert.equal(yawFrame.intents.length, 1);
const yawIntent = yawFrame.intents[0];
assert.deepEqual(Object.keys(yawIntent).sort(), ['id', 'params', 'phase', 'priority', 'runId', 'source']);
assert.equal(yawIntent.id, 'd-1#0');
assert.equal(yawIntent.source, 'motion');
assert.equal(yawIntent.priority, 50); // 缺省 NORMAL
assert.equal(yawIntent.phase, 'pre'); // AngleX 是物理根输入 → 默认 pre（INV-7）
assert.equal(yawIntent.params.AngleX, 15);
assert.equal(yawIntent.runId, 'run-7');

// 默认相位推断：PositionX / LeanInput / HipAngleX 都是 pre，姿态骨/眼球是 post
assert.equal(defaultPhaseForParam('PositionX'), 'pre');
assert.equal(defaultPhaseForParam('LeanInput'), 'pre');
assert.equal(defaultPhaseForParam('HipAngleY'), 'pre');
assert.equal(defaultPhaseForParam('Param36'), 'post');
assert.equal(defaultPhaseForParam('ParamEyeBallX'), 'post');
assert.ok(PRE_ONLY_PARAMS.has('AngleZ'));
assert.equal(PRE_ONLY_PARAMS.has('Param36'), false);

// 显式 post 写物理根输入 → 拒（否则物理每帧覆盖，属于白写）
const postOnPre = lower({ controls: { 'head.yaw': 0.5 }, phase: 'post' });
assert.deepEqual(postOnPre.intents, []);
assert.equal(postOnPre.rejected[0].reason, 'pre-only-param');

// 眼球走 gaze 来源、post 相位
const gazeFrame = lower({ controls: { 'gaze.x': 0.3 }, source: 'gaze' });
assert.equal(gazeFrame.intents[0].source, 'gaze');
assert.equal(gazeFrame.intents[0].phase, 'post');
assert.equal(gazeFrame.intents[0].params.ParamEyeBallX, 0.3);

// 四肢走 limb、FORCE 优先级
const armFrame = lower({ controls: { 'arm.right.raise': 0.8 }, priority: 90, source: 'limb' });
assert.equal(armFrame.intents[0].priority, 90);
assert.equal(armFrame.intents[0].source, 'limb');
assert.equal(armFrame.intents[0].phase, 'post');
assert.equal(armFrame.intents[0].params.Param36, 0.8);

// 分组：同 source/priority/phase 合并成一条；不同 priority 分开
const grouped = lower({ controls: { 'head.yaw': 0.2, 'head.pitch': -0.2 } });
assert.equal(grouped.intents.length, 1);
assert.deepEqual(Object.keys(grouped.intents[0].params).sort(), ['AngleX', 'AngleY']);
const split = lowerFrameToIntents(
  { controls: { 'head.yaw': 0.2, 'head.pitch': 0.3 } },
  [
    { controlId: 'head.yaw', paramId: 'AngleX', phase: 'pre', source: 'motion' },
    { controlId: 'head.pitch', paramId: 'AngleY', phase: 'pre', source: 'pose' },
  ],
  {},
);
assert.equal(split.intents.length, 2);
assert.deepEqual(split.intents.map((intent) => intent.source), ['motion', 'pose']);

// 拒绝路径：全部 fail-closed，不静默丢
assert.equal(lower({ controls: { 'no.such': 1 } }).rejected[0].reason, 'unknown-control');
assert.equal(lower({ controls: { 'face.blink': 1 } }).rejected[0].reason, 'unbound-control');
assert.equal(lower({ controls: { 'head.yaw': Number.NaN } }).rejected[0].reason, 'invalid-value');
assert.equal(lower({ controls: { 'head.yaw': 'x' } }).rejected[0].reason, 'invalid-value');
const duplicateParam = lowerFrameToIntents(
  { controls: { 'head.yaw': 0.1, 'head.pitch': 0.2 } },
  [
    { controlId: 'head.yaw', paramId: 'AngleX', phase: 'pre' },
    { controlId: 'head.pitch', paramId: 'AngleX', phase: 'pre' },
  ],
);
assert.equal(duplicateParam.intents.length, 1);
assert.match(duplicateParam.rejected[0].reason, /duplicate-param:AngleX/);
assert.equal(lower({ controls: { 'head.yaw': 1 }, priority: 70 }).rejected[0].reason, 'invalid-priority');
assert.equal(lower({ controls: { 'head.yaw': 1 }, source: 'physics' }).rejected[0].reason, 'invalid-source');
assert.equal(lower(null).rejected[0].reason, 'invalid-frame');
assert.deepEqual(lower({ controls: {} }).warnings, ['empty-frame']);
// 边界钳制生效（超出 bounds）
assert.equal(lower({ controls: { 'head.yaw': 99 } }).intents[0].params.AngleX, 30);
// 绑定里非有限数
assert.equal(lowerFrameToIntents({ controls: { 'head.yaw': 1 } }, [{ controlId: 'head.yaw', paramId: 'AngleX', scale: Number.NaN }]).rejected[0].reason, 'invalid-binding');

// ---------------------------------------------------------------------------
// 6) 轨迹：编译一次 + 采样不校验、不抛；缓动复用 ease.ts
// ---------------------------------------------------------------------------
const trajectory = {
  durationMs: 1000,
  tracks: [{
    controlId: 'head.yaw',
    keyframes: [
      { atMs: 0, value: 0, easing: 'ease-in-out' as const },
      { atMs: 500, value: 1, easing: 'ease-out' as const },
      { atMs: 1000, value: 0 },
    ],
  }],
};
assert.deepEqual(validateTrajectory(trajectory), []);
const compiled = compileTrajectory(trajectory);
assert.equal(compiled.ok, true);
if (!compiled.ok) throw new Error('compile failed');
assert.equal(compiled.compiled.tracks[0].segments.length, 2);
assert.deepEqual(compiled.compiled.tracks[0].segments.map((segment) => segment.easing), ['ease-in-out', 'ease-out']);

// 采样边界：0 / 区间内 / 正好落在中间关键帧 / duration / 超出
assert.equal(sampleCompiled(compiled.compiled, 0).values['head.yaw'], 0);
const mid = sampleCompiled(compiled.compiled, 250).values['head.yaw'];
assert.ok(mid > 0 && mid < 1, `250ms 应在中间值，实际 ${mid}`);
assert.equal(sampleCompiled(compiled.compiled, 500).values['head.yaw'], 1);
assert.equal(sampleCompiled(compiled.compiled, 1000).values['head.yaw'], 0);
assert.equal(sampleCompiled(compiled.compiled, 1200).values['head.yaw'], 0);
assert.equal(sampleCompiled(compiled.compiled, 1200).complete, true);
assert.equal(sampleCompiled(compiled.compiled, Number.NaN).values['head.yaw'], 0);

// 缓存：同一对象只编译一次
assert.equal(compileTrajectoryCached(trajectory), compileTrajectoryCached(trajectory));
assert.equal(compileTrajectoryCached(trajectory).ok, true);

// 段缓动取左端点：第二段（500→1000，from=1 → to=0）用 500ms 那帧的 ease-out
// t=0.5 → ease-out(0.5)=0.75 → 1 + (0-1)*0.75 = 0.25
const segmentSample = sampleCompiled(compiled.compiled, 750).values['head.yaw'];
assert.ok(Math.abs(segmentSample - 0.25) < 1e-9, `期望 0.25，实际 ${segmentSample}`);

// 缓动表：未知 easing 退回线性（不产生 NaN）
assert.equal(easeAt(0.5, 'linear'), 0.5);
assert.ok(Math.abs(easeAt(0.5, 'smoothstep') - 0.5) < 1e-9);
assert.ok(Math.abs(easeAt(0.5, 'ease-in-out') - 0.5) < 1e-9);
assert.equal(easeAt(0.5, 'bogus' as never), 0.5);

// 非法轨迹：safe 返回错误，throw 入口抛；帧路径不应依赖 throw
const invalid = { durationMs: 0, tracks: [] };
assert.equal(compileTrajectory(invalid as never).ok, false);
assert.equal(sampleTrajectorySafe(invalid as never, 0).ok, false);
assert.throws(() => sampleTrajectory(invalid as never, 0));
assert.match(validateTrajectory({ durationMs: 1000, tracks: [
  { controlId: 'x', keyframes: [{ atMs: 0, value: 0 }] },
] } as never).join('; '), /needs at least two keyframes/);
assert.match(validateTrajectory({ durationMs: 1000, tracks: [
  { controlId: 'x', keyframes: [{ atMs: 0, value: 0 }, { atMs: 500, value: 1 }] },
] } as never).join('; '), /must end at durationMs/);
assert.match(validateTrajectory({ durationMs: 1000, tracks: [
  { controlId: 'x', keyframes: [{ atMs: 0, value: 0 }, { atMs: 1000, value: 1 }] },
  { controlId: 'x', keyframes: [{ atMs: 0, value: 0 }, { atMs: 1000, value: 1 }] },
] } as never).join('; '), /duplicate track/);
assert.match(validateTrajectory({ durationMs: 1000, tracks: [
  { controlId: 'x', keyframes: [{ atMs: 0, value: 0 }, { atMs: 0, value: 1 }, { atMs: 1000, value: 0 }] },
] } as never).join('; '), /strictly increasing/);

// 端点容差：浮点构造的 duration 不应被误拒
assert.deepEqual(validateTrajectory({ durationMs: 1000, tracks: [
  { controlId: 'x', keyframes: [{ atMs: 0, value: 0 }, { atMs: 999.9999999, value: 1 }] },
] } as never), []);

// 采样不修改输入
const before = JSON.stringify(trajectory);
sampleTrajectory(trajectory, 123);
assert.equal(JSON.stringify(trajectory), before);

console.log('motion contract v2 ok');
