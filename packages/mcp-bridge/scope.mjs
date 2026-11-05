/**
 * MCP Scope 隔离（PR-B，设计契约 §5）。
 *
 * Model Control 会话专用注册器：只允许白名单前缀的工具名注册；越权名称直接
 * throw——不让「获得模型控制权限」扩散成「整个 DSH 工作区任意操作权限」。
 * Chat 会话零 l2d 工具（工具不注册进 Chat 侧 registry 即可，无需反向过滤）。
 */

export const DEFAULT_ALLOWED_PREFIXES = Object.freeze(['l2d_action_', 'l2d_get_status']);

/**
 * @param {{registerTool: Function}} innerRegistry 底层 MCP registry（如 McpServer）
 * @param {string[]} [allowedPrefixes] 白名单前缀，缺省 l2d_action_* + l2d_get_status*
 * @returns {{registerTool: Function, allowedPrefixes: string[]}}
 */
export function createScopedRegistry(innerRegistry, allowedPrefixes = DEFAULT_ALLOWED_PREFIXES) {
  if (!innerRegistry || typeof innerRegistry.registerTool !== 'function') {
    throw new Error('createScopedRegistry: innerRegistry.registerTool 必填');
  }
  if (!Array.isArray(allowedPrefixes) || allowedPrefixes.length === 0) {
    throw new Error('createScopedRegistry: allowedPrefixes 不得为空');
  }
  return {
    allowedPrefixes: Object.freeze([...allowedPrefixes]),
    registerTool(name, ...rest) {
      const toolName = String(name ?? '');
      const allowed = allowedPrefixes.some((p) => toolName.startsWith(p));
      if (!allowed) {
        // 越权注册直接失败——宁可拒绝也不静默放行
        throw new Error(`scope-forbidden: 工具 ${toolName} 不在 Model Control 白名单前缀 ${allowedPrefixes.join('/')}`);
      }
      return innerRegistry.registerTool(name, ...rest);
    },
  };
}
