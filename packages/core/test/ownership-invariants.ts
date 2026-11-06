/**
 * Ownership Invariants 测试（docs/Ownership-Invariants.md §2 INV / §3 用例清单 / §4 状态层）。
 *
 * 三个部分：
 *   A. 跨验：可执行 spec 的 25 用例（tools/ownership-spec/cases.mjs）直接喂本实现，
 *      与 CASE 编号及 INV 覆盖列一一对应（含 shuffle 变体）。
 *   B. INV-01…INV-12 逐条编号单测（命名对齐文档 §2）。
 *   C. 状态层 S-01…S-06（LimbController 状态机 + 与 resolveWritePlan 的联调）。
 *
 * fixture 里的 RArm / Param36 / AngleX 等是测试素材，不允许出现在 src 实现里。
 */
import assert from 'node:assert/strict';
import { resolveWritePlan, M1_DEFAULT_ENABLED } from '../src/write-plan.ts';
import type { OwnershipWriteIntent, ResolveInput, ResolveResult } from '../src/write-plan.ts';
import { LimbController } from '../src/limb-controller.ts';
// cases.mjs 是可执行 spec 的 JS 用例数据（tools/ownership-spec/，无类型声明；只读不写）
// @ts-ignore
import { cases } from '../../../tools/ownership-spec/cases.mjs';

let passed = 0;
const test = (name: string, fn: () => void) => {
  fn();
  passed++;
  console.log('  ok  ' + name);
};

// ---- A. 跨验 tools/ownership-spec 用例（CASE-01…25 → INV 覆盖列） -----------------

const INV_MAP: Record<string, string> = {
  'CASE-01': 'INV-1,3,4',
  'CASE-02': 'INV-3',
  'CASE-03': 'INV-6',
  'CASE-04': 'INV-3',
  'CASE-05': 'INV-3,4,7',
  'CASE-06': 'INV-3',
  'CASE-07': 'INV-7',
  'CASE-08': 'INV-7',
  'CASE-09': 'INV-5',
  'CASE-10': 'INV-4,5',
  'CASE-11': 'INV-2',
  'CASE-12': 'INV-1,3',
  'CASE-13': 'INV-6',
  'CASE-14': 'INV-6,7',
  'CASE-15': 'INV-6',
  'CASE-16': 'INV-6',
  'CASE-17': 'INV-1,6',
  'CASE-18': 'INV-9',
  'CASE-19': 'INV-9',
  'CASE-20': 'INV-10',
  'CASE-21': 'INV-11',
  'CASE-22': 'INV-8',
  'CASE-23': 'INV-12',
  'CASE-24': 'INV-4,6,12',
  'CASE-25': 'INV-7,4',
};

const sortWrites = (list: ResolveResult['writes']) =>
  [...list].sort((a, b) => a.id.localeCompare(b.id) || String(a.source).localeCompare(String(b.source)));
const sortRejected = (list: ResolveResult['rejected']) =>
  [...list].sort((a, b) => (a.id + '|' + a.source + '|' + a.reason).localeCompare(b.id + '|' + b.source + '|' + b.reason));

test('A/CASE-01..25 × spec 用例逐条跨验（' + cases.length + ' 例，覆盖 ' + Object.keys(INV_MAP).length + ' 个编号）', () => {
  for (const c of cases as Array<{ id: string; desc: string; input: any; expect: any; shuffle?: boolean }>) {
    assert.ok(INV_MAP[c.id], c.id + ' 必须在 INV 映射表里（文档编号对齐）');
    const variants: Array<{ name: string; input: any }> = [{ name: 'normal', input: c.input }];
    if (c.shuffle) variants.push({ name: 'shuffled', input: { ...c.input, intents: [...c.input.intents].reverse() } });
    for (const v of variants) {
      const out = resolveWritePlan(v.input);
      assert.deepEqual(sortWrites(out.writes), sortWrites(c.expect.writes || []), c.id + '/' + v.name + ' writes');
      assert.deepEqual(sortRejected(out.rejected), sortRejected(c.expect.rejected || []), c.id + '/' + v.name + ' rejected');
    }
  }
});

// ---- B. INV-01…12 逐条编号 -------------------------------------------------------

const limbIntent = (params: Record<string, number>, extra: Partial<OwnershipWriteIntent> = {}): OwnershipWriteIntent =>
  ({ id: 'i-limb', source: 'limb', priority: 50, phase: 'post', params, runId: 'r1', ...extra });
const srcIntent = (source: OwnershipWriteIntent['source'], params: Record<string, number>, extra: Partial<OwnershipWriteIntent> = {}): OwnershipWriteIntent =>
  ({ id: 'i-' + source, source, priority: 50, phase: 'post', params, ...extra });

test('INV-01 唯一 winner：同参多 intent 只输出一条；全部用例 writes 无重复 id', () => {
  // CASE-17 语义：同 source 两条 → 后者覆盖，前者不出现
  const out = resolveWritePlan({
    now: 1000,
    intents: [srcIntent('keyframes', { Param36: 0.2 }, { id: 'a' }), srcIntent('keyframes', { Param36: 0.5 }, { id: 'b' })],
  });
  assert.deepEqual(out.writes, [{ id: 'Param36', value: 0.5, source: 'keyframes', phase: 'post' }]);
  // 全局：任何用例的 writes 里 id 不得重复
  for (const c of cases as Array<{ id: string; input: any }>) {
    const ids = resolveWritePlan(c.input).writes.map((w) => w.id);
    assert.equal(new Set(ids).size, ids.length, c.id + ' 出现重复 id');
  }
});

test('INV-02 口型禁区：任意 source / 任意 owner（含 limb 独占中）永不放行', () => {
  const gaze = resolveWritePlan({
    now: 1000,
    intents: [srcIntent('gaze', { ParamMouthOpenY: 1 }, { phase: 'pre' })],
    physics: { ParamMouthOpenY: 0.3 },
  });
  assert.deepEqual(gaze.writes, []);
  assert.deepEqual(gaze.rejected, [{ id: 'ParamMouthOpenY', source: 'gaze', reason: 'lipsync' }]);
  // 即使 limb 已 acquire（错误 acquire 假设）也拒绝
  const limb = resolveWritePlan({
    now: 1000,
    intents: [limbIntent({ ParamMouthOpenY: 1 })],
    ownership: { ParamMouthOpenY: { owner: 'limb', runId: 'r1' } },
  });
  assert.deepEqual(limb.writes, []);
  assert.equal(limb.rejected[0].reason, 'lipsync');
  // physics 值兜底也不输出口型
  const idle = resolveWritePlan({ now: 1000, intents: [], physics: { ParamMouthOpen: 0.5 } });
  assert.deepEqual(idle.writes, []);
});

test('INV-03 物理输出仅 limb-owned 可写：未 acquire 拒绝、limb 越界写姿态参数拒绝', () => {
  // CASE-02：未 acquire
  const notAcquired = resolveWritePlan({ now: 1000, intents: [limbIntent({ RArm: 1 })], physics: { RArm: 0.5 } });
  assert.deepEqual(notAcquired.writes, [{ id: 'RArm', value: 0.5, source: 'physics', phase: 'post' }]);
  assert.deepEqual(notAcquired.rejected, [{ id: 'RArm', source: 'limb', reason: 'not-owned' }]);
  // CASE-04：Param36 非四肢白名单，pose 值不被 limb 覆盖
  const poseOverride = resolveWritePlan({
    now: 1000,
    intents: [limbIntent({ Param36: 1 }), srcIntent('pose', { Param36: 0.3 })],
  });
  assert.deepEqual(poseOverride.writes, [{ id: 'Param36', value: 0.3, source: 'pose', phase: 'post' }]);
  assert.deepEqual(poseOverride.rejected, [{ id: 'Param36', source: 'limb', reason: 'not-owned' }]);
  // CASE-06：HipAngleX 未 acquire，limb pre 拒绝，physics 胜出
  const hip = resolveWritePlan({
    now: 1000,
    intents: [limbIntent({ HipAngleX: 5 }, { phase: 'pre' })],
    physics: { HipAngleX: 1 },
  });
  assert.deepEqual(hip.writes, [{ id: 'HipAngleX', value: 1, source: 'physics', phase: 'pre' }]);
});

test('INV-04 独占期间 physics 不产生写入，owner 的 intent 为 winner', () => {
  // CASE-01：limb post 胜出，physics 值被忽略
  const leaf = resolveWritePlan({
    now: 1000,
    intents: [limbIntent({ RArm: 1 })],
    ownership: { RArm: { owner: 'limb', runId: 'r1' } },
    physics: { RArm: 0.2 },
  });
  assert.deepEqual(leaf.writes, [{ id: 'RArm', value: 1, source: 'limb', phase: 'post' }]);
  // CASE-05：Hip pre 胜出，physics 让位
  const hip = resolveWritePlan({
    now: 1000,
    intents: [limbIntent({ HipAngleX: 5 }, { phase: 'pre' })],
    ownership: { HipAngleX: { owner: 'limb', runId: 'r1' } },
    physics: { HipAngleX: 1 },
  });
  assert.deepEqual(hip.writes, [{ id: 'HipAngleX', value: 5, source: 'limb', phase: 'pre' }]);
  // 独占期间无 limb intent → 无写入（physics 让位，物理恢复前不产生 stale winner）
  const silent = resolveWritePlan({ now: 1000, intents: [], ownership: { RArm: { owner: 'limb', runId: 'r1' } }, physics: { RArm: 0.2 } });
  assert.deepEqual(silent.writes, []);
});

test('INV-05 expiresAt <= now 视为已释放（超时兜底），physics 恢复', () => {
  const out = resolveWritePlan({
    now: 1000,
    intents: [limbIntent({ RArm: 1 })],
    ownership: { RArm: { owner: 'limb', runId: 'r1', expiresAt: 500 } },
    physics: { RArm: 0.5 },
  });
  assert.deepEqual(out.writes, [{ id: 'RArm', value: 0.5, source: 'physics', phase: 'post' }]);
  assert.deepEqual(out.rejected, [{ id: 'RArm', source: 'limb', reason: 'not-owned' }]);
  // 边界：expiresAt === now 也算过期
  const boundary = resolveWritePlan({
    now: 1000,
    intents: [limbIntent({ RArm: 1 })],
    ownership: { RArm: { owner: 'limb', runId: 'r1', expiresAt: 1000 } },
    physics: { RArm: 0.5 },
  });
  assert.equal(boundary.writes[0].source, 'physics');
  // runId 不匹配的 release 已生效（ownership 空）→ 同物理恢复（CASE-10 无 winner）
  const released = resolveWritePlan({
    now: 1000,
    intents: [limbIntent({ RArm: 1 }, { runId: 'r1' })],
    ownership: { RArm: { owner: 'limb', runId: 'r2' } },
    physics: { RArm: 0.5 },
  });
  assert.deepEqual(released.writes, []);
});

test('INV-6 同参多 intent：priority desc → source 秩 desc → 同 source last-write-wins', () => {
  // CASE-03：同 priority，limb > keyframes（秩 limb 6 > keyframes 3）
  const limbVsKf = resolveWritePlan({
    now: 1000,
    intents: [limbIntent({ RArm: 1 }), srcIntent('keyframes', { RArm: 2 })],
    ownership: { RArm: { owner: 'limb', runId: 'r1' } },
  });
  assert.equal(limbVsKf.writes[0]!.source, 'limb');
  assert.deepEqual(limbVsKf.rejected, [{ id: 'RArm', source: 'keyframes', reason: 'not-owned' }]);
  // CASE-13：pose > keyframes；CASE-14：pose > motion
  const poseVsKf = resolveWritePlan({
    now: 1000,
    intents: [srcIntent('pose', { Param36: 0.3 }), srcIntent('keyframes', { Param36: 0.6 })],
  });
  assert.equal(poseVsKf.writes[0].source, 'pose');
  const poseVsMotion = resolveWritePlan({
    now: 1000,
    intents: [srcIntent('motion', { Param36: 0.9 }), srcIntent('pose', { Param36: 0.3 })],
  });
  assert.equal(poseVsMotion.writes[0].source, 'pose');
  // CASE-15：FORCE(90) gaze > NORMAL(50) ambient（根输入 pre 相位）
  const forceGaze = resolveWritePlan({
    now: 1000,
    intents: [
      srcIntent('gaze', { AngleX: 1 }, { phase: 'pre', priority: 90 }),
      srcIntent('ambient', { AngleX: 0.5 }, { phase: 'pre', priority: 50 }),
    ],
  });
  assert.deepEqual(forceGaze.writes, [{ id: 'AngleX', value: 1, source: 'gaze', phase: 'pre' }]);
  // CASE-16：BACKGROUND(10) motion < NORMAL(50) pose
  const bgMotion = resolveWritePlan({
    now: 1000,
    intents: [srcIntent('motion', { Param36: 0.9 }, { priority: 10 }), srcIntent('pose', { Param36: 0.3 }, { priority: 50 })],
  });
  assert.equal(bgMotion.writes[0].source, 'pose');
  // CASE-24：同参两个 limb intent 不同 runId → 只当前 runId 胜出
  const runIdBound = resolveWritePlan({
    now: 1000,
    intents: [limbIntent({ RArm: 0.7 }, { runId: 'r1', id: 'i1' }), limbIntent({ RArm: 0.8 }, { runId: 'r2', id: 'i2' })],
    ownership: { RArm: { owner: 'limb', runId: 'r2' } },
  });
  assert.deepEqual(runIdBound.writes, [{ id: 'RArm', value: 0.8, source: 'limb', phase: 'post' }]);
  assert.deepEqual(runIdBound.rejected, [{ id: 'RArm', source: 'limb', reason: 'not-owned' }]);
});

test('INV-7 相位规则：Hip*/根输入只 pre、set 型只 post；ownership.phase 不绕过族约束', () => {
  // CASE-07：Hip 已 acquire 但用 post → wrong-phase，无 winner
  const hipPost = resolveWritePlan({
    now: 1000,
    intents: [limbIntent({ HipAngleX: 5 }, { phase: 'post' })],
    ownership: { HipAngleX: { owner: 'limb', runId: 'r1' } },
    physics: { HipAngleX: 1 },
  });
  assert.deepEqual(hipPost.writes, []);
  assert.deepEqual(hipPost.rejected, [{ id: 'HipAngleX', source: 'limb', reason: 'wrong-phase' }]);
  // CASE-08：叶子四肢已 acquire 但用 pre → wrong-phase
  const leafPre = resolveWritePlan({
    now: 1000,
    intents: [limbIntent({ RArm: 1 }, { phase: 'pre' })],
    ownership: { RArm: { owner: 'limb', runId: 'r1' } },
    physics: { RArm: 0.4 },
  });
  assert.deepEqual(leafPre.writes, []);
  assert.deepEqual(leafPre.rejected, [{ id: 'RArm', source: 'limb', reason: 'wrong-phase' }]);
  // CASE-25：intent 不带 phase → 用 ownership.phase（Hip pre）；带 phase 时以 intent 为权威
  const ownershipPhase = resolveWritePlan({
    now: 1000,
    intents: [{ id: 'i1', source: 'limb', priority: 50, params: { HipAngleX: 5 }, runId: 'r1' }],
    ownership: { HipAngleX: { owner: 'limb', runId: 'r1', phase: 'pre' } },
    physics: { HipAngleX: 1 },
  });
  assert.deepEqual(ownershipPhase.writes, [{ id: 'HipAngleX', value: 5, source: 'limb', phase: 'pre' }]);
  // 绕过防护：ownership.phase 被错误写成 pre（叶子），intent 缺省 → 仍按族约束拒绝
  const bypass = resolveWritePlan({
    now: 1000,
    intents: [{ id: 'i1', source: 'limb', priority: 50, params: { RArm: 1 }, runId: 'r1' }],
    ownership: { RArm: { owner: 'limb', runId: 'r1', phase: 'pre' } },
  });
  assert.deepEqual(bypass.writes, []);
  assert.equal(bypass.rejected[0].reason, 'wrong-phase');
});

test('INV-8 输出与 intents 顺序无关：打乱两次执行 writes 完全相同（按 id 排序）', () => {
  const base: ResolveInput = {
    now: 1000,
    intents: [
      srcIntent('keyframes', { Param36: 0.2 }, { priority: 10, id: 'k1' }),
      srcIntent('pose', { Param36: 0.4 }, { id: 'p1' }),
      limbIntent({ RArm: 0.8 }),
    ],
    ownership: { RArm: { owner: 'limb', runId: 'r1' } },
    physics: { RArm: 0.1, Param39: 0.7 },
  };
  const a = resolveWritePlan(base);
  const b = resolveWritePlan({ ...base, intents: [...base.intents].reverse() });
  const c = resolveWritePlan({ ...base, intents: [base.intents[2]!, base.intents[0]!, base.intents[1]!] });
  assert.deepEqual(a.writes, b.writes);
  assert.deepEqual(a.writes, c.writes);
  assert.deepEqual(a.rejected, b.rejected);
  // 输出已按 id 排序
  const ids = a.writes.map((w) => w.id);
  assert.deepEqual(ids, [...ids].sort((x, y) => x.localeCompare(y)));
});

test('INV-9 数值必须有限；bounds 提供时钳制到 [min,max]', () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const out = resolveWritePlan({ now: 1000, intents: [srcIntent('pose', { Param36: bad })] });
    assert.deepEqual(out.writes, []);
    assert.deepEqual(out.rejected, [{ id: 'Param36', source: 'pose', reason: 'invalid-value' }]);
  }
  const clampedHigh = resolveWritePlan({
    now: 1000,
    intents: [srcIntent('pose', { Param36: 5 })],
    bounds: { Param36: { min: -1, max: 1 } },
  });
  assert.deepEqual(clampedHigh.writes, [{ id: 'Param36', value: 1, source: 'pose', phase: 'post' }]);
  const clampedLow = resolveWritePlan({
    now: 1000,
    intents: [srcIntent('pose', { Param36: -9 })],
    bounds: { Param36: { min: -1, max: 1 } },
  });
  assert.equal(clampedLow.writes[0]!.value, -1);
  // 无 bounds → 原值输出
  const raw = resolveWritePlan({ now: 1000, intents: [srcIntent('pose', { Param36: 5 })] });
  assert.equal(raw.writes[0]!.value, 5);
});

test('INV-10 knownParams 提供时，名单外参数 rejected(unknown-param)', () => {
  const out = resolveWritePlan({
    now: 1000,
    intents: [srcIntent('pose', { NoSuchParam: 1 }), srcIntent('pose', { Param36: 0.3 }, { id: 'i2' })],
    knownParams: ['Param36'],
  });
  assert.deepEqual(out.writes, [{ id: 'Param36', value: 0.3, source: 'pose', phase: 'post' }]);
  assert.deepEqual(out.rejected, [{ id: 'NoSuchParam', source: 'pose', reason: 'unknown-param' }]);
});

test('INV-11 空帧无副作用：空 intents + 空 physics → writes/rejected 全空；有 physics 时仅兜底', () => {
  const empty = resolveWritePlan({ now: 1000, intents: [] });
  assert.deepEqual(empty, { writes: [], rejected: [] });
  const passthrough = resolveWritePlan({ now: 1000, intents: [], physics: { Param39: 0.7 } });
  assert.deepEqual(passthrough.writes, [{ id: 'Param39', value: 0.7, source: 'physics', phase: 'post' }]);
});

test('INV-12 limb 功能关闭：limb intent rejected(not-owned)，physics 恢复（flag 语义）', () => {
  const out = resolveWritePlan({
    now: 1000,
    limbEnabled: false,
    intents: [limbIntent({ RArm: 1 })],
    ownership: { RArm: { owner: 'limb', runId: 'r1' } },
    physics: { RArm: 0.5 },
  });
  assert.deepEqual(out.writes, [{ id: 'RArm', value: 0.5, source: 'physics', phase: 'post' }]);
  assert.deepEqual(out.rejected, [{ id: 'RArm', source: 'limb', reason: 'not-owned' }]);
});

// ---- C. 状态层 S-01…06（LimbController，形状对齐渲染侧 LimbControlLike） ------------

// fixture：叶子四肢 id 来自「模型画像」（这里模拟 W3 注册表给出的 20 个叶子的子集）
const FIXTURE_LEAF_IDS = ['RArm', 'RForearm', 'LArm', 'ShoulderZ'] as const;

/** 渲染侧 LimbControlLike 最小依赖面的结构镜像（packages/renderer/src/app/motion-adapter.ts）。 */
interface LimbControlLike {
  acquire(ids: string[], options?: { priority?: number; runId?: string; phase?: 'pre' | 'post'; durationMs?: number }): string[];
  release(runId?: string): string[];
  resolve(now: number): Map<string, number>;
}

test('形状对齐：LimbController 结构化满足渲染侧 LimbControlLike（acquire→string[] / release→string[] / resolve→Map）', () => {
  const ctl = new LimbController(FIXTURE_LEAF_IDS, { enabled: true, now: () => 1000 });
  const like: LimbControlLike = ctl; // 结构化赋值即契约
  assert.deepEqual(like.acquire(['RArm'], { runId: 'r1' }), ['RArm']);
  assert.deepEqual(like.release('r1'), ['RArm']);
  assert.ok(like.resolve(1000) instanceof Map);
  assert.equal(like.resolve(1000).size, 0);
});

test('S-01 acquire → 同一 runId release → 再 resolve：物理恢复', () => {
  const ctl = new LimbController(FIXTURE_LEAF_IDS, { enabled: true, now: () => 1000 });
  assert.deepEqual(ctl.acquire(['RArm'], { runId: 'r1' }), ['RArm']);
  assert.equal(ctl.ownershipSnapshot().ownership.RArm!.runId, 'r1');
  assert.deepEqual(ctl.release('r1'), ['RArm']);
  assert.equal(ctl.ownershipSnapshot().ownership.RArm, undefined);
  // 联调：ownership 空后 resolveWritePlan 输出 physics
  const plan = resolveWritePlan({ now: 1000, intents: [], ownership: ctl.ownershipSnapshot().ownership, physics: { RArm: 0.4 } });
  assert.deepEqual(plan.writes, [{ id: 'RArm', value: 0.4, source: 'physics', phase: 'post' }]);
});

test('S-02/S-03 ActGate 终态（interrupted / action-done）→ 立即 release，不等超时', () => {
  const ctl = new LimbController(FIXTURE_LEAF_IDS, { enabled: true, now: () => 1000 });
  assert.equal(ctl.acquire(['RArm', 'LArm'], { runId: 'run-a', durationMs: 60000 }).length, 2);
  // interrupted：终态触发 release，超时远未到
  assert.deepEqual(ctl.release('run-a').sort(), ['LArm', 'RArm']);
  assert.equal(ctl.ownershipSnapshot(2000).ownership.RArm, undefined);
  // action-done：新 runId 再走一遍
  ctl.acquire(['RArm'], { runId: 'run-b', durationMs: 60000 });
  assert.deepEqual(ctl.release('run-b'), ['RArm']);
  assert.equal(ctl.size, 0);
  // release() 缺省 runId = 全部释放（reset 语义）
  ctl.acquire(['RArm', 'ShoulderZ'], { runId: 'run-c' });
  assert.deepEqual(ctl.release().sort(), ['RArm', 'ShoulderZ']);
});

test('S-04 FORCE 抢占 NORMAL：低优先级 hold 被释放；NORMAL 反向被 priority-blocked', () => {
  const ctl = new LimbController(FIXTURE_LEAF_IDS, { enabled: true, now: () => 1000 });
  assert.deepEqual(ctl.acquire(['RArm'], { runId: 'normal', priority: 50 }), ['RArm']);
  // 同级可打断（ActGate：低不打断高、同级可）：同 50 接管成功，旧 runId 失去持有
  assert.deepEqual(ctl.acquire(['RArm'], { runId: 'other-normal', priority: 50 }), ['RArm']);
  assert.equal(ctl.ownershipSnapshot().ownership.RArm!.runId, 'other-normal');
  assert.deepEqual(ctl.release('normal'), [], '被接管的旧 runId 已不持有参数');
  // FORCE(90) 抢占成功，旧 runId 的持有被替换
  assert.deepEqual(ctl.acquire(['RArm'], { runId: 'force', priority: 90 }), ['RArm']);
  assert.equal(ctl.ownershipSnapshot().ownership.RArm!.runId, 'force');
  // 低不打断高：NORMAL(50) 抢 FORCE 持有 → priority-blocked
  const blocked = ctl.acquireDetailed(['RArm'], { runId: 'low', priority: 50 });
  assert.deepEqual(blocked.acquired, []);
  assert.deepEqual(blocked.rejected, [{ id: 'RArm', reason: 'priority-blocked' }]);
  assert.equal(ctl.ownershipSnapshot().ownership.RArm!.runId, 'force');
  // 同级 FORCE 仍可打断
  assert.deepEqual(ctl.acquire(['RArm'], { runId: 'force-2', priority: 90 }), ['RArm']);
});

test('S-05 超时兜底：expiresAt 到点 ownershipSnapshot/resolve 自动释放（仅保险路径）', () => {
  const ctl = new LimbController(FIXTURE_LEAF_IDS, { enabled: true, now: () => 1000 });
  ctl.acquire(['RArm'], { runId: 'r1', durationMs: 200 });
  assert.equal(ctl.ownershipSnapshot(1100).ownership.RArm!.runId, 'r1'); // 未到期
  const snap = ctl.ownershipSnapshot(1201); // expiresAt = 1200，已过期
  assert.deepEqual(snap.expired, ['RArm']);
  assert.equal(snap.ownership.RArm, undefined);
  assert.equal(ctl.size, 0);
});

test('S-06 反复 acquire/release 1000 次无泄漏（ownership 表大小回到 0）', () => {
  const ctl = new LimbController(FIXTURE_LEAF_IDS, { enabled: true, now: () => 1000 });
  for (let i = 0; i < 1000; i++) {
    const { runId } = ctl.acquireDetailed(['RArm', 'LArm']);
    ctl.release(runId);
  }
  assert.equal(ctl.size, 0);
  assert.deepEqual(ctl.ownershipSnapshot().ownership, {});
});

test('值路径（LimbControlLike.resolve）：set → resolve(now) 返回持有参数写值，clamp 生效；未 set 空表', () => {
  const ctl = new LimbController(FIXTURE_LEAF_IDS, {
    enabled: true,
    now: () => 1000,
    clamp: (_id, v) => Math.max(-1, Math.min(1, v)), // renderer 注入参数 min/max
  });
  assert.deepEqual(ctl.acquire(['RArm', 'LArm'], { runId: 'r1' }), ['RArm', 'LArm']);
  assert.equal(ctl.resolve(1000).size, 0, '未 set 前无写入（空帧无副作用）');
  const applied = ctl.set('r1', { RArm: 0.8, LArm: 5 });
  assert.deepEqual(applied.applied.sort(), ['LArm', 'RArm']);
  const writes = ctl.resolve(1000);
  assert.equal(writes.get('RArm'), 0.8);
  assert.equal(writes.get('LArm'), 1, '已按 clamp 钩子钳制');
  // 未持有 / 他人 runId / 非有限值的 set 全部忽略
  assert.deepEqual(ctl.set('other', { ShoulderZ: 1 }).ignored, ['ShoulderZ']);
  assert.deepEqual(ctl.set('r1', { Param36: 1 }).ignored, ['Param36']);
  assert.deepEqual(ctl.set('r1', { RArm: Number.NaN }).ignored, ['RArm']);
  // release 后写值消失（回物理）
  ctl.release('r1');
  assert.equal(ctl.resolve(1000).size, 0);
});

test('R10b：isOwnable 谓词过滤非物理输出（rejected(not-ownable)，不算错误）', () => {
  // 谓词由调用方注入（renderer：MotionAdapter.canOwn / physics3 输出表）；fixture 模拟 LArm 非物理输出
  const ctl = new LimbController(FIXTURE_LEAF_IDS, { enabled: true, now: () => 1000, isOwnable: (id) => id !== 'LArm' });
  const r = ctl.acquireDetailed(['RArm', 'LArm'], { runId: 'r1' });
  assert.deepEqual(r.acquired, ['RArm']);
  assert.deepEqual(r.rejected, [{ id: 'LArm', reason: 'not-ownable' }]);
  assert.equal(ctl.ownershipSnapshot().ownership.LArm, undefined);
  assert.equal(ctl.ownershipSnapshot().ownership.RArm!.runId, 'r1');
});

test('联调：controller ownershipSnapshot + limb intent 进 resolveWritePlan → post 胜出；未知 id 拒绝', () => {
  const ctl = new LimbController(FIXTURE_LEAF_IDS, { enabled: true, now: () => 1000 });
  assert.deepEqual(ctl.acquire(['RArm'], { runId: 'r1' }), ['RArm']);
  // 非四肢白名单（姿态参数）不能 acquire：能力驱动，id 名单来自构造参数
  const overreach = ctl.acquireDetailed(['Param36'], { runId: 'r1' });
  assert.deepEqual(overreach.rejected, [{ id: 'Param36', reason: 'unknown-id' }]);

  const snap = ctl.ownershipSnapshot();
  const plan = resolveWritePlan({
    now: 1000,
    intents: [limbIntent({ RArm: 0.8 }, { runId: 'r1' })],
    ownership: snap.ownership,
    physics: { RArm: 0.2 },
  });
  assert.deepEqual(plan.writes, [{ id: 'RArm', value: 0.8, source: 'limb', phase: 'post' }]);
  // release 后回物理
  ctl.release('r1');
  const after = resolveWritePlan({
    now: 1000,
    intents: [limbIntent({ RArm: 0.8 }, { runId: 'r1' })],
    ownership: ctl.ownershipSnapshot().ownership,
    physics: { RArm: 0.2 },
  });
  assert.deepEqual(after.writes, [{ id: 'RArm', value: 0.2, source: 'physics', phase: 'post' }]);
  assert.deepEqual(after.rejected, [{ id: 'RArm', source: 'limb', reason: 'not-owned' }]);
});

test('feature flag：M1_DEFAULT_ENABLED=false；控制器缺省禁用（现行为），显式启用才生效', () => {
  assert.equal(M1_DEFAULT_ENABLED, false);
  const off = new LimbController(FIXTURE_LEAF_IDS);
  assert.equal(off.isEnabled, false);
  assert.deepEqual(off.acquire(['RArm']), []);
  const detailed = off.acquireDetailed(['RArm']);
  assert.deepEqual(detailed.rejected, [{ id: 'RArm', reason: 'disabled' }]);
  assert.equal(off.resolve(9999).size, 0);
  assert.deepEqual(off.ownershipSnapshot(9999), { ownership: {}, expired: [] });
  // 显式启用后行为恢复
  const on = new LimbController(FIXTURE_LEAF_IDS, { enabled: true });
  assert.equal(on.isEnabled, true);
  assert.deepEqual(on.acquire(['RArm']), ['RArm']);
});

if (process.exitCode) console.error('\nownership-invariants 测试失败\n');
else console.log(`\n${passed} passed\n`);
