/**
 * Embodied Cue 编译层（REFERENCE-WHALEL2D-ARCHITECTURE.md §6「Embodied Cue 协议设计」/ §8 M1-f）。
 *
 * 把结构化 EmbodiedCue（Body.cs Word 七字段的定稿收敛）编译进现有 Gesture Timeline /
 * 共享通道仲裁——**不做自由文本解析，不新增绕过 shared arbitration / resolveWritePlan
 * 的写入路径**。四操作映射（§6.2）：
 * - hold      → 一个 GestureSegment（params = 绑定表映射后的原生值域；durationMs 缺省
 *   省略 → endAt null 长期持有，gesture-timeline.ts:43-44/283-286 同语义）；
 * - transition → 一个 GestureSegment：params = 参数域声明（值为曲线**终点 0**，仅作
 *   冲突租约域），durationMs = 曲线总长；曲线写值本身走既有 keyframes 写路径
 *   （WriteIntent source 'keyframes'，秩 3）——v1 不给 GestureSegment 加 keyframes 字段
 *   （不偷偷加契约字段，motion-intent.ts:16-17 同原则）；
 * - overlay   → 一条 SharedChannelUse（表情占用声明，互斥由画像 conflicts 数据裁决）
 *   + 一条 renderer 表情开关（setExpression/clearExpression 对）；
 * - clear     → 一条 StopSelector（group = 'cue:<channel>'，stopGesture 按 group 收窄）；
 *   带 target 时追加一条表情关闭开关。
 *
 * 同通道替换 / 跨通道并存语义**交给现有 gesture-timeline 冲突判定**（domainsOverlap
 * gesture-timeline.ts:173-176；整批原子替换 :313-320），本层不重复实现：
 * 同通道两 hold → 绑定表相同 → 参数域完全重叠 → 后来者整批取代（Body.cs:198
 * 「后来者取代」的参数域泛化）；不同通道 → 词表约定参数域不相交 → 并存。
 *
 * fail-closed（§6.2，对齐 gesture-timeline.ts:239-248「不产生任何副作用」与
 * shared-arbitration.ts:116-129「判不出来就拒绝，不猜」）：未知 channel、未知 operation、
 * 非有限 value、interruptible:false（v1 仅接受 true/缺省——Timeline 无「不可打断」语义，
 * 硬造会破坏同级可打断规则）、非法 priority/durationMs/binding → 全部进 rejected，
 * segments/sharedUses/stops/overlays 零产出、调用方状态零变化。不设白名单兜底放行。
 *
 * 设计约束：
 * - 全部纯函数：不修改入参；同一输入任意次编译输出一致（INV-8 同型，键序随绑定表
 *   声明序，确定性）；
 * - 能力驱动铁律：channel → 原生参数域的映射全部来自 CueChannelBinding **数据**
 *   （随词表/画像提供），本文件零模型参数名（种子词表 CUE_SEED_BINDINGS 是数据，
 *   是本文件的消费素材而非硬编码分支）；
 * - feature flag：`M1F_DEFAULT_ENABLED`（缺省 false）= 编译层不接线，渲染层现行为
 *   零变化（§6.5 回滚要求，模式同 M1_DEFAULT_ENABLED / M1E_DEFAULT_ENABLED）；
 *   编译器本身是纯函数，不在 flag 后也有单测价值。
 */
import {
  isSemanticPriority,
  isSemanticSource,
  type SemanticPriority,
  type SemanticSource,
} from './motion-contract.ts';
import type { GestureSegment, StopSelector } from './gesture-timeline.ts';
import type { SharedChannelUse } from './shared-arbitration.ts';

/** M1-f 统一 feature flag：默认关闭 = 编译层不接线（§6.5 回滚要求）。 */
export const M1F_DEFAULT_ENABLED = false;

/**
 * EmbodiedCue（§6.1 v1 词汇，字段不多不少）。
 */
export interface EmbodiedCue {
  /** cue 通道 id：词表数据里的键（gaze/tilt/turn/pitch/lean 的泛化），非硬编码。 */
  channel: string;
  operation: 'hold' | 'transition' | 'overlay' | 'clear';
  /** overlay：表情资产 id；clear：要清除的资产（缺省 = 本 channel 全清）。 */
  target?: string;
  /** hold：归一化语义值（[-1,1]），经绑定表映射到原生参数。 */
  value?: number;
  /** hold：持有租约时长（缺省长期持有）；transition：曲线总长（缺省 = 曲线长，v1 无曲线引用 → 必填，缺了 fail-closed）。 */
  durationMs?: number;
  /** ActGate 档位（10/50/90），缺省 50；非法值编译期拒绝。 */
  priority?: SemanticPriority;
  /** v1 仅接受 true/缺省；false 直接拒（Timeline 无「不可打断」语义，不硬造）。 */
  interruptible?: boolean;
}

/** 单参数映射域：native = clamp(value * scale + offset, bounds)（motion-intent.ts:52-55 同口径）。 */
export interface CueChannelParamBinding {
  scale?: number;
  offset?: number;
  bounds?: readonly [number, number];
}

/**
 * 通道绑定（§6.1）：channel → 原生参数域（即该通道的「冲突域」）。
 * 与 motion-intent.ts 的 ChannelBinding 同型精神：模型差异（参数名/量程/缩放）只能出现在数据里。
 */
export interface CueChannelBinding {
  channel: string;
  params: Record<string, CueChannelParamBinding>;
}

export interface EmbodiedCueCompileResult {
  /** 进 enqueueGesture（gesture-timeline.ts:210）。 */
  segments: GestureSegment[];
  /** 进 arbitrateShared（shared-arbitration.ts:110）——表情类共享通道占用声明。 */
  sharedUses: SharedChannelUse[];
  /** 进 stopGesture（gesture-timeline.ts:362）。 */
  stops: StopSelector[];
  /** 进 renderer setExpression/clearExpression 的表情开关对。 */
  overlays: Array<{ name: string; on: boolean }>;
  /** fail-closed 回执：任何不合法输入在此列明，绝不静默丢弃。 */
  rejected: Array<{ channel: string; operation: string; reason: string }>;
}

export interface EmbodiedCueCompileOptions {
  /** 执行轮次绑定（R12 同语义），透传给段与占用声明。 */
  runId?: string;
  /** intent source（INV-6 source 秩词汇）；缺省 'motion'。 */
  source?: SemanticSource;
}

const CUE_OPERATIONS: readonly EmbodiedCue['operation'][] = ['hold', 'transition', 'overlay', 'clear'];

/** 校验通道绑定数据本身（词表装配时调用；编译期逐 cue 也复用同一校验，fail-closed 前置到资产层）。 */
function validateBinding(binding: CueChannelBinding): string | null {
  if (!binding || typeof binding !== 'object' || typeof binding.channel !== 'string' || !binding.channel) {
    return 'invalid-binding';
  }
  const params = binding.params;
  if (!params || typeof params !== 'object' || Array.isArray(params)) return 'invalid-binding';
  const keys = Object.keys(params);
  if (!keys.length) return 'invalid-binding';
  for (const key of keys) {
    if (!key) return 'invalid-binding';
    const p = params[key];
    if (!p || typeof p !== 'object' || Array.isArray(p)) return 'invalid-binding';
    if (p.scale !== undefined && (typeof p.scale !== 'number' || !Number.isFinite(p.scale))) return 'invalid-binding';
    if (p.offset !== undefined && (typeof p.offset !== 'number' || !Number.isFinite(p.offset))) return 'invalid-binding';
    if (p.bounds !== undefined) {
      const b = p.bounds;
      if (!Array.isArray(b) || b.length !== 2 || !Number.isFinite(b[0]) || !Number.isFinite(b[1]) || b[0] > b[1]) {
        return 'invalid-binding';
      }
    }
  }
  return null;
}

/**
 * 归一化语义值 → 原生值（motion-intent.ts:178-187 同型：乘加后 clamp 进 bounds）。
 * 导出供 cue-loop.ts 的逐帧写值复用同一映射（值域只有一份定义，避免词表漂移）。
 */
export function mapCueParamValue(value: number, binding: CueChannelParamBinding): number {
  const native = value * (binding.scale ?? 1) + (binding.offset ?? 0);
  if (!Number.isFinite(native)) return native; // 溢出交由调用方按 invalid-value fail-closed
  if (binding.bounds) {
    return Math.min(Number(binding.bounds[1]), Math.max(Number(binding.bounds[0]), native));
  }
  return native;
}

/**
 * 编译一条 EmbodiedCue（纯函数，§6.2 签名）。
 *
 * 返回的四个产物数组按各自的既有入口消费（segments → enqueueGesture、sharedUses →
 * arbitrateShared、stops → stopGesture、overlays → renderer 表情开关）；rejected 非空时
 * 对应产物保证为零产出（逐条 fail-closed，不半产出）。
 */
export function compileEmbodiedCue(
  cue: EmbodiedCue | null | undefined,
  bindings: readonly CueChannelBinding[],
  now: number,
  options: EmbodiedCueCompileOptions = {},
): EmbodiedCueCompileResult {
  const empty: EmbodiedCueCompileResult = { segments: [], sharedUses: [], stops: [], overlays: [], rejected: [] };
  const fail = (channel: string, operation: string, reason: string): EmbodiedCueCompileResult => ({
    ...empty,
    rejected: [{ channel, operation, reason }],
  });

  if (!cue || typeof cue !== 'object' || Array.isArray(cue)) {
    return fail('*', '*', 'invalid-cue');
  }
  const channel = typeof cue.channel === 'string' ? cue.channel : '';
  if (!channel) return fail('*', '*', 'invalid-channel');
  const op = cue.operation;
  const opStr = typeof op === 'string' ? op : '*';
  if (!CUE_OPERATIONS.includes(op)) return fail(channel, opStr, 'unknown-operation');
  // v1 仅接受 true/缺省：Timeline 无「不可打断」语义，传 false 直接拒（§6.1）。
  if (cue.interruptible === false) return fail(channel, opStr, 'not-interruptible');
  if (cue.priority !== undefined && !isSemanticPriority(cue.priority)) {
    return fail(channel, opStr, 'invalid-priority');
  }
  if (
    cue.durationMs !== undefined &&
    (typeof cue.durationMs !== 'number' || !Number.isFinite(cue.durationMs) || cue.durationMs <= 0)
  ) {
    return fail(channel, opStr, 'invalid-duration');
  }
  if (cue.value !== undefined && (typeof cue.value !== 'number' || !Number.isFinite(cue.value))) {
    return fail(channel, opStr, 'invalid-value');
  }
  if (options.source !== undefined && !isSemanticSource(options.source)) {
    return fail(channel, opStr, 'invalid-source');
  }

  // 词表查表（数据驱动，零硬编码通道）：查无即拒，不猜（§6.2 fail-closed）。
  // 注意：Array.isArray 对 readonly 数组的收窄会降级元素类型（TS 5.9 实测），
  // 这里用显式注解的中间数组保住 CueChannelBinding 元素类型。
  const list: readonly CueChannelBinding[] = Array.isArray(bindings) ? bindings : [];
  const binding = list.find((b) => b && b.channel === channel);
  if (!binding) return fail(channel, opStr, 'unknown-channel');
  const bindingError = validateBinding(binding);
  if (bindingError) return fail(channel, opStr, bindingError);

  const priority: SemanticPriority = cue.priority ?? 50;
  const source: SemanticSource = options.source ?? 'motion';

  if (op === 'hold') {
    if (cue.value === undefined) return fail(channel, opStr, 'missing-value');
    const params: Record<string, number> = {};
    for (const [paramId, paramBinding] of Object.entries(binding.params)) {
      const native = mapCueParamValue(cue.value, paramBinding);
      if (!Number.isFinite(native)) return fail(channel, opStr, 'invalid-value');
      params[paramId] = native;
    }
    const segment: GestureSegment = {
      id: 'cue:' + channel + ':hold',
      group: 'cue:' + channel,
      params,
      priority,
      source,
    };
    if (cue.durationMs !== undefined) segment.durationMs = cue.durationMs;
    if (options.runId !== undefined) segment.runId = options.runId;
    return { ...empty, segments: [segment] };
  }

  if (op === 'transition') {
    // 缺省 = 曲线长；v1 cue 无曲线引用可查 → durationMs 必填，缺了 fail-closed。
    if (cue.durationMs === undefined) return fail(channel, opStr, 'missing-duration');
    // params = 参数域声明，值为曲线终点 0（仅作冲突租约域；每帧值是采样不是静态值）。
    const params: Record<string, number> = {};
    for (const paramId of Object.keys(binding.params)) params[paramId] = 0;
    const segment: GestureSegment = {
      id: 'cue:' + channel + ':transition',
      group: 'cue:' + channel,
      params,
      durationMs: cue.durationMs,
      priority,
      source,
    };
    if (options.runId !== undefined) segment.runId = options.runId;
    return { ...empty, segments: [segment] };
  }

  if (op === 'overlay') {
    if (typeof cue.target !== 'string' || !cue.target) return fail(channel, opStr, 'missing-target');
    // 表情资产清单校验（target ∈ 画像 assets）属画像接线职责（第二批），v1 只校验非空。
    const use: SharedChannelUse = {
      channelId: cue.target,
      priority,
      startedAt: now,
      endsAt: cue.durationMs !== undefined ? now + cue.durationMs : null,
    };
    if (options.runId !== undefined) use.runId = options.runId;
    return { ...empty, sharedUses: [use], overlays: [{ name: cue.target, on: true }] };
  }

  // clear：缺省 = 本 channel 全清（group 锚点）；带 target 追加表情关闭开关。
  const stops: StopSelector[] = [{ group: 'cue:' + channel }];
  const overlays: EmbodiedCueCompileResult['overlays'] = [];
  if (cue.target !== undefined) {
    if (typeof cue.target !== 'string' || !cue.target) return fail(channel, opStr, 'invalid-target');
    overlays.push({ name: cue.target, on: false });
  }
  return { ...empty, stops, overlays };
}

/** bounds 元组便捷构造（as const 保证推断为 [number, number] 而非 readonly number[]）。 */
const bounds = (min: number, max: number): readonly [number, number] => Object.freeze([min, max]) as readonly [number, number];

/**
 * 种子词表（数据，非代码）：大肥鱼 cdi3 真实参数名核实依据——
 * - tilt（歪头）→ AngleZ：renderer/index.ts:907 `ANGLE_BUS_CAP = { AngleZ: 15, ... }`
 *   （head.roll 通道，capability-scan 画像 controls[head.roll].sourceId='AngleZ'；
 *   WHALE 对应物 FaceAngleZ 16° 是 VTS 侧参数名，本仓模型无此参数）；
 * - pitch/yaw（点头/转头）→ AngleY/AngleX：renderer/index.ts:1499-1501 gaze 跟随
 *   `gx * 20`（注释：20°/g 换算，VTS 设计满量程 ±30）；
 * - lean（前倾）→ LeanInput：renderer/index.ts:1482 clamp ±30
 *   （画像 controls[torso.lean].sourceId='LeanInput'）；
 * - gaze（眼神）→ ParamEyeBallX/Y：画像 controls[gaze.x/gaze.y] min/max ±1，
 *   renderer/index.ts:1536-1537 直写 gazeState.cur（±1 归一化）。
 * 各通道参数域互不相交（§6.3 跨通道并存的词表数据约定）。
 */
const CUE_SEED_LIST: readonly CueChannelBinding[] = [
  { channel: 'tilt', params: { AngleZ: { scale: 15, bounds: bounds(-15, 15) } } },
  { channel: 'pitch', params: { AngleY: { scale: 20, bounds: bounds(-30, 30) } } },
  { channel: 'yaw', params: { AngleX: { scale: 20, bounds: bounds(-30, 30) } } },
  { channel: 'lean', params: { LeanInput: { scale: 30, bounds: bounds(-30, 30) } } },
  {
    channel: 'gaze',
    params: {
      ParamEyeBallX: { scale: 1, bounds: bounds(-1, 1) },
      ParamEyeBallY: { scale: 1, bounds: bounds(-1, 1) },
    },
  },
];
export const CUE_SEED_BINDINGS: readonly CueChannelBinding[] = Object.freeze(CUE_SEED_LIST);
