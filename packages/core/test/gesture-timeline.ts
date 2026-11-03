/**
 * Gesture Timeline 测试（docs/Embodied-Behavior.md §6「Gesture Timeline」/ §8 M1-c 行）。
 *
 * 用例编号 GT-xx 与文档锚点对照（语义同型，逐条对齐）：
 *   GT-01    → ActGate「没有在播的链时，任何优先级都能开始」（action-chain.ts 头注）
 *   GT-02/03 → 同级可打断 / 低不打断高（canInterruptAct；LimbController priority-blocked；S-04）
 *   GT-04    → 高打低即抢占，旧段立即让位（R7 打断即释放；S-04）
 *   GT-05/06 → chain-normalize.ts 分组语义：group 并行桶 / delayMs / 整组超时钳制
 *   GT-07/08 → INV-5 / S-05 到期兜底（expiresAt <= now 视为已释放）；长期持有不自动过期
 *   GT-09    → INV-12 同型：flag 关全拒、resolve 恒空（M1-c 回滚要求：旧 playKeyframes 路径保留）
 *   GT-10    → INV-8 同型：输出与入队顺序无关、稳定排序、可重放
 *   GT-11    → INV-9 同型：非法值 fail-closed，无任何副作用
 *   GT-12    → LimbController 逐参数语义：不同参数并存，参数重叠才构成抢占
 *   GT-13    → S-01 同型：显式 stop 释放（R7/R8 释放语义）
 * fixture 里的 RArm/LArm 等是测试素材，不允许出现在 src 实现里。
 */
import assert from 'node:assert/strict';
import {
  emptyTimeline,
  enqueueGesture,
  resolveTimeline,
  stopGesture,
} from '../src/gesture-timeline.ts';
import { GROUP_TIMEOUT_MAX_MS } from '../src/chain-normalize.ts';
import type { GestureSegment, GestureTimelineState } from '../src/gesture-timeline.ts';

let passed = 0;
const test = (name: string, fn: () => void) => {
  fn();
  passed++;
  console.log('  ok  ' + name);
};

const ENQ = { enabled: true } as const;
const seg = (id: string, extra: Partial<GestureSegment> = {}): GestureSegment =>
  ({ id, params: { RArm: 1 }, ...extra });

const ids = (list: ReadonlyArray<{ id: string }>) => list.map((s) => s.id);

test('GT-01 空时间线：任何优先级都能开始，入队后 resolve 输出活跃段', () => {
  const r = enqueueGesture(emptyTimeline(), [seg('g1', { durationMs: 1000 })], 1000, ENQ);
  assert.deepEqual(ids(r.rejected), []);
  assert.deepEqual(ids(r.admitted), ['g1']);
  assert.deepEqual(ids(r.interrupted), []);
  const frame = resolveTimeline(r.state, 1000);
  assert.deepEqual(ids(frame.active), ['g1']);
  assert.deepEqual(ids(frame.expired), []);
  assert.deepEqual(frame.active[0].params, { RArm: 1 });
  assert.equal(frame.active[0].source, 'motion', 'source 缺省 motion（INV-6 词汇）');
  assert.equal(frame.active[0].priority, 50, 'priority 缺省 NORMAL');
});

test('GT-02 同级可打断：同优先级参数重叠 → 旧段让位（替换语义，C3/C5）', () => {
  const a = enqueueGesture(emptyTimeline(), [seg('g1', { durationMs: 5000 })], 1000, ENQ);
  const b = enqueueGesture(a.state, [seg('g2', { durationMs: 5000 })], 1100, ENQ);
  assert.deepEqual(ids(b.interrupted), ['g1']);
  assert.deepEqual(ids(b.admitted), ['g2']);
  assert.deepEqual(ids(resolveTimeline(b.state, 1100).active), ['g2']);
  assert.ok(!b.state.segments.some((s) => s.id === 'g1'), '被打断段立即退出时间线（R7）');
});

test('GT-03 低不打断高：FORCE 在播时 NORMAL 整批 rejected(priority-blocked)', () => {
  const a = enqueueGesture(emptyTimeline(), [seg('g1', { priority: 90, durationMs: 5000 })], 1000, ENQ);
  const b = enqueueGesture(a.state, [seg('g2', { priority: 50, durationMs: 5000 })], 1100, ENQ);
  assert.deepEqual(b.rejected, [{ id: 'g2', reason: 'priority-blocked' }]);
  assert.deepEqual(b.admitted, []);
  assert.deepEqual(b.interrupted, []);
  assert.deepEqual(ids(resolveTimeline(b.state, 1100).active), ['g1'], '旧段保持活跃');
});

test('GT-04 高打低：FORCE 抢占 BACKGROUND，旧段立即让位（S-04）', () => {
  const a = enqueueGesture(emptyTimeline(), [seg('g1', { priority: 10, durationMs: 5000 })], 1000, ENQ);
  const b = enqueueGesture(a.state, [seg('g2', { priority: 90, durationMs: 5000 })], 1100, ENQ);
  assert.deepEqual(ids(b.interrupted), ['g1']);
  assert.deepEqual(ids(resolveTimeline(b.state, 1100).active), ['g2']);
});

test('GT-05 group 并行桶：同组段同桶投放、整组超时取最大并钳制（chain-normalize 同源）', () => {
  const r = enqueueGesture(emptyTimeline(), [
    seg('w1', { group: 'wave', timeoutMs: 500 }),
    seg('w2', { group: 'wave', delayMs: 100, timeoutMs: 200 }),
  ], 1000, ENQ);
  assert.deepEqual(ids(r.admitted), ['w1', 'w2']);
  assert.deepEqual(r.admitted.map((s) => s.startAt), [1000, 1100], '各段按自身 delayMs 投放');
  // 整组超时 = 组内最大（500），桶起点 1000 → 全组 endAt = 1500
  assert.ok(r.admitted.every((s) => s.endAt === 1500), '整组超时原子生效');
  assert.deepEqual(ids(resolveTimeline(r.state, 1200).active), ['w1', 'w2']);
  const gone = resolveTimeline(r.state, 1500);
  assert.deepEqual(gone.active, []);
  assert.deepEqual(ids(gone.expired), ['w1', 'w2'], '到点整组清理（timeout reason 语义）');

  const clamped = enqueueGesture(emptyTimeline(), [seg('w3', { group: 'wave', timeoutMs: 999999 })], 1000, ENQ);
  assert.equal(clamped.admitted[0].endAt, 1000 + GROUP_TIMEOUT_MAX_MS, '超时钳制到 GROUP_TIMEOUT_MAX_MS');
});

test('GT-06 delayMs：投放前在 scheduled，到点转 active', () => {
  const r = enqueueGesture(emptyTimeline(), [seg('g1', { delayMs: 200, durationMs: 1000 })], 1000, ENQ);
  const before = resolveTimeline(r.state, 1000);
  assert.deepEqual(before.active, [], '投放前无活跃段（空帧无副作用）');
  assert.deepEqual(ids(before.scheduled), ['g1']);
  const after = resolveTimeline(r.state, 1200);
  assert.deepEqual(ids(after.active), ['g1']);
  assert.deepEqual(after.scheduled, []);
});

test('GT-07 durationMs 到期清理：endAt <= now 视为已释放（INV-5 / S-05）', () => {
  const r = enqueueGesture(emptyTimeline(), [seg('g1', { durationMs: 100 })], 1000, ENQ);
  assert.deepEqual(ids(resolveTimeline(r.state, 1099).active), ['g1']);
  const done = resolveTimeline(r.state, 1100);
  assert.deepEqual(done.active, []);
  assert.deepEqual(ids(done.expired), ['g1']);
  assert.deepEqual(done.state.segments, [], '清理后的状态不再含该段');
});

test('GT-08 长期持有（endAt null）不自动过期，须显式 stop', () => {
  const r = enqueueGesture(emptyTimeline(), [seg('g1')], 1000, ENQ);
  assert.equal(r.admitted[0].endAt, null);
  assert.deepEqual(ids(resolveTimeline(r.state, 9999999).active), ['g1']);
});

test('GT-09 flag 关（缺省 M1_DEFAULT_ENABLED）：入队全拒 disabled、resolve 恒空（INV-12 同型）', () => {
  // 缺省（不传 enabled）= 关闭
  const off = enqueueGesture(emptyTimeline(), [seg('g1')], 1000);
  assert.deepEqual(off.rejected, [{ id: 'g1', reason: 'disabled' }]);
  assert.deepEqual(off.admitted, []);
  assert.deepEqual(resolveTimeline(off.state, 1000).active, []);
  // 显式关闭
  const off2 = enqueueGesture(emptyTimeline(), [seg('g2', { priority: 90 })], 1000, { enabled: false });
  assert.deepEqual(off2.rejected, [{ id: 'g2', reason: 'disabled' }]);
  // 关闭时状态零变化
  const seeded: GestureTimelineState = {
    segments: [{
      id: 'keep', group: '', priority: 50, source: 'motion', params: { LArm: 1 },
      entryId: 'e0', startAt: 0, endAt: null,
    }],
  };
  const untouched = enqueueGesture(seeded, [seg('g3')], 1000, { enabled: false });
  assert.deepEqual(untouched.state.segments, seeded.segments, 'flag 关 = 现行为，零副作用');
});

test('GT-10 确定性（INV-8 同型）：入队顺序打乱 → 活跃段输出逐字节相同', () => {
  const batchA: GestureSegment[] = [
    seg('a', { params: { RArm: 1 }, durationMs: 3000 }),
    seg('b', { params: { LArm: 1 }, delayMs: 100, durationMs: 3000 }),
    seg('c', { params: { ShoulderZ: 1 }, delayMs: 200, durationMs: 3000 }),
  ];
  const run1 = enqueueGesture(emptyTimeline(), batchA, 1000, { enabled: true, entryId: 'e1' });
  const run2 = enqueueGesture(emptyTimeline(), [...batchA].reverse(), 1000, { enabled: true, entryId: 'e1' });
  assert.deepEqual(resolveTimeline(run1.state, 1300), resolveTimeline(run2.state, 1300));
  // 输出按 startAt → id 稳定排序
  assert.deepEqual(ids(resolveTimeline(run1.state, 1300).active), ['a', 'b', 'c']);
});

test('GT-11 fail-closed（INV-9 同型）：非法段逐条 rejected(invalid-segment)，状态零变化', () => {
  const before = emptyTimeline();
  const r = enqueueGesture(before, [
    { params: { RArm: 1 } } as GestureSegment,                 // 缺 id
    seg('bad-delay', { delayMs: -1 }),                          // 负 delay
    seg('bad-duration', { durationMs: Number.NaN }),            // 非有限
    seg('bad-priority', { priority: 60 as 50 }),                // 非 ActGate 档位
    seg('bad-param', { params: { RArm: Number.POSITIVE_INFINITY } }),
    seg('good', { durationMs: 1000 }),
  ], 1000, ENQ);
  assert.deepEqual(
    r.rejected.map((x) => [x.id, x.reason]),
    [
      ['*', 'invalid-segment'],
      ['bad-delay', 'invalid-segment'],
      ['bad-duration', 'invalid-segment'],
      ['bad-priority', 'invalid-segment'],
      ['bad-param', 'invalid-segment'],
    ],
  );
  assert.deepEqual(ids(r.admitted), ['good'], '合法段照常入队（LimbController 逐 id 同型）');
  // 纯非法入队：状态零变化
  const none = enqueueGesture(before, [{ params: {} } as GestureSegment], 1000, ENQ);
  assert.deepEqual(none.state.segments, []);
});

test('GT-12 逐参数冲突域（LimbController 同型）：不同参数并存，重叠才抢占', () => {
  const a = enqueueGesture(emptyTimeline(), [seg('g1', { durationMs: 5000 })], 1000, ENQ);
  // 不同参数：并存，互不打断
  const b = enqueueGesture(a.state, [seg('g2', { params: { LArm: 1 }, durationMs: 5000 })], 1100, ENQ);
  assert.deepEqual(b.interrupted, []);
  assert.deepEqual(ids(resolveTimeline(b.state, 1100).active), ['g1', 'g2']);
  // 同参数：抢占 g1，g2 保持
  const c = enqueueGesture(b.state, [seg('g3', { durationMs: 5000 })], 1200, ENQ);
  assert.deepEqual(ids(c.interrupted), ['g1']);
  assert.deepEqual(ids(resolveTimeline(c.state, 1200).active), ['g2', 'g3']);
  // 无 params（资产型手势）：不与任何段冲突
  const d = enqueueGesture(c.state, [{ id: 'g4', durationMs: 5000 }], 1300, ENQ);
  assert.deepEqual(d.interrupted, []);
  assert.deepEqual(ids(resolveTimeline(d.state, 1300).active), ['g2', 'g3', 'g4']);
});

test('GT-13 显式 stop（S-01 同型）：按 runId/id/entryId 释放，缺省全停', () => {
  const r = enqueueGesture(emptyTimeline(), [
    seg('g1', { runId: 'r1', durationMs: 5000 }),
    seg('g2', { runId: 'r2', durationMs: 5000 }),
  ], 1000, ENQ);
  const stopR1 = stopGesture(r.state, { runId: 'r1' });
  assert.deepEqual(ids(stopR1.stopped), ['g1']);
  assert.deepEqual(ids(resolveTimeline(stopR1.state, 1000).active), ['g2']);
  const stopById = stopGesture(stopR1.state, { id: 'g2' });
  assert.deepEqual(stopById.state.segments, []);
  // 重新入队后全停
  const again = enqueueGesture(stopById.state, [seg('g3'), seg('g4', { params: { LArm: 1 } })], 2000, ENQ);
  const stopAll = stopGesture(again.state);
  assert.deepEqual(stopAll.state.segments, []);
  assert.deepEqual(ids(stopAll.stopped), ['g3', 'g4']);
});
