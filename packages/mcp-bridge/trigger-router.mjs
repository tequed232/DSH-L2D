/**
 * OACA-3 · 触发器路由（事件 type → 已发布动作，确定性、0 LLM）。
 *
 * 语义（用户 OACA 方案 §五「触发器只做映射，不做生成」）：
 *  - 命中判定纯查表：compiled_actions.triggers_json 是否含本次事件 type。
 *  - 多命中择优**完全确定**：FORCE > NORMAL > BACKGROUND；同级取 actionId 字典序最小。
 *    不允许"随机挑一个"或按数据库返回顺序挑——同样输入必须永远得到同样动作。
 *  - 无命中就返回 `{status:'no_matching_action'}`：不抛错、不调 LLM、不兜底到其它动作。
 *  - 参数只透传命中动作 manifest 里声明过的键（intensity/holdMs 等），其余一律丢弃；
 *    值域校验与缺省填充仍由 ActionRouter.dispatch 统一负责（单一校验入口，不重复实现）。
 *
 * 本文件不 import 任何 LLM / 网络模块（与 action-router 同一负面约束）。
 */
import { ActionRouterError } from './action-router.mjs';

/** 优先级档位（与 action-compiler 的 PRIORITY_TIERS 同枚举，数值只做比较用）。 */
export const PRIORITY_RANK = Object.freeze({ FORCE: 3, NORMAL: 2, BACKGROUND: 1 });

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** 字典序比较（按 UTF-16 code unit，跨平台稳定；不用 localeCompare 以免受 locale 影响）。 */
function compareActionId(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

export class TriggerRouter {
  /**
   * @param {object} deps
   * @param {import('./action-router.mjs').ActionRouter} deps.router 命中后的派发器
   * @param {{listPublishedActions: Function}} deps.repo 动作注册表 repo
   */
  constructor({ router, repo } = {}) {
    if (!router || typeof router.dispatch !== 'function') throw new Error('TriggerRouter: router.dispatch 必填');
    if (!repo || typeof repo.listPublishedActions !== 'function') {
      throw new Error('TriggerRouter: repo.listPublishedActions 必填');
    }
    this.router = router;
    this.repo = repo;
  }

  /**
   * 处理一次触发事件。
   * @param {{type: string, modelId: string, payload?: object, requestId?: string}} input
   * @returns {Promise<object>} 命中 → dispatch 回执 + {matchedBy:'trigger', actionId}；
   *                            无命中 → {status:'no_matching_action', type, modelId}
   * @throws {ActionRouterError} type/modelId 缺失（400）或派发阶段错误（原样上抛）
   */
  async handle({ type, modelId, payload = {}, requestId } = {}) {
    if (!isNonEmptyString(type)) throw new ActionRouterError('invalid-request', 'type 必填', 400);
    if (!isNonEmptyString(modelId)) throw new ActionRouterError('invalid-request', 'modelId 必填', 400);

    const all = await this.repo.listPublishedActions({ modelId });
    const candidates = (Array.isArray(all) ? all : []).filter(
      (a) => a && a.status === 'published' && Array.isArray(a.triggers) && a.triggers.includes(type),
    );

    // 无命中：如实返回，不抛错（事件来了但没有对应动作是正常业务结果）
    if (!candidates.length) return { status: 'no_matching_action', type, modelId };

    // 确定性择优：先按优先级档位降序，再按 actionId 字典序升序
    const best = candidates.slice().sort((left, right) => {
      const lr = PRIORITY_RANK[left.priority] || 0;
      const rr = PRIORITY_RANK[right.priority] || 0;
      if (lr !== rr) return rr - lr;
      return compareActionId(String(left.actionId), String(right.actionId));
    })[0];

    // 参数白名单透传：只留 manifest 声明过的键（值域交给 dispatch 统一校验）
    const declared = isPlainObject(best.parameters) ? Object.keys(best.parameters) : [];
    const source = isPlainObject(payload) ? payload : {};
    const parameters = {};
    for (const key of declared) {
      if (Object.prototype.hasOwnProperty.call(source, key)) parameters[key] = source[key];
    }

    const result = await this.router.dispatch({
      modelId,
      actionId: best.actionId,
      parameters,
      requestId,
    });
    return { ...result, matchedBy: 'trigger', actionId: best.actionId };
  }
}
