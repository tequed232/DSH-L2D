/**
 * 参数映射系统（任务书 Part 4）。
 *
 * 不同 Live2D 模型的参数名称、范围、表现不一致：语义层（[-1,1] / [0,1] 归一化值）
 * 与参数层（真实 Cubism 范围）之间必须经过显式映射。
 *
 * 语义值域分两类，不得混用（把眼睛开合的 0~1 错映射到角度范围是典型事故）：
 *   - unit    ：[0, 1]，如 eyes.leftOpen / eyes.rightOpen / mouth.open
 *   - bipolar ：[-1, 1]，如 head.* / eyes.gazeX/Y / brows.* / mouth.smile / mouth.form
 *
 * mapNormalizedValue 是任务书给定的双极性映射基线（保留原语义）；
 * 实际调用请按 SEMANTIC_DOMAINS 选择 mapUnitRange / mapBipolarRange。
 */

export type FacialSemantic =
  | 'head.yaw'
  | 'head.pitch'
  | 'head.roll'
  | 'eyes.leftOpen'
  | 'eyes.rightOpen'
  | 'eyes.gazeX'
  | 'eyes.gazeY'
  | 'mouth.open'
  | 'mouth.form'
  | 'brows.leftRaise'
  | 'brows.rightRaise';

export type SemanticDomain = 'unit' | 'bipolar';

/** 每个语义的输入值域。映射函数按这里选择，调用方不得自行假设。 */
export const SEMANTIC_DOMAINS = {
  'head.yaw': 'bipolar',
  'head.pitch': 'bipolar',
  'head.roll': 'bipolar',
  'eyes.leftOpen': 'unit',
  'eyes.rightOpen': 'unit',
  'eyes.gazeX': 'bipolar',
  'eyes.gazeY': 'bipolar',
  'mouth.open': 'unit',
  'mouth.form': 'bipolar',
  'brows.leftRaise': 'bipolar',
  'brows.rightRaise': 'bipolar',
} as const satisfies Record<FacialSemantic, SemanticDomain>;

export interface ParameterBinding {
  parameterId: string;

  semantic: FacialSemantic;

  /** 真实 Cubism 参数范围（来自模型扫描，不得手填猜测值） */
  min: number;
  max: number;
  defaultValue: number;

  /** 轴向反转（镜像模型 / 反装追踪轴时使用） */
  invert?: boolean;

  /** false 时该映射不参与写入（UNSUPPORTED / 用户禁用） */
  enabled: boolean;
}

/**
 * Cubism 标准参数的种子映射。只有参数真实存在（经 createBindingFromScan 扫描确认）
 * 才会进入写入链路；眉毛参数不假定所有模型都有，未扫描到即标记 UNSUPPORTED。
 */
export const DEFAULT_PARAMETER_BINDINGS: ParameterBinding[] = [
  {
    parameterId: 'ParamAngleX',
    semantic: 'head.yaw',
    min: -30,
    max: 30,
    defaultValue: 0,
    enabled: true,
  },
  {
    parameterId: 'ParamAngleY',
    semantic: 'head.pitch',
    min: -30,
    max: 30,
    defaultValue: 0,
    enabled: true,
  },
  {
    parameterId: 'ParamAngleZ',
    semantic: 'head.roll',
    min: -15,
    max: 15,
    defaultValue: 0,
    enabled: true,
  },
  {
    parameterId: 'ParamEyeLOpen',
    semantic: 'eyes.leftOpen',
    min: 0,
    max: 1,
    defaultValue: 1,
    enabled: true,
  },
  {
    parameterId: 'ParamEyeROpen',
    semantic: 'eyes.rightOpen',
    min: 0,
    max: 1,
    defaultValue: 1,
    enabled: true,
  },
  {
    parameterId: 'ParamEyeBallX',
    semantic: 'eyes.gazeX',
    min: -1,
    max: 1,
    defaultValue: 0,
    enabled: true,
  },
  {
    parameterId: 'ParamEyeBallY',
    semantic: 'eyes.gazeY',
    min: -1,
    max: 1,
    defaultValue: 0,
    enabled: true,
  },
  {
    parameterId: 'ParamMouthOpenY',
    semantic: 'mouth.open',
    min: 0,
    max: 1,
    defaultValue: 0,
    enabled: true,
  },
  {
    parameterId: 'ParamMouthForm',
    semantic: 'mouth.form',
    min: -1,
    max: 1,
    defaultValue: 0,
    enabled: true,
  },
];

/**
 * 双极性映射基线（任务书 Part 4.2 原语义）：输入 [-1, 1] 线性映射到 [binding.min, binding.max]，
 * 输出钳回参数范围。仅用于 bipolar 域语义；unit 域请用 mapUnitRange。
 */
export function mapNormalizedValue(value: number, binding: ParameterBinding): number {
  const normalized = Math.max(-1, Math.min(1, value));

  const input = binding.invert ? -normalized : normalized;

  const result = binding.min + ((input + 1) / 2) * (binding.max - binding.min);

  return Math.max(binding.min, Math.min(binding.max, result));
}

/**
 * unit 域映射：输入 [0, 1] 线性映射到 [binding.min, binding.max]，输出钳回参数范围。
 * 眼睛开合、嘴部开合等 [0,1] 语义必须走这里，避免 0 被映射到范围中点。
 */
export function mapUnitRange(value: number, binding: ParameterBinding): number {
  const clamped = Math.max(0, Math.min(1, value));
  const input = binding.invert ? 1 - clamped : clamped;
  const result = binding.min + input * (binding.max - binding.min);
  return Math.max(binding.min, Math.min(binding.max, result));
}

/** 双极性域显式版本：与 mapNormalizedValue 等价，命名上与 mapUnitRange 成对。 */
export function mapBipolarRange(value: number, binding: ParameterBinding): number {
  return mapNormalizedValue(value, binding);
}

/** 通用线性映射：输入域钳位后按比例映射到输出域。输入域上下限相等时返回 outputMin。 */
export function mapRange(
  value: number,
  inputMin: number,
  inputMax: number,
  outputMin: number,
  outputMax: number,
): number {
  const clamped = Math.max(inputMin, Math.min(inputMax, value));
  if (inputMax === inputMin) return outputMin;
  const ratio = (clamped - inputMin) / (inputMax - inputMin);
  return outputMin + ratio * (outputMax - outputMin);
}
