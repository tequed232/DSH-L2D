/**
 * Cue Loop 测试（M1-f 第二批 F2-3/4 组合语义 + 生命周期；测试矩阵 F2-T01…T15）。
 *
 * 覆盖：
 *   F2-T01 五通道词表映射实证（channel → 原生参数域/符号/量程 clamp；参数集与模型核实表一致）
 *   F2-T02 同通道后到替换（Body.cs:198 语义）
 *   F2-T03 跨通道并存（词表参数域互不相交 → 一次 tick 输出全部通道写值）
 *   F2-T04 长期持有（durationMs 缺省 = endsAt null，须显式释放）
 *   F2-T05 有限时长到期（endAt <= now，INV-5/S-05 同型）
 *   F2-T06 clear 按 channel 收窄（compiled.stops 的 group 锚点与停范围一致）
 *   F2-T07 clear 带 target 只关同名表情层（channel 与 overlay 两套释放面）
 *   F2-T08 overlay 单槽替换 + 到期
 *   F2-T09 transition：缺 duration fail-closed；有 duration 只占域零写值 + 到期
 *   F2-T10 fail-closed：未知 channel/operation、非有限值、interruptible:false → 零副作用
 *   F2-T11 表情资产清单校验（knownOverlays，fail-closed unknown-overlay）
 *   F2-T12 同参数多通道（词表错误）→ priority desc → channel 升序唯一 winner，不求和（INV-1）
 *   F2-T13 runId 透传与按 runId 收窄释放（陈旧批次不误清）
 *   F2-T14 纯函数/确定性：不修改入参、重复调用深相等、输出键排序
 *   F2-T15 与 gesture-timeline 端到端：同通道替换/跨通道并存/clear→stopGesture/到期对齐
 */
import assert from 'node:assert/strict';
import {
  commitCue,
  cueSnapshot,
  cueWrites,
  emptyCueLoop,
  releaseCue,
  tickCue,
} from '../src/cue-loop.ts';
import { CUE_SEED_BINDINGS, compileEmbodiedCue } from '../src/embodied-cue.ts';
import { emptyTimeline, enqueueGesture, resolveTimeline, stopGesture } from '../src/gesture-timeline.ts';
import type { CueChannelBinding, EmbodiedCue } from '../src/embodied-cue.ts';

let passed = 0;
const test = (name: string, fn: () => void) => {
  fn();
  passed++;
  console.log('  ok  ' + name);
};

const NOW = 2000;

/** 模型侧实证参数名（大肥鱼.cdi3.json，509 参数中逐一核实存在；见 docs/M1-F2-VOCAB-VERIFICATION.md）。 */
const VERIFIED_MODEL_PARAMS = new Map<string, string>([
  ['AngleZ', 'tilt'],
  ['AngleY', 'pitch'],
  ['AngleX', 'yaw'],
  ['LeanInput', 'lean'],
  ['ParamEyeBallX', 'gaze'],
  ['ParamEyeBallY', 'gaze'],
]);

const hold = (channel: string, value: number, extra: Partial<EmbodiedCue> = {}): EmbodiedCue => ({
  channel,
  operation: 'hold',
  value,
  ...extra,
});

const writesOf = (state: ReturnType<typeof emptyCueLoop>) => cueWrites(state, CUE_SEED_BINDINGS).writes;

test('F2-T01 五通道词表映射实证：参数名 ∈ 模型 cdi3，方向/量程与 renderer 写值一致', () => {
  // 1) 词表参数集必须与模型实证表逐条一致（防词表漂移；模型无 FaceAngleZ 等 VTS 侧名）。
  const seen = new Set<string>();
  for (const binding of CUE_SEED_BINDINGS) {
    for (const paramId of Object.keys(binding.params)) {
      assert.ok(VERIFIED_MODEL_PARAMS.has(paramId), paramId + ' 未在模型参数实证表中');
      assert.equal(VERIFIED_MODEL_PARAMS.get(paramId), binding.channel, paramId + ' 归属通道');
      assert.ok(!seen.has(paramId), paramId + ' 不允许跨通道重复声明');
      seen.add(paramId);
    }
  }
  for (const channel of ['tilt', 'pitch', 'yaw', 'lean', 'gaze']) {
    assert.ok(CUE_SEED_BINDINGS.some((b) => b.channel === channel), '种子含 ' + channel);
  }

  // 2) 正方向 +1 的原生值 = scale（renderer 真实写值口径）：
  //    AngleZ ±15（ANGLE_BUS_CAP）、AngleX/Y ±20 换算（gaze 跟随 gx*20，满量程 ±30）、
  //    LeanInput ±30（renderer clamp）、ParamEyeBall ±1（画像 min/max）。
  assert.deepEqual(writesOf(commitCue(emptyCueLoop(), hold('tilt', 1), CUE_SEED_BINDINGS, NOW).state), { AngleZ: 15 });
  assert.deepEqual(writesOf(commitCue(emptyCueLoop(), hold('pitch', 1), CUE_SEED_BINDINGS, NOW).state), { AngleY: 20 });
  assert.deepEqual(writesOf(commitCue(emptyCueLoop(), hold('yaw', 1), CUE_SEED_BINDINGS, NOW).state), { AngleX: 20 });
  assert.deepEqual(writesOf(commitCue(emptyCueLoop(), hold('lean', 1), CUE_SEED_BINDINGS, NOW).state), { LeanInput: 30 });
  assert.deepEqual(writesOf(commitCue(emptyCueLoop(), hold('gaze', 1), CUE_SEED_BINDINGS, NOW).state), {
    ParamEyeBallX: 1,
    ParamEyeBallY: 1,
  });

  // 3) 符号方向与 clamp：负值取负、超界钳到 bounds（pitch value=2 → 40 → 30）。
  assert.equal(writesOf(commitCue(emptyCueLoop(), hold('tilt', -1), CUE_SEED_BINDINGS, NOW).state).AngleZ, -15);
  assert.equal(writesOf(commitCue(emptyCueLoop(), hold('pitch', 2), CUE_SEED_BINDINGS, NOW).state).AngleY, 30);
  assert.equal(writesOf(commitCue(emptyCueLoop(), hold('lean', -2), CUE_SEED_BINDINGS, NOW).state).LeanInput, -30);
});

test('F2-T02 同通道后到替换：tilt 0.5 → -0.3 只留一条，写值为后来者', () => {
  const first = commitCue(emptyCueLoop(), hold('tilt', 0.5), CUE_SEED_BINDINGS, NOW);
  const second = commitCue(first.state, hold('tilt', -0.3), CUE_SEED_BINDINGS, NOW + 10);
  const snap = cueSnapshot(second.state, CUE_SEED_BINDINGS);
  assert.equal(snap.channels.length, 1, '同 channel 单槽');
  assert.equal(snap.channels[0].value, -0.3);
  assert.equal(snap.channels[0].startedAt, NOW + 10, '替换刷新开始时刻');
  assert.deepEqual(writesOf(second.state), { AngleZ: -4.5 });
});

test('F2-T03 跨通道并存：tilt + gaze + lean 一次 tick 输出三通道写值', () => {
  let state = emptyCueLoop();
  state = commitCue(state, hold('tilt', 0.5), CUE_SEED_BINDINGS, NOW).state;
  state = commitCue(state, hold('gaze', -1), CUE_SEED_BINDINGS, NOW).state;
  state = commitCue(state, hold('lean', 0.2), CUE_SEED_BINDINGS, NOW).state;
  const w = cueWrites(state, CUE_SEED_BINDINGS);
  assert.deepEqual(w.writes, { AngleZ: 7.5, LeanInput: 6, ParamEyeBallX: -1, ParamEyeBallY: -1 });
  assert.deepEqual(Object.keys(w.writes), Object.keys(w.writes).slice().sort(), '键稳定排序');
  assert.deepEqual(w.conflicts, [], '词表域不相交 → 无同参数冲突');
});

test('F2-T04 长期持有：durationMs 缺省 endsAt=null，任意时刻 tick 不释放', () => {
  const c = commitCue(emptyCueLoop(), hold('tilt', 0.4), CUE_SEED_BINDINGS, NOW);
  assert.equal(c.state.channels.tilt.endsAt, null);
  const ticked = tickCue(c.state, NOW + 86_400_000);
  assert.deepEqual(ticked.expiredChannels, []);
  assert.equal(ticked.state, c.state, '无到期 → 返回同一状态（无副作用）');
  assert.deepEqual(writesOf(ticked.state), { AngleZ: 6 });
  const released = releaseCue(ticked.state, { channel: 'tilt' });
  assert.deepEqual(released.releasedChannels, ['tilt']);
  assert.deepEqual(writesOf(released.state), {});
});

test('F2-T05 有限时长到期：now < endsAt 持有，now >= endsAt 释放（INV-5 同型）', () => {
  const c = commitCue(emptyCueLoop(), hold('tilt', 0.5, { durationMs: 500 }), CUE_SEED_BINDINGS, NOW);
  assert.equal(c.state.channels.tilt.endsAt, NOW + 500);
  const before = tickCue(c.state, NOW + 499);
  assert.deepEqual(before.expiredChannels, []);
  assert.deepEqual(writesOf(before.state), { AngleZ: 7.5 });
  const at = tickCue(c.state, NOW + 500);
  assert.deepEqual(at.expiredChannels, ['tilt']);
  assert.deepEqual(writesOf(at.state), {});
  assert.equal(at.state.channels.tilt, undefined);
});

test('F2-T06 clear 按 channel 收窄：tilt 停、gaze 留；stops 锚点与停范围一致', () => {
  let state = emptyCueLoop();
  state = commitCue(state, hold('tilt', 0.5), CUE_SEED_BINDINGS, NOW).state;
  state = commitCue(state, hold('gaze', 1), CUE_SEED_BINDINGS, NOW).state;
  const cleared = commitCue(state, { channel: 'tilt', operation: 'clear' }, CUE_SEED_BINDINGS, NOW + 1);
  assert.ok(cleared.accepted);
  assert.deepEqual(cleared.compiled.stops, [{ group: 'cue:tilt' }]);
  assert.deepEqual(Object.keys(cleared.state.channels), ['gaze'], '跨通道不受影响');
  assert.deepEqual(writesOf(cleared.state), { ParamEyeBallX: 1, ParamEyeBallY: 1 });
});

test('F2-T07 clear 带 target：只关闭同名表情层，channel 照常释放；不匹配则保留表情', () => {
  let state = commitCue(emptyCueLoop(), { channel: 'gaze', operation: 'overlay', target: 'happy' }, CUE_SEED_BINDINGS, NOW).state;
  state = commitCue(state, hold('tilt', 0.5), CUE_SEED_BINDINGS, NOW).state;

  const other = commitCue(state, { channel: 'tilt', operation: 'clear', target: 'sad' }, CUE_SEED_BINDINGS, NOW + 1);
  assert.equal(other.state.overlay?.name, 'happy', 'target 不匹配 → 表情保留');
  assert.equal(other.state.channels.tilt, undefined, 'channel 仍释放');

  const matched = commitCue(state, { channel: 'tilt', operation: 'clear', target: 'happy' }, CUE_SEED_BINDINGS, NOW + 1);
  assert.equal(matched.state.overlay, null);
  assert.deepEqual(matched.compiled.overlays, [{ name: 'happy', on: false }]);
});

test('F2-T08 overlay 单槽替换 + 到期关闭', () => {
  let state = commitCue(emptyCueLoop(), { channel: 'gaze', operation: 'overlay', target: 'happy' }, CUE_SEED_BINDINGS, NOW).state;
  assert.equal(state.overlay?.name, 'happy');
  state = commitCue(state, { channel: 'gaze', operation: 'overlay', target: 'sad', durationMs: 300 }, CUE_SEED_BINDINGS, NOW + 10).state;
  assert.equal(state.overlay?.name, 'sad', '新 overlay 替换旧层（Cubism 表情单槽）');
  assert.equal(state.overlay?.endsAt, NOW + 310);
  const ticked = tickCue(state, NOW + 310);
  assert.equal(ticked.expiredOverlay, 'sad');
  assert.equal(ticked.state.overlay, null);
});

test('F2-T09 transition：缺 duration 拒绝；有 duration 只占域零写值，到期释放', () => {
  const missing = commitCue(emptyCueLoop(), { channel: 'tilt', operation: 'transition' }, CUE_SEED_BINDINGS, NOW);
  assert.equal(missing.accepted, false);
  assert.deepEqual(missing.rejected, [{ channel: 'tilt', operation: 'transition', reason: 'missing-duration' }]);
  assert.equal(missing.state.channels.tilt, undefined);

  const ok = commitCue(emptyCueLoop(), { channel: 'tilt', operation: 'transition', durationMs: 400 }, CUE_SEED_BINDINGS, NOW);
  assert.ok(ok.accepted);
  assert.equal(ok.state.channels.tilt.operation, 'transition');
  assert.deepEqual(writesOf(ok.state), {}, 'v1 无曲线引用 → 只占域不写值');
  assert.deepEqual(tickCue(ok.state, NOW + 400).expiredChannels, ['tilt']);
});

test('F2-T10 fail-closed：非法输入 → 状态原样引用、四产物全空、rejected 非空', () => {
  const state = commitCue(emptyCueLoop(), hold('tilt', 0.5), CUE_SEED_BINDINGS, NOW).state;
  const cases: Array<[EmbodiedCue, string]> = [
    [{ channel: 'wink', operation: 'hold', value: 1 }, 'unknown-channel'],
    [{ channel: 'tilt', operation: 'spin' as never }, 'unknown-operation'],
    [{ channel: 'tilt', operation: 'hold', value: Number.NaN }, 'invalid-value'],
    [{ channel: 'tilt', operation: 'hold', value: 0.5, interruptible: false }, 'not-interruptible'],
    [{ channel: 'tilt', operation: 'hold', value: 0.5, durationMs: -1 }, 'invalid-duration'],
  ];
  for (const [cue, reason] of cases) {
    const r = commitCue(state, cue, CUE_SEED_BINDINGS, NOW + 1);
    assert.equal(r.accepted, false, reason);
    assert.equal(r.rejected[0].reason, reason);
    assert.equal(r.state, state, reason + ' 零副作用（同一引用）');
    assert.deepEqual(r.compiled.segments, []);
    assert.deepEqual(r.compiled.sharedUses, []);
    assert.deepEqual(r.compiled.stops, []);
    assert.deepEqual(r.compiled.overlays, []);
  }
});

test('F2-T11 表情清单校验：knownOverlays 之外的 target 被拒，零副作用', () => {
  const known = ['happy', 'sad'];
  const bad = commitCue(
    emptyCueLoop(),
    { channel: 'gaze', operation: 'overlay', target: 'angry' },
    CUE_SEED_BINDINGS,
    NOW,
    { knownOverlays: known },
  );
  assert.equal(bad.accepted, false);
  assert.deepEqual(bad.rejected, [{ channel: 'gaze', operation: 'overlay', reason: 'unknown-overlay' }]);
  assert.deepEqual(bad.compiled.overlays, []);
  assert.equal(bad.state.overlay, null);

  const ok = commitCue(
    emptyCueLoop(),
    { channel: 'gaze', operation: 'overlay', target: 'happy' },
    CUE_SEED_BINDINGS,
    NOW,
    { knownOverlays: known },
  );
  assert.ok(ok.accepted);
});

test('F2-T12 同参数多通道（词表错误）：priority desc → channel 升序唯一 winner，不求和', () => {
  const bindings: CueChannelBinding[] = [
    { channel: 'a', params: { ParamEyeBallX: { scale: 1 } } },
    { channel: 'b', params: { ParamEyeBallX: { scale: 2 } } },
  ];
  const a = commitCue(emptyCueLoop(), hold('a', 0.5, { priority: 90 }), bindings, NOW).state;
  const b = commitCue(a, hold('b', 0.5, { priority: 10 }), bindings, NOW).state;
  const w1 = cueWrites(b, bindings);
  assert.deepEqual(w1.writes, { ParamEyeBallX: 0.5 }, '高优先级 a 胜出（0.5），非求和/非覆盖为 b 的 1.0');
  assert.equal(w1.owners.ParamEyeBallX, 'a');
  assert.deepEqual(w1.conflicts, [{ paramId: 'ParamEyeBallX', winner: 'a', losers: ['b'] }]);

  // 同优先级 → channel 字典序小者胜（确定性，与入账顺序无关）。
  const c1 = commitCue(emptyCueLoop(), hold('b', 0.5, { priority: 50 }), bindings, NOW).state;
  const c2 = commitCue(c1, hold('a', 0.2, { priority: 50 }), bindings, NOW).state;
  const w2 = cueWrites(c2, bindings);
  assert.equal(w2.owners.ParamEyeBallX, 'a');
  assert.equal(w2.writes.ParamEyeBallX, 0.2);
});

test('F2-T13 runId：透传快照；按 runId 收窄释放，陈旧批次不误清', () => {
  const state = commitCue(emptyCueLoop(), hold('tilt', 0.5, { durationMs: 1000 }), CUE_SEED_BINDINGS, NOW, {
    runId: 'r1',
  }).state;
  assert.equal(cueSnapshot(state, CUE_SEED_BINDINGS).channels[0].runId, 'r1');

  const stale = releaseCue(state, { runId: 'r0' });
  assert.equal(stale.state, state, '陈旧 runId 无命中 → 原状态');
  assert.deepEqual(stale.releasedChannels, []);

  const hit = releaseCue(state, { runId: 'r1' });
  assert.deepEqual(hit.releasedChannels, ['tilt']);
  assert.deepEqual(hit.state.channels, {});
});

test('F2-T14 纯函数/确定性：不修改入参（深冻结）、重复调用深相等、输出排序稳定', () => {
  const first = commitCue(emptyCueLoop(), hold('gaze', 0.5), CUE_SEED_BINDINGS, NOW);
  const frozen: any = { channels: Object.freeze({ ...first.state.channels }), overlay: null };
  Object.freeze(first.state.channels.gaze);

  const before = JSON.stringify(frozen);
  const again = commitCue(frozen, hold('tilt', -0.5), CUE_SEED_BINDINGS, NOW + 1);
  tickCue(again.state, NOW + 2);
  cueWrites(again.state, CUE_SEED_BINDINGS);
  releaseCue(again.state, { channel: 'tilt' });
  cueSnapshot(again.state, CUE_SEED_BINDINGS);
  assert.equal(JSON.stringify(frozen), before, '入参零修改');

  const x = commitCue(emptyCueLoop(), { channel: 'tilt', operation: 'hold', value: 0.3 }, CUE_SEED_BINDINGS, NOW);
  const y = commitCue(emptyCueLoop(), { channel: 'tilt', operation: 'hold', value: 0.3 }, CUE_SEED_BINDINGS, NOW);
  assert.deepEqual(x, y);
  assert.deepEqual(cueSnapshot(x.state, CUE_SEED_BINDINGS), cueSnapshot(y.state, CUE_SEED_BINDINGS));
});

test('F2-T15 与 gesture-timeline 端到端：同通道替换 / 跨通道并存 / clear→stopGesture / 到期对齐', () => {
  const t0 = 10_000;
  // 第一次 tilt hold 入队。
  const c1 = commitCue(emptyCueLoop(), hold('tilt', 0.5, { durationMs: 800 }), CUE_SEED_BINDINGS, t0);
  const e1 = enqueueGesture(emptyTimeline(), c1.compiled.segments, t0, { enabled: true });
  assert.equal(e1.admitted.length, 1);

  // 第二次同通道 tilt → 参数域重叠，同级可打断（后来者取代）。
  const c2 = commitCue(c1.state, hold('tilt', -0.5), CUE_SEED_BINDINGS, t0 + 100);
  const e2 = enqueueGesture(e1.state, c2.compiled.segments, t0 + 100, { enabled: true });
  assert.equal(e2.admitted.length, 1);
  assert.deepEqual(e2.interrupted.map((s) => s.id), ['cue:tilt:hold'], '同通道替换');

  // 跨通道 gaze 与 tilt 并存。
  const c3 = commitCue(c2.state, hold('gaze', 1, { durationMs: 800 }), CUE_SEED_BINDINGS, t0 + 200);
  const e3 = enqueueGesture(e2.state, c3.compiled.segments, t0 + 200, { enabled: true });
  assert.equal(e3.admitted.length, 1);
  assert.deepEqual(e3.interrupted, [], '跨通道参数域不相交 → 并存');
  assert.equal(e3.state.segments.length, 2);

  // clear tilt → stopGesture 按 compiled.stops 的 group 释放且只释放 tilt。
  const cleared = commitCue(c3.state, { channel: 'tilt', operation: 'clear' }, CUE_SEED_BINDINGS, t0 + 300);
  const stopped = stopGesture(e3.state, cleared.compiled.stops[0]);
  assert.deepEqual(stopped.stopped.map((s) => s.id), ['cue:tilt:hold']);
  assert.deepEqual(stopped.state.segments.map((s) => s.id), ['cue:gaze:hold']);

  // 到期对齐：gaze 在 t0+200+800 = t0+1000 到期，账本与时间线同一时刻释放。
  const at = t0 + 1000;
  assert.deepEqual(tickCue(c3.state, at).expiredChannels, ['gaze']);
  assert.deepEqual(resolveTimeline(stopped.state, at).expired.map((s) => s.id), ['cue:gaze:hold']);

  // 编译层与账本同一份词表：compileEmbodiedCue 的段 params 值 = 账本写值（hold 场景）。
  const compiled = compileEmbodiedCue(hold('tilt', 0.5), CUE_SEED_BINDINGS, t0);
  assert.deepEqual(compiled.segments[0].params, { AngleZ: 7.5 });
});

console.log('cue-loop: ' + passed + ' tests passed');
