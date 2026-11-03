/**
 * 可见性判定：给多少空间就露多少，而不是把整个模型一味缩小。
 *
 * 三条硬规则：
 *   1. 用户意愿 > 自动判断（用户手动隐藏后，AI 再兴奋也不弹出来）。
 *   2. 页面不可见 → hidden，但 renderState 只降为 suspended，行为链继续跑。
 *   3. 档位切换带**滞回**：进入与退出阈值不同，避免侧边栏拖到临界值时来回跳。
 */
import type { LayoutInput, VisibilityDecision, VisibilityMode } from './presentation-types.ts';

/** 阈值。首次标定，真机再按实际 UI 校准。 */
export const THRESHOLDS = {
  /** 宽度 ≥ 420 才进 full */
  fullEnter: 420,
  /** 已 full 时掉到 380 以下才退出（40px 滞回带） */
  fullExit: 380,
  halfEnter: 240,
  halfExit: 200,
  /** 太矮时不谈"完整角色"，再宽也只能半身 */
  heightForFull: 320,
  heightForHalf: 200,
} as const;

const ORDER: VisibilityMode[] = ['hidden', 'portrait', 'half', 'full'];

export function visibilityController(input: LayoutInput, previous: VisibilityMode | null): VisibilityDecision {
  if (input.userOverride === 'hide') {
    return { mode: 'hidden', renderState: 'suspended', reason: '用户手动隐藏', forced: true };
  }
  if (!input.pageVisible) {
    return { mode: 'hidden', renderState: 'suspended', reason: '页面不可见（标签切走/窗口最小化）', forced: false };
  }

  const auto = autoMode(input, previous);
  if (input.userOverride === 'show') {
    // 用户强制显示：至少给 portrait，不受"空间不足"影响，但也不会比 auto 更大
    const mode = ORDER.indexOf(auto.mode) >= ORDER.indexOf('portrait') ? auto.mode : 'portrait';
    return { ...auto, mode, forced: true, reason: `用户强制显示；${auto.reason}` };
  }
  return auto;
}

function autoMode(input: LayoutInput, previous: VisibilityMode | null): VisibilityDecision {
  const w = Math.max(0, input.containerWidth);
  const h = Math.max(0, input.containerHeight);
  const prev = previous && previous !== 'hidden' ? previous : null;

  // 滞回：已经在大档位时，用更低的退出阈值
  const fullFloor = prev === 'full' ? THRESHOLDS.fullExit : THRESHOLDS.fullEnter;
  const halfFloor = prev === 'half' || prev === 'full' ? THRESHOLDS.halfExit : THRESHOLDS.halfEnter;

  if (w >= fullFloor && h >= THRESHOLDS.heightForFull) {
    return { mode: 'full', renderState: 'active', reason: `空间充足 ${Math.round(w)}×${Math.round(h)}`, forced: false };
  }
  if (w >= halfFloor && h >= THRESHOLDS.heightForHalf) {
    return {
      mode: 'half',
      renderState: 'active',
      reason: `空间有限 ${Math.round(w)}×${Math.round(h)} → 半身`,
      forced: false,
    };
  }
  return {
    mode: 'portrait',
    renderState: 'reduced',
    reason: `空间不足 ${Math.round(w)}×${Math.round(h)} → 只保留头部`,
    forced: false,
  };
}

/**
 * 渲染状态与档位解耦：hidden 才是 suspended，
 * 其余档位即使降质也保持 active（动作链不能因为"变小了"就停）。
 */
export function renderStateFor(mode: VisibilityMode): 'active' | 'reduced' | 'suspended' {
  if (mode === 'hidden') return 'suspended';
  if (mode === 'portrait') return 'reduced';
  return 'active';
}
