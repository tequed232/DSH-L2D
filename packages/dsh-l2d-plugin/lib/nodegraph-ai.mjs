/**
 * AI 节点编辑：把「自然语言指令 + 节点说明 + 当前图」交给宿主 LLM 通道，拿回 JSON ops，
 * 再用 applyOps 预演校验。不合法的 op 不返回给前端，而是放进 warnings。
 *
 * 纯逻辑模块：LLM 调用以 llm({system, user}) => Promise<object> 注入（宿主传 llm-channel 的
 * DeepSeek 通道；单测传假函数）。llm 缺失 → 503 ai-unavailable，绝不伪造结果。
 * 本模块不读写任何文件或宿主状态。
 */
import { applyOps, graphHash, stableStringify } from './nodegraph-ops.mjs';
import { MAX_OPS_PER_CALL, buildNodeSchema } from './nodegraph-schema.mjs';

export const AI_EDIT_LANGS = Object.freeze(['zh-CN', 'en', 'ja']);
export const MAX_INSTRUCTION_LENGTH = 2000;
const LANG_NAMES = { 'zh-CN': '简体中文', en: 'English', ja: '日本語' };

/** lang 归一化：zh / zh-cn / zh-CN → zh-CN；未知回 zh-CN。 */
export function normalizeLang(lang) {
  const s = String(lang || '').trim().toLowerCase();
  if (s.startsWith('en')) return 'en';
  if (s.startsWith('ja')) return 'ja';
  return 'zh-CN';
}

/**
 * 构造提示词。节点说明直接取 buildNodeSchema()（与 NODE-SCHEMA.json 同源，不手抄）；
 * live2dIds 存在时附上合法 Live2D ID。
 */
export function buildAiEditPrompt({ graph, instruction, lang, live2dIds }) {
  const schema = buildNodeSchema();
  const system = [
    '你是 DSH-L2D 动作节点编辑器的编辑助手。你只能输出编辑操作（ops），由程序确定性地应用到节点图上。',
    '严格返回 JSON：{"ops": [ ... ], "explanation": "..."}，不要输出 Markdown 或其它文字。',
    'ops 里每一项必须是下面 schema.ops 中定义的一种：add_node / remove_node / set_param / connect / disconnect / move_node，字段名照抄。',
    '只能使用 schema.nodeTypes 里的节点类型与参数；数值必须在 min~max 内；enum 只能取 options 里的值。',
    '表情名 / 动作组名只能用给定清单里的值，不要发明；动作组 Idle 由引擎自播，不能写进节点。',
    '本模型没有 HitAreas，也没有 pose3：pose 节点只是手臂姿势预设，不要假设点击区域或 pose3 存在。',
    '连线规则：只能 out → in；两端 portType 相同；不能自连、不能成环、不能重复；目标已有输入时要么先 disconnect，要么写 replace:true。',
    '新节点请显式给 id（字母数字下划线，不与现有 id 冲突），并给 pos 放在相关节点附近（横向间距约 260，纵向约 170）。',
    '只做用户要求的最小改动，不要重排无关节点。',
    `explanation 用 ${LANG_NAMES[lang] || LANG_NAMES['zh-CN']} 写，一两句话说明改了什么。`,
    '',
    '节点说明（schema）：',
    JSON.stringify(schema),
  ];
  if (live2dIds) {
    system.push('', '当前模型的合法 Live2D ID（以此为准，优先于 schema 里的 enumFallback）：', JSON.stringify(live2dIds));
  }
  const user = [
    '当前节点图（设计层，viewport 已省略）：',
    stableStringify({ nodes: graph.nodes || [], edges: graph.edges || [] }),
    '',
    '用户指令：',
    instruction,
    '',
    '请返回 JSON。',
  ].join('\n');
  return { system: system.join('\n'), user };
}

/**
 * @param {{graph: object, instruction: string, lang?: string, modelId?: string}} body
 * @param {{llm?: Function|null, live2dIds?: object|null, allowed?: {expressions?: Set<string>, motionGroups?: Set<string>}|null}} deps
 *   allowed：按模型注入的动态白名单（静态 ∪ 该模型 live2d-ids.json），预演与复核共用。
 * @returns {Promise<{status: number, payload: object}>}
 */
export async function aiEdit(body, deps = {}) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const instruction = typeof b.instruction === 'string' ? b.instruction.trim() : '';
  if (!instruction) return bad(400, 'invalid-request', 'instruction 必须是非空字符串');
  if (instruction.length > MAX_INSTRUCTION_LENGTH) return bad(400, 'invalid-request', `instruction 最长 ${MAX_INSTRUCTION_LENGTH} 字`);
  const lang = normalizeLang(b.lang);
  const probe = applyOps(b.graph, [], { allowed: deps.allowed || null });
  if (probe.errors.some((e) => e.reason === 'invalid-graph')) {
    return { status: 400, payload: { ok: false, reason: 'invalid-graph', errors: probe.errors } };
  }
  const baseHash = graphHash(b.graph);
  if (typeof deps.llm !== 'function') {
    return {
      status: 503,
      payload: { ok: false, reason: 'ai-unavailable', message: '宿主 LLM 通道不可用（未配置 DeepSeek API Key 或当前环境无 LLM 通道），未生成任何改动', baseHash },
    };
  }
  const live2dIds = deps.live2dIds || null;
  const prompt = buildAiEditPrompt({ graph: probe.graph, instruction, lang, live2dIds });
  let raw;
  try {
    raw = await deps.llm(prompt);
  } catch (err) {
    return { status: 502, payload: { ok: false, reason: 'ai-failed', message: String((err && err.message) || err).slice(0, 300), baseHash } };
  }
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.ops)) {
    return { status: 502, payload: { ok: false, reason: 'ai-bad-response', message: '模型返回里没有 ops 数组', baseHash } };
  }
  const warnings = [];
  let aiOps = raw.ops;
  if (aiOps.length > MAX_OPS_PER_CALL) {
    warnings.push({ opIndex: null, reason: 'too-many-ops', message: `模型给了 ${aiOps.length} 个 op，只预演前 ${MAX_OPS_PER_CALL} 个` });
    aiOps = aiOps.slice(0, MAX_OPS_PER_CALL);
  }
  // 预演：逐 op 应用，失败的跳过并记入 warnings（opIndex 指模型原始 ops 下标）
  const preview = applyOps(b.graph, aiOps, { mode: 'skip', live2dIds, allowed: deps.allowed || null });
  for (const e of preview.errors) {
    const w = { opIndex: e.opIndex, reason: e.reason, message: e.message };
    if (e.opIndex !== null) w.op = aiOps[e.opIndex];
    warnings.push(w);
  }
  // 不阻断的告警（如 live2d-id-not-in-model）：op 保留，告警一并带给前端
  for (const w of preview.warnings) warnings.push({ ...w, op: aiOps[w.opIndex] });
  const ops = preview.appliedOps.map((i) => aiOps[i]);
  // 复核：只含合法 op 的整批 atomic 应用必须成功（确定性保证，防预演与确认结果不一致）
  const verify = applyOps(b.graph, ops, { live2dIds, allowed: deps.allowed || null });
  if (!verify.applied) {
    return { status: 502, payload: { ok: false, reason: 'ai-preview-mismatch', message: '合法 op 复核应用失败', errors: verify.errors, baseHash } };
  }
  const explanation = typeof raw.explanation === 'string' ? raw.explanation.trim().slice(0, 1000) : '';
  return {
    status: 200,
    payload: { ok: true, ops, explanation, warnings, baseHash, valid: verify.valid, previewHash: graphHash(verify.graph) },
  };
}

function bad(status, reason, message) {
  return { status, payload: { ok: false, reason, message } };
}
