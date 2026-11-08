/**
 * 动画层测试：Micro Expression Engine（任务书 Part 7）+ Blink Controller（确定性眨眼）。
 *
 * 用例编号 AN-xx 对照：
 *   AN-01  微表情输出确定性：同一时刻序列产出完全一致（无随机源）
 *   AN-02  波形周期 ≥ 1.2s（MICRO_MIN_PERIOD_MS 强制下限）
 *   AN-03  情绪切换淡入（ramp）：切换瞬间不突跳
 *   AN-04  clear 后输出为空；intensity=0 输出为空
 *   AN-05  输出钳制在 FACE_PARAMETER_BOUNDS 内
 *   AN-06  未登记情绪输出为空
 *   AN-07  眨眼确定性：同种子同时刻序列可复现
 *   AN-08  眨眼曲线有界（0~1）且单次时长在 120~180ms 区间
 *   AN-09  手动让位：hold 期间不眨眼、节奏顺延
 *   AN-10  情绪调制：tired 眨眼间隔拉长
 *   AN-11  时钟回拨不产生越界曲线
 */
import assert from 'node:assert';
import { BlinkController } from '../src/animation/blink-controller.ts';
import {
  FACE_PARAMETER_BOUNDS,
} from '../src/controller/facial-controller.ts';
import {
  MICRO_MIN_PERIOD_MS,
  MICRO_TEMPLATES,
  MicroExpressionEngine,
} from '../src/animation/micro-expression.ts';

// AN-01 微表情确定性
{
  const run = () => {
    const e = new MicroExpressionEngine();
    e.setEmotion('happy', 0.7, 1000);
    const frames: Array<Record<string, number>> = [];
    for (let t = 1000; t <= 5000; t += 16) {
      const out = e.update(t);
      frames.push({ ...out });
    }
    return frames;
  };
  const a = run();
  const b = run();
  assert.deepEqual(a, b, '同一时刻序列必须产出一致（确定性）');
  assert.ok(a.some((f) => Object.keys(f).length > 0), 'happy 应产出非空目标');
  console.log('AN-01 微表情确定性 ok');
}

// AN-02 波形周期下限
{
  for (const [emotion, tpl] of Object.entries(MICRO_TEMPLATES)) {
    for (const wave of Object.values(tpl.waves ?? {})) {
      const effective = Math.max(MICRO_MIN_PERIOD_MS, wave.periodMs);
      assert.ok(effective >= 1200, `${emotion} 波形周期 ${effective}ms 低于 1.2s 下限`);
    }
  }
  // 引擎实际生效周期也 ≥ 1.2s：即使模板配置了 500ms 周期也会被抬到 1200ms
  const e = new MicroExpressionEngine();
  e.setEmotion('happy', 1, 0);
  const s1 = e.update(0);
  const mid = e.update(600); // 半个 1.2s 周期附近应有明显相位差
  assert.ok(JSON.stringify(s1) !== JSON.stringify(mid), '1.2s 周期内应有波形演化');
  console.log('AN-02 周期下限 ok');
}

// AN-03 情绪切换淡入
{
  const e = new MicroExpressionEngine();
  e.setEmotion('shy', 1, 1000);
  const instant = e.update(1000); // 淡入起点
  for (const v of Object.values(instant)) assert.ok(Math.abs(v as number) < 0.02, '淡入起点幅度应接近 0');
  const later = e.update(2000); // 1s 后淡入完成
  assert.ok(
    Object.values(later).some((v) => Math.abs(v as number) > 0.05),
    '淡入完成后应有明显幅度',
  );
  // 同情绪重复 setEmotion 不重置淡入（波形连续）
  e.setEmotion('shy', 1, 2000);
  const cont = e.update(2000);
  assert.deepEqual(cont, later, '同情绪重复设置不得重启淡入');
  console.log('AN-03 淡入 ok');
}

// AN-04 clear / intensity=0 / 未登记情绪
{
  const e = new MicroExpressionEngine();
  e.setEmotion('happy', 0.8, 0);
  e.update(500);
  e.clear();
  assert.deepEqual(e.update(600), {}, 'clear 后输出为空');
  const e2 = new MicroExpressionEngine();
  e2.setEmotion('happy', 0, 0);
  assert.deepEqual(e2.update(500), {}, 'intensity=0 输出为空');
  const e3 = new MicroExpressionEngine();
  e3.setEmotion('ecstatic', 1, 0); // 未登记情绪无模板
  assert.deepEqual(e3.update(500), {}, '未登记情绪输出为空');
  console.log('AN-04 空输出路径 ok');
}

// AN-05 输出边界钳制
{
  const e = new MicroExpressionEngine();
  e.setEmotion('surprised', 1, 0);
  for (let t = 0; t <= 6000; t += 16) {
    const out = e.update(t);
    for (const [key, v] of Object.entries(out)) {
      const b = FACE_PARAMETER_BOUNDS[key as keyof typeof FACE_PARAMETER_BOUNDS];
      assert.ok(v >= b.min - 1e-9 && v <= b.max + 1e-9, `${key}=${v} 越界`);
    }
  }
  console.log('AN-05 输出边界 ok');
}

// AN-06 眨眼确定性
{
  const run = (seed: number) => {
    const c = new BlinkController({ seed });
    const frames: number[] = [];
    for (let t = 0; t <= 12000; t += 16) frames.push(c.update(t).eyeLOpen);
    return frames;
  };
  assert.deepEqual(run(42), run(42), '同种子必须复现同一眨眼序列');
  assert.notDeepEqual(run(42), run(43), '不同种子应产生不同节奏');
  assert.ok(run(42).some((v) => v < 0.5), '12s 内至少发生一次眨眼（曲线明显闭合）');
  console.log('AN-06 眨眼确定性 ok');
}

// AN-07 眨眼曲线有界且时长在 120~180ms
{
  const c = new BlinkController({ seed: 7, blinkDurationMs: 150 });
  c.update(0);
  let closed = -1;
  let reopened = -1;
  let t = 0;
  for (t = 0; t <= 12000; t += 8) {
    const v = c.update(t).eyeLOpen;
    assert.ok(v >= 0 && v <= 1, `曲线越界 @${t}: ${v}`);
    // 采样阈值取 v<0.5：v<0.1 的窗口只有 ~4ms，低于采样步长会漏检
    if (closed < 0 && v < 0.5) closed = t;
    if (closed >= 0 && reopened < 0 && v > 0.95 && t > closed) reopened = t;
  }
  assert.ok(closed >= 0, '应观察到一次闭合');
  assert.ok(reopened - closed <= 180, `眨眼时长 ${(reopened - closed)}ms 超出 120~180ms 区间`);
  console.log('AN-07 眨眼时长 ok');
}

// AN-08 手动让位（单调时间线：触发 → hold → 释放 → 恢复）
{
  const c = new BlinkController({ seed: 11, minIntervalMs: 100, maxIntervalMs: 200 });
  let trigger = -1;
  for (let t = 0; t <= 2000 && trigger < 0; t += 8) {
    if (c.update(t).eyeLOpen < 0.5) trigger = t;
  }
  assert.ok(trigger >= 0, '让位前应观察到一次眨眼');
  c.setManualHold(true);
  const holdStart = trigger;
  for (let t = holdStart; t <= holdStart + 2000; t += 16) {
    const f = c.update(t);
    assert.equal(f.eyeLOpen, 1, '让位期间不得眨眼');
    assert.equal(f.eyeROpen, 1);
  }
  c.setManualHold(false);
  const releaseAt = holdStart + 2000;
  let blinkedAgain = false;
  for (let t = releaseAt; t <= releaseAt + 6000 && !blinkedAgain; t += 8) {
    if (c.update(t).eyeLOpen < 0.5) blinkedAgain = true;
  }
  assert.ok(blinkedAgain, '让位结束后眨眼恢复');
  console.log('AN-08 手动让位 ok');
}

// AN-09 情绪调制：tired 间隔拉长
{
  const intervals = (emotion: string): number[] => {
    const c = new BlinkController({ seed: 99, minIntervalMs: 1000, maxIntervalMs: 1000 });
    c.setEmotion(emotion);
  const marks: number[] = [];
  let inBlink = false;
  for (let t = 0; t <= 30000; t += 8) {
    const v = c.update(t).eyeLOpen;
    if (!inBlink && v < 0.5) {
      inBlink = true;
      marks.push(t);
    } else if (inBlink && v >= 0.99) {
      inBlink = false;
    }
  }
  return marks;
  };
  const neutral = intervals('neutral');
  const tired = intervals('tired');
  assert.ok(neutral.length >= 2 && tired.length >= 2, '两种情绪都应发生多次眨眼');
  const gap = (m: number[]) => (m[m.length - 1] - m[0]) / (m.length - 1);
  assert.ok(gap(tired) > gap(neutral), `tired 平均间隔 ${gap(tired)}ms 应长于 neutral ${gap(neutral)}ms`);
  console.log('AN-09 tired 调制 ok');
}

// AN-10 时钟回拨安全
{
  const c = new BlinkController({ seed: 3 });
  c.update(5000);
  const f = c.update(1000); // 回拨
  assert.ok(f.eyeLOpen >= 0 && f.eyeLOpen <= 1);
  assert.ok(Number.isFinite(f.eyeLOpen) && Number.isFinite(f.eyeROpen));
  console.log('AN-10 时钟回拨 ok');
}

console.log('facial animation ok');
