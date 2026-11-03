import assert from 'node:assert/strict';
import { createAiInbox } from './ai-inbox.mjs';

const inbox = createAiInbox();
const queued = inbox.call('l2d_act', { priority: 'FORCE' });
assert.equal(queued.ok, true);
assert.equal(queued.id, 1);
assert.deepEqual(inbox.poll().calls.map((item) => item.name), ['l2d_act']);
assert.deepEqual(inbox.poll().calls, []);

const start = { type: 'action-done', phase: 'start', runId: 1, callId: 1 };
assert.equal(inbox.post({ id: 1, event: start }).ok, true);
const early = inbox.read(1);
assert.equal(early.ready, false);
assert.equal(early.events.length, 1);
assert.equal(early.events[0].phase, 'start');

const accepted = { ok: true, accepted: true, runId: 1, priority: 'FORCE' };
inbox.post({ id: 1, result: accepted });
const end = { type: 'action-done', phase: 'end', runId: 1, callId: 1 };
inbox.post({ id: 1, event: end });
const done = inbox.read(1);
assert.equal(done.ready, true);
assert.equal(done.result.accepted, true);
assert.equal(done.events[0].phase, 'end');
assert.deepEqual(inbox.read(1), { ready: false });

assert.equal(inbox.post({}).ok, false);

// ---- P0 通道计数器：入队 / 消费 / 残留 ----
{
  const box = createAiInbox({ maxQueue: 3, staleMs: 1000 });
  assert.equal(box.stats(0).queueDepth, 0);
  assert.equal(box.stats(0).oldestPendingAgeMs, 0);

  box.call('a', {});
  box.call('b', {});
  const s = box.stats(0);
  assert.equal(s.queueDepth, 2); // 残留 2 条未消费
  assert.equal(s.totalEnqueued, 2);
  assert.equal(s.totalConsumed, 0);
  assert.equal(s.seq, 2);

  // 最老未消费年龄：ts 取真实 Date.now，注入 now=ts+1500 判过期
  const ts = Date.now();
  box.poll(); // 消费 2 条
  assert.equal(box.stats(ts).queueDepth, 0);
  const s2 = box.stats(ts);
  assert.equal(s2.totalConsumed, 2);

  box.call('c', {});
  box.call('d', {});
  const s3 = box.stats(ts + 1500); // 两条都超过 staleMs=1000
  assert.equal(s3.stalePending, 2);
  assert.equal(s3.totalStale, 2);
  assert.ok(s3.oldestPendingAgeMs >= 1500);
  // 重复读 stats 不重复累计过期
  assert.equal(box.stats(ts + 1500).totalStale, 2);
}

// ---- 队列满：背压丢弃计数 ----
{
  const box = createAiInbox({ maxQueue: 2 });
  box.call('x', {});
  box.call('y', {});
  box.call('z', {}); // 挤掉最老的 x
  const s = box.stats();
  assert.equal(s.queueDepth, 2);
  assert.equal(s.totalEnqueued, 3);
  assert.equal(s.totalDropped, 1);
  assert.equal(s.totalConsumed, 0);
}

// ---- result / event 读写与过期计数 ----
{
  const box = createAiInbox({ maxIds: 1 });
  box.post({ id: 1, result: { ok: true } });
  box.post({ id: 2, result: { ok: true } }); // id=1 的结果未读被挤掉
  assert.equal(box.stats().totalResultsExpired, 1);
  assert.equal(box.stats().totalResultsPosted, 2);
  assert.equal(box.read(2).ready, true);
  assert.equal(box.stats().totalResultsRead, 1);

  box.post({ id: 3, event: { type: 'action-done' } });
  box.post({ id: 4, event: { type: 'action-done' } });
  assert.equal(box.stats().totalEventsPosted, 2);
  assert.equal(box.stats().totalEventsExpired, 1); // id=3 的事件被 maxIds=1 挤掉
}

// ---- P3：迟到回执 timeout 计数（timeoutMs 启用时） ----
{
  const box = createAiInbox({ timeoutMs: 100 });
  const q = box.call('slow_act', {});
  box.poll(); // call 被取走，进入等待回执阶段
  // 未超时的回执：不计 timeout
  box.post({ id: q.id, result: { ok: true } });
  assert.equal(box.read(q.id).ready, true);
  assert.equal(box.stats().totalTimeouts, 0);

  // 超时后到达的回执：计 timeout，但仍照常写入（只计数不丢弃）
  const q2 = box.call('slow_act2', {});
  box.poll();
  const waitUntil = Date.now() + 150;
  while (Date.now() < waitUntil) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  box.post({ id: q2.id, result: { ok: true } });
  assert.equal(box.read(q2.id).ready, true); // 迟到回执仍可读
  assert.equal(box.stats().totalTimeouts, 1);
}

// ---- P3：timeoutMs 未启用（默认 0）时行为与 P0 版完全一致 ----
{
  const box = createAiInbox();
  const q = box.call('a', {});
  box.poll();
  box.post({ id: q.id, result: { ok: true } });
  assert.equal(box.stats().totalTimeouts, 0);
}

// ---- 现有 API 形状不变 ----
{
  const box = createAiInbox();
  const q = box.call('l2d_act', {});
  assert.deepEqual(Object.keys(q).sort(), ['id', 'ok', 'queued']);
  assert.deepEqual(Object.keys(box.poll()).sort(), ['calls']);
  assert.deepEqual(Object.keys(box.post({ id: 1 })).sort(), ['ok']);
  assert.deepEqual(Object.keys(box.read(1)).sort(), ['ready']);
}

console.log('ai-inbox ok');
