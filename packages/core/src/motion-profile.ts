import {
  MOTION_CONTRACT_VERSION, isFiniteRange,
  type ModelMotionProfile, type SemanticControlCapability,
  type MotionAssetCapability, type MotionAdapterRegistration,
} from './motion-contract.ts';

export interface ProfileValidation { ok: boolean; errors: string[]; warnings: string[]; }

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
    if (seenControls.has(control.id)) errors.push(`duplicate control: ${control.id}`);
    seenControls.add(control.id);
    if (!['supported', 'approximate', 'unsupported'].includes(control.status)) errors.push(`controls[${index}].status is invalid`);
    if (!isFiniteRange(control.min, control.max, control.neutral)) errors.push(`controls[${index}] has invalid range or neutral value`);
    if (!Number.isFinite(control.confidence) || control.confidence < 0 || control.confidence > 1) errors.push(`controls[${index}].confidence must be within [0, 1]`);
    if (control.status === 'supported' && !control.sourceId) warnings.push(`supported control ${control.id} has no sourceId; adapter must resolve it internally`);
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
    if (!['motion', 'pose', 'expression', 'gesture'].includes(asset.kind)) errors.push(`assets[${index}].kind is invalid`);
    if (!['supported', 'approximate'].includes(asset.status)) errors.push(`assets[${index}].status is invalid`);
    if (!Array.isArray(asset.resources) || asset.resources.some((x) => typeof x !== 'string')) errors.push(`assets[${index}].resources must be string[]`);
    if (asset.durationMs !== undefined && (!Number.isFinite(asset.durationMs) || asset.durationMs < 0)) errors.push(`assets[${index}].durationMs must be non-negative`);
  }
  return { ok: errors.length === 0, errors, warnings };
}

export function resolveSemanticControl(profile: ModelMotionProfile, id: string): SemanticControlCapability | null {
  const found = profile.controls.find((item) => item.id === id);
  return !found || found.status === 'unsupported' ? null : found;
}
export function selectMotionAdapter<Model>(
  model: Model, registrations: MotionAdapterRegistration<Model>[],
): MotionAdapterRegistration<Model> | null {
  for (const registration of registrations) {
    try { if (registration.supports(model)) return registration; } catch { /* try next adapter */ }
  }
  return null;
}
export function clampSemanticValue(capability: SemanticControlCapability, value: number): number | null {
  if (capability.status === 'unsupported' || !Number.isFinite(value)) return null;
  return Math.max(capability.min, Math.min(capability.max, value));
}
