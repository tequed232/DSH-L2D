/**
 * 布局计算：档位 → 缩放 / 偏移 / 焦点。
 *
 * 关键取舍（都有测试兜着）：
 *   - **不用 uiScale 乘缩放**。DSH 的界面缩放会改变容器实际像素尺寸，我们观察的就是那个尺寸；
 *     再乘一次 uiScale 会变成"放大两次"，用户改缩放时模型会突然变大变小。
 *   - **不把 full/half/portrait 等同于"整体缩小"**。半身档放大并裁掉下半身，
 *     焦点放在上半身，而不是把完整角色压成一个小人。
 *   - 缩放有上下限：上限避免贴图被放大糊掉，下限避免小到看不见。
 */
import type { LayoutInput, LayoutResult, VisibilityMode } from './presentation-types.ts';

/** 焦点区域占模型全高的比例（按常见半身立绘估，真机可校准） */
export const FOCUS_RATIO = {
  face: 0.24,
  'upper-body': 0.62,
  'full-body': 1,
} as const;

export const MAX_SCALE = 1.25;
export const MIN_SCALE = 0.2;
/** 顶部留白，别让头发贴边 */
export const MARGIN_TOP = 8;

export function modeFocus(mode: VisibilityMode): LayoutResult['focus'] {
  if (mode === 'full') return 'full-body';
  if (mode === 'half') return 'upper-body';
  return 'face';
}

export function computeLayout(input: LayoutInput, mode: VisibilityMode): LayoutResult {
  const focus = modeFocus(mode);
  const cw = Math.max(1, input.containerWidth);
  const ch = Math.max(1, input.containerHeight);
  const mw = Math.max(1, input.modelWidth);
  const mh = Math.max(1, input.modelHeight);

  if (mode === 'hidden') {
    return { mode, scale: 0, offsetX: 0, offsetY: 0, focus, reason: '隐藏：不绘制' };
  }

  const ratio = FOCUS_RATIO[focus];
  // 让"焦点区域"刚好填满容器高度所需的缩放
  const heightBudget = ch / ratio;
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.min(cw / mw, heightBudget / mh)));

  const drawnH = mh * scale;
  // 模型中心相对容器中心的纵向偏移：让模型顶边落在 MARGIN_TOP
  const offsetY = MARGIN_TOP - ch / 2 + drawnH / 2;
  const offsetX = 0;

  return {
    mode,
    scale,
    offsetX,
    offsetY,
    focus,
    reason: `${focus} · scale=${scale.toFixed(3)}${scale === MAX_SCALE ? '（已到上限）' : ''}${scale === MIN_SCALE ? '（已到下限）' : ''}`,
  };
}
