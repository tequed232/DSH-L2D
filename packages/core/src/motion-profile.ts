import {
  MOTION_CONTRACT_VERSION, isFiniteRange, isSemanticControlId, isSemanticSource,
  type MotionAdapterRegistration, type MotionAssetCapability,
  type ModelMotionProfile, type SemanticControlCapability,
} from './motion-contract.ts';

export interface ProfileValidation { ok: boolean; errors: string[]; warnings: string[]; }

const CAPABILITY_STATUSES = ['supported', 'approximate', 'unsupported', 'unknown'] as const;
const ASSET_STATUSES = ['supported', 'approximate'] as const;
const ASSET_KINDS = ['motion', 'pose', 'expression', 'gesture'] as const;

/**
 * Profile 校验。纯函数，Adapter 装配时调一次，不进帧循环。
 *
 * fail-closed 语义：`unknown` 是合法状态但**不可写**（见 resolveSemanticControl）；
 * 无法确认的能力必须报 unknown，不允许猜成 supported。
 */
export function validateMotionProfile(profile: unknown): ProfileValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    return { ok: false, errors: ['profile must be an object'], warnings };
  }
  const value = profile as Partial<ModelMotionProfile>;
  if (value.contractVersion !== MOTION_CONTRACT_VERSION) errors.push('unsupported contractVersion');
  if (typeof value.modelId !== 'string' || !value.modelId.trim()) errors.push('modelId is required');
  if (typeof value.adapterId !== 'string' || !value.adapterId.trim()) errors.push('adapterId is required');
  if (typeof value.profileRevision !== 'string' || !value.profileRevision.trim()) errors.push('profileRevision is required');
  if (!Array.isArray(value.controls)) errors.push('controls must be an array');
  if (!Array.isArray(value.assets)) errors.push('assets must be an array');

  const controls = Array.isArray(value.controls) ? value.controls : [];
  const seenControls = new Set<string>();
  for (const [index, raw] of controls.entries()) {
    const control = raw as SemanticControlCapability;
    if (!control || typeof control.id !== 'string' || !control.id.trim()) {
      errors.push(`controls[${index}].id is required`); continue;
    }
    // 标准 id 或 ext. 扩展 id；拼错的标准 id 不能被悄悄接受。
    if (!isSemanticControlId(control.id)) errors.push(`controls[${index}].id is not a semantic control id: ${control.id}`);
    if (seenControls.has(control.id)) errors.push(`duplicate control: ${control.id}`);
    seenControls.add(control.id);
    if (!(CAPABILITY_STATUSES as readonly string[]).includes(control.status)) errors.push(`controls[${index}].status is invalid`);
    if (!isFiniteRange(control.min, control.max, control.neutral)) errors.push(`controls[${index}] has invalid range or neutral value`);
    if (!Number.isFinite(control.confidence) || control.confidence < 0 || control.confidence > 1) errors.push(`controls[${index}].confidence must be within [0, 1]`);
    if (control.status === 'supported' && !control.sourceId) warnings.push(`supported control ${control.id} has no sourceId; adapter must resolve it internally`);
    // unknown 必须带原因，否则回执里无法解释降级。
    if (control.status === 'unknown' && !control.reason) warnings.push(`unknown control ${control.id} has no reason`);
  }

  const assets = Array.isArray(value.assets) ? value.assets : [];
  const seenAssets = new Set<string>();
  for (const [index, raw] of assets.entries()) {
    const asset = raw as MotionAssetCapability;
    if (!asset || typeof asset.id !== 'string' || !asset.id.trim()) {
      errors.push(`assets[${index}].id is required`); continue;
    }
    if (seenAssets.has(asset.id)) errors.push(`duplicate asset: ${asset.id}`);
    seenAssets.add(asset.id);
    if (!(ASSET_KINDS as readonly string[]).includes(asset.kind)) errors.push(`assets[${index}].kind is invalid`);
    if (!(ASSET_STATUSES as readonly string[]).includes(asset.status)) errors.push(`assets[${index}].status is invalid`);
    if (!Array.isArray(asset.resources) || asset.resources.some((x) => typeof x !== 'string')) errors.push(`assets[${index}].resources must be string[]`);
    if (typeof asset.interruptible !== 'boolean') errors.push(`assets[${index}].interruptible must be boolean`);
    if (typeof asset.loopable !== 'boolean') errors.push(`assets[${index}].loopable must be boolean`);
    if (asset.durationMs !== undefined && (!Number.isFinite(asset.durationMs) || asset.durationMs < 0)) errors.push(`assets[${index}].durationMs must be non-negative`);
  }

  if (value.metadata !== undefined) {
    const metadata = value.metadata as unknown;
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      errors.push('metadata must be an object');
    } else {
      for (const [key, item] of Object.entries(metadata as Record<string, unknown>)) {
        const ok = typeof item === 'string' || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item));
        if (!ok) errors.push(`metadata.${key} must be string | number | boolean`);
      }
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}

/**
 * 解析语义控制。null 表示**不可写**：unsupported（模型不支持）与 unknown（无法确认）
 * 一律 fail-closed；调用方应把 null 转成结构化降级原因，而不是自己猜参数。
 */
export function resolveSemanticControl(profile: ModelMotionProfile | null | undefined, id: string): SemanticControlCapability | null {
  if (!profile || !Array.isArray(profile.controls)) return null;
  const found = profile.controls.find((item) => item && item.id === id);
  if (!found) return null;
  if (found.status === 'unsupported' || found.status === 'unknown') return null;
  return found;
}

/**
 * 选 Adapter。`supports()` 抛异常时继续试下一个，但把告警收集起来（不要静默吞）：
 * 模型选错 Adapter 必须能在诊断里看到。
 */
export function selectMotionAdapter<Model>(
  model: Model,
  registrations: MotionAdapterRegistration<Model>[],
  options: { warnings?: string[] } = {},
): MotionAdapterRegistration<Model> | null {
  if (!Array.isArray(registrations)) return null;
  for (const [index, registration] of registrations.entries()) {
    if (!registration || typeof registration.supports !== 'function') {
      if (options.warnings) options.warnings.push(`adapter[${index}] has no supports(); skipped`);
      continue;
    }
    try {
      if (registration.supports(model)) return registration;
    } catch (error) {
      if (options.warnings) {
        const name = registration.adapter && registration.adapter.id ? registration.adapter.id : String(index);
        options.warnings.push(`adapter ${name} supports() threw: ${String((error as Error)?.message ?? error)}`);
      }
    }
  }
  return null;
}

/**
 * 语义值限幅。非法 profile / 非法 capability 一律返回 null（不返回 NaN）：
 * NaN 一旦进入参数写入，渲染端会写出无效值。
 */
export function clampSemanticValue(capability: SemanticControlCapability | null | undefined, value: number): number | null {
  if (!capability || typeof capability !== 'object') return null;
  if (capability.status === 'unsupported' || capability.status === 'unknown') return null;
  if (!Number.isFinite(value)) return null;
  if (!Number.isFinite(capability.min) || !Number.isFinite(capability.max)) return null;
  if (capability.min > capability.max) return null;
  return Math.max(capability.min, Math.min(capability.max, value));
}

/** Profile 是否声明了某类能力（供 planner 做降级决策）。 */
export function hasAsset(profile: ModelMotionProfile | null | undefined, assetId: string): boolean {
  if (!profile || !Array.isArray(profile.assets)) return false;
  return profile.assets.some((asset) => asset && asset.id === assetId && (asset.status === 'supported' || asset.status === 'approximate'));
}

/** 扩展通道是否被允许（`ext.` 前缀，且 source 秩合法）。 */
export function isExtensionControlId(id: string): boolean {
  return typeof id === 'string' && id.startsWith('ext.');
}

export { isSemanticSource };
