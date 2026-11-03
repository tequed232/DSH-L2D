/**
 * 自适应呈现引擎：档位判定 / 布局计算 / 平滑过渡。
 *
 * 这些是纯函数，不碰 DOM、不碰模型，所以可以直接把边界条件跑穿。
 * 重点守住四条：用户意愿优先、滞回防抖、uiScale 不二次放大、隐藏不等于停行为。
 */
import assert from 'node:assert/strict';
import {
  stepPresentation,
  nextState,
  THRESHOLDS,
  MAX_SCALE,
  FOCUS_RATIO,
} from '../../renderer/src/presentation/adaptive-engine.ts';
import { smoothingAlpha, smoothValue } from '../../renderer/src/presentation/transition-controller.ts';
import { computeLayout } from '../../renderer/src/presentation/layout-calculator.ts';
import type { LayoutInput } from '../../renderer/src/presentation/presentation-types.ts';

let passed = 0;
const test = (name: string, fn: () => void) => {
  fn();
  passed++;
  console.log('  ok  ' + name);
};

const base: LayoutInput = {
  containerWidth: 800,
  containerHeight: 600,
  uiScale: 1,
  devicePixelRatio: 2,
  modelWidth: 1024,
  modelHeight: 1536,
  pageVisible: true,
  userOverride: 'auto',
};

const run = (patch: Partial<LayoutInput>, state = null, dtMs = 0) =>
  stepPresentation({ ...base, ...patch }, state as any, dtMs);

test('宽阔空间 → full，焦点全身，缩放不超过上限', () => {
  const r = run({ containerWidth: 800, containerHeight: 700 });
  assert.equal(r.decision.mode, 'full');
  assert.equal(r.layout.focus, 'full-body');
  assert.ok(r.layout.scale <= MAX_SCALE);
  assert.equal(r.decision.renderState, 'active');
});

test('中等空间 → half，焦点上半身', () => {
  const half = run({ containerWidth: 320, containerHeight: 700 });
  assert.equal(half.decision.mode, 'half');
  assert.equal(half.layout.focus, 'upper-body');
});

test('半身档是"放大+裁切"，不是整体缩小（同一容器对比两种档位）', () => {
  // 用足够宽的容器，排除宽度约束，只看焦点比例带来的差异
  const wide = { ...base, containerWidth: 1200, containerHeight: 900 };
  const full = computeLayout(wide, 'full');
  const half = computeLayout(wide, 'half');
  assert.ok(half.scale > full.scale, `半身档应更近: half=${half.scale} full=${full.scale}`);
  assert.ok(half.scale <= MAX_SCALE);
});

test('狭小空间 → portrait，只保头', () => {
  const r = run({ containerWidth: 180, containerHeight: 700 });
  assert.equal(r.decision.mode, 'portrait');
  assert.equal(r.layout.focus, 'face');
  assert.equal(r.decision.renderState, 'reduced');
  assert.ok(r.layout.scale <= MAX_SCALE);
});

test('太矮时不允许 full（再宽也只能半身）', () => {
  const r = run({ containerWidth: 900, containerHeight: 120 });
  assert.notEqual(r.decision.mode, 'full');
});

test('用户手动隐藏：强制 hidden，且渲染挂起', () => {
  const r = run({ userOverride: 'hide' });
  assert.equal(r.decision.mode, 'hidden');
  assert.equal(r.decision.forced, true);
  assert.equal(r.decision.renderState, 'suspended');
  assert.equal(r.layout.scale, 0);
});

test('页面不可见：hidden 但不是用户强制（恢复后可自动回来）', () => {
  const r = run({ pageVisible: false });
  assert.equal(r.decision.mode, 'hidden');
  assert.equal(r.decision.forced, false);
  assert.equal(r.decision.renderState, 'suspended');
});

test('用户强制显示：小容器也至少给 portrait', () => {
  const r = run({ containerWidth: 120, userOverride: 'show' });
  assert.equal(r.decision.mode, 'portrait');
  assert.equal(r.decision.forced, true);
});

test('滞回：已 full 时 400px 仍是 full，掉到 370 才退', () => {
  const stillFull = run({ containerWidth: 400 }, { mode: 'full', scale: 1, offsetX: 0, offsetY: 0 });
  assert.equal(stillFull.decision.mode, 'full', `≥ ${THRESHOLDS.fullExit} 应保持 full`);

  const dropped = run({ containerWidth: 370 }, { mode: 'full', scale: 1, offsetX: 0, offsetY: 0 });
  assert.notEqual(dropped.decision.mode, 'full');
});

test('没有历史时不滞回：400px 直接判 half', () => {
  const r = run({ containerWidth: 400 }, null);
  assert.equal(r.decision.mode, 'half');
});

test('uiScale 不参与缩放（避免放大两次）', () => {
  const a = run({ containerWidth: 300, uiScale: 1 });
  const b = run({ containerWidth: 300, uiScale: 1.5 });
  assert.equal(a.layout.scale, b.layout.scale, '容器尺寸已含缩放效果，再乘 uiScale 会双重放大');
});

test('焦点比例与档位一致', () => {
  assert.ok(FOCUS_RATIO.face < FOCUS_RATIO['upper-body']);
  assert.ok(FOCUS_RATIO['upper-body'] < FOCUS_RATIO['full-body']);
});

test('平滑：单调逼近目标且不越界', () => {
  const target = 1;
  let v = 0;
  let prev = v;
  for (let i = 0; i < 60; i++) {
    v = smoothValue(v, target, 16, 140);
    assert.ok(v >= prev, '不应回退');
    assert.ok(v <= target, '不应越过目标');
    prev = v;
  }
  assert.ok(v > 0.9, '60 帧（~1s）内应基本到位');
});

test('平滑与帧率无关：两个 8ms 步 ≈ 一个 16ms 步', () => {
  const a = smoothValue(smoothValue(0, 1, 8, 140), 1, 8, 140);
  const b = smoothValue(0, 1, 16, 140);
  assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);
});

test('alpha 边界：dt 或 tau 非法时不动', () => {
  assert.equal(smoothingAlpha(0, 140), 0);
  assert.equal(smoothingAlpha(16, 0), 0);
  assert.ok(smoothingAlpha(16, 140) > 0);
});

test('stepPresentation：首帧直接到位，多帧后收敛', () => {
  const first = run({ containerWidth: 800 }, null, 0);
  assert.equal(first.view.settled, true);
  assert.equal(first.view.scale, first.layout.scale);

  const moving = run({ containerWidth: 200 }, nextState(first), 16);
  assert.equal(moving.view.settled, false);
  assert.notEqual(moving.view.scale, moving.layout.scale);

  let state = nextState(moving);
  for (let i = 0; i < 120; i++) {
    const r = run({ containerWidth: 200 }, state, 16);
    state = nextState(r);
    if (r.view.settled) break;
  }
  assert.ok(Math.abs(state.scale - run({ containerWidth: 200 }).layout.scale) < 1e-3, '最终应收敛到目标');
});

if (process.exitCode) console.error('\n呈现引擎测试失败\n');
else console.log(`\n${passed} passed\n`);
