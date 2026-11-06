/**
 * P0 修复（模型加载失败）测试：恢复状态机规格（l2d-recovery.mjs 纯函数，假时钟驱动）。
 * 运行：node packages/dsh-l2d-plugin/lib/l2d-recovery.test.mjs
 */
import assert from 'node:assert/strict';
import {
  createRecoveryController,
  RECOVERY_STATES,
  FAILED_CONTAINER_PX,
  MODULE_DISABLED_KEY,
  DEFAULT_RETRY_TIMERS,
} from './l2d-recovery.mjs';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  ok -', name);
  } catch (err) {
    console.error('  FAIL -', name);
    throw err;
  }
}

/** 假时钟：手动推进，schedule/cancel 全部记录 */
function makeClock() {
  const clock = { now: 0, jobs: [], nextId: 1 };
  clock.schedule = (fn, delay) => {
    const id = clock.nextId++;
    clock.jobs.push({ id, fn, at: clock.now + delay, cancelled: false });
    return id;
  };
  clock.cancel = (id) => {
    const job = clock.jobs.find((j) => j.id === id);
    if (job) job.cancelled = true;
  };
  clock.advance = (ms) => {
    clock.now += ms;
    for (const j of [...clock.jobs]) {
      if (!j.cancelled && j.at <= clock.now) {
        j.cancelled = true;
        j.fn();
      }
    }
  };
  clock.pending = () => clock.jobs.filter((j) => !j.cancelled).length;
  return clock;
}

/** 组装控制器，startAttempt 记录每次真实加载 */
function makeController(clock, extraDeps = {}) {
  const started = [];
  const states = [];
  const ctrl = createRecoveryController({
    startAttempt: (gen) => started.push(gen),
    onStateChange: (state, info) => states.push({ state, info }),
    schedule: clock.schedule,
    cancel: clock.cancel,
    now: () => clock.now,
    ...extraDeps,
  });
  return { ctrl, started, states };
}

test('状态枚举与常量自检', () => {
  assert.deepEqual(RECOVERY_STATES, ['initializing', 'loading', 'ready', 'retry_wait', 'failed', 'model_disabled', 'module_disabled']);
  assert.equal(FAILED_CONTAINER_PX, 300);
  assert.equal(MODULE_DISABLED_KEY, 'dsh-l2d.disabled');
  assert.deepEqual(DEFAULT_RETRY_TIMERS, [1000, 3000, 8000]);
});

test('首启：beginLoading → loading 并发起一次真实加载', () => {
  const clock = makeClock();
  const { ctrl, started } = makeController(clock);
  const gen = ctrl.beginLoading();
  assert.equal(gen, 1);
  assert.deepEqual(started, [1]);
  assert.equal(ctrl.snapshot().state, 'loading');
});

test('失败后自动重试：1s/3s/8s 间隔，共 3 次', () => {
  const clock = makeClock();
  const { ctrl, started } = makeController(clock);
  const gen = ctrl.beginLoading();

  let r = ctrl.reportFailure(gen, new Error('boom'));
  assert.equal(r.done, false);
  assert.equal(r.retryIn, 1000);
  assert.equal(ctrl.snapshot().state, 'retry_wait');
  clock.advance(1000);
  assert.equal(ctrl.snapshot().state, 'loading');
  assert.deepEqual(started, [1, 2]);

  r = ctrl.reportFailure(2, new Error('boom'));
  assert.equal(r.retryIn, 3000);
  clock.advance(3000);

  r = ctrl.reportFailure(3, new Error('boom'));
  assert.equal(r.retryIn, 8000);
  clock.advance(8000);
  assert.deepEqual(started, [1, 2, 3, 4]);
});

test('重试耗尽 → failed，停止自动重试（无挂起定时器）', () => {
  const clock = makeClock();
  const { ctrl } = makeController(clock);
  const gen = ctrl.beginLoading();
  for (let i = 0; i < 3; i++) {
    ctrl.reportFailure(ctrl.snapshot().generation, new Error('boom'));
    clock.advance(9000);
  }
  // 第 4 次失败（第 4 轮加载仍失败）→ failed
  const r = ctrl.reportFailure(ctrl.snapshot().generation, new Error('boom-4th'));
  assert.equal(r.done, true);
  assert.equal(r.state, 'failed');
  assert.equal(ctrl.snapshot().state, 'failed');
  assert.equal(clock.pending(), 0, '耗尽后不得再有自动重试定时器');
});

test('stale generation：旧代失败/成功不覆盖新代状态', () => {
  const clock = makeClock();
  const { ctrl } = makeController(clock);
  const gen1 = ctrl.beginLoading();
  ctrl.reportFailure(gen1, new Error('old')); // attempts=1, gen→2
  const stale = ctrl.snapshot().generation; // 2
  clock.advance(1000); // 重试轮 gen=2 开始
  assert.equal(ctrl.snapshot().generation, 2);
  // 旧代 gen1 的成功迟到 → 忽略
  const ignored = ctrl.reportSuccess(gen1);
  assert.equal(ignored.ignored, true);
  assert.equal(ctrl.snapshot().state, 'loading', '旧代成功不得把重试轮标成 ready');
  assert.equal(stale > gen1, true);
});

test('成功 → ready，计数清零', () => {
  const clock = makeClock();
  const { ctrl } = makeController(clock);
  const gen = ctrl.beginLoading();
  ctrl.reportFailure(gen, new Error('x'));
  clock.advance(1000);
  const r = ctrl.reportSuccess(ctrl.snapshot().generation);
  assert.equal(r.state, 'ready');
  const snap = ctrl.snapshot();
  assert.equal(snap.attempts, 0);
  assert.equal(snap.lastError, null);
});

test('手动重试：计数清零、可无限次、撤回「禁用模型」', () => {
  const clock = makeClock();
  const { ctrl } = makeController(clock);
  const gen = ctrl.beginLoading();
  // 打到 failed
  for (let i = 0; i < 4; i++) {
    ctrl.reportFailure(ctrl.snapshot().generation, new Error('x'));
    clock.advance(9000);
  }
  assert.equal(ctrl.snapshot().state, 'failed');
  // 用户禁用模型后手动重试
  ctrl.disableModel();
  assert.equal(ctrl.snapshot().state, 'model_disabled');
  const beforeGen = ctrl.snapshot().generation;
  const r = ctrl.manualRetry();
  assert.equal(r, beforeGen + 1); // 新 generation
  const snap = ctrl.snapshot();
  assert.equal(snap.state, 'loading');
  assert.equal(snap.attempts, 0);
  assert.equal(snap.modelDisabled, false);
});

test('禁用模型：停止一切重试调度', () => {
  const clock = makeClock();
  const { ctrl } = makeController(clock);
  const gen = ctrl.beginLoading();
  ctrl.reportFailure(gen, new Error('x'));
  ctrl.disableModel();
  clock.advance(10000);
  assert.equal(clock.pending(), 0, '禁用后挂起的重试定时器必须被清除');
  // 禁用后失败上报也被忽略
  const r = ctrl.reportFailure(ctrl.snapshot().generation, new Error('late'));
  assert.equal(r.ignored, true);
});

test('禁用模组：manualRetry 也不执行', () => {
  const clock = makeClock();
  const { ctrl } = makeController(clock);
  ctrl.beginLoading();
  ctrl.disableModule();
  assert.equal(ctrl.snapshot().state, 'module_disabled');
  assert.equal(ctrl.manualRetry().ignored, true);
  assert.equal(ctrl.beginLoading(), null, 'module_disabled 下 beginLoading 拒绝');
});

test('空 retryTimers 表：保守路径不崩溃', () => {
  const clock = makeClock();
  const c2 = createRecoveryController({ schedule: clock.schedule, cancel: clock.cancel, retryTimers: [] });
  c2.beginLoading();
  const r = c2.reportFailure(1, new Error('x'));
  assert.equal(r.done, false, '空 timers 表不崩溃，走保守路径');
  assert.equal(r.retryIn, 1000, '回退默认 timers 表取首段间隔');
});

console.log('\nl2d-recovery: ' + passed + ' passed, 0 failed');
