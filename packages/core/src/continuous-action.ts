/**
 * Continuous Action Mixer（docs/Embodied-Behavior.md §6「Continuous Motion」行 / §8 M1-e）。
 *
 * 职责：把 Idle / Ambient / Media 三类**连续动作**统一收敛到一个决策路径——
 * 统一优先级、生命周期、打断与恢复。不是新增动作系统：
 * - 优先级：连续层整体固定 ActGate BACKGROUND（10），来源间用 lane 秩排序
 *   （media > ambient > idle，与基线 stage 策略同源：媒体开启即停 ambient）；
 * - Agent 保留既有优先级与控制权：agent hold 活跃期间，scope 内 lane 的存量条目
 *   **挂起**（suspended，不 kill），新提交拒绝（'agent-held'）——连续动作永不抢占 Agent，
 *   hold 解除后原条目原地恢复（恢复 ≠ 重启，startedAt/runId 不变）；
 * - 生命周期：复用 gesture-timeline 的到期清理语义（endAt <= now 视为已释放，
 *   INV-5 / S-05）与 stop 语义（S-01 显式释放）；长期持有（endAt null）须显式 release；
 * - 抖动幂等：同源（同 id）重复提交 = 无操作刷新（refresh：只刷新 refreshedAt，
 *   不重启）；同源不同参数 = 原地更新（update：替换 params，startedAt/runId 不变）；
 *   释放后冷却窗口内的重提交拒绝（'cooldown'，抖动/冷却用例）；
 * - 与 resolveWritePlan 的分工：本模块只产出「每 lane 每帧的连续层写声明」，
 *   `source: 'continuous' | 'ambient'`（INV-6 秩 1，低于 motion）的 WriteIntent 喂 resolveWritePlan——连续层永不直接写模型参数，
 *   也不触碰 PhysicsGate 让位表与 Hip* pre 通道（M1-b 所有权语义不回退）。
 *
 * 设计约束：
 * - 全部纯函数：不修改入参 state；同一输入集合任意顺序 → 输出一致（INV-8 同型，
 *   条目按 id 稳定排序）；runId = origin id（稳定身份是「恢复不重启」的前提）；
 * - 能力驱动铁律：写什么参数由调用方在 params 里声明，本文件零参数名；
 *   params 同时是 lane 间参数域仲裁的冲突域（gesture-timeline domainOf 同型）；
 * - feature flag：`enabled` 缺省 `M1E_DEFAULT_ENABLED`（false）——关闭时提交全拒、
 *   resolve 恒空、状态零变化（M1-e 回滚要求：flag 关 = M1-b 集成后基线）。
 */

/** M1-e 统一 feature flag：默认关闭 = M1-b 集成后基线（回滚要求）。 */
export const M1E_DEFAULT_ENABLED = false;

/** 连续层 lane（来源词汇，与需求拍板表一致）。 */
export type ContinuousLane = 'idle' | 'ambient' | 'media';

export const CONTINUOUS_LANES: readonly ContinuousLane[] = ['idle', 'ambient', 'media'];

/**
 * 连续层固定 ActGate 档位：BACKGROUND（10）。
 * 连续层整体低于/等于 Agent 最低档，任何 agent hold 都不会被连续动作抢占。
 */
export const CONTINUOUS_PRIORITY = 10 as const;

/**
 * lane 秩（越大越强，参数域重叠时的 lane 间仲裁）：
 * media(3) > ambient(2) > idle(1)。
 * 依据（基线 stage 策略）：媒体开启即停 ambient（setMediaSway(true) → stopAmbient）；
 * ambient 是事件驱动微动作、比 idle 漂移更显著。注意这与 angleBus 的**数值混合**
 * 权重（ambient20 > media10）不矛盾：基线通过生命周期互斥让两路从不同帧写，
 * 本模块把该互斥升级为显式规则（media 准入即释放 ambient 存量条目）。
 */
export const CONTINUOUS_LANE_RANK: Record<ContinuousLane, number> = Object.freeze({
  idle: 1,
  ambient: 2,
  media: 3,
});

/** 提交请求（origin id 是幂等/恢复的同一性键）。 */
export interface ContinuousSubmitRequest {
  /** 同源键：如 'idle:drift' / 'ambient:tilt' / 'media:sway'。同 id 重复提交 = 刷新。 */
  id: string;
  lane: ContinuousLane;
  /** 声明写值域（gesture-timeline 的 params 同型）；空域不与任何 lane 冲突。 */
  params?: Record<string, number>;
  /** 持续时长（ms，>0）；缺省长期持有（须显式 release / 到期清理）。 */
  durationMs?: number;
}

/** 已登记的连续动作条目。runId 恒等于 id（稳定身份，refresh/update 不换）。 */
export interface ContinuousEntry {
  id: string;
  lane: ContinuousLane;
  priority: number;
  params: Record<string, number>;
  startedAt: number;
  /** 最近一次刷新/更新时刻（抖动诊断用）。 */
  refreshedAt: number;
  /** null = 长期持有（INV-5 缺省语义）。 */
  endAt: number | null;
  runId: string;
}

/** Agent 舞台占用（连续层视角的 Agent 控制权快照）。 */
export interface ContinuousAgentHold {
  /** Agent 侧执行轮次绑定（R12 同语义）。 */
  runId: string;
  /** 'all' = 全 lane；给出 lane 列表 = 只挂起这些 lane（如媒体豁免）。 */
  scope: 'all' | readonly ContinuousLane[];
  /** ActGate 档位（10/50/90）。连续层固定 10，任何档位都压制连续层。 */
  priority: number;
  /** null = 显式清除前一直持有。 */
  expiresAt: number | null;
}

export interface ContinuousState {
  /** 按 id 稳定排序的条目（INV-8 同型）。 */
  entries: readonly ContinuousEntry[];
  agentHold: ContinuousAgentHold | null;
  /** 最近释放时刻（冷却判定用；只保留窗口内的记录）。 */
  releasedAt: Readonly<Record<string, number>>;
}

export const M1E_MAX_RELEASED_TRACKED = 32;
/** releasedAt 记录的最大保留时长（超过即清除，防泄漏）。 */
const RELEASED_TRACK_MS = 60000;

export type ContinuousDecision =
  | 'started'    // 新条目准入
  | 'refresh'    // 同源同参数：无操作刷新（不重启）
  | 'update'     // 同源不同参数：原地更新（不重启）
  | 'rejected'   // 见 reason
  | 'disabled';  // flag 关

export type ContinuousRejectReason =
  | 'invalid-request'   // 形状非法（fail-closed，零副作用）
  | 'agent-held'        // agent hold 活跃且 lane 在 scope 内
  | 'media-active'      // 媒体活跃时拒绝 ambient（基线互斥策略）
  | 'cooldown';         // 释放后冷却窗口内（抖动/冷却）

export interface ContinuousSubmitResult {
  state: ContinuousState;
  decision: ContinuousDecision;
  /** decision = rejected 时的原因。 */
  reason?: ContinuousRejectReason;
  /** 准入/刷新/更新后的条目快照（rejected/disabled 时缺省）。 */
  entry?: ContinuousEntry;
  /** media 准入时被释放的 ambient 存量条目（基线 stopAmbient 语义，诊断用）。 */
  superseded: ContinuousEntry[];
  /** 提交时顺手清理的到期条目（INV-5，诊断用）。 */
  expired: ContinuousEntry[];
}

export interface ContinuousAgentHoldResult {
  state: ContinuousState;
  /** 本次 hold 设置/更新导致挂起的条目。 */
  suspended: ContinuousEntry[];
  /** 本次清除/收窄导致恢复的条目。 */
  resumed: ContinuousEntry[];
}

export interface ContinuousTickResult {
  state: ContinuousState;
  /** 本次到期清理的条目（INV-5 / S-05）。 */
  expired: ContinuousEntry[];
}

export interface ContinuousReleaseSelector {
  id?: string;
  lane?: ContinuousLane;
}

export interface ContinuousReleaseResult {
  state: ContinuousState;
  stopped: ContinuousEntry[];
}

export interface ContinuousResolution {
  /** 当前活跃（未到期且未被挂起）的条目——消费方只对它们产出写声明。 */
  active: ContinuousEntry[];
  /** 被agent hold 挂起的条目（保留状态，恢复不重启）。 */
  suspended: ContinuousEntry[];
  /** 每活跃条目的写声明（lane + params）；调用方降级为 WriteIntent 喂 resolveWritePlan。 */
  writes: Array<{ lane: ContinuousLane; id: string; params: Record<string, number> }>;
}

export const emptyContinuous = (): ContinuousState => ({ entries: [], agentHold: null, releasedAt: {} });

// ---------------------------------------------------------------- 内部工具

const keyOfEntries = (list: readonly ContinuousEntry[]): ContinuousEntry[] =>
  [...list].sort((a, b) => a.id.localeCompare(b.id));

function sameParams(a: Record<string, number>, b: Record<string, number>): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k) || a[k] !== b[k]) return false;
  }
  return true;
}

function validateRequest(req: unknown): req is ContinuousSubmitRequest {
  if (!req || typeof req !== 'object' || Array.isArray(req)) return false;
  const r = req as ContinuousSubmitRequest;
  if (typeof r.id !== 'string' || !r.id) return false;
  if (!CONTINUOUS_LANES.includes(r.lane)) return false;
  if (r.params !== undefined) {
    if (!r.params || typeof r.params !== 'object' || Array.isArray(r.params)) return false;
    for (const v of Object.values(r.params)) {
      if (typeof v !== 'number' || !Number.isFinite(v)) return false;
    }
  }
  if (r.durationMs !== undefined && (typeof r.durationMs !== 'number' || !Number.isFinite(r.durationMs) || r.durationMs < 0)) {
    return false;
  }
  return true;
}

/** agent hold 是否活跃（未过期）且覆盖某 lane。 */
function holdCovers(hold: ContinuousAgentHold | null, lane: ContinuousLane, now: number): boolean {
  if (!hold) return false;
  if (hold.expiresAt != null && hold.expiresAt <= now) return false;
  return hold.scope === 'all' || hold.scope.includes(lane);
}

function pruneReleased(released: Record<string, number>, now: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, at] of Object.entries(released)) {
    if (now - at <= RELEASED_TRACK_MS) out[id] = at;
  }
  // 只保留最近 N 条，防高频来源撑爆
  const keys = Object.keys(out).sort((a, b) => out[b] - out[a]).slice(0, M1E_MAX_RELEASED_TRACKED);
  const bounded: Record<string, number> = {};
  for (const k of keys) bounded[k] = out[k];
  return bounded;
}

function baseOf(state: ContinuousState | null | undefined): ContinuousState {
  if (!state || !Array.isArray(state.entries)) return emptyContinuous();
  return {
    entries: state.entries,
    agentHold: state.agentHold ?? null,
    releasedAt: state.releasedAt && typeof state.releasedAt === 'object' ? { ...state.releasedAt } : {},
  };
}

// ---------------------------------------------------------------- API

/**
 * 提交/刷新一个连续动作。
 *
 * 判定顺序：
 * 1. flag 关 → rejected 全部折叠为 decision 'disabled'，状态零变化（回滚要求）；
 * 2. 校验失败 → 'rejected'('invalid-request')，零副作用（fail-closed）；
 * 3. 到期清理：endAt <= now 的存量条目先释放（不参与同源判定）；
 * 4. agent hold：hold 活跃且 lane 在 scope 内 → 'rejected'('agent-held')（连续层永不抢占 Agent）；
 * 5. 冷却：同 id 在 readmitCooldownMs 内被释放过 → 'rejected'('cooldown')（抖动/冷却）；
 * 6. 媒体互斥：lane=media 准入时释放全部 ambient 存量条目（基线 stopAmbient 语义）；
 *    lane=ambient 在 media 活跃时提交 → 'rejected'('media-active')；
 * 7. 同源判定：已有同 id 条目——params 相同 → 'refresh'（只刷 refreshedAt；
 *    显式给 durationMs 才顺延 endAt）；params 不同 → 'update'（原地换 params，
 *    startedAt/runId 不变）；否则新条目 'started'。
 */
export function submitContinuous(
  state: ContinuousState | null | undefined,
  req: ContinuousSubmitRequest | null | undefined,
  now: number,
  options: { enabled?: boolean; readmitCooldownMs?: number } = {},
): ContinuousSubmitResult {
  const enabled = options.enabled ?? M1E_DEFAULT_ENABLED;
  const t = Number(now) || 0;
  const base = baseOf(state);
  const superseded: ContinuousEntry[] = [];
  const expired: ContinuousEntry[] = [];

  if (!enabled) {
    return { state: base, decision: 'disabled', superseded, expired };
  }
  if (!validateRequest(req)) {
    return { state: base, decision: 'rejected', reason: 'invalid-request', superseded, expired };
  }

  // 3) 到期清理（gesture-timeline 同语义：endAt <= now 视为已释放）。
  const live: ContinuousEntry[] = [];
  const releasedNow: Record<string, number> = {};
  for (const e of base.entries) {
    if (e.endAt !== null && e.endAt <= t) {
      expired.push(e);
      releasedNow[e.id] = t;
    } else {
      live.push(e);
    }
  }

  const cooldownMs = options.readmitCooldownMs ?? 0;
  const lastReleased = Math.max(base.releasedAt[req.id] ?? 0, releasedNow[req.id] ?? 0);
  if (cooldownMs > 0 && lastReleased > 0 && t - lastReleased < cooldownMs) {
    const releasedAt = { ...base.releasedAt, ...releasedNow };
    return {
      state: { entries: keyOfEntries(live), agentHold: base.agentHold, releasedAt },
      decision: 'rejected',
      reason: 'cooldown',
      superseded,
      expired,
    };
  }

  // 4) agent hold：连续层永不抢占 Agent。
  if (holdCovers(base.agentHold, req.lane, t)) {
    const releasedAt = { ...base.releasedAt, ...releasedNow };
    return {
      state: { entries: keyOfEntries(live), agentHold: base.agentHold, releasedAt },
      decision: 'rejected',
      reason: 'agent-held',
      superseded,
      expired,
    };
  }

  // 6) 媒体互斥（基线策略）：media 准入释放 ambient 存量；ambient 撞 media 活跃被拒。
  let nextLive = live;
  if (req.lane === 'media') {
    const ambientLive = nextLive.filter((e) => e.lane === 'ambient');
    if (ambientLive.length) {
      superseded.push(...keyOfEntries(ambientLive));
      const gone = new Set(ambientLive.map((e) => e.id));
      nextLive = nextLive.filter((e) => !gone.has(e.id));
      for (const e of ambientLive) releasedNow[e.id] = t;
    }
  } else if (req.lane === 'ambient') {
    const mediaActive = nextLive.some((e) => e.lane === 'media' && (e.endAt === null || e.endAt > t));
    if (mediaActive) {
      const releasedAt = { ...base.releasedAt, ...releasedNow };
      return {
        state: { entries: keyOfEntries(nextLive), agentHold: base.agentHold, releasedAt },
        decision: 'rejected',
        reason: 'media-active',
        superseded,
        expired,
      };
    }
  }

  // 7) 同源幂等：refresh / update 不换 runId、不动 startedAt。
  const existing = nextLive.find((e) => e.id === req.id);
  const params = { ...(req.params ?? {}) };
  let entry: ContinuousEntry;
  let decision: ContinuousDecision;
  if (existing) {
    const refreshedAt = t;
    let endAt = existing.endAt;
    if (req.durationMs !== undefined) endAt = t + req.durationMs;
    if (sameParams(existing.params, params)) {
      decision = 'refresh';
      entry = { ...existing, refreshedAt, endAt };
    } else {
      decision = 'update';
      entry = { ...existing, params, refreshedAt, endAt };
    }
    nextLive = nextLive.map((e) => (e.id === req.id ? entry : e));
  } else {
    decision = 'started';
    entry = {
      id: req.id,
      lane: req.lane,
      priority: CONTINUOUS_PRIORITY,
      params,
      startedAt: t,
      refreshedAt: t,
      endAt: req.durationMs !== undefined && req.durationMs > 0 ? t + req.durationMs : null,
      runId: req.id,
    };
    nextLive = [...nextLive, entry];
  }

  const releasedAt = { ...base.releasedAt, ...releasedNow };
  delete releasedAt[req.id]; // 重新准入后清除冷却记录
  return {
    state: { entries: keyOfEntries(nextLive), agentHold: base.agentHold, releasedAt },
    decision,
    entry,
    superseded,
    expired,
  };
}

/**
 * 设置/清除 agent hold。hold 活跃期间 scope 内 lane 的存量条目被挂起（保留状态），
 * 清除（或收窄 scope / 到期）后原地恢复。连续层侧无抢占判定——Agent 控制权是单向的。
 */
export function setContinuousAgentHold(
  state: ContinuousState | null | undefined,
  hold: ContinuousAgentHold | null | undefined,
  now: number,
  options: { enabled?: boolean } = {},
): ContinuousAgentHoldResult {
  const enabled = options.enabled ?? M1E_DEFAULT_ENABLED;
  const t = Number(now) || 0;
  const base = baseOf(state);
  if (!enabled) {
    return { state: base, suspended: [], resumed: [] };
  }
  const nextHold: ContinuousAgentHold | null = hold
    ? {
        runId: typeof hold.runId === 'string' && hold.runId ? hold.runId : 'agent',
        scope: hold.scope ?? 'all',
        priority: hold.priority ?? 50,
        expiresAt: hold.expiresAt === undefined ? null : hold.expiresAt,
      }
    : null;
  const wasCovered = (e: ContinuousEntry) => holdCovers(base.agentHold, e.lane, t);
  const nowCovered = (e: ContinuousEntry) => holdCovers(nextHold, e.lane, t);
  const suspended = base.entries.filter((e) => !wasCovered(e) && nowCovered(e));
  const resumed = base.entries.filter((e) => wasCovered(e) && !nowCovered(e));
  return { state: { ...base, agentHold: nextHold }, suspended, resumed };
}

/** 每帧维护：到期清理（INV-5 / S-05）。flag 关 = 空操作。 */
export function tickContinuous(
  state: ContinuousState | null | undefined,
  now: number,
  options: { enabled?: boolean } = {},
): ContinuousTickResult {
  const enabled = options.enabled ?? M1E_DEFAULT_ENABLED;
  const t = Number(now) || 0;
  const base = baseOf(state);
  if (!enabled) return { state: base, expired: [] };
  const live: ContinuousEntry[] = [];
  const expired: ContinuousEntry[] = [];
  const releasedNow: Record<string, number> = {};
  for (const e of base.entries) {
    if (e.endAt !== null && e.endAt <= t) {
      expired.push(e);
      releasedNow[e.id] = t;
    } else {
      live.push(e);
    }
  }
  const releasedAt = pruneReleased({ ...base.releasedAt, ...releasedNow }, t);
  return { state: { entries: keyOfEntries(live), agentHold: base.agentHold, releasedAt }, expired };
}

/**
 * 显式释放（S-01 / R7/R8 同语义）。selector 缺省 = 全部停止；
 * 字段按 AND 收窄。flag 关 = 空操作（返回空 stopped）。
 * `options.now` 供冷却记账（释放后 cooldown 窗口内的重提交会被拒）；
 * 缺省 Date.now——确定性用例请显式注入。
 */
export function releaseContinuous(
  state: ContinuousState | null | undefined,
  selector?: ContinuousReleaseSelector,
  options: { enabled?: boolean; now?: number } = {},
): ContinuousReleaseResult {
  const enabled = options.enabled ?? M1E_DEFAULT_ENABLED;
  const base = baseOf(state);
  if (!enabled) return { state: base, stopped: [] };
  const nowMs = Number(options.now ?? Date.now()) || 0;
  const stopped = base.entries.filter((e) =>
    (selector?.id === undefined || e.id === selector.id) &&
    (selector?.lane === undefined || e.lane === selector.lane));
  const gone = new Set(stopped.map((e) => e.id));
  const releasedNow: Record<string, number> = {};
  for (const id of gone) releasedNow[id] = nowMs;
  return {
    state: {
      entries: base.entries.filter((e) => !gone.has(e.id)),
      agentHold: base.agentHold,
      releasedAt: pruneReleased({ ...base.releasedAt, ...releasedNow }, nowMs),
    },
    stopped: keyOfEntries(stopped),
  };
}

/**
 * 每帧出口（纯读）：到期/挂起判定不入 state（到期由 tick/submit 清理），
 * 输出活跃条目与写声明（lane 间参数域仲裁：重叠参数 lane 秩高者胜）。
 * flag 关 = 恒空（空帧无副作用）。
 */
export function resolveContinuous(
  state: ContinuousState | null | undefined,
  now: number,
  options: { enabled?: boolean } = {},
): ContinuousResolution {
  const enabled = options.enabled ?? M1E_DEFAULT_ENABLED;
  const t = Number(now) || 0;
  const base = baseOf(state);
  if (!enabled) return { active: [], suspended: [], writes: [] };
  const active: ContinuousEntry[] = [];
  const suspended: ContinuousEntry[] = [];
  for (const e of base.entries) {
    if (e.endAt !== null && e.endAt <= t) continue; // 已到期，等 tick 清理
    if (holdCovers(base.agentHold, e.lane, t)) suspended.push(e);
    else active.push(e);
  }
  const sorted = keyOfEntries(active);
  // lane 间参数域仲裁：同参数被多条目声明时，lane 秩高者胜出
  // （media 3 > ambient 2 > idle 1；同 lane 内按 id 升序先声明者胜——确定性，顺序无关）。
  const claims = [...sorted].sort(
    (a, b) => CONTINUOUS_LANE_RANK[b.lane] - CONTINUOUS_LANE_RANK[a.lane] || a.id.localeCompare(b.id),
  );
  const owned = new Set<string>(); // 已被更高 lane 秩持有的参数
  const writes: ContinuousResolution['writes'] = [];
  for (const e of claims) {
    const params: Record<string, number> = {};
    for (const [k, v] of Object.entries(e.params)) {
      if (!owned.has(k)) {
        owned.add(k);
        params[k] = v;
      }
    }
    // 空 params（如 idle 漂移）也保留写声明条目：写声明 = 活跃来源清单，
    // 消费方按它维持「该来源仍在场」的信号，与 active 快照一致。
    writes.push({ lane: e.lane, id: e.id, params });
  }
  // writes 回到 id 稳定排序（与条目序一致，INV-8 同型）。
  writes.sort((a, b) => a.id.localeCompare(b.id));
  return {
    active: sorted,
    suspended: keyOfEntries(suspended),
    writes,
  };
}
