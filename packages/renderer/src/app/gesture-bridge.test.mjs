/**
 * Gesture Bridge 测试（M1-d2 测试矩阵 M1-M6 / R1）。
 *
 * deps 全部 mock（计数器断言「零触碰」），不依赖 Cubism/ActGate/injector 真实实现。
 * RArm/Param36 等是测试素材，不允许出现在 src 实现里（bridge 零参数名）。
 *
 * 用例编号 → 蓝图矩阵（docs/M1-D2-IMPLEMENTATION-READY.md §4）：
 *   M1 正向准入 + armed 建立 + 到期解除   M2 Agent 独占拒 NORMAL
 *   M3 FORCE 打断释放 Agent 独占          M4 到期清理（INV-5 / S-05）
 *   M5 Agent 打断（stop 全清硬解除）       M6 同 entryId 重入队 = 同通道替换
 *   R1 flag 关：全拒 + 零触碰（回滚不变式）
 *   收紧项：Agent act 寿命内手势不可同级插入（§5 情形 B，`>` vs `>=`）
 */
import assert from 'node:assert/strict';
import { createGestureBridge } from './gesture-bridge.ts';

let passed = 0;
const test = (name, fn) => {
  fn();
  passed++;
  console.log('  ok  ' + name);
};

/** mock deps：全部依赖可注入并带调用计数（overrides 先铺，currentAct/getAgentOwned 再包计数）。 */
function makeDeps(overrides = {}) {
  const calls = { releaseOwned: [], stopKeyframes: 0, releaseKfOwnership: 0, currentAct: 0, getAgentOwned: 0 };
  const clock = { now: 1000 };
  const deps = {
    enabled: true,
    now: () => clock.now,
    ...overrides,
  };
  const curAct = overrides.currentAct;
  deps.currentAct = () => {
    calls.currentAct++;
    return curAct === undefined ? null : curAct;
  };
  const agentOwned = overrides.agentOwned || [];
  deps.getAgentOwned = () => {
    calls.getAgentOwned++;
    return agentOwned;
  };
  deps.releaseOwned = (ids) => {
    calls.releaseOwned.push(...ids);
    return ids;
  };
  deps.stopKeyframes = () => {
    calls.stopKeyframes++;
  };
  deps.releaseKfOwnership = () => {
    calls.releaseKfOwnership++;
  };
  return { deps, calls, clock };
}

const kfSeg = (extra = {}) => ({
  id: 'kf:RArm',
  group: 'kf',
  params: { RArm: 0 },
  durationMs: 5000,
  ...extra,
});

test('M1 正向：flag 开无占用，admit(NORMAL) 准入且 armed 建立；到期后 armed 解除并软释放', () => {
  const { deps, calls } = makeDeps();
  const bridge = createGestureBridge(deps);
  const ga = bridge.admit([kfSeg()], { priority: 'NORMAL', now: 1000 });
  assert.equal(ga.admitted, true);
  assert.deepEqual(ga.admittedIds, ['kf:RArm']);
  assert.deepEqual(ga.rejected, []);
  assert.equal(ga.flagEnabled, true);
  const snap1 = bridge.snapshot();
  assert.equal(snap1.enabled, true);
  assert.equal(snap1.armedEntryId, 'kf:RArm', 'armed 建立（admitted 非空即武装）');
  assert.equal(snap1.active.length, 1);
  assert.deepEqual(snap1.active[0].params, ['RArm']);
  // 持有期内 armed 不受 resolve 影响
  bridge.resolve(3000);
  assert.equal(bridge.snapshot().armedEntryId, 'kf:RArm');
  assert.equal(calls.releaseKfOwnership, 0);
  // 到期：INV-5 / S-05（endAt <= now 视为已释放）→ armed 解除 + 软释放兜底
  const frame = bridge.resolve(1000 + 5000 + 301);
  assert.equal(frame.expired.length, 1);
  assert.equal(frame.active.length, 0);
  const snap2 = bridge.snapshot();
  assert.equal(snap2.armedEntryId, null, 'armed 批次全部段被清 → 解除');
  assert.equal(snap2.active.length, 0);
  assert.equal(calls.releaseKfOwnership, 1, '软解除走 releaseKfOwnership');
  assert.equal(calls.stopKeyframes, 0, '到期不是硬解除');
});

test('M2 负向：Agent 独占（无链，NORMAL 档语义）时 admit(NORMAL) 整批拒且零副作用', () => {
  const { deps, calls } = makeDeps({ agentOwned: ['RArm'] });
  const bridge = createGestureBridge(deps);
  const ga = bridge.admit([kfSeg()], { priority: 'NORMAL', now: 1000 });
  assert.equal(ga.admitted, false);
  assert.deepEqual(
    ga.rejected.map((r) => r.reason),
    ['priority-blocked'],
  );
  assert.equal(ga.flagEnabled, true, 'flag 开时「被拒」与「没开」可区分');
  assert.deepEqual(calls.releaseOwned, [], '被拒不释放 Agent 独占');
  assert.equal(calls.stopKeyframes, 0);
  assert.equal(calls.releaseKfOwnership, 0);
  assert.equal(bridge.snapshot().armedEntryId, null, 'armed 未建立');
  assert.equal(bridge.snapshot().active.length, 0, '时间线零变化');
});

test('收紧项：Agent act 链占用槽位时，同级 NORMAL 拒、FORCE 才打断（§5 情形 B）', () => {
  const { deps } = makeDeps({ currentAct: { runId: 7, priority: 50, source: 'act' } });
  const bridge = createGestureBridge(deps);
  const same = bridge.admit([kfSeg()], { priority: 'NORMAL', now: 1000 });
  assert.equal(same.admitted, false, '50 <= 50 → 拒（严格大于才打断）');
  const force = bridge.admit([kfSeg()], { priority: 'FORCE', now: 1100 });
  assert.equal(force.admitted, true, '90 > 50 → 打断准入');
  assert.deepEqual(force.interrupted, [], '链内 keyframes 未登记时无时间线段可打断');
});

test('M3 负向转正向：Agent 独占 + admit(FORCE) → 释放独占后准入（releasedAgentParams 记账）', () => {
  const { deps, calls } = makeDeps({ agentOwned: ['RArm', 'LArm'] });
  const bridge = createGestureBridge(deps);
  const ga = bridge.admit([kfSeg()], { priority: 'FORCE', now: 1000 });
  assert.equal(ga.admitted, true);
  assert.deepEqual(ga.releasedAgentParams, ['RArm'], '只释放本批参数域内的独占');
  assert.deepEqual(calls.releaseOwned, ['RArm']);
  assert.equal(bridge.snapshot().armedEntryId, 'kf:RArm');
});

test('M4 释放：durationMs=300 段入队后 resolve(now+301) → expired 含段、state 清空、armed 解除', () => {
  const { deps, calls } = makeDeps();
  const bridge = createGestureBridge(deps);
  const ga = bridge.admit([{ id: 'kf:RArm', params: { RArm: 0 }, durationMs: 300 }], { now: 1000 });
  assert.equal(ga.admitted, true);
  const frame = bridge.resolve(1301);
  assert.deepEqual(
    frame.expired.map((s) => s.id),
    ['kf:RArm'],
  );
  assert.equal(bridge.snapshot().active.length, 0);
  assert.equal(bridge.snapshot().armedEntryId, null);
  assert.equal(calls.releaseKfOwnership, 1);
});

test('M5 Agent 打断：手势播放中 stop() 全清 → timeline 清空、硬解除（stopKeyframes）', () => {
  const { deps, calls } = makeDeps();
  const bridge = createGestureBridge(deps);
  bridge.admit([kfSeg()], { priority: 'NORMAL', now: 1000 });
  assert.equal(bridge.snapshot().armedEntryId, 'kf:RArm');
  const stopped = bridge.stop();
  assert.deepEqual(
    stopped.map((s) => s.id),
    ['kf:RArm'],
  );
  const snap = bridge.snapshot();
  assert.equal(snap.active.length, 0, 'timeline 清空');
  assert.equal(snap.armedEntryId, null);
  assert.equal(calls.stopKeyframes, 1, '命中 armed → 硬解除');
  assert.equal(calls.releaseKfOwnership, 0, 'stopKeyframes 自带 ownership 释放，不重复软释放');
  // 空时间线全停是 no-op（无 armed 无段）
  bridge.stop();
  assert.equal(calls.stopKeyframes, 1);
});

test('M6 幂等：同 entryId 连续 admit 同段同参数 → 同通道替换，不产生重复段', () => {
  const { deps, clock } = makeDeps();
  const bridge = createGestureBridge(deps);
  const segs = [kfSeg()];
  clock.now = 1000;
  const first = bridge.admit(segs, { entryId: 'E1', now: 1000 });
  assert.equal(first.admitted, true);
  clock.now = 1100;
  const second = bridge.admit(segs, { entryId: 'E1', now: 1100 });
  assert.equal(second.admitted, true);
  assert.deepEqual(
    second.interrupted.map((s) => s.id),
    ['kf:RArm'],
    '首批被 interrupted 替换（WHALEL2D §3.1 同通道替换语义）',
  );
  const snap = bridge.snapshot();
  assert.equal(snap.active.length, 1, 'entryId+id 主键，无重复段');
  assert.equal(snap.armedEntryId, 'E1');
});

test('R1 回归：flag 关 → admit 恒 rejected(disabled)、resolve/stop no-op、deps 零触碰', () => {
  const { deps, calls } = makeDeps({ enabled: false, agentOwned: ['RArm'] });
  const bridge = createGestureBridge(deps);
  const ga = bridge.admit([kfSeg()], { priority: 'FORCE', now: 1000 });
  assert.equal(ga.admitted, false);
  assert.equal(ga.flagEnabled, false);
  assert.deepEqual(
    ga.rejected.map((r) => r.reason),
    ['disabled'],
  );
  const frame = bridge.resolve(2000);
  assert.deepEqual(frame.active, []);
  assert.deepEqual(frame.expired, []);
  assert.deepEqual(bridge.stop(), []);
  assert.equal(calls.currentAct, 0, 'ActGate 零触碰');
  assert.equal(calls.getAgentOwned, 0, 'injector 零触碰');
  assert.equal(calls.releaseOwned.length, 0);
  assert.equal(calls.stopKeyframes, 0);
  assert.equal(calls.releaseKfOwnership, 0);
  const snap = bridge.snapshot();
  assert.equal(snap.enabled, false);
  assert.equal(snap.armedEntryId, null);
});

test('空参数域段（资产型手势）：无冲突并存、不受 ActGate 双查阻挡', () => {
  const { deps } = makeDeps({ currentAct: { runId: 7, priority: 90, source: 'act' } });
  const bridge = createGestureBridge(deps);
  const ga = bridge.admit([{ id: 'asset:bow', params: {} }], { priority: 'NORMAL', now: 1000 });
  assert.equal(ga.admitted, true, '空域段不参与优先级判定（可与 Agent 链并存）');
  assert.equal(bridge.snapshot().armedEntryId, 'asset:bow');
});

test('armedHas：纵深防御 #3 查询面（armed 覆盖参数 → true；解除后 → false）', () => {
  const { deps } = makeDeps();
  const bridge = createGestureBridge(deps);
  bridge.admit([kfSeg()], { now: 1000 });
  assert.equal(bridge.armedHas('RArm'), true);
  assert.equal(bridge.armedHas('LArm'), false);
  bridge.stop();
  assert.equal(bridge.armedHas('RArm'), false);
});

// ---- [M1-d2 真机回归] armed 衔接（admit 登记 ↔ playKeyframes 纵深查询）----
// 真机症状：admit 回执 admitted 非空（如 'kf:LArm'），playKeyframes 却把物理输出轨道
// 全剔（no-valid-tracks）——armed 登记键与 armedHas 查询键失配。以下用例把「衔接」
// 锁死：overlay gestureSegmentsFromTracks 的段形状 admit 后，每个轨道参数必须立即
// 可被 armedHas 背书；armed 解除（到期/stop/打断）后立即失背书。

test('armed 衔接回归：overlay 段形状（kf:+param / group kf / params {[param]:0}）admit 后逐轨道立即背书', () => {
  const { deps } = makeDeps();
  const bridge = createGestureBridge(deps);
  // overlay.js gestureSegmentsFromTracks 的精确输出形状（U7 载荷：LArm / duration 500）
  const segs = [
    { id: 'kf:LArm', group: 'kf', params: { LArm: 0 }, durationMs: 500 },
    { id: 'kf:RArm', group: 'kf', params: { RArm: 0 }, durationMs: 500 },
  ];
  const ga = bridge.admit(segs, { priority: 'NORMAL', now: 1000 });
  assert.equal(ga.admitted, true);
  assert.deepEqual(ga.admittedIds, ['kf:LArm', 'kf:RArm']);
  // playKeyframes 纵深防御 #3 的逐轨道查询：同 tick 立即放行（衔接成立）
  assert.equal(bridge.armedHas('LArm'), true, '登记键（params 键）= 查询键（轨道参数名）');
  assert.equal(bridge.armedHas('RArm'), true);
  // 持有期内每帧 resolve 旁挂不清 armed
  bridge.resolve(1200);
  assert.equal(bridge.armedHas('LArm'), true);
  assert.equal(bridge.armedHas('RArm'), true);
  // 批次到期（duration 500）→ 软解除 → 物理轨道失去背书（P2 语义恢复）
  bridge.resolve(1000 + 500 + 1);
  assert.equal(bridge.armedHas('LArm'), false, '到期后物理轨道无 armed 背书 → 被剔');
  assert.equal(bridge.armedHas('RArm'), false);
});

test('armed 衔接回归：空 params 批（资产型手势）不给任何物理参数背书（P2 不放宽）', () => {
  const { deps } = makeDeps();
  const bridge = createGestureBridge(deps);
  const ga = bridge.admit([{ id: 'asset:bow', params: {} }], { now: 1000 });
  assert.equal(ga.admitted, true);
  assert.equal(bridge.snapshot().armedEntryId, 'asset:bow', 'armed 建立');
  assert.equal(bridge.armedHas('LArm'), false, '空域批不背书任何物理轨道');
  assert.equal(bridge.armedHas('RArm'), false);
});

test('armed 衔接回归：同参数重入队（同通道替换）后新批次立即重新背书', () => {
  const { deps } = makeDeps();
  const bridge = createGestureBridge(deps);
  const seg = (ms) => ({ id: 'kf:LArm', group: 'kf', params: { LArm: 0 }, durationMs: ms });
  assert.equal(bridge.admit([seg(5000)], { entryId: 'E1', now: 1000 }).admitted, true);
  assert.equal(bridge.armedHas('LArm'), true);
  // U9 型：stop 清账 → 背书消失 → 复播再准入后背书恢复
  bridge.stop();
  assert.equal(bridge.armedHas('LArm'), false);
  assert.equal(bridge.admit([seg(5000)], { entryId: 'E2', now: 1100 }).admitted, true, 'stop 后同参数可再准入');
  assert.equal(bridge.armedHas('LArm'), true, '复播批次立即背书（清账无残留）');
  // M6 型：同 entryId 重入队替换 → armed 归属新批次，参数键不变
  assert.equal(bridge.admit([seg(5000)], { entryId: 'E2', now: 1200 }).admitted, true);
  assert.equal(bridge.armedHas('LArm'), true);
});

test('armed 衔接回归：armed 批次被更高批打断 → 硬解除 → 原批独有参数立即失背书，新批参数立即获背书', () => {
  const { deps, calls } = makeDeps();
  const bridge = createGestureBridge(deps);
  // 旧批 E1：RArm + LArm 两参数域
  assert.equal(
    bridge.admit(
      [
        { id: 'kf:RArm', group: 'kf', params: { RArm: 0 }, durationMs: 5000 },
        { id: 'kf:LArm', group: 'kf', params: { LArm: 0 }, durationMs: 5000 },
      ],
      { entryId: 'E1', now: 1000 },
    ).admitted,
    true,
  );
  assert.equal(bridge.armedHas('RArm'), true);
  assert.equal(bridge.armedHas('LArm'), true);
  // FORCE 批只声明 RArm：冲突域重叠 → E1 整批 interrupted → armed 硬解除并归属新批
  const ga2 = bridge.admit([{ id: 'kf:RArm', group: 'kf', params: { RArm: 0 }, durationMs: 5000 }], {
    priority: 'FORCE',
    now: 1100,
  });
  assert.equal(ga2.admitted, true);
  assert.equal(bridge.armedHas('LArm'), false, '旧批（E1）被清 → 其独有参数失背书');
  assert.equal(bridge.armedHas('RArm'), true, 'armed 归属新批，RArm 由新批背书');
  assert.equal(calls.stopKeyframes, 1, '打断 armed 批 → 硬解除');
});

console.log('gesture-bridge: ' + passed + ' tests passed');
