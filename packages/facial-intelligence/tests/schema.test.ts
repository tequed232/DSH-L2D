/**
 * Schema 验证测试（任务书 Part 18 Schema Tests + Part 9 安全验证）。
 *
 * 用例编号 SV-xx 对照：
 *   SV-01  合法 JSON 可以通过
 *   SV-02  非法情绪被拒绝
 *   SV-03  NaN / Infinity 被拒绝
 *   SV-04  越界值按明确规则裁剪并记入 warnings
 *   SV-05  不支持的 Schema 版本被拒绝
 *   SV-06  白名单外字段（含 parameterId / script / tool 注入）被拒绝
 *   SV-07  durationMs / holdMs / priority 越限被裁剪，priority 不突破 700
 *   SV-08  非法来源（source）被拒绝
 *   SV-09  JSON 文本入口：解析失败收敛为统一错误格式
 */
import assert from 'node:assert/strict';
import { parseFacialPlanJson, validateFacialPlan, LIMITS } from '../src/schema/validator.ts';

let passed = 0;
const test = (name: string, fn: () => void) => {
  fn();
  passed++;
  console.log('  ok  ' + name);
};

/** 任务书 Part 8.2 的期望输出样例（合法基线） */
const validPlan = {
  version: '1.0',
  dialogue: '今天稍微有点累嘛。',
  intent: {
    emotion: 'tired',
    intensity: 0.45,
    face: {
      eyes: { openness: 0.72, squint: 0.18, gazeX: 0, gazeY: -0.1 },
      brows: { leftRaise: 0, rightRaise: 0, leftFurrow: 0.05, rightFurrow: 0.05 },
      mouth: { open: 0, smile: 0.05, form: 0 },
      head: { yaw: 0, pitch: 0.12, roll: 0 },
    },
    transition: { durationMs: 650, easing: 'easeInOut' },
    holdMs: 1800,
    priority: 600,
    source: 'llm',
  },
};

const clone = () => JSON.parse(JSON.stringify(validPlan));

// --- 1) 合法输入 ---
test('SV-01 合法计划通过且字段回传一致', () => {
  const r = validateFacialPlan(validPlan);
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.value?.intent.emotion, 'tired');
  assert.equal(r.value?.intent.transition.durationMs, 650);
  assert.equal(r.value?.dialogue, '今天稍微有点累嘛。');
});

test('SV-01b 可选 voice/behavior 通过', () => {
  const plan = clone();
  plan.voice = { speed: 1, tone: 'gentle', pitch: 1 };
  plan.behavior = { expressionId: 'exp_smile_01' };
  const r = validateFacialPlan(plan);
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.equal(r.value?.voice?.tone, 'gentle');
  assert.equal(r.value?.behavior?.expressionId, 'exp_smile_01');
});

// --- 2) 枚举与版本 ---
test('SV-02 非法情绪被拒绝', () => {
  const plan = clone();
  plan.intent.emotion = 'ecstatic';
  const r = validateFacialPlan(plan);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('emotion')), r.errors.join('; '));
});

test('SV-05 不支持的版本被拒绝', () => {
  const plan = clone();
  plan.version = '2.0';
  const r = validateFacialPlan(plan);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('version')), r.errors.join('; '));
});

test('SV-08 非法来源被拒绝', () => {
  const plan = clone();
  plan.intent.source = 'renderer';
  const r = validateFacialPlan(plan);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('source')), r.errors.join('; '));
});

test('SV-08b 非法 easing 被拒绝', () => {
  const plan = clone();
  plan.intent.transition.easing = 'spring';
  const r = validateFacialPlan(plan);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('easing')), r.errors.join('; '));
});

// --- 3) 数值安全 ---
test('SV-03 NaN 被拒绝', () => {
  const plan = clone();
  plan.intent.face.eyes.openness = NaN;
  const r = validateFacialPlan(plan);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('openness')), r.errors.join('; '));
});

test('SV-03b Infinity 被拒绝', () => {
  const plan = clone();
  plan.intent.intensity = Infinity;
  const r = validateFacialPlan(plan);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('intensity')), r.errors.join('; '));
});

test('SV-04 越界值被裁剪并记入 warnings（不整条拒绝）', () => {
  const plan = clone();
  plan.intent.face.eyes.openness = 1.7;
  plan.intent.face.head.yaw = -3;
  const r = validateFacialPlan(plan);
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.equal(r.value?.intent.face.eyes.openness, 1);
  assert.equal(r.value?.intent.face.head.yaw, -1);
  assert.equal(r.warnings.length, 2, r.warnings.join('; '));
  assert.ok(r.warnings[0].includes('裁剪'));
});

test('SV-07 durationMs/holdMs/priority 越限被裁剪', () => {
  const plan = clone();
  plan.intent.transition.durationMs = 60_000;
  plan.intent.holdMs = -500;
  plan.intent.priority = 5000;
  const r = validateFacialPlan(plan);
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.equal(r.value?.intent.transition.durationMs, LIMITS.maxDurationMs);
  assert.equal(r.value?.intent.holdMs, LIMITS.minHoldMs);
  assert.equal(r.value?.intent.priority, LIMITS.maxPriority);
  assert.equal(r.warnings.length, 3, r.warnings.join('; '));
});

// --- 4) 注入面 ---
test('SV-06 顶层 parameterId 注入被拒绝', () => {
  const plan = clone();
  (plan as Record<string, unknown>).parameterId = 'ParamMouthOpenY';
  const r = validateFacialPlan(plan);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('parameterId')), r.errors.join('; '));
});

test('SV-06b 深层 script/tool 注入被拒绝', () => {
  const plan = clone();
  (plan.intent.face as Record<string, unknown>).script = 'model.setParameterValueById(...)';
  plan.intent.transition = { durationMs: 400, easing: 'linear', tool: 'l2d_set_facial_intent' } as never;
  const r = validateFacialPlan(plan);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('script')), r.errors.join('; '));
  assert.ok(r.errors.some((e) => e.includes('tool')), r.errors.join('; '));
});

test('SV-06c 大小写混淆与原型污染键也被拒绝', () => {
  const r1 = validateFacialPlan(clone());
  assert.equal(r1.valid, true);
  // JSON.parse 会把 "__proto__" 变成 own enumerable key（JS 字面量赋值不会），
  // 这正是真实 LLM 输出路径的形态
  const plan = clone();
  plan.intent.face.head = JSON.parse('{"yaw":0,"pitch":0,"roll":0,"__proto__":{}}');
  const r2 = validateFacialPlan(plan);
  assert.equal(r2.valid, false);
  const plan2 = clone();
  (plan2 as Record<string, unknown>).ParameterId = 'ParamAngleX';
  const r3 = validateFacialPlan(plan2);
  assert.equal(r3.valid, false);
});

test('SV-06d 白名单外顶层字段被拒绝', () => {
  const plan = clone();
  (plan as Record<string, unknown>).cubism = { direct: true };
  const r = validateFacialPlan(plan);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('cubism')), r.errors.join('; '));
});

test('SV-06e behavior 只允许资源 ID 引用', () => {
  const plan = clone();
  plan.behavior = { motionId: 'm01', code: 'evil()' } as never;
  const r = validateFacialPlan(plan);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('code')), r.errors.join('; '));
});

// --- 5) JSON 文本入口 ---
test('SV-09 合法 JSON 文本通过', () => {
  const r = parseFacialPlanJson(JSON.stringify(validPlan));
  assert.equal(r.valid, true, JSON.stringify(r.errors));
});

test('SV-09b 非法 JSON 文本收敛为统一错误格式', () => {
  const r = parseFacialPlanJson('{ not json');
  assert.equal(r.valid, false);
  assert.ok(r.errors[0].includes('JSON 解析失败'), r.errors.join('; '));
  assert.deepEqual(r.warnings, []);
});

test('SV-09c JSON 数组顶层被拒绝', () => {
  const r = parseFacialPlanJson('[]');
  assert.equal(r.valid, false);
  assert.ok(r.errors[0].includes('顶层'), r.errors.join('; '));
});

console.log(`facial schema ok (${passed} tests)`);
