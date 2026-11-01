export { ParamMixer } from './mixer.ts';
export type { ChannelSpec, BlendMode, MixerOptions, ParamId, ParamRange, StepSnapshot } from './mixer.ts';

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
