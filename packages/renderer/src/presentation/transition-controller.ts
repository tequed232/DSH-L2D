/**
 * 平滑过渡：拖动侧边栏时角色不能一格一格跳。
 *
 * 用指数平滑 x_{t+1} = x_t + (target - x_t) * (1 - e^{-dt/tau})，
 * 与帧率无关：dt 变化时收敛速度一致。tau 越大越"黏"。
 */
import type { LayoutResult } from './presentation-types.ts';

export interface LayoutView {
  scale: number;
  offsetX: number;
  offsetY: number;
}

/** 缩放跟随要慢一点（避免呼吸式抖动），位移可以快一点 */
export const DEFAULT_TAU = { scale: 140, offset: 90 } as const;

/** 与帧率无关的平滑系数。dtMs<=0 时返回 0（不动）。 */
export function smoothingAlpha(dtMs: number, tauMs: number): number {
  if (!(dtMs > 0) || !(tauMs > 0)) return 0;
  return 1 - Math.exp(-dtMs / tauMs);
}

export function smoothValue(current: number, target: number, dtMs: number, tauMs: number): number {
  return current + (target - current) * smoothingAlpha(dtMs, tauMs);
}

/** 档位切换（full↔half）时 scale 会突变，这里按 tau 追上，不做瞬间赋值 */
export function smoothLayout(
  current: LayoutView,
  target: LayoutResult,
  dtMs: number,
  tau = DEFAULT_TAU,
): LayoutView & { settled: boolean } {
  const scale = smoothValue(current.scale, target.scale, dtMs, tau.scale);
  const offsetX = smoothValue(current.offsetX, target.offsetX, dtMs, tau.offset);
  const offsetY = smoothValue(current.offsetY, target.offsetY, dtMs, tau.offset);
  const settled =
    Math.abs(scale - target.scale) < 1e-3 &&
    Math.abs(offsetX - target.offsetX) < 0.5 &&
    Math.abs(offsetY - target.offsetY) < 0.5;
  return { scale, offsetX, offsetY, settled };
}

/** 首帧：直接落到目标，不要从 0 开始"放大出现" */
export function initialLayout(target: LayoutResult): LayoutView & { settled: boolean } {
  return { scale: target.scale, offsetX: target.offsetX, offsetY: target.offsetY, settled: true };
}
