export type MotionEasing = 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out' | 'smoothstep';
export interface MotionKeyframe { atMs: number; value: number; easing?: MotionEasing; }
export interface MotionTrack { controlId: string; keyframes: MotionKeyframe[]; }
export interface MotionTrajectory { durationMs: number; tracks: MotionTrack[]; }
export interface TrajectorySample { values: Record<string, number>; complete: boolean; }

function clamp01(value: number): number { return Math.max(0, Math.min(1, value)); }
function ease(value: number, easing: MotionEasing = 'ease-in-out'): number {
  const t = clamp01(value);
  switch (easing) {
    case 'linear': return t;
    case 'ease-in': return t * t;
    case 'ease-out': return 1 - (1 - t) * (1 - t);
    case 'smoothstep': return t * t * (3 - 2 * t);
    case 'ease-in-out': return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }
}
export function validateTrajectory(trajectory: MotionTrajectory): string[] {
  const errors: string[] = [];
  if (!trajectory || !Number.isFinite(trajectory.durationMs) || trajectory.durationMs <= 0) return ['durationMs must be positive'];
  if (!Array.isArray(trajectory.tracks)) return ['tracks must be an array'];
  const ids = new Set<string>();
  for (const [index, track] of trajectory.tracks.entries()) {
    if (!track || typeof track.controlId !== 'string' || !track.controlId.trim()) { errors.push(`tracks[${index}].controlId is required`); continue; }
    if (ids.has(track.controlId)) errors.push(`duplicate track: ${track.controlId}`);
    ids.add(track.controlId);
    if (!Array.isArray(track.keyframes) || track.keyframes.length < 2) { errors.push(`track ${track.controlId} needs at least two keyframes`); continue; }
    let previous = -Infinity;
    for (const [frameIndex, frame] of track.keyframes.entries()) {
      if (!Number.isFinite(frame.atMs) || frame.atMs < 0 || frame.atMs > trajectory.durationMs) errors.push(`track ${track.controlId} keyframe ${frameIndex} has invalid time`);
      if (frame.atMs <= previous) errors.push(`track ${track.controlId} keyframes must be strictly increasing`);
      if (!Number.isFinite(frame.value)) errors.push(`track ${track.controlId} keyframe ${frameIndex} has invalid value`);
      if (frame.easing !== undefined && !['linear', 'ease-in', 'ease-out', 'ease-in-out', 'smoothstep'].includes(frame.easing)) errors.push(`track ${track.controlId} keyframe ${frameIndex} has invalid easing`);
      previous = frame.atMs;
    }
    if (track.keyframes[0]?.atMs !== 0) errors.push(`track ${track.controlId} must start at 0ms`);
    if (track.keyframes[track.keyframes.length - 1]?.atMs !== trajectory.durationMs) errors.push(`track ${track.controlId} must end at durationMs`);
  }
  return errors;
}
export function sampleTrajectory(trajectory: MotionTrajectory, elapsedMs: number): TrajectorySample {
  const errors = validateTrajectory(trajectory);
  if (errors.length) throw new Error(errors.join('; '));
  const time = Math.max(0, Math.min(trajectory.durationMs, Number.isFinite(elapsedMs) ? elapsedMs : 0));
  const values: Record<string, number> = {};
  for (const track of trajectory.tracks) {
    let left = track.keyframes[0];
    let right = track.keyframes[track.keyframes.length - 1];
    for (let index = 1; index < track.keyframes.length; index++) {
      if (time <= track.keyframes[index].atMs) { left = track.keyframes[index - 1]; right = track.keyframes[index]; break; }
    }
    const span = right.atMs - left.atMs;
    const progress = span <= 0 ? 1 : (time - left.atMs) / span;
    const t = ease(progress, left.easing);
    values[track.controlId] = left.value + (right.value - left.value) * t;
  }
  return { values, complete: time >= trajectory.durationMs };
}
