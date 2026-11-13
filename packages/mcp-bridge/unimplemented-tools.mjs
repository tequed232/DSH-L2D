/**
 * 未实现的工具名登记表（诚实失败，而不是静默无动作）。
 *
 * 现状：`l2d_emote` 在 MCP 工具表里暴露、宿主 guardAiCall 也放行、`/ai/call` 会把它入队，
 * 但**渲染端没有实现这个名字**（`packages/renderer/src` 全仓无 `l2d_emote` 处理分支）。
 * 结果是调用方以为发成功了，角色却一动不动——比直接报错更糟。
 *
 * 处理原则：拦在宿主入口，返回可执行的替代路径，而不是让错误穿过整条链路。
 * 等渲染端真的实现（或改成走已发布动作程序）后，从这里删掉即可。
 */
export const UNIMPLEMENTED_TOOLS = Object.freeze({
  l2d_emote: {
    reason: 'emote-unimplemented',
    status: 501,
    message: 'l2d_emote 宿主端未实现（渲染端无该指令处理分支），调用不会产生任何动作',
    alternatives: [
      'POST /dsh-l2d/api/actions/dispatch {actionId, parameters, requestId}（已发布动作，确定性执行）',
      'MCP: l2d_graph_run（运行已存在的节点图）',
      'MCP: l2d_perform（presetState / segments 编排）',
    ],
  },
});

/**
 * @param {string} name 工具名
 * @returns {null | {reason: string, status: number, message: string, alternatives: string[]}}
 */
export function unimplementedTool(name) {
  const key = typeof name === 'string' ? name.trim() : '';
  if (!key) return null;
  return Object.prototype.hasOwnProperty.call(UNIMPLEMENTED_TOOLS, key) ? UNIMPLEMENTED_TOOLS[key] : null;
}
