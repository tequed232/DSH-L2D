/**
 * Continuous Action Mixer 测试（docs/Embodied-Behavior.md §8 M1-e 行 / §9 测试契约）。
 *
 * 用例编号 CA-xx 与验收清单对照：
 *   CA-01/02 → flag 关 = 基线：提交全拒、resolve 恒空、状态零变化（M1-e 回滚要求）
 *   CA-03    → Idle 与 Ambient 同时存在的仲裁（lane 秩：ambient > idle，参数域逐参数判定）
 *   CA-04/05 → Media 启动/暂停/结束状态转换；媒体互斥（media 准入释放 ambient 存量）
 *   CA-06/07 → Agent 动作打断 Idle 后的恢复（挂起保留状态，恢复不重启；hold 期新提交拒绝）
 *   CA-08/09 → 连续动作重复提交幂等（同源同参数 = refresh 无操作；不同参数 = update 不重启）
 *   CA-10/11 → 高频状态变化下的稳定性（媒体抖动：参数交替 update 单条目；冷却窗口挡重启）
 *   CA-12    → 组合仲裁：连续层 intent（source continuous/ambient，秩 1）被 Agent motion
 *              intent（秩 2）压制；limb-owned Hip* 连续写入被 resolveWritePlan 拒绝
 *              （M1-b 所有权不回退，embodied.m1 + m1e 组合的 core 侧证据）
 *   CA-13    → 到期清理（gesture-timeline INV-5 同语义）与确定性（INV-8 同型：顺序无关）
 *
 * fixture 里的 AngleZ/PositionX/HipAngleX 等是测试素材，不允许出现在 src 实现里。
 * 运行：node --experimental-strip-types packages/core/test/continuous-action.ts
 */
import assert from 'node:assert/strict';
import {
  M1E_DEFAULT_ENABLED,
  CONTINUOUS_PRIORITY,
  CONTINUOUS_LANE_RANK,
  emptyContinuous,
  submitContinuous,
  setContinuousAgentHold,
  tickContinuous,
  releaseContinuous,
  resolveContinuous,
} from '../src/continuous-action.ts';
import { resolveWritePlan } from '../src/write-plan.ts';
import type { ContinuousSubmitRequest, ContinuousState } from '../src/continuous-action.ts';

let passed = 0;
const test = (name: string, fn: () => void) => {
  try {
    fn();
    passed++;
    console.log('  ok  ' + name);
  } catch (err) {
    console.error('  FAIL ' + name);
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
};

console.log('\nM1-e 连续动作 Mixer 测试\n');

const ON = { enabled: true } as const;
const req = (id: string, lane: ContinuousSubmitRequest['lane'], extra: Partial<ContinuousSubmitRequest> = {}): ContinuousSubmitRequest =>
  ({ id, lane, ...extra });

const entryOf = (state: ContinuousState, id: string) => state.entries.find((e) => e.id === id);

// ---------------------------------------------------------------- flag 关 = 基线

test('CA-01 flag 缺省 false：提交 disabled、resolve 恒空、agent hold 空操作', () => {
  assert.equal(M1E_DEFAULT_ENABLED, false, 'M1-e 默认关闭（回滚要求）');
  const s0 = emptyContinuous();
  const r = submitContinuous(s0, req('media:sway', 'media', { params: { AngleZ: 5.5 } }), 1000);
  assert.equal(r.decision, 'disabled');
  assert.deepEqual(r.state, s0, 'flag 关提交零状态变化');

  const h = setContinuousAgentHold(s0, { runId: 'agent', scope: 'all', priority: 90, expiresAt: null }, 1000);
  assert.deepEqual(h.state, s0, 'flag 关 hold 零状态变化');
  assert.deepEqual(resolveContinuous(s0, 1000).writes, [], 'flag 关 resolve 恒空');

  const tk = tickContinuous(s0, 999999, { enabled: false });
  assert.deepEqual(tk.expired, [], 'flag 关 tick 空操作');
  const rel = releaseContinuous(s0, undefined, { enabled: false });
  assert.deepEqual(rel.stopped, [], 'flag 关 release 空操作');
});

test('CA-02 flag 显式 false 与缺省一致；开启路径不受 flag 关污染', () => {
  const s0 = emptyContinuous();
  const off = submitContinuous(s0, req('idle:drift', 'idle'), 1000, { enabled: false });
  assert.equal(off.decision, 'disabled');
  const on = submitContinuous(off.state, req('idle:drift', 'idle'), 1100, ON);
  assert.equal(on.decision, 'started', '同一状态上显式开启即正常准入');
  assert.equal(on.entry!.priority, CONTINUOUS_PRIORITY, '连续层固定 BACKGROUND 10');
  assert.equal(on.entry!.runId, 'idle:drift', 'runId = origin id（稳定身份）');
});

// ---------------------------------------------------------------- Idle × Ambient 仲裁

test('CA-03 Idle 与 Ambient 同时存在：参数域重叠处 ambient 胜出，非重叠参数 idle 照常输出', () => {
  let s = emptyContinuous();
  s = submitContinuous(s, req('idle:drift', 'idle', { params: { AngleZ: 1, PositionY: 2 } }), 1000, ON).state;
  const amb = submitContinuous(s, req('ambient:tilt', 'ambient', { params: { AngleZ: 3 } }), 1050, ON);
  assert.equal(amb.decision, 'started', 'ambient 与 idle 并存（lane 秩只在重叠参数上裁决）');

  const res = resolveContinuous(amb.state, 1100, ON);
  const idle = res.writes.find((w) => w.id === 'idle:drift');
  const tilt = res.writes.find((w) => w.id === 'ambient:tilt');
  assert.ok(idle && tilt, '两条都活跃');
  assert.deepEqual(Object.keys(idle.params).sort(), ['PositionY'], 'idle 的 AngleZ 被高位 lane 压制，PositionY 保留');
  assert.deepEqual(tilt.params, { AngleZ: 3 });
  assert.equal(CONTINUOUS_LANE_RANK.ambient, 2);
  assert.equal(CONTINUOUS_LANE_RANK.idle, 1);
});

test('CA-03b 空域条目（idle 漂移）不与任何 lane 冲突，可并存', () => {
  let s = emptyContinuous();
  s = submitContinuous(s, req('media:sway', 'media', { params: { AngleZ: 5.5 } }), 1000, ON).state;
  const r = submitContinuous(s, req('idle:drift', 'idle', { params: {} }), 1050, ON);
  assert.equal(r.decision, 'started', '空域不构成冲突');
  assert.equal(resolveContinuous(r.state, 1100, ON).active.length, 2);
});

// ---------------------------------------------------------------- Media 状态转换

test('CA-04 Media 启动/刷新/结束：started → refresh → release → 再启动', () => {
  let s = emptyContinuous();
  const start = submitContinuous(s, req('media:sway', 'media', { params: { AngleZ: 5.5 } }), 1000, ON);
  assert.equal(start.decision, 'started');
  assert.equal(start.entry!.endAt, null, '缺省长期持有');

  const refresh = submitContinuous(start.state, req('media:sway', 'media', { params: { AngleZ: 5.5 } }), 1100, ON);
  assert.equal(refresh.decision, 'refresh', '同源同参数 = 无操作刷新');
  assert.equal(refresh.entry!.startedAt, 1000, '不重启：startedAt 不变');
  assert.equal(refresh.entry!.runId, start.entry!.runId);
  assert.equal(refresh.entry!.refreshedAt, 1100);

  const stop = releaseContinuous(refresh.state, { id: 'media:sway' }, { enabled: true, now: 1200 });
  assert.deepEqual(stop.stopped.map((e) => e.id), ['media:sway']);
  assert.deepEqual(resolveContinuous(stop.state, 1250, ON).writes, [], '结束即释放（R7/R8）');

  const again = submitContinuous(stop.state, req('media:sway', 'media', { params: { AngleZ: 5.5 } }), 2000, ON);
  assert.equal(again.decision, 'started', '冷却窗口外可再启动');
});

test('CA-05 媒体互斥：media 准入释放 ambient 存量（基线 stopAmbient 语义）；ambient 撞 media 被拒', () => {
  let s = emptyContinuous();
  s = submitContinuous(s, req('ambient:tilt', 'ambient', { params: { AngleZ: 3 }, durationMs: 2400 }), 1000, ON).state;
  const media = submitContinuous(s, req('media:sway', 'media', { params: { AngleZ: 5.5 } }), 1100, ON);
  assert.equal(media.decision, 'started');
  assert.deepEqual(media.superseded.map((e) => e.id), ['ambient:tilt'], 'media 准入即释放 ambient（基线语义）');
  assert.ok(!entryOf(media.state, 'ambient:tilt'), 'ambient 条目已出时间线');
  assert.ok(media.state.releasedAt['ambient:tilt'] !== undefined, '释放时刻入冷却记账');

  const blocked = submitContinuous(media.state, req('ambient:puff', 'ambient', { params: { CheeckPuff: 0.45 } }), 1200, ON);
  assert.equal(blocked.decision, 'rejected');
  assert.equal(blocked.reason, 'media-active', '媒体活跃期间 ambient 提交被拒');
});

// ---------------------------------------------------------------- Agent 打断与恢复

test('CA-06 Agent 打断 Idle：hold 期挂起（保留状态不 kill），清除后原地恢复（恢复不重启）', () => {
  let s = emptyContinuous();
  s = submitContinuous(s, req('idle:drift', 'idle', { params: {} }), 1000, ON).state;
  s = submitContinuous(s, req('ambient:shift', 'ambient', { params: { PositionX: 5 }, durationMs: 2400 }), 1020, ON).state;

  const hold = setContinuousAgentHold(s, { runId: 'act-1', scope: ['idle', 'ambient'], priority: 50, expiresAt: null }, 1100, ON);
  assert.deepEqual(hold.suspended.map((e) => e.id).sort(), ['ambient:shift', 'idle:drift']);
  const during = resolveContinuous(hold.state, 1200, ON);
  assert.deepEqual(during.writes, [], 'hold 期连续层零写入（Agent 控制权完整）');
  assert.equal(during.suspended.length, 2, '条目保留（挂起 ≠ 释放）');

  const release = setContinuousAgentHold(hold.state, null, 2000, ON);
  assert.deepEqual(release.resumed.map((e) => e.id).sort(), ['ambient:shift', 'idle:drift']);
  const idle = entryOf(release.state, 'idle:drift')!;
  assert.equal(idle.startedAt, 1000, '恢复不重启：startedAt/runId 原样');
  assert.equal(idle.runId, 'idle:drift');
  assert.equal(resolveContinuous(release.state, 2050, ON).writes.length, 2);
});

test('CA-06b FORCE hold 与 BACKGROUND 连续层同档也压制；hold 到期自动失效', () => {
  let s = emptyContinuous();
  s = submitContinuous(s, req('idle:drift', 'idle', { params: {} }), 1000, ON).state;
  // Agent 最低档（10）与连续层同档：仍压制（连续层永不抢占 Agent）
  const h = setContinuousAgentHold(s, { runId: 'a', scope: 'all', priority: 10, expiresAt: 1500 }, 1100, ON);
  assert.deepEqual(resolveContinuous(h.state, 1200, ON).writes, []);
  // hold 到期（expiresAt <= now）→ 自动失效，连续层恢复
  const after = resolveContinuous(h.state, 1500, ON);
  assert.deepEqual(after.suspended, []);
  assert.equal(after.writes.length, 1, 'hold 到期即恢复');
});

test('CA-07 hold 期间新提交被拒（agent-held），不产生任何条目', () => {
  let s = emptyContinuous();
  s = setContinuousAgentHold(s, { runId: 'a', scope: ['ambient'], priority: 90, expiresAt: null }, 1000, ON).state;
  const r = submitContinuous(s, req('ambient:tilt', 'ambient', { params: { AngleZ: 3 } }), 1050, ON);
  assert.equal(r.decision, 'rejected');
  assert.equal(r.reason, 'agent-held');
  assert.deepEqual(r.state.entries, [], '零副作用');
  // media 不在 scope：不受影响（基线：媒体律动在拖拽期间持续）
  const m = submitContinuous(s, req('media:sway', 'media', { params: { AngleZ: 5.5 } }), 1050, ON);
  assert.equal(m.decision, 'started');
});

// ---------------------------------------------------------------- 幂等与抖动

test('CA-08 连续动作重复提交幂等：100 次同源同参数提交 = 单条目、startedAt 不变、零打断', () => {
  let s = emptyContinuous();
  const first = submitContinuous(s, req('media:sway', 'media', { params: { AngleZ: 5.5 } }), 1000, ON);
  s = first.state;
  for (let i = 0; i < 100; i++) {
    const r = submitContinuous(s, req('media:sway', 'media', { params: { AngleZ: 5.5 } }), 1000 + i, ON);
    assert.equal(r.decision, 'refresh');
    assert.equal(r.entry!.startedAt, 1000, '不重启');
    assert.equal(r.state.entries.length, 1, '单条目');
    s = r.state;
  }
  const res = resolveContinuous(s, 1100, ON);
  assert.equal(res.active.length, 1);
  assert.equal(res.active[0].startedAt, 1000);
});

test('CA-09 同源不同参数 = update 原地替换（不 kill + restart），可顺延 endAt', () => {
  let s = emptyContinuous();
  const first = submitContinuous(s, req('media:sway', 'media', { params: { AngleZ: 5.5 }, durationMs: 1000 }), 1000, ON);
  s = first.state;
  const upd = submitContinuous(s, req('media:sway', 'media', { params: { AngleZ: 4 }, durationMs: 5000 }), 1100, ON);
  assert.equal(upd.decision, 'update');
  assert.equal(upd.entry!.startedAt, 1000, '身份不变');
  assert.deepEqual(upd.entry!.params, { AngleZ: 4 }, '参数原地替换');
  assert.equal(upd.entry!.endAt, 6100, '显式 durationMs 顺延 endAt（刷新语义）');
  // 不给 durationMs 的 update：endAt 保持
  const keep = submitContinuous(upd.state, req('media:sway', 'media', { params: { AngleZ: 3 } }), 1200, ON);
  assert.equal(keep.entry!.endAt, 6100);
});

test('CA-10 高频媒体抖动：on/off/on 交替 + 参数交替，状态稳定为单条目无重启', () => {
  let s = emptyContinuous();
  let startedAt = 0;
  for (let i = 0; i < 50; i++) {
    const now = 1000 + i * 10;
    const params = { AngleZ: i % 2 === 0 ? 5.5 : 4.5 };
    const r = submitContinuous(s, req('media:sway', 'media', { params }), now, ON);
    assert.ok(r.decision === 'started' || r.decision === 'refresh' || r.decision === 'update');
    if (i === 0) startedAt = r.entry!.startedAt;
    else assert.equal(r.entry!.startedAt, startedAt, '抖动期间不重启');
    s = r.state;
  }
  assert.equal(s.entries.length, 1, '高频提交收敛为单条目');
  const res = resolveContinuous(s, 1600, ON);
  assert.equal(res.active.length, 1);
  assert.equal(res.active[0].params.AngleZ, 4.5, '最后参数生效');
});

test('CA-11 冷却窗口：释放后 readmitCooldownMs 内重提交拒绝（cooldown），窗口外放行', () => {
  let s = emptyContinuous();
  s = submitContinuous(s, req('media:sway', 'media', { params: { AngleZ: 5.5 } }), 1000, ON).state;
  s = releaseContinuous(s, { id: 'media:sway' }, { enabled: true, now: 1100 }).state;
  const early = submitContinuous(s, req('media:sway', 'media', { params: { AngleZ: 5.5 } }), 1150, ON, );
  // 未给 cooldown 选项（缺省 0）→ 立即放行（语义由调用方决定）
  assert.equal(early.decision, 'started', '缺省无冷却');

  let s2 = emptyContinuous();
  s2 = submitContinuous(s2, req('media:sway', 'media', { params: { AngleZ: 5.5 } }), 1000, ON).state;
  s2 = releaseContinuous(s2, { id: 'media:sway' }, { enabled: true, now: 1100 }).state;
  const blocked = submitContinuous(s2, req('media:sway', 'media', { params: { AngleZ: 5.5 } }), 1200, { enabled: true, readmitCooldownMs: 250 });
  assert.equal(blocked.decision, 'rejected');
  assert.equal(blocked.reason, 'cooldown', '250ms 冷却内的重提交被挡（抖动不重启）');
  const later = submitContinuous(blocked.state, req('media:sway', 'media', { params: { AngleZ: 5.5 } }), 1400, { enabled: true, readmitCooldownMs: 250 });
  assert.equal(later.decision, 'started', '窗口外放行');
});

// ---------------------------------------------------------------- 与 M1-b/M1-c 组合（所有权不回退）

test('CA-12 组合仲裁：连续层 intent 被 Agent motion 压制；limb-owned Hip* 连续写入被 resolveWritePlan 拒绝', () => {
  // 连续层写声明 → 降级为 source 'continuous'（INV-6 秩 1）的 WriteIntent
  const s = submitContinuous(
    emptyContinuous(),
    req('media:sway', 'media', { params: { AngleZ: 5.5 } }),
    1000,
    ON,
  );
  const res = resolveContinuous(s.state, 1000, ON);
  const continuousIntent = {
    id: 'continuous:media:sway',
    source: 'continuous' as const,
    priority: CONTINUOUS_PRIORITY,
    phase: 'pre' as const,
    params: { ...res.writes[0].params },
  };
  // Agent motion intent（秩 2）同帧写同一参数 → Agent 胜出
  // （physics 只传独占/让位参数；AngleZ 无 physics 值时 intent 正常参与仲裁）。
  const agentIntent = {
    id: 'agent:motion',
    source: 'motion' as const,
    priority: 50,
    phase: 'pre' as const,
    params: { AngleZ: 10 },
  };
  const plan = resolveWritePlan({
    now: 1000,
    intents: [continuousIntent, agentIntent],
    physics: {},
  });
  const angle = plan.writes.find((w) => w.id === 'AngleZ');
  assert.ok(angle);
  assert.equal(angle.source, 'motion', 'Agent motion（秩 2）压制连续层（秩 1）——Agent 不被抢占');

  // Hip*：limb 独占期间连续层写入 → not-owned（M1-b 所有权不回退）
  const hipPlan = resolveWritePlan({
    now: 1000,
    intents: [{
      id: 'continuous:bad',
      source: 'continuous' as const,
      priority: CONTINUOUS_PRIORITY,
      phase: 'pre' as const,
      params: { HipAngleX: 1 },
    }],
    ownership: { HipAngleX: { owner: 'limb', runId: 'limb-run', phase: 'pre' } },
    physics: { HipAngleX: 0 },
  });
  assert.deepEqual(
    hipPlan.rejected.filter((r) => r.reason === 'not-owned').map((r) => r.id),
    ['HipAngleX'],
    '连续层不得触碰 limb-owned Hip* pre 通道',
  );
  // M1-b 物理让位：limb 独占期间 HipAngleX 无 physics 兜底写（物理让位给 Agent/limb，
  // renderer physics-yield 同语义），连续层写入也进不来。
  assert.ok(!hipPlan.writes.some((w) => w.id === 'HipAngleX'), '独占期间 HipAngleX 物理让位');
});

// ---------------------------------------------------------------- 到期清理与确定性

test('CA-13 到期清理（INV-5 同语义）与确定性（INV-8 同型：提交顺序无关、稳定排序）', () => {
  let s = emptyContinuous();
  const r1 = submitContinuous(s, req('ambient:tilt', 'ambient', { params: { AngleZ: 3 }, durationMs: 2400 }), 1000, ON);
  const r2 = submitContinuous(r1.state, req('idle:drift', 'idle', { params: {} }), 1020, ON);
  s = r2.state;
  // 到期前活跃（endAt = 1000 + 2400 = 3400，INV-5：endAt <= now 即已释放）
  assert.equal(resolveContinuous(s, 3399, ON).active.length, 2);
  // ambient 到期 → tick 清理并入冷却记账
  const tk = tickContinuous(s, 3401, ON);
  assert.deepEqual(tk.expired.map((e) => e.id), ['ambient:tilt']);
  assert.deepEqual(resolveContinuous(tk.state, 3402, ON).active.map((e) => e.id), ['idle:drift'], '长期持有不自动过期');
  assert.equal(tk.state.releasedAt['ambient:tilt'], 3401);

  // 确定性：任意提交顺序 → 集合与仲裁结果一致（startedAt = 各自提交时刻，是身份的一部分，
  // 交换顺序必然不同——这里锁定的是 id/lane/params 集合与 lane 仲裁输出的等价性）。
  const a = submitContinuous(emptyContinuous(), req('idle:drift', 'idle', { params: { PositionY: 2 } }), 1000, ON);
  const b = submitContinuous(a.state, req('ambient:tilt', 'ambient', { params: { AngleZ: 3 } }), 1050, ON);
  const c = submitContinuous(emptyContinuous(), req('ambient:tilt', 'ambient', { params: { AngleZ: 3 } }), 1000, ON);
  const d = submitContinuous(c.state, req('idle:drift', 'idle', { params: { PositionY: 2 } }), 1050, ON);
  assert.deepEqual(
    b.state.entries.map((e) => [e.id, e.lane, e.params]),
    d.state.entries.map((e) => [e.id, e.lane, e.params]),
  );
  assert.equal(entryOf(b.state, 'idle:drift')!.startedAt, 1000, '各自提交时刻即 startedAt');
  assert.equal(entryOf(d.state, 'idle:drift')!.startedAt, 1050);
  assert.deepEqual(
    resolveContinuous(b.state, 1100, ON).writes,
    resolveContinuous(d.state, 1100, ON).writes,
    'lane 仲裁输出与提交顺序无关',
  );
  assert.deepEqual(
    b.state.entries.map((e) => e.id),
    [...b.state.entries.map((e) => e.id)].sort(),
    '条目按 id 稳定排序',
  );
});

test('CA-14 非法输入 fail-closed：零副作用（INV-9 同型）', () => {
  const s0 = emptyContinuous();
  for (const bad of [
    null,
    { id: '', lane: 'media' },
    { id: 'x', lane: 'bogus' },
    { id: 'x', lane: 'media', params: { AngleZ: Number.NaN } },
    { id: 'x', lane: 'media', durationMs: -1 },
  ]) {
    const r = submitContinuous(s0, bad as unknown as ContinuousSubmitRequest, 1000, ON);
    assert.equal(r.decision, 'rejected');
    assert.equal(r.reason, 'invalid-request');
    assert.deepEqual(r.state, s0, '零副作用');
  }
});

console.log(`\n${passed} passed${process.exitCode ? '（有失败）' : ''}\n`);
if (process.exitCode) process.exit(process.exitCode);
