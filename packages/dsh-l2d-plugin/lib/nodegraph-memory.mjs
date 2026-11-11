/**
 * nodegraph-memory —— 动作链行为记忆（Phase 3 Action Memory + Phase 4 Runtime Feedback）
 *
 * 职责：
 *   - Phase 3：把 $DSH_HOME/l2d-nodegraphs/*.json 的既有动作链汇编成带语义索引的记忆条目
 *     （name / modelId / semantic / 链摘要），并提供关键词检索排序——LLM 在创建新链前
 *     先查记忆：命中即复用（run / ai_edit），未命中才 ai_plan 新建；
 *   - Phase 4：每条链附带「最近一次真实执行摘要」（注册表最新终态记录的结果 digest：
 *     完成段数 / 剩余段数 / 首个失败回执），LLM 据此决定修补（ai_edit）或重规划，
 *     不得在未确认 completed 前假装执行成功。
 *
 * 设计约束：
 *   - 只读汇编：不写 nodegraph.mjs / nodegraph-runs.mjs / applyOps 任何状态；
 *   - 执行注册表经 deps.registry 注入（宿主与 dev-server 各自的实例），缺省无执行史；
 *   - 检索是本地关键词评分（子串匹配，无外部依赖）：name 命中 ×4 > semantic ×2 > 链节点名 ×1，
 *     同模型 / any 绑定加权；不做 embeddings，不引第三方库。
 */
import fs from 'node:fs';
import path from 'node:path';
import { listNodegraphs, nodegraphsDir } from './nodegraph.mjs';
import { guardGraphCall } from './host-guard.mjs';

const MAX_LIMIT = 50;

function isPlain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 从一份已导入图文档提取记忆条目的链摘要（扁平 chain，最多前 12 步）。
 * 文档损坏 / 形状不符 → 返回空链（条目仍保留 name/modelId/valid 信息）。
 */
function extractChain(doc) {
  if (!isPlain(doc) || !Array.isArray(doc.segments)) return { chain: [], nodeCount: 0, semantic: '', templateId: '' };
  const chain = [];
  for (const seg of doc.segments) {
    if (!isPlain(seg) || !Array.isArray(seg.chain)) continue;
    for (const step of seg.chain) {
      if (chain.length >= 12) break;
      chain.push({ kind: String(step && step.kind || ''), name: String(step && step.name || '') });
    }
    if (chain.length >= 12) break;
  }
  const semantic = doc.meta && typeof doc.meta.semantic === 'string' ? doc.meta.semantic : '';
  const templateId = doc.meta && typeof doc.meta.templateId === 'string' ? doc.meta.templateId : '';
  return { chain, nodeCount: chain.length, semantic, templateId };
}

/**
 * 从一条执行注册表终态记录提取 LLM 可读的结果摘要（Phase 4）。
 * 只取关键事实：完成/剩余段数、终止原因、首个非完成回执。
 */
function summarizeRun(rec) {
  if (!isPlain(rec) || !isPlain(rec.result)) return null;
  const r = rec.result;
  const out = {
    executionId: rec.executionId,
    status: rec.status,
    finishedAt: rec.finishedAt,
    ok: r.ok === true,
    completedSegments: Number(r.completedSegments) || 0,
    remainingSegments: Number(r.remainingSegments) || 0,
    replanRequired: r.replanRequired === true,
  };
  if (typeof r.reason === 'string' && r.reason) out.reason = r.reason;
  // 首个非完成回执：LLM 修补的锚点
  if (Array.isArray(r.receipts)) {
    for (const entry of r.receipts) {
      const receipt = isPlain(entry) ? entry.receipt : null;
      const outcome = receipt && typeof receipt.outcome === 'string' ? receipt.outcome : '';
      if (outcome && outcome !== 'completed') {
        out.failure = {
          batch: typeof entry.batch === 'number' ? entry.batch : null,
          outcome,
        };
        if (typeof receipt.reason === 'string' && receipt.reason) out.failure.reason = receipt.reason;
        if (Array.isArray(receipt.errors) && receipt.errors.length) {
          out.failure.error = String(typeof receipt.errors[0] === 'string' ? receipt.errors[0] : JSON.stringify(receipt.errors[0])).slice(0, 200);
        }
        break;
      }
    }
  }
  return out;
}

/**
 * 汇编动作链记忆（全部已导入图 + 最近一次执行摘要）。
 * @param {{homeDir?: string, registry?: {list: Function, get: Function}}} [deps]
 * @returns {{ok: true, items: Array<object>, total: number}}
 */
export function buildActionMemory(deps = {}) {
  const listed = listNodegraphs({ homeDir: deps.homeDir });
  if (!listed.ok) return { ok: true, items: [], total: 0 };
  // Phase 4：注册表最新在前 → 每个图名取第一条终态记录的完整结果
  const lastRunByName = new Map();
  if (deps.registry && typeof deps.registry.list === 'function' && typeof deps.registry.get === 'function') {
    try {
      for (const item of deps.registry.list({ limit: 50 })) {
        if (item.name && !lastRunByName.has(item.name)) {
          const full = deps.registry.get(item.executionId);
          const summary = summarizeRun(full);
          if (summary) lastRunByName.set(item.name, summary);
        }
      }
    } catch {
      /* 注册表不可用时无执行史，不影响记忆汇编 */
    }
  }
  const items = [];
  const dir = nodegraphsDir(deps.homeDir);
  for (const meta of listed.items) {
    let doc = null;
    try {
      // 直读原文而非 loadNodegraph：记忆汇编对未过全量校验的文档也要容忍（只要能取到语义/链摘要）
      doc = JSON.parse(fs.readFileSync(path.join(dir, meta.name + '.json'), 'utf8'));
    } catch {
      doc = null;
    }
    const { chain, nodeCount, semantic, templateId } = extractChain(doc);
    items.push({
      name: meta.name,
      modelId: meta.modelId,
      bindingMode: meta.bindingMode,
      valid: meta.valid === true,
      semantic,
      templateId,
      chain,
      nodeCount,
      ...(lastRunByName.has(meta.name) ? { lastRun: lastRunByName.get(meta.name) } : {}),
    });
  }
  return { ok: true, items, total: items.length };
}

function scoreItem(item, tokens, modelId) {
  let score = 0;
  const name = item.name || '';
  const semantic = item.semantic || '';
  for (const t of tokens) {
    if (name.includes(t)) score += 4;
    if (semantic.includes(t)) score += 2;
    for (const step of item.chain) {
      if (step.name && step.name.includes(t)) { score += 1; break; }
    }
  }
  if (score > 0 && modelId) {
    if (item.modelId === modelId) score += 2;
    else if (item.bindingMode === 'any') score += 1;
  }
  return score;
}

/**
 * 关键词检索动作链记忆。q 为空 → 全量按（有执行史优先、新→旧）返回。
 * @param {{q?: string, modelId?: string, limit?: number}} query
 * @param {{homeDir?: string, registry?: object, getCurrentModelId?: Function}} [deps]
 * @returns {{status: number, payload: object}}
 */
export function handleMemorySearch(query, deps = {}) {
  const guarded = guardGraphCall({ name: 'l2d_graph_search', args: {} });
  if (!guarded.ok) return { status: 400, payload: { ok: false, reason: guarded.reason, message: guarded.message } };
  const q = typeof query.q === 'string' ? query.q.trim().slice(0, 200) : '';
  const modelId = (typeof query.modelId === 'string' && query.modelId.trim())
    || (typeof deps.getCurrentModelId === 'function' ? deps.getCurrentModelId() : '');
  const parsedLimit = Math.floor(Number(query.limit));
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, MAX_LIMIT) : 8;
  const memory = buildActionMemory(deps);
  const tokens = q.split(/[\s,，。;；、/()（）]+/).filter(Boolean);
  let ranked;
  if (!tokens.length) {
    ranked = [...memory.items].sort((a, b) => {
      const ra = a.lastRun ? 1 : 0;
      const rb = b.lastRun ? 1 : 0;
      if (ra !== rb) return rb - ra;
      return a.name.localeCompare(b.name, 'zh-Hans-CN');
    });
  } else {
    ranked = memory.items
      .map((item) => ({ item, score: scoreItem(item, tokens, modelId) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name, 'zh-Hans-CN'))
      .map((x) => x.item);
  }
  return {
    status: 200,
    payload: {
      ok: true,
      q,
      modelId: modelId || undefined,
      total: memory.total,
      matched: ranked.length,
      items: ranked.slice(0, limit),
      hint: '命中即优先复用（l2d_nodegraph_run 执行 / l2d_graph_ai_edit 修补）；lastRun 非completed 时先读 failure 再决定；未命中才 l2d_graph_ai_plan 新建',
    },
  };
}
