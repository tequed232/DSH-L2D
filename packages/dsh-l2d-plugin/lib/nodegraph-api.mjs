/**
 * AI 节点编辑 HTTP 接口的传输无关处理器（插件 lib/index.js 与 tools/dev-server 共用，便于单测）。
 *
 *   POST /dsh-l2d/api/nodegraph/apply-ops  → handleApplyOps(body, deps)
 *   POST /dsh-l2d/api/nodegraph/ai-edit    → handleAiEdit(body, deps)
 *   GET  /dsh-l2d/api/nodegraph/graph?name → handleGraphGet(name, deps)
 *   GET  /dsh-l2d/api/nodegraph/catalog?model → handleCatalog(model, deps)
 *
 * 每个处理器返回 { status, payload }，路由层只负责读 body / 发 JSON。
 *
 * 「当前节点图」的存放位置：编辑器画布本身只在浏览器内存 + localStorage 槽位里；宿主侧唯一的
 * 持久真源是已导入的分享 JSON `$DSH_HOME/l2d-nodegraphs/<name>.json`（nodegraph.mjs）。
 * 所以 apply-ops 有两种用法：
 *   - 传 graph：纯函数预演/应用，返回新图，不写任何文件（前端「确认」按钮走这条）；
 *   - 传 name（不传 graph）：读该已导入图的设计层，应用后整体合法才原子写回（MCP 工具走这条）。
 *
 * 按模型选清单（2026-11-10 统一约定）：每条动作链属于一个模型，编辑/校验/AI 编辑都按该模型
 * 自己的 live2d-ids.json（docs/nodegraph/models/<modelId>/live2d-ids.json）。modelId 优先级：
 *   显式传（body.modelId / deps.modelId）> 图绑定 modelId > 当前模型（deps.getCurrentModelId）；
 *   都没有 → 全局清单（docs/nodegraph/live2d-ids.json，旧行为）。
 */
import { guardGraphCall } from './host-guard.mjs';
import { listNodegraphs, loadNodegraph, saveNodegraph } from './nodegraph.mjs';
import { applyOps, docFromEditorGraph, editorGraphFromDoc, graphHash } from './nodegraph-ops.mjs';
import { allowedFromLive2dIds, isSafeModelId, loadLive2dIds, loadLive2dIdsForModel } from './nodegraph-schema.mjs';
import { aiEdit } from './nodegraph-ai.mjs';
import { ACCESSORY_I18N, loadAccessoriesForModel } from './accessories-catalog.mjs';

/** 请求体上限：120 节点设计层图 + 200 op 的宽松裕量（与 nodegraphs/import 同为 256KB）。 */
export const NODEGRAPH_API_BODY_LIMIT = 256 * 1024;

/** 当前模型 ID：显式 modelId > deps.getCurrentModelId() > ''（未知）。 */
function currentModelId(deps) {
  if (deps && typeof deps.modelId === 'string' && deps.modelId) return deps.modelId;
  if (deps && typeof deps.getCurrentModelId === 'function') {
    try {
      const id = deps.getCurrentModelId();
      if (typeof id === 'string' && id) return id;
    } catch {
      /* 当前模型未知 */
    }
  }
  return '';
}

/**
 * 按模型解析清单（旧 deps.live2dIds / deps.live2dIdsFile 注入优先保持兼容）。
 * @returns {{ids: object|null, status: string, modelId: string, source?: 'model'|'global'|'none', warning?: string}}
 */
function resolveIdsForModel(bindingModelId, deps) {
  const d = deps || {};
  // 旧注入（单测/宿主显式覆盖）不变语义
  if (Object.prototype.hasOwnProperty.call(d, 'live2dIds')) {
    return { ids: d.live2dIds || null, status: d.live2dIds ? 'loaded' : 'missing', modelId: bindingModelId || '', allowed: allowedFromLive2dIds(d.live2dIds || null) };
  }
  const explicit = typeof bindingModelId === 'string' && bindingModelId && isSafeModelId(bindingModelId)
    ? bindingModelId
    : currentModelId(d);
  if (explicit) {
    const loaded = loadLive2dIdsForModel(explicit, { modelsDir: d.modelsDir, globalFile: d.globalFile || d.live2dIdsFile });
    return {
      ids: loaded.ids,
      status: loaded.ids ? 'loaded' : 'missing',
      modelId: explicit,
      source: loaded.source,
      allowed: allowedFromLive2dIds(loaded.ids),
      ...(loaded.warning ? { warning: loaded.warning } : {}),
    };
  }
  // 无模型上下文：全局清单（旧行为）
  const loaded = loadLive2dIds(d.live2dIdsFile);
  return { ids: loaded.ids, status: loaded.ids ? 'loaded' : loaded.reason, modelId: '', allowed: allowedFromLive2dIds(loaded.ids) };
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

/**
 * GET 当前（已导入）节点图 + hash。
 * name 缺省 + deps.listModel 给定时 → 返回按模型过滤的图列表（strict 绑定该模型的图 +
 * any 图（matches:false 标记）；strict 绑定其它模型的图不列）。name 缺省且无 listModel → 400 附可选名单。
 */
export function handleGraphGet(name, deps = {}) {
  if (!name && deps && typeof deps.listModel === 'string' && deps.listModel) {
    const filter = deps.listModel;
    let items = [];
    let listed = null;
    try {
      listed = listNodegraphs({ homeDir: deps.homeDir });
    } catch {
      listed = null;
    }
    if (listed && listed.ok) {
      // 只返回绑定该模型的图；any 图也列出但标记 matches:false；strict 绑定其它模型的不列。
      items = listed.items
        .filter((item) => item.bindingMode === 'any' || (item.bindingMode === 'strict' && item.modelId === filter))
        .map((item) => ({
          name: item.name,
          modelId: item.modelId,
          bindingMode: item.bindingMode,
          valid: item.valid,
          matches: item.bindingMode === 'strict' && item.modelId === filter,
        }));
    }
    return { status: 200, payload: { ok: true, model: filter, items } };
  }
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
  const boundModelId = stored.doc && stored.doc.modelBinding && typeof stored.doc.modelBinding.modelId === 'string'
    ? stored.doc.modelBinding.modelId
    : '';
  const ids = resolveIdsForModel(boundModelId, deps);
  const checked = applyOps(stored.graph, [], { live2dIds: ids.ids, allowed: ids.allowed });
  return {
    status: 200,
    payload: {
      ok: true,
      name: stored.doc.name || name,
      graph: checked.graph,
      hash: graphHash(checked.graph),
      valid: checked.valid,
      errors: checked.errors,
      modelId: ids.modelId,
      live2dIds: ids.status,
      ...(ids.source ? { live2dIdsSource: ids.source } : {}),
      ...(ids.warning ? { catalogWarning: ids.warning } : {}),
    },
  };
}

/** POST apply-ops：{graph, ops, baseHash?, modelId?} 或 {name, ops, baseHash?, modelId?}。 */
export function handleApplyOps(body, deps = {}) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  if (!b) return { status: 400, payload: { ok: false, reason: 'invalid-request', message: 'body 必须是 JSON 对象' } };
  const byName = b.graph === undefined && typeof b.name === 'string';
  const guarded = guardGraphCall({ name: 'l2d_graph_apply_ops', args: { ops: b.ops, baseHash: b.baseHash, name: byName ? b.name : undefined } });
  if (!guarded.ok) return { status: 400, payload: { ok: false, reason: guarded.reason, message: guarded.message } };

  let graph = b.graph;
  let stored = null;
  let boundModelId = '';
  if (byName) {
    stored = loadStored(b.name, deps.homeDir);
    if (stored.error) return stored.error;
    // 与 handleGraphGet 同一归一化后再算 hash，保证 get 拿到的 hash 能直接用作 baseHash
    graph = applyOps(stored.graph, []).graph;
    boundModelId = stored.doc && stored.doc.modelBinding && typeof stored.doc.modelBinding.modelId === 'string'
      ? stored.doc.modelBinding.modelId
      : '';
  }
  const currentHash = graphHash(graph);
  if (b.baseHash !== undefined && b.baseHash !== currentHash) {
    return { status: 409, payload: { ok: false, reason: 'stale-graph', message: '节点图已变化，请基于最新图重新生成改动', hash: currentHash } };
  }
  // modelId 优先级：显式传 > 图绑定模型 > 当前模型（图没绑用当前模型）
  const ids = resolveIdsForModel(typeof b.modelId === 'string' && b.modelId ? b.modelId : boundModelId, deps);
  const result = applyOps(graph, b.ops, { live2dIds: ids.ids, allowed: ids.allowed });
  const payload = {
    ok: result.errors.length === 0,
    graph: result.graph,
    valid: result.valid,
    applied: result.applied,
    errors: result.errors,
    warnings: result.warnings,
    hash: graphHash(result.graph),
    live2dIds: ids.status,
    modelId: ids.modelId,
    ...(ids.source ? { live2dIdsSource: ids.source } : {}),
    ...(ids.warning ? { catalogWarning: ids.warning } : {}),
  };
  if (stored) {
    payload.name = stored.doc.name || b.name;
    payload.saved = false;
    // 只有整批应用成功且整体合法才写回；saveNodegraph 内部先校验后原子写，失败原文件不动。
    if (result.applied && result.valid && b.ops.length > 0) {
      try {
        const saved = saveNodegraph(docFromEditorGraph(result.graph, stored.doc), { homeDir: deps.homeDir, allowed: ids.allowed });
        payload.saved = saved.ok === true;
        if (!saved.ok) payload.saveErrors = saved.errors;
      } catch (err) {
        payload.saveErrors = [String((err && err.message) || err)];
      }
    }
  }
  return { status: 200, payload };
}

/** POST ai-edit：{graph, instruction, lang, modelId?}。不修改任何文件或状态。 */
export async function handleAiEdit(body, deps = {}) {
  const guarded = guardGraphCall({ name: 'l2d_graph_ai_edit', args: body && typeof body === 'object' ? { instruction: body.instruction } : {} });
  if (!guarded.ok) return { status: 400, payload: { ok: false, reason: guarded.reason, message: guarded.message } };
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  // ai-edit 的 graph 是设计层图（不带绑定）：modelId = 显式传 > 当前模型（图没绑用当前模型）
  const ids = resolveIdsForModel(typeof b.modelId === 'string' && b.modelId ? b.modelId : '', deps);
  const out = await aiEdit(body, { llm: deps.llm || null, live2dIds: ids.ids, allowed: ids.allowed });
  if (out.status === 200 && out.payload && typeof out.payload === 'object') {
    out.payload.modelId = ids.modelId;
    if (ids.warning) out.payload.catalogWarning = ids.warning;
  }
  return out;
}

/**
 * GET catalog?model=X：该模型的动作组/表情/参数/forms 清单（目录接口唯一入口，不另开 /models）。
 * model 缺省用当前模型。模型缺清单 → 回退全局清单 + warning model-catalog-missing。
 */
export function handleCatalog(modelParam, deps = {}) {
  const d = deps || {};
  let modelId = '';
  if (modelParam !== undefined && modelParam !== null && String(modelParam) !== '') {
    modelId = String(modelParam);
    if (!isSafeModelId(modelId)) {
      return {
        status: 400,
        payload: { ok: false, reason: 'invalid-model-id', message: 'modelId 非法（拦 .. 与路径分隔符；单个点放行）：' + modelId.slice(0, 40) },
      };
    }
  } else {
    modelId = currentModelId(d);
  }
  if (!modelId) {
    return { status: 404, payload: { ok: false, reason: 'no-model', message: '未指定 model 且无法确定当前模型（模型目录里没有 .model3.json）' } };
  }
  const loaded = loadLive2dIdsForModel(modelId, { modelsDir: d.modelsDir, globalFile: d.globalFile || d.live2dIdsFile });
  const acc = loadAccessoriesForModel(modelId, { modelsDir: d.modelsDir });
  return {
    status: 200,
    payload: {
      ok: true,
      modelId,
      source: loaded.source,
      catalog: loaded.ids
        ? { params: loaded.ids.params, motions: loaded.ids.motions, expressions: loaded.ids.expressions, forms: loaded.ids.forms }
        : null,
      accessories: {
        source: acc.source,
        slots: acc.menuSlots,
        i18n: ACCESSORY_I18N,
        ...(acc.file ? { file: acc.file } : {}),
        ...(acc.warning ? { warning: acc.warning } : {}),
      },
      ...(loaded.file ? { file: loaded.file } : {}),
      ...(loaded.warning ? { warning: loaded.warning } : {}),
    },
  };
}
