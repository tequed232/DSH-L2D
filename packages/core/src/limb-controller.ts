/**
 * LimbController 骨架（docs/Embodied-Behavior.md §6 / docs/Ownership-Invariants.md §4 状态层）。
 *
 * 职责：四肢参数的「physics-owned ↔ limb-owned」状态机——默认 physics 驱动，
 * acquire 后 limb 独占（叶子四肢 post；Hip* pre 属 M1-b，经 acquire 选项显式给相位），
 * release / 打断 / 超时后回 physics。本层不直接写模型参数；
 * 两个出口：
 *   - `resolve(now)`：每帧 limb 写值（Map<id, value>）——对齐渲染侧 LimbControlLike
 *     （packages/renderer/src/app/motion-adapter.ts），供 ParamInjector 在独占相位落地；
 *   - `ownershipSnapshot(now)`：ownership 表快照——喂 `resolveWritePlan` 做帧级仲裁。
 *
 * 能力驱动铁律：四肢参数 id 由构造函数传入（来自模型画像/W3 注册表），本文件零参数名；
 * R10b：acquire 只登记物理输出——`isOwnable` 谓词由调用方注入（renderer 接
 * MotionAdapter.canOwn / physics3 输出表），非物理 id 返回 ignored（不算错误）。
 *
 * feature flag：`enabled` 缺省取 `M1_DEFAULT_ENABLED`（false = 现行为，
 * 行为变化必须由调用方显式启用；关闭时 acquire 全部拒绝、resolve 恒空表）。
 */
import { M1_DEFAULT_ENABLED } from './write-plan.ts';
import type { OwnershipEntry } from './write-plan.ts';
import type { WritePhase } from './motion-contract.ts';

export interface LimbControllerOptions {
  /** 缺省 M1_DEFAULT_ENABLED（false）：调用方显式 true 才启用 limb 行为。 */
  enabled?: boolean;
  /** 时钟注入（测试/确定性用）；缺省 Date.now。 */
  now?: () => number;
  /** acquire 未传 durationMs 时的缺省持有时长；缺省 undefined = 长期持有（须显式 release）。 */
  defaultDurationMs?: number;
  /**
   * R10b canOwn 谓词：id 是否为当前物理输出（renderer 注入 MotionAdapter.canOwn /
   * physics3 输出表，不硬编码）。缺省恒 true——此时以构造函数传入的四肢名单为唯一门槛。
   */
  isOwnable?: (id: string) => boolean;
  /**
   * 值钳制钩子（renderer 注入参数 min/max；`resolve()` 返回前调用）。
   * 缺省原值返回。
   */
  clamp?: (id: string, value: number) => number;
}

/** acquire 选项（对齐渲染侧 LimbAcquireOptions，同形状同语义）。 */
export interface LimbAcquireOptions {
  /** ActGate 优先级语义：BACKGROUND 10 < NORMAL 50 < FORCE 90（R5）。 */
  priority?: number;
  /** 执行轮次绑定；打断/完成/超时按 runId 释放（R7/R12）。缺省自动生成。 */
  runId?: string;
  /** 叶子四肢固定 post；Hip* 固定 pre（M1-b）。与参数族默认冲突时按 wrong-phase 处理。 */
  phase?: WritePhase;
  /** 占用时长（毫秒，<=0 长期持有）；超时只是最后保险，主路径是显式 release。 */
  durationMs?: number;
}

export type AcquireRejectReason = 'disabled' | 'unknown-id' | 'not-ownable' | 'priority-blocked';

/** 详细回执（`acquireDetailed`；`acquire` 只返回成功列表，对齐 LimbControlLike）。 */
export interface AcquireResult {
  runId: string;
  acquired: string[];
  rejected: Array<{ id: string; reason: AcquireRejectReason }>;
}

/** `set()` 回执：值只登记在当前持有的参数上；未持有的 id 忽略（R10b 同语义）。 */
export interface LimbSetResult {
  applied: string[];
  ignored: string[];
}

/** ownership 表条目（喂给 resolveWritePlan 的 `ownership` 字段）。 */
export interface LimbOwnershipEntry extends OwnershipEntry {
  owner: 'limb';
  runId: string;
  phase: WritePhase;
  /** ActGate 档位（S-04 抢占判定用，不进 resolveWritePlan 输入）。 */
  priority: number;
}

export interface LimbOwnershipSnapshot {
  /** 未过期的 ownership 表（按 id 排序键序稳定）。 */
  ownership: Record<string, LimbOwnershipEntry>;
  /** 本次快照因超时兜底而释放的参数（S-05，诊断用）。 */
  expired: string[];
}

let runIdSeq = 0;

interface HeldEntry extends LimbOwnershipEntry {
  value?: number;
}

export class LimbController {
  private readonly limbIds: ReadonlySet<string>;
  private readonly enabled: boolean;
  private readonly nowFn: () => number;
  private readonly defaultDurationMs: number | undefined;
  private readonly isOwnable: (id: string) => boolean;
  private readonly clampFn: (id: string, value: number) => number;
  private readonly held = new Map<string, HeldEntry>();

  /**
   * @param limbIds 叶子四肢参数 id 列表（来自模型画像/W3 注册表，禁止在调用方之外硬编码）。
   */
  constructor(limbIds: readonly string[], options: LimbControllerOptions = {}) {
    this.limbIds = new Set(limbIds);
    this.enabled = options.enabled ?? M1_DEFAULT_ENABLED;
    this.nowFn = options.now ?? Date.now;
    this.defaultDurationMs = options.defaultDurationMs;
    this.isOwnable = options.isOwnable ?? (() => true);
    this.clampFn = options.clamp ?? ((_, value) => value);
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** 当前持有大小（S-06 泄漏检查用）。 */
  get size(): number {
    return this.held.size;
  }

  /**
   * 取得独占（R1/R2/R5/R10b/R12），返回成功 acquire 的 id 列表（对齐 LimbControlLike）。
   * 逐 id 判定：
   * - 未启用 → rejected('disabled')（flag 默认关 = 现行为）；
   * - 不在构造时给的四肢名单里 → rejected('unknown-id')（limb 只写四肢参数，CASE-04）；
   * - `isOwnable` 谓词不通过（非物理输出）→ rejected('not-ownable')（R10b：忽略，不算错误）；
   * - 已被其它 runId 持有：新 priority < 持有 priority → rejected('priority-blocked')
   *   （低不打断高）；同级或更高 → 抢占，旧 runId 在该参数上的持有被释放（S-04）；
   * - 同 runId → 刷新 durationMs/priority。
   * 详细回执（含拒绝原因）用 `acquireDetailed`。
   */
  acquire(ids: readonly string[], options: LimbAcquireOptions = {}): string[] {
    return this.acquireDetailed(ids, options).acquired;
  }

  /** 同 `acquire`，返回完整回执（诊断/对账用）。 */
  acquireDetailed(ids: readonly string[], options: LimbAcquireOptions = {}): AcquireResult {
    const runId = options.runId ?? 'limb-run-' + (++runIdSeq);
    const acquired: string[] = [];
    const rejected: AcquireResult['rejected'] = [];
    if (!this.enabled) {
      for (const id of ids) rejected.push({ id, reason: 'disabled' });
      return { runId, acquired, rejected };
    }
    const priority = options.priority ?? 50;
    const now = this.nowFn();
    for (const id of ids) {
      if (!this.limbIds.has(id)) {
        rejected.push({ id, reason: 'unknown-id' });
        continue;
      }
      if (!this.isOwnable(id)) {
        rejected.push({ id, reason: 'not-ownable' }); // R10b：非物理输出只登记为 ignored
        continue;
      }
      const existing = this.held.get(id);
      if (existing && existing.runId !== runId && priority < existing.priority) {
        rejected.push({ id, reason: 'priority-blocked' });
        continue;
      }
      this.held.delete(id); // 同 runId 刷新或抢占旧 runId
      const entry: HeldEntry = {
        owner: 'limb',
        runId,
        phase: options.phase ?? 'post',
        priority,
      };
      const durationMs = options.durationMs ?? this.defaultDurationMs;
      if (typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs > 0) {
        entry.expiresAt = now + durationMs;
      }
      this.held.set(id, entry);
      acquired.push(id);
    }
    return { runId, acquired, rejected };
  }

  /**
   * 登记本帧目标写值（Embodied-Behavior §6 `set(ids,values)` 语义）。
   * 只有当前持有（本 runId）的参数会生效；未持有 id 忽略并在回执标出。
   */
  set(runId: string, values: Record<string, number>): LimbSetResult {
    const applied: string[] = [];
    const ignored: string[] = [];
    if (!this.enabled) {
      return { applied, ignored: Object.keys(values) };
    }
    for (const [id, value] of Object.entries(values)) {
      const entry = this.held.get(id);
      if (!entry || entry.runId !== runId || typeof value !== 'number' || !Number.isFinite(value)) {
        ignored.push(id);
        continue;
      }
      entry.value = value;
      applied.push(id);
    }
    return { applied, ignored };
  }

  /**
   * 释放（R7/R8：打断即释放、释放回物理）。只释放该 runId 持有的参数；
   * runId 缺省 = 释放全部持有（渲染侧 reset 语义）。
   * 未到期也立即释放（超时只是最后兜底，不作为主路径）。
   */
  release(runId?: string): string[] {
    const released: string[] = [];
    if (!this.enabled) return released;
    for (const [id, entry] of this.held) {
      if (runId === undefined || entry.runId === runId) {
        this.held.delete(id);
        released.push(id);
      }
    }
    return released;
  }

  /**
   * 每帧写计划出口（对齐 LimbControlLike.resolve）：先做超时兜底清理（S-05，
   * expiresAt <= now 视为已释放），再返回本帧 limb 写值 `Map<id, value>`（已经 clamp 钩子）。
   * 空表 = 本帧无 limb 写入（空帧无副作用）。
   */
  resolve(now: number = this.nowFn()): Map<string, number> {
    const writes = new Map<string, number>();
    if (!this.enabled) return writes;
    this.pruneExpired(now);
    for (const [id, entry] of this.held) {
      if (typeof entry.value !== 'number') continue;
      writes.set(id, this.clampFn(id, entry.value));
    }
    return writes;
  }

  /**
   * ownership 表快照：可直接作为 `resolveWritePlan({ ownership: snap.ownership, ... })` 的输入。
   * 同样先做超时兜底清理（与 resolve 共享 prune，重复调用安全）。
   */
  ownershipSnapshot(now: number = this.nowFn()): LimbOwnershipSnapshot {
    if (!this.enabled) return { ownership: {}, expired: [] };
    const expired = this.pruneExpired(now);
    const ownership: Record<string, LimbOwnershipEntry> = {};
    for (const id of [...this.held.keys()].sort()) ownership[id] = this.held.get(id)!;
    return { ownership, expired };
  }

  /** 超时兜底：expiresAt <= now 的持有视为已释放（INV-5 / S-05）。 */
  private pruneExpired(now: number): string[] {
    const expired: string[] = [];
    for (const [id, entry] of this.held) {
      if (entry.expiresAt !== undefined && entry.expiresAt <= now) {
        this.held.delete(id);
        expired.push(id);
      }
    }
    return expired;
  }
}
