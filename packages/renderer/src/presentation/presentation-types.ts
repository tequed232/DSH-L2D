/**
 * 呈现层类型。与"角色怎么动"（Motion Engine）严格分开：
 * 这里只回答"角色在哪、多大、露出多少"。
 */

/** 展示档位。portrait = 只留头部，hidden = 不绘制。 */
export type VisibilityMode = 'full' | 'half' | 'portrait' | 'hidden';

/** 渲染状态：hidden 时降为 suspended，但 AI 行为链照常运行。 */
export type RenderState = 'active' | 'reduced' | 'suspended';

/** 呈现容器。pane=右侧面板内嵌，overlay=框架之上，window=桌面原生窗。 */
export type PresentationMode = 'pane' | 'overlay' | 'window';

/** 用户意愿优先于自动判断。 */
export type UserOverride = 'auto' | 'show' | 'hide';

export interface LayoutInput {
  /** 角色容器实际内容区（不是 window.innerWidth） */
  containerWidth: number;
  containerHeight: number;
  /** DSH 界面缩放；1 = 100% */
  uiScale: number;
  /** 设备像素比 */
  devicePixelRatio: number;
  /** 模型设计尺寸（画布逻辑像素） */
  modelWidth: number;
  modelHeight: number;
  pageVisible: boolean;
  userOverride: UserOverride;
}

/** 上一次的档位，用于滞回；首次传 null。 */
export interface LayoutState {
  mode: VisibilityMode | null;
  scale: number;
  offsetX: number;
  offsetY: number;
}

export interface VisibilityDecision {
  mode: VisibilityMode;
  renderState: RenderState;
  reason: string;
  /** 是否由用户强制（强制时不做滞回与自动切换） */
  forced: boolean;
}

export interface LayoutResult {
  mode: VisibilityMode;
  /** 模型绘制缩放（1 = 原始尺寸） */
  scale: number;
  /** 相对容器中心的偏移（CSS 像素） */
  offsetX: number;
  offsetY: number;
  /** 焦点：face 只保证头在框内，upper-body 保留到腰，full-body 全保留 */
  focus: 'face' | 'upper-body' | 'full-body';
  reason: string;
}
