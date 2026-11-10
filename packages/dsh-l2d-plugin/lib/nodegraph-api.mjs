/**
 * AI 节点编辑 HTTP 接口的传输无关处理器（插件 lib/index.js 与 tools/dev-server 共用，便于单测）。
 *
 *   POST /dsh-l2d/api/nodegraph/apply-ops  → handleApplyOps(body, deps)
 *   POST /dsh-l2d/api/nodegraph/ai-edit    → handleAiEdit(body, deps)
 *   GET  /dsh-l2d/api/nodegraph/graph?name → handleGraphGet(name, deps)
 *
 * 每个处理器返回 { status, payload }，路由层只负责读 body / 发 JSON。
 *
 * 「当前节点图」的存放位置：编辑器画布本身只在浏览器内存 + localStorage 槽位里；宿主侧唯一的
 * 持久真源是已导入的分享 JSON `$DSH_HOME/l2d-nodegraphs/<name>.json`（nodegraph.mjs）。
 * 所以 apply-ops 有两种用法：
 *   - 传 graph：纯函数预演/应用，返回新图，不写任何文件（前端「确认」按钮走这条）；
 *   - 传 name（不传 graph）：读该已导入图的设计层，应用后整体合法才原子写回（MCP 工具走这条）。
 */
import { guardGraphCall } from './host-guard.mjs';
import { listNodegraphs, loadNodegraph, saveNodegraph } from './nodegraph.mjs';
import { applyOps, docFromEditorGraph, editorGraphFromDoc, graphHash } from './nodegraph-ops.mjs';
import { loadLive2dIds } from './nodegraph-schema.mjs';
import { aiEdit } from './nodegraph-ai.mjs';

/** 请求体上限：120 节点设计层图 + 200 op 的宽松裕量（与 nodegraphs/import 同为 256KB）。 */
export const NODEGRAPH_API_BODY_LIMIT = 256 * 1024;

function resolveIds(deps) {
  if (deps && Object.prototype.hasOwnProperty.call(deps, 'live2dIds')) {
    return { ids: deps.live2dIds || null, status: deps.live2dIds ? 'loaded' : 'missing' };
  }
  const loaded = loadLive2dIds(deps && deps.live2dIdsFile);
  return { ids: loaded.ids, status: loaded.ids ? 'loaded' : loaded.reason };
}

function loadStored(name, homeDir) {
  const text = loadNodegraph(name, { homeDir });
  if (text === null) return { error: { status: 404, payload: { ok: false, reason: 'nodegraph-not-found', message: '未找到已导入的节点图：' + name } } };
  try {
    const doc = JSON.parse(text);
    return { doc, graph: editorGraphFromDoc(doc) };
  } catch {
    return { error: { status: 500, payload: { ok: false, reason: 'nodegraph-corrupt', message: '节点图文件损坏：' + name } } };
  }
}

/** GET 当前（已导入）节点图 + hash。name 缺省时返回 400 并附可选名单。 */
export function handleGraphGet(name, deps = {}) {
  const guarded = guardGraphCall({ name: 'l2d_graph_get', args: { name } });
  if (!guarded.ok) {
    let items = [];
    try {
      items = listNodegraphs({ homeDir: deps.homeDir }).items.map((i) => i.name);
    } catch {
      items = [];
    }
    return { status: 400, payload: { ok: false, reason: guarded.reason, message: guarded.message, names: items } };
  }
  const stored = loadStored(name, deps.homeDir);
  if (stored.error) return stored.error;
  const checked = applyOps(stored.graph, [], { live2dIds: resolveIds(deps).ids });
  return {
    status: 200,
    payload: { ok: true, name: stored.doc.name || name, graph: checked.graph, hash: graphHash(checked.graph), valid: checked.valid, errors: checked.errors },
  };
}

/** POST apply-ops：{graph, ops, baseHash?} 或 {name, ops, baseHash?}。 */
export function handleApplyOps(body, deps = {}) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  if (!b) return { status: 400, payload: { ok: false, reason: 'invalid-request', message: 'body 必须是 JSON 对象' } };
  const byName = b.graph === undefined && typeof b.name === 'string';
  const guarded = guardGraphCall({ name: 'l2d_graph_apply_ops', args: { ops: b.ops, baseHash: b.baseHash, name: byName ? b.name : undefined } });
  if (!guarded.ok) return { status: 400, payload: { ok: false, reason: guarded.reason, message: guarded.message } };

  let graph = b.graph;
  let stored = null;
  if (byName) {
    stored = loadStored(b.name, deps.homeDir);
    if (stored.error) return stored.error;
    // 与 handleGraphGet 同一归一化后再算 hash，保证 get 拿到的 hash 能直接用作 baseHash
    graph = applyOps(stored.graph, []).graph;
  }
  const currentHash = graphHash(graph);
  if (b.baseHash !== undefined && b.baseHash !== currentHash) {
    return { status: 409, payload: { ok: false, reason: 'stale-graph', message: '节点图已变化，请基于最新图重新生成改动', hash: currentHash } };
  }
  const ids = resolveIds(deps);
  const result = applyOps(graph, b.ops, { live2dIds: ids.ids });
  const payload = {
    ok: result.errors.length === 0,
    graph: result.graph,
    valid: result.valid,
    applied: result.applied,
    errors: result.errors,
    warnings: result.warnings,
    hash: graphHash(result.graph),
    live2dIds: ids.status,
  };
  if (stored) {
    payload.name = stored.doc.name || b.name;
    payload.saved = false;
    // 只有整批应用成功且整体合法才写回；saveNodegraph 内部先校验后原子写，失败原文件不动。
    if (result.applied && result.valid && b.ops.length > 0) {
      try {
        const saved = saveNodegraph(docFromEditorGraph(result.graph, stored.doc), { homeDir: deps.homeDir });
        payload.saved = saved.ok === true;
        if (!saved.ok) payload.saveErrors = saved.errors;
      } catch (err) {
        payload.saveErrors = [String((err && err.message) || err)];
      }
    }
  }
  return { status: 200, payload };
}

/** POST ai-edit：{graph, instruction, lang}。不修改任何文件或状态。 */
export async function handleAiEdit(body, deps = {}) {
  const guarded = guardGraphCall({ name: 'l2d_graph_ai_edit', args: body && typeof body === 'object' ? { instruction: body.instruction } : {} });
  if (!guarded.ok) return { status: 400, payload: { ok: false, reason: guarded.reason, message: guarded.message } };
  return aiEdit(body, { llm: deps.llm || null, live2dIds: resolveIds(deps).ids });
}
