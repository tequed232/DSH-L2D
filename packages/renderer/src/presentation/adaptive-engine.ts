/**
 * 自适应呈现引擎：一次调用拿到「露多少 + 多大 + 放哪」。
 *
 * 调用方（宿主容器 / 面板 / 悬浮窗）只需要把一个 LayoutInput 丢进来，
 * 拿 LayoutResult 去改 iframe 的 transform。它不碰模型参数、不碰动作链，
 * 也不创建渲染实例——这保证了"身体状态不依赖显示在哪个容器"。
 */
import type { LayoutInput, LayoutState, LayoutResult, VisibilityDecision } from './presentation-types.ts';
import { visibilityController, renderStateFor } from './visibility-controller.ts';
import { computeLayout } from './layout-calculator.ts';
import { smoothLayout, initialLayout, DEFAULT_TAU, type LayoutView } from './transition-controller.ts';

export interface EngineResult {
  decision: VisibilityDecision;
  layout: LayoutResult;
  /** 平滑后的实际渲染值；首帧等于目标值 */
  view: LayoutView & { settled: boolean };
}

export interface EngineOptions {
  tau?: { scale: number; offset: number };
}

/**
 * @param input  当前容器与用户意愿
 * @param state  上一次的档位与渲染值（首次传 null）
 * @param dtMs   距上次调用的毫秒数（首帧传 0）
 */
export function stepPresentation(
  input: LayoutInput,
  state: LayoutState | null,
  dtMs: number,
  options: EngineOptions = {},
): EngineResult {
  const decision = visibilityController(input, state ? state.mode : null);
  const mode = decision.mode;
  const layout = computeLayout(input, mode);
  const tau = options.tau || DEFAULT_TAU;

  if (!state || !(dtMs > 0) || mode === 'hidden') {
    // 首帧 / 隐藏 / 无时间步长：直接对齐，不做平滑（隐藏时 scale=0 立刻生效）
    return { decision, layout, view: initialLayout(layout) };
  }

  const from: LayoutView = { scale: state.scale, offsetX: state.offsetX, offsetY: state.offsetY };
  return { decision, layout, view: smoothLayout(from, layout, dtMs, tau) };
}

/** 把结果折成下一次调用需要的 state */
export function nextState(result: EngineResult): LayoutState {
  return {
    mode: result.decision.mode,
    scale: result.view.scale,
    offsetX: result.view.offsetX,
    offsetY: result.view.offsetY,
  };
}

export { visibilityController, computeLayout, renderStateFor };
export { THRESHOLDS } from './visibility-controller.ts';
export { FOCUS_RATIO, MAX_SCALE, MIN_SCALE } from './layout-calculator.ts';
