/**
 * 确定性轨迹采样（纯函数，无网络/无模型访问）。
 *
 * 热路径约定（PR #10 review P2）：
 * - 校验只做一次：`compileTrajectory()` 在准入时校验并把关键帧展平成段，
 *   帧循环用 `sampleCompiled()`，不再每帧建 Set / 跑 validate；
 * - `compileTrajectoryCached()` 用 WeakMap 缓存编译结果，同一 trajectory 对象重复
 *   采样不重复校验（planner 通常复用同一对象）；
 * - 非法轨迹给 `{ok:false, errors}` 或 `sampleTrajectorySafe`，**不要在帧循环里 throw**
 *   （`sampleTrajectory` 保留 throw 只为兼容，渲染路径请用 compile + sampleCompiled）；
 * - 缓动复用 `core/src/ease.ts` 的 `easeInOutCubic`，不另写一份公式。
 */
import { easeInOutCubic } from './ease.ts';

export type MotionEasing = 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out' | 'smoothstep';

export interface MotionKeyframe { atMs: number; value: number; easing?: MotionEasing; }
export interface MotionTrack { controlId: string; keyframes: MotionKeyframe[]; }
export interface MotionTrajectory { durationMs: number; tracks: MotionTrack[]; }
export interface TrajectorySample { values: Record<string, number>; complete: boolean; }

/** 编译后的段：`from`/`to` 是该段两端关键帧的值，`easing` 取左端点（segment easing 归属左端点）。 */
export interface CompiledSegment {
  startMs: number;
  endMs: number;
  from: number;
  to: number;
  easing: MotionEasing;
}

export interface CompiledTrack { controlId: string; segments: CompiledSegment[]; }
export interface CompiledTrajectory { durationMs: number; tracks: CompiledTrack[]; }

export type CompileResult = { ok: true; compiled: CompiledTrajectory } | { ok: false; errors: string[] };
export type SafeSample = { ok: true; sample: TrajectorySample } | { ok: false; errors: string[] };

const EASINGS = ['linear', 'ease-in', 'ease-out', 'ease-in-out', 'smoothstep'] as const;
/** 端点时间容差：允许浮点构造（999.9999ms）而不误拒。 */
const TIME_EPS = 1e-6;

function clamp01(value: number): number { return Math.max(0, Math.min(1, value)); }

/** 缓动求值。未知 easing 退回线性——JS 调用方传错字符串不能产出 NaN。 */
export function easeAt(progress: number, easing: MotionEasing = 'ease-in-out'): number {
  const t = clamp01(progress);
  switch (easing) {
    case 'linear': return t;
    case 'ease-in': return t * t;
    case 'ease-out': return 1 - (1 - t) * (1 - t);
    case 'smoothstep': return t * t * (3 - 2 * t);
    case 'ease-in-out': return easeInOutCubic(t);
    default: return t;
  }
}

/** 准入期校验。返回错误列表（空数组 = 合法）。 */
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
      if (!frame || typeof frame !== 'object') { errors.push(`track ${track.controlId} keyframe ${frameIndex} is not an object`); continue; }
      const at = frame.atMs;
      if (!Number.isFinite(at) || at < 0 || at > trajectory.durationMs) errors.push(`track ${track.controlId} keyframe ${frameIndex} has invalid time`);
      if (at <= previous) errors.push(`track ${track.controlId} keyframes must be strictly increasing`);
      if (!Number.isFinite(frame.value)) errors.push(`track ${track.controlId} keyframe ${frameIndex} has invalid value`);
      if (frame.easing !== undefined && !(EASINGS as readonly string[]).includes(frame.easing)) errors.push(`track ${track.controlId} keyframe ${frameIndex} has invalid easing`);
      previous = at;
    }
    if (Math.abs(track.keyframes[0].atMs) > TIME_EPS) errors.push(`track ${track.controlId} must start at 0ms`);
    if (Math.abs(track.keyframes[track.keyframes.length - 1].atMs - trajectory.durationMs) > TIME_EPS) errors.push(`track ${track.controlId} must end at durationMs`);
  }
  return errors;
}

/** 校验 + 展平分段。每帧采样不再触碰关键帧数组与 Set。 */
export function compileTrajectory(trajectory: MotionTrajectory): CompileResult {
  const errors = validateTrajectory(trajectory);
  if (errors.length) return { ok: false, errors };
  const tracks: CompiledTrack[] = trajectory.tracks.map((track) => {
    const segments: CompiledSegment[] = [];
    for (let index = 1; index < track.keyframes.length; index++) {
      const left = track.keyframes[index - 1];
      const right = track.keyframes[index];
      segments.push({
        startMs: left.atMs,
        endMs: right.atMs,
        from: left.value,
        to: right.value,
        easing: left.easing ?? 'ease-in-out',
      });
    }
    return { controlId: track.controlId, segments };
  });
  return { ok: true, compiled: { durationMs: trajectory.durationMs, tracks } };
}

const compiledCache = new WeakMap<object, CompileResult>();

/** 带缓存的编译：同一 trajectory 对象只校验一次（只缓存成功结果）。 */
export function compileTrajectoryCached(trajectory: MotionTrajectory): CompileResult {
  if (!trajectory || typeof trajectory !== 'object') return { ok: false, errors: ['trajectory must be an object'] };
  const cached = compiledCache.get(trajectory as object);
  if (cached) return cached;
  const result = compileTrajectory(trajectory);
  if (result.ok) compiledCache.set(trajectory as object, result);
  return result;
}

/** 帧循环用这个：预编译轨迹 + 时间，零校验、不 throw。 */
export function sampleCompiled(compiled: CompiledTrajectory, elapsedMs: number): TrajectorySample {
  const duration = compiled.durationMs;
  const time = Math.max(0, Math.min(duration, Number.isFinite(elapsedMs) ? elapsedMs : 0));
  const values: Record<string, number> = {};
  for (const track of compiled.tracks) {
    const segments = track.segments;
    if (!segments.length) continue;
    let segment = segments[segments.length - 1];
    for (const candidate of segments) {
      if (time <= candidate.endMs) { segment = candidate; break; }
    }
    const span = segment.endMs - segment.startMs;
    const progress = span <= 0 ? 1 : (time - segment.startMs) / span;
    const t = easeAt(progress, segment.easing);
    values[track.controlId] = segment.from + (segment.to - segment.from) * t;
  }
  return { values, complete: time >= duration };
}

/** 不抛版本的采样：非法轨迹返回 `{ok:false, errors}`，适合帧循环/回执路径。 */
export function sampleTrajectorySafe(trajectory: MotionTrajectory, elapsedMs: number): SafeSample {
  const result = compileTrajectoryCached(trajectory);
  if (!result.ok) return { ok: false, errors: result.errors };
  return { ok: true, sample: sampleCompiled(result.compiled, elapsedMs) };
}

/**
 * 兼容入口：内部走缓存编译，非法轨迹仍 throw。
 * 渲染热路径请改用 `compileTrajectory` + `sampleCompiled`，避免每帧 try/throw 风险。
 */
export function sampleTrajectory(trajectory: MotionTrajectory, elapsedMs: number): TrajectorySample {
  const result = compileTrajectoryCached(trajectory);
  if (!result.ok) throw new Error(result.errors.join('; '));
  return sampleCompiled(result.compiled, elapsedMs);
}

// 编译缓存用 WeakMap：trajectory 对象不再被引用时自动回收，
// 因此不需要 clear()（模型切换时旧轨迹对象自然失效，不会污染新模型）。
