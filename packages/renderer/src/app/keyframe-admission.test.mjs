import test from 'node:test';
import assert from 'node:assert/strict';
import { admitKeyframeTrack } from './keyframe-admission.ts';

test('未 own 的物理输出轨道必须被接受（准入后自动认领），回归 no-valid-tracks', () => {
  const admission = admitKeyframeTrack({ exists: true, lipsync: false, physicsOutput: true });
  assert.equal(admission.accepted, true);
  assert.equal(admission.autoOwn, true);
});

test('普通可写参数接受但不自动认领', () => {
  const admission = admitKeyframeTrack({ exists: true, lipsync: false, physicsOutput: false });
  assert.equal(admission.accepted, true);
  assert.equal(admission.autoOwn, false);
});

test('口型与不存在的参数被拒绝', () => {
  assert.deepEqual(admitKeyframeTrack({ exists: true, lipsync: true, physicsOutput: false }), {
    accepted: false,
    autoOwn: false,
    reason: 'lipsync',
  });
  assert.deepEqual(admitKeyframeTrack({ exists: false, lipsync: false, physicsOutput: true }), {
    accepted: false,
    autoOwn: false,
    reason: 'unknown-param',
  });
});
