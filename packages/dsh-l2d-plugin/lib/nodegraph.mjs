/**
 * 节点图动作编排通道（契约：docs/nodegraph/SPEC.md v1）
 *
 * 职责（后端线）：
 *   1. 分享 JSON Schema v1 校验（§2 全规则）+ graph → segments 编译器 + segments 回算 graph；
 *      单一执行真源是 segments（与 action-sequence.validateActionSequence 同构，导入即可跑）。
 *   2. `$DSH_HOME/l2d-nodegraphs/<name>.json` 分享图存取（文件名安全化、先校验后写、原子覆盖）。
 *   3. `$DSH_HOME/l2d-motion-mode.json` 模式互斥状态文件（§3：nodegraph | llm，缺省 llm 现状兼容）。
 *   4. 执行入口 `runNodegraph`（§4 第 4 行，NG-RUN）：mode 互斥的另一半（llm 模式 409 mode-blocked）
 *      → loadNodegraph → segments → executeActionSequence（F2/F3 同源）；execute 经
 *      `createInboxActExecutor` 走宿主 aiInbox 的 l2d_act 既有下发链路（不另开一套），
 *      回执形状与 MCP shapeActReceipt 一致，保证 run 通道与 /ai/call 语义不分叉。
 *
 * 设计约束：
 *   - 复用 F2 校验器（choreography.validateStep / action-sequence.validateActionSequence），
 *     不另造步校验，保证「导入即可跑」与 MCP /ai/call 同一语义。
 *   - 原子写仿 env-state.mjs（tmp + rename），失败不留半文件；重名覆盖前先整体校验，
 *     校验失败绝不触碰原文件。
 *   - 编译语义（确定性，测试固化）：分支按 next 数组顺序深度优先线性化，共享后继只编译一次；
 *     delay 节点不产生 step，其 delayMs 累加并入线性化中下一个动作节点的 delayMs，
 *     末端无载体时丢弃。分段：每 8 步一段，步优先级变化也起新段（节点可选 priority，
 *     缺省/非法回 NORMAL，旧图行为不变）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { POSE_VALUES } from './choreography.mjs';
import {
  validateActionSequence,
  executeActionSequence,
  MAX_SEGMENTS,
  MAX_STEPS_PER_SEGMENT,
} from '../../dsh-l2d-mcp/src/action-sequence.mjs';
import { actSettled, mergeActEvents, shapeActReceipt } from '../../dsh-l2d-mcp/src/act-result.mjs';

export const NODEGRAPH_SCHEMA_VERSION = 1;
export const NODEGRAPH_KIND = 'dsh-l2d-nodegraph';
/** F1 四类动作步 + 纯延时节点（§2：编译为并入 delayMs）。 */
export const NODE_TYPES = Object.freeze(['expression', 'motion', 'pose', 'look', 'delay']);
/** 节点级可选执行优先级（与编辑器 Capability.priorities / ACT_PRIORITIES 同一取值域，缺省 NORMAL）。 */
export const NODE_PRIORITIES = Object.freeze(['BACKGROUND', 'NORMAL', 'FORCE']);
export const MOTION_MODES = Object.freeze(['nodegraph', 'llm']);
export const MOTION_MODE_FILE_NAME = 'l2d-motion-mode.json';
export const NODEGRAPH_DIR_NAME = 'l2d-nodegraphs';
/** 图规模上限：120 动作节点恰好对应 15 段 × 8 步的编译上限，同时防恶意大图递归。 */
export const MAX_GRAPH_NODES = MAX_SEGMENTS * MAX_STEPS_PER_SEGMENT;

function isPlain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** $DSH_HOME 解析（F5 同源：显式 homeDir > 环境变量 > ~/.dsh）。 */
export function resolveDshHome(homeDir) {
  return homeDir || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

export function motionModePath(homeDir) {
  return path.join(resolveDshHome(homeDir), MOTION_MODE_FILE_NAME);
}

export function nodegraphsDir(homeDir) {
  return path.join(resolveDshHome(homeDir), NODEGRAPH_DIR_NAME);
}

function atomicWriteJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  const body = JSON.stringify(data, null, 2) + '\n';
  try {
    fs.writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 模式互斥状态文件（SPEC §3）：{ mode, updatedAt }，白名单字段，无过期。
// ---------------------------------------------------------------------------

/**
 * 读取动作模式。文件缺失 / 损坏 / 字段非法一律回 'llm'（现状兼容，绝不抛）。
 * @param {{homeDir?: string}} [options]
 * @returns {{available: boolean, mode: 'nodegraph'|'llm', updatedAt: string|null, file: string, reason?: string}}
 */
export function readMotionMode(options = {}) {
  const file = motionModePath(options.homeDir);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return {
      available: false,
      mode: 'llm',
      updatedAt: null,
      file,
      reason: err && err.code === 'ENOENT' ? 'missing' : 'unreadable',
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { available: false, mode: 'llm', updatedAt: null, file, reason: 'invalid-json' };
  }
  const mode = parsed && parsed.mode;
  if (!MOTION_MODES.includes(mode)) {
    return { available: false, mode: 'llm', updatedAt: null, file, reason: 'invalid-mode' };
  }
  return {
    available: true,
    mode,
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
    file,
  };
}

/**
 * 写入动作模式（整份覆盖，带 updatedAt）。mode 非法时抛错，由调用方转 400。
 * @param {'nodegraph'|'llm'} mode
 * @param {{homeDir?: string, now?: number}} [options]
 */
export function writeMotionMode(mode, options = {}) {
  if (!MOTION_MODES.includes(mode)) {
    throw new Error("mode 必须是 'nodegraph' 或 'llm'，收到：" + String(mode).slice(0, 24));
  }
  const now = Number(options.now) || Date.now();
  const state = { mode, updatedAt: new Date(now).toISOString() };
  atomicWriteJson(motionModePath(options.homeDir), state);
  return state;
}

// ---------------------------------------------------------------------------
// 文件名安全化：去路径分隔符与 Windows 非法字符，防目录逃逸。
// ---------------------------------------------------------------------------

/**
 * @param {string} name
 * @returns {string} 安全文件名（不含 .json 后缀）；清洗后为空则抛错。
 */
export function sanitizeFileName(name) {
  const cleaned = String(name == null ? '' : name)
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .trim();
  if (!cleaned) throw new Error('name 清洗后为空，不能作为文件名');
  return cleaned.slice(0, 64);
}

// ---------------------------------------------------------------------------
// 图结构校验（§2：DAG、roots 可达全部节点、next 引用存在、type 白名单）
// ---------------------------------------------------------------------------

const NODE_ALLOWED_KEYS = Object.freeze([
  'id', 'type', 'name', 'clear', 'closeMotion', 'closeAfterMs', 'delayMs', 'pose', 'x', 'y', 'next',
  'priority',
]);

/**
 * @returns {{errors: string[]}} 结构错误清单（空数组 = 结构合法）
 */
function validateGraph(graph) {
  const errors = [];
  if (!isPlain(graph)) return ['graph 必须是对象'];
  const roots = graph.roots;
  const nodes = graph.nodes;
  if (!Array.isArray(roots) || roots.length === 0) errors.push('graph.roots 不能为空');
  if (!Array.isArray(nodes) || nodes.length === 0) {
    errors.push('graph.nodes 不能为空');
    return errors;
  }
  if (nodes.length > MAX_GRAPH_NODES) {
    errors.push(`graph.nodes 最多 ${MAX_GRAPH_NODES} 个（对应 ${MAX_SEGMENTS} 段 × ${MAX_STEPS_PER_SEGMENT} 步）`);
  }
  for (const key of Object.keys(graph)) {
    if (key !== 'roots' && key !== 'nodes') errors.push('graph 未知字段 ' + key);
  }

  const byId = new Map();
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const at = `graph.nodes[${i}]`;
    if (!isPlain(node)) {
      errors.push(at + ' 必须是对象');
      continue;
    }
    if (typeof node.id !== 'string' || !node.id) {
      errors.push(at + '.id 必须是非空字符串');
      continue;
    }
    if (byId.has(node.id)) {
      errors.push(at + ' id 重复：' + node.id);
      continue;
    }
    if (!NODE_TYPES.includes(node.type)) {
      errors.push(at + ' type 不受支持：' + String(node.type));
      continue;
    }
    for (const key of Object.keys(node)) {
      if (!NODE_ALLOWED_KEYS.includes(key)) errors.push(at + ' 未知字段 ' + key);
    }
    if (node.type === 'expression' && (typeof node.name !== 'string' || !node.name)) {
      errors.push(at + ' expression 缺 name');
    }
    if (node.type === 'motion' && (typeof node.name !== 'string' || !node.name)) {
      errors.push(at + ' motion 缺 name');
    }
    if (node.type === 'pose') {
      if (!isPlain(node.pose) || (node.pose.right === undefined && node.pose.left === undefined)) {
        errors.push(at + ' pose 需要 {right/left} 至少一侧');
      } else {
        for (const side of ['right', 'left']) {
          if (node.pose[side] !== undefined && !POSE_VALUES.includes(node.pose[side])) {
            errors.push(at + ' pose.' + side + ' 非法：' + String(node.pose[side]));
          }
        }
      }
    }
    if (node.type === 'look' && (!Number.isFinite(Number(node.x)) || !Number.isFinite(Number(node.y)))) {
      errors.push(at + ' look 需要 x/y 数字');
    }
    if (node.type === 'delay') {
      const d = Number(node.delayMs);
      if (!Number.isFinite(d) || d <= 0 || d > 5000) {
        errors.push(at + ' delay 需要 0 < delayMs <= 5000');
      }
    } else if (node.delayMs !== undefined) {
      const d = Number(node.delayMs);
      if (!Number.isFinite(d) || d < 0 || d > 5000) {
        errors.push(at + ' delayMs 必须是 0~5000 的数字');
      }
    }
    if (node.priority !== undefined && !NODE_PRIORITIES.includes(node.priority)) {
      errors.push(
        at + ' priority 非法：' + String(node.priority) + '（可选 ' + NODE_PRIORITIES.join('/') + '，缺省 NORMAL）'
      );
    }
    if (node.next !== undefined && !Array.isArray(node.next)) {
      errors.push(at + '.next 必须是数组');
    }
    byId.set(node.id, node);
  }
  if (errors.length) return errors;

  // 悬空 next / roots 引用
  for (const node of byId.values()) {
    for (const target of Array.isArray(node.next) ? node.next : []) {
      if (!byId.has(target)) errors.push(`节点 ${node.id} 的 next 引用不存在：${target}`);
    }
  }
  for (const root of roots) {
    if (!byId.has(root)) errors.push('roots 引用不存在：' + root);
  }
  if (errors.length) return errors;

  // 环检测（三色 DFS；节点数已限 ≤120，递归深度安全）
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map();
  for (const id of byId.keys()) color.set(id, WHITE);
  let cyclic = false;
  const dfs = (id) => {
    if (cyclic) return;
    color.set(id, GRAY);
    for (const target of Array.isArray(byId.get(id).next) ? byId.get(id).next : []) {
      const c = color.get(target);
      if (c === GRAY) {
        cyclic = true;
        errors.push(`graph 存在环：${id} → ${target}`);
        return;
      }
      if (c === WHITE) dfs(target);
      if (cyclic) return;
    }
    color.set(id, BLACK);
  };
  for (const id of byId.keys()) {
    if (color.get(id) === WHITE) dfs(id);
    if (cyclic) break;
  }
  if (cyclic) return errors;

  // roots 可达全部节点（BFS）
  const reach = new Set();
  const queue = [];
  for (const root of roots) {
    if (byId.has(root) && !reach.has(root)) {
      reach.add(root);
      queue.push(root);
    }
  }
  while (queue.length) {
    const current = queue.shift();
    for (const target of Array.isArray(byId.get(current).next) ? byId.get(current).next : []) {
      if (byId.has(target) && !reach.has(target)) {
        reach.add(target);
        queue.push(target);
      }
    }
  }
  for (const id of byId.keys()) {
    if (!reach.has(id)) errors.push('节点不可从 roots 到达：' + id);
  }
  return errors;
}

// ---------------------------------------------------------------------------
// graph → segments 编译器（确定性线性化，语义见文件头）
// ---------------------------------------------------------------------------

/**
 * @param {object} graph 已通过结构校验的节点图
 * @returns {{ok: boolean, errors: string[], segments: Array, steps: Array}}
 */
export function compileGraphToSegments(graph) {
  const g = isPlain(graph) ? graph : {};
  const roots = Array.isArray(g.roots) ? g.roots : [];
  const nodes = Array.isArray(g.nodes) ? g.nodes : [];
  const byId = new Map();
  for (const node of nodes) {
    if (isPlain(node) && typeof node.id === 'string' && node.id && !byId.has(node.id)) {
      byId.set(node.id, node);
    }
  }
  const order = [];
  const seen = new Set();
  const visit = (id) => {
    if (seen.has(id) || !byId.has(id)) return;
    seen.add(id);
    order.push(id);
    const node = byId.get(id);
    for (const target of Array.isArray(node.next) ? node.next : []) visit(target);
  };
  for (const root of roots) visit(root);

  let pendingDelay = 0;
  const steps = [];
  const stepPriorities = [];
  for (const id of order) {
    const node = byId.get(id);
    if (!node || node.type === 'delay') {
      pendingDelay += Number(node && node.delayMs) || 0;
      continue;
    }
    const step = { kind: node.type };
    if (node.type === 'expression') {
      step.name = node.name;
      if (node.clear === true) step.clear = true;
    } else if (node.type === 'motion') {
      step.name = node.name;
      if (typeof node.closeMotion === 'string' && node.closeMotion) {
        step.closeMotion = node.closeMotion;
        if (node.closeAfterMs !== undefined) step.closeAfterMs = node.closeAfterMs;
      }
    } else if (node.type === 'pose') {
      step.pose = {};
      if (node.pose && node.pose.right !== undefined) step.pose.right = node.pose.right;
      if (node.pose && node.pose.left !== undefined) step.pose.left = node.pose.left;
    } else if (node.type === 'look') {
      step.x = Number(node.x);
      step.y = Number(node.y);
    }
    const delay = (Number(node.delayMs) || 0) + pendingDelay;
    if (delay > 0) step.delayMs = Math.round(delay);
    pendingDelay = 0;
    steps.push(step);
    // 节点级可选优先级：取值域白名单校验（与编辑器语义一致），非法/缺省回 NORMAL。
    // 无 priority 字段的旧图全部落 NORMAL，分段结果与改动前完全一致。
    stepPriorities.push(NODE_PRIORITIES.includes(node.priority) ? node.priority : 'NORMAL');
  }
  // 末端遗留的累计延时无动作节点可并入：按「并入 delayMs」语义丢弃。
  if (steps.length === 0) {
    return { ok: false, errors: ['图没有可编译的动作节点'], segments: [], steps: [] };
  }
  // 每 8 步一段；步优先级变化也起新段（与编辑器 Compiler 分段语义一致）。
  // 全 NORMAL（旧图缺省）时退化为纯 8 步切分，与改动前行为完全一致。
  const segments = [];
  let cur = null;
  for (let i = 0; i < steps.length; i++) {
    const pr = stepPriorities[i] || 'NORMAL';
    if (!cur || cur.priority !== pr || cur.chain.length >= MAX_STEPS_PER_SEGMENT) {
      cur = { priority: pr, chain: [] };
      segments.push(cur);
    }
    cur.chain.push(steps[i]);
  }
  if (segments.length > MAX_SEGMENTS) {
    return {
      ok: false,
      errors: [`编译后需要 ${segments.length} 段，超过上限 ${MAX_SEGMENTS} 段`],
      segments: [],
      steps,
    };
  }
  return { ok: true, errors: [], segments, steps };
}

/**
 * segments → graph 回算（线性视图）：与 segments 严格同构，graph 仅作视图书写层。
 * @param {Array} segments
 * @returns {{roots: string[], nodes: Array}}
 */
export function segmentsToGraph(segments) {
  const steps = [];
  for (const segment of Array.isArray(segments) ? segments : []) {
    if (isPlain(segment) && Array.isArray(segment.chain)) steps.push(...segment.chain);
  }
  const nodes = steps.map((step, index) => {
    const id = 's' + (index + 1);
    const node = { id, type: step.kind };
    if (step.kind === 'expression') {
      node.name = step.name;
      if (step.clear === true) node.clear = true;
    } else if (step.kind === 'motion') {
      node.name = step.name;
      if (step.closeMotion) node.closeMotion = step.closeMotion;
      if (step.closeAfterMs !== undefined) node.closeAfterMs = step.closeAfterMs;
    } else if (step.kind === 'pose') {
      node.pose = { ...(step.pose || {}) };
    } else if (step.kind === 'look') {
      node.x = step.x;
      node.y = step.y;
    }
    if (step.delayMs !== undefined) node.delayMs = step.delayMs;
    return node;
  });
  nodes.forEach((node, index) => {
    node.next = index + 1 < nodes.length ? [nodes[index + 1].id] : [];
  });
  return { roots: nodes.length ? [nodes[0].id] : [], nodes };
}

// ---------------------------------------------------------------------------
// 分享 JSON 整体校验 + 归一化（§2：单一执行真源是 segments）
// ---------------------------------------------------------------------------

/**
 * @param {object} doc 分享 JSON 解析结果
 * @param {{allowed?: {expressions?: Set<string>, motionGroups?: Set<string>}|null}} [options]
 *   allowed：按图绑定模型注入的动态白名单（静态 ∪ 该模型 live2d-ids.json）；缺省 null 用纯静态名单
 *   （旧行为，旧图不受影响）。
 * @returns {{ok: boolean, errors: string[], normalized: object|null}}
 */
export function validateNodegraph(doc, options = {}) {
  const allowed = options.allowed || null;
  if (!isPlain(doc)) return { ok: false, errors: ['分享 JSON 必须是对象'], normalized: null };
  const errors = [];
  // §2 唯一格式：顶层只接受这七个字段（与 validateActionSequence 的严格风格一致），
  // 防止任意 JSON 借导入通道入库；扩展需走 schemaVersion 升版。
  for (const key of Object.keys(doc)) {
    if (!['schemaVersion', 'kind', 'name', 'modelBinding', 'graph', 'segments', 'meta'].includes(key)) {
      errors.push('未知顶层字段 ' + key);
    }
  }
  if (doc.schemaVersion !== NODEGRAPH_SCHEMA_VERSION) {
    errors.push('schemaVersion 必须是 ' + NODEGRAPH_SCHEMA_VERSION + '，收到：' + String(doc.schemaVersion));
  }
  if (doc.kind !== NODEGRAPH_KIND) {
    errors.push('kind 必须是 ' + NODEGRAPH_KIND + '，收到：' + String(doc.kind));
  }
  if (typeof doc.name !== 'string' || !doc.name.trim()) errors.push('name 必须是非空字符串');

  const binding = isPlain(doc.modelBinding) ? doc.modelBinding : {};
  for (const key of Object.keys(binding)) {
    if (!['modelId', 'modelHash', 'bindingMode'].includes(key)) errors.push('modelBinding 未知字段 ' + key);
  }
  const bindingMode = binding.bindingMode === undefined ? 'any' : binding.bindingMode;
  if (!['strict', 'any'].includes(bindingMode)) {
    errors.push('modelBinding.bindingMode 必须是 strict 或 any，收到：' + String(bindingMode));
  }
  const modelId = typeof binding.modelId === 'string' ? binding.modelId : '';
  const modelHash = typeof binding.modelHash === 'string' ? binding.modelHash : '';
  if (bindingMode === 'strict' && !modelId && !modelHash) {
    errors.push('bindingMode=strict 需要至少提供 modelId 或 modelHash');
  }

  const hasGraph = doc.graph !== undefined;
  const hasSegments = doc.segments !== undefined;
  if (!hasGraph && !hasSegments) errors.push('graph 与 segments 至少提供一个');

  let graph = null;
  let segments = null;
  if (hasGraph) {
    const graphErrors = validateGraph(doc.graph);
    if (graphErrors.length) errors.push(...graphErrors);
    else graph = doc.graph;
  }
  if (hasSegments) {
    const checked = validateActionSequence({ segments: doc.segments }, allowed);
    if (!checked.ok) errors.push(...checked.errors);
    else segments = doc.segments;
  }
  if (errors.length) return { ok: false, errors, normalized: null };

  let normalizedSegments;
  let normalizedGraph;
  if (segments) {
    // 两者都在 / 只有 segments：以 segments 为准，graph 回算为线性视图（§2）。
    normalizedSegments = segments;
    normalizedGraph = segmentsToGraph(segments);
  } else {
    // 只有 graph：编译出 segments，并复用 F2 校验器把关（表情/动作组白名单、时长上限）。
    const compiled = compileGraphToSegments(graph);
    if (!compiled.ok) return { ok: false, errors: compiled.errors, normalized: null };
    const checked = validateActionSequence({ segments: compiled.segments }, allowed);
    if (!checked.ok) return { ok: false, errors: checked.errors, normalized: null };
    normalizedSegments = compiled.segments;
    normalizedGraph = graph;
  }

  const normalized = {
    schemaVersion: NODEGRAPH_SCHEMA_VERSION,
    kind: NODEGRAPH_KIND,
    name: doc.name.trim(),
    modelBinding: { modelId, modelHash, bindingMode },
    graph: normalizedGraph,
    segments: normalizedSegments,
    meta: isPlain(doc.meta) ? doc.meta : {},
  };
  return { ok: true, errors: [], normalized };
}

// ---------------------------------------------------------------------------
// 分享图存取：$DSH_HOME/l2d-nodegraphs/<name>.json
// ---------------------------------------------------------------------------

/**
 * 保存（导入）。先整体校验，成功才原子写盘；失败时原文件一个字节都不动。
 * @returns {{ok: true, name: string, file: string} | {ok: false, errors: string[]}}
 */
export function saveNodegraph(doc, options = {}) {
  const checked = validateNodegraph(doc, { allowed: options.allowed || null });
  if (!checked.ok) return { ok: false, errors: checked.errors };
  let fileName;
  try {
    fileName = sanitizeFileName(checked.normalized.name) + '.json';
  } catch (err) {
    return { ok: false, errors: [String((err && err.message) || err)] };
  }
  const file = path.join(nodegraphsDir(options.homeDir), fileName);
  atomicWriteJson(file, checked.normalized);
  return { ok: true, name: checked.normalized.name, file };
}

/**
 * 列出已导入节点图。目录不存在 → 空列表；单个文件损坏 → valid:false 不抛。
 * @returns {{ok: true, items: Array<{name: string, modelId: string, bindingMode: string, valid: boolean}>}}
 */
export function listNodegraphs(options = {}) {
  const dir = nodegraphsDir(options.homeDir);
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: true, items: [] };
    throw err;
  }
  const items = [];
  for (const file of files) {
    const fallbackName = file.slice(0, -'.json'.length);
    let item = { name: fallbackName, modelId: '', bindingMode: '', valid: false };
    try {
      const doc = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      const checked = validateNodegraph(doc);
      item = {
        name: checked.ok
          ? checked.normalized.name
          : typeof (doc && doc.name) === 'string' && doc.name.trim() ? doc.name.trim() : fallbackName,
        modelId: isPlain(doc && doc.modelBinding) && typeof doc.modelBinding.modelId === 'string'
          ? doc.modelBinding.modelId
          : '',
        bindingMode: isPlain(doc && doc.modelBinding) && ['strict', 'any'].includes(doc.modelBinding.bindingMode)
          ? doc.modelBinding.bindingMode
          : '',
        valid: checked.ok,
      };
    } catch {
      /* 保持 invalid 条目，不抛 */
    }
    items.push(item);
  }
  return { ok: true, items };
}

/**
 * 读回分享 JSON 原文（export 用）。不存在 / name 非法 → null。
 * @returns {string|null}
 */
export function loadNodegraph(name, options = {}) {
  let fileName;
  try {
    fileName = sanitizeFileName(name) + '.json';
  } catch {
    return null;
  }
  try {
    return fs.readFileSync(path.join(nodegraphsDir(options.homeDir), fileName), 'utf8');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 模型绑定裁决（按单个模型编辑动作链，2026-11-10 统一约定）
// ---------------------------------------------------------------------------

/**
 * 裁决一份 modelBinding 与当前模型是否匹配（纯函数，不发动作、不碰注册表）。
 *
 * 规则：
 *   - bindingMode 缺省 'any'（旧图现状兼容）；
 *   - strict 且绑定 modelId 与当前模型不同 → {ok:false, reason:'model-mismatch', expected, actual}；
 *   - strict 只填 modelHash（无 modelId）→ 无法比对，放行（与导入校验「二选一」一致）；
 *   - any 且填了 modelId 且与当前不同 → 放行但带 warning（结果回传给调用方）；
 *   - 当前模型未知（currentModelId 为空）→ 不比对，放行（与 strict 导入校验同风格）。
 *
 * @param {object|null} binding doc.modelBinding
 * @param {string} currentModelId 当前模型（模型文件名去 .model3.json）
 * @returns {{ok:true, bindingMode:'strict'|'any', modelId:string, warning?:'model-mismatch', expected?:string, actual?:string}
 *           |{ok:false, status:409, reason:'model-mismatch', bindingMode:'strict', modelId:string, expected:string, actual:string}}
 */
export function evaluateModelBinding(binding, currentModelId) {
  const b = isPlain(binding) ? binding : {};
  const bindingMode = b.bindingMode === 'strict' ? 'strict' : 'any';
  const modelId = typeof b.modelId === 'string' ? b.modelId : '';
  const current = typeof currentModelId === 'string' ? currentModelId : '';
  if (bindingMode === 'strict' && modelId && current && modelId !== current) {
    return { ok: false, status: 409, reason: 'model-mismatch', bindingMode, modelId, expected: modelId, actual: current };
  }
  if (bindingMode === 'any' && modelId && current && modelId !== current) {
    return { ok: true, bindingMode, modelId, warning: 'model-mismatch', expected: modelId, actual: current };
  }
  return { ok: true, bindingMode, modelId };
}

/**
 * run 通道的绑定闸门（路由层在 nodegraphRunRegistry.begin **之前**调用）：
 * 读已导入图的 modelBinding 并裁决。strict 不匹配 → 409 model-mismatch，一个动作都不发、
 * 不进注册表；图缺失/损坏 → 放行（后续 runNodegraph 按既有语义报 404/500，这里不抢职责）。
 *
 * @param {string} name 节点图名
 * @param {{homeDir?: string, currentModelId?: string}} [options]
 * @returns {{ok:true, bindingMode:string, modelId:string, warning?:string, expected?:string, actual?:string}
 *           |{ok:false, status:number, reason:string, expected:string, actual:string}}
 */
export function checkRunModelBinding(name, options = {}) {
  const currentModelId = typeof options.currentModelId === 'string' ? options.currentModelId : '';
  const raw = loadNodegraph(name, { homeDir: options.homeDir });
  if (raw === null) return { ok: true, bindingMode: 'any', modelId: '' };
  let doc = null;
  try {
    doc = JSON.parse(raw);
  } catch {
    return { ok: true, bindingMode: 'any', modelId: '' };
  }
  const verdict = evaluateModelBinding(doc && doc.modelBinding, currentModelId);
  return verdict;
}

// ---------------------------------------------------------------------------
// 执行入口（SPEC §4 第 4 行，NG-RUN，2026-11-08 14:50 定案）
// ---------------------------------------------------------------------------

const executorSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * l2d_act 进程内下发执行器（forward.mjs mode='act' 的宿主内等价物）。
 *
 * 复用宿主 aiInbox 的 l2d_act 既有下发链路（/ai/call 处理器同一入口函数，禁止另开一套）：
 * call('l2d_act', {chain, priority, bubble?}) 入队 → read(id) 轮回执 → accepted 时再等
 * action-done 的 end / interrupted 终态事件，最后 shapeActReceipt 成 MCP 同一形状。
 * 不经过 guardAiCall：互斥门禁只管 /ai/call 的 LLM 入口，不拦节点通道自身。
 *
 * 超时语义照抄 forward.mjs：accepted 但终态未知 → 回执保留 pending 语义并附 id，
 * 不误报成功；已入队但无回执 → {ok:false, reason:'timeout', id}。
 *
 * @param {{ call: (name: string, args: object) => object, read: (id: number) => object }} transport
 *   宿主 aiInbox（或等价物），注入以便单测与 dev-server / 插件宿主共用一份实现。
 */
export function createInboxActExecutor(transport, options = {}) {
  if (!transport || typeof transport.call !== 'function' || typeof transport.read !== 'function') {
    throw new Error('createInboxActExecutor: transport 必须提供 call 与 read');
  }
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || 12000);
  const pollIntervalMs = Math.max(1, Number(options.pollIntervalMs) || 120);
  const wait = options.sleep || executorSleep;
  const now = options.now || Date.now;

  return async function execute(input) {
    let queued;
    try {
      queued = transport.call('l2d_act', input);
    } catch (err) {
      queued = { ok: false, reason: String((err && err.message) || err) };
    }
    if (!queued || queued.ok !== true || !queued.id) {
      return {
        ok: false, accepted: false,
        reason: (queued && queued.reason) || 'enqueue-failed',
        outcome: 'rejected', settled: false, events: [],
      };
    }
    const deadline = now() + timeoutMs;
    let acceptResult = null;
    let events = [];
    while (true) {
      let readBack = null;
      try {
        readBack = transport.read(queued.id);
      } catch {
        readBack = null;
      }
      if (readBack) {
        if (Array.isArray(readBack.events)) events = mergeActEvents(events, readBack.events);
        if (readBack.ready) {
          acceptResult = readBack.result && typeof readBack.result === 'object'
            ? readBack.result
            : { ok: false, reason: 'empty' };
          if (Array.isArray(acceptResult.events)) events = mergeActEvents(events, acceptResult.events);
          // 未受理直接回；已受理则等 end / interrupted 终态事件再回
          if (acceptResult.accepted !== true || actSettled(events, acceptResult.runId)) {
            return shapeActReceipt(acceptResult, events);
          }
        }
      }
      const remaining = deadline - now();
      if (remaining <= 0) break;
      await wait(Math.min(pollIntervalMs, remaining));
    }
    if (acceptResult && acceptResult.accepted === true) {
      // accepted 但终态未知：pending 语义 + 保留 id 供后续查询，不误报完成
      return { ...shapeActReceipt(acceptResult, events), id: queued.id };
    }
    return { ok: false, reason: 'timeout', id: queued.id, events };
  };
}

/**
 * 执行已导入的节点图（同步定案部分 + 异步执行部分统一在一个返回值里）。
 *
 * 返回形状：
 *  - mode !== 'nodegraph'：{ ok:false, status:409, reason:'mode-blocked', message }（互斥另一半，
 *    与 guardAiCall 的 mode-blocked 对称；纯 LLM 模式下节点图不执行）
 *  - name 不存在 / 坏文件 / 无 segments：{ ok:false, status:404|500|422, reason, errors }
 *  - 正常执行：executeActionSequence 原样返回（{ok, status:'completed'|'stopped'|'rejected',
 *    receipts, completedSegments, remainingSegments, replanRequired}），另附 name。
 * 路由层约定：result.ok===false 且 result.status 为数字 → 该数字即 HTTP 状态码；否则 200。
 *
 * @param {string} name 节点图名（导入时的原始 name，内部做文件名安全化）
 * @param {(input: {chain: object[], priority: string, bubble?: string}) => Promise<object>} execute
 *   单批动作下发回调；宿主传 createInboxActExecutor 产物，单测注入假回调。
 * @param {{homeDir?: string, currentModelId?: string, sequence?: object}} [options]
 *   currentModelId：当前模型 ID（模型文件名去 .model3.json）；strict 绑定不一致 → 409 model-mismatch，
 *   any 绑定不一致 → 结果附 warning。缺省不比对（现状兼容）。
 */
export async function runNodegraph(name, execute, options = {}) {
  if (typeof execute !== 'function') {
    return { ok: false, status: 500, reason: 'no-executor', errors: ['runNodegraph: execute 回调缺失'] };
  }
  const homeDir = options.homeDir;
  const mode = readMotionMode({ homeDir }).mode;
  // Phase 3 双模式收敛：默认仍按全局模式闸门（旧行为）；但当调用方是**已发布动作程序**
  // 的派发路径时，程序本身就是权威，不再要求用户先切到节点图模式。
  // 只对显式传入 requireNodegraphMode === false 的调用方放行，普通 /nodegraphs/run 不受影响。
  if (mode !== 'nodegraph' && options.requireNodegraphMode !== false) {
    return {
      ok: false,
      status: 409,
      reason: 'mode-blocked',
      message: '纯 LLM 模式下节点图不执行，请先切换到节点图模式；导入新图后需在设置页切换动作模式',
    };
  }
  const raw = loadNodegraph(name, { homeDir });
  if (raw === null) {
    return { ok: false, status: 404, reason: 'nodegraph-not-found', errors: ['nodegraph not found: ' + name] };
  }
  let doc = null;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    return { ok: false, status: 500, reason: 'nodegraph-corrupt', errors: [String((err && err.message) || err)] };
  }
  if (!doc || !Array.isArray(doc.segments) || doc.segments.length === 0) {
    return { ok: false, status: 422, reason: 'no-segments', errors: ['nodegraph 无可执行 segments：' + name] };
  }
  // 绑定裁决（纵深防御第二道闸；路由层已在 registry.begin 前拦过一次）：
  // strict 不匹配 → 409 model-mismatch，execute 一次都不调（一个动作都不发）；
  // any 模式照旧执行，绑定模型与当前模型不一致时结果附 warning 字段。
  const currentModelId = typeof options.currentModelId === 'string' ? options.currentModelId : '';
  const verdict = evaluateModelBinding(doc.modelBinding, currentModelId);
  if (!verdict.ok) {
    return {
      ok: false,
      status: 409,
      reason: 'model-mismatch',
      expected: verdict.expected,
      actual: verdict.actual,
      message: `节点图 strict 绑定模型 ${verdict.expected}，当前模型 ${verdict.actual}，未执行任何动作`,
    };
  }
  const result = await executeActionSequence(
    { segments: doc.segments },
    execute,
    options.sequence || {},
  );
  if (verdict.warning) {
    result.warning = { reason: 'model-mismatch', expected: verdict.expected, actual: verdict.actual };
  }
  return { ...result, name };
}
