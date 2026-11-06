/**
 * Cue Loop（M1-f 第二批 F2-1/3/4）：EmbodiedCue 的组合语义与生命周期状态机。
 *
 * 分层职责（不重复实现，全部复用既有纯函数）：
 * - 编译：compileEmbodiedCue（embodied-cue.ts）负责 fail-closed 校验与四入口产物
 *   （segments/sharedUses/stops/overlays）；
 * - 准入/冲突：渲染层把 segments 交给 enqueueGesture（gesture-timeline.ts）判定——
 *   同通道（参数域重叠）后者替换、跨通道并存、低不打断高，全部沿用既有语义；
 * - 本文件只做**被准入之后的组合账本**：记住每个 channel 当前持有的值/到期时刻、
 *   当前表情叠加层，输出逐帧写值表与到期/释放清单。
 *
 * 为什么需要账本：GestureSegment 的 params 只是「冲突域 + 值」（gesture-timeline.ts:49-50），
 * 时间线本身不产生写路径（d2 的段由 keyframes 播放器写值）。cue 的 hold 没有曲线资产，
 * 必须由调用方按帧把当前 channel 值写出去；账本即这份「当前值」的唯一来源。
 *
 * 语义（对齐 REFERENCE-WHALEL2D-ARCHITECTURE.md §3.1 / Body.cs:198）：
 * - 同 channel 后到替换前到（账本按 channel 单槽；准入侧由参数域冲突再兜一层）；
 * - 跨 channel 并存；**不做 WHALE 式跨通道求和**（本仓每参数唯一 winner，INV-1）；
 *   万一两个通道绑定同一参数（词表错误），写值表按 priority desc → channel id 升序
 *   选唯一 winner，loser 记入 conflicts，绝不叠加；
 * - 生命周期：durationMs 缺省 = 长期持有（endsAt null，须显式 clear）；有限时到期即释放
 *   （endAt <= now，INV-5/S-05 同型）；overlay 同一时刻只有一层（Cubism 表情是单槽）。
 * - clear 是显式释放（与 stopGesture 同语义，不受 priority 限制）：按 channel 收窄；
 *   带 target 时只关闭同名表情层，channel 仍释放。
 *
 * 纯函数：不修改入参；同一输入任意次调用输出深相等（INV-8 同型，输出键排序）。
 */
import {
  compileEmbodiedCue,
  mapCueParamValue,
  type CueChannelBinding,
  type EmbodiedCue,
  type EmbodiedCueCompileOptions,
  type EmbodiedCueCompileResult,
} from './embodied-cue.ts';
import type { SemanticPriority } from './motion-contract.ts';

/** 缺省档位（与 ActGate / GestureTimeline 同一份 NORMAL）。 */
export const CUE_DEFAULT_PRIORITY: SemanticPriority = 50;

/** 通道账本条目（同一 channel 只有一条 = 同通道替换）。 */
export interface CueChannelState {
  channel: string;
  operation: 'hold' | 'transition';
  /** hold 的归一化语义值；transition v1 无曲线引用 → 只占域不写值。 */
  value?: number;
  priority: SemanticPriority;
  startedAt: number;
  /** null = 长期持有（须显式 clear / 被同通道替换）。 */
  endsAt: number | null;
  runId?: string;
}

/** 表情叠加层（Cubism 表达式单槽；新 overlay 替换旧层）。 */
export interface CueOverlayState {
  name: string;
  priority: SemanticPriority;
  startedAt: number;
  endsAt: number | null;
  runId?: string;
}

export interface CueLoopState {
  /** channel → 当前持有；键序不参与语义，输出一律排序。 */
  channels: Readonly<Record<string, CueChannelState>>;
  overlay: CueOverlayState | null;
}

export interface CueCommitOptions extends EmbodiedCueCompileOptions {
  /**
   * 合法表情资产清单（渲染层从 model3.json 的 FileReferences.Expressions 提供）。
   * 缺省不校验（纯逻辑测试）；提供时未知 target → fail-closed 'unknown-overlay'
   * （编译层 v1 只校验非空，清单校验归第二批接线职责）。
   */
  knownOverlays?: readonly string[];
}

export interface CueCommitResult {
  /** 被接受后的新状态；rejected 非空时 === 入参 state（零副作用）。 */
  state: CueLoopState;
  /** 编译产物（rejected 时四产物全空）。 */
  compiled: EmbodiedCueCompileResult;
  accepted: boolean;
  rejected: EmbodiedCueCompileResult['rejected'];
}

export interface CueTickResult {
  state: CueLoopState;
  /** 本次到期释放的 channel（稳定排序）。 */
  expiredChannels: string[];
  /** 本次到期关闭的表情层（无则 null）。 */
  expiredOverlay: string | null;
}

export interface CueReleaseSelector {
  channel?: string;
  runId?: string;
  /** 只关闭该名称的表情层；channel 释放与表情释放可同时给出（AND 收窄）。 */
  overlay?: string;
}

export interface CueReleaseResult {
  state: CueLoopState;
  /** 被释放的 channel（稳定排序）。 */
  releasedChannels: string[];
  /** 被释放的表情层名称。 */
  releasedOverlay: string | null;
}

export interface CueWritesResult {
  /** 参数 id → 值（键按 id 升序；每参数唯一 winner，不求和）。 */
  writes: Record<string, number>;
  /** 参数 id → 拥有它的 channel（诊断）。 */
  owners: Record<string, string>;
  /** 同参数多通道冲突（词表错误才会出现；确定性 winner 已选定）。 */
  conflicts: Array<{ paramId: string; winner: string; losers: string[] }>;
}

export interface CueSnapshot {
  channels: Array<{
    channel: string;
    operation: CueChannelState['operation'];
    value: number | null;
    priority: number;
    startedAt: number;
    endsAt: number | null;
    runId: string | null;
    params: string[];
  }>;
  overlay: {
    name: string;
    priority: number;
    startedAt: number;
    endsAt: number | null;
    runId: string | null;
  } | null;
}

const ZERO_COMPILE: EmbodiedCueCompileResult = {
  segments: [],
  sharedUses: [],
  stops: [],
  overlays: [],
  rejected: [],
};

export const emptyCueLoop = (): CueLoopState => ({ channels: {}, overlay: null });

const toTime = (now: unknown): number => {
  const n = Number(now);
  return Number.isFinite(n) ? n : 0;
};

const endsAtOf = (startedAt: number, durationMs: number | undefined): number | null =>
  typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs > 0
    ? startedAt + durationMs
    : null;

const sortedKeys = (record: Readonly<Record<string, unknown>>): string[] =>
  Object.keys(record).sort((a, b) => a.localeCompare(b));

/**
 * 编译 + 账本提交（纯函数）。
 *
 * 调用顺序（渲染层）：commitCue 得到候选 state/segments → 有 segments 时先过
 * admitGesture（时间线准入）→ 准入成功才把候选 state 落账。这样同通道替换/低不打断高
 * 只有一份判定（enqueueGesture），本文件不做第二套优先级规则。
 *
 * fail-closed：编译拒绝或缺省清单外的表情 → 返回入参 state、四产物全空、rejected 非空。
 */
export function commitCue(
  state: CueLoopState | null | undefined,
  cue: EmbodiedCue | null | undefined,
  bindings: readonly CueChannelBinding[],
  now: number,
  options: CueCommitOptions = {},
): CueCommitResult {
  const base = state && typeof state === 'object' && state.channels ? state : emptyCueLoop();
  const compiled = compileEmbodiedCue(cue, bindings, now, options);
  if (compiled.rejected.length) {
    return { state: base, compiled: { ...ZERO_COMPILE, rejected: compiled.rejected }, accepted: false, rejected: compiled.rejected };
  }

  const t = toTime(now);
  const priority: SemanticPriority = cue?.priority ?? CUE_DEFAULT_PRIORITY;
  const op = cue!.operation;
  const channel = cue!.channel;
  const channels = { ...base.channels };
  let overlay = base.overlay;

  if (op === 'hold') {
    const entry: CueChannelState = {
      channel,
      operation: 'hold',
      value: cue!.value,
      priority,
      startedAt: t,
      endsAt: endsAtOf(t, cue!.durationMs),
    };
    if (options.runId !== undefined) entry.runId = options.runId;
    channels[channel] = entry;
  } else if (op === 'transition') {
    const entry: CueChannelState = {
      channel,
      operation: 'transition',
      priority,
      startedAt: t,
      endsAt: endsAtOf(t, cue!.durationMs),
    };
    if (options.runId !== undefined) entry.runId = options.runId;
    channels[channel] = entry;
  } else if (op === 'overlay') {
    const target = cue!.target as string;
    const known = options.knownOverlays;
    if (Array.isArray(known) && !known.includes(target)) {
      const rejected = [{ channel, operation: op, reason: 'unknown-overlay' }];
      return { state: base, compiled: { ...ZERO_COMPILE, rejected }, accepted: false, rejected };
    }
    const next: CueOverlayState = {
      name: target,
      priority,
      startedAt: t,
      endsAt: endsAtOf(t, cue!.durationMs),
    };
    if (options.runId !== undefined) next.runId = options.runId;
    overlay = next;
  } else {
    // clear：显式释放，不收 priority 限制（与 stopGesture 同语义）。
    delete channels[channel];
    if (cue!.target !== undefined && overlay && overlay.name === cue!.target) overlay = null;
  }

  return { state: { channels, overlay }, compiled, accepted: true, rejected: [] };
}

/** 到期清理（每帧调用；pure）。endAt <= now 视为已释放（INV-5 / S-05 同型）。 */
export function tickCue(state: CueLoopState | null | undefined, now: number): CueTickResult {
  const base = state && typeof state === 'object' && state.channels ? state : emptyCueLoop();
  const t = toTime(now);
  const channels: Record<string, CueChannelState> = {};
  const expiredChannels: string[] = [];
  for (const key of sortedKeys(base.channels)) {
    const entry = base.channels[key];
    if (entry.endsAt !== null && entry.endsAt <= t) expiredChannels.push(entry.channel);
    else channels[key] = entry;
  }
  let overlay = base.overlay;
  let expiredOverlay: string | null = null;
  if (overlay && overlay.endsAt !== null && overlay.endsAt <= t) {
    expiredOverlay = overlay.name;
    overlay = null;
  }
  if (!expiredChannels.length && !expiredOverlay) return { state: base, expiredChannels: [], expiredOverlay: null };
  return { state: { channels, overlay }, expiredChannels, expiredOverlay };
}

/**
 * 显式释放（stopGesture 同语义）：selector 缺省 = 全清；给出字段按 AND 收窄。
 * channel 与 overlay 可同时给出（clear 带 target 的场景；channel 释放与表情关闭互不替代）。
 */
export function releaseCue(
  state: CueLoopState | null | undefined,
  selector?: CueReleaseSelector,
): CueReleaseResult {
  const base = state && typeof state === 'object' && state.channels ? state : emptyCueLoop();
  const channels: Record<string, CueChannelState> = { ...base.channels };
  const releasedChannels: string[] = [];
  const overlaySelector = selector?.overlay;
  // 只给 overlay 时不碰 channel；只给 channel 时不碰表情（两套释放面互不替代）。
  const touchChannels = !selector || selector.channel !== undefined || selector.runId !== undefined;
  const touchOverlay = !selector || overlaySelector !== undefined || selector.runId !== undefined;

  if (touchChannels) {
    for (const key of sortedKeys(channels)) {
      const entry = channels[key];
      const match =
        (!selector || selector.channel === undefined || entry.channel === selector.channel) &&
        (selector?.runId === undefined || entry.runId === selector.runId);
      if (match) {
        releasedChannels.push(entry.channel);
        delete channels[key];
      }
    }
  }

  let overlay = base.overlay;
  let releasedOverlay: string | null = null;
  if (overlay && touchOverlay) {
    const match =
      (overlaySelector === undefined || overlay.name === overlaySelector) &&
      (selector?.runId === undefined || overlay.runId === selector.runId);
    if (match) {
      releasedOverlay = overlay.name;
      overlay = null;
    }
  }

  if (!releasedChannels.length && releasedOverlay === null) {
    return { state: base, releasedChannels: [], releasedOverlay: null };
  }
  return { state: { channels, overlay }, releasedChannels, releasedOverlay };
}

/**
 * 当前应写出的参数表（每帧调用；pure）。
 *
 * 只输出 hold（transition v1 无曲线引用 → 零写值，仅占域）；同参数多通道时按
 * priority desc → channel id 升序选唯一 winner（INV-1 唯一 winner，不求和）。
 */
export function cueWrites(
  state: CueLoopState | null | undefined,
  bindings: readonly CueChannelBinding[],
): CueWritesResult {
  const base = state && typeof state === 'object' && state.channels ? state : emptyCueLoop();
  const list: readonly CueChannelBinding[] = Array.isArray(bindings) ? bindings : [];
  const claimed = new Map<string, { value: number; owner: string; priority: SemanticPriority }>();
  const conflicts: CueWritesResult['conflicts'] = [];

  for (const channel of sortedKeys(base.channels)) {
    const entry = base.channels[channel];
    if (entry.operation !== 'hold' || entry.value === undefined) continue;
    const binding = list.find((b) => b && b.channel === entry.channel);
    if (!binding || !binding.params) continue;
    for (const paramId of Object.keys(binding.params).sort((a, b) => a.localeCompare(b))) {
      const native = mapCueParamValue(entry.value, binding.params[paramId]);
      if (!Number.isFinite(native)) continue;
      const prev = claimed.get(paramId);
      if (!prev) {
        claimed.set(paramId, { value: native, owner: entry.channel, priority: entry.priority });
        continue;
      }
      const challengerWins =
        entry.priority > prev.priority ||
        (entry.priority === prev.priority && entry.channel.localeCompare(prev.owner) < 0);
      const winner = challengerWins ? entry.channel : prev.owner;
      const loser = challengerWins ? prev.owner : entry.channel;
      const existing = conflicts.find((c) => c.paramId === paramId);
      if (existing) {
        if (!existing.losers.includes(loser)) existing.losers.push(loser);
        existing.winner = winner;
        existing.losers.sort((a, b) => a.localeCompare(b));
      } else {
        conflicts.push({ paramId, winner, losers: [loser] });
      }
      if (challengerWins) claimed.set(paramId, { value: native, owner: entry.channel, priority: entry.priority });
    }
  }

  const writes: Record<string, number> = {};
  const owners: Record<string, string> = {};
  for (const paramId of [...claimed.keys()].sort((a, b) => a.localeCompare(b))) {
    const hit = claimed.get(paramId)!;
    writes[paramId] = hit.value;
    owners[paramId] = hit.owner;
  }
  conflicts.sort((a, b) => a.paramId.localeCompare(b.paramId));
  return { writes, owners, conflicts };
}

/** 诊断快照（getCueState 数据源；键与通道稳定排序，参数域取自词表数据）。 */
export function cueSnapshot(
  state: CueLoopState | null | undefined,
  bindings: readonly CueChannelBinding[],
): CueSnapshot {
  const base = state && typeof state === 'object' && state.channels ? state : emptyCueLoop();
  const list: readonly CueChannelBinding[] = Array.isArray(bindings) ? bindings : [];
  const channels = sortedKeys(base.channels).map((key) => {
    const entry = base.channels[key];
    const binding = list.find((b) => b && b.channel === entry.channel);
    return {
      channel: entry.channel,
      operation: entry.operation,
      value: entry.value === undefined ? null : entry.value,
      priority: entry.priority,
      startedAt: entry.startedAt,
      endsAt: entry.endsAt,
      runId: entry.runId ?? null,
      params: binding ? Object.keys(binding.params).sort((a, b) => a.localeCompare(b)) : [],
    };
  });
  return {
    channels,
    overlay: base.overlay
      ? {
          name: base.overlay.name,
          priority: base.overlay.priority,
          startedAt: base.overlay.startedAt,
          endsAt: base.overlay.endsAt,
          runId: base.overlay.runId ?? null,
        }
      : null,
  };
}
