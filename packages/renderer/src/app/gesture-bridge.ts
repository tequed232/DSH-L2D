/**
 * Gesture Bridge（M1-d2）：Gesture Timeline 与 renderer 运行面（ActGate / ParamInjector /
 * keyframes 播放器）的桥接纯逻辑。
 *
 * 职责（docs/M1-D2-IMPLEMENTATION-READY.md §1.1 / §2）：
 * - admitGesture：四步判定——flag 查 → ActGate 双查 → injector 双查 → enqueueGesture；
 * - 每帧 resolve：到期清理旁挂（kfTick 前一行），armed 批次全部到期即软解除（releaseKfOwnership 兜底）；
 * - stop：显式释放（selector 透传 core stopGesture 语义），命中 armed 批次即硬解除（stopKeyframes）；
 * - armed 生命周期单一出口（风险清单 #2）：hard disarm = armed 置空 + stopKeyframes，
 *   soft disarm = armed 置空 + releaseKfOwnership，全部收口在本文件 disarmArmed()。
 * - armed 键域单一来源（真机回归收口）：armed 只记 entryId；armedHas 直接查时间线中
 *   armed 批次段的 params。登记（admit 写入时间线）与查询（armedHas）共用同一批
 *   ScheduledSegment 对象，不存在第二份键集合，结构性排除「登记键 ≠ 查询键」的失配。
 *
 * 不依赖 Cubism：ActGate / injector 通过 deps 注入，node 单测可直接跑
 * （gesture-bridge.test.mjs，测试矩阵 M1-M6/R1）。
 *
 * 优先级语义（§5 情形 B 收紧项，缺省采用）：参数域非空的批，在 ActGate 当前链存在时
 * 要求批内最高档**严格大于**链档位才放行（比 ActGate 的 >= 更保守：Agent act 寿命内
 * 手势不可同级插入）；无链但 Agent 经 ownParameters 独占时按 NORMAL 档同规则收紧
 * （M2：NORMAL 拒、M3：FORCE 释放后准入）。改比较符只动本文件 + M2/M3 断言。
 */
import {
  DEFAULT_GESTURE_PRIORITY,
  emptyTimeline,
  enqueueGesture,
  resolveTimeline,
  stopGesture as stopGestureCore,
  type GestureRejectReason,
  type GestureSegment,
  type GestureTimelineState,
  type StopSelector,
  type ScheduledSegment,
} from '../../../core/src/gesture-timeline.ts';
import type { SemanticPriority } from '../../../core/src/motion-contract.ts';

/** overlay 传入的段结构：GestureSegment 的宽松输入形状（数值字段容错由校验兜底）。 */
export interface GestureSegmentInput {
  id: string;
  group?: string;
  delayMs?: number;
  /** 缺省长期持有；keyframes 轨道场景 = opts.duration 或轨道 maxT。 */
  durationMs?: number;
  timeoutMs?: number;
  /** ActGate 数值档位（10/50/90）；缺省批档位或 50。 */
  priority?: SemanticPriority;
  /** 本段会写的参数 id → 值。值只进冲突域判定（keys），不产生任何写路径。 */
  params?: Record<string, number>;
  source?: string;
}

/** overlay 优先级词汇（与 ActGate 同词汇），映射 10/50/90。 */
export type GesturePriorityLabel = 'BACKGROUND' | 'NORMAL' | 'FORCE';

const PRIORITY_RANK: Record<GesturePriorityLabel, SemanticPriority> = {
  BACKGROUND: 10,
  NORMAL: 50,
  FORCE: 90,
};

/** Agent 独占（ownParameters，无活动链）按 NORMAL 档收紧（M2/M3 断言口径）。 */
const AGENT_OWN_BARRIER: SemanticPriority = 50;

export interface GestureAdmitOptions {
  /** 批内档位（整批统一，缺省 NORMAL）。 */
  priority?: GesturePriorityLabel;
  /** 缺省由段 id 派生（entryIdOf，可重放）。 */
  entryId?: string;
  /** 缺省注入时钟。 */
  now?: number;
}

export interface GestureRejection {
  id: string;
  reason: GestureRejectReason;
  detail?: string;
}

export interface GestureAdmission {
  /** 批内 admitted.length > 0；flag 关恒 false。 */
  admitted: boolean;
  entryId: string;
  admittedIds: string[];
  rejected: GestureRejection[];
  /** 被本批让位的旧段（含 Agent 独占被同级/更高打断释放的参数 id）。 */
  interrupted: Array<{ id: string; entryId: string }>;
  /** 因本批打断而被释放的 Agent 独占参数（回执/诊断用）。 */
  releasedAgentParams: string[];
  /** flag 状态回显（诊断：区分「被拒」与「没开」）。 */
  flagEnabled: boolean;
}

export interface GestureBridgeDeps {
  /** feature flag（embodied.timeline 编译期常量）。 */
  enabled: boolean;
  /** ActGate 当前链（双查 2）；null = 无占用。 */
  currentAct?(): { priority: number } | null;
  /** injector Agent 独占清单（双查 3）。 */
  getAgentOwned?(): string[];
  /** Agent 独占释放（同级/更高打断路径）。 */
  releaseOwned?(ids: string[]): string[];
  /** 硬解除落点：停 keyframes 播放并释放 kfAutoOwned（index.ts 的 stopKeyframes）。 */
  stopKeyframes?(): void;
  /** 软解除落点：仅释放 kfAutoOwned（index.ts 的 releaseKfOwnership，幂等）。 */
  releaseKfOwnership?(): void;
  /** 时钟（缺省 performance.now / Date.now，测试注入用）。 */
  now?(): number;
}

export interface GestureBridgeSnapshot {
  enabled: boolean;
  active: Array<{
    id: string;
    entryId: string;
    startAt: number;
    endAt: number | null;
    params: string[];
  }>;
  armedEntryId: string | null;
}

export interface GestureBridge {
  /** admitGesture 主流程（§1.1 判定顺序 1-4）。 */
  admit(segments: GestureSegmentInput[] | null | undefined, opts?: GestureAdmitOptions): GestureAdmission;
  /** 每帧到期清理（post 钩子 kfTick 旁挂）；flag 关 = no-op。 */
  resolve(now: number): { active: ScheduledSegment[]; expired: ScheduledSegment[] };
  /** 显式释放；selector 缺省 = 全停。命中 armed 批次时硬解除（stopKeyframes）。 */
  stop(selector?: StopSelector): Array<{ id: string; entryId: string }>;
  /** armed 批次是否覆盖该参数（playKeyframes 纵深防御 #3 检查用）。 */
  armedHas(paramId: string): boolean;
  /** 诊断快照（getGestureState 数据源）。 */
  snapshot(): GestureBridgeSnapshot;
}

const nowMs = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();

function normalizeSegments(
  segments: GestureSegmentInput[] | null | undefined,
  opts: GestureAdmitOptions,
): GestureSegment[] {
  const list = Array.isArray(segments) ? segments : [];
  const batchRank = opts.priority ? PRIORITY_RANK[opts.priority] : undefined;
  return list
    .filter((s) => !!s && typeof s === 'object')
    .map((s) => {
      const seg: GestureSegment = {
        id: String(s.id),
        params: s.params && typeof s.params === 'object' && !Array.isArray(s.params) ? { ...s.params } : {},
      };
      if (typeof s.group === 'string' && s.group) seg.group = s.group;
      if (typeof s.delayMs === 'number' && Number.isFinite(s.delayMs) && s.delayMs >= 0) seg.delayMs = s.delayMs;
      if (typeof s.durationMs === 'number' && Number.isFinite(s.durationMs) && s.durationMs > 0) {
        seg.durationMs = s.durationMs;
      }
      if (typeof s.timeoutMs === 'number' && Number.isFinite(s.timeoutMs) && s.timeoutMs > 0) seg.timeoutMs = s.timeoutMs;
      const rank = typeof s.priority === 'number' && Number.isFinite(s.priority)
        ? (s.priority as SemanticPriority)
        : batchRank;
      if (rank !== undefined) seg.priority = rank;
      return seg;
    });
}

const domainOf = (segs: GestureSegment[]): string[] =>
  [...new Set(segs.flatMap((s) => Object.keys(s.params)))].sort();

/** armed 解除的单一出口（风险清单 #2）：hard = 停播；soft = 只清 ownership。 */
function disarmArmed(armed: { entryId: string } | null, hard: boolean, deps: GestureBridgeDeps): null {
  if (!armed) return null;
  if (hard) deps.stopKeyframes?.();
  else deps.releaseKfOwnership?.();
  return null;
}

/**
 * 创建 bridge 实例（index.ts 装配一次；测试可多次创建）。
 * 内部持有 timeline 与 armed 批次；全部状态变更收口在 admit/resolve/stop 三个入口。
 */
export function createGestureBridge(deps: GestureBridgeDeps): GestureBridge {
  let timeline: GestureTimelineState = emptyTimeline();
  // armed 只记批次 id（键域单一来源）：armedHas 查询用的参数键直接取自时间线里
  // armed 批次段的 params——与 admit 写入的是同一批 ScheduledSegment 对象。
  let armed: { entryId: string } | null = null;

  const disarm = (hard: boolean): void => {
    if (armed) armed = disarmArmed(armed, hard, deps);
  };

  const admit = (
    segments: GestureSegmentInput[] | null | undefined,
    opts: GestureAdmitOptions = {},
  ): GestureAdmission => {
    const list = Array.isArray(segments) ? segments : [];
    const ids = list.map((s) => (s && typeof s === 'object' && typeof s.id === 'string' ? s.id : '*'));

    // 1. flag 查：状态零变化、ActGate/injector 零触碰（回滚不变式，R1）。
    if (!deps.enabled) {
      return {
        admitted: false,
        entryId: opts.entryId ?? '',
        admittedIds: [],
        rejected: ids.map((id) => ({ id, reason: 'disabled' as const })),
        interrupted: [],
        releasedAgentParams: [],
        flagEnabled: false,
      };
    }

    const now = opts.now ?? deps.now?.() ?? nowMs();
    const norm = normalizeSegments(list, opts);
    const domain = domainOf(norm);
    const batchRank = norm.length
      ? (Math.max(...norm.map((s) => s.priority ?? DEFAULT_GESTURE_PRIORITY)) as SemanticPriority)
      : DEFAULT_GESTURE_PRIORITY;

    // 2/3. ActGate + injector 双查（收紧项：参数域非空的批要求严格大于才打断）。
    const releasedAgentParams: string[] = [];
    if (domain.length) {
      const cur = deps.currentAct?.() ?? null;
      if (cur && batchRank <= cur.priority) {
        return {
          admitted: false,
          entryId: opts.entryId ?? '',
          admittedIds: [],
          rejected: norm.map((s) => ({ id: s.id, reason: 'priority-blocked' as const })),
          interrupted: [],
          releasedAgentParams,
          flagEnabled: true,
        };
      }
      const agentOwned = deps.getAgentOwned?.() ?? [];
      const agentHeld = agentOwned.filter((id) => domain.includes(id));
      if (agentHeld.length) {
        if (batchRank <= AGENT_OWN_BARRIER) {
          return {
            admitted: false,
            entryId: opts.entryId ?? '',
            admittedIds: [],
            rejected: norm.map((s) => ({ id: s.id, reason: 'priority-blocked' as const })),
            interrupted: [],
            releasedAgentParams,
            flagEnabled: true,
          };
        }
        // 同级/更高打断：Agent 独占被释放（语义与 ActGate 高打低一致，R7 打断即释放）。
        const freed = deps.releaseOwned?.(agentHeld) ?? agentHeld;
        releasedAgentParams.push(...freed);
      }
    }

    // 4. enqueueGesture（core 纯函数：校验/分组/冲突/原子准入）。
    const result = enqueueGesture(timeline, norm, now, { enabled: true, entryId: opts.entryId });
    timeline = result.state;

    // 被打断段若属于当前 armed 批次 → 硬解除（旧 keyframes 逐帧写值停止，kfAutoOwned 释放）。
    if (armed && result.interrupted.some((s) => s.entryId === armed!.entryId)) {
      disarm(true);
    }

    // 本批成功 → armed 归属本批（情形 C：armed 归属最后一批成功批次）。
    // 段对象已在 result.state（= timeline）里，armedHas 的参数键直接以它们为准。
    if (result.admitted.length) {
      armed = { entryId: result.entryId };
    }

    return {
      admitted: result.admitted.length > 0,
      entryId: result.entryId,
      admittedIds: result.admitted.map((s) => s.id),
      rejected: result.rejected,
      interrupted: result.interrupted.map((s) => ({ id: s.id, entryId: s.entryId })),
      releasedAgentParams,
      flagEnabled: true,
    };
  };

  const resolve = (now: number) => {
    if (!deps.enabled) {
      return { active: [] as ScheduledSegment[], expired: [] as ScheduledSegment[] };
    }
    const frame = resolveTimeline(timeline, Number(now) || 0);
    timeline = frame.state;
    if (armed && !timeline.segments.some((s) => s.entryId === armed!.entryId)) {
      // armed 批次全部段被清理（到期）→ 软解除：armed 置空 + releaseKfOwnership 兜底。
      disarm(false);
    }
    return { active: frame.active, expired: frame.expired };
  };

  const stop = (selector?: StopSelector) => {
    if (!deps.enabled) return [];
    const result = stopGestureCore(timeline, selector);
    timeline = result.state;
    if (!selector) {
      // 全停（Agent 打断钩子 / reset）：armed 无论是否仍有段都硬解除。
      disarm(true);
      return result.stopped.map((s) => ({ id: s.id, entryId: s.entryId }));
    }
    if (armed && result.stopped.some((s) => s.entryId === armed!.entryId)) {
      disarm(true);
    }
    return result.stopped.map((s) => ({ id: s.id, entryId: s.entryId }));
  };

  // 纵深防御 #3 查询面（键域单一来源）：参数键取自时间线中 armed 批次段的 params，
  // 与 admit 写入时间线的是同一批对象——登记即查询，不存在键失配的第三态。
  // 注意 armed 批次段在到期清理（resolve）前仍留在时间线里，此处不做 active 过滤：
  // 「已 admit 尚未到期清理」的段继续背书其参数（与原 armed.params 集合逐点等价）。
  const armedHas = (paramId: string): boolean =>
    !!armed && timeline.segments.some((s) => s.entryId === armed.entryId && paramId in s.params);

  const snapshot = (): GestureBridgeSnapshot => {
    const frame = deps.enabled ? resolveTimeline(timeline, deps.now?.() ?? nowMs()) : null;
    return {
      enabled: deps.enabled,
      active: (frame?.active ?? []).map((s) => ({
        id: s.id,
        entryId: s.entryId,
        startAt: s.startAt,
        endAt: s.endAt,
        params: Object.keys(s.params).sort(),
      })),
      armedEntryId: armed ? armed.entryId : null,
    };
  };

  return { admit, resolve, stop, armedHas, snapshot };
}
