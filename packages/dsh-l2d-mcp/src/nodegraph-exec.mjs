/**
 * 节点图执行侧 MCP 工具的转发层（l2d_nodegraph_import / run / status / cancel）。
 *
 * 与 server.mjs 的 graphApi 同风格：直连宿主路由（/dsh-l2d/nodegraphs/*），不经
 * /ai/call 队列。校验与执行生命周期全部在宿主，这里只做转发与错误归一，不重复实现校验：
 *   - Schema v1 全量导入校验（256KB 上限、白名单）→ 宿主 saveNodegraph（nodegraph.mjs）；
 *   - 执行注册表 / 批间取消 → nodegraph-runs.mjs；
 *   - 模式互斥（llm 模式 409 mode-blocked）与绑定闸门（409 model-mismatch）→ runNodegraph；
 *   - 路由入口静态守卫 → host-guard.guardGraphCall（HOST_GRAPH_TOOLS 白名单）。
 *
 * 错误归一与 graphApi 一致：无 base → plugin-offline；网络层失败 → unreachable；
 * 响应非 JSON → http-<status>；fetch 超时/中止 → timeout（run 的执行仍在宿主继续，
 * 可用宿主执行历史回查 executionId 后走 status）。
 */

/** run 会等整条图执行完（多批次逐段 await），给足预算；其余转发走默认 10s。 */
export const NODEGRAPH_EXEC_TIMEOUTS = Object.freeze({ run: 120_000, default: 10_000 });

async function fetchJson(base, pathAndQuery, init = {}, timeoutMs, fetchImpl) {
  const doFetch = fetchImpl || fetch;
  try {
    const res = await doFetch(base + pathAndQuery, {
      ...init,
      signal: init.signal || AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return { ok: false, reason: 'http-' + res.status };
    }
  } catch (err) {
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      return { ok: false, reason: 'timeout', timeoutMs };
    }
    return { ok: false, reason: 'unreachable' };
  }
}

/**
 * 导入完整 Schema v1 分享 JSON。成功后回查图 hash（l2d_graph_apply_ops 的 baseHash）；
 * hash 回查失败不影响导入成功语义，只附 hashUnavailable。
 * @param {object} doc 完整分享 JSON 对象（不是字符串）
 * @param {{base?: string, fetchImpl?: typeof fetch}} deps
 */
export async function nodegraphImport(doc, deps = {}) {
  const base = deps.base;
  if (!base) return { ok: false, reason: 'plugin-offline' };
  const result = await fetchJson(
    base,
    '/dsh-l2d/nodegraphs/import',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(doc),
    },
    NODEGRAPH_EXEC_TIMEOUTS.default,
    deps.fetchImpl,
  );
  if (!result || result.ok !== true) return result;
  const graph = await fetchJson(
    base,
    '/dsh-l2d/api/nodegraph/graph?name=' + encodeURIComponent(String(result.name || '')),
    { cache: 'no-store' },
    NODEGRAPH_EXEC_TIMEOUTS.default,
    deps.fetchImpl,
  );
  if (graph && graph.ok === true && typeof graph.hash === 'string') {
    return {
      ...result,
      hash: graph.hash,
      ...(graph.valid !== undefined ? { valid: graph.valid } : {}),
      ...(graph.modelId ? { modelId: graph.modelId } : {}),
      ...(graph.live2dIdsSource ? { live2dIdsSource: graph.live2dIdsSource } : {}),
    };
  }
  return { ...result, hashUnavailable: true, ...(graph && graph.reason ? { hashReason: graph.reason } : {}) };
}

/**
 * 执行已导入的节点图（等宿主执行完整条图后返回真实结果：executionId + receipts）。
 * @param {string} name 已导入节点图的 name
 * @param {{base?: string, modelId?: string, fetchImpl?: typeof fetch}} deps
 */
export async function nodegraphRun(name, deps = {}) {
  const base = deps.base;
  if (!base) return { ok: false, reason: 'plugin-offline' };
  let pathAndQuery = '/dsh-l2d/nodegraphs/run?name=' + encodeURIComponent(name);
  // 透传备用：宿主当前按图的 strict 绑定模型校验，此参数不改变校验目标。
  if (deps.modelId) pathAndQuery += '&modelId=' + encodeURIComponent(deps.modelId);
  return fetchJson(base, pathAndQuery, { method: 'POST' }, NODEGRAPH_EXEC_TIMEOUTS.run, deps.fetchImpl);
}

/**
 * 按 executionId 回查执行记录（状态 / 已完成与剩余批次 / 每批 receipts / 失败原因）。
 * @param {string} executionId
 * @param {{base?: string, fetchImpl?: typeof fetch}} deps
 */
export async function nodegraphStatus(executionId, deps = {}) {
  const base = deps.base;
  if (!base) return { ok: false, reason: 'plugin-offline' };
  return fetchJson(
    base,
    '/dsh-l2d/nodegraphs/executions?id=' + encodeURIComponent(executionId),
    { cache: 'no-store' },
    NODEGRAPH_EXEC_TIMEOUTS.default,
    deps.fetchImpl,
  );
}

/**
 * 请求取消一次执行中的节点图。批间粒度：正在播放的批次会播完，下一批下发前才感知
 * 取消——已入队动作不保证立即中断。取消成功不等于已停止，终态以 status 回查为准。
 * @param {string} executionId
 * @param {{base?: string, fetchImpl?: typeof fetch}} deps
 */
export async function nodegraphCancel(executionId, deps = {}) {
  const base = deps.base;
  if (!base) return { ok: false, reason: 'plugin-offline' };
  return fetchJson(
    base,
    '/dsh-l2d/nodegraphs/cancel?id=' + encodeURIComponent(executionId),
    { method: 'POST' },
    NODEGRAPH_EXEC_TIMEOUTS.default,
    deps.fetchImpl,
  );
}

/**
 * 四个执行侧工具的描述（server.mjs 注册用；导出以便测试断言关键语义文案——
 * run 的「completed 前不得宣称已执行」、cancel 的「批间粒度」等是对 Agent 的硬约束）。
 */
export const NODEGRAPH_EXEC_TOOL_DESCRIPTIONS = Object.freeze({
  import:
    '把一份完整 Schema v1 分享 JSON（kind:"dsh-l2d-nodegraph"，顶层字段 schemaVersion/kind/name/modelBinding/graph|segments/meta，格式见 docs/nodegraph/NODE-SCHEMA.json）导入宿主。校验在宿主做（256KB 上限、整体合法性）：导入失败返回具体 errors，按错误改 JSON，不要原样重试。动作/表情/参数 ID 必须来自图绑定模型的 live2d-ids 清单（docs/nodegraph/models/<modelId>/live2d-ids.json，缺省全局清单）。缺 modelBinding 时宿主默认 strict 绑定当前模型。成功回传 saved name 与图 hash（可直接用作 l2d_graph_apply_ops 的 baseHash）。',
  run:
    '执行已导入的节点图。宿主按图绑定模型闸门校验：strict 绑定模型 ≠ 当前模型 → 409 model-mismatch（expected/actual 原样读出，未执行任何动作）；同图已有执行 → 409 busy（返回在执行的 executionId）；LLM 模式 → 409 mode-blocked（需先在设置页切到节点图模式）。返回真实执行结果（accepted / executionId / status completed|stopped|rejected / 每批 receipts）：在确认 completed 之前不得向用户宣称动作已执行；conflict / priority-blocked 的批次要原样读出，不要原样重试。modelId 仅透传备用：宿主当前按图的绑定模型校验，此参数不改变校验目标。',
  status:
    '按 executionId 回查一次节点图执行：状态（running/completed/failed/cancelled/timeout）、已完成与剩余批次（completedSegments / remainingSegments）、每批 receipts 与失败原因。executionId 来自 l2d_nodegraph_run 的返回。只读。',
  cancel:
    '请求取消一次执行中的节点图（executionId，来自 l2d_nodegraph_run）。批间粒度取消：正在播放的批次会播完，下一批下发前才感知取消——已入队动作不保证立即中断。取消请求成功不等于已停止，终态以 l2d_nodegraph_status 回查（cancelled）为准。记录缺失或已终态 → 404。',
});
