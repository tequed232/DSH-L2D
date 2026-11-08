/**
 * Parameter Ownership 与 ParamMixer（任务书 Part 6）。
 *
 * 多个控制源（Safety / Manual / Tracking / LLM / Interaction / Motion / Micro）
 * 会同时想写同一批面部参数，必须统一仲裁后再交给 Cubism Adapter。
 *
 * 求值规则（按 priority 升序应用，后写覆盖前写，即高优先级最后落地）：
 *   - override ：直接取贡献值（weight 忽略）
 *   - weighted ：向贡献值按 weight 插值（加权混合，保留下层值的部分影响）
 *   - additive ：在当前值上叠加 delta * weight（不改变参数归属）
 *   - 归属（owner）：最后一个 override / weighted 写入者
 *   - 诊断口径：被严格更高优先级写入覆盖的落地计入 skippedWrites；
 *     被完全压制的写入仍先落地再被覆盖（升序求值语义，非跳过）
 *
 * 必须防住的任务书五类事故：
 *   1. 手动控制被后台 LLM 覆盖   → manual(900) > llm(≤700)，升序求值天然保证
 *   2. 摄像头输入永久占用参数     → source timeout（来源停止提交即释放）
 *   3. Motion 播放完成后无法释放  → expiresAt / source timeout 双保险
 *   4. 微表情与主表情相互冲突     → micro(200) 最低优先级，主表情可直接覆盖
 *   5. 多个动作争夺头部角度       → 每参数单 owner，同参多源必经本仲裁
 *
 * 注意：本 Mixer 工作在语义参数键上（FaceParameters 键或真实参数 ID 均可），
 * 调用方决定键空间；范围钳制按 options.ranges 提供，未声明的参数不裁剪。
 */

export type ControlMode = 'override' | 'additive' | 'weighted';

export interface ParameterContribution {
  source: string;
  parameterId: string;
  value: number;

  priority: number;
  weight: number;

  mode: ControlMode;

  timestamp: number;
  expiresAt?: number;
}

/** 建议初始优先级表（任务书 Part 6）。LLM 的 priority 经 validator 钳制 ≤ 700。 */
export const SOURCE_PRIORITY = {
  safety: 1000,
  manual: 900,
  tracking: 800,
  interaction: 600,
  motion: 400,
  micro: 200,
} as const;

export type SourceName = keyof typeof SOURCE_PRIORITY;

/** LLM 声明的 priority 上限（与 validator.LIMITS.maxPriority 一致） */
export const LLM_MAX_PRIORITY = 700;

/** 来源超时：超过该时长未再提交的来源视为已释放（默认 500ms，一帧级别冗余） */
export const DEFAULT_SOURCE_TIMEOUT_MS = 500;

export interface MixerRange {
  min: number;
  max: number;
}

export interface ParamMixerOptions {
  /** 参数合法范围；未声明的参数不裁剪 */
  ranges?: Record<string, MixerRange>;
  /** 来源超时毫秒数，默认 500 */
  sourceTimeoutMs?: number;
}

export interface MixerStepSnapshot {
  /** 最终输出值（含基线值） */
  values: Record<string, number>;
  /** 每个参数的归属来源（最后一个 override/weighted 写入者；无写入者时不存在键） */
  owners: Record<string, string>;
  /** 本帧因超时 / 过期被释放的来源（去重） */
  expiredSources: string[];
  /** 被更高优先级写入覆盖的落地次数（诊断用） */
  skippedWrites: number;
}

const clamp = (v: number, min: number, max: number): number => (v < min ? min : v > max ? max : v);

export class ParamMixer {
  /** parameterId → (source → 最新贡献) */
  private contributions = new Map<string, Map<string, ParameterContribution>>();
  private ranges: Map<string, MixerRange>;
  private sourceTimeoutMs: number;
  private lastSnapshot: MixerStepSnapshot = { values: {}, owners: {}, expiredSources: [], skippedWrites: 0 };

  constructor(options: ParamMixerOptions = {}) {
    this.ranges = new Map(Object.entries(options.ranges ?? {}));
    const timeout = options.sourceTimeoutMs ?? DEFAULT_SOURCE_TIMEOUT_MS;
    this.sourceTimeoutMs = timeout > 0 ? timeout : DEFAULT_SOURCE_TIMEOUT_MS;
  }

  /** 提交 / 更新一条贡献。同 source 同参数以最新一次为准。非有限值直接忽略。 */
  submit(contribution: ParameterContribution): this {
    if (!Number.isFinite(contribution.value)) return this;
    let perParam = this.contributions.get(contribution.parameterId);
    if (!perParam) {
      perParam = new Map<string, ParameterContribution>();
      this.contributions.set(contribution.parameterId, perParam);
    }
    perParam.set(contribution.source, {
      ...contribution,
      weight: clamp(Number.isFinite(contribution.weight) ? contribution.weight : 1, 0, 1),
    });
    return this;
  }

  /** 便捷入口：单参数提交（timestamp 由调用方提供，保持确定性） */
  submitValue(
    source: string,
    parameterId: string,
    value: number,
    options: {
      priority: number;
      timestamp: number;
      mode?: ControlMode;
      weight?: number;
      expiresAt?: number;
    },
  ): this {
    return this.submit({
      source,
      parameterId,
      value,
      priority: options.priority,
      weight: options.weight ?? 1,
      mode: options.mode ?? 'override',
      timestamp: options.timestamp,
      expiresAt: options.expiresAt,
    });
  }

  /** 显式释放某来源的全部参数（Motion 完成 / 摄像头关闭时调用） */
  clearSource(source: string): this {
    for (const perParam of this.contributions.values()) perParam.delete(source);
    return this;
  }

  /** 显式释放某来源对某参数的控制权 */
  clearParameter(source: string, parameterId: string): this {
    this.contributions.get(parameterId)?.delete(source);
    return this;
  }

  hasSource(source: string): boolean {
    for (const perParam of this.contributions.values()) {
      if (perParam.has(source)) return true;
    }
    return false;
  }

  /**
   * 求值一帧。
   * @param nowMs 当前时间（由调用方提供，保持确定性，便于测试）
   * @param baseValues 基线值（待机 / 物理 / 默认姿势），作为第一层
   */
  step(nowMs: number, baseValues: Record<string, number> = {}): MixerStepSnapshot {
    const work = new Map<string, number>(Object.entries(baseValues));
    const owners = new Map<string, string>();
    const expired = new Set<string>();
    let skippedWrites = 0;

    // ---- 过期清理：expiresAt 到点或来源超时都释放
    for (const [parameterId, perParam] of this.contributions) {
      for (const [source, c] of perParam) {
        const expires = c.expiresAt !== undefined && nowMs >= c.expiresAt;
        const timedOut = nowMs - c.timestamp > this.sourceTimeoutMs;
        if (expires || timedOut) {
          perParam.delete(source);
          expired.add(source);
        }
      }
      if (perParam.size === 0) this.contributions.delete(parameterId);
    }

    // ---- 逐参数求值
    for (const [parameterId, perParam] of this.contributions) {
      const ordered = [...perParam.values()].sort(
        (a, b) => a.priority - b.priority || a.source.localeCompare(b.source),
      );

      let value = work.get(parameterId) ?? 0;
      let owner: string | null = null;
      let ownerPriority = -Infinity;

      for (const c of ordered) {
        if (c.mode === 'additive') {
          // 叠加不改变归属；由范围钳制兜底
          value += c.value * c.weight;
          continue;
        }

        // override / weighted：低于现有 owner 优先级的写入必然被覆盖，直接跳过
        if (c.priority < ownerPriority) {
          skippedWrites++;
          continue;
        }

        // 严格更高优先级覆盖既有 owner：被覆盖的那次写入计为 suppressed
        // （升序求值下 ownerPriority 分支不可达，真正被压的写是这里——诊断面口径与注释一致）
        if (owner !== null && c.priority > ownerPriority) {
          skippedWrites++;
        }

        value = c.mode === 'override' ? c.value : value + (c.value - value) * c.weight;
        owner = c.source;
        ownerPriority = c.priority;
      }

      const range = this.ranges.get(parameterId);
      const final = Number.isFinite(value) ? (range ? clamp(value, range.min, range.max) : value) : 0;

      work.set(parameterId, final);
      if (owner !== null) owners.set(parameterId, owner);
    }

    this.lastSnapshot = {
      values: Object.fromEntries(work),
      owners: Object.fromEntries(owners),
      expiredSources: [...expired].sort(),
      skippedWrites,
    };
    return this.lastSnapshot;
  }

  /** 不推进时间，直接读最近一次 step 的结果（诊断面板用） */
  snapshot(): MixerStepSnapshot {
    return this.lastSnapshot;
  }

  /** 清空全部状态（换模型 / 回滚用） */
  reset(): void {
    this.contributions.clear();
    this.lastSnapshot = { values: {}, owners: {}, expiredSources: [], skippedWrites: 0 };
  }
}
