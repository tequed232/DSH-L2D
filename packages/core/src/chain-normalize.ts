/**
 * 动作链 → 执行计划（并行组 / 整组超时 / 冲突降级）。
 *
 * 纯函数：不碰 DOM/GL，也不做准入判断（准入仍是 `ActGate`）。
 * 这里只回答一个问题：**每一步在什么时刻投放**。
 *
 * 语义（2026-11-03 拍板）：
 * - 同一 `group` 的步骤进同一个时间桶，一次投放（并行）；
 * - 并行组按「整组」原子打断 —— 一条链只有一个 runId，ActGate 天然满足；
 * - `mode` 只表达组语义（sequence | parallel），`parallel` 必须带 `group`；
 *   混合语义（override/add）叫 blend，属于 frame/binding，不进链；
 * - `timeoutMs` 是整组超时，执行层到点取消整组并回执 `reason:'timeout'`；
 * - 组内参数域重叠时自动降级为串行并记 notes，
 *   避免两个节点各自覆盖同一参数（典型：两个 look、同一侧手臂、两个表情）。
 */

export type ActStepKind = 'expression' | 'motion' | 'pose' | 'look' | 'keyframes';

/** 链步骤：既有 ActStep 的字段 + 并行组三位（宿主 validateActChain 已放行）。 */
export interface ChainStep {
  kind: ActStepKind;
  name?: string;
  clear?: boolean;
  closeMotion?: string;
  closeAfterMs?: number;
  delayMs?: number;
  pose?: {
    right?: 'rest' | 'finger' | 'grass' | 'chest';
    left?: 'rest' | 'finger' | 'grass' | 'chest';
  };
  x?: number;
  y?: number;
  tracks?: unknown;
  duration?: number;
  loop?: boolean;
  /** 并行组 id：同组进同一时间桶。 */
  group?: string;
  /** 组语义；缺省 sequence。parallel 必须带 group，否则执行层按 sequence 处理。 */
  mode?: 'sequence' | 'parallel';
  /** 整组超时（ms）：到点取消整组，0/缺省 = 不限。 */
  timeoutMs?: number;
}

export interface PlannedStep {
  /** 绝对投放时刻（相对链开始，ms）。 */
  atMs: number;
  /** 该步自己的 delayMs（降级成串行时要用回原值）。 */
  delayMs: number;
  step: ChainStep;
}

export interface PlanBucket {
  atMs: number;
  steps: PlannedStep[];
  group: string;
  timeoutMs: number;
  /** true = 组内域冲突，已降级为串行。 */
  downgraded: boolean;
}

export interface ActPlan {
  buckets: PlanBucket[];
  notes: string[];
  /** 计划寿命（ms）：给 armActEnd 兜底结束用，语义与 overlay 的 plannedLifeMs 一致。 */
  lifeMs: number;
}

export const PARALLEL_OVERLAP_NOTE = 'parallel-overlap-downgraded';
export const GROUP_TIMEOUT_NOTE = 'group-timeout';
export const GROUP_TIMEOUT_MAX_MS = 8000;

/** 一步会写到的参数/通道域。同域并行会互相覆盖，必须串行。 */
export function stepDomains(step: ChainStep | null | undefined): string[] {
  if (!step || typeof step !== 'object') return ['unknown'];
  switch (step.kind) {
    case 'expression':
      return ['expression'];
    case 'motion':
      return ['motion'];
    case 'keyframes':
      return ['keyframes'];
    case 'look':
      // look 同时写头部输入与眼球：两者分开列，便于和姿态/手臂区分。
      return ['head', 'eye'];
    case 'pose': {
      const domains: string[] = [];
      if (step.pose && step.pose.left) domains.push('arm-left');
      if (step.pose && step.pose.right) domains.push('arm-right');
      return domains.length ? domains : ['pose'];
    }
    default:
      return ['unknown'];
  }
}

function overlaps(a: string[], b: string[]): boolean {
  // unknown 不可判定，宁可并行（执行层有 Mixer/Director 兜底），不误降级。
  if (a.indexOf('unknown') >= 0 || b.indexOf('unknown') >= 0) return false;
  for (const d of a) if (b.indexOf(d) >= 0) return true;
  return false;
}

const clampTimeout = (value: unknown): number => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(GROUP_TIMEOUT_MAX_MS, Math.round(n));
};

const delayOf = (step: ChainStep): number => {
  const n = Number(step && step.delayMs);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/**
 * 归一化：把声明顺序的链变成按时刻排序的桶。
 * 不修改入参（返回新对象），可在每帧安全调用（实际每链只调一次）。
 */
export function normalizeActChain(chain: readonly ChainStep[] | null | undefined): ActPlan {
  const steps = Array.isArray(chain) ? chain : [];
  const notes: string[] = [];
  const buckets: PlanBucket[] = [];
  const groupStarts = new Map<string, PlanBucket>();
  let elapsed = 0;

  for (const step of steps) {
    if (!step || typeof step !== 'object') continue;
    const delay = delayOf(step);
    const group = typeof step.group === 'string' && step.group ? step.group : '';

    if (!group) {
      elapsed += delay;
      buckets.push({
        atMs: elapsed,
        steps: [{ atMs: elapsed, delayMs: delay, step }],
        group: '',
        timeoutMs: clampTimeout(step.timeoutMs),
        downgraded: false,
      });
      continue;
    }

    let bucket = groupStarts.get(group);
    if (!bucket) {
      bucket = { atMs: elapsed + delay, steps: [], group, timeoutMs: 0, downgraded: false };
      groupStarts.set(group, bucket);
      buckets.push(bucket);
      bucket.steps.push({ atMs: bucket.atMs, delayMs: delay, step });
      // 首成员：组开始时刻已经含过 delay，不能重复累加
      elapsed = Math.max(elapsed, bucket.atMs);
    } else {
      bucket.steps.push({ atMs: bucket.atMs + delay, delayMs: delay, step });
      elapsed = Math.max(elapsed, bucket.atMs + delay);
    }
    bucket.timeoutMs = Math.max(bucket.timeoutMs, clampTimeout(step.timeoutMs));
  }

  // 组内域冲突 → 该组降级为串行（保留每步自己的 delayMs），并记 notes。
  for (const bucket of buckets) {
    if (bucket.steps.length < 2) continue;
    const domains = bucket.steps.map((node) => stepDomains(node.step));
    const conflict =
      bucket.steps.length > 1 &&
      domains.some((a, i) => domains.some((b, j) => j > i && overlaps(a, b)));
    if (!conflict) continue;
    let at = bucket.atMs;
    bucket.steps.forEach((node, index) => {
      if (index > 0) at += node.delayMs;
      node.atMs = at;
    });
    bucket.downgraded = true;
    notes.push(PARALLEL_OVERLAP_NOTE + ':' + bucket.group);
  }

  // 并行组的 steps 要按时刻排，执行层才不用自己找最早的那个。
  for (const bucket of buckets) {
    bucket.steps.sort((a, b) => a.atMs - b.atMs);
    bucket.atMs = bucket.steps[0].atMs;
  }
  buckets.sort((a, b) => a.atMs - b.atMs);

  // 寿命：与 overlay 既有 plannedLifeMs 同口径（每步 +1800ms，收招动作按时长），
  // 再并上整组超时，别让 armActEnd 在超时前把槽提前放掉。
  let lifeMs = 400;
  for (const bucket of buckets) {
    for (const node of bucket.steps) {
      const base = Math.max(0, node.atMs) + 1800;
      lifeMs = Math.max(lifeMs, base);
      if (node.step.closeMotion) {
        lifeMs = Math.max(lifeMs, node.atMs + (Number(node.step.closeAfterMs) || 6000) + 200);
      }
    }
    if (bucket.timeoutMs > 0) lifeMs = Math.max(lifeMs, bucket.atMs + bucket.timeoutMs);
  }

  if (notes.length) {
    const seen = new Set<string>();
    for (let i = notes.length - 1; i >= 0; i--) {
      if (seen.has(notes[i])) notes.splice(i, 1);
      else seen.add(notes[i]);
    }
  }

  return { buckets, notes, lifeMs };
}
