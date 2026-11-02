import assert from 'node:assert/strict';
import { executeActionSequence, validateActionSequence } from './action-sequence.mjs';
const plan = { segments: [
 { priority: 'NORMAL', chain: [{ kind: 'look', x: 0, y: 0 }, { kind: 'expression', name: '兔牙', delayMs: 100 }] },
 { priority: 'NORMAL', chain: [{ kind: 'motion', name: '竖手指打开', closeMotion: '竖手指关闭', closeAfterMs: 1800 }] },
] };
assert.equal(validateActionSequence(plan).ok, true);
assert.equal(validateActionSequence({ segments: [{ chain: [{ kind: 'look', x: 2, y: 0 }] }] }).ok, false);
assert.equal(validateActionSequence({ segments: [{ chain: [{ kind: 'expression', name: 'ParamMouthOpenY' }] }] }).ok, false);
assert.equal(validateActionSequence({ segments: Array.from({length:4},()=>({chain:[{kind:'look',x:0,y:0}]})) }).ok, false);
assert.equal(validateActionSequence({ segments: [{ chain: Array.from({length:9},()=>({kind:'look',x:0,y:0})) }] }).ok, false);
let count = 0;
const done = await executeActionSequence(plan, async () => { count++; return { accepted:true, outcome:'completed', settled:true }; });
assert.equal(done.ok, true); assert.equal(count, 2);
count = 0;
const interrupted = await executeActionSequence(plan, async () => { count++; return { accepted:true, outcome:'interrupted', reason:'interrupted' }; });
assert.equal(interrupted.replanRequired, true); assert.equal(interrupted.remainingSegments, 1); assert.equal(count, 1);
const conflict = await executeActionSequence(plan, async () => ({ accepted:false, outcome:'rejected', reason:'conflict' }));
assert.equal(conflict.reason, 'conflict'); assert.equal(conflict.replanRequired, true);
console.log('action-sequence ok');
