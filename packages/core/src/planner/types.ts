/**
 * 混合语义动作规划器类型（PR-D）。
 *
 * 定位铁律：Planner 只负责规划——Agent → Semantic Planner → Existing Behavior
 * Loop → Existing Timeline → Gesture Admission → ParamInjector → Cubism Runtime。
 * 不新建 Scheduler、不建第二套执行生命周期、不直接写 Cubism 参数。
 * 优先级/相位/source 全部沿用既有词汇（motion-contract / action-chain），不新增。
 */
import type { SemanticPriority } from '../motion-contract.ts';

/** 用户作业书 MotionIntent：Agent 的语义意图（不含任何参数写入）。 */
export interface PlannerIntent {
  emotion?: string;
  gesture?: string;
  gaze?: { x: number; y: number };
  posture?: string;
  /** 0..1；映射到既有 10/50/90 优先级档位 */
  intensity: number;
  durationMs?: number;
  /** 关联的 /ai/call callId（完成事件按 executionId 关联） */
  callId?: string | number;
}

export type PlannerActionType = 'motion3' | 'expression' | 'parameter' | 'keyframes';

/** 计划内单步动作（描述，不是写入指令）。 */
export interface MotionPlanStep {
  actionId: string;
  type: PlannerActionType;
  /** 既有 ActGate 优先级档位（10/50/90） */
  priority: SemanticPriority;
  /** 互斥组（同组动作不并行；组名沿用动作域词汇） */
  group: string;
  /** 动作载荷：motion3=动作名；expression=表情名；parameter=通道绑定；keyframes=轨道描述 */
  payload: {
    name?: string;
    /** parameter 型：既有语义控制通道 id（受 ChannelBinding 契约约束） */
    controlId?: string;
    value?: number;
    durationMs?: number;
    loop?: boolean;
  };
  /** 该步是否需要 ownership（parameter/keyframes 连续控制） */
  requiresOwnership: boolean;
}

/** 用户作业书 MotionPlan。 */
export interface MotionPlan {
  planId: string;
  actions: MotionPlanStep[];
  constraints: {
    preservePhysics: boolean;
    allowInterruption: boolean;
    allowBlending: boolean;
  };
  /** 生成计划的模型版本键（与 Capability Manifest / Actions Lib 的 modelHash 对齐） */
  modelHash?: string;
}

export type MotionConflictType =
  | 'parameter_overlap'   // 两动作写集重叠
  | 'ownership_conflict'  // 两动作都要认领同一批物理输出
  | 'motion_exclusive'    // 同一动作槽/同组 motion（状态机单槽）
  | 'physics_conflict';   // 撞物理域（装饰/共享枢纽）

export type MotionConflictResolution = 'sequence' | 'blend' | 'reject';

/** 用户作业书 MotionConflict。 */
export interface MotionConflict {
  actionA: string;
  actionB: string;
  type: MotionConflictType;
  resolution: MotionConflictResolution;
  reason: string;
}

/** 计划步的写集摘要（冲突判定输入；来自 Capability Manifest / write-plan 证据）。 */
export interface PlanStepFootprint {
  actionId: string;
  type: PlannerActionType;
  priority: SemanticPriority;
  group: string;
  /** 直接写的参数 id（parameter/keyframes 型） */
  writeParams: string[];
  /** 需要认领的物理输出（ownership 型） */
  ownershipParams: string[];
  /** motion3 的动作槽组（如 left_hand/right_hand/face） */
  motionGroup?: string;
  /** 写集中含装饰域或共享枢纽参数（由调用方按 manifest 标注） */
  touchesDecoration: boolean;
  touchesSharedHub: boolean;
  /** 参数组是否已验证（Capability 证据） */
  verified: boolean;
}
