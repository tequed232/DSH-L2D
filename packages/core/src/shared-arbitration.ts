/**
 * 共享通道仲裁（docs/Embodied-Behavior.md §4 C2/C3 / §8 M1-c「LeanInput/表情共享仲裁」）。
 *
 * 互斥关系（LeanInput 与 gaze.look_* 双向互斥、表情族两两互斥、成对动作互斥）
 * 全部来自画像 `controls[].conflicts` 数据（tools/capability-scan/w3-controls.mjs
 * 派生，canExpress 消费同一份数据），本文件**零通道名**。
 *
 * `arbitrateShared(current, incoming)` 只回答一个问题：incoming 现在能不能上。
 * 四种决定（与 ActGate/LimbController 同一份优先级语义）：
 *   accept = 无冲突（或冲突占用已过期），直接表达；
 *   yield  = 有冲突但 incoming 优先级 >= 全部冲突占用（同级可打断 / 高打低）→
 *            当前占用让位（conflicts 列出被让位者，Timeline 替换语义，C3/C5）；
 *   queue  = incoming 优先级更低，但全部冲突占用都有到期时间（endsAt 有限）→
 *            排队，readyAt = 冲突占用的最大到期时刻；
 *   reject = incoming 未登记/不支持（fail-closed，canExpress 同语义）、
 *            或低优先级撞上长期持有（endsAt 为空）的占用（LimbController
 *            priority-blocked 同语义）。
 *
 * 与 canExpress 的分工：canExpress 回答「这个通道在当前激活集下能否表达」
 * （单向查 incoming 的 conflicts + pose/motionPlaying 约束）；本函数在此基础上
 * 补上冲突明细、双向声明检查与 让位/拒绝/排队 决策，供 Timeline/Mixer 接线。
 */
import type { ModelMotionProfile, SemanticControlCapability, SemanticPriority } from './motion-contract.ts';

/** ActGate 缺省档位（NORMAL）。 */
export const DEFAULT_SHARED_PRIORITY: SemanticPriority = 50;

/** 一次共享通道占用（当前或 incoming）。通道 id 允许带/不带 `ext.` 前缀。 */
export interface SharedChannelUse {
  channelId: string;
  /** ActGate 优先级（10/50/90）；缺省 50。 */
  priority?: SemanticPriority;
  /** 占用开始时刻（诊断用，可选）。 */
  startedAt?: number;
  /** 到期时刻；null/undefined = 长期持有（须显式释放，同 LimbController 语义）。 */
  endsAt?: number | null;
  runId?: string;
}

export type SharedDecision = 'accept' | 'yield' | 'reject' | 'queue';

export type SharedRejectReason =
  | 'invalid-incoming'       // incoming 形状非法
  | 'unknown-channel'        // 画像里没有该通道（fail-closed，R11 同型）
  | 'unsupported-channel'    // status 为 unsupported/unknown 或缺 sourceId
  | 'held-indefinitely';     // 低优先级撞上长期持有的冲突占用

export interface SharedConflict {
  channelId: string;
  runId?: string;
  priority: number;
  endsAt?: number | null;
  /** 冲突依据：同通道替换（C3）/ incoming 声明的 conflicts / 占用方声明的 conflicts。 */
  via: 'same-channel' | 'incoming-conflicts' | 'current-conflicts';
}

export interface SharedArbitration {
  decision: SharedDecision;
  /** 冲突的当前占用（yield 时即被让位者；accept 时为空）。 */
  conflicts: SharedConflict[];
  /** queue 时的最早可上时刻 = 冲突占用最大 endsAt。 */
  readyAt?: number;
  /** reject 的原因码（diagnostics）。 */
  reason?: SharedRejectReason;
}

function normalizeExtId(id: string): string {
  return typeof id === 'string' && id.startsWith('ext.') ? id : 'ext.' + id;
}

function findControl(
  profile: ModelMotionProfile | null | undefined,
  id: string,
): SemanticControlCapability & { conflicts?: readonly string[] } | null {
  if (!profile || !Array.isArray(profile.controls) || typeof id !== 'string' || !id) return null;
  // 先精确匹配（标准语义 id / 已带 ext. 前缀），再试补 ext. 前缀（canExpress 同口径）。
  const exact = profile.controls.find((c) => c && c.id === id);
  if (exact) return exact as SemanticControlCapability & { conflicts?: readonly string[] };
  const normalized = normalizeExtId(id);
  if (normalized !== id) {
    const ext = profile.controls.find((c) => c && c.id === normalized);
    if (ext) return ext as SemanticControlCapability & { conflicts?: readonly string[] };
  }
  return null;
}

/** 通道同一性：原始相等，或 ext. 前缀归一后相等。 */
function sameChannel(a: string, b: string): boolean {
  return a === b || normalizeExtId(a) === normalizeExtId(b);
}

/**
 * 画像 conflicts 匹配规则（与 semantic-binding.ts canExpress 同语义）：
 * 精确相等，或 `x.*` 通配前缀；比较在 ext. 归一后进行。
 */
function conflictMatches(pattern: string, id: string): boolean {
  const p = normalizeExtId(pattern);
  const i = normalizeExtId(id);
  return sameChannel(pattern, id) || (p.endsWith('.*') && i.startsWith(p.slice(0, -1)));
}

/**
 * 共享通道仲裁（纯函数）。
 *
 * @param profile  模型能力画像（conflicts 数据源；模型差异不允许写进本文件）
 * @param current  当前共享通道占用列表（按调用方的活跃集传入）
 * @param incoming 待决通道请求
 * @param options.now  过期判定基准时刻；缺省不做过期过滤（全部占用视为活跃）
 */
export function arbitrateShared(
  profile: ModelMotionProfile | null | undefined,
  current: readonly SharedChannelUse[] | null | undefined,
  incoming: SharedChannelUse | null | undefined,
  options: { now?: number } = {},
): SharedArbitration {
  const fail = (reason: SharedRejectReason): SharedArbitration => ({ decision: 'reject', conflicts: [], reason });

  if (!incoming || typeof incoming !== 'object' || typeof incoming.channelId !== 'string' || !incoming.channelId) {
    return fail('invalid-incoming');
  }
  const incomingId = normalizeExtId(incoming.channelId);
  const incomingControl = findControl(profile, incomingId);
  if (!incomingControl) return fail('unknown-channel');
  if (
    (incomingControl.status !== 'supported' && incomingControl.status !== 'approximate') ||
    !incomingControl.sourceId
  ) {
    return fail('unsupported-channel'); // fail-closed：判不出来就拒绝，不猜
  }

  const now = options.now;
  const isExpired = (use: SharedChannelUse): boolean =>
    now !== undefined && use.endsAt != null && use.endsAt <= now;

  const incomingPatterns: readonly string[] = Array.isArray(incomingControl.conflicts)
    ? incomingControl.conflicts
    : [];

  const conflicts: SharedConflict[] = [];
  for (const use of Array.isArray(current) ? current : []) {
    if (!use || typeof use !== 'object' || typeof use.channelId !== 'string' || !use.channelId) continue;
    if (isExpired(use)) continue; // 已到期的占用视为已释放（INV-5 同型），不构成冲突
    const useId = normalizeExtId(use.channelId);
    if (sameChannel(use.channelId, incoming.channelId)) {
      conflicts.push({ channelId: useId, runId: use.runId, priority: use.priority ?? DEFAULT_SHARED_PRIORITY, endsAt: use.endsAt ?? null, via: 'same-channel' });
      continue;
    }
    // 双向检查：不假设画像已把互斥关系两边都声明（数据缺一边也不漏判）。
    if (incomingPatterns.some((p) => conflictMatches(normalizeExtId(p), useId))) {
      conflicts.push({ channelId: useId, runId: use.runId, priority: use.priority ?? DEFAULT_SHARED_PRIORITY, endsAt: use.endsAt ?? null, via: 'incoming-conflicts' });
      continue;
    }
    const useControl = findControl(profile, useId);
    const usePatterns: readonly string[] = useControl && Array.isArray(useControl.conflicts) ? useControl.conflicts : [];
    if (usePatterns.some((p) => conflictMatches(normalizeExtId(p), incomingId))) {
      conflicts.push({ channelId: useId, runId: use.runId, priority: use.priority ?? DEFAULT_SHARED_PRIORITY, endsAt: use.endsAt ?? null, via: 'current-conflicts' });
    }
  }

  if (!conflicts.length) return { decision: 'accept', conflicts: [] };

  const incomingPriority = incoming.priority ?? DEFAULT_SHARED_PRIORITY;
  const maxCurrent = Math.max(...conflicts.map((c) => c.priority));
  if (incomingPriority >= maxCurrent) {
    // 同级可打断 / 高打低：当前占用让位（Timeline 替换语义，C3/C5）。
    return { decision: 'yield', conflicts };
  }
  // 低不打断高（LimbController priority-blocked 同语义）：全部冲突占用可到期 → 排队；否则拒绝。
  const finiteEnds = conflicts.map((c) => c.endsAt).filter((e): e is number => typeof e === 'number' && Number.isFinite(e));
  if (finiteEnds.length === conflicts.length) {
    return { decision: 'queue', conflicts, readyAt: Math.max(...finiteEnds) };
  }
  return { decision: 'reject', conflicts, reason: 'held-indefinitely' };
}
