/**
 * 身体部位规划器 / 分配求解器（M1-g / G2，**纯函数**）。
 *
 * 依据：docs/M1-G-LIMB-ALLOCATION-ROADMAP.md §G2（契约与 10 条规则）、
 *      docs/M1-G-PHYSICS-RIG-AUDIT.md §3（部位域）/ §6（未知清单）、
 *      docs/M1-G2-PLANNER-CONTRACT.md（契约冻结稿）。
 *
 * **为什么主战场是姿态域**（G1 判定实验结论，决定的不是偏好而是事实）：
 * 手臂有两条**互不相交**的通道——
 *   - 姿态层（真实动作写这里，非物理输出、不可 own、普通参数写入）；
 *   - 物理输出层（可 own，但静息增益≈0，单独 own 未必可见）。
 * 现有真实手臂动作（竖手指/狗尾草/抚胸）只写姿态层；因此"分配哪条手臂给哪个行为源"
 * 本质是**姿态域租约**，物理输出 own 只作为"直写输出"的兜底通道。每个 selectedPart
 * 因此同时给出 `poseDomain` 与可选 `physicsDomain`，两者语义不混同。
 *
 * 设计约束（红线）：
 * - 全部纯函数：无 DOM / Cubism / 渲染器实例 / 定时器 / 网络 / 随机；时间由 `now` 注入；
 *   同一输入任意次调用输出一致（INV-8 同型），输出域一律排序去重；
 * - 能力驱动铁律：本文件**零参数名**，所有参数域、侧归属、校准证据都来自调用方传入的
 *   manifest 数据（G1 生成物 packages/renderer/src/app/body-manifest.ts 的形状由
 *   `LimbManifest` 描述；core 不反向依赖 renderer）；
 * - 不写参数、不产生第二写入路径：本层只产出 decision，运行时的 lease / admission
 *   仍由 LimbController + Gesture Admission / Timeline / ParamInjector 负责；
 * - fail-closed：判不出来就拒绝，不按参数名/部位名推断能力（G0 §6.2 UNKNOWN）。
 *
 * feature flag：`M1G2_DEFAULT_ENABLED = false`——本层尚未接线，G4 接入时必须显式
 * `enabled: true`；关闭时决策恒为 rejected('disabled')，状态零变化（回滚口径）。
 */

/** M1-g/G2 统一 feature flag：默认关闭 = 规划器不参与运行时（尚未接线）。 */
export const M1G2_DEFAULT_ENABLED = false;

/** 行为来源。 */
export type BehaviorSource = 'agent' | 'interaction' | 'autonomous';

/**
 * 跨源主序（规则 2/3/4 的唯一依据）：agent 显式 > interaction > autonomous。
 * 同源内才比较 `priority`（同级可打断 / 低不打断高，与 ActGate / LimbController 同口径）。
 */
export const LIMB_SOURCE_RANK: Readonly<Record<BehaviorSource, number>> = Object.freeze({
  agent: 3,
  interaction: 2,
  autonomous: 1,
});

/** 侧约束：显式左右不可静默改侧（规则 1）；auto 只在有校准证据时选边。 */
export type SideConstraint = 'left' | 'right' | 'both' | 'auto';

/** 可分配侧（both/auto 解析后的实体侧）。 */
export type LimbSide = 'left' | 'right';

/** 动作请求（路线图 §G2 契约 + 本仓扩展两字段）。 */
export interface MotionRequest {
  /** 执行轮次标识（同一 executionId 的不同 generation = 同一动作的多次尝试）。 */
  executionId: string;
  /** 执行代次；小 generation 的回调被 fence（规则 9）。 */
  generation: number;
  source: BehaviorSource;
  motionId: string;
  side: SideConstraint;
  /** ActGate 档位惯例 10/50/90；同源内比较，非有限值 fail-closed。 */
  priority: number;
  /** 占用时长（ms，> 0）。到期只是兜底，主路径是显式 settle。 */
  durationMs: number;
  /**
   * 是否直写物理输出（缺省取能力条的 directOutput，再缺省 false）。
   * false = 只占姿态域（G1 判定实验结论：真实动作写姿态层，不需要 own）。
   */
  directOutput?: boolean;
  /**
   * 显式承认跨域耦合（姿态参数同时喂另一部位物理的"跨域参数"型，见 manifest.crossDomain）。
   * 未 ack 时请求里出现跨域参数一律 fail-closed（不得默认占用）。
   */
  crossDomainAck?: boolean;
}

/** manifest 的单个部位域（对应 G1 body-manifest 的分组，由调用方装配）。 */
export interface LimbManifestPart {
  /** 部位 id（如 'arm.right'）；数据驱动，本文件不硬编码。 */
  id: string;
  /** 归属侧；无侧 = 不可按侧分配（头/躯干类）。 */
  side?: LimbSide;
  /** 部位族（如 'arm'）；同族左右可并存。 */
  family?: string;
  /** 姿态域：真实动作写这里，非物理输出、普通参数写入（必填，可为空数组）。 */
  poseDomain?: readonly string[];
  /** 物理输出域：可 own，仅"直写输出"时使用。 */
  physicsDomain?: readonly string[];
  /** 跨域耦合参数：既是姿态层又喂物理 Source，必须显式声明。 */
  crossDomain?: readonly string[];
  /** 头/躯干物理根输入（只写根，不 own 输出）。 */
  rootOnly?: readonly string[];
  /** 禁止按侧独占的共享枢纽/开关（fail-closed，规则 7 的静态面）。 */
  sharedForbidden?: readonly string[];
  /** 校准证据：auto 选边的唯一依据；缺省/false = 无证据（rejected 'no-calibration'）。 */
  calibrated?: boolean;
}

/** 部位域清单（G1 生成物的装配视图）。 */
export interface LimbManifest {
  /** 模型指纹（诊断/对账用，不参与决策）。 */
  modelFingerprint?: string;
  parts: readonly LimbManifestPart[];
}

/** 动作能力条：动作 → 部位变体（G3 动作库的接口面，G2 只消费数据）。 */
export interface LimbMotionCapability {
  motionId: string;
  /** 部位族过滤（与 manifest part.family 对齐）；缺省不限族，按侧匹配。 */
  family?: string;
  /** 部位 id → 变体；缺失的侧 = 该侧无动作可用（不猜、不回退）。 */
  variants: Readonly<Record<string, LimbMotionVariant>>;
  /** 缺省是否直写物理输出（缺省 false）。 */
  directOutput?: boolean;
}

/** 单侧动作变体。 */
export interface LimbMotionVariant {
  /** 本变体实际写入的姿态参数（必须是该侧 poseDomain ∪ crossDomain 的子集）；缺省 = 全量姿态域。 */
  poseParams?: readonly string[];
  /** 直写输出时的物理参数（必须是该侧 physicsDomain 的子集）；缺省 = 全量物理域。 */
  physicsParams?: readonly string[];
}

/** 决策选中的部位（路线图 `selectedParts: string[]` 的结构化扩展）。 */
export interface SelectedPart {
  partId: string;
  side?: LimbSide;
  via: 'explicit' | 'auto-calibrated' | 'both';
  /** 姿态域（主战场）：普通参数写入的冲突域。 */
  poseDomain: readonly string[];
  /** 物理输出域：仅当请求直写输出时非空（可 own）。 */
  physicsDomain: readonly string[];
  /** 跨域耦合参数：仅当请求显式 ack 且变体声明时非空。 */
  crossDomain: readonly string[];
}

export type LimbDecisionOutcome = 'accepted' | 'rejected' | 'blocked';

export type LimbRejectReason =
  | 'disabled'                    // feature flag 关
  | 'invalid-request'             // 请求形状非法（fail-closed）
  | 'unknown-capability'          // 动作/能力无证据（不发明模型能力）
  | 'unknown-part'                // 变体声明的部位不在 manifest
  | 'ambiguous-part'              // 侧匹配到多个部位（族未收窄）
  | 'unknown-parameter'           // 变体写的参数不在该侧已声明域内
  | 'shared-domain-forbidden'     // 触碰共享枢纽/开关（规则 7 静态面）
  | 'no-calibration'              // auto 缺校准证据（G1 判定实验未覆盖该侧）
  | 'side-unavailable'            // 该侧无变体（显式侧不回退）
  | 'cross-domain-unacknowledged' // 跨域参数未显式 ack
  | 'part-busy'                   // 部位被更高主序来源占用
  | 'priority-blocked'            // 同源低优先级撞上高优先级（低不打断高）
  | 'autonomous-no-preempt'       // 自主永不抢占（规则 4）
  | 'interaction-preempt-denied'  // interaction 抢占 agent 未开策略（规则 3）
  | 'stale-generation'            // 旧代次请求被 fence（规则 9）
  | 'model-not-ready';            // 模型未就绪 → BLOCKED，绝不 PASS

/** 分配决策（路线图 §G2 契约 + 扩展字段）。 */
export interface AllocationDecision {
  /** `outcome === 'accepted'` 的便捷视图（兼容路线图字段名）。 */
  accepted: boolean;
  outcome: LimbDecisionOutcome;
  selectedParts: SelectedPart[];
  /** 兼容视图：部位的平铺 id 列表（排序）。 */
  selectedPartIds: string[];
  /** 本次决策原子预留的全部参数 id（姿态 ∪ 物理 ∪ 跨域，排序去重）。 */
  parameterDomains: string[];
  executionId: string;
  generation: number;
  /**
   * accepted 时恒为 'admitted'：**准入成功 ≠ 动作完成**（规则 10）。
   * 完成/取消/超时/失败必须走 `settleLimbHold`，动作回执（action receipt）才是权威。
   */
  phase: 'admitted' | 'none';
  /** 本次抢占掉的执行（R7 打断即释放）；未抢占为空。 */
  preempted: string[];
  reason?: LimbRejectReason;
  detail?: string;
}

/** 持有中的部位（决策落地后的只读快照）。 */
export type LimbHoldPart = SelectedPart;

/** 一条活跃占用（= 一次准入的执行）。 */
export interface LimbHold {
  executionId: string;
  generation: number;
  source: BehaviorSource;
  motionId: string;
  priority: number;
  parts: readonly LimbHoldPart[];
  /** 占用的全部参数 id（排序去重）——冲突判定与原子预留单位。 */
  domains: readonly string[];
  startAt: number;
  endAt: number;
}

/** 规划器状态（不可变；每次决策返回新状态，不修改入参）。 */
export interface LimbPlanState {
  holds: readonly LimbHold[];
}

/** 抢占/就绪策略（缺省最保守：interaction 不抢占 agent）。 */
export interface LimbPlanOptions {
  /** feature flag：缺省 M1G2_DEFAULT_ENABLED（false = 不参与运行时）。 */
  enabled?: boolean;
  /** 模型是否就绪（缺省 true）；false → blocked 'model-not-ready'，绝不 PASS。 */
  modelReady?: boolean;
  /** 规则 3：interaction 抢占 agent 必须显式开启，缺省 false。 */
  allowInteractionPreemptAgent?: boolean;
}

export interface LimbPlanResult {
  /** 新状态（入参不被修改）；rejected/blocked 时仅做到期清理。 */
  state: LimbPlanState;
  decision: AllocationDecision;
}

/** 终态（规则 8/10）：四种终态走同一条幂等出口。 */
export type LimbSettleOutcome = 'completed' | 'cancelled' | 'failed' | 'timeout';

export interface LimbSettleInput {
  executionId: string;
  /** 缺省 = 不限代次；给出时小于持有代次 → fence（规则 9）。 */
  generation?: number;
  outcome: LimbSettleOutcome;
}

export interface LimbSettleResult {
  state: LimbPlanState;
  /** 本次真正释放的持有（幂等：第二次为空）。 */
  released: LimbHold[];
  /** 旧代次回调被 fence（状态零变化）。 */
  fenced: boolean;
  reason?: 'unknown-hold' | 'invalid-settle' | 'stale-generation';
}

export interface LimbTickResult {
  state: LimbPlanState;
  expired: LimbHold[];
}

/** 空状态。 */
export const emptyLimbPlan = (): LimbPlanState => ({ holds: [] });

const SOURCES: readonly BehaviorSource[] = ['agent', 'interaction', 'autonomous'];
const SIDES: readonly SideConstraint[] = ['left', 'right', 'both', 'auto'];
const SETTLE_OUTCOMES: readonly LimbSettleOutcome[] = ['completed', 'cancelled', 'failed', 'timeout'];

const isSource = (v: unknown): v is BehaviorSource => typeof v === 'string' && SOURCES.includes(v as BehaviorSource);
const isSideConstraint = (v: unknown): v is SideConstraint => typeof v === 'string' && SIDES.includes(v as SideConstraint);
const isSettleOutcome = (v: unknown): v is LimbSettleOutcome =>
  typeof v === 'string' && SETTLE_OUTCOMES.includes(v as LimbSettleOutcome);

/** 时间归一（与 gesture-timeline 同口径）：非有限值按 0，避免 NaN 污染比较。 */
function normalizeNow(now: unknown): number {
  const t = Number(now);
  return Number.isFinite(t) ? t : 0;
}

/** 排序去重：所有输出域共用，保证 INV-8 型确定性。 */
function sortedUnique(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort();
}

function validateRequest(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'request must be an object';
  const r = raw as MotionRequest;
  if (typeof r.executionId !== 'string' || !r.executionId) return 'executionId is required';
  if (typeof r.generation !== 'number' || !Number.isInteger(r.generation) || r.generation < 0) {
    return 'generation must be a non-negative integer';
  }
  if (!isSource(r.source)) return 'source must be agent/interaction/autonomous';
  if (typeof r.motionId !== 'string' || !r.motionId) return 'motionId is required';
  if (!isSideConstraint(r.side)) return 'side must be left/right/both/auto';
  if (typeof r.priority !== 'number' || !Number.isFinite(r.priority)) return 'priority must be a finite number';
  if (typeof r.durationMs !== 'number' || !Number.isFinite(r.durationMs) || r.durationMs <= 0) {
    return 'durationMs must be a positive finite number';
  }
  if (r.directOutput !== undefined && typeof r.directOutput !== 'boolean') return 'directOutput must be a boolean';
  if (r.crossDomainAck !== undefined && typeof r.crossDomainAck !== 'boolean') return 'crossDomainAck must be a boolean';
  return null;
}

function stateHolds(state: LimbPlanState | null | undefined): LimbHold[] {
  return state && Array.isArray(state.holds) ? [...state.holds] : [];
}

/** 到期清理（INV-5 / S-05 同语义：endAt <= now 视为已释放）。 */
function pruneHolds(
  state: LimbPlanState | null | undefined,
  now: number,
): { live: LimbHold[]; expired: LimbHold[] } {
  const live: LimbHold[] = [];
  const expired: LimbHold[] = [];
  for (const hold of stateHolds(state)) {
    if (hold && typeof hold === 'object' && typeof hold.endAt === 'number' && hold.endAt <= now) expired.push(hold);
    else if (hold && typeof hold === 'object') live.push(hold);
  }
  return { live, expired };
}

/** 稳定排序：startAt → executionId → generation（输出与插入顺序无关）。 */
function sortHolds(holds: LimbHold[]): LimbHold[] {
  return [...holds].sort(
    (a, b) => a.startAt - b.startAt || a.executionId.localeCompare(b.executionId) || a.generation - b.generation,
  );
}

function indexManifest(manifest: LimbManifest | null | undefined): {
  list: LimbManifestPart[];
  byId: Map<string, LimbManifestPart>;
} {
  const list = manifest && Array.isArray(manifest.parts)
    ? manifest.parts.filter((p) => p && typeof p === 'object' && typeof p.id === 'string' && p.id.length > 0)
    : [];
  const byId = new Map<string, LimbManifestPart>();
  for (const p of list) if (!byId.has(p.id)) byId.set(p.id, p);
  return { list, byId };
}

function findCapability(
  catalog: readonly LimbMotionCapability[] | null | undefined,
  motionId: string,
): LimbMotionCapability | null {
  if (!Array.isArray(catalog)) return null;
  for (const entry of catalog) {
    if (entry && typeof entry === 'object' && entry.motionId === motionId) return entry;
  }
  return null;
}

/** 该部位当前被多少条活跃持有占用（auto 选边的负载因子）。 */
function loadOf(holds: readonly LimbHold[], partId: string): number {
  let n = 0;
  for (const hold of holds) for (const part of hold.parts) if (part.partId === partId) n++;
  return n;
}

type PartFailure = { ok: false; reason: LimbRejectReason; detail: string };
type PartSuccess = { ok: true; value: SelectedPart; domains: string[] };

/**
 * 单部位域装配：把变体声明的参数分类成姿态/跨域/物理三份，逐条 fail-closed。
 * 顺序：先在 manifest 已声明域内分类（未知参数直接拒），再判共享禁占，再判跨域 ack。
 */
function buildSelectedPart(
  part: LimbManifestPart,
  variant: LimbMotionVariant,
  via: SelectedPart['via'],
  directOutput: boolean,
  request: MotionRequest,
): PartFailure | PartSuccess {
  const poseAll = Array.isArray(part.poseDomain) ? part.poseDomain : [];
  const crossAll = Array.isArray(part.crossDomain) ? part.crossDomain : [];
  const physAll = Array.isArray(part.physicsDomain) ? part.physicsDomain : [];
  const forbidden = new Set(Array.isArray(part.sharedForbidden) ? part.sharedForbidden : []);
  const poseSet = new Set(poseAll);
  const crossSet = new Set(crossAll);
  const physSet = new Set(physAll);

  const declared = Array.isArray(variant.poseParams) ? variant.poseParams : poseAll;
  const pose: string[] = [];
  const cross: string[] = [];
  for (const id of declared) {
    if (typeof id !== 'string' || !id) {
      return { ok: false, reason: 'unknown-parameter', detail: 'invalid parameter id in ' + part.id };
    }
    if (forbidden.has(id)) return { ok: false, reason: 'shared-domain-forbidden', detail: part.id + ':' + id };
    if (poseSet.has(id)) pose.push(id);
    else if (crossSet.has(id)) cross.push(id);
    else return { ok: false, reason: 'unknown-parameter', detail: part.id + ':' + id };
  }

  const physics: string[] = [];
  if (directOutput) {
    if (!physAll.length) {
      return { ok: false, reason: 'unknown-capability', detail: 'no-physics-domain:' + part.id };
    }
    const declaredPhys = Array.isArray(variant.physicsParams) ? variant.physicsParams : physAll;
    for (const id of declaredPhys) {
      if (typeof id !== 'string' || !id) {
        return { ok: false, reason: 'unknown-parameter', detail: 'invalid parameter id in ' + part.id };
      }
      if (forbidden.has(id)) return { ok: false, reason: 'shared-domain-forbidden', detail: part.id + ':' + id };
      if (!physSet.has(id)) return { ok: false, reason: 'unknown-parameter', detail: part.id + ':' + id };
      physics.push(id);
    }
    if (!physics.length) return { ok: false, reason: 'unknown-capability', detail: 'empty-physics-domain:' + part.id };
  }

  if (cross.length && request.crossDomainAck !== true) {
    return {
      ok: false,
      reason: 'cross-domain-unacknowledged',
      detail: part.id + ':' + sortedUnique(cross).join(','),
    };
  }

  const poseDomain = sortedUnique(pose);
  const physicsDomain = sortedUnique(physics);
  const crossDomain = sortedUnique(cross);
  if (!poseDomain.length && !physicsDomain.length) {
    return { ok: false, reason: 'unknown-capability', detail: 'empty-domain:' + part.id };
  }
  return {
    ok: true,
    value: { partId: part.id, side: part.side, via, poseDomain, physicsDomain, crossDomain },
    domains: sortedUnique([...poseDomain, ...physicsDomain, ...crossDomain]),
  };
}

interface HoldConflict {
  hold: LimbHold;
  allowed: boolean;
  reason?: LimbRejectReason;
  detail?: string;
}

/**
 * 跨源抢占判定（规则 2/3/4 的唯一实现点）：
 * - 自主永不抢占（无论 priority）；
 * - 高主序压低保：agent > interaction > autonomous；interaction 抢 agent 需显式策略；
 * - 同主序才比 priority：低不打断高，同级可打断（ActGate / LimbController 同口径）。
 */
function evaluateConflict(hold: LimbHold, request: MotionRequest, options: LimbPlanOptions): HoldConflict {
  const incoming = LIMB_SOURCE_RANK[request.source];
  const held = LIMB_SOURCE_RANK[hold.source];
  if (request.source === 'autonomous') {
    return { hold, allowed: false, reason: 'autonomous-no-preempt', detail: hold.executionId };
  }
  if (held > incoming) {
    if (request.source === 'interaction' && hold.source === 'agent' && options.allowInteractionPreemptAgent === true) {
      return { hold, allowed: true };
    }
    return {
      hold,
      allowed: false,
      reason: request.source === 'interaction' && hold.source === 'agent' ? 'interaction-preempt-denied' : 'part-busy',
      detail: hold.executionId + '(' + hold.source + ')',
    };
  }
  if (held === incoming) {
    if (request.priority < hold.priority) {
      return { hold, allowed: false, reason: 'priority-blocked', detail: hold.executionId + '@' + hold.priority };
    }
    return { hold, allowed: true };
  }
  return { hold, allowed: true };
}

/**
 * 规划 + 求解（纯函数）。
 *
 * 判定顺序（任一失败即 fail-closed，状态只做到期清理）：
 * 1. flag 关 → rejected('disabled')；
 * 2. 请求形状非法 → rejected('invalid-request')；
 * 3. 模型未就绪 → **blocked**('model-not-ready')，绝不 accepted（路线图 Required tests 末条）；
 * 4. 动作无能力条 / 部位不在 manifest → rejected('unknown-capability'/'unknown-part')；
 * 5. 侧解析（显式侧不回退；both 原子；auto 需校准证据）；
 * 6. 域装配（未知参数 / 共享禁占 / 跨域未 ack 全拒）；
 * 7. 旧代次 fence（同 executionId 有更新代次 → rejected('stale-generation')）；
 * 8. 冲突求解（逐条按主序/优先级；任意一条不允许 → 整单拒绝，规则 7 原子性）；
 * 9. 准入 → 新持有，被抢占的立即释放（R7）。
 */
export function planMotionAllocation(
  state: LimbPlanState | null | undefined,
  request: MotionRequest,
  manifest: LimbManifest | null | undefined,
  catalog: readonly LimbMotionCapability[] | null | undefined,
  now: number,
  options: LimbPlanOptions = {},
): LimbPlanResult {
  const t = normalizeNow(now);
  const { live } = pruneHolds(state, t);
  const safeState: LimbPlanState = { holds: live };

  const raw = request && typeof request === 'object' ? (request as MotionRequest) : ({} as MotionRequest);
  const executionId = typeof raw.executionId === 'string' ? raw.executionId : '';
  const generation = typeof raw.generation === 'number' && Number.isFinite(raw.generation) ? raw.generation : 0;

  const rejected = (reason: LimbRejectReason, detail?: string): LimbPlanResult => ({
    state: safeState,
    decision: {
      accepted: false,
      outcome: outcomeOf(reason),
      selectedParts: [],
      selectedPartIds: [],
      parameterDomains: [],
      executionId,
      generation,
      phase: 'none',
      preempted: [],
      reason,
      ...(detail ? { detail } : {}),
    },
  });

  if ((options.enabled ?? M1G2_DEFAULT_ENABLED) !== true) return rejected('disabled');

  const invalid = validateRequest(raw);
  if (invalid) return rejected('invalid-request', invalid);
  if (options.modelReady === false) return rejected('model-not-ready', 'model readiness not observed');

  const capability = findCapability(catalog, raw.motionId);
  if (!capability) return rejected('unknown-capability', 'no capability for ' + raw.motionId);

  const manifestIndex = indexManifest(manifest);
  if (!manifestIndex.list.length) return rejected('unknown-capability', 'empty-manifest');

  const variantIds = capability.variants && typeof capability.variants === 'object'
    ? Object.keys(capability.variants).filter((id) => capability.variants[id] && typeof capability.variants[id] === 'object')
    : [];
  if (!variantIds.length) return rejected('unknown-capability', 'no variants for ' + raw.motionId);

  // 变体声明的每个部位都必须在 manifest 里（不发明部位）。
  for (const partId of variantIds) {
    if (!manifestIndex.byId.has(partId)) return rejected('unknown-part', partId);
  }

  const familyOf = (p: LimbManifestPart): string | undefined => p.family;
  const inFamily = (p: LimbManifestPart): boolean =>
    capability.family === undefined || familyOf(p) === capability.family;

  const partOfSide = (side: LimbSide): LimbManifestPart | null => {
    const matches = manifestIndex.list.filter(
      (p) => inFamily(p) && p.side === side && Object.prototype.hasOwnProperty.call(capability.variants, p.id),
    );
    if (matches.length === 1) return matches[0];
    return null;
  };
  const countOfSide = (side: LimbSide): number =>
    manifestIndex.list.filter((p) => inFamily(p) && p.side === side && Object.prototype.hasOwnProperty.call(capability.variants, p.id)).length;

  const chosen: Array<{ part: LimbManifestPart; via: SelectedPart['via'] }> = [];
  if (raw.side === 'left' || raw.side === 'right') {
    if (countOfSide(raw.side) === 0) return rejected('side-unavailable', raw.motionId + '@' + raw.side);
    if (countOfSide(raw.side) > 1) return rejected('ambiguous-part', raw.motionId + '@' + raw.side);
    chosen.push({ part: partOfSide(raw.side)!, via: 'explicit' });
  } else if (raw.side === 'both') {
    // 规则 7 的静态面：两侧必须同时可用，否则整单拒绝（不做半批准入）。
    for (const side of ['left', 'right'] as const) {
      if (countOfSide(side) === 0) return rejected('side-unavailable', raw.motionId + '@' + side);
      if (countOfSide(side) > 1) return rejected('ambiguous-part', raw.motionId + '@' + side);
      chosen.push({ part: partOfSide(side)!, via: 'both' });
    }
  } else {
    // auto：只在**有校准证据**的侧里选（G1 判定实验覆盖到的侧）；缺证据 fail-closed。
    const candidates = manifestIndex.list.filter(
      (p) =>
        inFamily(p) &&
        (p.side === 'left' || p.side === 'right') &&
        p.calibrated === true &&
        Object.prototype.hasOwnProperty.call(capability.variants, p.id),
    );
    if (!candidates.length) return rejected('no-calibration', raw.motionId);
    // 确定性选边：负载（该部位活跃持有数）→ manifest 声明序（先声明者优先）。
    let best = candidates[0];
    for (const candidate of candidates.slice(1)) {
      const loadBest = loadOf(live, best.id);
      const loadCand = loadOf(live, candidate.id);
      if (loadCand < loadBest) best = candidate;
    }
    chosen.push({ part: best, via: 'auto-calibrated' });
  }

  const directOutput = raw.directOutput ?? capability.directOutput ?? false;
  const selectedParts: SelectedPart[] = [];
  const domains: string[] = [];
  for (const item of chosen) {
    const built = buildSelectedPart(item.part, capability.variants[item.part.id], item.via, directOutput, raw);
    if (!built.ok) return rejected(built.reason, built.detail);
    selectedParts.push(built.value);
    domains.push(...built.domains);
  }
  const parameterDomains = sortedUnique(domains);

  // 规则 9：旧代次回调被 fence（同 executionId 已有更新代次）。
  const sameExecution = live.find((hold) => hold.executionId === raw.executionId) ?? null;
  if (sameExecution && sameExecution.generation > raw.generation) {
    return rejected('stale-generation', raw.executionId + '#' + raw.generation + '<' + sameExecution.generation);
  }

  // 冲突域 = 参数 id 重叠（gesture-timeline / LimbController 同语义）；空域不可能（上方已拒）。
  const domainSet = new Set(parameterDomains);
  const conflicts = live
    .filter((hold) => hold !== sameExecution && Array.isArray(hold.domains) && hold.domains.some((id) => domainSet.has(id)))
    .sort((a, b) => a.startAt - b.startAt || a.executionId.localeCompare(b.executionId));

  const preemptedHolds: LimbHold[] = [];
  for (const hold of conflicts) {
    const verdict = evaluateConflict(hold, raw, options);
    if (!verdict.allowed) return rejected(verdict.reason ?? 'part-busy', verdict.detail);
    preemptedHolds.push(hold);
  }

  const hold: LimbHold = {
    executionId: raw.executionId,
    generation: raw.generation,
    source: raw.source,
    motionId: raw.motionId,
    priority: raw.priority,
    parts: selectedParts.map((p) => ({ ...p })),
    domains: parameterDomains,
    startAt: t,
    endAt: t + raw.durationMs,
  };
  const preemptedKeys = new Set(preemptedHolds.map((h) => h.executionId + '#' + h.generation));
  const next = live.filter(
    (h) => h !== sameExecution && !preemptedKeys.has(h.executionId + '#' + h.generation),
  );
  next.push(hold);

  return {
    state: { holds: sortHolds(next) },
    decision: {
      accepted: true,
      outcome: 'accepted',
      selectedParts,
      selectedPartIds: sortedUnique(selectedParts.map((p) => p.partId)),
      parameterDomains,
      executionId: raw.executionId,
      generation: raw.generation,
      // 规则 10：准入成功只是 admitted，不是动作完成。
      phase: 'admitted',
      preempted: preemptedHolds.map((h) => h.executionId),
    },
  };
}

function outcomeOf(reason: LimbRejectReason): LimbDecisionOutcome {
  return reason === 'model-not-ready' ? 'blocked' : 'rejected';
}

/**
 * 终态出口（规则 8/10）：完成 / 取消 / 失败 / 超时走同一条路径。
 * - 幂等：重复 settle、或对已释放的 executionId settle → released 为空、状态不变；
 * - fence：给出 generation 且小于持有代次 → fenced=true，状态零变化（规则 9）；
 * - 找不到持有 → reason 'unknown-hold'（不算错误，等价幂等）。
 */
export function settleLimbHold(
  state: LimbPlanState | null | undefined,
  input: LimbSettleInput,
  now: number,
): LimbSettleResult {
  const { live } = pruneHolds(state, normalizeNow(now));
  const base = live;
  const raw = input && typeof input === 'object' ? input : ({} as LimbSettleInput);
  if (typeof raw.executionId !== 'string' || !raw.executionId || !isSettleOutcome(raw.outcome)) {
    return { state: { holds: sortHolds(base) }, released: [], fenced: false, reason: 'invalid-settle' };
  }
  const match = base.filter((h) => h.executionId === raw.executionId);
  if (!match.length) {
    return { state: { holds: sortHolds(base) }, released: [], fenced: false, reason: 'unknown-hold' };
  }
  if (typeof raw.generation === 'number' && Number.isFinite(raw.generation)) {
    const current = Math.max(...match.map((h) => h.generation));
    if (raw.generation < current) {
      return { state: { holds: sortHolds(base) }, released: [], fenced: true, reason: 'stale-generation' };
    }
  }
  const released = match;
  const releasedKeys = new Set(released.map((h) => h.executionId + '#' + h.generation));
  return {
    state: { holds: sortHolds(base.filter((h) => !releasedKeys.has(h.executionId + '#' + h.generation))) },
    released,
    fenced: false,
  };
}

/**
 * 到期兜底（INV-5 / S-05）：endAt <= now 的持有视为已释放。
 * 与 `planMotionAllocation` 内的清理同语义；重复调用安全（幂等）。
 */
export function tickLimbPlan(state: LimbPlanState | null | undefined, now: number): LimbTickResult {
  const { live, expired } = pruneHolds(state, normalizeNow(now));
  return { state: { holds: sortHolds(live) }, expired: sortHolds(expired) };
}

/** 查询某执行当前是否活跃（诊断/对账用；不参与决策）。 */
export function findLimbHold(
  state: LimbPlanState | null | undefined,
  executionId: string,
): LimbHold | null {
  for (const hold of stateHolds(state)) {
    if (hold && typeof hold === 'object' && hold.executionId === executionId) return hold;
  }
  return null;
}
