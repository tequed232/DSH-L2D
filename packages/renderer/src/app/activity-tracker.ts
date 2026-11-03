/**
 * ActivityTracker：统一「最近有交互」信号（P1 渲染调度）。
 *
 * 现状问题：帧率门（index.ts computeFps）只用一个 lastActiveAt 时间戳，
 * 拖拽、动作、表情、注视、Agent 状态各自直接写它，来源散、没有口径，
 * 也没有滞回参数——想调「活动结束后多久降帧」要改渲染器本体。
 *
 * 这里把所有活动信号收敛到一个 tracker：
 *   - mark(kind) 记录某类活动发生；
 *   - isActive() 回答「现在是否仍在活动滞回窗口内」；
 *   - 滞回（hysteresis）：活动结束后不立即降帧，等窗口滑出再降，
 *     避免交互间歇性发生时刷新率在 60↔30 之间抖动。
 *
 * 滞回默认值：
 *   - DEFAULT_HYSTERESIS_MS = 2500：与 index.ts 旧帧率门「交互后 2.5s 内保持满帧」
 *     完全一致，保证替换后行为语义不变（前台 60 / 失焦 30 / 交互 60）。
 *   - 需要更强的抗抖动（如 P1 方案提到的 8s）时，用构造参数
 *     { hysteresisMs: 8000 } 覆盖——只有失焦降帧的生效时机会受影响，
 *     前台档位不受影响（前台本来就恒 60）。
 *
 * 本文件保持零依赖、不碰 DOM：所有时间由 now() 注入，node 单测可直接跑。
 */

/** 活动信号类型。system = 可见性恢复/窗口聚焦等环境事件。 */
export type ActivityKind =
  | 'pointer'
  | 'drag'
  | 'motion'
  | 'expression'
  | 'gaze'
  | 'agent'
  | 'system';

export interface ActivityTrackerOptions {
  /** 活动结束后保持「活跃」的滞回时长（ms）。缺省 2500（= 旧帧率门行为）。 */
  hysteresisMs?: number;
  /** 时间源（ms 单调时钟）。缺省 performance.now()；单测注入假时钟。 */
  now?: () => number;
}

/** 旧帧率门的交互保持窗口，替换后必须逐毫秒等价。 */
export const DEFAULT_HYSTERESIS_MS = 2500;
/** P1 方案建议的抗抖动滞回（前台恒 60 的现状下仅影响失焦降帧时机）。 */
export const ANTI_JITTER_HYSTERESIS_MS = 8000;

export class ActivityTracker {
  private readonly hysteresisMs: number;
  private readonly nowFn: () => number;
  private lastAt: number;
  /** 各类型计数：诊断用（getInfo/HUD 想展示「谁在唤醒渲染」时读它）。 */
  private readonly counts: Record<ActivityKind, number> = {
    pointer: 0,
    drag: 0,
    motion: 0,
    expression: 0,
    gaze: 0,
    agent: 0,
    system: 0,
  };

  constructor(opts: ActivityTrackerOptions = {}) {
    this.hysteresisMs = Math.max(0, Number(opts.hysteresisMs) || DEFAULT_HYSTERESIS_MS);
    this.nowFn = opts.now || (typeof performance !== 'undefined' ? () => performance.now() : () => Date.now());
    // 与旧实现一致：模块加载即视为「刚活跃」，首帧不受降载影响。
    this.lastAt = this.nowFn();
  }

  /** 记录一次活动。at 缺省用注入时钟；时间倒流的脏数据会被忽略（取 max）。 */
  mark(kind: ActivityKind, at?: number): void {
    const t = typeof at === 'number' && Number.isFinite(at) ? at : this.nowFn();
    if (t > this.lastAt) this.lastAt = t;
    if (kind in this.counts) this.counts[kind]++;
  }

  /**
   * 是否仍在活动滞回窗口内。
   * @param at 观察时刻（缺省当前），单测用它推演窗口滑动。
   */
  isActive(at?: number): boolean {
    return (typeof at === 'number' ? at : this.nowFn()) - this.lastAt < this.hysteresisMs;
  }

  /** 最近一次活动的时间戳（注入时钟口径）。 */
  lastActiveAt(): number {
    return this.lastAt;
  }

  /** 剩余滞回 ms（≤0 表示已滑出窗口）。 */
  remainingMs(at?: number): number {
    return this.hysteresisMs - ((typeof at === 'number' ? at : this.nowFn()) - this.lastAt);
  }

  /** 各类型 mark 次数快照（诊断）。 */
  stats(): Record<ActivityKind, number> {
    return { ...this.counts };
  }
}

// ---------------------------------------------------------------- reduced-motion
//
// prefers-reduced-motion：系统级「减少动态效果」偏好。渲染不能停（角色是常驻
// 视觉锚点），但自发动作（ambient 微动作）应当降频——这里只提供两个纯函数，
// 策略（降多少）留在调用方，node 单测不碰 matchMedia。

/**
 * 读取系统 reduced-motion 偏好。环境不支持 matchMedia（node/老 WebView）或
 * 查询抛错时按 false 处理：能力缺失时不能反向「更减少」。
 */
export function prefersReducedMotion(win?: {
  matchMedia?: (q: string) => { matches: boolean };
}): boolean {
  try {
    const w = win || (typeof window !== 'undefined' ? window : null);
    if (!w || typeof w.matchMedia !== 'function') return false;
    return !!w.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * ambient 动作准入门（纯函数）。
 *
 * - 未开启 reduced-motion：永远放行（现状行为，ambient 由既有遮挡/抢占逻辑管）。
 * - 开启 reduced-motion：按冷却降频而非停渲染——冷却窗内拒绝，窗外放行。
 *   lastStartedAt=-Infinity 表示「从未播过」，首次直接放行。
 *
 * @param reduced    系统是否要求减少动态
 * @param lastStartedAt 上一次真正 startAmbient 的时刻（同口径单调 ms）
 * @param now        当前时刻
 * @param cooldownMs reduced-motion 下的最小间隔；默认 20000（正常路径 ambient
 *                   由情绪路由自发触发，间隔远小于此，即约降到 1/6 频率）
 */
export const REDUCED_MOTION_AMBIENT_COOLDOWN_MS = 20000;

export function shouldStartAmbient(
  reduced: boolean,
  lastStartedAt: number,
  now: number,
  cooldownMs: number = REDUCED_MOTION_AMBIENT_COOLDOWN_MS,
): boolean {
  if (!reduced) return true;
  return now - lastStartedAt >= cooldownMs;
}
