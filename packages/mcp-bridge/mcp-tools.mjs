/**
 * Model Control MCP 工具（PR-B）。
 *
 * 三个工具（裁决书 §八）：l2d_action_enqueue / l2d_action_status / l2d_action_cancel。
 * Agent 不接触 ModelActionQueue 内部对象——queue/cancel/getStatus 全部注入
 * （PR-C 接真队列；本 PR 测试用 fake）。参数校验失败返回
 * {error:'INVALID_ARGS', detail}，不抛穿（MCP 层自行决定回执形态）。
 *
 * 校验规则：
 *  - requestId：非空 string（幂等标识，PR-C 落库 PRIMARY KEY）；
 *  - action：非空 string 且必须经 deps.validateAction 放行（PR-C 接 actions-repo
 *    语义解析/Capability Registry；本 PR 测试用白名单 fake）——拒绝任意 Cubism 参数 ID；
 *  - args：仅普通 object（数组/null 拒绝）；
 *  - priority：整数 0–100，缺省 50（仅记录，FIFO 不重排）；
 *  - timeoutMs：整数 1000–300000，缺省 30000。
 */

const DEFAULT_PRIORITY = 50;
const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 300_000;

function invalid(detail) {
  return { error: 'INVALID_ARGS', detail };
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isInt(v) {
  return Number.isInteger(v);
}

/** validateAction 返回 true / {ok:true} 视为放行；false / {ok:false, reason} 视为拒绝。 */
function actionAllowed(validateAction, action) {
  const r = validateAction(action);
  if (r === true) return { ok: true };
  if (r && typeof r === 'object') return r.ok === true ? { ok: true } : { ok: false, reason: r.reason || 'action-not-registered' };
  return { ok: false, reason: 'action-not-registered' };
}

/**
 * @param {{registerTool: Function}} registry 已过 scope 白名单的注册器
 * @param {object} deps 全部注入
 */
export function registerLive2DTools(registry, deps) {
  if (!registry || typeof registry.registerTool !== 'function') throw new Error('registerLive2DTools: registry.registerTool 必填');
  const { enqueue, getStatus, cancel, workspace, validateAction } = deps || {};
  if (typeof enqueue !== 'function') throw new Error('registerLive2DTools: deps.enqueue 必填（PR-C 队列注入）');
  if (typeof getStatus !== 'function') throw new Error('registerLive2DTools: deps.getStatus 必填');
  if (typeof cancel !== 'function') throw new Error('registerLive2DTools: deps.cancel 必填');
  if (!isPlainObject(workspace) || !workspace.id) throw new Error('registerLive2DTools: deps.workspace{id,controlSessionId} 必填');
  if (typeof validateAction !== 'function') throw new Error('registerLive2DTools: deps.validateAction 必填（动作合法性闸门）');

  registry.registerTool('l2d_action_enqueue', async (args = {}) => {
    const requestId = args.requestId;
    if (typeof requestId !== 'string' || !requestId.trim()) return invalid('requestId 须为非空 string');
    if (typeof args.action !== 'string' || !args.action.trim()) return invalid('action 须为非空 string');
    const allowed = actionAllowed(validateAction, args.action);
    if (!allowed.ok) return invalid(`action 未注册：${args.action}（${allowed.reason}）——只允许引用已注册语义动作`);
    if (args.args !== undefined && !isPlainObject(args.args)) return invalid('args 须为普通 object');
    const priority = args.priority === undefined ? DEFAULT_PRIORITY : args.priority;
    if (!isInt(priority) || priority < 0 || priority > 100) return invalid('priority 须为整数 0–100');
    const timeoutMs = args.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : args.timeoutMs;
    if (!isInt(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
      return invalid(`timeoutMs 须为整数 [${MIN_TIMEOUT_MS}, ${MAX_TIMEOUT_MS}]`);
    }
    return enqueue({
      requestId,
      workspaceId: workspace.id,
      controlSessionId: workspace.controlSessionId,
      action: args.action,
      args: args.args ?? {},
      priority,
      timeoutMs,
      createdAt: Date.now(),
      memoryRevision: Number.isInteger(args.memoryRevision) ? args.memoryRevision : 0,
    });
  });

  registry.registerTool('l2d_action_status', async (args = {}) => {
    const requestId = args.requestId;
    if (typeof requestId !== 'string' || !requestId.trim()) return invalid('requestId 须为非空 string');
    const r = await getStatus(requestId);
    return {
      receipt: (r && r.receipt) ?? null,
      queue: (r && r.queue) ?? { depth: 0, activeRequestId: undefined },
    };
  });

  registry.registerTool('l2d_action_cancel', async (args = {}) => {
    const requestId = args.requestId;
    if (typeof requestId !== 'string' || !requestId.trim()) return invalid('requestId 须为非空 string');
    return { cancelled: Boolean(await cancel(requestId)) };
  });

  return ['l2d_action_enqueue', 'l2d_action_status', 'l2d_action_cancel'];
}
