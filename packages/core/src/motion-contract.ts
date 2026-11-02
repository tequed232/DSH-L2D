/**
 * Model-agnostic motion contracts.
 * Behavior planning speaks in semantic control IDs, never Cubism parameter IDs.
 */
export const MOTION_CONTRACT_VERSION = 1 as const;
export type SemanticControlId =
  | 'head.yaw' | 'head.pitch' | 'head.roll' | 'torso.lean' | 'torso.sway'
  | 'gaze.x' | 'gaze.y' | 'arm.left.raise' | 'arm.left.extend'
  | 'arm.right.raise' | 'arm.right.extend';
export type CapabilityStatus = 'supported' | 'approximate' | 'unsupported';
export type MotionAssetKind = 'motion' | 'pose' | 'expression' | 'gesture';

export interface SemanticControlCapability {
  id: SemanticControlId | string;
  status: CapabilityStatus;
  /** Canonical semantic controls use normalized [-1, 1] values. */
  min: number;
  max: number;
  neutral: number;
  confidence: number;
  reason?: string;
  /** Adapter-private source ID; never expose this to the behavior planner. */
  sourceId?: string;
  resourceGroup?: string;
}
export interface MotionAssetCapability {
  id: string;
  kind: MotionAssetKind;
  status: Exclude<CapabilityStatus, 'unsupported'>;
  durationMs?: number;
  resources: string[];
  interruptible: boolean;
  loopable: boolean;
}
export interface ModelMotionProfile {
  contractVersion: typeof MOTION_CONTRACT_VERSION;
  modelId: string;
  adapterId: string;
  profileRevision: string;
  controls: SemanticControlCapability[];
  assets: MotionAssetCapability[];
  metadata?: Record<string, string | number | boolean>;
}
export interface SemanticMotionFrame {
  controls: Record<string, number>;
  assetId?: string;
  weight?: number;
  source?: string;
}
export interface MotionAdapter<Model = unknown> {
  readonly id: string;
  inspect(model: Model): Promise<ModelMotionProfile> | ModelMotionProfile;
  readFrame(model: Model): Record<string, number>;
  applyFrame(model: Model, frame: SemanticMotionFrame, deltaMs: number): void;
  playAsset(model: Model, assetId: string, options?: {
    priority?: number; fadeInMs?: number; fadeOutMs?: number; loop?: boolean;
  }): Promise<{ accepted: boolean; reason?: string }>;
  reset(model: Model): void;
}
export interface MotionAdapterRegistration<Model = unknown> {
  adapter: MotionAdapter<Model>;
  supports(model: Model): boolean;
}
export function isFiniteRange(min: number, max: number, neutral: number): boolean {
  return Number.isFinite(min) && Number.isFinite(max) &&
    Number.isFinite(neutral) && min < max && neutral >= min && neutral <= max;
}
