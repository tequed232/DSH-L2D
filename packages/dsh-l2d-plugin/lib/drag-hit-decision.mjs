/**
 * dsh-l2d · 左键拖拽「起拖判定」纯函数（overlay.js 内联副本的单一事实源）。
 *
 * 背景缺陷：overlay 的 pointerdown 里 requestHitSample() 要等下一帧渲染才产出
 * alpha 样本，而 overModel(e) 立即读缓存；hover 采样 10Hz 节流，快速移动鼠标后
 * 首次点击人物时，采样点距点击点常 >16px，渲染包 hitTestAt 直接 false → 起不了拖。
 *
 * 修复口径（两级判定）：
 *   ① 渲染包 hitTestAt 命中（其内部已含 16px 偏差检查，true 即权威）→ 走原路径；
 *   ② hitTestAt 未命中（无论因样本过期、偏差大还是 alpha 未命中）→ 回退同步
 *      包围盒 hitTestBox（与右键菜单同一通道）；两者都未命中才放行事件到下层页面。
 *
 * sampleAvailable / sampleAge / sampleOffset 是可选元数据：渲染包当前不向 overlay
 * 暴露采样点坐标与时间戳，overlay 侧传不进来；字段留着供将来渲染包扩展接口时
 * 细化 reason，且任何「不可用」证据都会把兜底原因标成 sample-unusable-*。
 * 容差核查结论：16px 轴向容差在渲染包内部（不动渲染包）；overlay 侧的放宽方式
 * 就是②的无条件包围盒兜底，不再叠加额外阈值。
 */

/** 样本最大可容忍年龄（ms）：hover 采样 10Hz 节流 + 高刷屏掉帧余量 */
export const HIT_SAMPLE_MAX_AGE_MS = 250;
/** 采样点与点击点的轴向偏差容忍（px）：与渲染包 hitTestAt 内部阈值一致 */
export const HIT_SAMPLE_MAX_OFFSET_PX = 16;

function sampleUsable(i) {
  if (i.sampleAvailable === false) return false;
  if (typeof i.sampleAge === 'number' && i.sampleAge > HIT_SAMPLE_MAX_AGE_MS) return false;
  if (typeof i.sampleOffset === 'number' && i.sampleOffset > HIT_SAMPLE_MAX_OFFSET_PX) return false;
  return true;
}

/**
 * @param {{
 *   legacy?: boolean,          // 无渲染包命中 API（旧包/静态兜底）
 *   hitTestAt?: boolean|null,  // 渲染包 alpha 采样判定结果
 *   hitTestBox?: boolean|null, // 渲染包同步包围盒判定结果（null=接口缺失）
 *   sampleAvailable?: boolean, // 可选：渲染包是否已有样本
 *   sampleAge?: number,        // 可选：样本年龄 ms
 *   sampleOffset?: number,     // 可选：采样点与点击点的轴向偏差 px
 * }} input
 * @returns {{ start: boolean, reason: string }}
 */
export function shouldStartDrag(input) {
  const i = input || {};
  if (i.legacy) return { start: true, reason: 'legacy' }; // 旧渲染包：保持整盒可交互
  if (i.hitTestAt === true) return { start: true, reason: 'sample-hit' }; // 样本优先
  if (i.hitTestBox === true) {
    return { start: true, reason: sampleUsable(i) ? 'sample-miss-box-hit' : 'sample-unusable-box-hit' };
  }
  return { start: false, reason: sampleUsable(i) ? 'sample-miss' : 'sample-unusable-miss' };
}
