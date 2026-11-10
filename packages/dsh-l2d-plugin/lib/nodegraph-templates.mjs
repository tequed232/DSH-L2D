/**
 * 语义模板 → 动作链节点图生成器（戳一戳节点图化 · 模型导入自动初始化）。
 *
 * 需求（2026-11-10 用户原话）：模型导入插件时自动调用 dsh 初始化联动节点，基于已知
 * 语义表达自动生成对应的动作链节点编排，确保可复用、可扩展、编排结果与语义表达一致。
 *
 * 三层结构：
 *   1. SEMANTIC_TEMPLATES —— 纯数据模板（新增语义 = 加一个模板对象，不改任何逻辑）。
 *      每模板声明「语义描述 + 资源候选清单（按优先级回退）」，资源名是语义意图，
 *      实际取值由当前模型的 live2d-ids.json 清单匹配器决定。
 *   2. instantiateTemplate / instantiateAllTemplates —— 纯函数实例化：候选 × 清单
 *      匹配（第一个存在的候选胜出，全缺 → 跳过该模板 = 该模型不支持该语义）。
 *      产出 docs/nodegraph SPEC v1 分享 JSON（strict 绑定 modelId），meta 记
 *      templateId / templateVersion / 语义依据，可在编辑器里看到编排语义注释。
 *   3. ensureModelNodegraphs —— 幂等落盘编排：已存在且 templateVersion 相同 → 跳过
 *      （保留用户手改）；已存在但版本更旧 → 按新模板重生成（升级策略：模板升级时
 *      用户手改会被覆盖，meta.templateVersion 可追溯）；不存在 → 生成。
 *
 * 资源名事实来源：docs/nodegraph/models/<modelId>/live2d-ids.json（Live2D 同事维护，
 * 本模块绝不编造清单内容）；动作收招名由 choreography.PAIRED_CLOSES 推导，且仅在
 * 收招名也在清单里时才写 closeMotion（避免编译校验 unknown-live2d-id）。
 */
import { PAIRED_CLOSES } from './choreography.mjs';
import { loadNodegraph, saveNodegraph } from './nodegraph.mjs';
import { allowedFromLive2dIds, isSafeModelId, loadLive2dIdsForModel } from './nodegraph-schema.mjs';

/** 模板版本：模板编排改动时 +1，ensure 按它决定重生成/跳过。 */
export const POKE_TEMPLATE_VERSION = 1;
/** 戳一戳固定节点图名（overlay 节点图策略固定 run 这一张）。 */
export const POKE_GRAPH_NAME = 'poke-response';

/**
 * 语义模板库（数据驱动）。字段：
 *   id          语义 id（也是缺省图名）
 *   graphName   落盘图名（poke 固定 poke-response，其余与 id 相同）
 *   semantic    语义描述（写进 meta 与语义注释）
 *   expressions 表情候选（按优先级回退；[] = 该模板不带表情）
 *   motions     动作候选（打开类；[] = 不带动作）
 *   look        视线落点 {x,y}（look 回正/偏移语义）
 *   lookDelayMs 表情/动作后的视线延时
 */
export const SEMANTIC_TEMPLATES = Object.freeze([
  {
    id: 'poke',
    graphName: POKE_GRAPH_NAME,
    semantic: '被戳：可爱表情反应 → 打开类小动作回应 → 视线回正看向用户',
    expressions: ['兔牙', '圈圈眼', '＞＜'],
    motions: ['狗尾巴草打开', '竖手指打开'],
    look: { x: 0, y: 0.05 },
    lookDelayMs: 600,
  },
  {
    id: 'greet',
    graphName: 'greet',
    semantic: '打招呼：开心表情 → 招手指向用户 → 视线看向用户',
    expressions: ['兔牙', '爱心眼'],
    motions: ['竖手指打开', '狗尾巴草打开'],
    look: { x: 0, y: 0.05 },
    lookDelayMs: 400,
  },
  {
    id: 'happy',
    graphName: 'happy',
    semantic: '开心：爱心眼/圈圈眼表情 → 亲昵小动作 → 视线回正',
    expressions: ['爱心眼', '圈圈眼', '兔牙'],
    motions: ['抚胸手打开', '狗尾巴草打开'],
    look: { x: 0, y: 0.1 },
    lookDelayMs: 400,
  },
  {
    id: 'shy',
    graphName: 'shy',
    semantic: '害羞：脸红表情 → 视线躲闪偏向一侧',
    expressions: ['脸红', '＞＜'],
    motions: ['抚胸手打开'],
    look: { x: 0.2, y: 0.25 },
    lookDelayMs: 300,
  },
  {
    id: 'confused',
    graphName: 'confused',
    semantic: '疑惑：圈圈眼/单片眼镜 → 视线歪向一侧',
    expressions: ['圈圈眼', '单片眼镜', '＞＜'],
    motions: ['竖手指打开'],
    look: { x: -0.2, y: 0.15 },
    lookDelayMs: 300,
  },
]);

function inList(list, name) {
  return Array.isArray(list) && list.includes(name);
}

/** 候选回退匹配：返回第一个在清单里的候选；全缺 → null。 */
export function pickFirstAvailable(candidates, catalogList) {
  const list = Array.isArray(catalogList) ? catalogList : [];
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    if (typeof candidate === 'string' && candidate && inList(list, candidate)) return candidate;
  }
  return null;
}

/**
 * 单模板实例化（纯函数）。
 * @param {object} template SEMANTIC_TEMPLATES 之一
 * @param {object|null} catalog loadLive2dIdsForModel 出的清单（{motions, expressions,...}）
 * @param {{modelId?: string, templateVersion?: number}} [options]
 * @returns {{ok: true, doc: object, picks: object}
 *           |{ok: false, reason: 'resources-missing', missing: string[]}}
 */
export function instantiateTemplate(template, catalog, options = {}) {
  const version = Number(options.templateVersion) || POKE_TEMPLATE_VERSION;
  const expressions = (catalog && Array.isArray(catalog.expressions)) ? catalog.expressions : [];
  const motions = (catalog && Array.isArray(catalog.motions)) ? catalog.motions : [];
  const expr = pickFirstAvailable(template.expressions, expressions);
  const motion = pickFirstAvailable(template.motions, motions);
  if (!expr && !motion) {
    return {
      ok: false,
      reason: 'resources-missing',
      missing: [
        ...(template.expressions || []).length && !expr ? ['expressions: ' + template.expressions.join('/')] : [],
        ...(template.motions || []).length && !motion ? ['motions: ' + template.motions.join('/')] : [],
      ],
    };
  }

  const nodes = [];
  const semanticNotes = [];
  if (expr) {
    nodes.push({ id: 'expr', type: 'expression', name: expr, delayMs: 0 });
    semanticNotes.push(`表情 ${expr}：语义「${template.semantic}」的第一候选命中清单`);
  }
  if (motion) {
    const node = { id: 'motion', type: 'motion', name: motion, delayMs: expr ? 200 : 0 };
    const close = PAIRED_CLOSES[motion];
    if (close && inList(motions, close)) {
      node.closeMotion = close;
      node.closeAfterMs = 5200;
    }
    nodes.push(node);
    semanticNotes.push(
      `动作 ${motion}` + (node.closeMotion ? `（配对收招 ${node.closeMotion}）` : '（清单无配对收招，不写 closeMotion）') +
      `：候选按可用性回退命中`
    );
  }
  // 视线步：语义收尾（回正/偏移），延时后落点，只与表情/动作其一共存也有意义。
  nodes.push({
    id: 'look',
    type: 'look',
    x: template.look.x,
    y: template.look.y,
    delayMs: template.lookDelayMs,
  });
  semanticNotes.push(`look(${template.look.x},${template.look.y})：语义收尾视线`);
  nodes.forEach((node, index) => {
    node.next = index + 1 < nodes.length ? [nodes[index + 1].id] : [];
  });

  const doc = {
    schemaVersion: 1,
    kind: 'dsh-l2d-nodegraph',
    name: template.graphName,
    modelBinding: {
      modelId: typeof options.modelId === 'string' ? options.modelId : '',
      modelHash: '',
      bindingMode: 'strict',
    },
    graph: { roots: [nodes[0].id], nodes },
    meta: {
      templateId: template.id,
      templateVersion: version,
      semantic: template.semantic,
      editor: { note: semanticNotes.join('；') },
    },
  };
  return { ok: true, doc, picks: { expression: expr, motion, closeMotion: nodes[nodes.length - 2] && nodes[nodes.length - 2].closeMotion } };
}

/**
 * 全模板 × 清单实例化。匹配不到资源的模板跳过（该模型不支持该语义）。
 * @returns {{docs: object[], skipped: Array<{id: string, graphName: string, reason: string, missing?: string[]}>, picks: object}}
 */
export function instantiateAllTemplates(catalog, options = {}) {
  const docs = [];
  const skipped = [];
  const picks = {};
  for (const template of SEMANTIC_TEMPLATES) {
    const out = instantiateTemplate(template, catalog, options);
    if (out.ok) {
      docs.push(out.doc);
      picks[template.id] = out.picks;
    } else {
      skipped.push({ id: template.id, graphName: template.graphName, reason: out.reason, missing: out.missing });
    }
  }
  return { docs, skipped, picks };
}

/**
 * 模型导入自动初始化联动节点（幂等）：
 *   - 模型清单缺失 → 全部模板按 resources-missing 跳过（绝不编造资源名）；
 *   - 图不存在 → 生成并落盘（strict 绑定 modelId）；
 *   - 图已存在且 meta.templateVersion 相同 → 跳过（保留用户手改）；
 *   - 图已存在但版本更旧 → 按新模板重生成（覆盖 = 升级策略）；
 *   - 图已存在但版本更新（比本代码新）→ 跳过（不降级）。
 *
 * @param {string} modelId 模型文件名去 .model3.json
 * @param {{homeDir?: string, modelsDir?: string, globalFile?: string, cache?: Map, templateVersion?: number}} [options]
 * @returns {{ok: true, modelId: string, generated: string[], unchanged: string[], regenerated: string[],
 *            skipped: Array, failed: Array<{name: string, errors: string[]}>, catalogSource: string}
 *           |{ok: false, reason: 'no-model'|'unsafe-model-id', modelId: string}}
 */
export function ensureModelNodegraphs(modelId, options = {}) {
  if (!modelId || typeof modelId !== 'string') return { ok: false, reason: 'no-model', modelId: modelId || '' };
  if (!isSafeModelId(modelId)) return { ok: false, reason: 'unsafe-model-id', modelId };
  const loaded = loadLive2dIdsForModel(modelId, {
    modelsDir: options.modelsDir,
    globalFile: options.globalFile,
    cache: options.cache,
  });
  const out = instantiateAllTemplates(loaded.ids, {
    modelId,
    templateVersion: options.templateVersion,
  });

  const allowed = allowedFromLive2dIds(loaded.ids);
  const generated = [];
  const unchanged = [];
  const regenerated = [];
  const failed = [];
  for (const doc of out.docs) {
    const graphName = doc.name;
    let existingVersion = null;
    try {
      const raw = loadNodegraph(graphName, { homeDir: options.homeDir });
      if (raw !== null) {
        const existing = JSON.parse(raw);
        const tv = existing && existing.meta && Number(existing.meta.templateVersion);
        if (Number.isFinite(tv)) existingVersion = tv;
      }
    } catch {
      /* 损坏文件按不存在处理：重生成覆盖 */
    }
    if (existingVersion !== null) {
      if (existingVersion === (Number(options.templateVersion) || POKE_TEMPLATE_VERSION)) {
        unchanged.push(graphName);
        continue;
      }
      if (existingVersion > (Number(options.templateVersion) || POKE_TEMPLATE_VERSION)) {
        unchanged.push(graphName); // 图版本比代码新：不降级
        continue;
      }
    }
    try {
      const saved = saveNodegraph(doc, { homeDir: options.homeDir, allowed });
      if (saved.ok) {
        (existingVersion !== null ? regenerated : generated).push(graphName);
      } else {
        failed.push({ name: graphName, errors: saved.errors });
      }
    } catch (err) {
      failed.push({ name: graphName, errors: [String((err && err.message) || err)] });
    }
  }
  return {
    ok: true,
    modelId,
    catalogSource: loaded.source,
    generated,
    regenerated,
    unchanged,
    skipped: out.skipped,
    failed,
  };
}
