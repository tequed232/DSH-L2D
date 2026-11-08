/**
 * 默认情绪模板（任务书 Part 3.2）。
 *
 * 模板只是初始配置（情绪 → 默认强度）；实际表情由 LLM 输出的完整 Intent 决定，
 * 模板不会绕过 validator，也不会直接写 Cubism 参数。
 */
import type { FacialIntent } from './facial-intent.ts';

export const DEFAULT_FACIAL_INTENTS: Record<string, Partial<FacialIntent>> = {
  neutral: {
    intensity: 0.2,
  },

  happy: {
    intensity: 0.7,
  },

  shy: {
    intensity: 0.6,
  },

  curious: {
    intensity: 0.65,
  },

  surprised: {
    intensity: 0.8,
  },

  sad: {
    intensity: 0.65,
  },

  focused: {
    intensity: 0.55,
  },

  tired: {
    intensity: 0.5,
  },
};

/** 读取情绪模板强度；未登记的情绪回退 neutral。 */
export function getTemplateIntensity(emotion: string): number {
  const template = DEFAULT_FACIAL_INTENTS[emotion] ?? DEFAULT_FACIAL_INTENTS.neutral;
  return template.intensity ?? 0.2;
}
