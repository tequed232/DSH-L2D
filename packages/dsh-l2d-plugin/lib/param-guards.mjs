/**
 * 参数名守卫（单一事实源：口型禁区）。
 *
 * 与 `packages/core/src/index.ts` 的 `LIPSYNC_PARAMS` 保持同一份名单：
 * 任何通道（HTTP / MCP / keyframes / 动作链）都不得写这三个参数。
 * 渲染端已有 keyframes 拦截；这里给宿主与 MCP 侧提供同一名单，避免各写一份漂移。
 */

/** 口型禁区参数名（永不放行）。 */
export const LIPSYNC_PARAMS = Object.freeze([
  'ParamMouthOpenY',
  'ParamMouthOpen',
  'ParamMouthForm',
]);

const RESERVED = new Set(LIPSYNC_PARAMS);

export function isReservedParam(id) {
  return typeof id === 'string' && RESERVED.has(id);
}

/**
 * 递归扫描参数对象里出现的口型参数名（键或字符串值都算）。
 * 用于 `l2d_set_parameters` / `l2d_play_keyframes` 这类以参数名为键的入参，
 * 也用于动作链的防御性扫描（正常动作链不应出现参数名）。
 *
 * @param {unknown} value
 * @param {{maxDepth?: number, maxNodes?: number}} [options]
 * @returns {string[]} 命中的参数名（去重）
 */
export function collectReservedParams(value, options = {}) {
  const maxDepth = Number(options.maxDepth) || 8;
  const maxNodes = Number(options.maxNodes) || 5000;
  const hits = new Set();
  const seen = new Set();
  let nodes = 0;

  const visit = (node, depth) => {
    if (nodes++ > maxNodes || depth > maxDepth) return;
    if (typeof node === 'string') {
      if (RESERVED.has(node)) hits.add(node);
      return;
    }
    if (!node || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    for (const [key, item] of Object.entries(node)) {
      if (RESERVED.has(key)) hits.add(key);
      visit(item, depth + 1);
    }
  };

  visit(value, 0);
  return [...hits];
}

/**
 * 统一参数写入校验（host / MCP / 未来工具共用）：
 * - 口型参数：任何通道、任何 owner 都拒绝；
 * - 物理输出：仅 `own === true` 放行（渲染层再按 ownership 表最终裁定，本函数是前置闸）。
 *
 * @param {{paramIds?: string[], own?: boolean}} request
 * @param {{physicsOutputs?: Iterable<string>}} [context]
 * @returns {{ok:true, params:string[]} | {ok:false, reason:string, params:string[]}}
 */
export function checkParameterWrite(request = {}, context = {}) {
  const ids = [...new Set((Array.isArray(request.paramIds) ? request.paramIds : []).map((id) => String(id)).filter(Boolean))];
  const reserved = ids.filter((id) => RESERVED.has(id));
  if (reserved.length) return { ok: false, reason: 'reserved-param', params: reserved };
  if (request.own !== true) {
    const outputs = context.physicsOutputs instanceof Set
      ? context.physicsOutputs
      : new Set(context.physicsOutputs || []);
    const blocked = ids.filter((id) => outputs.has(id));
    if (blocked.length) return { ok: false, reason: 'physics-output-requires-own', params: blocked };
  }
  return { ok: true, params: ids };
}
