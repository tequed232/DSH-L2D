/**
 * ParamMixer —— 参数仲裁器
 *
 * 解决的问题：面捕、表情、动作、口型、待机微动作会同时想写同一个 Live2D 参数。
 * 若无仲裁，表现为抖动、抽帧、表情「打架」。
 *
 * 规则（与 docs/DSH-L2D-技术方案-v0.1.md §4.1 一致）：
 *   1. 分层求值：按 priority 升序依次应用，后写覆盖前写
 *   2. 动作锁：hardLock 通道占用参数后，低优先级通道不得再写
 *   3. 口型硬覆盖：lipSync 通道为最高优先级，任何人不得覆盖
 *   4. 软切换：每个参数有独立时间常数，避免突变
 */

export type ParamId = string;

export interface ParamRange {
  min: number;
  max: number;
}

export type BlendMode = 'override' | 'add';

export interface ChannelSpec {
  /** 通道标识，如 'idle' | 'motion' | 'tracking' | 'lipsync' */
  id: string;
  /** 数值越大优先级越高，求值时按升序应用 */
  priority: number;
  /** override：加权插值到目标值；add：在已有值上叠加增量 */
  mode: BlendMode;
  /** 混合权重 0~1，默认 1 */
  weight?: number;
  /** 为 true 时，该通道写入的参数会被锁定，低优先级通道跳过 */
  hardLock?: boolean;
  /** 目标参数值（override 为绝对值，add 为增量） */
  values: Record<ParamId, number>;
}

interface ChannelState {
  id: string;
  priority: number;
  mode: BlendMode;
  weight: number;
  hardLock: boolean;
  enabled: boolean;
  values: Record<ParamId, number>;
}

/** 参数名 → 过渡时间常数（ms）。按前缀匹配，越靠前优先级越高。 */
const TIME_CONSTANT_RULES: Array<[RegExp, number]> = [
  [/^ParamEye(L|R)Open$/i, 30],
  [/^ParamEyeBall/i, 40],
  [/^Param(Eye|Brow)/i, 40],
  [/Mouth|^ParamMouth/i, 25],
  [/^ParamAngle[XYZ]$/i, 120],
  [/^Angle[XYZ]$/i, 120],
  [/^ParamBodyAngle/i, 300],
  [/Breath/i, 900],
];

const DEFAULT_TIME_CONSTANT = 80;

export interface MixerOptions {
  /** 参数合法范围；未声明的参数不裁剪 */
  ranges?: Record<ParamId, ParamRange>;
  /** 覆盖默认时间常数 */
  timeConstants?: Record<ParamId, number>;
}

export interface StepSnapshot {
  /** 最终输出值 */
  values: Record<ParamId, number>;
  /** 每个参数的归属通道（最后一个硬锁它的通道） */
  owners: Record<ParamId, string>;
  /** 本帧被跳过的写入次数，用于调试 */
  skippedWrites: number;
}

const clamp = (v: number, min: number, max: number): number => (v < min ? min : v > max ? max : v);

/** 一阶低通：返回本帧应移动的比例 */
const alphaOf = (dtMs: number, tauMs: number): number => {
  if (tauMs <= 0) return 1;
  return 1 - Math.exp(-dtMs / tauMs);
};

export class ParamMixer {
  private channels = new Map<string, ChannelState>();
  private smoothed = new Map<ParamId, number>();
  private ranges: Map<ParamId, ParamRange>;
  private tcOverride: Map<ParamId, number>;
  private lastSnapshot: StepSnapshot = { values: {}, owners: {}, skippedWrites: 0 };

  constructor(options: MixerOptions = {}) {
    this.ranges = new Map(Object.entries(options.ranges ?? {}));
    this.tcOverride = new Map(Object.entries(options.timeConstants ?? {}));
  }

  // ------------------------------------------------------------ 通道管理

  upsert(spec: ChannelSpec): this {
    const prev = this.channels.get(spec.id);
    this.channels.set(spec.id, {
      id: spec.id,
      priority: spec.priority,
      mode: spec.mode,
      weight: spec.weight ?? 1,
      hardLock: spec.hardLock ?? false,
      enabled: prev?.enabled ?? true,
      values: { ...(spec.values ?? {}) },
    });
    return this;
  }

  remove(id: string): this {
    this.channels.delete(id);
    return this;
  }

  setEnabled(id: string, enabled: boolean): this {
    const ch = this.channels.get(id);
    if (ch) ch.enabled = enabled;
    return this;
  }

  setWeight(id: string, weight: number): this {
    const ch = this.channels.get(id);
    if (ch) ch.weight = clamp(weight, 0, 1);
    return this;
  }

  /** 局部更新某通道的参数值，常用于每帧写入口型/视线 */
  patchValues(id: string, values: Record<ParamId, number>): this {
    const ch = this.channels.get(id);
    if (ch) Object.assign(ch.values, values);
    return this;
  }

  /** 整体替换某通道的参数值（清掉上一帧残留，避免脏数据） */
  replaceValues(id: string, values: Record<ParamId, number>): this {
    const ch = this.channels.get(id);
    if (ch) ch.values = { ...values };
    return this;
  }

  has(id: string): boolean {
    return this.channels.has(id);
  }

  // ------------------------------------------------------------ 求值

  /**
   * 求值一帧。
   * @param dtMs 距上一帧的毫秒数
   * @param baseValues 基线值（待机/物理/默认姿势），作为第一层
   */
  step(dtMs: number, baseValues: Record<ParamId, number> = {}): StepSnapshot {
    const work = new Map<ParamId, number>(Object.entries(baseValues));
    const owners = new Map<ParamId, string>();
    let skippedWrites = 0;

    const ordered = [...this.channels.values()]
      .filter((c) => c.enabled && c.weight > 0)
      .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));

    for (const ch of ordered) {
      for (const paramId of Object.keys(ch.values)) {
        // 已被更高优先级的硬锁通道占用
        if (owners.has(paramId)) {
          skippedWrites++;
          continue;
        }

        const target = ch.values[paramId];
        if (!Number.isFinite(target)) continue;

        const prev = work.get(paramId) ?? 0;
        // weight 为 1 时直接取目标值，避免 prev + (target - prev) * 1 的浮点误差
        const next =
          ch.mode === 'add'
            ? prev + target * ch.weight
            : ch.weight >= 1
              ? target
              : prev + (target - prev) * ch.weight;

        const range = this.ranges.get(paramId);
        work.set(paramId, range ? clamp(next, range.min, range.max) : next);

        if (ch.hardLock) owners.set(paramId, ch.id);
      }
    }

    // 平滑：每个参数独立时间常数。
    // 首帧无历史值时以基座值为起点，避免上电瞬间硬切。
    const out: Record<ParamId, number> = {};
    for (const [paramId, target] of work) {
      const tau = this.resolveTimeConstant(paramId);
      const prev = this.smoothed.get(paramId) ?? baseValues[paramId] ?? 0;
      const next = prev + (target - prev) * alphaOf(dtMs, tau);
      this.smoothed.set(paramId, next);
      out[paramId] = next;
    }

    this.lastSnapshot = {
      values: out,
      owners: Object.fromEntries(owners),
      skippedWrites,
    };
    return this.lastSnapshot;
  }

  /** 不打平滑，直接读当前内部状态（用于调试面板） */
  snapshot(): StepSnapshot {
    return this.lastSnapshot;
  }

  /** 清空全部状态，用于换模型 */
  reset(): void {
    this.channels.clear();
    this.smoothed.clear();
    this.lastSnapshot = { values: {}, owners: {}, skippedWrites: 0 };
  }

  private resolveTimeConstant(paramId: ParamId): number {
    const override = this.tcOverride.get(paramId);
    if (override !== undefined) return override;
    for (const [pattern, tau] of TIME_CONSTANT_RULES) {
      if (pattern.test(paramId)) return tau;
    }
    return DEFAULT_TIME_CONSTANT;
  }
}
