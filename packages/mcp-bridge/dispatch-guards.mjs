/**
 * 派发前置闸门（OACA-3 执行层）。
 *
 * 为什么单独成模块：原先这段判定内联在 `index.js` 的 `apply()` 闭包里，只能靠
 * 起宿主才能验证（QA W-1）。抽成**纯函数**后，生产与测试走同一份代码，不需要
 * 复制逻辑，也不需要启动 HTTP。
 *
 * 判定顺序：模式闸门（仅旧口径）→ strict 绑定 → 图存在。
 *
 * Phase 3 双模式收敛：
 *   - gate='program'（默认）：**已发布动作程序本身就是权威**，不再要求用户先切节点图模式；
 *   - gate='mode'（回滚开关）：沿用旧行为，mode≠nodegraph 一律 409。
 * 两种口径下 strict 绑定与图存在检查都不放松 —— 收敛的只是"谁来授权执行"，不是执行安全。
 */
export const DISPATCH_GUARD = Object.freeze({
  MODE_BLOCKED: 'mode-blocked',
  MODEL_MISMATCH: 'model-mismatch',
  GRAPH_NOT_FOUND: 'graph-not-found',
});

/**
 * @param {object} input
 * @param {string} input.graphId 已发布动作对应的节点图名
 * @param {string} input.mode 当前动作模式（readMotionMode().mode）
 * @param {'program'|'mode'} [input.gate='program'] 模式闸门口径（'mode' 为旧行为回滚开关）
 * @param {{ok: boolean, reason?: string, expected?: string, actual?: string}} input.binding
 *        checkRunModelBinding(graphId, {currentModelId}) 的返回值
 * @param {boolean} input.graphExists 该图是否在图仓中
 * @returns {{ok: true} | {ok: false, reason: string, status: number, message: string}}
 */
export function evaluateDispatchGuards({ graphId, mode, binding, graphExists, gate = 'program' }) {
  if (gate === 'mode' && mode !== 'nodegraph') {
    return {
      ok: false,
      reason: DISPATCH_GUARD.MODE_BLOCKED,
      status: 409,
      message: `当前动作模式为 ${mode}，节点图不执行；请先切到节点图模式（或把 actionGate 设为 program）`,
    };
  }
  if (!binding || binding.ok !== true) {
    const reason = (binding && binding.reason) || DISPATCH_GUARD.MODEL_MISMATCH;
    return {
      ok: false,
      reason,
      status: 409,
      message: `节点图 strict 绑定模型 ${binding && binding.expected}，当前模型 ${binding && binding.actual}，未执行任何动作`,
    };
  }
  if (!graphExists) {
    return {
      ok: false,
      reason: DISPATCH_GUARD.GRAPH_NOT_FOUND,
      status: 404,
      message: `已发布动作的节点图 ${graphId} 不在图仓中（可能被手工删除）`,
    };
  }
  return { ok: true };
}
