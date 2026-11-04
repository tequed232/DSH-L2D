export { ParamMixer } from './mixer.ts';
export { planSemanticPosture, canExpress } from './semantic-binding.ts';
export type { SemanticWrite, SkippedChannel, PosturePlan } from './semantic-binding.ts';
export {
  POSTURE_DURATION_DEFAULT_MS,
  POSTURE_DURATION_MAX_MS,
  POSTURE_DURATION_MIN_MS,
  normalizePostureInput,
  planPostureExecution,
  shapePostureReceipt,
} from './posture.ts';
export type {
  DegradedChannel,
  NormalizedPostureInput,
  PostureAppliedWrite,
  PostureExecutionPlan,
  PostureFailedWrite,
  PostureInput,
  PostureReceipt,
} from './posture.ts';
export type { ChannelSpec, BlendMode, MixerOptions, ParamId, ParamRange, StepSnapshot } from './mixer.ts';
export { easeInOutCubic } from './ease.ts';
export { mixAdditive } from './angle-mix.ts';
export type { AngleLayer } from './angle-mix.ts';
export { sampleAmbient, AMBIENT_KINDS, AMBIENT_FORBIDDEN } from './ambient.ts';
export type { AmbientKind } from './ambient.ts';
export {
  ACT_PRIORITIES,
  ACT_PRIORITY_RANK,
  ACT_PHASE_TEMPLATES,
  ActGate,
  parseActPriority,
  canInterruptAct,
  chainHasMotion,
  motionResultKind,
  closeMotionsOnPreempt,
  preemptedYandere,
  getActPhaseTemplate,
  actTemplateWritesMouth,
} from './action-chain.ts';
export type {
  ActPriority,
  ActPhaseName,
  ActEventPhase,
  ActStep,
  ActPhaseTemplate,
  ActionDoneEvent,
  ActiveAct,
  ActAdmission,
  ActAdmitInput,
} from './action-chain.ts';

/**
 * 通道优先级。数值越大越后求值、越能覆盖前面的通道。
 * 顺序对齐设计文档：待机基座 → 表情 → 动作锁 → 面捕 → 口型硬覆盖 → 程序化叠加。
 */
export const CHANNEL_PRIORITY = {
  idle: 10,
  expression: 20,
  motion: 30,
  tracking: 40,
  lipsync: 50,
  procedural: 60,
} as const;

export type ChannelName = keyof typeof CHANNEL_PRIORITY;

/** 口型参数：行为层禁区，只有 lipSync 通道可写 */
export const LIPSYNC_PARAMS = ['ParamMouthOpenY', 'ParamMouthOpen', 'ParamMouthForm'] as const;

// ---------------------------------------------------------------- motion engine 契约（v2）
// 语义层（planner）只产出 SemanticMotionFrame；写模型必须先经 lowerFrameToIntents
// 变成既有 WriteIntent，再交给 ParamMixer/param-ownership——不允许直接写 Cubism 参数。
export {
  MOTION_CONTRACT_VERSION,
  SEMANTIC_CONTROL_IDS,
  SEMANTIC_PRIORITIES,
  SEMANTIC_SOURCE_RANK,
  isFiniteRange,
  isSemanticControlId,
  isSemanticPriority,
  isSemanticSource,
} from './motion-contract.ts';
export type {
  AnySemanticControlId,
  CapabilityStatus,
  ExtensionControlId,
  ModelMotionProfile,
  MotionAdapter,
  MotionAdapterRegistration,
  MotionAssetCapability,
  MotionAssetKind,
  SemanticControlCapability,
  SemanticControlId,
  SemanticMotionFrame,
  SemanticPriority,
  SemanticSource,
  WritePhase,
} from './motion-contract.ts';
export {
  clampSemanticValue,
  hasAsset,
  isExtensionControlId,
  resolveSemanticControl,
  selectMotionAdapter,
  validateMotionProfile,
} from './motion-profile.ts';
export type { ProfileValidation } from './motion-profile.ts';
export {
  PRE_ONLY_PARAMS,
  defaultPhaseForParam,
  lowerFrameToIntents,
  validateChannelBindings,
} from './motion-intent.ts';
export type {
  ChannelBinding,
  LowerResult,
  RejectedControl,
  WriteIntent,
} from './motion-intent.ts';
export {
  compileTrajectory,
  compileTrajectoryCached,
  easeAt,
  sampleCompiled,
  sampleTrajectory,
  sampleTrajectorySafe,
  validateTrajectory,
} from './motion-trajectory.ts';
export type {
  CompileResult,
  CompiledSegment,
  CompiledTrack,
  CompiledTrajectory,
  MotionEasing,
  MotionKeyframe,
  MotionTrack,
  MotionTrajectory,
  SafeSample,
  TrajectorySample,
} from './motion-trajectory.ts';

// ---------------------------------------------------------------- M1 所有权仲裁（WS-1）
// resolveWritePlan 纯函数：docs/Ownership-Invariants.md §1 契约 / §2 INV 不变量；
// LimbController：physics-owned ↔ limb-owned 状态机（叶子四肢 id 由调用方传入）。
// feature flag：M1_DEFAULT_ENABLED=false = 现行为，行为变化必须由调用方显式启用。
export {
  M1_DEFAULT_ENABLED,
  LIMB_BONE_PARAMS,
  LIPSYNC_PARAM_SET,
  WRITE_SOURCE_RANK,
  resolveWritePlan,
} from './write-plan.ts';
export type {
  OwnershipEntry,
  OwnershipWriteIntent,
  RejectReason,
  RejectedWrite,
  ResolveInput,
  ResolveResult,
  WriteEntry,
  WriteSource,
} from './write-plan.ts';
export { LimbController } from './limb-controller.ts';
export type {
  AcquireRejectReason,
  AcquireResult,
  LimbAcquireOptions,
  LimbControllerOptions,
  LimbOwnershipEntry,
  LimbOwnershipSnapshot,
  LimbSetResult,
} from './limb-controller.ts';

// ---------------------------------------------------------------- M1-c 手势时间线与共享仲裁
// Gesture Timeline：手势/动作段时间线编排纯函数（group/delayMs/timeoutMs 分组语义
// 与 chain-normalize 同源；可打断规则与 LimbController/ActGate 同一份；到期清理
// INV-5/S-05 同语义）。feature flag：enabled 缺省 M1_DEFAULT_ENABLED（false = 现行为）。
export {
  DEFAULT_GESTURE_PRIORITY,
  emptyTimeline,
  enqueueGesture,
  resolveTimeline,
  stopGesture,
} from './gesture-timeline.ts';
export type {
  EnqueueOptions,
  GestureEnqueueResult,
  GestureRejectReason,
  GestureSegment,
  GestureTimelineState,
  ScheduledSegment,
  StopSelector,
  TimelineResolution,
  TimelineStopResult,
} from './gesture-timeline.ts';
// 共享通道仲裁：LeanInput/gaze、表情族互斥全部读画像 conflicts 数据（零通道名），
// 输出 accept/yield/reject/queue（ActGate/LimbController 同一份优先级语义）。
export { arbitrateShared, DEFAULT_SHARED_PRIORITY } from './shared-arbitration.ts';
export type {
  SharedArbitration,
  SharedChannelUse,
  SharedConflict,
  SharedDecision,
  SharedRejectReason,
} from './shared-arbitration.ts';

// ---------------------------------------------------------------- M1-e 连续动作 Mixer
// Idle/Ambient/Media 三类连续动作统一收敛：lane 秩仲裁、agent hold 挂起/恢复、
// 抖动幂等（refresh/update 不重启）、冷却窗口、到期清理（INV-5 同语义）。
// 输出的写声明由消费方降级为 source 'continuous'/'ambient'（INV-6 秩 1）的 WriteIntent
// 喂 resolveWritePlan——连续层永不直接写模型参数，也不触碰 PhysicsGate 让位表。
// feature flag：enabled 缺省 M1E_DEFAULT_ENABLED（false = M1-b 集成后基线，回滚要求）。
export {
  M1E_DEFAULT_ENABLED,
  M1E_MAX_RELEASED_TRACKED,
  CONTINUOUS_LANES,
  CONTINUOUS_PRIORITY,
  CONTINUOUS_LANE_RANK,
  emptyContinuous,
  submitContinuous,
  setContinuousAgentHold,
  tickContinuous,
  releaseContinuous,
  resolveContinuous,
} from './continuous-action.ts';
export type {
  ContinuousAgentHold,
  ContinuousDecision,
  ContinuousEntry,
  ContinuousLane,
  ContinuousReleaseResult,
  ContinuousReleaseSelector,
  ContinuousRejectReason,
  ContinuousResolution,
  ContinuousState,
  ContinuousSubmitRequest,
  ContinuousSubmitResult,
  ContinuousTickResult,
} from './continuous-action.ts';

// ---------------------------------------------------------------- M1-f Embodied Cue 编译层
// 结构化 EmbodiedCue → 既有四入口的编译（segments → enqueueGesture、sharedUses →
// arbitrateShared、stops → stopGesture、overlays → renderer 表情开关）。同通道替换/
// 跨通道并存语义交给 gesture-timeline 既有冲突判定，本层不重复实现；channel → 原生
// 参数域映射全部来自 CueChannelBinding 数据（种子词表随本层提供，已按模型真实参数核实）。
// fail-closed：未知 channel/operation、非有限值、interruptible:false → 全进 rejected 零产出。
// feature flag：M1F_DEFAULT_ENABLED=false = 编译层不接线，渲染层现行为零变化（回滚要求）。
export {
  M1F_DEFAULT_ENABLED,
  CUE_SEED_BINDINGS,
  compileEmbodiedCue,
} from './embodied-cue.ts';
export type {
  CueChannelBinding,
  CueChannelParamBinding,
  EmbodiedCue,
  EmbodiedCueCompileOptions,
  EmbodiedCueCompileResult,
} from './embodied-cue.ts';

// ---------------------------------------------------------------- M1-f 第二批 Cue Loop
// 编译层之上的组合账本与生命周期（F2-1/3/4）：同 channel 后到替换（Body.cs:198 同语义）、
// 跨 channel 并存、durationMs 到期释放（INV-5/S-05 同型）、clear 显式释放、overlay 单槽。
// 不做跨通道求和（INV-1 唯一 winner）；准入/冲突判定仍由 enqueueGesture 单点负责。
export {
  CUE_DEFAULT_PRIORITY,
  commitCue,
  cueSnapshot,
  cueWrites,
  emptyCueLoop,
  releaseCue,
  tickCue,
} from './cue-loop.ts';
export type {
  CueChannelState,
  CueCommitOptions,
  CueCommitResult,
  CueLoopState,
  CueOverlayState,
  CueReleaseResult,
  CueReleaseSelector,
  CueSnapshot,
  CueTickResult,
  CueWritesResult,
} from './cue-loop.ts';

// ---------------------------------------------------------------- M1-g/G2 部位规划器
// 纯函数规划器/求解器：把语义动作请求映射到部位与**参数域租约**（姿态域为主战场，
// 物理输出域仅"直写输出"兜底）。零参数名——域/侧/校准证据全部来自调用方 manifest
// （G1 生成物）。feature flag：M1G2_DEFAULT_ENABLED=false（尚未接线，G4 才是接线点）。
export {
  M1G2_DEFAULT_ENABLED,
  LIMB_SOURCE_RANK,
  emptyLimbPlan,
  findLimbHold,
  planMotionAllocation,
  settleLimbHold,
  tickLimbPlan,
} from './limb-plan.ts';
export type {
  AllocationDecision,
  BehaviorSource,
  LimbDecisionOutcome,
  LimbHold,
  LimbHoldPart,
  LimbManifest,
  LimbManifestPart,
  LimbMotionCapability,
  LimbMotionVariant,
  LimbPlanOptions,
  LimbPlanResult,
  LimbPlanState,
  LimbRejectReason,
  LimbSettleInput,
  LimbSettleOutcome,
  LimbSettleResult,
  LimbSide,
  LimbTickResult,
  MotionRequest,
  SelectedPart,
  SideConstraint,
} from './limb-plan.ts';
