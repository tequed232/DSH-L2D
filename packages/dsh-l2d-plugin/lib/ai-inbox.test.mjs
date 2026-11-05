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

// CODE-REVIEW-1 #13：event 与 result 同一条 post 都要落，result 不得被静默丢弃
{
  const b2 = createAiInbox();
  b2.call('l2d_act', {});
  const id2 = b2.poll().calls[0].id;
  b2.post({ id: id2, event: { phase: 'start' }, result: { ok: true } });
  const r2 = b2.read(id2);
  assert.equal(r2.ready, true, 'event+result 并存时 result 必须落库');
  assert.equal(r2.result.ok, true);
  assert.equal(r2.events.length, 1);
}

// CODE-REVIEW-1 #14：result 为合法 falsy（false/0）时原样保留，不得被篡改
{
  const b3 = createAiInbox();
  b3.call('l2d_get_state', {});
  const id3 = b3.poll().calls[0].id;
  b3.post({ id: id3, result: false });
  assert.equal(b3.read(id3).result, false, 'false 结果不得被替换');
  b3.call('l2d_get_state', {});
  const id4 = b3.poll().calls[0].id;
  b3.post({ id: id4, result: 0 });
  assert.equal(b3.read(id4).result, 0, '0 结果不得被替换');
}

// CODE-REVIEW-1 #15：队列溢出必须显式带 dropped 计数
{
  const b5 = createAiInbox({ maxQueue: 2 });
  b5.call('l2d_act', { n: 1 });
  b5.call('l2d_act', { n: 2 });
  const overflow = b5.call('l2d_act', { n: 3 });
  assert.equal(overflow.ok, true);
  assert.equal(overflow.dropped, 1, '溢出丢弃必须反馈 dropped 计数');
  assert.deepEqual(b5.poll().calls.map((c) => c.args.n), [2, 3]);
}

// CODE-REVIEW-1 #13 伴随收紧：既无 event 也无 result 的 post 拒绝（原为静默 ok:true）
assert.equal(inbox.post({ id: 999 }).ok, false);

console.log('ai-inbox ok');
