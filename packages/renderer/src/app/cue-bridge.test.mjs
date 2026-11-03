/**
 * Cue Bridge 测试（M1-f 第二批 F2-1；测试矩阵 R1-R12 本域用例）。
 *
 * deps 全部 mock（计数器断言「零触碰」/「调用形状」），不依赖 Cubism/时间线真实实现。
 * 用例：
 *   R1  flag 关：零副作用（不编译/不入队/不写值/不碰表情）
 *   R2  正向 hold：时间线准入的段形状（group/params/priority）+ 帧写值
 *   R3  时间线拒绝（priority-blocked）：账本不落账、零写值
 *   R4  缺 admitGesture 依赖 → fail-closed 'timeline-unavailable'
 *   R5  clear 按 channel：stopGesture(group) + 写值清空
 *   R6  overlay 打开/关闭（target 匹配才关）
 *   R7  overlay 未知表情（setExpression=false）→ 拒整条，零落账
 *   R8  overlay 到期：clearExpression + expiredOverlay
 *   R9  hold 到期：到期帧起不写值 + 停租约
 *   R10 同通道替换：账本单槽 + 写值为后来者 + runId 透传
 *   R11 stop(selector)：按 channel 收窄释放
 *   R12 被拒批次不污染后续：第二次合法 cue 正常落账
 */
import assert from 'node:assert/strict';
import { createCueBridge } from './cue-bridge.ts';
import { CUE_SEED_BINDINGS } from '../../../core/src/embodied-cue.ts';

let passed = 0;
const test = (name, fn) => {
  fn();
  passed++;
  console.log('  ok  ' + name);
};

/** mock deps：全部依赖可注入并带调用记录。 */
function makeDeps(overrides = {}) {
  const calls = { admit: [], stop: [], setExpression: [], clearExpression: 0, own: [], release: [], write: [] };
  const clock = { now: 1000 };
  const gate = overrides.gate;
  const deps = {
    enabled: true,
    now: () => clock.now,
    admitGesture: (segments, opts) => {
      calls.admit.push({ segments, opts });
      return typeof gate === 'function' ? gate(segments, opts) : gate ?? { admitted: true, entryId: 'e1' };
    },
    stopGesture: (selector) => calls.stop.push(selector),
    setExpression: (name) => {
      calls.setExpression.push(name);
      return overrides.setExpressionResult ?? true;
    },
    clearExpression: () => {
      calls.clearExpression++;
      return true;
    },
    knownOverlays: overrides.knownOverlays,
    writeParam:
      overrides.writeParam ??
      ((id, value) => {
        calls.write.push([id, value]);
        return true;
      }),
    isMouthParam: overrides.isMouthParam,
    isPhysicsOutput: overrides.isPhysicsOutput ?? (() => false),
    ownParams:
      overrides.ownParams ??
      ((ids) => {
        calls.own.push(...ids);
        return ids;
      }),
    releaseOwned:
      overrides.releaseOwned ??
      ((ids) => {
        calls.release.push(...ids);
        return ids;
      }),
    bindings: overrides.bindings,
    ...overrides.deps,
  };
  if (overrides.admitGesture === null) delete deps.admitGesture;
  return { deps, calls, clock };
}

const hold = (channel, value, extra = {}) => ({ channel, operation: 'hold', value, ...extra });

test('R1 flag 关：admit 全拒且不触碰任何依赖', () => {
  const { deps, calls } = makeDeps({ deps: { enabled: false } });
  const bridge = createCueBridge(deps);
  const r = bridge.admit(hold('tilt', 0.5));
  assert.equal(r.accepted, false);
  assert.equal(r.flagEnabled, false);
  assert.deepEqual(r.rejected, [{ channel: 'tilt', operation: 'hold', reason: 'disabled' }]);
  assert.deepEqual(calls.admit, []);
  assert.deepEqual(calls.stop, []);
  assert.deepEqual(calls.setExpression, []);
  assert.equal(calls.clearExpression, 0);
  assert.deepEqual(bridge.tick(1000), {
    writes: {},
    applied: [],
    skipped: [],
    expiredChannels: [],
    expiredOverlay: null,
  });
  assert.equal(bridge.snapshot().enabled, false);
  assert.deepEqual(bridge.snapshot().channels, []);
});

test('R2 正向 hold：段形状（group/params/priority）+ 帧写值', () => {
  const { deps, calls } = makeDeps({ deps: { knownOverlays: () => ['happy'] } });
  const bridge = createCueBridge(deps);
  const r = bridge.admit(hold('tilt', 0.5, { priority: 90 }), { entryId: 'cue:1', runId: 'r1' });
  assert.equal(r.accepted, true);
  assert.equal(r.flagEnabled, true);
  assert.deepEqual(r.writes, { AngleZ: 7.5 });
  assert.equal(r.entryId, 'cue:1');

  assert.equal(calls.admit.length, 1);
  const seg = calls.admit[0].segments[0];
  assert.equal(seg.id, 'cue:tilt:hold');
  assert.equal(seg.group, 'cue:tilt');
  assert.deepEqual(seg.params, { AngleZ: 7.5 });
  assert.equal(seg.priority, 90);
  assert.equal(calls.admit[0].opts.entryId, 'cue:1');

  const frame = bridge.tick(1000);
  assert.deepEqual(frame.writes, { AngleZ: 7.5 });
  assert.deepEqual(frame.applied, ['AngleZ'], '无注入端口时声明写值');
  assert.deepEqual(bridge.tick(1500).writes, { AngleZ: 7.5 }, '长期持有每帧续写');
  assert.equal(bridge.snapshot().channels[0].runId, 'r1');
});

test('R3 时间线拒绝：账本不落账、零写值、零表情副作用', () => {
  const { deps, calls } = makeDeps({
    gate: { admitted: false, rejected: [{ id: 'cue:tilt:hold', reason: 'priority-blocked' }] },
  });
  const bridge = createCueBridge(deps);
  const r = bridge.admit(hold('tilt', 0.5));
  assert.equal(r.accepted, false);
  assert.equal(r.flagEnabled, true);
  assert.deepEqual(r.rejected, [{ channel: 'tilt', operation: 'hold', reason: 'priority-blocked' }]);
  assert.deepEqual(r.writes, {});
  assert.deepEqual(bridge.tick(1000).writes, {});
  assert.deepEqual(bridge.snapshot().channels, []);
  assert.deepEqual(calls.stop, []);
});

test('R4 缺 admitGesture 依赖 → fail-closed timeline-unavailable', () => {
  const { deps } = makeDeps({ admitGesture: null });
  const bridge = createCueBridge(deps);
  const r = bridge.admit(hold('tilt', 0.5));
  assert.equal(r.accepted, false);
  assert.equal(r.rejected[0].reason, 'timeline-unavailable');
  assert.deepEqual(bridge.snapshot().channels, []);
});

test('R5 clear 按 channel：stopGesture(group) 收窄 + 写值清空', () => {
  const { deps, calls } = makeDeps();
  const bridge = createCueBridge(deps);
  bridge.admit(hold('tilt', 0.5));
  bridge.admit(hold('gaze', 1));
  const r = bridge.admit({ channel: 'tilt', operation: 'clear' });
  assert.equal(r.accepted, true);
  assert.deepEqual(calls.stop, [{ group: 'cue:tilt' }]);
  assert.deepEqual(bridge.tick(1000).writes, { ParamEyeBallX: 1, ParamEyeBallY: 1 }, '跨通道保留');
  assert.deepEqual(bridge.snapshot().channels.map((c) => c.channel), ['gaze']);
});

test('R6 overlay 打开/关闭：target 匹配才关闭当前表情层', () => {
  const { deps, calls } = makeDeps({ deps: { knownOverlays: () => ['happy', 'sad'] } });
  const bridge = createCueBridge(deps);
  const on = bridge.admit({ channel: 'gaze', operation: 'overlay', target: 'happy' });
  assert.equal(on.accepted, true);
  assert.deepEqual(calls.setExpression, ['happy']);
  assert.equal(bridge.snapshot().overlay.name, 'happy');

  // target 不匹配：channel 释放但表情保留（clear 的 target 只关同名层）。
  bridge.admit({ channel: 'gaze', operation: 'clear', target: 'sad' });
  assert.equal(calls.clearExpression, 0);
  assert.equal(bridge.snapshot().overlay?.name, 'happy');

  bridge.admit({ channel: 'gaze', operation: 'overlay', target: 'happy' });
  bridge.admit({ channel: 'gaze', operation: 'clear', target: 'happy' });
  assert.equal(calls.clearExpression, 1);
  assert.equal(bridge.snapshot().overlay, null);
});

test('R7 overlay 未知表情（setExpression=false）→ 拒整条且零落账', () => {
  const { deps } = makeDeps({ setExpressionResult: false });
  const bridge = createCueBridge(deps);
  const r = bridge.admit({ channel: 'gaze', operation: 'overlay', target: 'angry' });
  assert.equal(r.accepted, false);
  assert.equal(r.rejected[0].reason, 'unknown-overlay');
  assert.equal(bridge.snapshot().overlay, null);
});

test('R8 overlay 到期：clearExpression + expiredOverlay', () => {
  const { deps, calls, clock } = makeDeps();
  const bridge = createCueBridge(deps);
  bridge.admit({ channel: 'gaze', operation: 'overlay', target: 'happy', durationMs: 300 });
  assert.equal(calls.clearExpression, 0);
  const frame = bridge.tick(clock.now + 299);
  assert.equal(frame.expiredOverlay, null);
  const expired = bridge.tick(clock.now + 300);
  assert.equal(expired.expiredOverlay, 'happy');
  assert.equal(calls.clearExpression, 1);
  assert.equal(bridge.snapshot().overlay, null);
});

test('R9 hold 到期：到期帧起不写值 + 停租约', () => {
  const { deps, calls, clock } = makeDeps();
  const bridge = createCueBridge(deps);
  bridge.admit(hold('tilt', 0.5, { durationMs: 500 }));
  assert.deepEqual(bridge.tick(clock.now + 499).writes, { AngleZ: 7.5 });
  const at = bridge.tick(clock.now + 500);
  assert.deepEqual(at.writes, {});
  assert.deepEqual(at.expiredChannels, ['tilt']);
  assert.deepEqual(calls.stop, [{ group: 'cue:tilt' }]);
});

test('R10 同通道替换：账本单槽、写值后来者、时间线收到第二段', () => {
  const { deps, calls } = makeDeps();
  const bridge = createCueBridge(deps);
  bridge.admit(hold('tilt', 0.5));
  bridge.admit(hold('tilt', -0.5), { runId: 'r2' });
  assert.equal(calls.admit.length, 2, '两次都走时间线准入（替换由 enqueueGesture 判定）');
  assert.equal(bridge.snapshot().channels.length, 1);
  assert.deepEqual(bridge.tick(1000).writes, { AngleZ: -7.5 });
  assert.equal(bridge.snapshot().channels[0].runId, 'r2');
});

test('R11 stop(selector)：按 channel 收窄释放 + 停对应租约', () => {
  const { deps, calls } = makeDeps();
  const bridge = createCueBridge(deps);
  bridge.admit(hold('tilt', 0.5));
  bridge.admit(hold('lean', 0.1));
  const out = bridge.stop({ channel: 'tilt' });
  assert.deepEqual(out.releasedChannels, ['tilt']);
  assert.deepEqual(calls.stop, [{ group: 'cue:tilt' }]);
  assert.deepEqual(bridge.tick(1000).writes, { LeanInput: 3 });
});

test('R12 被拒批次不污染后续：第二次合法 cue 正常落账', () => {
  let n = 0;
  const { deps } = makeDeps({
    gate: () => {
      n++;
      return n === 1
        ? { admitted: false, rejected: [{ id: 'cue:tilt:hold', reason: 'priority-blocked' }] }
        : { admitted: true, entryId: 'ok' };
    },
  });
  const bridge = createCueBridge(deps);
  assert.equal(bridge.admit(hold('tilt', 0.5)).accepted, false);
  assert.equal(bridge.admit(hold('tilt', 0.25)).accepted, true);
  assert.deepEqual(bridge.tick(1000).writes, { AngleZ: 3.75 });
  // cue 词表与 core 同源：写值域只有一个定义。
  assert.ok(CUE_SEED_BINDINGS.some((b) => b.channel === 'tilt'));
});

test('R13 口型红线：cue 通道映射到口型参数 → 准入期拒绝（不落账、零写值）', () => {
  const { deps, calls } = makeDeps({
    bindings: [{ channel: 'mouth', params: { ParamMouthOpenY: { scale: 1 } } }],
    isMouthParam: (id) => id === 'ParamMouthOpenY',
  });
  const bridge = createCueBridge(deps);
  const r = bridge.admit(hold('mouth', 1));
  assert.equal(r.accepted, false);
  assert.deepEqual(r.rejected, [{ channel: 'mouth', operation: 'hold', reason: 'mouth-param' }]);
  assert.deepEqual(calls.admit, [], '口型红线先于时间线准入');
  assert.deepEqual(calls.write, []);
  assert.deepEqual(bridge.tick(1000).writes, {});
});

test('R14 物理输出未授权：own 失败 → 拒整条（不写、不落账）', () => {
  const { deps, calls } = makeDeps({
    bindings: [{ channel: 'arm', params: { RArm: { scale: 1 } } }],
    isPhysicsOutput: (id) => id === 'RArm',
    ownParams: () => [],
  });
  const bridge = createCueBridge(deps);
  const r = bridge.admit(hold('arm', 1));
  assert.equal(r.accepted, false);
  assert.deepEqual(r.rejected, [{ channel: 'arm', operation: 'hold', reason: 'physics-output-not-owned' }]);
  assert.deepEqual(calls.admit, [], '未授权物理写不进入时间线');
  assert.deepEqual(calls.write, []);
  assert.deepEqual(bridge.tick(1000).writes, {});
});

test('R15 物理输出经 own 后写入；clear 释放认领', () => {
  const { deps, calls } = makeDeps({
    bindings: [{ channel: 'arm', params: { RArm: { scale: 1 } } }],
    isPhysicsOutput: (id) => id === 'RArm',
  });
  const bridge = createCueBridge(deps);
  const r = bridge.admit(hold('arm', 0.5, { durationMs: 600 }));
  assert.equal(r.accepted, true);
  assert.deepEqual(calls.own, ['RArm'], '写前先认领');
  const frame = bridge.tick(1000);
  assert.deepEqual(frame.writes, { RArm: 0.5 });
  assert.deepEqual(frame.applied, ['RArm']);

  bridge.admit({ channel: 'arm', operation: 'clear' });
  assert.deepEqual(calls.release, ['RArm'], 'clear 释放物理认领');
});

test('R16 注入端口拒绝：skipped 语义（不静默当成功）', () => {
  const { deps } = makeDeps({
    writeParam: (id) => id !== 'ParamEyeBallY',
  });
  const bridge = createCueBridge(deps);
  bridge.admit(hold('gaze', 1));
  const frame = bridge.tick(1000);
  assert.deepEqual(frame.writes, { ParamEyeBallX: 1, ParamEyeBallY: 1 });
  assert.deepEqual(frame.applied, ['ParamEyeBallX']);
  assert.deepEqual(frame.skipped, ['ParamEyeBallY']);
});

test('R17 到期释放物理认领（tick 到期路径）', () => {
  const { deps, calls, clock } = makeDeps({
    bindings: [{ channel: 'arm', params: { RArm: { scale: 1 } } }],
    isPhysicsOutput: (id) => id === 'RArm',
  });
  const bridge = createCueBridge(deps);
  bridge.admit(hold('arm', 0.5, { durationMs: 300 }));
  const at = bridge.tick(clock.now + 300);
  assert.deepEqual(at.expiredChannels, ['arm']);
  assert.deepEqual(calls.release, ['RArm']);
});

console.log('cue-bridge: ' + passed + ' tests passed');
