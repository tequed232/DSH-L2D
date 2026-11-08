/**
 * FacialBridge 集成测试（PR-01）：验证桥把 FI 包仲裁/平滑/眨眼编排成正确帧。
 * 纯逻辑层（不依赖 Cubism），配合 packages/facial-intelligence 的四个单测构成完整覆盖。
 *
 * 覆盖：
 * - 模型扫描建映射（无眉毛语义 → unsupported）
 * - 合法意图 → 头角帧产出并向目标收敛
 * - 手动覆盖压过 LLM；releaseManual 后 LLM 重新接管
 * - holdMs 到期让位（帧不再产出）
 * - 口型红线：桥永不产出 mouthOpen/mouthForm
 * - 微表情预览：tired 产出眼开合下降
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { FacialBridge, FACIAL_SOURCE_PRIORITY } from './facial-bridge.ts';

// 大肥鱼真实参数面（无眉毛参数）
const PARAMS = [
  { id: 'ParamAngleX', min: -30, max: 30, defaultValue: 0 },
  { id: 'ParamAngleY', min: -30, max: 30, defaultValue: 0 },
  { id: 'ParamAngleZ', min: -15, max: 15, defaultValue: 0 },
  { id: 'ParamEyeLOpen', min: 0, max: 1, defaultValue: 1 },
  { id: 'ParamEyeROpen', min: 0, max: 1, defaultValue: 1 },
  { id: 'ParamEyeBallX', min: -1, max: 1, defaultValue: 0 },
  { id: 'ParamEyeBallY', min: -1, max: 1, defaultValue: 0 },
  { id: 'ParamMouthOpenY', min: 0, max: 1, defaultValue: 0 },
  { id: 'ParamMouthForm', min: -1, max: 1, defaultValue: 0 },
];

const T0 = 1_000_000;

function validPlan(overrides = {}) {
  return {
    version: '1.0',
    intent: {
      emotion: 'happy',
      intensity: 0.6,
      face: {
        eyes: { openness: 0.9, squint: 0.1, gazeX: 0, gazeY: 0 },
        brows: { leftRaise: 0, rightRaise: 0, leftFurrow: 0, rightFurrow: 0 },
        mouth: { open: 0, smile: 0.2, form: 0 },
        head: { yaw: 0.5, pitch: 0, roll: 0.1 },
      },
      transition: { durationMs: 300, easing: 'easeInOut' },
      holdMs: 2000,
      priority: 600,
      source: 'llm',
      ...overrides,
    },
  };
}

test('configure：扫描建映射 + unsupported 诊断', () => {
  const b = new FacialBridge();
  const scan = b.configure(PARAMS);
  assert.ok(scan.bindings.length >= 7, '至少 7 个语义映射');
  assert.ok(scan.unsupported.some((u) => u.semantic.startsWith('brows')), '眉毛进 unsupported');
});

test('合法意图 → 头角帧产出并向目标收敛（yaw 0.5 → AngleX 15°）', () => {
  const b = new FacialBridge();
  b.configure(PARAMS);
  const r = b.applyPlan(validPlan(), T0);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  let last = null;
  for (let i = 0; i < 120; i++) {
    last = b.tick(T0 + 16 * (i + 1), 16);
  }
  assert.ok(last.headX !== undefined, 'yaw 有映射则必须产出 headX');
  assert.ok(Math.abs(last.headX - 15) < 1.5, '收敛到 yaw 0.5 → 15°: ' + last.headX);
  assert.ok(last.headZ !== undefined && Math.abs(last.headZ - 1.5) < 1, 'roll 0.1 → AngleZ 1.5°: ' + last.headZ);
  assert.ok(last.eyeL !== undefined && last.eyeL <= 1, 'eyeL 产出且钳制');
  assert.equal(Object.keys(last.owners).length > 0, true, 'owner 诊断非空');
});

test('非法意图拒绝且零产出', () => {
  const b = new FacialBridge();
  b.configure(PARAMS);
  const bad = validPlan();
  bad.intent.emotion = 'ecstatic';
  const r = b.applyPlan(bad, T0);
  assert.equal(r.ok, false);
  assert.ok(r.errors.length > 0);
  const f = b.tick(T0 + 16, 16);
  assert.equal(f.headX, undefined, '拒绝后不得产出任何帧');
});

test('手动覆盖压过 LLM，release 后平滑恢复', () => {
  const b = new FacialBridge();
  b.configure(PARAMS);
  b.applyPlan(validPlan(), T0);
  assert.equal(b.setManual('head.yaw', -1), true, 'manual 值域合法');
  const s1 = b.tick(T0 + 16, 16);
  assert.equal(s1.owners['angleX'], 'manual', 'manual(900) 压过 llm(700)');
  assert.ok(s1.headX < 0, '朝 manual 方向: ' + s1.headX);
  b.releaseManual();
  const s2 = b.tick(T0 + 32, 16);
  assert.equal(s2.owners['angleX'], 'llm', 'release 后 llm 接管');
});

test('holdMs 到期让位（帧不再产出）', () => {
  const b = new FacialBridge();
  b.configure(PARAMS);
  b.applyPlan(validPlan(), T0); // hold 2000ms
  const s1 = b.tick(T0 + 1000, 16);
  assert.ok(s1.headX !== undefined, 'hold 内有效');
  const s2 = b.tick(T0 + 2600, 16);
  assert.equal(s2.headX, undefined, 'hold 到期零产出');
  assert.equal(s2.eyeL, undefined, '眼部同让位');
});

test('口型红线：桥永不产出 mouth 参数（含 surprised 微表情模板）', () => {
  const b = new FacialBridge();
  b.configure(PARAMS);
  b.setEmotion('surprised', 1, T0); // surprised 模板含 mouthOpen 0.1 波形
  for (let i = 0; i < 40; i++) {
    const f = b.tick(T0 + 30 * (i + 1), 30);
    assert.equal(f.mouthOpen, undefined, '帧不得携带 mouthOpen');
    assert.equal(f.mouthForm, undefined, '帧不得携带 mouthForm');
    assert.ok(!('mouthOpen' in f.owners) && !('mouthForm' in f.owners), 'owner 不得含嘴部键');
  }
});

test('微表情预览：tired 使眼开合下降（经 mixer 低优先级生效）', () => {
  const b = new FacialBridge();
  b.configure(PARAMS);
  b.setEmotion('tired', 0.9, T0);
  let minEye = 2;
  for (let i = 0; i < 60; i++) {
    const f = b.tick(T0 + 33 * (i + 1), 33);
    if (f.eyeL !== undefined) minEye = Math.min(minEye, f.eyeL);
  }
  assert.ok(minEye < 0.95, 'tired 微表情应压低眼开合: ' + minEye);
});

test('无主张时零产出（不干扰既有通道）', () => {
  const b = new FacialBridge();
  b.configure(PARAMS);
  const f = b.tick(T0 + 16, 16);
  assert.equal(f.headX, undefined);
  assert.equal(f.eyeL, undefined);
  assert.equal(f.eyeGX, undefined);
  assert.deepEqual(f.unsupported.filter((u) => u.startsWith('brows')).length > 0, true);
});

test('优先级常量对齐任务书 Part 6', () => {
  assert.equal(FACIAL_SOURCE_PRIORITY.safety, 1000);
  assert.equal(FACIAL_SOURCE_PRIORITY.manual, 900);
  assert.equal(FACIAL_SOURCE_PRIORITY.tracking, 800);
  assert.equal(FACIAL_SOURCE_PRIORITY.llm, 700);
  assert.equal(FACIAL_SOURCE_PRIORITY.micro, 200);
});
