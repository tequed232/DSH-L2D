/**
 * OACA-1 · 动作编译流水线（LLM 是编译器，不是 Runtime）。
 *
 * 输入：模型能力档案（Capability Profile）+ 动作清单 + 注入的 LLM 通道。
 * 输出：可发布的 action bundle（Manifest + 节点图 + 四层校验结果），原子落盘到
 *       <homeDir>/l2d-action-bundles/<modelId>/rev-<n>/，并写 current.json 指针。
 *
 * 三条硬纪律（对应用户 OACA 方案 §四）：
 *  1. **LLM 不直接写生产库**：编译器只产出候选 bundle，落盘由本模块 publishBundle 完成。
 *  2. **LLM 不决定校验是否通过**：四层校验在本地执行，LLM 输出只当候选。
 *  3. **失败不覆盖旧版本**：每次发布是新 revision 目录；current.json 只在全部写成功后
 *     用 tmp+rename 原子切换。旧 revision 原样保留 = 回滚即改指针。
 *
 * 复用而非重写（受保护范围零触碰）：
 *   - 生成：`aiPlan` / `buildAiPlanPrompt`（nodegraph-planner，既有 LLM 通道与 op 校验）
 *   - L1 Schema：`validateNodegraph`（Schema v1）
 *   - L2 Capability：本文件用 Capability Profile 的 controls + ownership
 *   - L3 Safety：manifest 参数域自检 + `ownership: requires-own` 标记（运行时必须先 own）
 *   - L4 Execution：OACA-1 阶段标 `skipped`（deferred-to-oaca-4），不伪报已执行
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { aiPlan } from './nodegraph-planner.mjs';
import { docFromEditorGraph, graphHash } from './nodegraph-ops.mjs';
import { loadNodegraph, sanitizeFileName, saveNodegraph, validateNodegraph } from './nodegraph.mjs';
import { isSafeModelId } from './nodegraph-schema.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 仓库根：packages/dsh-l2d-plugin/lib → ../../.. */
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const DEFAULT_PROFILE_DIR = path.join(REPO_ROOT, 'tools', 'capability-scan');

export const COMPILER_VERSION = 'oaca-1.0.0';
export const MANIFEST_VERSION = 1;
export const BUNDLE_VERSION = 1;
/** 单次编译最多处理的动作数（防止一次导入把 LLM 预算打穿）。 */
export const MAX_ACTIONS_PER_COMPILE = 12;
export const BUNDLE_DIR_NAME = 'l2d-action-bundles';

/** 优先级三档（复用节点图既有枚举，不新造数值优先级；数值仅用于兼容外部输入）。 */
export const PRIORITY_TIERS = Object.freeze(['BACKGROUND', 'NORMAL', 'FORCE']);

/**
 * 动作清单种子表（OACA-1 用固定清单；从 Capability 自动推导留到 OACA-2）。
 * requiredControls 全部取自真实模型档案里 status='supported' 的 id —— 不凭空编造能力。
 * parameters 是**动作参数**（intensity 等），不是 Live2D 引擎参数。
 */
export const SEED_ACTIONS = Object.freeze([
  {
    actionId: 'head.nod',
    category: 'head',
    triggers: ['interaction.head_nod'],
    instruction: '让角色轻轻点头：先给一个自然的轻微微笑表情，再点一下头，最后视线回正。幅度小、节奏短。',
    requiredControls: ['head.pitch'],
    parameters: { intensity: { type: 'number', min: 0, max: 1, default: 0.6 } },
    priority: 'NORMAL',
    interruptible: true,
  },
  {
    actionId: 'head.shake',
    category: 'head',
    triggers: ['interaction.head_shake'],
    instruction: '让角色摇头表示否定：表情略带为难，头部左右摇一次，然后视线回正。',
    requiredControls: ['head.yaw'],
    parameters: { intensity: { type: 'number', min: 0, max: 1, default: 0.6 } },
    priority: 'NORMAL',
    interruptible: true,
  },
  {
    actionId: 'head.tilt',
    category: 'head',
    triggers: ['interaction.head_tilt'],
    instruction: '让角色歪头表示好奇：先出现疑惑类表情，再轻微把头偏向一侧，保持片刻后回正。',
    requiredControls: ['head.roll'],
    parameters: { intensity: { type: 'number', min: 0, max: 1, default: 0.5 } },
    priority: 'NORMAL',
    interruptible: true,
  },
  {
    actionId: 'gaze.look',
    category: 'gaze',
    triggers: ['interaction.gaze'],
    instruction: '让角色把视线转向一侧看向用户，表情保持自然，随后视线回到正中。',
    requiredControls: ['gaze.x', 'gaze.y'],
    parameters: {
      intensity: { type: 'number', min: 0, max: 1, default: 0.5 },
      holdMs: { type: 'number', min: 0, max: 3000, default: 800 },
    },
    priority: 'BACKGROUND',
    interruptible: true,
  },
  {
    actionId: 'interaction.head_poke',
    category: 'interaction',
    triggers: ['pointer.head.click', 'interaction.head_poke'],
    instruction: '被戳头的反应：先露出可爱的害羞类表情，再做一个短暂的小动作回应，最后视线看向用户回正。',
    requiredControls: ['head.pitch', 'gaze.x'],
    parameters: { intensity: { type: 'number', min: 0, max: 1, default: 0.7 } },
    priority: 'FORCE',
    interruptible: true,
  },
]);

/** 数值优先级 → 三档（外部传入 0-100 时归一，避免第四套优先级体系）。 */
export function normalizePriority(value) {
  if (typeof value === 'string') {
    const up = value.trim().toUpperCase();
    return PRIORITY_TIERS.includes(up) ? up : 'NORMAL';
  }
  const n = Number(value);
  if (!Number.isFinite(n)) return 'NORMAL';
  if (n < 34) return 'BACKGROUND';
  if (n < 67) return 'NORMAL';
  return 'FORCE';
}

/** 能力档案的 revision：优先用档案自带的 profileRevision，否则对控制项做稳定哈希。 */
export function capabilityRevisionOf(profile) {
  if (profile && typeof profile.profileRevision === 'string' && profile.profileRevision.trim()) {
    return profile.profileRevision.trim();
  }
  if (!profile || !Array.isArray(profile.controls)) return '';
  const canonical = profile.controls
    .map((c) => `${c.id}|${c.status}|${c.min}|${c.max}|${c.ownership || ''}`)
    .sort()
    .join('\n');
  return 'rcap' + crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 12);
}

/**
 * 读取模型能力档案（只读，不存在则返回 null —— 调用方必须把 L2 标 skipped 而不是"通过"）。
 * @returns {{profile: object|null, file: string|null, reason?: string}}
 */
export function loadCapabilityProfile(modelId, { profileDir = DEFAULT_PROFILE_DIR } = {}) {
  if (!isSafeModelId(modelId)) return { profile: null, file: null, reason: 'unsafe-model-id' };
  const file = path.join(profileDir, `profile.${modelId}.json`);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return { profile: null, file, reason: err && err.code === 'ENOENT' ? 'missing' : 'unreadable' };
  }
  try {
    const profile = JSON.parse(text);
    return profile && typeof profile === 'object' ? { profile, file } : { profile: null, file, reason: 'invalid-shape' };
  } catch {
    return { profile: null, file, reason: 'invalid-json' };
  }
}

function graphIdFor(actionId) {
  return 'graph_' + String(actionId).replace(/[^a-zA-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
}

/**
 * 编译单个动作（生成 + L1/L2/L3 校验）。纯校验逻辑，不落盘。
 * @returns {Promise<{entry: object, doc: object|null}>} entry.status = 'compiled' | 'rejected'
 */
export async function compileOneAction({ action, modelId, llm, capability, live2dIds, allowed }) {
  const graphId = graphIdFor(action.actionId);
  const base = {
    actionId: action.actionId,
    graphId,
    category: action.category || 'misc',
    triggers: Array.isArray(action.triggers) ? [...action.triggers] : [],
    priority: normalizePriority(action.priority),
    interruptible: action.interruptible !== false,
    parameters: action.parameters || {},
    requiredControls: Array.isArray(action.requiredControls) ? [...action.requiredControls] : [],
  };

  const planned = await aiPlan(
    { instruction: action.instruction, lang: 'zh-CN' },
    { llm, live2dIds, allowed },
  );
  if (planned.status !== 200 || !planned.payload || planned.payload.ok !== true) {
    return {
      doc: null,
      entry: {
        ...base,
        status: 'rejected',
        stage: 'generate',
        reason: (planned.payload && planned.payload.reason) || 'generate-failed',
        errors: (planned.payload && planned.payload.errors) || [],
      },
    };
  }

  let doc;
  try {
    doc = docFromEditorGraph(
      planned.payload.graph,
      { name: graphId },
      { defaultBinding: { modelId, bindingMode: 'strict' } },
    );
  } catch (err) {
    return {
      doc: null,
      entry: { ...base, status: 'rejected', stage: 'normalize', reason: 'doc-build-failed', errors: [String((err && err.message) || err)] },
    };
  }
  if (planned.payload.explanation) doc.meta.semantic = planned.payload.explanation;

  const validation = validateCompiledAction({ doc, entry: base, capability, allowed });
  return {
    doc,
    entry: {
      ...base,
      status: validation.ok ? 'compiled' : 'rejected',
      stage: 'validate',
      ...(validation.ok ? {} : { reason: 'validation-failed', errors: validation.errors }),
      graphHash: validation.ok ? planned.payload.hash || graphHash(doc.graph) : undefined,
      nodeCount: doc.graph.nodes.length,
      semantic: planned.payload.explanation || '',
      requiresOwn: validation.requiresOwn,
      layers: validation.layers,
      warnings: validation.warnings,
    },
  };
}

/**
 * 四层校验（L4 在 OACA-1 显式 skipped，不伪报）。
 * @returns {{ok: boolean, layers: object, errors: string[], warnings: object[], requiresOwn: string[]}}
 */
export function validateCompiledAction({ doc, entry, capability, allowed = null }) {
  const errors = [];
  const warnings = [];

  // L1 Schema v1
  const schema = validateNodegraph(doc, { allowed });
  const schemaErrors = Array.isArray(schema.errors) ? schema.errors : [];
  if (!schema.ok) errors.push(...schemaErrors.map((e) => `schema: ${e}`));

  // L2 Capability
  let capabilityLayer;
  if (!capability || !Array.isArray(capability.controls)) {
    // 没有能力档案 ≠ 通过：如实标 skipped，避免"看起来验过了"
    capabilityLayer = { status: 'skipped', reason: 'capability-profile-missing', errors: [] };
  } else {
    const byId = new Map(capability.controls.map((c) => [c.id, c]));
    const capErrors = [];
    for (const controlId of entry.requiredControls || []) {
      const control = byId.get(controlId);
      if (!control) capErrors.push(`capability: 能力不存在 ${controlId}`);
      else if (control.status !== 'supported') capErrors.push(`capability: 能力不可用 ${controlId}（status=${control.status}）`);
    }
    errors.push(...capErrors);
    capabilityLayer = { status: capErrors.length ? 'fail' : 'pass', errors: capErrors };
  }

  // L3 Safety：manifest 参数域自检 + 物理输出参数 ownership 标记
  const safetyErrors = [];
  for (const [name, rule] of Object.entries(entry.parameters || {})) {
    if (!rule || rule.type !== 'number') {
      safetyErrors.push(`safety: 参数 ${name} 只支持 number（收到 ${rule && rule.type}）`);
      continue;
    }
    if (!Number.isFinite(rule.min) || !Number.isFinite(rule.max) || rule.min > rule.max) {
      safetyErrors.push(`safety: 参数 ${name} 的 min/max 非法`);
      continue;
    }
    if (!Number.isFinite(rule.default) || rule.default < rule.min || rule.default > rule.max) {
      safetyErrors.push(`safety: 参数 ${name} 的 default 不在 [${rule.min}, ${rule.max}]`);
    }
  }
  const requiresOwn = [];
  if (capability && Array.isArray(capability.controls)) {
    for (const control of capability.controls) {
      if (control.ownership === 'requires-own' && (entry.requiredControls || []).includes(control.id)) {
        // 物理输出参数：运行时必须先 own 才能写（不在这里判失败，转成运行时约束）
        requiresOwn.push(control.id);
      }
    }
    if (requiresOwn.length) {
      warnings.push({ reason: 'requires-own', message: `以下参数是物理输出，运行时必须先 own：${requiresOwn.join(', ')}`, controls: requiresOwn });
    }
  }
  errors.push(...safetyErrors);

  return {
    ok: errors.length === 0,
    layers: {
      schema: { status: schema.ok ? 'pass' : 'fail', errors: schemaErrors },
      capability: capabilityLayer,
      safety: { status: safetyErrors.length ? 'fail' : 'pass', errors: safetyErrors },
      // 不谎报：OACA-1 不做真机试执行
      execution: { status: 'skipped', reason: 'deferred-to-oaca-4' },
    },
    errors,
    warnings,
    requiresOwn,
  };
}

function bundlesRoot(homeDir) {
  return path.join(homeDir, BUNDLE_DIR_NAME);
}

/** 读取 current.json 指针（不存在返回 null）。 */
export function readCurrentBundle({ modelId, homeDir }) {
  const dir = path.join(bundlesRoot(homeDir), sanitizeFileName(modelId));
  const file = path.join(dir, 'current.json');
  try {
    const ptr = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!ptr || typeof ptr.revision !== 'number') return null;
    return { ...ptr, dir: path.join(dir, `rev-${ptr.revision}`) };
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * 把编译产物物化进节点图仓（`$DSH_HOME/l2d-nodegraphs`），让运行时能直接
 * `runNodegraph(graphId)` —— 否则 dispatch 只能入队一条无法执行的空链（OACA-3 断裂点）。
 *
 * 冲突纪律：同名图已存在时
 *   - 内容哈希相同 → 视为幂等，跳过写入；
 *   - 内容不同 → **不覆盖**（可能是用户手改图），该动作降级为 rejected，
 *     运行时永远不会拿到一条"发布成功但跑不起来"的动作。
 */
export function materializeGraphs({ bundle, actions, homeDir, allowed = null }) {
  const runnable = [];
  const conflicts = [];
  for (const action of actions) {
    const doc = bundle.graphs && bundle.graphs[action.graphId];
    if (!doc) {
      conflicts.push({ actionId: action.actionId, reason: 'graph-missing' });
      continue;
    }
    // 自证指纹写进 meta：saveNodegraph 会做规范化，落盘后 graphHash 与内存态可能不同口径，
    // 直接比 graphHash 会把"同一张图"误判成冲突。用自己的指纹判定幂等。
    const contentHash = graphHash(doc.graph);
    doc.meta = { ...(doc.meta || {}), oaca: { graphId: action.graphId, contentHash, compilerVersion: COMPILER_VERSION } };
    const existingRaw = loadNodegraph(action.graphId, { homeDir });
    if (existingRaw !== null) {
      // loadNodegraph 返回**原始文本**（不是对象），必须自己 parse。
      let existing = null;
      try {
        existing = JSON.parse(existingRaw);
      } catch {
        existing = null;
      }
      const existingHash = existing && existing.meta && existing.meta.oaca && existing.meta.oaca.contentHash;
      if (existingHash && existingHash === contentHash) {
        runnable.push(action);
        continue;
      }
      conflicts.push({ actionId: action.actionId, reason: 'graph-name-conflict' });
      continue;
    }
    const saved = saveNodegraph(doc, { homeDir, allowed });
    if (!saved.ok) {
      conflicts.push({ actionId: action.actionId, reason: 'materialize-failed', errors: saved.errors });
      continue;
    }
    runnable.push(action);
  }
  return { runnable, conflicts };
}

/**
 * 原子发布：新 revision 目录 + current.json 指针切换。
 * 只有至少一个动作通过校验**且已物化进节点图仓**才发布；失败动作随 manifest 一起入档
 * （status='rejected'），运行时应忽略它们（见 manifest.actions[].status）。
 */
export function publishBundle({ bundle, homeDir, allowed = null }) {
  if (!bundle || !Array.isArray(bundle.actions)) return { ok: false, reason: 'invalid-bundle' };
  const candidates = bundle.actions.filter((a) => a.status === 'compiled');
  if (!candidates.length) return { ok: false, reason: 'no-valid-action' };

  // 0) 先物化再落档：物化失败的动作用"拒绝"覆盖原状态，不进入发布清单
  const { runnable, conflicts } = materializeGraphs({ bundle, actions: candidates, homeDir, allowed });
  if (conflicts.length) {
    for (const conflict of conflicts) {
      const entry = bundle.actions.find((a) => a.actionId === conflict.actionId);
      if (!entry) continue;
      entry.status = 'rejected';
      entry.stage = 'materialize';
      entry.reason = conflict.reason;
      entry.errors = [...(entry.errors || []), ...(conflict.errors || [`物化失败：${conflict.reason}`])];
    }
  }
  const valid = runnable;
  if (!valid.length) {
    return { ok: false, reason: 'no-runnable-action', conflicts: conflicts.map((c) => c.reason) };
  }

  const dir = path.join(bundlesRoot(homeDir), sanitizeFileName(bundle.modelId));
  fs.mkdirSync(dir, { recursive: true });

  // revision 单调递增；目录已存在则继续 +1（防并发编译撞号）
  const current = readCurrentBundle({ modelId: bundle.modelId, homeDir });
  let revision = (current && Number(current.revision)) || 0;
  let revDir;
  for (let attempt = 0; attempt < 100; attempt++) {
    revision += 1;
    revDir = path.join(dir, `rev-${revision}`);
    if (!fs.existsSync(revDir)) break;
  }
  fs.mkdirSync(revDir, { recursive: false });

  // 1) 图（只写通过校验的）
  const graphDir = path.join(revDir, 'graphs');
  fs.mkdirSync(graphDir, { recursive: true });
  for (const action of valid) {
    writeJsonAtomic(path.join(graphDir, `${sanitizeFileName(action.graphId)}.json`), bundle.graphs[action.graphId]);
  }

  // 2) Manifest（动作是什么、怎么触发、要什么参数）
  const manifest = {
    manifestVersion: MANIFEST_VERSION,
    modelId: bundle.modelId,
    capabilityRevision: bundle.capabilityRevision,
    compilerVersion: bundle.compilerVersion,
    revision,
    compiledAt: bundle.compiledAt,
    actions: bundle.actions.map((a) => ({
      actionId: a.actionId,
      graphId: a.graphId,
      category: a.category,
      triggers: a.triggers,
      priority: a.priority,
      interruptible: a.interruptible,
      parameters: a.parameters,
      requiredControls: a.requiredControls,
      requiresOwn: a.requiresOwn || [],
      graphHash: a.graphHash || null,
      status: a.status,
      ...(a.reason ? { reason: a.reason } : {}),
    })),
  };

  // 3) 校验结果留档（可审计：谁在哪层被拒）
  const validation = {
    revision,
    compilerVersion: bundle.compilerVersion,
    actions: Object.fromEntries(bundle.actions.map((a) => [a.actionId, { status: a.status, layers: a.layers || null, errors: a.errors || [] }])),
  };

  writeJsonAtomic(path.join(revDir, 'manifest.json'), manifest);
  writeJsonAtomic(path.join(revDir, 'validation.json'), validation);
  writeJsonAtomic(path.join(revDir, 'bundle.json'), { bundleVersion: BUNDLE_VERSION, ...bundle, graphs: undefined });

  // 4) 指针最后切换：前面任何一步抛错都不会影响旧 revision
  const manifestHash = crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex').slice(0, 16);
  writeJsonAtomic(path.join(dir, 'current.json'), {
    modelId: bundle.modelId,
    revision,
    manifestHash,
    publishedAt: new Date().toISOString(),
  });

  return { ok: true, revision, dir: revDir, manifestHash, publishedActions: valid.map((a) => a.actionId) };
}

/**
 * 编译 + 发布（一步到位）。dryRun=true 时只编译校验、不落盘。
 * @param {{modelId: string, actions?: object[], llm: Function, capability?: object|null,
 *   live2dIds?: object|null, allowed?: object|null, homeDir: string, dryRun?: boolean}} opts
 */
export async function compileModelActions(opts = {}) {
  const { modelId, actions = SEED_ACTIONS, llm, homeDir, dryRun = false } = opts;
  if (!modelId || !isSafeModelId(modelId)) return { ok: false, reason: 'unsafe-model-id' };
  if (!homeDir) return { ok: false, reason: 'home-dir-required' };
  if (typeof llm !== 'function') {
    return { ok: false, reason: 'ai-unavailable', message: '宿主 LLM 通道不可用（未配置 Key 或无通道），未编译任何动作' };
  }
  const list = Array.isArray(actions) ? actions.slice(0, MAX_ACTIONS_PER_COMPILE) : [];
  if (!list.length) return { ok: false, reason: 'no-actions' };

  // 能力档案：未显式注入则按 modelId 读真实档案；读不到 → L2 诚实 skipped
  let capability = opts.capability || null;
  let profileSource = opts.capability ? 'injected' : '';
  if (!capability) {
    const loaded = loadCapabilityProfile(modelId, opts.profileDir ? { profileDir: opts.profileDir } : {});
    capability = loaded.profile;
    profileSource = loaded.profile ? loaded.file : `unavailable:${loaded.reason}`;
  }

  const bundle = {
    bundleVersion: BUNDLE_VERSION,
    compilerVersion: COMPILER_VERSION,
    modelId,
    capabilityRevision: capabilityRevisionOf(capability),
    compiledAt: new Date().toISOString(),
    profileSource,
    actions: [],
    graphs: {},
  };

  for (const action of list) {
    const { entry, doc } = await compileOneAction({
      action,
      modelId,
      llm,
      capability,
      live2dIds: opts.live2dIds || null,
      allowed: opts.allowed || null,
    });
    bundle.actions.push(entry);
    if (doc && entry.status === 'compiled') bundle.graphs[entry.graphId] = doc;
  }

  const compiled = bundle.actions.filter((a) => a.status === 'compiled').length;
  const rejected = bundle.actions.length - compiled;
  const summary = {
    requested: list.length,
    compiled,
    rejected,
    capabilityLayer: capability ? 'evaluated' : 'skipped',
    executionLayer: 'skipped',
  };

  if (dryRun) {
    return { ok: compiled > 0, modelId, capabilityRevision: bundle.capabilityRevision, bundle, summary, published: null };
  }

  const published = publishBundle({ bundle, homeDir, allowed: opts.allowed || null });
  return {
    ok: published.ok,
    modelId,
    capabilityRevision: bundle.capabilityRevision,
    bundle,
    summary,
    published,
    ...(published.ok ? {} : { reason: published.reason }),
  };
}
