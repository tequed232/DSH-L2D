/**
 * Cubism Adapter（任务书 Part 10）—— Facial Intelligence 与现有 Renderer 的唯一入口。
 *
 * 本文件只定义适配接口、参数扫描映射与写入诊断；不做任何「假设 Cubism Framework
 * 对象拥有这些方法」的实现。真实实现必须基于仓库现有 Cubism SDK 版本与模型实例。
 *
 * 铁律：不允许在参数不存在时静默返回成功 —— 每次写入都必须产出
 * ParameterWriteResult（success / reason），失败必须显式上报给 Inspector。
 */
import { SEMANTIC_DOMAINS } from '../controller/parameter-mapping.ts';
import type { FacialSemantic, ParameterBinding } from '../controller/parameter-mapping.ts';

/**
 * 模型参数适配接口。真实实现由渲染层提供（包装 CubismModel 的参数读写）；
 * 本包内的测试用 mock 实现该接口验证链路。
 */
export interface CubismParameterAdapter {
  hasParameter(id: string): boolean;

  getParameterValue(id: string): number | null;

  getParameterRange(id: string): {
    min: number;
    max: number;
    defaultValue: number;
  } | null;

  setParameterValue(id: string, value: number): boolean;

  /** 模型指纹（用于检测模型切换）；模型未就绪时返回空字符串 */
  getModelFingerprint(): string;
}

export type ParameterWriteFailReason =
  | 'PARAMETER_NOT_FOUND'
  | 'MODEL_NOT_READY'
  | 'OUT_OF_RANGE'
  | 'ADAPTER_ERROR';

export interface ParameterWriteResult {
  parameterId: string;
  requestedValue: number;
  appliedValue?: number;

  success: boolean;

  reason?: ParameterWriteFailReason;
}

export interface BindingScanResult {
  /** 扫描时的模型指纹；空字符串表示模型未就绪 */
  fingerprint: string;
  /** 扫描成功并启用 bindings：数值范围 / 默认值全部来自真实模型，不带猜测 */
  bindings: ParameterBinding[];
  /** 不支持的语义（未扫描到候选参数或模型未就绪），按任务书标记 UNSUPPORTED */
  unsupported: Array<{ semantic: FacialSemantic; reason: 'PARAMETER_NOT_FOUND' | 'MODEL_NOT_READY' }>;
}

/**
 * 每个语义在扫描时依次尝试的候选参数 ID（Cubism 标准名 + 常见别名）。
 * 只是探测候选，不会写入；是否真实存在以 hasParameter/getParameterRange 为准。
 */
export const SEMANTIC_PARAMETER_CANDIDATES: Record<FacialSemantic, string[]> = {
  'head.yaw': ['ParamAngleX'],
  'head.pitch': ['ParamAngleY'],
  'head.roll': ['ParamAngleZ'],
  'eyes.leftOpen': ['ParamEyeLOpen'],
  'eyes.rightOpen': ['ParamEyeROpen'],
  'eyes.gazeX': ['ParamEyeBallX'],
  'eyes.gazeY': ['ParamEyeBallY'],
  'mouth.open': ['ParamMouthOpenY', 'ParamMouthOpen'],
  'mouth.form': ['ParamMouthForm'],
  // 眉毛参数不假定所有模型都有：候选扫不到就标 UNSUPPORTED，由 Inspector 提示用户
  'brows.leftRaise': ['ParamBrowLY', 'ParamBrowL_Y', 'ParamBrowLForm', 'ParamBrowLAngle'],
  'brows.rightRaise': ['ParamBrowRY', 'ParamBrowR_Y', 'ParamBrowRForm', 'ParamBrowRAngle'],
};

/**
 * 扫描当前模型并为语义建立参数映射（任务书 Part 4.1）。
 * 范围与默认值一律取自真实模型，不使用 DEFAULT_PARAMETER_BINDINGS 的猜测值；
 * 该常量仅作为语义清单与 fallback 候选的来源。
 *
 * 模型未就绪（指纹为空）时 fail-closed：全部语义进 unsupported，不产出任何 binding。
 */
export function createBindingFromScan(
  adapter: CubismParameterAdapter,
  options: {
    /** 覆盖候选表（默认 SEMANTIC_PARAMETER_CANDIDATES） */
    candidates?: Record<FacialSemantic, string[]>;
    /** 追加扫描的额外语义（如模型特有参数）不在本函数范围内，由调用方自行登记 */
  } = {},
): BindingScanResult {
  const fingerprint = adapter.getModelFingerprint();
  const candidates = options.candidates ?? SEMANTIC_PARAMETER_CANDIDATES;
  const bindings: ParameterBinding[] = [];
  const unsupported: BindingScanResult['unsupported'] = [];

  for (const semantic of Object.keys(candidates) as FacialSemantic[]) {
    if (!fingerprint) {
      unsupported.push({ semantic, reason: 'MODEL_NOT_READY' });
      continue;
    }

    let matched: { id: string; range: NonNullable<ReturnType<CubismParameterAdapter['getParameterRange']>> } | null =
      null;
    for (const id of candidates[semantic]) {
      if (!adapter.hasParameter(id)) continue;
      const range = adapter.getParameterRange(id);
      if (range === null) continue;
      if (!(range.max > range.min)) continue; // 非法范围视同不存在，不得建映射
      matched = { id, range };
      break;
    }

    if (matched === null) {
      unsupported.push({ semantic, reason: 'PARAMETER_NOT_FOUND' });
      continue;
    }

    bindings.push({
      parameterId: matched.id,
      semantic,
      min: matched.range.min,
      max: matched.range.max,
      defaultValue: matched.range.defaultValue,
      enabled: true,
    });
  }

  return { fingerprint, bindings, unsupported };
}

export interface ApplyToAdapterOptions {
  /**
   * 越界处理：true（默认）裁剪后写入；false 时拒绝写入并返回 OUT_OF_RANGE。
   * 默认裁剪与 validator 的「越界按明确规则裁剪」语义一致。
   */
  clampOutOfRange?: boolean;
}

/**
 * 把最终参数值写入适配器，逐条返回写入诊断。
 *
 * - 只处理 values 中出现的参数（未请求的参数不产生结果条目）
 * - 禁用映射（enabled=false）是配置态而非写入失败，不产生条目（Inspector 显示 UNSUPPORTED）
 * - 参数不存在 → PARAMETER_NOT_FOUND；模型未就绪 → MODEL_NOT_READY
 * - 写入后回读适配器值作为 appliedValue，便于诊断真实落盘值
 */
export function applyToAdapter(
  adapter: CubismParameterAdapter,
  bindings: ParameterBinding[],
  values: Record<string, number>,
  options: ApplyToAdapterOptions = {},
): ParameterWriteResult[] {
  const results: ParameterWriteResult[] = [];
  const clampOutOfRange = options.clampOutOfRange ?? true;

  const fingerprint = adapter.getModelFingerprint();
  const modelReady = fingerprint !== '';

  for (const binding of bindings) {
    if (!binding.enabled) continue;
    const requested = values[binding.parameterId];
    if (requested === undefined) continue;
    if (!Number.isFinite(requested)) {
      results.push({
        parameterId: binding.parameterId,
        requestedValue: requested,
        success: false,
        reason: 'ADAPTER_ERROR',
      });
      continue;
    }

    if (!modelReady) {
      results.push({
        parameterId: binding.parameterId,
        requestedValue: requested,
        success: false,
        reason: 'MODEL_NOT_READY',
      });
      continue;
    }

    if (!adapter.hasParameter(binding.parameterId)) {
      results.push({
        parameterId: binding.parameterId,
        requestedValue: requested,
        success: false,
        reason: 'PARAMETER_NOT_FOUND',
      });
      continue;
    }

    const range = adapter.getParameterRange(binding.parameterId);
    const min = range !== null ? range.min : binding.min;
    const max = range !== null ? range.max : binding.max;

    if (!(max > min)) {
      results.push({
        parameterId: binding.parameterId,
        requestedValue: requested,
        success: false,
        reason: 'ADAPTER_ERROR',
      });
      continue;
    }

    const outOfRange = requested < min || requested > max;
    if (outOfRange && !clampOutOfRange) {
      results.push({
        parameterId: binding.parameterId,
        requestedValue: requested,
        success: false,
        reason: 'OUT_OF_RANGE',
      });
      continue;
    }

    const target = Math.max(min, Math.min(max, requested));
    let ok = false;
    try {
      ok = adapter.setParameterValue(binding.parameterId, target);
    } catch {
      ok = false;
    }

    if (!ok) {
      results.push({
        parameterId: binding.parameterId,
        requestedValue: requested,
        success: false,
        reason: 'ADAPTER_ERROR',
      });
      continue;
    }

    const appliedValue = adapter.getParameterValue(binding.parameterId) ?? target;
    results.push({
      parameterId: binding.parameterId,
      requestedValue: requested,
      appliedValue,
      success: true,
    });
  }

  return results;
}
