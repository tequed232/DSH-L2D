/**
 * P3 消息可靠性地基单测 + 10,000 条混合消息压力用例。
 *
 * 覆盖：信封补全、(type, requestId) 去重、乱序/缺口、state latest-value 合并
 * （动作/回执/错误/ACK/取消绝不合并）、水位背压（关键事件零丢失）、幂等重试。
 */
import assert from 'node:assert/strict';
import {
  RELIABLE_MESSAGE_SCHEMA_VERSION,
  backpressure,
  coalesceStateFrames,
  createSequence,
  deduplicate,
  envelopeMessage,
  idempotencyKey,
  isCoalescableStateFrame,
  reorder,
  withRetry,
  type ReliableEnvelope,
  type ReliableMessage,
} from '../src/reliable-message.ts';

// ---------------------------------------------------------------------------
// 1) 信封补全
// ---------------------------------------------------------------------------
const nextSeq = createSequence();
const env = envelopeMessage({ type: 'action', requestId: 'act-1', payload: { n: 1 } }, nextSeq());
assert.equal(env.sequence, 1);
assert.equal(env.requestId, 'act-1');
assert.equal(env.type, 'action');
assert.equal(env.schemaVersion, RELIABLE_MESSAGE_SCHEMA_VERSION);
assert.equal(typeof env.timestamp, 'number');
assert.equal(env.payload && (env.payload as { n: number }).n, 1);

// requestId 缺省补齐；伪造的 sequence/schemaVersion 被权威值覆盖
const forged = envelopeMessage(
  { type: 'state', key: 'ws:ent', sequence: -99, schemaVersion: 42 } as unknown as ReliableMessage,
  7,
);
assert.equal(forged.sequence, 7);
assert.equal(forged.schemaVersion, RELIABLE_MESSAGE_SCHEMA_VERSION);
assert.equal(forged.requestId, 'seq-7');
assert.equal(forged.key, 'ws:ent');

// 序列必须由调用方保证：非正整数拒绝；缺 type 拒绝
assert.throws(() => envelopeMessage({ type: 'state' }, 0), RangeError);
assert.throws(() => envelopeMessage({ type: 'state' }, 1.5), RangeError);
assert.throws(() => envelopeMessage({ type: '' }, 1), TypeError);
assert.throws(() => envelopeMessage(undefined as unknown as ReliableMessage, 1), TypeError);

// createSequence 单调
const seqB = createSequence(10);
assert.deepEqual([seqB(), seqB(), seqB()], [11, 12, 13]);

// ---------------------------------------------------------------------------
// 2) (type, requestId) 去重：保留最新
// ---------------------------------------------------------------------------
const dupInput = [
  envelopeMessage({ type: 'action', requestId: 'a', timestamp: 100 }, 1),
  envelopeMessage({ type: 'action', requestId: 'a', timestamp: 300 }, 3), // 最新
  envelopeMessage({ type: 'action', requestId: 'a', timestamp: 200 }, 2),
  envelopeMessage({ type: 'action', requestId: 'b', timestamp: 999 }, 4), // 不同 requestId 不合并
  envelopeMessage({ type: 'ack', requestId: 'a', timestamp: 100 }, 5), // 不同 type 不合并
];
const deduped = deduplicate(dupInput);
assert.equal(deduped.length, 3);
assert.deepEqual(deduped.map((m) => m.sequence), [3, 4, 5]);
assert.equal(deduped[0].timestamp, 300);

// 同序号重复投递（网络重发）取 timestamp 更新者
const resends = deduplicate([
  envelopeMessage({ type: 'state', requestId: 's', key: 'k', timestamp: 10 }, 9),
  envelopeMessage({ type: 'state', requestId: 's', key: 'k', timestamp: 20 }, 9),
]);
assert.equal(resends.length, 1);
assert.equal(resends[0].timestamp, 20);

assert.equal(idempotencyKey({ type: 'ack', requestId: 'a' }), 'ack\u0000a');
assert.equal(idempotencyKey({ type: 'ack' }), 'ack\u0000');

// ---------------------------------------------------------------------------
// 3) 乱序重排 + 缺口检测
// ---------------------------------------------------------------------------
const gapInput = [
  envelopeMessage({ type: 'state', requestId: 's1', key: 'k' }, 1),
  envelopeMessage({ type: 'action', requestId: 'x1' }, 4),
  envelopeMessage({ type: 'state', requestId: 's2', key: 'k' }, 2),
  envelopeMessage({ type: 'ack', requestId: 'y1' }, 7),
];
const { ordered, gaps } = reorder(gapInput);
assert.deepEqual(ordered.map((m) => m.sequence), [1, 2, 4, 7]);
assert.deepEqual(gaps, [
  { from: 3, to: 3 },
  { from: 5, to: 6 },
]);
assert.deepEqual(reorder([]), { ordered: [], gaps: [] });
// 重复 sequence 不产生缺口
assert.deepEqual(reorder([gapInput[0], gapInput[0]]).gaps, []);

// ---------------------------------------------------------------------------
// 4) state latest-value 合并：动作/回执/错误/ACK/取消绝不合并（P3 硬规则）
// ---------------------------------------------------------------------------
const coalesceInput = [
  envelopeMessage({ type: 'state', requestId: 's1', key: 'ws:e1', payload: { v: 1 } }, 1),
  envelopeMessage({ type: 'state', requestId: 's2', key: 'ws:e1', payload: { v: 2 } }, 2),
  envelopeMessage({ type: 'action', requestId: 'a1', payload: {} }, 3),
  envelopeMessage({ type: 'state', requestId: 's3', key: 'ws:e1', payload: { v: 3 } }, 4),
  envelopeMessage({ type: 'state.batch', requestId: 's4', key: 'ws:e2', payload: { v: 9 } }, 5),
  envelopeMessage({ type: 'state.batch', requestId: 's5', key: 'ws:e2', payload: { v: 10 } }, 6),
  envelopeMessage({ type: 'action', requestId: 'a2', payload: {} }, 7), // 同 type 不同 requestId 保留
  envelopeMessage({ type: 'receipt', requestId: 'r1' }, 8),
  envelopeMessage({ type: 'error', requestId: 'e1' }, 9),
  envelopeMessage({ type: 'ack', requestId: 'k1' }, 10),
  envelopeMessage({ type: 'cancel', requestId: 'c1' }, 11),
  envelopeMessage({ type: 'state', requestId: 's6', payload: { v: 0 } }, 12), // 无 key 的 state 不合并
];
const coalesced = coalesceStateFrames(coalesceInput);
assert.deepEqual(
  coalesced.map((m) => m.sequence),
  [3, 4, 6, 7, 8, 9, 10, 11, 12], // 1/2 旧 state 被合并，5 是 state.batch 旧帧被合并；其余逐条保留
);
const e1Latest = coalesced.find((m) => m.type === 'state' && m.key === 'ws:e1');
assert.equal(e1Latest && (e1Latest.payload as { v: number }).v, 3);
assert.equal(coalesced.filter((m) => m.type === 'action').length, 2);
assert.equal(coalesced.filter((m) => isCoalescableStateFrame(m) && m.key === 'ws:e1').length, 1);

// 白名单负例：离散事件类型一概不可合并
for (const t of ['action', 'action.receipt', 'receipt', 'error', 'ack', 'cancel', 'event']) {
  assert.equal(isCoalescableStateFrame({ type: t }), false, t);
}
assert.equal(isCoalescableStateFrame({ type: 'state' }), true);
assert.equal(isCoalescableStateFrame({ type: 'state.posture' }), true);

// ---------------------------------------------------------------------------
// 5) 背压：丢最旧 state、每 key 最新优先保留、关键事件绝不丢
// ---------------------------------------------------------------------------
const bpInput: ReliableEnvelope[] = [
  envelopeMessage({ type: 'state', requestId: 's1', key: 'k1', payload: { v: 1 } }, 1), // 旧 → 丢
  envelopeMessage({ type: 'state', requestId: 's2', key: 'k1', payload: { v: 2 } }, 2), // 最新 → 保
  envelopeMessage({ type: 'state', requestId: 's3', key: 'k2', payload: { v: 1 } }, 3), // 旧 → 丢
  envelopeMessage({ type: 'state', requestId: 's4', key: 'k2', payload: { v: 2 } }, 4), // 最新 → 丢（水位所迫）
  envelopeMessage({ type: 'action', requestId: 'a1' }, 5),
  envelopeMessage({ type: 'ack', requestId: 'k-1' }, 6),
];
const bp1 = backpressure(bpInput, 4);
assert.equal(bp1.kept.length, 4);
assert.deepEqual(
  bp1.kept.map((m) => m.sequence),
  [2, 4, 5, 6], // 丢两条旧 state；每 key 最新（k1=2、k2=4）+ 关键事件全保留
);
assert.deepEqual(bp1.dropped.map((m) => m.sequence), [1, 3]); // 只丢旧 state，按丢弃顺序
assert.ok(bpKeptSeqsHas(bp1, 5)); // action 5 在
assert.ok(bpKeptSeqsHas(bp1, 6)); // ack 6 在

// 水位内零丢弃
const bp2 = backpressure(bpInput, 6);
assert.equal(bp2.kept.length, 6);
assert.equal(bp2.dropped.length, 0);

// 全是不可丢事件超水位：如实保留（不静默丢关键事件）
const criticalOnly = [
  envelopeMessage({ type: 'action', requestId: 'a1' }, 1),
  envelopeMessage({ type: 'action', requestId: 'a2' }, 2),
];
const bp3 = backpressure(criticalOnly, 1);
assert.equal(bp3.kept.length, 2);
assert.equal(bp3.dropped.length, 0);

assert.throws(() => backpressure([], -1), RangeError);

function bpKeptSeqsHas(bp: { kept: ReliableEnvelope[] }, seq: number): boolean {
  return bp.kept.some((m) => m.sequence === seq);
}

// ---------------------------------------------------------------------------
// 6) ACK/重试语义：withRetry + 幂等键
// ---------------------------------------------------------------------------
let attempts = 0;
const retried = await withRetry(async () => {
  attempts++;
  if (attempts < 3) throw new Error('transient');
  return 'ok';
}, { retries: 3, backoffMs: 0 });
assert.equal(retried, 'ok');
assert.equal(attempts, 3);

// 重试耗尽抛最后错误
let exhaust = 0;
await assert.rejects(
  () =>
    withRetry(async () => {
      exhaust++;
      throw new Error('down-' + exhaust);
    }, { retries: 2 }),
  /down-3/,
);
assert.equal(exhaust, 3); // 首次 + 2 次重试

// 幂等重试：同一 requestId 重复投递 → 接收端 deduplicate 收敛为一条
const deliveries: ReliableEnvelope[] = [];
let deliverySeq = 0;
const deliver = async (msg: ReliableMessage) => {
  deliveries.push(envelopeMessage(msg, ++deliverySeq));
};
let failFirst = true;
await withRetry(async () => {
  await deliver({ type: 'action', requestId: 'idem-1', payload: { cmd: 'wave' } });
  if (failFirst) {
    failFirst = false;
    throw new Error('ack lost');
  }
}, { retries: 2 });
assert.equal(deliveries.length, 2); // 重试确实重复投递了
const acked = deduplicate(deliveries);
assert.equal(acked.length, 1); // 接收端幂等去重
assert.equal(acked[0].requestId, 'idem-1');

assert.rejects(() => withRetry(() => Promise.reject(new Error('x')), { retries: -1 }), RangeError);

// ---------------------------------------------------------------------------
// 7) 10,000 条混合消息压力用例（state:action:ack 混合 + 重复 + 乱序 + 缺口 + 水位）
// ---------------------------------------------------------------------------

/** 固定种子 LCG，保证压力用例可复现。 */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 2 ** 32);
}
const rand = lcg(20260311);
function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const STATE_KEYS = 50;
const N_STATE = 7000;
const N_ACTION = 2000;
const N_ACK = 1000;
const N_LOST = 1400; // 传输丢失（state 帧，每 5 条丢 1）→ 缺口
const N_DUP = 1400; // 重复投递（同 requestId 重发：state 1000 + action 400）
const PRODUCED = N_STATE + N_ACTION + N_ACK; // 发送端产出
const WIRE = PRODUCED - N_LOST + N_DUP; // 管线入口条数
assert.equal(PRODUCED, 10000);
assert.equal(WIRE, 10000);

const logicalActions: ReliableEnvelope[] = [];
const logicalAcks: ReliableEnvelope[] = [];
const wire: ReliableEnvelope[] = [];
const statesOnWire: ReliableEnvelope[] = [];
let seq = 0;
const lostSeqs = new Set<number>();

// state 帧：key 空间 50，随机丢失 N_LOST 条（精确计数，尾部强制补齐）→ 缺口
let keyIdx = 0;
for (let i = 0; i < N_STATE; i++) {
  const s = ++seq;
  const k = keyIdx++ % STATE_KEYS;
  const lostRemaining = N_LOST - lostSeqs.size;
  const framesRemaining = N_STATE - i;
  // seq=1 不可丢（首帧缺失没有下界参照，gap 检测不到）；尾部强制补齐保证精确 N_LOST
  if (s > 1 && lostRemaining > 0 && (framesRemaining <= lostRemaining || rand() < 0.2)) {
    lostSeqs.add(s);
    continue; // 未上线路
  }
  const m = envelopeMessage(
    { type: 'state', requestId: `st-${s}`, key: `ws-main:entity-${k}`, payload: { tick: s } },
    s,
  );
  statesOnWire.push(m);
  wire.push(m);
}
assert.equal(lostSeqs.size, N_LOST);

// 关键事件：动作与 ACK，逐条必须存活
for (let i = 0; i < N_ACTION; i++) {
  const s = ++seq;
  const m = envelopeMessage({ type: 'action', requestId: `act-${i}`, payload: { cmd: 'wave' } }, s);
  logicalActions.push(m);
  wire.push(m);
}
for (let i = 0; i < N_ACK; i++) {
  const s = ++seq;
  const m = envelopeMessage({ type: 'ack', requestId: `ack-${i}` }, s);
  logicalAcks.push(m);
  wire.push(m);
}

// 重复投递：state 重发 1000 + action 重发 400（同 requestId、同 sequence）
for (let i = 0; i < N_DUP; i++) {
  const src =
    i < 1000 ? statesOnWire[Math.floor(rand() * statesOnWire.length)] : logicalActions[Math.floor(rand() * logicalActions.length)];
  wire.push({ ...src });
}
assert.equal(wire.length, WIRE);

// 全链路乱序
shuffle(wire);

// 管线：去重 → 重排/缺口 → state 合并 → 背压
const t0 = Date.now();
const dedupedWire = deduplicate(wire);
assert.equal(dedupedWire.length, WIRE - N_DUP); // 重复投递全部收敛

const reorderRes = reorder(dedupedWire);
// 缺口对账：reorder 检出的缺号集合 == 实际传输丢失集合
const gapSeqs = new Set<number>();
for (const g of reorderRes.gaps) for (let s = g.from; s <= g.to; s++) gapSeqs.add(s);
for (const s of lostSeqs) assert.ok(reorderRes.ordered.every((m) => m.sequence !== s), `lost seq ${s} must not appear on wire`);

const coalescedWire = coalesceStateFrames(reorderRes.ordered);
assert.equal(gapSeqs.size, lostSeqs.size);
for (const s of lostSeqs) assert.ok(gapSeqs.has(s), `missing gap for lost seq ${s}`);
for (const s of gapSeqs) assert.ok(lostSeqs.has(s), `unexpected gap seq ${s}`);

// state 收敛：每 key 恰好 1 条
const stateByKey = new Map<string, number>();
for (const m of coalescedWire) {
  if (isCoalescableStateFrame(m) && m.key) stateByKey.set(m.key, (stateByKey.get(m.key) || 0) + 1);
}
assert.equal(stateByKey.size, STATE_KEYS);
for (const [k, n] of stateByKey) assert.equal(n, 1, `key ${k} coalesced to ${n}`);
const finalStates = coalescedWire.filter((m) => isCoalescableStateFrame(m));
assert.equal(finalStates.length, STATE_KEYS);

// 关键事件零丢失：动作/ACK 100% 保留
const keptActions = coalescedWire.filter((m) => m.type === 'action');
const keptAcks = coalescedWire.filter((m) => m.type === 'ack');
assert.equal(keptActions.length, N_ACTION, 'action 100% retained');
assert.equal(keptAcks.length, N_ACK, 'ack 100% retained');
const finalKeys = new Set(coalescedWire.map(idempotencyKey));
for (const a of logicalActions) assert.ok(finalKeys.has(idempotencyKey(a)), `lost action ${a.requestId}`);
for (const a of logicalAcks) assert.ok(finalKeys.has(idempotencyKey(a)), `lost ack ${a.requestId}`);

// 背压：水位 1000 < 关键事件总量 → 动作/ACK 依然 100%（关键事件绝不丢，如实超水位上报）
const bpLow = backpressure(coalescedWire, 1000);
assert.equal(bpLow.kept.filter((m) => m.type === 'action').length, N_ACTION);
assert.equal(bpLow.kept.filter((m) => m.type === 'ack').length, N_ACK);
assert.ok(bpLow.kept.length >= N_ACTION + N_ACK);

// 背压：水位 3020 = 关键 3000 + 20 条 state → 只丢 30 条 state，关键事件 100%
const bpTight = backpressure(coalescedWire, N_ACTION + N_ACK + 20);
assert.equal(bpTight.kept.length, N_ACTION + N_ACK + 20);
assert.equal(bpTight.dropped.length, STATE_KEYS - 20);
assert.ok(bpTight.dropped.every((m) => isCoalescableStateFrame(m)));
assert.equal(bpTight.kept.filter((m) => m.type === 'action').length, N_ACTION);
assert.equal(bpTight.kept.filter((m) => m.type === 'ack').length, N_ACK);

const elapsed = Date.now() - t0;

console.log(
  `[reliable-message] 压力对账 100%：管线入口 ${WIRE} 条（发送端产出 ${PRODUCED}，重复投递 ${N_DUP} / 传输丢失 ${N_LOST}）` +
    `→ 去重后 ${dedupedWire.length} → 合并后 ${coalescedWire.length}（state ${finalStates.length}/${STATE_KEYS} key 收敛为 1）；` +
    `动作保留 ${keptActions.length}/${N_ACTION}=100%，ACK 保留 ${keptAcks.length}/${N_ACK}=100%；` +
    `缺口 ${gapSeqs.size} 全部检出；背压(水位${N_ACTION + N_ACK + 20})丢弃 ${bpTight.dropped.length} 条 state、关键事件 0 丢失；` +
    `耗时 ${elapsed}ms`,
);
console.log('reliable-message ok');
