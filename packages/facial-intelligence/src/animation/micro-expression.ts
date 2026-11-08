/**
 * Micro Expression Engine（任务书 Part 7）。
 *
 * 微表情引擎不需要每帧请求 LLM：LLM 只决定情绪目标，微表情引擎产生
 * 细微、连续、可中断的变化，以最低优先级（SOURCE_PRIORITY.micro=200）进 ParamMixer。
 *
 * 硬规则：
 *   - 不使用真正随机的高频参数抖动；一切波形都是时间的确定性函数
 *   - 波形周期一律 ≥ 1.2s（MICRO_MIN_PERIOD_MS 强制下限），低频呼吸感
 *   - 情绪切换带淡入 ramp，避免目标突跳（叠加大幅变化的平滑在 FacialController）
 *   - 输出钳制在 FACE_PARAMETER_BOUNDS 内
 */
import {
  DEFAULT_FACE_PARAMETERS,
  FACE_PARAMETER_BOUNDS,
} from '../controller/facial-controller.ts';
import type { FaceParameterKey } from '../controller/facial-controller.ts';

export type MicroParamKey = FaceParameterKey;

/** 单条低频波形：value(t) = amplitude * sin(2π · t / periodMs + phase) */
export interface MicroWave {
  amplitude: number;
  /** 弧度相位偏移，让不同参数不同步，避免「机械同频」 */
  phase: number;
  /** 周期毫秒；引擎强制 ≥ MICRO_MIN_PERIOD_MS */
  periodMs: number;
}

export interface MicroTemplate {
  /** 情绪的静态基线目标（任务书示范模板，实际需结合模型资源校准） */
  base: Partial<Record<MicroParamKey, number>>;
  /** 叠加在基线上的低频波动 */
  waves?: Partial<Record<MicroParamKey, MicroWave>>;
  /** 淡入时长；缺省用引擎默认 */
  rampMs?: number;
}

/** 波形周期硬下限：低于它的配置会被强制抬到这里 */
export const MICRO_MIN_PERIOD_MS = 1200;

/** 淡入默认时长 */
export const MICRO_DEFAULT_RAMP_MS = 300;

/**
 * 六个情绪模板（任务书 Part 7 表格 + 示范代码）。
 * 数值是语义层目标，不是模型参数配置；未列出的参数不写。
 */
export const MICRO_TEMPLATES: Record<string, MicroTemplate> = {
  // 轻微眨眼感（由眨眼控制器承担主要眨眼）、眼睛弯曲、嘴角上扬
  happy: {
    base: { eyeLOpen: 0.88, eyeROpen: 0.88, mouthForm: 0.45 },
    waves: {
      eyeLOpen: { amplitude: 0.02, phase: 0, periodMs: 1600 },
      eyeROpen: { amplitude: 0.02, phase: Math.PI / 3, periodMs: 1600 },
      mouthForm: { amplitude: 0.05, phase: Math.PI / 2, periodMs: 1600 },
    },
  },

  // 视线偏移、头部轻微低下
  shy: {
    base: { eyeLOpen: 0.78, eyeROpen: 0.78, eyeBallX: -0.25, angleY: 0.12 },
    waves: {
      eyeBallX: { amplitude: 0.05, phase: 0, periodMs: 2000 },
      angleY: { amplitude: 0.02, phase: Math.PI / 4, periodMs: 2000 },
    },
  },

  // 单侧眉毛抬起由映射层承担（FaceParameters 无眉毛键）；轻微歪头在这里表达
  curious: {
    base: { eyeLOpen: 0.95, eyeROpen: 0.95, angleZ: 0.2, eyeBallX: 0.1 },
    waves: {
      angleZ: { amplitude: 0.04, phase: 0, periodMs: 1800 },
      eyeBallX: { amplitude: 0.06, phase: Math.PI / 2, periodMs: 1800 },
    },
  },

  // 眼睛开合减小、眨眼变慢（眨眼节奏由 BlinkController 的 tired 调制负责）
  tired: {
    base: { eyeLOpen: 0.65, eyeROpen: 0.65, angleY: 0.15 },
    waves: {
      eyeLOpen: { amplitude: 0.04, phase: 0, periodMs: 2400 },
      eyeROpen: { amplitude: 0.04, phase: Math.PI / 3, periodMs: 2400 },
    },
  },

  // 视线稳定、头部动作减少：基线贴近中性，波形幅度极小
  focused: {
    base: { eyeLOpen: 0.92, eyeROpen: 0.92, eyeBallX: 0, eyeBallY: 0, angleX: 0, angleY: 0, angleZ: 0 },
    waves: {
      eyeLOpen: { amplitude: 0.01, phase: 0, periodMs: 2000 },
      eyeROpen: { amplitude: 0.01, phase: Math.PI / 2, periodMs: 2000 },
    },
  },

  // 眼睛张开、眉毛抬高（眉毛经映射层 / Expression 资源表达）
  surprised: {
    base: { eyeLOpen: 1, eyeROpen: 1, mouthOpen: 0.1, angleY: -0.05 },
    waves: {
      mouthOpen: { amplitude: 0.02, phase: 0, periodMs: 1500 },
    },
  },
};

export interface MicroExpressionEngineOptions {
  /** 默认淡入时长 */
  rampMs?: number;
}

export class MicroExpressionEngine {
  private emotion = '';
  private intensity = 0;
  /** 情绪设置时刻；同情绪重复设置不重置，保证波形连续 */
  private setAtMs = 0;
  private rampMs: number;

  constructor(options: MicroExpressionEngineOptions = {}) {
    this.rampMs = options.rampMs ?? MICRO_DEFAULT_RAMP_MS;
  }

  /** 设置情绪目标。intensity 钳到 0~1；切换情绪时重置淡入起点。 */
  setEmotion(emotion: string, intensity: number, nowMs: number): void {
    const clamped = Math.max(0, Math.min(1, Number.isFinite(intensity) ? intensity : 0));
    if (emotion !== this.emotion) {
      this.setAtMs = nowMs;
    }
    this.emotion = emotion;
    this.intensity = clamped;
  }

  /** 显式清空（回到无微表情状态；输出为空对象即不写任何参数） */
  clear(): void {
    this.emotion = '';
    this.intensity = 0;
  }

  getEmotion(): string {
    return this.emotion;
  }

  /**
   * 计算本帧微表情目标。纯时间函数 + 确定性波形，无随机源。
   * 返回值为「目标参数值」（绝对语义值，幅度已乘 intensity 与淡入系数），
   * 交给调用方以 SOURCE_PRIORITY.micro 提交进 ParamMixer。
   */
  update(nowMs: number): Partial<Record<MicroParamKey, number>> {
    if (this.emotion === '' || this.intensity <= 0) return {};

    const template = MICRO_TEMPLATES[this.emotion];
    if (!template) return {};

    const ramp = Math.max(0, Math.min(1, (nowMs - this.setAtMs) / Math.max(1, this.rampMs)));
    if (ramp <= 0) return {};

    const out: Partial<Record<MicroParamKey, number>> = {};
    const keys = new Set<MicroParamKey>([
      ...(Object.keys(template.base) as MicroParamKey[]),
      ...(template.waves ? (Object.keys(template.waves) as MicroParamKey[]) : []),
    ]);

    for (const key of keys) {
      let value = template.base[key] ?? 0;
      const wave = template.waves?.[key];
      if (wave) {
        const periodMs = Math.max(MICRO_MIN_PERIOD_MS, wave.periodMs);
        value += wave.amplitude * Math.sin((2 * Math.PI * nowMs) / periodMs + wave.phase);
      }

      const bounds = FACE_PARAMETER_BOUNDS[key];
      const scaled = value * this.intensity * ramp;
      if (Number.isFinite(scaled)) {
        out[key] = Math.max(bounds.min, Math.min(bounds.max, scaled));
      }
    }

    // neutral 基线自检：无 base 也无 waves 的模板不应产出空壳键
    if (Object.keys(out).length === 0 && DEFAULT_FACE_PARAMETERS) return {};
    return out;
  }
}
