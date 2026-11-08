/**
 * Controller Tests（任务书 Part 18）：
 * 平滑过渡 / 中途改目标不跳变 / reset 平滑 / dt 异常不产 NaN / 参数不越界 /
 * duration+easing 过渡。
 */
import assert from 'node:assert';
import {
  FacialController,
  DEFAULT_FACE_PARAMETERS,
  EASING_FUNCTIONS,
} from '../src/controller/facial-controller.ts';

// C1 表情平滑过渡（不瞬跳）
{
  const c = new FacialController();
  c.setTarget({ angleX: 30 });
  const first = c.update(0.016);
  assert.ok(Math.abs(first.angleX) < 30, '第一帧不得直接到达目标');
  let prev = first.angleX;
  for (let i = 0; i < 200; i++) {
    const cur = c.update(0.016);
    assert.ok(cur.angleX >= prev - 1e-9, '单调逼近目标');
    prev = cur.angleX;
  }
  assert.ok(Math.abs(prev - 30) < 1, '200 帧后应收敛到目标附近: ' + prev);
  console.log('C1 平滑过渡 ok');
}

// C2 中途改变目标不会突然跳变（角度限速 120°/s → 16ms 内 ≤ ~2°）
{
  const c = new FacialController();
  c.setTarget({ angleX: 30 });
  for (let i = 0; i < 30; i++) c.update(0.016);
  const before = c.getCurrent().angleX;
  c.setTarget({ angleX: -30 });
  const after = c.update(0.016);
  assert.ok(Math.abs(after.angleX - before) <= 2.1, '改目标单帧位移受限速约束: ' + Math.abs(after.angleX - before));
  console.log('C2 中途改目标不跳变 ok');
}

// C3 reset 平滑恢复（不硬切）
{
  const c = new FacialController();
  c.setTarget({ angleX: 30, eyeLOpen: 0.2 });
  for (let i = 0; i < 80; i++) c.update(0.016);
  c.reset();
  const first = c.update(0.016);
  assert.ok(first.angleX > 20, 'reset 后第一帧仍在原位附近（平滑）: ' + first.angleX);
  for (let i = 0; i < 300; i++) c.update(0.016);
  const end = c.getCurrent();
  assert.ok(Math.abs(end.angleX - DEFAULT_FACE_PARAMETERS.angleX) < 0.5, '收敛回默认');
  assert.ok(Math.abs(end.eyeLOpen - DEFAULT_FACE_PARAMETERS.eyeLOpen) < 0.05, '眼收敛回 1');
  console.log('C3 reset 平滑 ok');
}

// C3b hardReset 硬切（模型切换场景）
{
  const c = new FacialController();
  c.setTarget({ angleX: 30 });
  for (let i = 0; i < 50; i++) c.update(0.016);
  c.hardReset();
  assert.equal(c.getCurrent().angleX, 0, 'hardReset 立即归零');
  console.log('C3b hardReset ok');
}

// C4 dt 异常不产 NaN
{
  const c = new FacialController();
  c.setTarget({ angleX: 30 });
  for (const dt of [0, -0.016, NaN, Infinity, -Infinity]) {
    const r = c.update(dt);
    for (const v of Object.values(r)) assert.ok(Number.isFinite(v), 'dt=' + dt + ' 不得产生非有限值');
  }
  console.log('C4 dt 异常安全 ok');
}

// C5 参数不越界（FACE_PARAMETER_BOUNDS 钳制）
{
  const c = new FacialController();
  c.setTarget({ eyeLOpen: 5, eyeROpen: -3, angleX: 999, eyeBallX: 7 });
  for (let i = 0; i < 300; i++) c.update(0.016);
  const end = c.getCurrent();
  assert.ok(end.eyeLOpen <= 1, 'eyeLOpen 钳到 ≤1: ' + end.eyeLOpen);
  assert.ok(end.eyeROpen >= 0, 'eyeROpen 钳到 ≥0');
  assert.ok(end.angleX <= 30, 'angleX 钳到 ≤30');
  assert.ok(end.eyeBallX <= 1, 'eyeBallX 钳到 ≤1');
  console.log('C5 边界钳制 ok');
}

// C5b 非有限目标值被忽略
{
  const c = new FacialController();
  c.setTarget({ angleX: NaN, eyeLOpen: Infinity });
  const r = c.update(0.016);
  assert.equal(r.angleX, 0, 'NaN 目标不得污染状态');
  assert.equal(r.eyeLOpen, 1, 'Infinity 目标不得污染状态');
  console.log('C5b 非有限目标忽略 ok');
}

// C6 duration 过渡 + easing 曲线
{
  const c = new FacialController();
  c.setTarget({ angleX: 30 }, { durationMs: 400, easing: 'easeInOut' });
  const samples: number[] = [];
  for (let i = 0; i < 30; i++) samples.push(c.update(0.016).angleX);
  assert.ok(Math.abs(samples[0]) < 2, '过渡起点从当前值开始');
  // easeInOut 中段速度大于首帧差分
  const diffs = samples.slice(1).map((v, i) => Math.abs(v - samples[i]));
  assert.ok(diffs[Math.floor(diffs.length / 2)] > diffs[0], 'easeInOut 中段速度应更大');
  // 过渡结束后平滑继续收敛到目标（时间常数 0.12s）
  for (let i = 0; i < 200; i++) c.update(0.016);
  assert.ok(Math.abs(c.getCurrent().angleX - 30) < 1, '过渡+平滑收敛到目标: ' + c.getCurrent().angleX);
  console.log('C6 duration+easing ok');
}

// C7 easing 函数有界
{
  for (const [name, fn] of Object.entries(EASING_FUNCTIONS)) {
    for (const t of [0, 0.3, 0.5, 0.9, 1]) {
      const v = fn(t);
      assert.ok(Number.isFinite(v) && v >= 0 && v <= 1, name + '@' + t + ' 越界: ' + v);
    }
  }
  console.log('C7 easing 有界 ok');
}

console.log('controller ok');
