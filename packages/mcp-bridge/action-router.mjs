/**
 * OACA-3 · 确定性动作路由（运行时，**零 LLM**）。
 *
 * 设计契约（用户 OACA 方案 §四/§五）：
 *  - 运行时只做三件事：查注册表 → 校验参数 → 入队；**不调用任何 LLM / 网络服务**，
 *    不"猜"动作、不在命中失败时偷偷兜底到生成式通道。没命中就如实报错。
 *  - 查表事实源唯一：repo.getPublishedAction（compiled_actions 表，status='published'）。
 *    编译产物已落库，运行时不再读文件系统 bundle。
 *  - 参数只接受 manifest 里声明过的键，且必须是 number 且落在 [min, max]；缺省取 default。
 *    这不是"宽容校验"：未声明/越界参数一律 400，宁可拒绝也不猜。
 *  - 去重/幂等靠 requestId：本类**不做内存去重**（进程内 Map 无法跨重启、跨进程保证
 *    同 requestId 不重复执行），去重责任在队列 + bridge_actions 主键（B15）。
 *  - requiresOwn 必须随回执透出：物理输出参数要先 own 再写（ownership 顺序约束）。
 *
 * 负面约束（可静态断言）：本文件顶层不得 import 任何 LLM / 网络模块。
 * 见 tests/action-router.test.mjs 的静态断言用例。
 */

/** 路由错误：带 reason（机器可读）与 status（HTTP 语义），供 HTTP 层原样映射。 */
export class ActionRouterError extends Error {
  /**
   * @param {string} reason 机器可读原因（invalid-request / unknown-action / stale-action /
   *                        capability-mismatch / unknown-parameter / invalid-parameter）
   * @param {string} message 人类可读说明
   * @param {number} [status=400] HTTP 状态码语义
   */
  constructor(reason, message, status = 400) {
    super(message || reason);
    this.name = 'ActionRouterError';
    this.reason = reason;
    this.status = status;
  }
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 参数校验（纯函数）：按 manifest 的参数 schema 过滤/校验/填缺省。
 *
 * 规则：
 *  - input 里的键必须在 schema 里声明过，否则 `unknown-parameter`（400）——
 *    多余参数是调用方与 manifest 脱节的信号，静默丢弃会掩盖契约错误。
 *  - 标签值必须是有限 number（`"0.5"` 这类字符串不隐式转换）且 min ≤ v ≤ max，
 *    否则 `invalid-parameter`（400）。
 *  - schema 条目本身非法（非 number 类型 / min>max / default 越界）→ `invalid-parameter`，
 *    不"尽量修好"再执行（manifest 有问题应当暴露，不能带病运行）。
 *  - 缺省值：input 未提供且 schema 有 default → 用 default；无 default → 不写入该键
 *    （让动作侧走自己的缺省），但 schema 中 required 未声明的键不强制。
 *
 * @param {object} input 调用方传入参数
 * @param {object} schema manifest 的 parameters（{name: {type:'number',min,max,default}}）
 * @returns {object} 校验后的新对象（不修改入参）
 * @throws {ActionRouterError}
 */
export function validateActionParameters(input, schema) {
  const given = input === undefined || input === null ? {} : input;
  if (!isPlainObject(given)) {
    throw new ActionRouterError('invalid-request', 'parameters 必须是对象', 400);
  }
  const rules = isPlainObject(schema) ? schema : {};
  const out = {};

  for (const [name, value] of Object.entries(given)) {
    if (!Object.prototype.hasOwnProperty.call(rules, name)) {
      throw new ActionRouterError('unknown-parameter', `未声明的动作参数：${name}`, 400);
    }
    const rule = rules[name];
    if (!isPlainObject(rule) || rule.type !== 'number') {
      throw new ActionRouterError('invalid-parameter', `参数 ${name} 的 manifest 定义非法（只支持 number）`, 400);
    }
    const min = rule.min;
    const max = rule.max;
    if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) {
      throw new ActionRouterError('invalid-parameter', `参数 ${name} 的 manifest min/max 非法`, 400);
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new ActionRouterError('invalid-parameter', `参数 ${name} 必须是有限 number，收到 ${typeof value}`, 400);
    }
    if (value < min || value > max) {
      throw new ActionRouterError('invalid-parameter', `参数 ${name}=${value} 越界（允许 [${min}, ${max}]）`, 400);
    }
    out[name] = value;
  }

  for (const [name, rule] of Object.entries(rules)) {
    if (Object.prototype.hasOwnProperty.call(out, name)) continue;
    if (!isPlainObject(rule)) {
      throw new ActionRouterError('invalid-parameter', `参数 ${name} 的 manifest 定义非法`, 400);
    }
    if (rule.default === undefined || rule.default === null) continue;
    if (!Number.isFinite(rule.default)) {
      throw new ActionRouterError('invalid-parameter', `参数 ${name} 的 default 非法`, 400);
    }
    if (Number.isFinite(rule.min) && Number.isFinite(rule.max) && (rule.default < rule.min || rule.default > rule.max)) {
      throw new ActionRouterError('invalid-parameter', `参数 ${name} 的 default 越界`, 400);
    }
    out[name] = rule.default;
  }

  return out;
}

/**
 * 动作路由器：注册表查询 + 校验 + 入队。**无 LLM、无网络**（enqueue 由宿主注入）。
 */
export class ActionRouter {
  /**
   * @param {object} deps
   * @param {{getPublishedAction: Function}} deps.repo 动作注册表 repo（同步或异步均可）
   * @param {(request: object) => Promise<object>|object} deps.enqueue 入队函数（宿主的队列链路）
   * @param {(modelId: string) => string|null|Promise<string|null>} [deps.getCapabilityRevision]
   *        当前生效的能力档案 revision；提供者缺省时跳过比对但记 warning（不伪报已核对）
   */
  constructor({ repo, enqueue, getCapabilityRevision = null } = {}) {
    if (!repo || typeof repo.getPublishedAction !== 'function') {
      throw new Error('ActionRouter: repo.getPublishedAction 必填');
    }
    if (typeof enqueue !== 'function') throw new Error('ActionRouter: enqueue 必填');
    this.repo = repo;
    this.enqueue = enqueue;
    this.getCapabilityRevision = typeof getCapabilityRevision === 'function' ? getCapabilityRevision : null;
  }

  /**
   * 派发一个已发布动作。
   * @param {{modelId: string, actionId: string, parameters?: object, requestId: string}} input
   * @returns {Promise<{ok: true, requestId: string, modelId: string, actionId: string,
   *   graphId: string, graphHash: string, capabilityRevision: string, priority: string,
   *   parameters: object, requiresOwn: string[], receipt: unknown, warnings: object[]}>}
   * @throws {ActionRouterError}
   */
  async dispatch({ modelId, actionId, parameters = {}, requestId } = {}) {
    const warnings = [];

    // 1) 请求形体：requestId 是幂等键，缺了就不可能安全去重，必须直接拒（不生成替代值）
    if (!isNonEmptyString(modelId)) throw new ActionRouterError('invalid-request', 'modelId 必填', 400);
    if (!isNonEmptyString(actionId)) throw new ActionRouterError('invalid-request', 'actionId 必填', 400);
    if (!isNonEmptyString(requestId)) {
      throw new ActionRouterError('invalid-request', 'requestId 必填（去重与幂等依赖它，不接受服务端兜底生成）', 400);
    }

    // 2) 注册表查询（唯一事实源）
    const action = await this.repo.getPublishedAction({ modelId, actionId });
    if (!action) throw new ActionRouterError('unknown-action', `未找到已发布动作：${modelId}/${actionId}`, 404);

    // 3) 可派发状态（stale/rejected 一律不可执行）
    if (action.status !== 'published') {
      throw new ActionRouterError('stale-action', `动作已不可派发（status=${action.status}），请重新编译发布`, 409);
    }

    // 4) 能力档案 revision 比对（防"用旧档案编译的动作打到新模型上"）
    if (this.getCapabilityRevision) {
      const current = await this.getCapabilityRevision(modelId);
      if (current !== null && current !== undefined && current !== '' && current !== false) {
        if (String(current) !== String(action.capabilityRevision)) {
          throw new ActionRouterError(
            'capability-mismatch',
            `能力档案 revision 不匹配（当前 ${current} / 动作 ${action.capabilityRevision}），请重新编译`,
            409,
          );
        }
      } else {
        warnings.push({ reason: 'capability-revision-unavailable', message: '能力档案 revision 不可得，本次未做比对' });
      }
    } else {
      warnings.push({ reason: 'capability-revision-provider-missing', message: '未注入 getCapabilityRevision，本次未做比对' });
    }

    // 5) 参数校验（未知/越界/非 number 一律拒）
    const validated = validateActionParameters(parameters, action.parameters);

    // 6) 入队（透传 requestId：队列按它做幂等，勿改写）
    const receipt = await this.enqueue({
      requestId,
      modelId,
      actionId,
      graphId: action.graphId,
      capabilityRevision: action.capabilityRevision,
      parameters: validated,
    });

    return {
      ok: true,
      requestId,
      modelId,
      actionId,
      graphId: action.graphId,
      graphHash: action.graphHash,
      capabilityRevision: action.capabilityRevision,
      priority: action.priority,
      parameters: validated,
      // 物理输出参数：Runtime 必须先 own 再写（顺序约束随回执下发）
      requiresOwn: Array.isArray(action.requiresOwn) ? [...action.requiresOwn] : [],
      receipt,
      warnings,
    };
  }
}
