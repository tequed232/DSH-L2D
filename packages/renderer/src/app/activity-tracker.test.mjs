import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ActivityTracker,
  DEFAULT_HYSTERESIS_MS,
  ANTI_JITTER_HYSTERESIS_MS,
  prefersReducedMotion,
  shouldStartAmbient,
  REDUCED_MOTION_AMBIENT_COOLDOWN_MS,
} from './activity-tracker.ts';

/** 假时钟：手动推针，模拟滞回窗口滑动。 */
function fakeClock(start = 1000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

test('默认滞回与旧帧率门逐值一致（2500ms）', () => {
  assert.equal(DEFAULT_HYSTERESIS_MS, 2500);
  const clock = fakeClock();
  const tr = new ActivityTracker({ now: clock.now });
  // 旧实现：mark 后 2499ms 内活跃、2500ms 整点滑出（< 2500 判定）
  clock.advance(2499);
  assert.equal(tr.isActive(), true);
  clock.advance(1);
  assert.equal(tr.isActive(), false);
});

test('mark 后滞回窗口内活跃，滑出后降级', () => {
  const clock = fakeClock();
  const tr = new ActivityTracker({ now: clock.now });
  assert.equal(tr.isActive(), true, '构造即活跃（与旧 lastActiveAt 初始化一致）');
  clock.advance(3000);
  assert.equal(tr.isActive(), false);
  tr.mark('pointer');
  assert.equal(tr.isActive(), true);
  clock.advance(2500);
  assert.equal(tr.isActive(), false);
});

test('滞回消除刷新率抖动：间歇 mark 持续续窗，不回落', () => {
  const clock = fakeClock();
  const tr = new ActivityTracker({ now: clock.now });
  // 每 2s 一次活动（低于滞回 2.5s）：无论多久都不应滑出
  for (let i = 0; i < 20; i++) {
    clock.advance(2000);
    tr.mark('gaze');
    assert.equal(tr.isActive(), true, `第 ${i + 1} 次续窗后仍应活跃`);
  }
});

test('时间倒流的 mark 不会把窗口拖回过去', () => {
  const clock = fakeClock();
  const tr = new ActivityTracker({ now: clock.now });
  clock.advance(1000);
  const before = tr.lastActiveAt();
  tr.mark('agent', before - 500);
  assert.equal(tr.lastActiveAt(), before);
});

test('显式 hysteresisMs=8000 生效（P1 抗抖动档）', () => {
  assert.equal(ANTI_JITTER_HYSTERESIS_MS, 8000);
  const clock = fakeClock();
  const tr = new ActivityTracker({ now: clock.now, hysteresisMs: ANTI_JITTER_HYSTERESIS_MS });
  clock.advance(7999);
  assert.equal(tr.isActive(), true);
  clock.advance(1);
  assert.equal(tr.isActive(), false);
});

test('mark 各类型计数可读（诊断）', () => {
  const clock = fakeClock();
  const tr = new ActivityTracker({ now: clock.now });
  tr.mark('drag');
  tr.mark('drag');
  tr.mark('motion');
  const s = tr.stats();
  assert.equal(s.drag, 2);
  assert.equal(s.motion, 1);
  assert.equal(s.gaze, 0);
});

test('remainingMs 单调递减且可为负', () => {
  const clock = fakeClock();
  const tr = new ActivityTracker({ now: clock.now });
  assert.equal(tr.remainingMs(), DEFAULT_HYSTERESIS_MS);
  clock.advance(3000);
  assert.equal(tr.remainingMs(), -500);
});

// ---------------------------------------------------------------- reduced-motion

test('prefersReducedMotion：matches=true/false/缺 API/抛错 都安全', () => {
  assert.equal(prefersReducedMotion({ matchMedia: () => ({ matches: true }) }), true);
  assert.equal(prefersReducedMotion({ matchMedia: () => ({ matches: false }) }), false);
  assert.equal(prefersReducedMotion({}), false, '无 matchMedia → false（能力缺失不反向减少）');
  assert.equal(prefersReducedMotion(undefined), false, 'node 环境（无 window）→ false');
  assert.equal(
    prefersReducedMotion({
      matchMedia: () => {
        throw new Error('boom');
      },
    }),
    false,
  );
});

test('shouldStartAmbient：未开启 reduced 恒放行（现状不变）', () => {
  assert.equal(shouldStartAmbient(false, 0, 1), true);
  assert.equal(shouldStartAmbient(false, 1000, 1100, 20000), true);
});

test('shouldStartAmbient：reduced 下冷却内拒绝、窗外放行、首次放行', () => {
  const cd = REDUCED_MOTION_AMBIENT_COOLDOWN_MS;
  assert.equal(cd, 20000);
  // 首次（-Infinity 语义：远小于 now）直接放行
  assert.equal(shouldStartAmbient(true, -Infinity, 5000, cd), true);
  // 刚播过 → 拒绝（降频而非停渲染：只是不 start，渲染循环照跑）
  assert.equal(shouldStartAmbient(true, 10000, 10000 + cd - 1, cd), false);
  // 冷却窗滑出 → 放行
  assert.equal(shouldStartAmbient(true, 10000, 10000 + cd, cd), true);
});
