/**
 * 未实现的工具名登记表（诚实失败，而不是静默无动作）。
 *
 * ⚠ 教训（2026-11-13）：曾把 `l2d_emote` 误登记为死工具——判断依据是
 * "packages/renderer 没有处理分支"，但真正的消费者是**插件侧浏览器脚本**
 * `packages/dsh-l2d-plugin/lib/overlay.js`（case 'l2d_emote' → emotionSignal）。
 * 误判导致 501 拦截弄坏了一个能用的工具，已回滚。
 * 教训：判定死工具必须以 `tools/dead-tool-scan.mjs` 的全量消费方扫描为准，
 * 且 `case '<name>':` 分支出现在任何消费层（renderer / overlay / 宿主路由）都算"活着"。
 *
 * 当前登记为空。新增条目前必须先跑扫描并确认目标名字在所有消费层都无 `case` 分支；
 * alternatives 里只能写真实存在的工具名（先在 server.mjs registerTool 里核对）。
 */
export const UNIMPLEMENTED_TOOLS = Object.freeze({});

/**
 * @param {string} name 工具名
 * @returns {null | {reason: string, status: number, message: string, alternatives: string[]}}
 */
export function unimplementedTool(name) {
  const key = typeof name === 'string' ? name.trim() : '';
  if (!key) return null;
  return Object.prototype.hasOwnProperty.call(UNIMPLEMENTED_TOOLS, key) ? UNIMPLEMENTED_TOOLS[key] : null;
}
