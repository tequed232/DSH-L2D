/**
 * AI 动作链规划器（Phase 2 / LLM Action Planner）：把「自然语言意图 + 模型能力清单」交给宿主
 * LLM 通道，从空图创建一条完整、合法、可执行的动作链，并持久化为新节点图。
 *
 * 与 nodegraph-ai.mjs（aiEdit，编辑既有图）的分工：
 *   - aiEdit：graph 已存在，做最小改动，不落盘；
 *   - aiPlan：从空种子图创建全链，产出必须通过整图校验（valid:true）才允许保存。
 *
 * 纯逻辑 + 显式落盘：LLM 以 llm({system, user}) => Promise<object> 注入（宿主传 llm-channel
 * 的 DeepSeek 通道，单测传假函数；llm 缺失 → 503 ai-unavailable，绝不伪造结果）。
 * 校验/保存完全复用 applyOps / docFromEditorGraph / saveNodegraph，不新造校验。
 */
import { applyOps, docFromEditorGraph, graphHash } from './nodegraph-ops.mjs';
import { MAX_OPS_PER_CALL, buildNodeSchema, loadLive2dIdsForModel, allowedFromLive2dIds } from './nodegraph-schema.mjs';
import { MAX_INSTRUCTION_LENGTH, normalizeLang } from './nodegraph-ai.mjs';
import { guardGraphCall } from './host-guard.mjs';
import { loadNodegraph, saveNodegraph, sanitizeFileName } from './nodegraph.mjs';

const LANG_NAMES = { 'zh-CN': '简体中文', en: 'English', ja: '日本語' };

/**
 * 构造创建型提示词。与 buildAiEditPrompt 同源取 buildNodeSchema()（不手抄 schema），
 * 但指令从「最小改动」换成「从空图创建完整链」。
 */
export function buildAiPlanPrompt({ instruction, lang, live2dIds }) {
  const schema = buildNodeSchema();
  const system = [
    '你是 DSH-L2D 动作链规划器。用户给出一个行为意图，你要从空节点图创建一条完整、可执行的动作链。',
    '严格返回 JSON：{"ops": [ ... ], "explanation": "..."}，不要输出 Markdown 或其它文字。',
    'ops 里每一项必须是下面 schema.ops 中定义的一种：add_node / remove_node / set_param / connect / disconnect / move_node，字段名照抄。',
    '创建规则：',
    '- 必须恰好一个 trigger 节点作为入口（type: "trigger"），动作节点串在它后面。',
    '- 动作节点类型只能用 schema.nodeTypes 里的 expression / motion / pose / look / delay；一般 2~6 个动作节点，长度服务于意图，不要堆砌。',
    '- 用 connect 把节点连成单链（out → in，两端 portType 相同，不能自连、不能成环、不能重复）。',
    '- 参数与数值必须在 schema 的 min~max 内；enum 只能取 options 里的值。',
    '- 表情名 / 动作组名只能用给定清单里的值，不要发明；动作组 Idle 由引擎自播，不能写进节点。',
    '- 本模型没有 HitAreas，也没有 pose3：pose 节点只是手臂姿势预设，不要假设点击区域或 pose3 存在。',
    '- 每个节点显式给 id（字母数字下划线，不重复）和 pos（横向间距约 260）。',
    '- motion 节点如清单里有成对的「开/关」动作组，按语义给 closeMotion 与 closeAfterMs。',
    `explanation 用 ${LANG_NAMES[lang] || LANG_NAMES['zh-CN']} 写，一两句话概括这条动作链的语义。`,
    '',
    '节点说明（schema）：',
    JSON.stringify(schema),
  ];
  if (live2dIds) {
    system.push('', '当前模型的合法 Live2D ID（以此为准，优先于 schema 里的 enumFallback）：', JSON.stringify(live2dIds));
  }
  const user = [
    '当前节点图为空（你从零创建）。',
    '',
    '用户意图：',
    instruction,
    '',
    '请返回 JSON。',
  ].join('\n');
  return { system: system.join('\n'), user };
}

/**
 * 从空图规划一条动作链（不落盘；落盘在 handleAiPlan）。
 * @param {{name: string, instruction: string, lang?: string, modelId?: string}} body
 * @param {{llm?: Function|null, live2dIds?: object|null, allowed?: object|null}} deps
 * @returns {Promise<{status: number, payload: object}>}
 */
export async function aiPlan(body, deps = {}) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const instruction = typeof b.instruction === 'string' ? b.instruction.trim() : '';
  if (!instruction) return bad(400, 'invalid-request', 'instruction 必须是非空字符串');
  if (instruction.length > MAX_INSTRUCTION_LENGTH) return bad(400, 'invalid-request', `instruction 最长 ${MAX_INSTRUCTION_LENGTH} 字`);
  const lang = normalizeLang(b.lang);
  if (typeof deps.llm !== 'function') {
    return {
      status: 503,
      payload: { ok: false, reason: 'ai-unavailable', message: '宿主 LLM 通道不可用（未配置 DeepSeek API Key 或当前环境无 LLM 通道），未创建任何动作链' },
    };
  }
  const live2dIds = deps.live2dIds || null;
  const prompt = buildAiPlanPrompt({ instruction, lang, live2dIds });
  let raw;
  try {
    raw = await deps.llm(prompt);
  } catch (err) {
    return { status: 502, payload: { ok: false, reason: 'ai-failed', message: String((err && err.message) || err).slice(0, 300) } };
  }
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.ops)) {
    return { status: 502, payload: { ok: false, reason: 'ai-bad-response', message: '模型返回里没有 ops 数组' } };
  }
  const warnings = [];
  let aiOps = raw.ops;
  if (aiOps.length > MAX_OPS_PER_CALL) {
    warnings.push({ opIndex: null, reason: 'too-many-ops', message: `模型给了 ${aiOps.length} 个 op，只应用前 ${MAX_OPS_PER_CALL} 个` });
    aiOps = aiOps.slice(0, MAX_OPS_PER_CALL);
  }
  // 预演（空种子图）：逐 op 应用，失败的跳过并记入 warnings
  const seed = { nodes: [], edges: [] };
  const preview = applyOps(seed, aiOps, { mode: 'skip', live2dIds, allowed: deps.allowed || null });
  for (const e of preview.errors) {
    const w = { opIndex: e.opIndex, reason: e.reason, message: e.message };
    if (e.opIndex !== null) w.op = aiOps[e.opIndex];
    warnings.push(w);
  }
  const ops = preview.appliedOps.map((i) => aiOps[i]);
  // 复核：合法 op 原子应用必须成功（确定性保证）
  const verify = applyOps(seed, ops, { live2dIds, allowed: deps.allowed || null });
  if (!verify.applied) {
    return { status: 502, payload: { ok: false, reason: 'ai-preview-mismatch', message: '合法 op 复核应用失败', errors: verify.errors } };
  }
  // 创建语义的硬门槛：整图必须构成完整可执行链（与编辑语义不同——编辑允许中间态，创建不允许）
  if (!verify.valid) {
    return {
      status: 422,
      payload: { ok: false, reason: 'plan-invalid', message: '生成的节点图不构成完整动作链，已放弃保存', errors: verify.errors, warnings },
    };
  }
  const explanation = typeof raw.explanation === 'string' ? raw.explanation.trim().slice(0, 1000) : '';
  return {
    status: 200,
    payload: {
      ok: true,
      ops,
      explanation,
      warnings,
      graph: verify.graph,
      nodeCount: verify.graph.nodes.length,
      hash: graphHash(verify.graph),
    },
  };
}

/**
 * 路由处理器：POST /dsh-l2d/api/nodegraph/ai-plan
 * body: {name, instruction, lang?, modelId?}——从自然语言意图创建并保存全新节点图。
 * 与 handleAiEdit 同构：guardGraphCall 静态守卫 → 按模型解析清单 → aiPlan → docFromEditorGraph
 * → saveNodegraph（modelBinding 默认 strict 绑定该模型）。
 * @param {object} body
 * @param {{llm?: Function|null, getCurrentModelId?: Function, homeDir?: string}} deps
 */
export async function handleAiPlan(body, deps = {}) {
  const guarded = guardGraphCall({ name: 'l2d_graph_ai_plan', args: body && typeof body === 'object' ? { name: body.name, instruction: body.instruction } : {} });
  if (!guarded.ok) return { status: 400, payload: { ok: false, reason: guarded.reason, message: guarded.message } };
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  let name = typeof b.name === 'string' ? b.name.trim() : '';
  try {
    name = sanitizeFileName(name);
  } catch (err) {
    return { status: 400, payload: { ok: false, reason: 'invalid-name', message: 'name 非法：' + String((err && err.message) || err) } };
  }
  if (loadNodegraph(name, { homeDir: deps.homeDir }) !== null) {
    return {
      status: 409,
      payload: { ok: false, reason: 'name-exists', message: `已存在同名节点图「${name}」：换一个名字，或用 l2d_graph_apply_ops / l2d_graph_ai_edit 编辑既有图` },
    };
  }
  const modelId = (typeof b.modelId === 'string' && b.modelId.trim()) || (typeof deps.getCurrentModelId === 'function' ? deps.getCurrentModelId() : '');
  if (!modelId) {
    return { status: 400, payload: { ok: false, reason: 'no-model', message: '无法确定目标模型：body.modelId 缺省且宿主当前模型未知' } };
  }
  const loaded = loadLive2dIdsForModel(modelId);
  const out = await aiPlan(b, { llm: deps.llm || null, live2dIds: loaded.ids, allowed: allowedFromLive2dIds(loaded.ids) });
  if (out.status !== 200) return out;
  const payload = out.payload;
  // 设计层图 → Schema v1 文档（strict 绑定规划时用的模型），semantic 记录 LLM 解释
  const doc = docFromEditorGraph(payload.graph, { name }, { defaultBinding: { modelId, bindingMode: 'strict' } });
  if (payload.explanation) doc.meta.semantic = payload.explanation;
  const saved = saveNodegraph(doc, { homeDir: deps.homeDir, allowed: allowedFromLive2dIds(loaded.ids) });
  if (!saved.ok) {
    return { status: 500, payload: { ok: false, reason: 'save-failed', message: '生成的动作链未通过落盘校验，未保存', errors: saved.errors } };
  }
  return {
    status: 200,
    payload: {
      ok: true,
      name: saved.name,
      modelId,
      nodeCount: payload.nodeCount,
      ops: payload.ops,
      explanation: payload.explanation,
      warnings: payload.warnings,
      hash: payload.hash,
      saved: true,
      ...(loaded.source ? { live2dIdsSource: loaded.source } : {}),
      ...(loaded.warning ? { catalogWarning: loaded.warning } : {}),
    },
  };
}

function bad(status, reason, message) {
  return { status, payload: { ok: false, reason, message } };
}
