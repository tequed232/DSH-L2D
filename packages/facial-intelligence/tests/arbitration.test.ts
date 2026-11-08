/**
 * Arbitration Tests（任务书 Part 18）—— 适配后端席 ParamMixer API
 * （submitValue / step(now, base) / clearSource；升序优先级求值，高优先级最后落地）。
 *
 * 覆盖：Manual 不被 LLM 覆盖 / 到期与超时释放 / Motion 完成释放 /
 * Safety 恒赢 / additive 加法 / 微表情不与主表情抢位 / owner 归属 / 空贡献。
 */
import assert from 'node:assert';
import { ParamMixer, LLM_MAX_PRIORITY, SOURCE_PRIORITY } from '../src/controller/arbitration.ts';

const T0 = 1000;

// A1 Manual Override 不被 LLM 覆盖
{
  const m = new ParamMixer();
  m.submitValue('llm', 'head.yaw', 0.8, { priority: 700, timestamp: T0 });
  m.submitValue('manual', 'head.yaw', -0.4, { priority: 900, timestamp: T0 });
  const s = m.step(T0 + 100, {});
  assert.equal(s.values['head.yaw'], -0.4, 'manual(900) 必须赢 llm(700)');
  assert.equal(s.owners['head.yaw'], 'manual');
  console.log('A1 Manual 不被 LLM 覆盖 ok');
}

// A1b LLM priority 声明超限的语义在 validator 已钳 700：mixer 层恒 manual > llm
{
  assert.equal(LLM_MAX_PRIORITY, 700);
  assert.ok(SOURCE_PRIORITY.manual > LLM_MAX_PRIORITY);
  console.log('A1b 权限上限 ok');
}

// A2 Safety 恒赢
{
  const m = new ParamMixer();
  m.submitValue('manual', 'head.yaw', 0.9, { priority: 900, timestamp: T0 });
  m.submitValue('safety', 'head.yaw', 0, { priority: 1000, timestamp: T0 });
  const s = m.step(T0 + 100, {});
  assert.equal(s.values['head.yaw'], 0);
  assert.equal(s.owners['head.yaw'], 'safety');
  console.log('A2 Safety 恒赢 ok');
}

// A3 expiresAt 到期释放（LLM hold 到期让位；用短 expiresAt 隔离到期语义，避开 500ms source timeout）
{
  const m = new ParamMixer();
  m.submitValue('llm', 'head.yaw', 0.5, { priority: 700, timestamp: T0, expiresAt: T0 + 300 });
  const s1 = m.step(T0 + 100, {});
  assert.equal(s1.values['head.yaw'], 0.5, '未到期有效');
  const s2 = m.step(T0 + 400, {});
  assert.ok(!('head.yaw' in s2.values), 'holdMs 到期必须让位（即使 source timeout 未到）');
  assert.ok(s2.expiredSources.includes('llm'), '过期来源进诊断');
  console.log('A3 到期释放 ok');
}

// A4 摄像头不永久占用（source timeout 500ms 默认）
{
  const m = new ParamMixer();
  m.submitValue('tracking', 'head.yaw', 0.7, { priority: 800, timestamp: T0 });
  const s1 = m.step(T0 + 400, {});
  assert.equal(s1.values['head.yaw'], 0.7, 'timeout 内 tracking 有效');
  const s2 = m.step(T0 + 600, {});
  assert.ok(!('head.yaw' in s2.values), '停止提交即释放（摄像头不永久占用）');
  console.log('A4 tracking 超时释放 ok');
}

// A4b 持续提交的来源保持有效（每帧重提交语义）
{
  const m = new ParamMixer();
  m.submitValue('tracking', 'head.yaw', 0.7, { priority: 800, timestamp: T0 });
  for (let t = 100; t <= 2000; t += 100) {
    m.submitValue('tracking', 'head.yaw', 0.7, { priority: 800, timestamp: T0 + t });
    const s = m.step(T0 + t, {});
    assert.equal(s.values['head.yaw'], 0.7, '持续提交不超时 @' + t);
  }
  console.log('A4b 持续提交 ok');
}

// A5 Motion 完成释放（clearSource）
{
  const m = new ParamMixer();
  m.submitValue('motion', 'head.yaw', 0.2, { priority: 400, timestamp: T0, expiresAt: T0 + 999999 });
  m.submitValue('llm', 'head.yaw', 0.5, { priority: 700, timestamp: T0, expiresAt: T0 + 999999 });
  m.clearSource('motion');
  const s = m.step(T0 + 100, {});
  assert.equal(s.owners['head.yaw'], 'llm', 'motion 释放后 llm 接管');
  console.log('A5 Motion 释放 ok');
}

// A6 additive 加法（微表情偏移模式）
{
  const m = new ParamMixer();
  m.submitValue('micro', 'eyeLOpen', -0.12, { priority: 200, timestamp: T0, mode: 'additive' });
  const s = m.step(T0 + 100, { eyeLOpen: 1 });
  assert.ok(Math.abs(s.values['eyeLOpen'] - 0.88) < 1e-9, 'additive 在基线上叠加: ' + s.values['eyeLOpen']);
  console.log('A6 additive ok');
}

// A7 微表情(200) 不与主表情(700) 抢位：主表情在位时微表情被跳过
{
  const m = new ParamMixer();
  m.submitValue('llm', 'eyeLOpen', 0.5, { priority: 700, timestamp: T0, expiresAt: T0 + 9999 });
  m.submitValue('micro', 'eyeLOpen', 0.9, { priority: 200, timestamp: T0, expiresAt: T0 + 9999 });
  const s = m.step(T0 + 100, {});
  assert.equal(s.values['eyeLOpen'], 0.5, '主表情压过微表情');
  assert.equal(s.owners['eyeLOpen'], 'llm');
  assert.ok(s.skippedWrites > 0, '被压写计入诊断');
  console.log('A7 微表情不抢位 ok');
}

// A8 无贡献 → 无产出（调用方不写入该参数）
{
  const m = new ParamMixer();
  const s = m.step(T0, {});
  assert.ok(!('eyes.gazeX' in s.values));
  console.log('A8 空贡献无产出 ok');
}

// A9 加权模式（实现语义：向贡献值按 weight 链式插值，高权重者为 owner）
{
  const m = new ParamMixer();
  m.submitValue('w1', 'head.yaw', 0.2, { priority: 300, timestamp: T0, mode: 'weighted', weight: 0.25 });
  m.submitValue('w2', 'head.yaw', 0.6, { priority: 300, timestamp: T0, mode: 'weighted', weight: 0.75 });
  const s = m.step(T0 + 100, {});
  assert.equal(s.owners['head.yaw'], 'w2', '高权重者为 owner');
  // 0 →(0.25)→ 0.05 →(0.75)→ 0.4625
  assert.ok(Math.abs(s.values['head.yaw'] - 0.4625) < 1e-9, '链式插值: ' + s.values['head.yaw']);
  // 高权重来源把值拉向自身贡献值：w2 提交后比 w1 阶段更接近 0.6
  console.log('A9 weighted ok');
}

// A10 范围钳制（mixer options.ranges）
{
  const m = new ParamMixer({ ranges: { eyeLOpen: { min: 0, max: 1 } } });
  m.submitValue('llm', 'eyeLOpen', 5, { priority: 700, timestamp: T0 });
  const s = m.step(T0 + 100, {});
  assert.equal(s.values['eyeLOpen'], 1, '超出 mixer 范围钳制');
  console.log('A10 范围钳制 ok');
}

// A11 同源同参以最新提交为准（不堆积）
{
  const m = new ParamMixer();
  m.submitValue('llm', 'head.yaw', 0.1, { priority: 700, timestamp: T0 });
  m.submitValue('llm', 'head.yaw', 0.9, { priority: 700, timestamp: T0 + 50 });
  const s = m.step(T0 + 100, {});
  assert.equal(s.values['head.yaw'], 0.9, '同源最新提交生效');
  console.log('A11 同源最新提交 ok');
}

console.log('arbitration ok');
