import assert from 'node:assert/strict';
import { clampSemanticValue, resolveSemanticControl, selectMotionAdapter, validateMotionProfile } from '../src/motion-profile.ts';
import { sampleTrajectory, validateTrajectory } from '../src/motion-trajectory.ts';
import type { ModelMotionProfile } from '../src/motion-contract.ts';

const profile: ModelMotionProfile = {
  contractVersion: 1, modelId: 'fixture-model-a', adapterId: 'cubism-web', profileRevision: 'fixture-1',
  controls: [
    { id: 'head.yaw', status: 'supported', min: -1, max: 1, neutral: 0, confidence: 1, sourceId: 'AngleX' },
    { id: 'arm.right.raise', status: 'unsupported', min: -1, max: 1, neutral: 0, confidence: 0, reason: 'No writable arm control' },
  ],
  assets: [{ id: 'wave-motion', kind: 'motion', status: 'supported', resources: ['arm.right'], interruptible: true, loopable: false }],
};
assert.equal(validateMotionProfile(profile).ok, true);
assert.equal(resolveSemanticControl(profile, 'head.yaw')?.sourceId, 'AngleX');
assert.equal(resolveSemanticControl(profile, 'arm.right.raise'), null);
assert.equal(clampSemanticValue(profile.controls[0], 2), 1);
assert.equal(clampSemanticValue(profile.controls[0], Number.NaN), null);
assert.equal(selectMotionAdapter({ kind: 'cubism' }, [
  { adapter: { id: 'other' } as never, supports: () => false },
  { adapter: { id: 'cubism' } as never, supports: (model) => model.kind === 'cubism' },
])?.adapter.id, 'cubism');

const trajectory = { durationMs: 1000, tracks: [{ controlId: 'head.yaw', keyframes: [
  { atMs: 0, value: 0, easing: 'ease-in-out' as const },
  { atMs: 500, value: 1, easing: 'ease-out' as const },
  { atMs: 1000, value: 0 },
]}]};
assert.deepEqual(validateTrajectory(trajectory), []);
assert.equal(sampleTrajectory(trajectory, 0).values['head.yaw'], 0);
assert.ok(sampleTrajectory(trajectory, 250).values['head.yaw'] > 0);
assert.equal(sampleTrajectory(trajectory, 1000).values['head.yaw'], 0);
assert.equal(sampleTrajectory(trajectory, 1200).complete, true);
assert.throws(() => sampleTrajectory({ ...trajectory, durationMs: 0 }, 0));
console.log('motion contract ok');
