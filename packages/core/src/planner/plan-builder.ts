/**
 * Motion Planner 计划构建（PR-D）。
 * Agent 意图 → MotionPlan；未验证能力 fail-closed，不进计划。
 * 只产出计划描述；执行交给既有 Behavior Loop / Timeline / Gesture Admission。
 */
import { isSemanticPriority, type SemanticPriority } from '../motion-contract.ts';
import type { MotionPlan, MotionPlanStep, PlannerIntent } from './types.ts';

/** 能力提供方：由 Capability Manifest / ModelMotionProfile 侧注入（规划期证据源）。 */
export interface PlannerCapabilityProvider {
  /** 表情通道能否表达（canExpress 同源证据） */
  canExpress(controlId: string): boolean;
  /** motion3 动作在该模型上是否存在且可用（Actions Lib / motion profile 证据） */
  hasMotion(name: string): boolean;
  /** parameter 通道是否已验证（未验证 fail-closed） */
  isVerifiedControl(controlId: string): boolean;
  /** 连续控制需要认领的物理输出（决定 requiresOwnership） */
  ownershipForControl(controlId: string): string[];
}

/** intensity 0..1 → 既有优先级档位（10/50/90，不新增词汇）。 */
export function priorityFromIntensity(intensity: number): SemanticPriority {
  const v = Number.isFinite(intensity) ? Math.max(0, Math.min(1, intensity)) : 0.5;
  if (v >= 0.8) return 90;
  if (v >= 0.3) return 50;
  return 10;
}

let planSeq = 0;
export function resetPlanSeqForTest(): void { planSeq = 0; }

/** 意图 → 计划。被证据拒绝的意图段不进计划并留痕（planner 拒绝清单）。 */
export function buildMotionPlan(
  intent: PlannerIntent,
  capabilities: PlannerCapabilityProvider,
): { plan: MotionPlan | null; rejected: Array<{ segment: string; reason: string }> } {
  const rejected: Array<{ segment: string; reason: string }> = [];
  const actions: MotionPlanStep[] = [];
  const priority = priorityFromIntensity(intent.intensity);

  // 1. emotion → expression（表情域；表情族互斥由 shared-arbitration 在执行层裁决）
  if (intent.emotion) {
    const controlId = `emotion.${intent.emotion}`;
    if (!capabilities.canExpress(controlId)) {
      rejected.push({ segment: `emotion:${intent.emotion}`, reason: `表情通道 ${controlId} 未登记/不支持（fail-closed）` });
    } else {
      actions.push({
        actionId: `exp-${intent.emotion}-${++planSeq}`,
        type: 'expression',
        priority,
        group: 'face',
        payload: { name: intent.emotion, durationMs: intent.durationMs },
        requiresOwnership: false,
      });
    }
  }

  // 2. gesture → motion3（预制动作；Actions Lib 校验在查询层）
  if (intent.gesture) {
    if (!capabilities.hasMotion(intent.gesture)) {
      rejected.push({ segment: `gesture:${intent.gesture}`, reason: `动作 ${intent.gesture} 不在该模型可用清单（Actions Lib 证据缺失）` });
    } else {
      actions.push({
        actionId: `mot-${intent.gesture}-${++planSeq}`,
        type: 'motion3',
        priority,
        group: 'gesture',
        payload: { name: intent.gesture },
        requiresOwnership: false,
      });
    }
  }

  // 3. gaze → parameter（连续控制；必须已验证，否则 fail-closed）
  if (intent.gaze) {
    const controlId = 'gaze.look_at';
    if (!capabilities.isVerifiedControl(controlId)) {
      rejected.push({ segment: 'gaze', reason: `视线通道 ${controlId} 未验证 → 不进计划（fail-closed）` });
    } else {
      actions.push({
        actionId: `gaze-${++planSeq}`,
        type: 'parameter',
        priority,
        group: 'gaze',
        payload: { controlId, durationMs: intent.durationMs },
        requiresOwnership: capabilities.ownershipForControl(controlId).length > 0,
      });
    }
  }

  // 4. posture → keyframes（局部轨迹细节；同样需验证）
  if (intent.posture) {
    const controlId = `posture.${intent.posture}`;
    if (!capabilities.isVerifiedControl(controlId)) {
      rejected.push({ segment: `posture:${intent.posture}`, reason: `姿态通道 ${controlId} 未验证 → 不进计划（fail-closed）` });
    } else {
      actions.push({
        actionId: `post-${intent.posture}-${++planSeq}`,
        type: 'keyframes',
        priority,
        group: 'posture',
        payload: { controlId, durationMs: intent.durationMs },
        requiresOwnership: capabilities.ownershipForControl(controlId).length > 0,
      });
    }
  }

  if (!actions.length) return { plan: null, rejected };
  for (const step of actions) {
    if (!isSemanticPriority(step.priority)) {
      // 防御：优先级词汇漂移即整体拒产（计划层不发明新档位）
      return { plan: null, rejected: [...rejected, { segment: step.actionId, reason: `非法优先级 ${step.priority}（只允许 10/50/90）` }] };
    }
  }
  const plan: MotionPlan = {
    planId: `plan-${Date.now()}-${planSeq}`,
    actions,
    constraints: {
      preservePhysics: true, // 规划层默认保物理；装饰/共享域拒绝在冲突层强制
      allowInterruption: priority < 90, // FORCE(90) 不允许被打断（ActGate 同语义）
      allowBlending: true,
    },
  };
  return { plan, rejected };
}
