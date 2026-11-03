export { ParamMixer } from './mixer.ts';
export { planSemanticPosture, canExpress } from './semantic-binding.ts';
export type { SemanticWrite, SkippedChannel, PosturePlan } from './semantic-binding.ts';
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
