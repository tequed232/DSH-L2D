/**
 * Agent 参数所有权登记（纯逻辑，便于单测）。
 *
 * 背景：四肢参数默认由物理驱动（只读）。当 Agent 要直接控制某个部位时，先把参数
 * 加入「独占集合」：注入器随后允许写这些参数，并且只在 post 相位（Physics 之后）
 * 写入，保证同一参数同一帧只有一条写入路径——物理先算，Agent 后写、确定性胜出。
 *
 * 释放后不恢复任何数据：下一帧物理自然接管。
 */

/** 默认占用时长：防止调用方忘记释放，导致参数永久脱离物理。 */
export const DEFAULT_OWN_DURATION_MS = 1200;

/** 写入相位：post = Physics600 之后覆盖（四肢叶子）；pre = 物理更新前（物理输入类，M1-b 才用）。 */
export type OwnPhase = 'pre' | 'post';

/** 与 Ownership-Invariants.md 的 WriteSource 对齐（物理/连续/微动作/动作/关键帧/姿势/注视/四肢）。 */
export type WriteSource =
  | 'physics'
  | 'continuous'
  | 'ambient'
  | 'motion'
  | 'keyframes'
  | 'pose'
  | 'gaze'
  | 'limb';

export interface OwnOptions {
  /** 占用时长（毫秒，<=0 表示长期持有）。 */
  durationMs?: number;
  /** 缺省 post。 */
  phase?: OwnPhase;
  /** 缺省 limb；未来 Mixer 的其它 source 也可复用登记表。 */
  owner?: WriteSource;
  /** 关联的执行轮次，便于 S-02/03 按 runId 释放。 */
  runId?: string;
  /** 测试用注入时钟。 */
  now?: number;
}

export interface OwnershipEntry {
  id: string;
  /** 0 表示长期持有，不自动到期。 */
  expiresAt: number;
  phase: OwnPhase;
  owner: WriteSource;
  runId?: string;
}

export class ParamOwnership {
  /** id -> expiresAt（0 = 永久） */
  private owned = new Map<string, { expiresAt: number; phase: OwnPhase; owner: WriteSource; runId?: string }>();

  /**
   * 认领参数。重复认领只延长不缩短（被更新/更长的请求「续期」）；
   * durationMs <= 0 表示长期持有。
   * @returns 实际登记的 id 列表（非法 id 被跳过）
   */
  public own(ids: Iterable<string>, options: number | OwnOptions = DEFAULT_OWN_DURATION_MS): string[] {
    const opts: OwnOptions = typeof options === 'number' ? { durationMs: options } : options || {};
    const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now();
    const duration = Number(opts.durationMs === undefined ? DEFAULT_OWN_DURATION_MS : opts.durationMs);
    const expiresAt = Number.isFinite(duration) && duration > 0 ? now + duration : 0;
    const phase: OwnPhase = opts.phase === 'pre' ? 'pre' : 'post';
    const owner: WriteSource = opts.owner || 'limb';
    const runId = typeof opts.runId === 'string' && opts.runId ? opts.runId : undefined;
    const accepted: string[] = [];
    for (const raw of ids) {
      const id = typeof raw === 'string' ? raw.trim() : '';
      if (!id) continue;
      const existing = this.owned.get(id);
      let next: number;
      if (existing && existing.expiresAt === 0) next = 0; // 长期持有不被短请求降级
      else if (expiresAt === 0) next = 0;
      else next = Math.max(existing ? existing.expiresAt : 0, expiresAt);
      // 相位/owner 以最新一次认领为准（后续 M1-b 的 pre 类参数走这里）
      this.owned.set(id, { expiresAt: next, phase, owner, runId });
      accepted.push(id);
    }
    return accepted;
  }

  /** 主动释放；返回实际被释放的 id。 */
  public release(ids: Iterable<string>): string[] {
    const released: string[] = [];
    for (const raw of ids) {
      const id = typeof raw === 'string' ? raw.trim() : '';
      if (!id) continue;
      if (this.owned.delete(id)) released.push(id);
    }
    return released;
  }

  /** 释放全部；返回被释放的 id。 */
  public releaseAll(): string[] {
    const ids = Array.from(this.owned.keys());
    this.owned.clear();
    return ids;
  }

  /** 是否仍被持有。到期即视为已释放并顺手移除。 */
  public isOwned(id: string, now: number = Date.now()): boolean {
    return this.phaseOf(id, now) !== null;
  }

  /** 独占来源；未持有返回 null。 */
  public ownerOf(id: string, now: number = Date.now()): WriteSource | null {
    const entry = this.owned.get(id);
    if (!entry) return null;
    if (entry.expiresAt !== 0 && now >= entry.expiresAt) {
      this.owned.delete(id);
      return null;
    }
    return entry.owner;
  }

  /** 独占相位；未持有返回 null。 */
  public phaseOf(id: string, now: number = Date.now()): OwnPhase | null {
    const entry = this.owned.get(id);
    if (!entry) return null;
    if (entry.expiresAt !== 0 && now >= entry.expiresAt) {
      this.owned.delete(id);
      return null;
    }
    return entry.phase;
  }

  /** 清理所有到期项，返回被清理的 id（供注入器同步清 sticky）。 */
  public expire(now: number = Date.now()): string[] {
    const expired: string[] = [];
    for (const [id, entry] of this.owned) {
      if (entry.expiresAt !== 0 && now >= entry.expiresAt) expired.push(id);
    }
    for (const id of expired) this.owned.delete(id);
    return expired;
  }

  /** 当前仍被持有的 id（会先清理到期项）。 */
  public list(now: number = Date.now()): string[] {
    this.expire(now);
    return Array.from(this.owned.keys());
  }

  public size(now: number = Date.now()): number {
    return this.list(now).length;
  }

  /** 诊断快照：id -> expiresAt（0 = 永久）。 */
  public snapshot(now: number = Date.now()): OwnershipEntry[] {
    this.expire(now);
    return Array.from(this.owned.entries()).map(([id, entry]) => ({
      id,
      expiresAt: entry.expiresAt,
      phase: entry.phase,
      owner: entry.owner,
      runId: entry.runId,
    }));
  }
}
