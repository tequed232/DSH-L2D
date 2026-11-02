import assert from 'node:assert/strict';
import { mergeActEvents, shapeActReceipt } from './act-result.mjs';

const start = { type: 'action-done', phase: 'start', runId: 4, callId: 9, priority: 'FORCE' };
const end = { type: 'action-done', phase: 'end', runId: 4, callId: 9, priority: 'FORCE' };
const dup = mergeActEvents([start], [start, end, { type: 'other' }]);
assert.equal(dup.length, 2);
assert.equal(dup[1].phase, 'end');

const pending = shapeActReceipt({ ok: true, accepted: true, runId: 4, priority: 'FORCE' }, [start]);
assert.equal(pending.ok, true);
assert.equal(pending.accepted, true);
assert.equal(pending.settled, false);
assert.equal(pending.outcome, 'pending');
assert.equal(pending.reason, 'pending');

const done = shapeActReceipt(pending, [start, end]);
assert.equal(done.settled, true);
assert.equal(done.outcome, 'completed');
assert.equal(done.reason, undefined);
assert.equal(done.events.length, 2);

const noted = shapeActReceipt(
  { ok: true, accepted: true, runId: 4, priority: 'FORCE', reason: 'pending' },
  [start, { ...end, notes: ['already-open'] }],
);
assert.equal(noted.outcome, 'completed');
assert.equal(noted.reason, undefined);
assert.deepEqual(noted.events[1].notes, ['already-open']);

const cut = shapeActReceipt(
  { ok: true, accepted: true, runId: 4 },
  [start, { type: 'action-done', phase: 'interrupted', runId: 4, reason: 'preempted' }],
);
assert.equal(cut.outcome, 'interrupted');
assert.equal(cut.settled, true);

const blocked = shapeActReceipt(
  { ok: false, accepted: false, reason: 'priority-blocked', priority: 'BACKGROUND', runId: null },
  [],
);
assert.equal(blocked.outcome, 'rejected');
assert.equal(blocked.reason, 'priority-blocked');
assert.equal(blocked.settled, false);

console.log('act-result ok');
