import { easeInOutCubic } from './ease.ts';

/**
 * 待机微动作采样。只产出物理输入或确认不与口型冲突的脸部参数。
 * 绝不包含 ParamMouthOpenY（口型禁区）。
 */
export type AmbientKind = 'tilt' | 'shift' | 'shrug' | 'puff' | 'pucker';

export const AMBIENT_KINDS: AmbientKind[] = ['tilt', 'shift', 'shrug', 'puff', 'pucker'];

/** 这些参数微动作不能写。 */
export const AMBIENT_FORBIDDEN = ['ParamMouthOpenY', 'ParamMouthOpen', 'ParamMouthForm'] as const;

/**
 * t ∈ [0,1]：前半程出去，后半程回到 0。sign 只作用于左右向的歪头和重心。
 * 歪头 AngleZ ±3°，重心 PositionX ±5，耸肩用 PositionY（ShoulderY 是物理输出，不能写）。
 * 鼓腮 / 嘟嘴用模型里的原拼写：CheeckPuff、Mouthpucker。
 */
export function sampleAmbient(kind: AmbientKind, t: number, sign: number): Record<string, number> {
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  const tri = clamped < 0.5 ? clamped * 2 : (1 - clamped) * 2;
  const eased = easeInOutCubic(tri);
  const s = sign < 0 ? -1 : 1;
  switch (kind) {
    case 'tilt':
      return { AngleZ: s * 3 * eased };
    case 'shift':
      return { PositionX: s * 5 * eased };
    case 'shrug':
      return { PositionY: 3 * eased };
    case 'puff':
      return { CheeckPuff: 0.45 * eased };
    case 'pucker':
      return { Mouthpucker: 0.35 * eased };
    default:
      return {};
  }
}
