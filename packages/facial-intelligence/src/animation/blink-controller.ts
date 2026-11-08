/**
 * 眨眼控制器（任务书 Part 7 / PR-01 范围内的确定性眨眼）。
 *
 * 设计要点：
 *   - 种子化 PRNG（mulberry32）：给定相同 seed 与相同的 update 时刻序列，
 *     眨眼节奏完全可复现，可进入确定性测试，也不引入真正的随机抖动
 *   - 单次眨眼 120~180ms，两相曲线：闭合（easeIn）→ 睁开（easeOut），
 *     曲线连续且可中断（改情绪 / 手动让位不产生跳变）
 *   - 情绪调制：tired 眨得更慢更久、surprised 更频繁、focused 更少等
 *   - 手动让位：手动源持有眼睛参数期间（setManualHold(true)）不输出眨眼值，
 *     并顺延眨眼节奏，避免与用户拖动打架
 *
 * 输出语义：{ eyeLOpen, eyeROpen } 是「睁眼乘数」0~1（1 = 完全睁开）。
 * 消费方应将期望的开眼值与本乘数相乘（或取 min）后再提交 ParamMixer，
 * 本控制器不直接决定开眼幅度。
 */

/** mulberry32：32 位种子 PRNG，输出 [0, 1) */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const easeInQuad = (t: number): number => t * t;
const easeOutQuad = (t: number): number => 1 - (1 - t) * (1 - t);
const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t);

/** 情绪对眨眼节奏的调制（未登记的情绪回退 neutral） */
export const EMOTION_BLINK_MODULATION = {
  neutral: { intervalScale: 1, durationScale: 1 },
  happy: { intervalScale: 0.9, durationScale: 1 },
  shy: { intervalScale: 0.85, durationScale: 1.1 },
  curious: { intervalScale: 1, durationScale: 1 },
  tired: { intervalScale: 1.6, durationScale: 1.35 },
  focused: { intervalScale: 1.25, durationScale: 0.9 },
  surprised: { intervalScale: 0.7, durationScale: 1.2 },
} as const;

export interface BlinkControllerOptions {
  /** PRNG 种子；默认固定值保证默认行为可复现 */
  seed?: number;
  /** 眨眼间隔下限，默认 2200ms */
  minIntervalMs?: number;
  /** 眨眼间隔上限，默认 5800ms */
  maxIntervalMs?: number;
  /** 单次眨眼时长，默认 150ms（120~180 区间） */
  blinkDurationMs?: number;
  /** 闭合相占比，默认 0.45 */
  closeRatio?: number;
}

const DEFAULT_BLINK_SEED = 20261108;
const DEFAULT_MIN_INTERVAL_MS = 2200;
const DEFAULT_MAX_INTERVAL_MS = 5800;
const DEFAULT_BLINK_DURATION_MS = 150;
const DEFAULT_CLOSE_RATIO = 0.45;
/** 顺延 / 调制后的间隔硬下限，防止调制参数把间隔压成 0 */
const MIN_SCHEDULED_INTERVAL_MS = 200;

export interface BlinkFrame {
  eyeLOpen: number;
  eyeROpen: number;
}

export class BlinkController {
  private rand: () => number;
  private minIntervalMs: number;
  private maxIntervalMs: number;
  private blinkDurationMs: number;
  private closeRatio: number;

  private modulation: { intervalScale: number; durationScale: number } = EMOTION_BLINK_MODULATION.neutral;
  private nextBlinkAtMs: number;
  private blinkStartMs = -1;
  private manualHold = false;

  constructor(options: BlinkControllerOptions = {}) {
    this.rand = mulberry32(options.seed ?? DEFAULT_BLINK_SEED);
    this.minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.maxIntervalMs = Math.max(this.minIntervalMs, options.maxIntervalMs ?? DEFAULT_MAX_INTERVAL_MS);
    this.blinkDurationMs = Math.max(1, options.blinkDurationMs ?? DEFAULT_BLINK_DURATION_MS);
    const ratio = options.closeRatio ?? DEFAULT_CLOSE_RATIO;
    this.closeRatio = clamp01(ratio) <= 0 ? DEFAULT_CLOSE_RATIO : clamp01(ratio);
    this.nextBlinkAtMs = this.drawInterval();
  }

  /** 设置情绪调制；眨眼进行中不中断当前一次，只影响下一次间隔与时长 */
  setEmotion(emotion: string): void {
    const mod = (EMOTION_BLINK_MODULATION as Record<string, { intervalScale: number; durationScale: number }>)[emotion];
    this.modulation = mod ?? EMOTION_BLINK_MODULATION.neutral;
  }

  /**
   * 手动让位开关。true 期间不输出眨眼（返回全开），下一次眨眼顺延；
   * 关闭让位后从顺延后的时间点恢复节奏。
   */
  setManualHold(hold: boolean): void {
    this.manualHold = hold;
  }

  isManualHold(): boolean {
    return this.manualHold;
  }

  /**
   * 推进一帧。@param nowMs 单调递增毫秒时间（由调用方提供，保持确定性）
   */
  update(nowMs: number): BlinkFrame {
    // 手动让位：不消耗眨眼节奏，顺延到让位结束后再眨
    if (this.manualHold) {
      if (nowMs >= this.nextBlinkAtMs) {
        this.nextBlinkAtMs = nowMs + this.drawInterval();
      }
      return { eyeLOpen: 1, eyeROpen: 1 };
    }

    // 一次眨眼进行中
    if (this.blinkStartMs >= 0) {
      const duration = Math.max(1, this.blinkDurationMs * this.modulation.durationScale);
      const u = (nowMs - this.blinkStartMs) / duration;
      if (u >= 1) {
        this.blinkStartMs = -1;
        this.nextBlinkAtMs = nowMs + this.drawInterval();
        return { eyeLOpen: 1, eyeROpen: 1 };
      }
      // u < 0（时钟回拨）等异常由 clamp01 兜底为全开，不产生越界曲线
      const open = clamp01(
        u < this.closeRatio
          ? 1 - easeInQuad(u / this.closeRatio)
          : easeOutQuad((u - this.closeRatio) / Math.max(1e-9, 1 - this.closeRatio)),
      );
      return { eyeLOpen: open, eyeROpen: open };
    }

    // 到点启动一次眨眼
    if (nowMs >= this.nextBlinkAtMs) {
      this.blinkStartMs = nowMs;
      return this.update(nowMs);
    }

    return { eyeLOpen: 1, eyeROpen: 1 };
  }

  /** 重置节奏（换模型 / 回滚用）。传 seed 可整体重置 PRNG。 */
  reset(seed?: number): void {
    if (seed !== undefined) this.rand = mulberry32(seed);
    this.modulation = EMOTION_BLINK_MODULATION.neutral;
    this.blinkStartMs = -1;
    this.manualHold = false;
    this.nextBlinkAtMs = this.drawInterval();
  }

  /** 抽取下一次眨眼间隔（含情绪调制与硬下限） */
  private drawInterval(): number {
    const base = this.minIntervalMs + this.rand() * (this.maxIntervalMs - this.minIntervalMs);
    return Math.max(MIN_SCHEDULED_INTERVAL_MS, base * this.modulation.intervalScale);
  }
}
