import assert from 'node:assert/strict';
import { executeActionSequence, validateActionSequence, MAX_SEGMENTS } from './action-sequence.mjs';

const plan = { segments: [
 { priority: 'NORMAL', chain: [{ kind: 'look', x: 0, y: 0 }, { kind: 'expression', name: '兔牙', delayMs: 100 }] },
 { priority: 'NORMAL', chain: [{ kind: 'motion', name: '竖手指打开', closeMotion: '竖手指关闭', closeAfterMs: 1800 }] },
] };
assert.equal(validateActionSequence(plan).ok, true);
assert.equal(validateActionSequence({ segments: [{ chain: [{ kind: 'look', x: 2, y: 0 }] }] }).ok, false);
assert.equal(validateActionSequence({ segments: [{ chain: [{ kind: 'expression', name: 'ParamMouthOpenY' }] }] }).ok, false);
assert.equal(validateActionSequence({ segments: Array.from({length:MAX_SEGMENTS + 1},()=>({chain:[{kind:'look',x:0,y:0}]})) }).ok, false);
assert.equal(validateActionSequence({ segments: [{ chain: Array.from({length:9},()=>({kind:'look',x:0,y:0})) }] }).ok, false);

let count = 0;
const done = await executeActionSequence(plan, async () => { count++; return { accepted:true, outcome:'completed', settled:true }; });
assert.equal(done.ok, true); assert.equal(count, 2);
count = 0;
const interrupted = await executeActionSequence(plan, async () => { count++; return { accepted:true, outcome:'interrupted', reason:'interrupted' }; });
assert.equal(interrupted.replanRequired, true); assert.equal(interrupted.remainingSegments, 1); assert.equal(count, 1);

// FIFO regression: 15 distinct actions must all run in order, even when admission
// temporarily rejects the head item while a higher-priority run is still active.
const fifteen = { segments: Array.from({ length: 15 }, (_, i) => ({
  priority: 'NORMAL',
  chain: [{ kind: 'look', x: (i % 3) / 3, y: 0 }],
})) };
assert.equal(validateActionSequence(fifteen).ok, true);
let submitted = 0;
let completed = [];
const queued = await executeActionSequence(fifteen, async ({ chain }) => {
  submitted += 1;
  if (submitted === 1 || submitted === 2) return { accepted: false, outcome: 'rejected', reason: 'priority-blocked' };
  completed.push(chain[0].x);
  return { accepted: true, outcome: 'completed', settled: true };
}, { maxQueueWaitMs: 1000, retryDelayMs: 0, sleep: async () => {} });
assert.equal(queued.ok, true);
assert.equal(queued.completedSegments, 15);
assert.equal(completed.length, 15);
assert.deepEqual(completed, fifteen.segments.map((s) => s.chain[0].x));
assert.equal(queued.receipts[0].attempts, 3);

// A still-running accepted action must not be submitted twice.
let pendingCalls = 0;
const pending = await executeActionSequence(plan, async () => {
  pendingCalls += 1;
  return { accepted: true, outcome: 'pending', reason: 'pending', settled: false };
});
assert.equal(pending.reason, 'pending');
assert.equal(pendingCalls, 1);
assert.equal(pending.remainingSegments, 1);

// A permanent admission rejection expires with an explicit queue timeout.
const expired = await executeActionSequence(plan, async () => ({
  accepted: false, outcome: 'rejected', reason: 'conflict',
}), { maxQueueWaitMs: 0, retryDelayMs: 0 });
assert.equal(expired.reason, 'conflict');
assert.equal(expired.receipts[0].attempts, 1);

console.log('action-sequence ok (15-step FIFO regression)');
