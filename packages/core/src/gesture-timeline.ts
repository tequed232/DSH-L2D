/**
 * Gesture Timeline（docs/Embodied-Behavior.md §6「Gesture Timeline」行 / §8 M1-c）。
 *
 * 手势/动作段的时间线编排**纯函数**：入队（group/delayMs/timeoutMs，分组语义与
 * chain-normalize.ts 的并行桶同源——同组段进同一时间桶、整组超时、整组原子打断）、
 * 可打断规则（同级可打断、低不打断高，与 LimbController / ActGate 同一份：
 * incoming.priority >= active.priority 才能占上，见 action-chain.ts `canInterruptAct`）、
 * 到期清理（endAt <= now 视为已释放，INV-5 / S-05 同语义）、
 * `resolveTimeline(now)` 输出当前活跃段。
 *
 * 设计约束：
 * - 全部纯函数：不修改入参 state；同一输入集合任意顺序 → 输出一致（INV-8 同型，
 *   输出按 startAt/id 稳定排序）；entryId 缺省由段 id 派生，不用全局计数器（可重放）；
 * - 能力驱动铁律：段写什么参数由调用方给定（params），本文件零参数名；
 * - 冲突域：段声明的参数 id 重叠才构成抢占关系（LimbController 逐参数判定同型）；
 *   params 为空的段（资产型手势）不与任何段冲突，可与其它段并存；
 * - feature flag：`enabled` 缺省 `M1_DEFAULT_ENABLED`（false = 现行为）——关闭时
 *   入队全拒、resolve 恒空；渲染层旧 playKeyframes 路径不受影响（M1-c 回滚要求）。
 */
import { M1_DEFAULT_ENABLED } from './write-plan.ts';
import { GROUP_TIMEOUT_MAX_MS } from './chain-normalize.ts';
import {
  isSemanticPriority,
  isSemanticSource,
  type SemanticPriority,
  type SemanticSource,
} from './motion-contract.ts';

/** ActGate 缺省档位（NORMAL）。 */
export const DEFAULT_GESTURE_PRIORITY: SemanticPriority = 50;

/**
 * 手势/动作段（调用方视角）。字段语义与 chain-normalize.ts 的 ChainStep 三位
 * （group/delayMs/timeoutMs）同源，priority 与 ActGate（10/50/90）同值。
 */
export interface GestureSegment {
  /** 段稳定标识（同一次入队内去重/排序用）。 */
  id: string;
  /** 并行组：同组段共享投放桶与整组超时（chain-normalize 同语义）。缺省无组。 */
  group?: string;
  /** 投放延迟（ms，>=0）；缺省 0 = 立即。 */
  delayMs?: number;
  /** 单段时长（ms，>0）；缺省长期持有（须显式 stop / 被打断 / 组超时）。 */
  durationMs?: number;
  /** 整组超时（ms）：同组取最大并钳制 GROUP_TIMEOUT_MAX_MS（chain-normalize 同口径）。 */
  timeoutMs?: number;
  /** ActGate 优先级（10/50/90）；缺省 50。 */
  priority?: SemanticPriority;
  /** 写值域：本段会写的参数 id → 值（喂 resolveWritePlan intents 用）；缺省空。 */
  params?: Record<string, number>;
  /** intent source（INV-6 source 秩词汇）；缺省 'motion'。 */
  source?: SemanticSource;
  /** 执行轮次绑定（R12 同语义）。 */
  runId?: string;
}

/** 已排程段（时间线内部视角；startAt/endAt 是绝对时刻）。 */
export interface ScheduledSegment {
  id: string;
  group: string;
  priority: SemanticPriority;
  source: SemanticSource;
  params: Record<string, number>;
  /** 所属入队批次（整组打断/stop 的原子单位）。 */
  entryId: string;
  startAt: number;
  /** null = 长期持有（INV-5 的 expiresAt 缺省语义）。 */
  endAt: number | null;
  runId?: string;
}

export interface GestureTimelineState {
  segments: readonly ScheduledSegment[];
}

export type GestureRejectReason = 'disabled' | 'invalid-segment' | 'priority-blocked';

export interface EnqueueOptions {
  /** feature flag：缺省 M1_DEFAULT_ENABLED（false = 现行为，M1-c 回滚要求）。 */
  enabled?: boolean;
  /** 本次入队批次 id；缺省由段 id 派生（确定性，不用全局计数器）。 */
  entryId?: string;
}

export interface GestureEnqueueResult {
  /** 新状态（不修改入参）。 */
  state: GestureTimelineState;
  entryId: string;
  admitted: ScheduledSegment[];
  rejected: Array<{ id: string; reason: GestureRejectReason; detail?: string }>;
  /** 被抢占的旧段（R7 打断即释放）。 */
  interrupted: ScheduledSegment[];
  /** 入队时顺手清理掉的到期段（INV-5 / S-05，诊断用）。 */
  expired: ScheduledSegment[];
}

export interface TimelineResolution {
  /** startAt <= now 且未到期（endAt === null 或 now < endAt）。 */
  active: ScheduledSegment[];
  /** 尚未到投放时刻。 */
  scheduled: ScheduledSegment[];
  /** 本次 resolve 清理掉的到期段。 */
  expired: ScheduledSegment[];
  /** 清理后的状态。 */
  state: GestureTimelineState;
}

export interface StopSelector {
  entryId?: string;
  runId?: string;
  id?: string;
  group?: string;
}

export interface TimelineStopResult {
  state: GestureTimelineState;
  stopped: ScheduledSegment[];
}

export const emptyTimeline = (): GestureTimelineState => ({ segments: [] });

/** 与 chain-normalize.ts 的 clampTimeout 同口径（该函数未导出，语义以常量对齐）。 */
function clampGroupTimeout(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(GROUP_TIMEOUT_MAX_MS, Math.round(n));
}

function validateSegment(raw: unknown): { ok: true; value: GestureSegment } | { ok: false; detail: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, detail: 'segment must be an object' };
  }
  const s = raw as GestureSegment;
  if (typeof s.id !== 'string' || !s.id) return { ok: false, detail: 'id is required' };
  if (s.group !== undefined && typeof s.group !== 'string') return { ok: false, detail: 'group must be a string' };
  const timings: Array<[string, unknown]> = [
    ['delayMs', s.delayMs],
    ['durationMs', s.durationMs],
    ['timeoutMs', s.timeoutMs],
  ];
  for (const [name, v] of timings) {
    if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v < 0)) {
      return { ok: false, detail: name + ' must be a finite non-negative number' };
    }
  }
  if (s.priority !== undefined && !isSemanticPriority(s.priority)) {
    return { ok: false, detail: 'priority must be 10/50/90' };
  }
  if (s.source !== undefined && !isSemanticSource(s.source)) {
    return { ok: false, detail: 'source is invalid' };
  }
  if (s.params !== undefined) {
    if (!s.params || typeof s.params !== 'object' || Array.isArray(s.params)) {
      return { ok: false, detail: 'params must be an object' };
    }
    for (const [k, v] of Object.entries(s.params)) {
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        return { ok: false, detail: 'params.' + k + ' must be a finite number' };
      }
    }
  }
  if (s.runId !== undefined && typeof s.runId !== 'string') {
    return { ok: false, detail: 'runId must be a string' };
  }
  return { ok: true, value: s };
}

/** 段冲突域 = 声明的参数 id（排序保证确定性）；空域（资产型手势）不构成冲突。 */
function domainOf(seg: ScheduledSegment): string[] {
  return Object.keys(seg.params).sort();
}

function domainsOverlap(a: string[], b: string[]): boolean {
  if (!a.length || !b.length) return false;
  return a.some((x) => b.includes(x));
}

/** 稳定排序：startAt → id → entryId（INV-8 同型：输出与入队顺序无关）。 */
function sortBySchedule(list: ScheduledSegment[]): ScheduledSegment[] {
  return [...list].sort((a, b) =>
    a.startAt - b.startAt ||
    a.id.localeCompare(b.id) ||
    a.entryId.localeCompare(b.entryId));
}

const keyOf = (s: ScheduledSegment): string => s.entryId + '|' + s.id;

function baseOf(state: GestureTimelineState | null | undefined): ScheduledSegment[] {
  return state && Array.isArray(state.segments) ? [...state.segments] : [];
}

function entryIdOf(segments: readonly GestureSegment[], explicit?: string): string {
  if (explicit) return explicit;
  return segments.map((s) => s.id).sort().join('+');
}

/**
 * 入队（ActGate 准入 + chain-normalize 分组语义）。
 *
 * 判定顺序：
 * 1. flag 关 → 全部 rejected('disabled')，状态零变化（现行为，M1-c 回滚要求）；
 * 2. 逐段校验：非法段 rejected('invalid-segment')，不产生任何副作用（fail-closed）；
 * 3. 到期清理：endAt <= now 的旧段视为已释放（INV-5 / S-05），不参与冲突；
 * 4. 冲突判定：参数域重叠的存量段为冲突集；incoming 档位 = 批内最高优先级——
 *    - incoming < 冲突集最高档 → 整批 rejected('priority-blocked')（低不打断高，
 *      chain-normalize 的整组原子语义：不做半批准入）；
 *    - 同级或更高 → 冲突集整批让位（interrupted，同级可打断 / 高打低）；
 *    - 无冲突（含空域段）→ 直接入队并存。
 */
export function enqueueGesture(
  state: GestureTimelineState | null | undefined,
  segments: readonly GestureSegment[] | null | undefined,
  now: number,
  options: EnqueueOptions = {},
): GestureEnqueueResult {
  const base = baseOf(state);
  const enabled = options.enabled ?? M1_DEFAULT_ENABLED;
  const list = Array.isArray(segments) ? segments : [];
  const t = Number(now) || 0;
  const entryId = options.entryId ?? entryIdOf(list.filter((s) => s && typeof s === 'object' && typeof (s as GestureSegment).id === 'string'));

  if (!enabled) {
    return {
      state: { segments: sortBySchedule(base) },
      entryId,
      admitted: [],
      rejected: list.map((s) => ({
        id: s && typeof s === 'object' && typeof s.id === 'string' ? s.id : '*',
        reason: 'disabled' as const,
      })),
      interrupted: [],
      expired: [],
    };
  }

  const rejected: GestureEnqueueResult['rejected'] = [];
  const valid: GestureSegment[] = [];
  for (const raw of list) {
    const v = validateSegment(raw);
    if (!v.ok) {
      const id = raw && typeof raw === 'object' && typeof (raw as GestureSegment).id === 'string'
        ? (raw as GestureSegment).id
        : '*';
      rejected.push({ id, reason: 'invalid-segment', detail: v.detail });
      continue;
    }
    valid.push(v.value);
  }

  // 到期清理：过期段视为已释放（INV-5 / S-05），不阻塞新段。
  const live: ScheduledSegment[] = [];
  const expired: ScheduledSegment[] = [];
  for (const seg of base) {
    if (seg.endAt !== null && seg.endAt <= t) expired.push(seg);
    else live.push(seg);
  }

  if (!valid.length) {
    return { state: { segments: sortBySchedule(live) }, entryId, admitted: [], rejected, interrupted: [], expired };
  }

  // 分组（chain-normalize 同源）：同 group 同桶；桶起点 = 最早投放时刻；
  // 整组超时取组内最大并钳制 GROUP_TIMEOUT_MAX_MS。
  const entryIdFinal = options.entryId ?? entryIdOf(valid);
  const buckets = new Map<string, { startAt: number; timeoutMs: number; members: GestureSegment[] }>();
  for (const s of valid) {
    const group = typeof s.group === 'string' ? s.group : '';
    let bucket = buckets.get(group);
    if (!bucket) {
      bucket = { startAt: t + (s.delayMs ?? 0), timeoutMs: 0, members: [] };
      buckets.set(group, bucket);
    }
    bucket.startAt = Math.min(bucket.startAt, t + (s.delayMs ?? 0));
    bucket.timeoutMs = Math.max(bucket.timeoutMs, clampGroupTimeout(s.timeoutMs));
    bucket.members.push(s);
  }

  const scheduled: ScheduledSegment[] = [];
  for (const [group, bucket] of buckets) {
    const groupEnd = bucket.timeoutMs > 0 ? bucket.startAt + bucket.timeoutMs : null;
    for (const s of bucket.members) {
      const startAt = t + (s.delayMs ?? 0);
      const ownEnd = typeof s.durationMs === 'number' && s.durationMs > 0 ? startAt + s.durationMs : null;
      const endAt = ownEnd !== null && groupEnd !== null
        ? Math.min(ownEnd, groupEnd)
        : ownEnd !== null ? ownEnd : groupEnd;
      const seg: ScheduledSegment = {
        id: s.id,
        group,
        priority: s.priority ?? DEFAULT_GESTURE_PRIORITY,
        source: s.source ?? 'motion',
        params: { ...(s.params ?? {}) },
        entryId: entryIdFinal,
        startAt,
        endAt,
      };
      if (s.runId !== undefined) seg.runId = s.runId;
      scheduled.push(seg);
    }
  }

  // 冲突判定（逐参数域，LimbController 同型；空域不冲突）。
  const incomingDomain = [...new Set(scheduled.flatMap(domainOf))].sort();
  const conflicts = incomingDomain.length
    ? live.filter((seg) => domainsOverlap(domainOf(seg), incomingDomain))
    : [];
  const incomingRank = Math.max(...scheduled.map((s) => s.priority));
  const maxConflict = conflicts.length ? Math.max(...conflicts.map((s) => s.priority)) : Number.NEGATIVE_INFINITY;

  let interrupted: ScheduledSegment[] = [];
  let admitted = scheduled;
  let nextLive = live;
  if (conflicts.length && incomingRank < maxConflict) {
    rejected.push(...scheduled.map((s) => ({ id: s.id, reason: 'priority-blocked' as const })));
    admitted = [];
  } else if (conflicts.length) {
    interrupted = sortBySchedule(conflicts);
    const interruptedKeys = new Set(conflicts.map(keyOf));
    nextLive = live.filter((s) => !interruptedKeys.has(keyOf(s)));
  }

  return {
    state: { segments: sortBySchedule([...nextLive, ...admitted]) },
    entryId: entryIdFinal,
    admitted,
    rejected,
    interrupted,
    expired,
  };
}

/**
 * 每帧出口：到期清理（endAt <= now 视为已释放）+ 输出当前活跃段。
 * 空时间线输出空表（空帧无副作用）；输出稳定排序（INV-8 同型）。
 */
export function resolveTimeline(
  state: GestureTimelineState | null | undefined,
  now: number,
): TimelineResolution {
  const base = baseOf(state);
  const t = Number(now) || 0;
  const active: ScheduledSegment[] = [];
  const scheduled: ScheduledSegment[] = [];
  const expired: ScheduledSegment[] = [];
  for (const seg of base) {
    if (seg.endAt !== null && seg.endAt <= t) expired.push(seg);
    else if (seg.startAt <= t) active.push(seg);
    else scheduled.push(seg);
  }
  return {
    active: sortBySchedule(active),
    scheduled: sortBySchedule(scheduled),
    expired: sortBySchedule(expired),
    state: { segments: sortBySchedule([...active, ...scheduled]) },
  };
}

/**
 * 显式释放（S-01 同型；LimbController.release 同语义）。
 * selector 缺省 = 全部停止；给出的字段按 AND 收窄。只释放匹配段，返回被停段。
 */
export function stopGesture(
  state: GestureTimelineState | null | undefined,
  selector?: StopSelector,
): TimelineStopResult {
  const base = baseOf(state);
  if (!selector) {
    return { state: { segments: [] }, stopped: sortBySchedule(base) };
  }
  const stopped = base.filter((s) =>
    (selector.entryId === undefined || s.entryId === selector.entryId) &&
    (selector.runId === undefined || s.runId === selector.runId) &&
    (selector.id === undefined || s.id === selector.id) &&
    (selector.group === undefined || s.group === selector.group));
  const stoppedKeys = new Set(stopped.map(keyOf));
  return {
    state: { segments: base.filter((s) => !stoppedKeys.has(keyOf(s))) },
    stopped: sortBySchedule(stopped),
  };
}
