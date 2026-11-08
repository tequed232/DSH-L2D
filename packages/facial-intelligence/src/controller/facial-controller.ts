/**
 * Facial Controller（任务书 Part 5）。
 *
 * 职责：把目标语义参数平滑过渡为实时参数值。本类只工作在语义层
 * （角度为度、其余为归一化值），不触碰 Cubism；写入由 Adapter 完成。
 *
 * 实际版相对任务书基线的增强：
 *   - 每参数独立平滑时间常数（角度 0.12s / 眼 0.08s / 嘴 0.10s）
 *   - 目标过渡支持 durationMs + easing（FacialIntent.transition 直传）
 *   - 角度变化限速（默认 120°/s），防止中途换目标时头部甩动
 *   - 中途改目标从当前值重新出发，不产生跳变
 *   - reset 平滑恢复默认（不硬切）
 *   - dt 安全：非有限 / 负值 / 0 都不会产生 NaN，也不会推动状态
 *   - 输出钳制在 FACE_PARAMETER_BOUNDS 内，任何路径都不会越界
 */

export type FaceParameterKey =
  | 'angleX'
  | 'angleY'
  | 'angleZ'
  | 'eyeLOpen'
  | 'eyeROpen'
  | 'eyeBallX'
  | 'eyeBallY'
  | 'mouthOpen'
  | 'mouthForm';

export interface FaceParameters {
  angleX: number;
  angleY: number;
  angleZ: number;

  eyeLOpen: number;
  eyeROpen: number;

  eyeBallX: number;
  eyeBallY: number;

  mouthOpen: number;
  mouthForm: number;
}

export const DEFAULT_FACE_PARAMETERS: FaceParameters = {
  angleX: 0,
  angleY: 0,
  angleZ: 0,

  eyeLOpen: 1,
  eyeROpen: 1,

  eyeBallX: 0,
  eyeBallY: 0,

  mouthOpen: 0,
  mouthForm: 0,
};

/** 语义层安全边界（与 DEFAULT_PARAMETER_BINDINGS 的标准范围一致） */
export const FACE_PARAMETER_BOUNDS = {
  angleX: { min: -30, max: 30 },
  angleY: { min: -30, max: 30 },
  angleZ: { min: -15, max: 15 },
  eyeLOpen: { min: 0, max: 1 },
  eyeROpen: { min: 0, max: 1 },
  eyeBallX: { min: -1, max: 1 },
  eyeBallY: { min: -1, max: 1 },
  mouthOpen: { min: 0, max: 1 },
  mouthForm: { min: -1, max: 1 },
} as const satisfies Record<FaceParameterKey, { min: number; max: number }>;

/** 每参数平滑时间常数（秒）。小 = 跟得紧，大 = 更柔。 */
export const DEFAULT_SMOOTHING_SECONDS = {
  angleX: 0.12,
  angleY: 0.12,
  angleZ: 0.12,
  eyeLOpen: 0.08,
  eyeROpen: 0.08,
  eyeBallX: 0.08,
  eyeBallY: 0.08,
  mouthOpen: 0.1,
  mouthForm: 0.1,
} as const satisfies Record<FaceParameterKey, number>;

/** 头部角度限速（度/秒）。防甩头；眼球 / 嘴部不限速（跟随类参数需要灵敏）。 */
export const DEFAULT_MAX_ANGLE_DEG_PER_SECOND = 120;

/** reset 的默认过渡时长：平滑恢复而不是硬切 */
export const DEFAULT_RESET_DURATION_MS = 300;

export const FACE_PARAMETER_KEYS = Object.keys(DEFAULT_FACE_PARAMETERS) as FaceParameterKey[];

const ANGLE_KEYS = new Set<FaceParameterKey>(['angleX', 'angleY', 'angleZ']);

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * 一阶低通系数：dt 为秒，smoothingSeconds 为时间常数。
 * smoothingSeconds <= 0 时直接贴目标；dt 非有限或 <= 0 时返回 0（本帧不动）。
 */
export function smoothFactor(dt: number, smoothingSeconds: number): number {
  if (!Number.isFinite(dt) || dt <= 0) return 0;
  if (!(smoothingSeconds > 0)) return 1;
  return 1 - Math.exp(-dt / smoothingSeconds);
}

const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t);

export type EasingFn = (t: number) => number;

/** 过渡缓动曲线（t 已在函数内钳到 0~1）。 */
export const EASING_FUNCTIONS = {
  linear: (t: number): number => clamp01(t),
  easeIn: (t: number): number => {
    const x = clamp01(t);
    return x * x;
  },
  easeOut: (t: number): number => {
    const x = clamp01(t);
    return 1 - (1 - x) * (1 - x);
  },
  easeInOut: (t: number): number => {
    const x = clamp01(t);
    return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
  },
  smooth: (t: number): number => {
    const x = clamp01(t);
    return x * x * (3 - 2 * x);
  },
} as const satisfies Record<string, EasingFn>;

export interface TransitionOptions {
  /** 过渡时长；0 表示立即贴目标 */
  durationMs?: number;
  easing?: FacialPlanEasing;
}

/** 从 schema 层复用 Easing 名，避免两套枚举漂移 */
type FacialPlanEasing = import('../schema/facial-intent.ts').Easing;

interface TransitionState {
  from: FaceParameters;
  to: FaceParameters;
  elapsedMs: number;
  durationMs: number;
  easing: FacialPlanEasing;
}

export interface FacialControllerOptions {
  /** 覆盖单参数平滑时间常数 */
  smoothingSeconds?: Partial<Record<FaceParameterKey, number>>;
  /** 角度限速（度/秒），默认 120 */
  maxAngleDegPerSecond?: number;
  /** reset 过渡时长，默认 300ms */
  resetDurationMs?: number;
}

export class FacialController {
  private current: FaceParameters = { ...DEFAULT_FACE_PARAMETERS };
  private target: FaceParameters = { ...DEFAULT_FACE_PARAMETERS };
  private transition: TransitionState | null = null;

  private smoothing: Record<FaceParameterKey, number>;
  private maxAngleRate: number;
  private resetDurationMs: number;

  constructor(options: FacialControllerOptions = {}) {
    this.smoothing = { ...DEFAULT_SMOOTHING_SECONDS, ...(options.smoothingSeconds ?? {}) };
    this.maxAngleRate =
      options.maxAngleDegPerSecond !== undefined && options.maxAngleDegPerSecond >= 0
        ? options.maxAngleDegPerSecond
        : DEFAULT_MAX_ANGLE_DEG_PER_SECOND;
    this.resetDurationMs = options.resetDurationMs ?? DEFAULT_RESET_DURATION_MS;
  }

  /**
   * 设置目标参数。非有限值会被忽略（防御上游脏数据）。
   * 传 transition 时从当前值出发按 easing 过渡；不传时立即改目标（仍受平滑约束）。
   */
  setTarget(target: Partial<FaceParameters>, transition?: TransitionOptions): void {
    const sanitized: Partial<FaceParameters> = {};
    for (const key of FACE_PARAMETER_KEYS) {
      const value = target[key];
      if (value !== undefined && Number.isFinite(value)) sanitized[key] = value;
    }

    const durationMs = transition?.durationMs;
    const useTransition = durationMs !== undefined && durationMs > 0;

    if (useTransition) {
      // 从当前值出发：中途换目标也连续，不跳变
      this.transition = {
        from: { ...this.current },
        to: { ...this.target, ...sanitized },
        elapsedMs: 0,
        durationMs,
        easing: transition?.easing ?? 'easeInOut',
      };
    } else {
      this.transition = null;
    }

    this.target = { ...this.target, ...sanitized };
  }

  /** 平滑恢复默认参数（角度归零、睁眼、闭嘴），不硬切。 */
  reset(): void {
    this.setTarget(DEFAULT_FACE_PARAMETERS, { durationMs: this.resetDurationMs, easing: 'easeInOut' });
  }

  /** 完全清空过渡状态并硬回默认。仅用于模型切换等明确的重置场景。 */
  hardReset(): void {
    this.current = { ...DEFAULT_FACE_PARAMETERS };
    this.target = { ...DEFAULT_FACE_PARAMETERS };
    this.transition = null;
  }

  /**
   * 推进一帧。
   * @param dt 距上一帧的秒数；非有限 / 负值 / 0 视为 0（状态不动，绝不产生 NaN）
   */
  update(dt: number): FaceParameters {
    const dtSafe = Number.isFinite(dt) && dt > 0 ? dt : 0;

    // ---- 过渡插值：求本帧的中间目标
    let interim: FaceParameters;
    if (this.transition !== null) {
      const tr = this.transition;
      tr.elapsedMs += dtSafe * 1000;
      const progress = tr.durationMs > 0 ? clamp01(tr.elapsedMs / tr.durationMs) : 1;
      const eased = EASING_FUNCTIONS[tr.easing](progress);
      interim = {} as FaceParameters;
      for (const key of FACE_PARAMETER_KEYS) {
        (interim as Record<FaceParameterKey, number>)[key] = lerp(tr.from[key], tr.to[key], eased);
      }
      if (progress >= 1) {
        this.target = { ...tr.to };
        this.transition = null;
      }
    } else {
      interim = this.target;
    }

    // ---- 平滑 + 角度限速 + 边界钳制
    const maxDelta = this.maxAngleRate * dtSafe;
    for (const key of FACE_PARAMETER_KEYS) {
      const alpha = smoothFactor(dtSafe, this.smoothing[key]);
      let next = lerp(this.current[key], interim[key], alpha);

      if (ANGLE_KEYS.has(key) && maxDelta > 0) {
        const before = this.current[key];
        next = Math.max(before - maxDelta, Math.min(before + maxDelta, next));
      }

      const bounds = FACE_PARAMETER_BOUNDS[key];
      if (Number.isFinite(next)) {
        this.current[key] = Math.max(bounds.min, Math.min(bounds.max, next));
      }
    }

    return { ...this.current };
  }

  getCurrent(): FaceParameters {
    return { ...this.current };
  }

  getTarget(): FaceParameters {
    return { ...this.target };
  }

  /** 是否仍在过渡中（用于诊断与 Inspector 显示） */
  isTransitioning(): boolean {
    return this.transition !== null;
  }
}
