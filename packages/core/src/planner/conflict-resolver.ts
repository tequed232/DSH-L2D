/**
 * Motion Conflict Resolver（PR-D，纯函数，无副作用）。
 *
 * 四类冲突 × 三种裁决（sequence/blend/reject），判定输入是 PlanStepFootprint
 * （写集摘要，由 Capability Manifest 与 write-plan 证据标注）。本文件零通道名、
 * 零参数名——一切具体 id 由证据侧给出，与 shared-arbitration.ts 同口径。
 */
import type { MotionConflict, MotionConflictResolution, PlanStepFootprint } from './types.ts';

function overlap<T>(a: readonly T[], b: readonly T[]): T[] {
  const setB = new Set(b);
  return a.filter((x) => setB.has(x));
}

/**
 * 逐对冲突分析：返回 0..n 条冲突记录（同一对动作可能同时命中多类）。
 * 裁决优先级：physics_conflict(reject) > ownership_conflict > motion_exclusive > parameter_overlap。
 */
export function analyzePair(a: PlanStepFootprint, b: PlanStepFootprint): MotionConflict[] {
  const out: MotionConflict[] = [];
  const pair = `${a.actionId} × ${b.actionId}`;

  // 1. physics_conflict：任一步触碰装饰域或共享枢纽 → 无条件 reject
  if (a.touchesDecoration || b.touchesDecoration) {
    const who = a.touchesDecoration ? a.actionId : b.actionId;
    out.push({
      actionA: a.actionId, actionB: b.actionId,
      type: 'physics_conflict', resolution: 'reject',
      reason: `${who} 触碰装饰/物理域参数：物理模拟保持原生，Agent 不接管（头发物理 × 直接改头发 = 拒绝）`,
    });
  } else if (a.touchesSharedHub || b.touchesSharedHub) {
    const who = a.touchesSharedHub ? a.actionId : b.actionId;
    out.push({
      actionA: a.actionId, actionB: b.actionId,
      type: 'physics_conflict', resolution: 'reject',
      reason: `${who} 触碰共享枢纽参数（G0 S1-S5），独占会拖动全身随动链`,
    });
  }

  // 2. ownership_conflict：都要认领同一批物理输出
  const ownOverlap = overlap(a.ownershipParams, b.ownershipParams);
  if (ownOverlap.length) {
    out.push({
      actionA: a.actionId, actionB: b.actionId,
      type: 'ownership_conflict',
      resolution: 'sequence',
      reason: `同一批物理输出被双方认领（${ownOverlap.length} 个）→ 高优先级先执行，低优先级排队`,
    });
  }

  // 3. motion_exclusive：同动作槽组（ActGate 单槽语义）
  if (a.type === 'motion3' && b.type === 'motion3' && a.motionGroup && a.motionGroup === b.motionGroup) {
    out.push({
      actionA: a.actionId, actionB: b.actionId,
      type: 'motion_exclusive',
      resolution: 'sequence',
      reason: `同动作槽（${a.motionGroup}）：状态机同一时刻只收一条 motion → 排队`,
    });
  }

  // 4. parameter_overlap：写集重叠（非 ownership 通道）
  const paramOverlap = overlap(a.writeParams, b.writeParams);
  if (paramOverlap.length && !ownOverlap.length) {
    const sameGroup = a.group === b.group;
    let resolution: MotionConflictResolution;
    let reason: string;
    if (!a.verified || !b.verified) {
      resolution = 'reject';
      reason = `写集重叠（${paramOverlap.length} 个参数）且存在未验证参数组 → fail-closed`;
    } else if (sameGroup) {
      // 同一头参数的两个动作：仲裁排队（用户示例 3）
      resolution = 'sequence';
      reason = `同组（${a.group}）写集重叠 → 仲裁为先后执行`;
    } else {
      // 参数组独立且已验证 → 允许并行（混合）
      resolution = 'blend';
      reason = `跨组写集重叠但参数组独立且已验证 → 允许组合`;
    }
    out.push({ actionA: a.actionId, actionB: b.actionId, type: 'parameter_overlap', resolution, reason });
  }
  void pair;
  return out;
}

/** 整计划两两分析；返回全部冲突（含用户四示例同型的裁定）。 */
export function analyzePlanConflicts(steps: readonly PlanStepFootprint[]): MotionConflict[] {
  const out: MotionConflict[] = [];
  for (let i = 0; i < steps.length; i++) {
    for (let j = i + 1; j < steps.length; j++) {
      out.push(...analyzePair(steps[i], steps[j]));
    }
  }
  return out;
}

/** 计划裁决汇总：任一 reject → 整计划拒绝（保守；部分执行留给后续按需放宽）。 */
export function planVerdict(conflicts: readonly MotionConflict[]): 'allow' | 'reject' {
  return conflicts.some((c) => c.resolution === 'reject') ? 'reject' : 'allow';
}

/**
 * 冲突 → 执行序列约束：sequence 对的后者必须等前者终态（end/interrupted/failed 三态之一）。
 * 输出 pair 约束表，供 Timeline 适配器排序（本函数不执行）。
 */
export function sequencingConstraints(conflicts: readonly MotionConflict[]): Array<{ after: string; then: string; reason: string }> {
  return conflicts
    .filter((c) => c.resolution === 'sequence')
    .map((c) => ({ after: c.actionA, then: c.actionB, reason: c.reason }));
}
