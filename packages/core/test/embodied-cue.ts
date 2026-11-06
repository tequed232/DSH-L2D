/**
 * Embodied Cue 编译层测试（REFERENCE-WHALEL2D-ARCHITECTURE.md §6.5「测试与回滚」四组
 * + §6.3 同通道替换/跨通道并存推导 + §7.4 生命周期语义测试 2 的编译器侧）。
 *
 * 用例分组（EC-xx 对齐 §6.5 四组）：
 *   EC-01/02  词表校验：未知 channel / 未知 operation / 缺 target → rejected 非空且零产出
 *   EC-03/04  参数域断言：hold 的 params 值 = value×scale+offset 且 clamp 进 bounds
 *             （motion-intent.ts:178-187 同型）；transition params 终点值 0
 *   EC-06     fail-closed：NaN/Infinity value、interruptible:false、绑定表缺项 → rejected
 *             且断言 segments/stops/overlays/sharedUses 全空（零副作用）
 *   EC-05/07  映射断言：clear → stops[0].group === 'cue:<channel>'；overlay →
 *             sharedUses[0].endsAt 有限
 *   EC-08/09  同通道替换 / 跨通道并存：经 compile → enqueueGesture 推导（引用既有冲突
 *   判定行为，本层不重复实现——gesture-timeline.ts:173-176/313-320）
 *   EC-10     transition 租约 → stopGesture 按 group 释放（S-01 同型）
 *   EC-11     INV-8 同型：同一输入任意次编译输出一致
 *   EC-12     种子词表自检：绑定数据合法、通道间参数域互不相交（§6.3 并存的数据约定）
 * fixture 里的 AngleZ/LeanInput 等是种子词表数据（已按 renderer 真实写值核实），
 * 不允许出现在 src 实现的分支逻辑里（CUE_SEED_BINDINGS 是数据）。
 */
import assert from 'node:assert/strict';
import {
  compileEmbodiedCue,
  CUE_SEED_BINDINGS,
} from '../src/embodied-cue.ts';
import {
  emptyTimeline,
  enqueueGesture,
  resolveTimeline,
  stopGesture,
} from '../src/gesture-timeline.ts';
import type { EmbodiedCue } from '../src/embodied-cue.ts';

let passed = 0;
const test = (name: string, fn: () => void) => {
  fn();
  passed++;
  console.log('  ok  ' + name);
};

const NOW = 1000;
// 便捷封装：种子词表 + now 固定，不带 options（runId/source 缺省路径）。
const c = (cue: EmbodiedCue) => compileEmbodiedCue(cue, CUE_SEED_BINDINGS, NOW);

const isZeroOutput = (r: ReturnType<typeof compileEmbodiedCue>): boolean =>
  r.segments.length === 0 && r.sharedUses.length === 0 && r.stops.length === 0 && r.overlays.length === 0;

test('EC-01 词表校验：未知 channel / 未知 operation → rejected 非空且四产物全空', () => {
  const badChannel = c({ channel: 'wink', operation: 'hold', value: 0.5 });
  assert.equal(badChannel.rejected.length, 1);
  assert.deepEqual(badChannel.rejected[0], { channel: 'wink', operation: 'hold', reason: 'unknown-channel' });
  assert.ok(isZeroOutput(badChannel), 'fail-closed：零产出');

  const badOp = c({ channel: 'tilt', operation: 'spin' as never });
  assert.equal(badOp.rejected.length, 1);
  assert.equal(badOp.rejected[0].reason, 'unknown-operation');
  assert.ok(isZeroOutput(badOp));
});

test('EC-02 overlay 缺 target / clear 带 target 的开关方向', () => {
  const noTarget = c({ channel: 'gaze', operation: 'overlay' });
  assert.equal(noTarget.rejected[0]?.reason, 'missing-target');
  assert.ok(isZeroOutput(noTarget));

  const clearAsset = c({ channel: 'tilt', operation: 'clear', target: 'ext.exp.smile' });
  assert.deepEqual(clearAsset.stops, [{ group: 'cue:tilt' }], '缺省 = 本 channel 全清（group 锚点）');
  assert.deepEqual(clearAsset.overlays, [{ name: 'ext.exp.smile', on: false }], '带 target 追加表情关闭');
});

test('EC-03 hold 参数域映射：value×scale+offset，group/id/priority/source 缺省', () => {
  const r = c({ channel: 'tilt', operation: 'hold', value: 0.5, durationMs: 3000 });
  assert.deepEqual(r.rejected, []);
  assert.equal(r.segments.length, 1);
  const seg = r.segments[0];
  assert.equal(seg.id, 'cue:tilt:hold');
  assert.equal(seg.group, 'cue:tilt', 'group 是 clear 的 selector 锚点');
  assert.deepEqual(seg.params, { AngleZ: 7.5 }, '0.5×15=7.5（种子词表 tilt→AngleZ scale 15）');
  assert.equal(seg.durationMs, 3000);
  assert.equal(seg.priority, 50, '缺省 NORMAL');
  assert.equal(seg.source, 'motion', 'source 缺省 motion（INV-6 词汇）');
  assert.equal(seg.runId, undefined);
});

test('EC-04 参数域 clamp：value 超界时 clamp 进 bounds（motion-intent 同型）', () => {
  const r = c({ channel: 'tilt', operation: 'hold', value: 1.5, durationMs: 1000 });
  assert.deepEqual(r.segments[0].params, { AngleZ: 15 }, '1.5×15=22.5 → clamp 到 bounds 上限 15');
  const neg = c({ channel: 'lean', operation: 'hold', value: -2, durationMs: 1000 });
  assert.deepEqual(neg.segments[0].params, { LeanInput: -30 }, '-2×30=-60 → clamp 到 -30');
});

test('EC-05 transition：params 为参数域终点值 0、durationMs 必填（缺省=曲线长，v1 无曲线引用）', () => {
  const r = c({ channel: 'gaze', operation: 'transition', durationMs: 800 });
  assert.deepEqual(r.rejected, []);
  const seg = r.segments[0];
  assert.equal(seg.id, 'cue:gaze:transition');
  assert.equal(seg.group, 'cue:gaze');
  assert.deepEqual(seg.params, { ParamEyeBallX: 0, ParamEyeBallY: 0 }, '终点值 0，仅作冲突租约域');
  assert.equal(seg.durationMs, 800);

  const noDuration = c({ channel: 'gaze', operation: 'transition' });
  assert.equal(noDuration.rejected[0]?.reason, 'missing-duration');
  assert.ok(isZeroOutput(noDuration));
});

test('EC-06 fail-closed：非有限值 / interruptible:false / 缺 value / 非法 priority / 非法 duration → 零副作用', () => {
  const cases: Array<[EmbodiedCue, string]> = [
    [{ channel: 'tilt', operation: 'hold', value: Number.NaN }, 'invalid-value'],
    [{ channel: 'tilt', operation: 'hold', value: Number.POSITIVE_INFINITY }, 'invalid-value'],
    [{ channel: 'tilt', operation: 'hold' }, 'missing-value'],
    [{ channel: 'tilt', operation: 'hold', value: 0.5, interruptible: false }, 'not-interruptible'],
    [{ channel: 'tilt', operation: 'hold', value: 0.5, priority: 30 as never }, 'invalid-priority'],
    [{ channel: 'tilt', operation: 'hold', value: 0.5, durationMs: 0 }, 'invalid-duration'],
    [{ channel: 'tilt', operation: 'hold', value: 0.5, durationMs: -100 }, 'invalid-duration'],
  ];
  for (const [cue, reason] of cases) {
    const r = c(cue);
    assert.equal(r.rejected.length, 1, cue.operation + ' ' + String((cue as { value?: number }).value));
    assert.equal(r.rejected[0].reason, reason);
    assert.ok(isZeroOutput(r), '零产出（gesture-timeline.ts:239-248 不产生任何副作用同口径）');
  }
  // 绑定表缺项：坏 scale 数据 → invalid-binding（fail-closed 前置到资产层，§7.3）。
  const badBinding = compileEmbodiedCue(
    { channel: 'tilt', operation: 'hold', value: 0.5 },
    [{ channel: 'tilt', params: { AngleZ: { scale: Number.NaN } } }],
    NOW,
  );
  assert.equal(badBinding.rejected[0]?.reason, 'invalid-binding');
  assert.ok(isZeroOutput(badBinding));
});

test('EC-07 映射断言：clear → stops[0].group；overlay → sharedUses[0].endsAt 有限', () => {
  const clear = c({ channel: 'tilt', operation: 'clear' });
  assert.deepEqual(clear.stops, [{ group: 'cue:tilt' }]);
  assert.deepEqual(clear.segments, [], 'clear 不产段');

  const overlay = c({ channel: 'gaze', operation: 'overlay', target: 'ext.exp.smile', durationMs: 4000 });
  assert.equal(overlay.sharedUses.length, 1);
  assert.equal(overlay.sharedUses[0].channelId, 'ext.exp.smile');
  assert.equal(overlay.sharedUses[0].endsAt, NOW + 4000, 'endsAt 有限（占用租约）');
  assert.equal(overlay.sharedUses[0].startedAt, NOW);
  assert.deepEqual(overlay.overlays, [{ name: 'ext.exp.smile', on: true }]);

  const holdOverlay = c({ channel: 'gaze', operation: 'overlay', target: 'ext.exp.smile' });
  assert.equal(holdOverlay.sharedUses[0].endsAt, null, '无 durationMs → 长期持有（须显式 clear）');
});

test('EC-08 同通道替换：经 compile → enqueue 推导，后来者整批取代（既有冲突判定，不重复实现）', () => {
  const first = compileEmbodiedCue(
    { channel: 'tilt', operation: 'hold', value: 0.5, durationMs: 5000 },
    CUE_SEED_BINDINGS, NOW,
  );
  const a = enqueueGesture(emptyTimeline(), first.segments, NOW, { enabled: true });
  assert.equal(a.admitted.length, 1);

  const second = compileEmbodiedCue(
    { channel: 'tilt', operation: 'hold', value: -0.5, durationMs: 5000 },
    CUE_SEED_BINDINGS, NOW + 100,
  );
  const b = enqueueGesture(a.state, second.segments, NOW + 100, { enabled: true });
  assert.deepEqual(b.interrupted.map((s) => s.id), ['cue:tilt:hold'], '参数域完全重叠 → 同级可打断');
  assert.deepEqual(b.admitted.map((s) => s.id), ['cue:tilt:hold']);
  assert.deepEqual(resolveTimeline(b.state, NOW + 100).active[0].params, { AngleZ: -7.5 }, '当帧只剩新值');
});

test('EC-09 跨通道并存：tilt + gaze 参数域不相交 → 同批准入并存', () => {
  const cues = compileEmbodiedCue(
    { channel: 'tilt', operation: 'hold', value: 0.4, durationMs: 5000 },
    CUE_SEED_BINDINGS, NOW,
  );
  const cues2 = compileEmbodiedCue(
    { channel: 'gaze', operation: 'hold', value: 0.6, durationMs: 5000 },
    CUE_SEED_BINDINGS, NOW,
  );
  // 两段合并一次入队（交互侧与 Agent cue 走同一编译器的合批形态）。
  const r = enqueueGesture(emptyTimeline(), [...cues.segments, ...cues2.segments], NOW, { enabled: true });
  assert.deepEqual(r.rejected, []);
  assert.deepEqual(r.admitted.map((s) => s.id).sort(), ['cue:gaze:hold', 'cue:tilt:hold']);
  const active = resolveTimeline(r.state, NOW).active;
  assert.equal(active.length, 2, '跨通道并存（Body.cs:44-61 gaze/tilt 并存对应）');
});

test('EC-10 transition 租约 → clear 的 stops 经 stopGesture 按 group 释放（S-01 同型）', () => {
  const tr = c({ channel: 'lean', operation: 'transition', durationMs: 600 });
  const enq = enqueueGesture(emptyTimeline(), tr.segments, NOW, { enabled: true });
  assert.equal(enq.admitted.length, 1);
  const clear = c({ channel: 'lean', operation: 'clear' });
  const stop = stopGesture(enq.state, clear.stops[0]);
  assert.deepEqual(stop.stopped.map((s) => s.id), ['cue:lean:transition']);
  assert.deepEqual(resolveTimeline(stop.state, NOW).active, []);
});

test('EC-11 确定性（INV-8 同型）：同一输入任意次编译输出一致', () => {
  const cue: EmbodiedCue = { channel: 'gaze', operation: 'overlay', target: 'x', durationMs: 10 };
  assert.deepEqual(c(cue), c(cue));
  const hold: EmbodiedCue = { channel: 'tilt', operation: 'hold', value: 0.3 };
  assert.deepEqual(c(hold), c(hold));
});

test('EC-12 种子词表自检：数据合法、通道间参数域互不相交（§6.3 并存的数据约定）', () => {
  assert.ok(CUE_SEED_BINDINGS.length >= 3 && CUE_SEED_BINDINGS.length <= 5, '词表种子 3-5 个');
  const owner = new Map<string, string>();
  for (const binding of CUE_SEED_BINDINGS) {
    assert.ok(binding.channel, '通道名非空');
    const keys = Object.keys(binding.params);
    assert.ok(keys.length > 0, binding.channel + ' 参数域非空');
    for (const paramId of keys) {
      const p = binding.params[paramId];
      assert.ok(!p.scale || Number.isFinite(p.scale), binding.channel + '.' + paramId + ' scale 有限');
      if (p.bounds) {
        assert.ok(p.bounds[0] <= p.bounds[1], binding.channel + '.' + paramId + ' bounds 有序');
      }
      assert.ok(!owner.has(paramId), paramId + ' 只属一个通道（跨通道并存的前提）');
      owner.set(paramId, binding.channel);
    }
  }
  // 种子词表覆盖面（对照核实依据：renderer 真实写值 + capability-scan 画像）。
  const channels = new Set(CUE_SEED_BINDINGS.map((b) => b.channel));
  for (const expected of ['tilt', 'pitch', 'yaw', 'lean', 'gaze']) {
    assert.ok(channels.has(expected), '种子含 ' + expected);
  }
});

console.log('embodied-cue: ' + passed + ' tests passed');
