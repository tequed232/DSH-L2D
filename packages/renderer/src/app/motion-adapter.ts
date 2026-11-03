/**
 * Motion Adapter（M1-d / WS-2 接口预留，Embodied-Behavior §6 + AIRI Phase B）。
 *
 * 职责：模型能力的**只读**校验面——capabilities 快照、`canOwn` / `canPlay` / `canWrite`
 * 查询。Adapter 不计算能力，只消费渲染入口 `L.getCapabilities()`（packages/renderer/src/index.ts）
 * 的结果与 physics3.json 输出表；换模型后由集成方重新喂快照（AIRI Phase B：
 * model switch invalidates profile）。
 *
 * 边界（本工作流）：
 * - 只定义接口与只读查询，不改帧循环、不引入任何写路径（写仍只走 ParamInjector）。
 * - 对 core 的 LimbController 依赖只用 `LimbControlLike` 接口：WS-1 会提供实现，
 *   方法语义对齐 Embodied-Behavior §6（acquire / release；resolve 为每帧写计划出口）。
 *   精确签名在集成日与 WS-1 对齐；本文件先约束形状，避免 renderer 反向依赖 core 实现。
 * - PhysicsGate 仅挂接点预留（M1-b）：见 `createPhysicsGate`。
 */

/** 口型红线（R9）：与 param-injector.ts 的 MOUTH_PARAMS 同源（core LIPSYNC_PARAMS）。 */
import { LIPSYNC_PARAMS } from '../../../core/src/index.ts';

const MOUTH_PARAMS: ReadonlySet<string> = new Set<string>(LIPSYNC_PARAMS);

// ---------------------------------------------------------------- 能力快照

/**
 * 渲染入口 `getCapabilities()` 的结构快照（packages/renderer/src/index.ts）。
 * 结构对齐但不 import —— 避免与 index.ts 形成循环依赖。
 */
export interface MotionAdapterCapabilities {
  model: string;
  expressions: string[];
  motionGroups: string[];
  params: Array<{ id: string; min: number; max: number; def: number }>;
}

/** `canOwn` 的回执：ownable = 物理输出表内且非口型；ignored = 其余（R10b：非物理 id 忽略、不算错误）。 */
export interface CanOwnResult {
  ownable: string[];
  ignored: Array<{ id: string; reason: 'not-physics-output' | 'lipsync' | 'empty' }>;
}

/**
 * Motion Adapter：capabilities 只读位 + 准入查询（Embodied-Behavior §6「Motion Adapter」行）。
 * 全部方法为纯查询，无副作用；快照未喂入时按「无能力」回答（fail-closed）。
 */
export class MotionAdapter {
  private caps: MotionAdapterCapabilities | null = null;
  private physicsOutputIds: ReadonlySet<string> = new Set();

  /** 喂入 `L.getCapabilities()` 的结果；模型切换 / 重挂载后必须重新喂（快照失效）。 */
  public setCapabilities(caps: MotionAdapterCapabilities | null): void {
    // 只存引用快照，不重算：能力唯一事实源是渲染入口的自省结果。
    this.caps = caps;
  }

  /** 喂入 physics3.json 输出表（index.ts mount 时已拉取并注入 ParamInjector 的同一份）。 */
  public setPhysicsOutputIds(ids: Iterable<string>): void {
    this.physicsOutputIds = new Set(ids);
  }

  /** 当前快照（只读）；未喂入时返回 null。 */
  public capabilities(): MotionAdapterCapabilities | null {
    return this.caps;
  }

  /**
   * canOwn(ids)：物理输出表内的 id 才可被 Agent 认领（R1/R10/R10b）。
   * 口型参数永不放行（R9）。非物理 id 返回 `ignored`，不算错误——
   * 它们仍可走普通 setParameters（不得因 own 语义改写 add/set 注入行为）。
   */
  public canOwn(ids: Iterable<string>): CanOwnResult {
    const ownable: string[] = [];
    const ignored: CanOwnResult['ignored'] = [];
    for (const raw of ids) {
      const id = typeof raw === 'string' ? raw.trim() : '';
      if (!id) {
        ignored.push({ id: String(raw ?? ''), reason: 'empty' });
        continue;
      }
      if (MOUTH_PARAMS.has(id)) {
        ignored.push({ id, reason: 'lipsync' });
        continue;
      }
      if (!this.physicsOutputIds.has(id)) {
        ignored.push({ id, reason: 'not-physics-output' });
        continue;
      }
      ownable.push(id);
    }
    return { ownable, ignored };
  }

  /** 动作组是否已索引（未索引组在入口处拒绝，R11）。 */
  public canPlay(group: string): boolean {
    const caps = this.caps;
    if (!caps) return false;
    return caps.motionGroups.indexOf(group) >= 0;
  }

  /** 参数是否存在于模型（普通写路径准入；物理输出是否可写由 ownership 决定，不在此判定）。 */
  public canWrite(id: string): boolean {
    const caps = this.caps;
    if (!caps) return false;
    // 线性扫即可：快照只在模型切换时重建，且调用频率为「每次指令」而非每帧。
    return caps.params.some((p) => p.id === id);
  }
}

// ---------------------------------------------------------------- LimbControlLike

/** acquire 的选项（对齐 Embodied-Behavior §6：`acquire(ids,{priority,runId,phase})`）。 */
export interface LimbAcquireOptions {
  /** ActGate 优先级语义：BACKGROUND 10 < NORMAL 50 < FORCE 90（R5）。 */
  priority?: number;
  /** 执行轮次绑定；打断/完成/超时按 runId 释放（R7/R12）。 */
  runId?: string;
  /** 叶子四肢固定 post；Hip* 固定 pre（M1-b）。与参数族默认冲突时按 wrong-phase 处理。 */
  phase?: 'pre' | 'post';
  /** 占用时长（毫秒，<=0 长期持有）；超时只是最后保险，主路径是显式 release。 */
  durationMs?: number;
}

/**
 * WS-1 LimbController 在渲染侧的最小依赖面（只按接口消费，不 import core 实现）。
 *
 * 方法语义（Embodied-Behavior §6「Limb Controller」行 + §3 所有权状态机）：
 * - acquire：physics-owned → limb-owned；成功后该参数在独占相位后写胜出（叶子四肢 post）。
 * - release：limb-owned → physics-owned；下一帧物理自然接管，无恢复逻辑（R8）。
 * - resolve：每帧写计划出口——返回本帧 limb 通道对独占参数的最终写值，
 *   供渲染层在正确相位（post / M1-b 的 pre）经 ParamInjector 落地。
 *   返回空表 = 本帧无 limb 写入（空帧无副作用）。
 *
 * 注意：精确签名（尤其 resolve 的出入参）以 WS-1 实现为准，集成日对齐后如有出入，
 * 以本接口向 WS-1 靠拢的改动在 core 侧做，renderer 不持有实现。
 */
export interface LimbControlLike {
  acquire(ids: string[], options?: LimbAcquireOptions): string[];
  release(runId?: string): string[];
  /** @returns 本帧 limb 写值（id → 已按参数 min/max 钳制的目标值）；空表 = 无写入。 */
  resolve(now: number): Map<string, number>;
}

// ---------------------------------------------------------------- PhysicsGate（M1-b 预留）

/** feature flag：默认 false = 现行为。任何渲染层行为变化都必须在它后面（全局约束 4）。 */
export interface EmbodiedFlags {
  'embodied.m1'?: boolean;
}

export const DEFAULT_EMBODIED_FLAGS: Readonly<Required<Pick<EmbodiedFlags, 'embodied.m1'>>> = {
  'embodied.m1': false,
};

/**
 * M1-b PhysicsGate：Hip* pre 通道 + 物理生产者让位的挂接点（Embodied-Behavior 拍板 1、冲突 C9）。
 *
 * 两个调用位置（**当前未接线**，index.ts 对应位置已用注释标出）：
 * - `pre`：物理前 —— pre 钩子内、`injector.apply(core, 'pre')` 之后、UpdateScheduler
 *   （Physics600）之前。启用时负责「生产者设置让位」：让 16 个上游生产者当帧跳过
 *   被 limb-owned 的 Hip* 输出（chained 4/1/3 设置）。
 * - `post`：物理后 —— post 钩子内、`injector.apply(core, 'post')` 之前（Pose800 之后）。
 *   启用时的职责（如让位后的次级链校验/回填）在 M1-b 评审时定。
 *
 * flag=false（默认）时 pre/post 是直接 return 的空实现，帧循环行为与 main 完全一致。
 */
export interface PhysicsGate {
  readonly enabled: boolean;
  /** 物理前调用点（见类注释「两个调用位置」）。空实现。 */
  pre(core: unknown): void;
  /** 物理后调用点（同上）。空实现。 */
  post(core: unknown): void;
}

/**
 * 创建 PhysicsGate。`flags['embodied.m1']` 缺省/false → enabled=false，pre/post 为空实现。
 * M1-b 启用时在 index.ts 的两处注释位置接入调用即可，不需要改本文件语义。
 */
export function createPhysicsGate(flags: EmbodiedFlags = {}): PhysicsGate {
  const enabled = flags['embodied.m1'] === true;
  return {
    enabled,
    pre(_core: unknown): void {
      // M1-b 启用点：生产者让位逻辑。flag 关闭时不得有任何副作用。
      if (!enabled) return;
    },
    post(_core: unknown): void {
      // M1-b 启用点：物理后处理。flag 关闭时不得有任何副作用。
      if (!enabled) return;
    },
  };
}
