/**
 * LimbController ⇄ ParamInjector 粘合层（M1-g / G1）。
 *
 * 为什么需要这一层：`LimbController.acquire` 只登记「谁持有」，**不会**让 injector 放行物理
 * 输出。injector.set 对未授权的物理输出一律拒绝（param-injector.ts 的 isPhysicsOutput 守卫），
 * 因此 acquire 成功后必须在同一次调用里同步 `injector.own(ids, durationMs, 'post')`——
 * 否则会出现「lease 成功、手臂一动不动」的假通过（G0 §6.4 风险 #1）。
 *
 * 三条不变量（全部在本文件内保证，调用方无法绕过）：
 *  1. **原子**：acquire 与 own 同进同退。own 局部失败（例如 id 不是物理输出或被口型红线拒）
 *     → 回滚已 own 的 id + 释放该 runId 的全部持有，回执 accepted=false，不留下半个租约。
 *  2. **同生命周期**：owner 的持有时长与 injector 的 own 时长逐字相同（缺省 0 = 长期，
 *     两边一致），避免「injector 先到期、物理回来抢写」的撕裂。
 *  3. **超时联动**：每帧 `resolve` 先做一次 ownershipSnapshot，把到期释放的 id 同步给
 *     injector.release（LimbController 的 pruneExpired 只清自己那张表）。
 *
 * 本模块不 import SDK / DOM，node 可直跑（单测：limb-wiring.test.mjs）。
 */
import type {
  AcquireRejectReason,
  AcquireResult,
  LimbController,
  LimbOwnershipEntry,
} from '../../../core/src/limb-controller.ts';
import type { LimbControlLike } from './motion-adapter.ts';

export type LimbPhase = 'pre' | 'post';

/** LimbController 的结构类型（真实实现由 core 提供，测试用 fake）。 */
export interface LimbControllerLike {
  readonly isEnabled: boolean;
  readonly size: number;
  acquireDetailed(
    ids: readonly string[],
    options?: { priority?: number; runId?: string; phase?: LimbPhase; durationMs?: number },
  ): AcquireResult;
  release(runId?: string): string[];
  resolve(now?: number): Map<string, number>;
  /** 登记本帧目标写值（core LimbController.set）；缺省 = 本层不写值（只做租约）。 */
  set?(runId: string, values: Record<string, number>): { applied: string[]; ignored: string[] };
  ownershipSnapshot(now?: number): {
    ownership: Record<string, LimbOwnershipEntry>;
    expired: string[];
  };
}

/** injector 的 ownership 面（ParamInjector.own / release 的形状）。 */
export interface LimbOwnershipSink {
  own(ids: Iterable<string>, durationMs: number, phase: LimbPhase): string[];
  release(ids: Iterable<string>): string[];
}

export interface LimbAdmitInput {
  ids: readonly string[];
  runId?: string;
  /** 占用时长（毫秒，<=0 / 缺省 = 长期，须显式 release）。 */
  durationMs?: number;
  /** ActGate 优先级语义：BACKGROUND 10 < NORMAL 50 < FORCE 90。缺省 50。 */
  priority?: number;
  /**
   * 初始目标值（可选）：只对本次成功 acquire 的 id 生效，未持有的 id 忽略。
   * 不给值 = 只拿租约（本帧 resolve 空表，不产生写入）——这样"接管但不写"与
   * "接管并压住"两种情况都能表达。
   */
  values?: Record<string, number>;
}

export interface LimbAdmitReceipt {
  ok: boolean;
  accepted: boolean;
  reason?:
    | 'limb-disabled'
    | 'empty-ids'
    | 'rejected'
    | 'injector-rejected'
    | 'not-ready';
  /** 与 cue/gesture 回执同口径：flag 关时 false，overlay 据此明确回执而不是静默成功。 */
  flagEnabled: boolean;
  runId?: string;
  /** 成功登记（controller + injector 双方都在）的 id。 */
  acquired: string[];
  /** controller 侧拒绝明细。 */
  rejected: Array<{ id: string; reason: AcquireRejectReason }>;
  /** injector 侧拒绝的 id（物理输出守卫/口型/不存在），已回滚。 */
  injectorRejected: string[];
  /** 本次登记的初始目标值 id（`values` 里被实际接受的部分）。 */
  written: string[];
  durationMs?: number;
}

export interface LimbReleaseReceipt {
  ok: boolean;
  released: string[];
  flagEnabled: boolean;
  reason?: 'limb-disabled';
}

export interface LimbStateSnapshot {
  flagEnabled: boolean;
  enabled: boolean;
  /** controller 侧持有数。 */
  size: number;
  /** controller 侧 ownership 表（id → 租约）。 */
  ownership: Record<string, LimbOwnershipEntry>;
  /** injector 侧当前 Agent 独占的 id（诊断用，避免"两边不一致"静默）。 */
  injectorOwned: string[];
  /** 只在一侧存在的 id（应为空；非空 = 状态漂移，必须调查）。 */
  drift: { controllerOnly: string[]; injectorOnly: string[] };
  expired: string[];
}

/**
 * 创建粘合层。`enabled=false`（flag 关）时 acquire 全部拒绝、release 为空、
 * resolve 恒空表，且**零 injector 交互**（回归安全：现行为逐字节不变）。
 */
export function createLimbWiring(input: {
  controller: LimbControllerLike;
  sink: LimbOwnershipSink;
  enabled: boolean;
  /** injector.getAgentOwned（诊断/漂移检测用；缺省不检测 injectorOnly）。 */
  ownedIds?: () => string[];
  now?: () => number;
}) {
  const { controller, sink, enabled } = input;
  const nowFn = input.now ?? Date.now;
  const phase: LimbPhase = 'post';

  /** 缺省 0 = 长期持有：与 LimbController 缺省语义一致（须显式 release）。 */
  function ownDurationOf(durationMs: number | undefined): number {
    return typeof durationMs === 'number' && Number.isFinite(durationMs) ? durationMs : 0;
  }

  function admit(request: LimbAdmitInput): LimbAdmitReceipt {
    const ids = dedupe(request.ids);
    if (!enabled) {
      return {
        ok: false,
        accepted: false,
        reason: 'limb-disabled',
        flagEnabled: false,
        acquired: [],
        rejected: ids.map((id) => ({ id, reason: 'disabled' as const })),
        injectorRejected: [],
        written: [],
      };
    }
    if (!ids.length) {
      return {
        ok: false,
        accepted: false,
        reason: 'empty-ids',
        flagEnabled: true,
        acquired: [],
        rejected: [],
        injectorRejected: [],
        written: [],
      };
    }
    const durationMs = request.durationMs;
    const result = controller.acquireDetailed(ids, {
      runId: request.runId,
      durationMs,
      priority: request.priority,
      phase,
    });

    // 原子：G1 只做单肢整段接管，任一 id 被拒 = 整次请求失败（不允许半个肢体）
    if (result.acquired.length !== ids.length) {
      rollback(result);
      return {
        ok: false,
        accepted: false,
        reason: 'rejected',
        flagEnabled: true,
        runId: result.runId,
        acquired: [],
        rejected: result.rejected,
        injectorRejected: [],
        written: [],
        durationMs,
      };
    }

    const owned = sink.own(result.acquired, ownDurationOf(durationMs), phase);
    if (owned.length !== result.acquired.length) {
      const ownedSet = new Set(owned);
      const injectorRejected = result.acquired.filter((id) => !ownedSet.has(id));
      sink.release(owned);
      rollback(result);
      return {
        ok: false,
        accepted: false,
        reason: 'injector-rejected',
        flagEnabled: true,
        runId: result.runId,
        acquired: [],
        rejected: result.rejected,
        injectorRejected,
        written: [],
        durationMs,
      };
    }

    // 初始目标值：只在 acquire + own 全部成功后登记（否则会留下"有值无租约"的残留）
    const written = request.values ? write(request.values, result.runId) : [];

    return {
      ok: true,
      accepted: true,
      flagEnabled: true,
      runId: result.runId,
      acquired: [...result.acquired],
      rejected: result.rejected,
      injectorRejected: [],
      written,
      durationMs,
    };
  }

  /** 登记目标写值；未持有/非法值由 controller.set 自己忽略（回执里给出 applied/ignored）。 */
  function write(values: Record<string, number>, runId?: string): string[] {
    if (!runId || !values || typeof values !== 'object') return [];
    if (!controller.set) return [];
    return controller.set(runId, values).applied;
  }

  /** 回滚：释放该 runId 在 controller 上的全部持有（own 尚未发生或已单独回收）。 */
  function rollback(result: AcquireResult): void {
    if (result.acquired.length) controller.release(result.runId);
  }

  /**
   * 释放。runId 缺省 = 释放全部（渲染侧 reset 语义）；否则只释放该 runId 的持有。
   * injector 只释放 controller 实际释放的 id（避免误伤别的 runId 的租约）。
   */
  function release(runId?: string): LimbReleaseReceipt {
    if (!enabled) return { ok: true, released: [], flagEnabled: false };
    const released = controller.release(runId);
    if (released.length) sink.release(released);
    return { ok: true, released, flagEnabled: true };
  }

  /**
   * 每帧出口（PhysicsGate.post 调 `limb.resolve(now)`）。
   * 先同步超时释放（controller 的 prune 只清自己那张表，injector 必须跟着清），
   * 再返回本帧写值；flag 关 = 空表且零 injector 交互。
   */
  function resolve(now: number = nowFn()): Map<string, number> {
    const writes = new Map<string, number>();
    if (!enabled) return writes;
    const snapshot = controller.ownershipSnapshot(now);
    if (snapshot.expired.length) sink.release(snapshot.expired);
    const held = controller.resolve(now);
    held.forEach((value, id) => writes.set(id, value));
    return writes;
  }

  function snapshot(now: number = nowFn()): LimbStateSnapshot {
    if (!enabled) {
      return {
        flagEnabled: false,
        enabled: false,
        size: 0,
        ownership: {},
        injectorOwned: [],
        drift: { controllerOnly: [], injectorOnly: [] },
        expired: [],
      };
    }
    const snap = controller.ownershipSnapshot(now);
    const controllerIds = Object.keys(snap.ownership);
    const injectorOwned = input.ownedIds ? [...input.ownedIds()] : [];
    const controllerSet = new Set(controllerIds);
    const injectorSet = new Set(injectorOwned);
    return {
      flagEnabled: true,
      enabled: controller.isEnabled,
      size: controller.size,
      ownership: snap.ownership,
      injectorOwned,
      drift: {
        controllerOnly: input.ownedIds ? controllerIds.filter((id) => !injectorSet.has(id)) : [],
        injectorOnly: input.ownedIds ? injectorOwned.filter((id) => !controllerSet.has(id)) : [],
      },
      expired: snap.expired,
    };
  }

  /** LimbControlLike 的 acquire 面（返回成功 id，供 gate/诊断复用）。 */
  function acquire(ids: readonly string[], options: { runId?: string; durationMs?: number; priority?: number } = {}): string[] {
    return admit({ ids, ...options }).acquired;
  }

  /**
   * 严格对齐 `LimbControlLike`（motion-adapter）的视图，供 PhysicsGate 注入。
   * 与 admit/release 的差别只有返回形状（gate 只需要 resolve；release 返回 id 列表）。
   */
  const control: LimbControlLike = {
    acquire: (ids, options) => acquire(ids, options),
    release: (runId) => release(runId).released,
    resolve: (now) => resolve(now),
  };

  return {
    enabled,
    control,
    acquire,
    admit,
    release,
    resolve,
    snapshot,
    /** 更新已持有租约的目标值（runId 不匹配/未持有的 id 被忽略）。 */
    set: (runId: string, values: Record<string, number>) => write(values, runId),
  };
}

export type LimbWiring = ReturnType<typeof createLimbWiring>;

/** 去重 + 去空白（保持首次出现顺序；空串丢弃）。 */
function dedupe(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of ids) {
    const id = typeof raw === 'string' ? raw.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** 真实 controller 的类型标注辅助（index.ts 装配时用，避免 as 断言散落）。 */
export type LimbControllerInstance = LimbController;
