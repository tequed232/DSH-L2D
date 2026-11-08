/**
 * @dsh/facial-intelligence —— Facial Control Core（PR-01）。
 *
 * 架构链路（任务书 Part 1 / 20）：
 *   LLM → Facial Intent → validateFacialPlan → FacialController
 *       → ParamMixer → applyToAdapter(Cubism Adapter) → Renderer
 *
 * LLM 不允许直接调用 Cubism SDK；所有输入必须经过本包的统一控制管线。
 * 渲染侧桥接的集成契约：
 *   import { FacialController, ParamMixer, validateFacialPlan, createBindingFromScan }
 *     from '@dsh/facial-intelligence'
 */

// ---------------------------------------------------------------- schema
export type {
  BrowIntent,
  Easing,
  Emotion,
  EyeIntent,
  FacialIntent,
  FacialPlan,
  HeadIntent,
  MouthIntent,
} from './schema/facial-intent.ts';
export { DEFAULT_FACIAL_INTENTS, getTemplateIntensity } from './schema/defaults.ts';
export {
  EMOTIONS,
  EASINGS,
  INTENT_SOURCES,
  LIMITS,
  parseFacialPlanJson,
  validateFacialPlan,
} from './schema/validator.ts';
export type { ValidationResult } from './schema/validator.ts';

// ---------------------------------------------------------------- controller
export {
  DEFAULT_PARAMETER_BINDINGS,
  SEMANTIC_DOMAINS,
  mapBipolarRange,
  mapNormalizedValue,
  mapRange,
  mapUnitRange,
} from './controller/parameter-mapping.ts';
export type { FacialSemantic, ParameterBinding, SemanticDomain } from './controller/parameter-mapping.ts';
export {
  DEFAULT_FACE_PARAMETERS,
  DEFAULT_MAX_ANGLE_DEG_PER_SECOND,
  DEFAULT_RESET_DURATION_MS,
  DEFAULT_SMOOTHING_SECONDS,
  EASING_FUNCTIONS,
  FACE_PARAMETER_BOUNDS,
  FACE_PARAMETER_KEYS,
  FacialController,
  lerp,
  smoothFactor,
} from './controller/facial-controller.ts';
export type {
  EasingFn,
  FaceParameterKey,
  FaceParameters,
  FacialControllerOptions,
  TransitionOptions,
} from './controller/facial-controller.ts';
export {
  DEFAULT_SOURCE_TIMEOUT_MS,
  LLM_MAX_PRIORITY,
  ParamMixer,
  SOURCE_PRIORITY,
} from './controller/arbitration.ts';
export type {
  ControlMode,
  MixerRange,
  MixerStepSnapshot,
  ParameterContribution,
  SourceName,
} from './controller/arbitration.ts';

// ---------------------------------------------------------------- animation
export {
  MICRO_DEFAULT_RAMP_MS,
  MICRO_MIN_PERIOD_MS,
  MICRO_TEMPLATES,
  MicroExpressionEngine,
} from './animation/micro-expression.ts';
export type { MicroParamKey, MicroTemplate, MicroWave } from './animation/micro-expression.ts';
export { BlinkController, EMOTION_BLINK_MODULATION } from './animation/blink-controller.ts';
export type { BlinkControllerOptions, BlinkFrame } from './animation/blink-controller.ts';

// ---------------------------------------------------------------- adapter
export {
  applyToAdapter,
  createBindingFromScan,
  SEMANTIC_PARAMETER_CANDIDATES,
} from './adapter/cubism-adapter.ts';
export type {
  ApplyToAdapterOptions,
  BindingScanResult,
  CubismParameterAdapter,
  ParameterWriteFailReason,
  ParameterWriteResult,
} from './adapter/cubism-adapter.ts';
