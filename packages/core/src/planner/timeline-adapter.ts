/**
 * Timeline 执行适配器（PR-D）。计划 → 交给既有执行链的指令序列。
 * 结构性保证：适配器产出里**不存在**参数写入原语——写入只属于 ParamInjector，
 * 且每条指令链必须声明经过 Gesture Admission（admit）入口。
 */
import type { MotionPlan, MotionPlanStep } from './types.ts';
import { sequencingConstraints, type MotionConflict } from './conflict-resolver.ts';

export type TimelineInstruction =
  /** 经由 Gesture Admission（actGate.admit）开链 */
  | { kind: 'admit'; planId: string; priority: MotionPlanStep['priority']; callId?: string | number }
  /** 交给既有 playMotion 路径（motion3） */
  | { kind: 'play-motion'; actionId: string; motionName: string; group: string; priority: MotionPlanStep['priority'] }
  /** 交给既有表情通道 */
  | { kind: 'set-expression'; actionId: string; expressionName: string; durationMs?: number }
  /** 交给既有 keyframes 播放路径（ownership 经 injector.own，仍非直写） */
  | { kind: 'play-keyframes'; actionId: string; controlId: string; durationMs?: number; requiresOwnership: boolean }
  /** 交给既有视线/连续控制通道 */
  | { kind: 'continuous-control'; actionId: string; controlId: string; requiresOwnership: boolean }
  /** 结链（finishAct）；phase 由 Runtime 三态生命周期回报 */
  | { kind: 'finish'; planId: string }
  /** 排队等待：sequence 约束的前序动作未到终态 */
  | { kind: 'wait-terminal'; after: string; then: string; reason: string };

/**
 * 计划 → 有序指令序列。
 * - 全部指令经由既有入口（admit/play-motion/set-expression/play-keyframes），无直写原语；
 * - sequence 冲突 → 注入 wait-terminal 指令（等前序 end/interrupted/failed）；
 * - 优先级升序稳定性：同优先级保持计划声明顺序（Timeline 的组调度照常工作）。
 */
export function planToTimelineInstructions(plan: MotionPlan, conflicts: readonly MotionConflict[]): TimelineInstruction[] {
  const out: TimelineInstruction[] = [];
  const head = plan.actions.find((a) => a.priority === Math.max(...plan.actions.map((x) => x.priority)));
  out.push({ kind: 'admit', planId: plan.planId, priority: head ? head.priority : 50, callId: undefined });
  const seq = new Map<string, string[]>();
  for (const c of sequencingConstraints(conflicts)) {
    if (!seq.has(c.then)) seq.set(c.then, []);
    seq.get(c.then)!.push(c.after);
  }
  const ordered = [...plan.actions].sort((a, b) => b.priority - a.priority); // 高优先级先入列
  for (const step of ordered) {
    const waits = seq.get(step.actionId) || [];
    for (const after of waits) out.push({ kind: 'wait-terminal', after, then: step.actionId, reason: 'sequence 冲突约束' });
    switch (step.type) {
      case 'motion3':
        out.push({ kind: 'play-motion', actionId: step.actionId, motionName: step.payload.name || '', group: step.group, priority: step.priority });
        break;
      case 'expression':
        out.push({ kind: 'set-expression', actionId: step.actionId, expressionName: step.payload.name || '', durationMs: step.payload.durationMs });
        break;
      case 'parameter':
        out.push({ kind: 'continuous-control', actionId: step.actionId, controlId: step.payload.controlId || '', requiresOwnership: step.requiresOwnership });
        break;
      case 'keyframes':
        out.push({ kind: 'play-keyframes', actionId: step.actionId, controlId: step.payload.controlId || '', durationMs: step.payload.durationMs, requiresOwnership: step.requiresOwnership });
        break;
    }
  }
  out.push({ kind: 'finish', planId: plan.planId });
  return out;
}

/** 结构断言：指令序列不含任何参数直写原语（回归防线，测试与运行前自检共用）。 */
export function assertNoDirectParamWrites(instructions: readonly TimelineInstruction[]): boolean {
  const FORBIDDEN = ['set-parameter', 'write-param', 'inject', 'setvalue'];
  return instructions.every((ins) => !FORBIDDEN.some((f) => (ins as { kind: string }).kind.toLowerCase().includes(f)));
}
