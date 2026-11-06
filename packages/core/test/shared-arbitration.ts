/**
 * 共享通道仲裁测试（docs/Embodied-Behavior.md §4 C2/C3 / §8 M1-c「LeanInput/表情共享仲裁」）。
 *
 * 用例编号 AR-xx 与文档锚点对照（逐条对齐）：
 *   AR-01    → 无冲突并存（C2/C7 反例：不相关的通道互不干扰）
 *   AR-02    → C2/C7：LeanInput 与 gaze.look_* 双向互斥（含单向声明数据的双向判定）
 *   AR-03    → C3：表情族两两互斥（画像 conflicts 两两声明）
 *   AR-04    → ActGate 同级可打断（canInterruptAct）：同级冲突 → yield（C3 替换语义）
 *   AR-05    → S-04：FORCE 抢 NORMAL → yield
 *   AR-06    → 低不打断高 + 冲突占用可到期 → queue（readyAt = 最大 endsAt）
 *   AR-07    → 低不打断高 + 长期持有 → reject（LimbController priority-blocked 同语义）
 *   AR-08    → C3「拒绝并发同参表情」：同通道重复请求即冲突（同优先级 → yield 替换）
 *   AR-09    → R11 同型 fail-closed：未登记 / status=unknown 通道拒绝
 *   AR-10    → 能力驱动铁律：规则全部读画像 conflicts——换数据结论随之变；
 *              并用真实模型画像（tools/capability-scan 产物，只读）复验 gaze/lean 互斥
 *   AR-11    → `x.*` 通配 conflicts（canExpress 同语义）
 *   AR-12    → INV-5 同型：已到期占用不构成冲突；未提供 now 时不做过期过滤
 * fixture 里的通道 id 是测试素材，src 实现零通道名。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { arbitrateShared } from '../src/shared-arbitration.ts';
import { MOTION_CONTRACT_VERSION } from '../src/motion-contract.ts';
import type { ModelMotionProfile, SemanticControlCapability } from '../src/motion-contract.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let passed = 0;
const test = (name: string, fn: () => void) => {
  fn();
  passed++;
  console.log('  ok  ' + name);
};

const ctrl = (id: string, conflicts: string[], extra: Partial<SemanticControlCapability> = {}): SemanticControlCapability =>
  ({
    id,
    status: 'supported',
    min: -1,
    max: 1,
    neutral: 0,
    confidence: 0.9,
    sourceId: 'fixture-param',
    ...extra,
    conflicts,
  } as SemanticControlCapability);

/** 与 tools/capability-scan 产出的画像同构的 fixture：gaze/lean 双向、表情两两、单向声明对。 */
const fixture: ModelMotionProfile = {
  contractVersion: MOTION_CONTRACT_VERSION,
  modelId: 'fixture',
  adapterId: 'cubism',
  profileRevision: 'r-test',
  controls: [
    ctrl('ext.gaze.look_up', ['ext.body.lean_forward']),
    ctrl('ext.gaze.look_down', ['ext.body.lean_forward']),
    ctrl('ext.body.lean_forward', ['ext.gaze.look_up', 'ext.gaze.look_down', 'ext.gaze.look_left', 'ext.gaze.look_right']),
    // 单向声明对：tail.wag 声明了 ear.twitch，ear.twitch 没声明回来（数据不对称也要双向判定）
    ctrl('ext.tail.wag', ['ext.ear.twitch']),
    ctrl('ext.ear.twitch', []),
    ctrl('ext.expression.圈圈眼', ['ext.expression.屑', 'ext.expression.爱心眼', 'ext.expression.＞＜']),
    ctrl('ext.expression.屑', ['ext.expression.圈圈眼', 'ext.expression.爱心眼', 'ext.expression.＞＜']),
    ctrl('ext.expression.爱心眼', ['ext.expression.圈圈眼', 'ext.expression.屑', 'ext.expression.＞＜']),
    ctrl('ext.expression.＞＜', ['ext.expression.圈圈眼', 'ext.expression.屑', 'ext.expression.爱心眼']),
    ctrl('ext.gesture.chest', []),
    ctrl('ext.debug.probe', ['ext.gaze.*']), // 通配声明（AR-11）
    ctrl('ext.gaze.gone', [], { status: 'unknown', sourceId: undefined, confidence: 0 }), // fail-closed（AR-09）
  ],
  assets: [],
} as ModelMotionProfile;

test('AR-01 无冲突并存：不相关通道 accept，conflicts 为空', () => {
  const r = arbitrateShared(fixture, [{ channelId: 'ext.gesture.chest' }], { channelId: 'ext.gaze.look_up' });
  assert.deepEqual(r, { decision: 'accept', conflicts: [] });
});

test('AR-02 双向互斥（C2/C7）：lean ↔ gaze.look_* 两个方向都判冲突', () => {
  // gaze 侧声明了 lean
  const upVsLean = arbitrateShared(fixture, [{ channelId: 'ext.body.lean_forward' }], { channelId: 'ext.gaze.look_up' });
  assert.equal(upVsLean.conflicts.length, 1);
  assert.equal(upVsLean.conflicts[0].channelId, 'ext.body.lean_forward');
  assert.equal(upVsLean.conflicts[0].via, 'incoming-conflicts');
  // lean 侧声明了 gaze 全族
  const leanVsUp = arbitrateShared(fixture, [{ channelId: 'ext.gaze.look_up' }], { channelId: 'ext.body.lean_forward' });
  assert.equal(leanVsUp.conflicts.length, 1);
  assert.equal(leanVsUp.conflicts[0].channelId, 'ext.gaze.look_up');
  assert.equal(leanVsUp.conflicts[0].via, 'incoming-conflicts');
  // 单向声明数据：两个方向都不得漏判
  const a = arbitrateShared(fixture, [{ channelId: 'ext.ear.twitch' }], { channelId: 'ext.tail.wag' });
  assert.equal(a.conflicts.length, 1, 'incoming 声明方向');
  const b = arbitrateShared(fixture, [{ channelId: 'ext.tail.wag' }], { channelId: 'ext.ear.twitch' });
  assert.equal(b.conflicts.length, 1, '占用方声明方向（current-conflicts）');
  assert.equal(b.conflicts[0].via, 'current-conflicts');
});

test('AR-03 表情族两两互斥（C3）：任意取一对、两个方向都判冲突', () => {
  const pairs: Array<[string, string]> = [
    ['ext.expression.圈圈眼', 'ext.expression.屑'],
    ['ext.expression.屑', 'ext.expression.爱心眼'],
    ['ext.expression.爱心眼', 'ext.expression.＞＜'],
  ];
  for (const [a, b] of pairs) {
    const ab = arbitrateShared(fixture, [{ channelId: a }], { channelId: b });
    assert.equal(ab.conflicts.length, 1, a + ' vs ' + b);
    const ba = arbitrateShared(fixture, [{ channelId: b }], { channelId: a });
    assert.equal(ba.conflicts.length, 1, b + ' vs ' + a);
  }
});

test('AR-04 同级可打断：同优先级冲突 → yield（让位，C3/C5 替换语义）', () => {
  const r = arbitrateShared(
    fixture,
    [{ channelId: 'ext.expression.圈圈眼', priority: 50, endsAt: 9000, runId: 'old' }],
    { channelId: 'ext.expression.屑' },
  );
  assert.equal(r.decision, 'yield');
  assert.deepEqual(r.conflicts, [{ channelId: 'ext.expression.圈圈眼', runId: 'old', priority: 50, endsAt: 9000, via: 'incoming-conflicts' }]);
  assert.equal(r.reason, undefined);
});

test('AR-05 高打低：FORCE incoming 冲突 → 当前占用让位（S-04）', () => {
  const r = arbitrateShared(
    fixture,
    [{ channelId: 'ext.body.lean_forward', priority: 50 }],
    { channelId: 'ext.gaze.look_down', priority: 90 },
  );
  assert.equal(r.decision, 'yield');
  assert.equal(r.conflicts[0].channelId, 'ext.body.lean_forward');
});

test('AR-06 低不打断高 + 冲突占用可到期 → queue，readyAt = 最大 endsAt', () => {
  const r = arbitrateShared(
    fixture,
    [
      { channelId: 'ext.expression.圈圈眼', priority: 90, endsAt: 3000 },
      { channelId: 'ext.expression.屑', priority: 90, endsAt: 5200 },
    ],
    { channelId: 'ext.expression.爱心眼', priority: 10 },
  );
  assert.equal(r.decision, 'queue');
  assert.equal(r.readyAt, 5200);
  assert.equal(r.conflicts.length, 2);
  // 单个冲突占用同样取它的 endsAt
  const single = arbitrateShared(
    fixture,
    [{ channelId: 'ext.expression.圈圈眼', priority: 90, endsAt: 4100 }],
    { channelId: 'ext.expression.屑', priority: 50 },
  );
  assert.equal(single.decision, 'queue');
  assert.equal(single.readyAt, 4100);
});

test('AR-07 低不打断高 + 长期持有 → reject(held-indefinitely)', () => {
  const r = arbitrateShared(
    fixture,
    [{ channelId: 'ext.expression.圈圈眼', priority: 90 }], // 无 endsAt = 长期持有
    { channelId: 'ext.expression.屑', priority: 10 },
  );
  assert.equal(r.decision, 'reject');
  assert.equal(r.reason, 'held-indefinitely');
  // 部分长期持有同样拒绝
  const mixed = arbitrateShared(
    fixture,
    [
      { channelId: 'ext.expression.圈圈眼', priority: 90, endsAt: 3000 },
      { channelId: 'ext.expression.屑', priority: 90, endsAt: null },
    ],
    { channelId: 'ext.expression.爱心眼', priority: 10 },
  );
  assert.equal(mixed.decision, 'reject');
  assert.equal(mixed.reason, 'held-indefinitely');
});

test('AR-08 同通道重复请求（C3 拒绝并发同参）：即冲突，同优先级 → yield 替换', () => {
  const r = arbitrateShared(fixture, [{ channelId: 'ext.expression.屑', endsAt: 9000 }], { channelId: 'ext.expression.屑' });
  assert.equal(r.conflicts[0].via, 'same-channel');
  assert.equal(r.decision, 'yield');
  // ext. 前缀差异视为同一通道
  const bare = arbitrateShared(fixture, [{ channelId: 'expression.屑' }], { channelId: 'ext.expression.屑' });
  assert.equal(bare.conflicts[0].via, 'same-channel');
  // 低优先级重复请求 → queue / reject 规则照常
  const low = arbitrateShared(fixture, [{ channelId: 'ext.expression.屑', priority: 90, endsAt: 7000 }], { channelId: 'ext.expression.屑', priority: 10 });
  assert.equal(low.decision, 'queue');
  assert.equal(low.readyAt, 7000);
});

test('AR-09 fail-closed（R11 同型）：未登记 / unknown 通道拒绝，非法 incoming 拒绝', () => {
  const unknown = arbitrateShared(fixture, [], { channelId: 'ext.expression.不存在' });
  assert.equal(unknown.decision, 'reject');
  assert.equal(unknown.reason, 'unknown-channel');
  const unsupported = arbitrateShared(fixture, [], { channelId: 'ext.gaze.gone' });
  assert.equal(unsupported.decision, 'reject');
  assert.equal(unsupported.reason, 'unsupported-channel');
  const invalid = arbitrateShared(fixture, [], null);
  assert.equal(invalid.decision, 'reject');
  assert.equal(invalid.reason, 'invalid-incoming');
  // 画像缺失 = 全部拒绝（fail-closed，不猜）
  const noProfile = arbitrateShared(null, [], { channelId: 'ext.gaze.look_up' });
  assert.equal(noProfile.decision, 'reject');
  assert.equal(noProfile.reason, 'unknown-channel');
});

test('AR-10 能力驱动铁律：换 conflicts 数据结论随之变；真实画像复验（只读）', () => {
  // 同一通道对，把数据里两边的互斥声明都删掉 → accept（证明不是硬编码）
  const noConflictData: ModelMotionProfile = {
    ...fixture,
    controls: fixture.controls.map((c) =>
      (c.id === 'ext.gaze.look_up' || c.id === 'ext.body.lean_forward' ? ctrl(c.id, []) : c)),
  };
  const r = arbitrateShared(noConflictData, [{ channelId: 'ext.body.lean_forward' }], { channelId: 'ext.gaze.look_up' });
  assert.deepEqual(r, { decision: 'accept', conflicts: [] });
  // 真实模型画像（tools/capability-scan 产物，只读复验：LeanInput 与 gaze.look_* 互斥来自数据）
  const realPath = path.resolve(HERE, '..', '..', '..', 'tools', 'capability-scan', 'profile.大肥鱼.dsl2d.2048.json');
  const real = JSON.parse(fs.readFileSync(realPath, 'utf8')) as ModelMotionProfile;
  const realR = arbitrateShared(real, [{ channelId: 'ext.body.lean_forward' }], { channelId: 'ext.gaze.look_up', priority: 50 });
  assert.equal(realR.conflicts.length, 1);
  assert.equal(realR.conflicts[0].channelId, 'ext.body.lean_forward');
  // 真实画像的表情两两互斥同样来自数据
  const realExp = arbitrateShared(real, [{ channelId: 'ext.expression.圈圈眼', priority: 50 }], { channelId: 'ext.expression.屑', priority: 90 });
  assert.equal(realExp.decision, 'yield');
});

test('AR-11 通配 conflicts（canExpress 同语义）：x.* 前缀匹配', () => {
  // incoming（ext.debug.probe）声明的 ext.gaze.* 通配命中当前占用
  const r = arbitrateShared(fixture, [{ channelId: 'ext.gaze.look_up' }], { channelId: 'ext.debug.probe' });
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0].via, 'incoming-conflicts');
  // 反向：占用方声明通配同样命中
  const rev = arbitrateShared(fixture, [{ channelId: 'ext.debug.probe' }], { channelId: 'ext.gaze.look_down' });
  assert.equal(rev.conflicts.length, 1);
  assert.equal(rev.conflicts[0].via, 'current-conflicts');
});

test('AR-12 到期占用不构成冲突（INV-5 同型）；未提供 now 不做过期过滤', () => {
  const expired = arbitrateShared(
    fixture,
    [{ channelId: 'ext.expression.圈圈眼', endsAt: 1000 }],
    { channelId: 'ext.expression.屑' },
    { now: 2000 },
  );
  assert.deepEqual(expired, { decision: 'accept', conflicts: [] });
  // 未提供 now：全部占用视为活跃（保守判定）
  const noNow = arbitrateShared(
    fixture,
    [{ channelId: 'ext.expression.圈圈眼', endsAt: 1000 }],
    { channelId: 'ext.expression.屑' },
  );
  assert.equal(noNow.decision, 'yield');
  assert.equal(noNow.conflicts.length, 1);
});
