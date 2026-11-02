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
console.log('ai-inbox ok');
