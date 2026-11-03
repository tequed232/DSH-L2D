/**
 * Motion Adapter（M1-d / WS-2 接口预留，Embodied-Behavior §6 + AIRI Phase B）。
 *
 * 职责：模型能力的**只读**校验面——capabilities 快照、`canOwn` / `canPlay` / `canWrite`
 * 查询。Adapter 不计算能力，只消费渲染入口 `L.getCapabilities()`（packages/renderer/src/index.ts）
 * 的结果与 physics3.json 输出表；换模型后由集成方重新喂快照（AIRI Phase B：
 * model switch invalidates profile）。
 *
 * 边界：
 * - 只定义接口与只读查询，不改帧循环；写路径仍只走 ParamInjector。
 *   M1-b 起 PhysicsGate 为真实现（Hip* pre 让位 + limb post 覆盖），全部行为在
 *   `embodied.m1` flag 后面（默认 false = 现行为）。
 * - 对 core 的 LimbController 依赖只用 `LimbControlLike` 接口：WS-1 会提供实现，
 *   方法语义对齐 Embodied-Behavior §6（acquire / release；resolve 为每帧写计划出口）。
 *   精确签名在集成日与 WS-1 对齐；本文件先约束形状，避免 renderer 反向依赖 core 实现。
 */

/** 口型红线（R9）：与 param-injector.ts 的 MOUTH_PARAMS 同源（core LIPSYNC_PARAMS）。 */
import { LIPSYNC_PARAMS } from '../../../core/src/index.ts';
import { physicsYield } from '../fw/physics/physics-yield.ts';

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

// ---------------------------------------------------------------- PhysicsGate（M1-b）

/** feature flag：默认 false = 现行为。任何渲染层行为变化都必须在它后面（全局约束 4）。 */
export interface EmbodiedFlags {
  'embodied.m1'?: boolean;
  /**
   * [M1-e] 连续动作 Mixer（Idle/Ambient/Media 收敛）。默认 false = M1-b 集成后基线；
   * 运行路径尚未接线（core 侧纯函数已落地，连续层写声明消费方在后续批次提供），
   * flag 先行注册保证回滚开关面完整。
   */
  'embodied.m1e'?: boolean;
  /**
   * [M1-d2] 手势时间线动作面（admitGesture 准入 / kfTick 到期旁挂 / playKeyframes
   * armed 纵深防御 / admitAct 打断钩子）。默认 false = 现行为逐字节不变；
   * 回滚 = 把 DEFAULT_EMBODIED_FLAGS['embodied.timeline'] 改回 false，无需回退代码。
   */
  'embodied.timeline'?: boolean;
  /**
   * [M1-f 第二批] EmbodiedCue 行为闭环（admitCue 接线：编译 → 时间线准入 → 账本 →
   * 每帧写值 / 表情开关）。默认 false = 现行为逐字节不变；依赖 embodied.timeline
   * 作为 hold/transition 的准入闸（timeline 关 → cue 整体 disabled）。
   * 回滚 = 把 DEFAULT_EMBODIED_FLAGS['embodied.cue'] 改回 false，无需回退代码。
   */
  'embodied.cue'?: boolean;
}

export const DEFAULT_EMBODIED_FLAGS: Readonly<
  Required<Pick<EmbodiedFlags, 'embodied.m1' | 'embodied.m1e' | 'embodied.timeline' | 'embodied.cue'>>
> = {
  'embodied.m1': false,
  'embodied.m1e': false,
  'embodied.timeline': false,
  'embodied.cue': false,
};

/**
 * PhysicsGate 的依赖注入面（全部可选；缺省 = 对应职责降级为空操作）。
 * 渲染层在 index.ts 装配时传入真实实现，node 单测传 mock——gate 本体零硬编码参数名。
 */
export interface PhysicsGateDeps {
  /**
   * [pre] 让位集合数据源：当前被 Agent 独占且相位为 pre 的参数 id
   * （index.ts 接 `injector.getPreOwnedIds()`；实际只有 HipAngleX/Y/Z 能以 pre 相位登记）。
   * 缺省 = 每帧清空让位表（等效无人独占）。
   */
  preOwnedIds?(): string[];
  /**
   * [post] limb 控制器（LimbControlLike：acquire/release/resolve，见本文件上方接口）。
   * resolve(now) 返回本帧叶子四肢写值；空表 = 无写入（空帧无副作用）。
   * 缺省 = post 不做 limb 覆盖（M1-a 的 injector post 路径照常工作）。
   */
  limb?: LimbControlLike | null;
  /**
   * [post] limb 写值落点：签名对齐 injector.set（index.ts 接
   * `(core, id, value) => injector.set(core, id, value, 1)`）。
   * 只在提供 `limb` 且 resolve 非空时调用。缺省 = resolve 结果丢弃（诊断仍可见）。
   */
  stagePostWrite?(core: unknown, id: string, value: number): void;
  /** [post] resolve 的时钟（缺省 performance.now/Date.now，测试注入用）。 */
  now?(): number;
}

/**
 * M1-b PhysicsGate：Hip* pre 通道 + 物理生产者让位（Embodied-Behavior 拍板 1、冲突 C9）。
 *
 * 两个调用位置（index.ts 已接线，注释点即本实现的启用位置）：
 * - `pre`：物理前 —— pre 钩子内、`injector.apply(core, 'pre')` 之后、UpdateScheduler
 *   （Physics600）之前。把 `deps.preOwnedIds()` 整体写入 fw/physics/physics-yield
 *   登记表：evaluate 跳过让位参数的 `_parameterCaches` 回写（chained 裙摆/腿链设置
 *   读到 Agent pre 值，次级链随动）、interpolate 跳过 parameterValues 落写
 *   （Agent 值不被物理覆盖）。振子状态照常推进，release 后物理平滑接管。
 * - `post`：物理后 —— post 钩子内、`injector.apply(core, 'post')` 之前（Pose800 之后）。
 *   `deps.limb.resolve(now)` 非空时逐项经 `deps.stagePostWrite` 登记 set 写，
 *   随后的 injector.apply('post') 后写胜出（叶子四肢 post 覆盖，M1-a 语义）。
 *
 * flag=false（默认）时 pre/post 是直接 return 的空实现，帧循环行为与 main 完全一致；
 * 让位表也不会被触碰（flag 关 = 逐字节现行为，M1-a 语义不变式）。
 */
export interface PhysicsGate {
  readonly enabled: boolean;
  /** 物理前调用点（见类注释「两个调用位置」）。flag 关 = 空操作。 */
  pre(core: unknown): void;
  /** 物理后调用点（同上）。flag 关 = 空操作。 */
  post(core: unknown): void;
  /** 释放让位登记（mount destroy 时调用）；flag 关时也为空操作。 */
  dispose(): void;
}

/**
 * 创建 PhysicsGate。`flags['embodied.m1']` 缺省/false → enabled=false，pre/post 为空实现。
 * deps 全部可选：未接线的职责按「无该通道」处理，不影响其余通道。
 */
export function createPhysicsGate(flags: EmbodiedFlags = {}, deps: PhysicsGateDeps = {}): PhysicsGate {
  const enabled = flags['embodied.m1'] === true;
  return {
    enabled,
    pre(_core: unknown): void {
      // [M1-b] 生产者让位：本帧独占的 pre 相位参数（Hip*）整体替换进让位登记表。
      // 空数组 = 全部恢复物理写入（release / 到期 / flag 关的统一路径）。
      if (!enabled) return;
      const ids = deps.preOwnedIds ? deps.preOwnedIds() : [];
      physicsYield.replace(ids);
    },
    post(core: unknown): void {
      // [M1-b] limb 通道：resolve 本帧写值，经 stagePostWrite（injector.set）登记，
      // 由紧随其后的 injector.apply(core, 'post') 后写胜出。
      if (!enabled) return;
      const limb = deps.limb;
      if (!limb || !deps.stagePostWrite) return;
      const now = deps.now ? deps.now() : Date.now();
      const writes = limb.resolve(now);
      if (!writes || writes.size === 0) return; // 空帧无副作用
      for (const [id, value] of writes) {
        if (!Number.isFinite(value)) continue;
        deps.stagePostWrite(core, id, value);
      }
    },
    dispose(): void {
      if (!enabled) return;
      physicsYield.clear();
    },
  };
}
