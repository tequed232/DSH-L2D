/**
 * 节点图确定性编辑（AI 节点编辑后端核心，纯函数）。
 *
 * 作用对象是「设计层节点图」（与编辑器 meta.editor / Graph.snapshot() 同形）：
 *   { nodes: [{ id, type, label, pos:{x,y}, props, disabled }], edges: [{ id, from, to }], viewport? }
 *
 * 对外：
 *   - applyOps(graph, ops, options) → { graph, valid, applied, errors }
 *       不修改入参；任一 op 失败时（默认 atomic）整批不生效，graph 原样（深拷贝）返回；
 *       options.mode='skip' 时跳过失败 op 继续（ai-edit 预演用），errors 仍逐条记录。
 *       全部 op 成功后，编译成执行图并用 nodegraph.mjs 的 validateNodegraph 整体校验，
 *       不合法时 valid=false、errors 带 reason='graph-invalid'（图仍返回，便于前端展示）。
 *       出错一律不抛，errors 形如 { opIndex, op, reason, message }，reason 为英文 code。
 *   - graphHash(graph)：nodes + edges 稳定序列化后 sha256 前 16 位（viewport 不参与）。
 *   - compileEditorGraph(graph)：设计层 → 执行层 graph（与编辑器 Compiler.compile 同语义）。
 *   - editorGraphFromDoc(doc) / docFromEditorGraph(graph, baseDoc)：分享 JSON 与设计层互转。
 */
import { createHash } from 'node:crypto';
import { NODEGRAPH_KIND, NODEGRAPH_SCHEMA_VERSION, validateNodegraph } from './nodegraph.mjs';
import {
  MAX_ABS_POS,
  MAX_EDITOR_NODES,
  MAX_OPS_PER_CALL,
  NODE_ID_RE,
  NODE_TYPE_DEFS,
  OP_DEFS,
  checkLive2dRef,
  defaultProps,
  pairedCloseFor,
  paramDefsFor,
} from './nodegraph-schema.mjs';

function isPlain(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deep(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

/** 稳定序列化：对象键按字典序，数组保持顺序。 */
export function stableStringify(value) {
  if (Array.isArray(value)) return '[' + value.map((v) => stableStringify(v === undefined ? null : v)).join(',') + ']';
  if (isPlain(value)) {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
  }
  return JSON.stringify(value === undefined ? null : value);
}

/** 图哈希：只覆盖 nodes 与 edges（画布平移缩放不应让 AI 提案过期）。 */
export function graphHash(graph) {
  const g = isPlain(graph) ? graph : {};
  const body = stableStringify({
    nodes: Array.isArray(g.nodes) ? g.nodes : [],
    edges: Array.isArray(g.edges) ? g.edges : [],
  });
  return createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// 输入图结构检查（不合法 → invalid-graph，不应用任何 op）
// ---------------------------------------------------------------------------

function checkInputGraph(graph) {
  const errors = [];
  if (!isPlain(graph)) return ['graph 必须是对象 {nodes, edges}'];
  if (!Array.isArray(graph.nodes)) errors.push('graph.nodes 必须是数组');
  if (graph.edges !== undefined && !Array.isArray(graph.edges)) errors.push('graph.edges 必须是数组');
  if (errors.length) return errors;
  if (graph.nodes.length > MAX_EDITOR_NODES) errors.push(`graph.nodes 最多 ${MAX_EDITOR_NODES} 个`);
  const ids = new Set();
  graph.nodes.forEach((n, i) => {
    if (!isPlain(n)) return errors.push(`graph.nodes[${i}] 必须是对象`);
    if (typeof n.id !== 'string' || !n.id) return errors.push(`graph.nodes[${i}].id 必须是非空字符串`);
    if (ids.has(n.id)) errors.push(`graph.nodes[${i}] id 重复：${n.id}`);
    ids.add(n.id);
    if (!NODE_TYPE_DEFS[n.type]) errors.push(`graph.nodes[${i}] 未知节点类型：${String(n.type)}`);
    if (n.props !== undefined && !isPlain(n.props)) errors.push(`graph.nodes[${i}].props 必须是对象`);
  });
  (graph.edges || []).forEach((e, i) => {
    if (!isPlain(e)) return errors.push(`graph.edges[${i}] 必须是对象`);
    if (!ids.has(e.from) || !ids.has(e.to)) errors.push(`graph.edges[${i}] 引用了不存在的节点：${String(e.from)} → ${String(e.to)}`);
  });
  return errors;
}

/** 深拷贝并补齐缺省字段（props 缺项按类型默认值补齐，不覆盖已有值）。 */
function normalizeGraph(graph) {
  const g = deep(graph);
  g.edges = Array.isArray(g.edges) ? g.edges : [];
  for (const n of g.nodes) {
    n.props = { ...defaultProps(n.type), ...(isPlain(n.props) ? n.props : {}) };
    if (!isPlain(n.pos)) n.pos = { x: 0, y: 0 };
    if (typeof n.label !== 'string') n.label = NODE_TYPE_DEFS[n.type].label;
    n.disabled = n.disabled === true || n.props.disabled === true;
  }
  return g;
}

// ---------------------------------------------------------------------------
// 参数校验
// ---------------------------------------------------------------------------

function fail(reason, message) {
  return { reason, message };
}

/**
 * 校验单个参数写入。返回 null 表示合法。
 * @param {object} def 参数定义
 * @param {*} value
 * @param {object|null} live2dIds
 * @param {{allowReadonly?: boolean}} [opts]
 */
function checkParamValue(def, value, live2dIds, opts = {}) {
  if (def.readonly && !opts.allowReadonly) return fail('param-readonly', `${def.key} 只读（由 ${def.derivedFrom} 自动推导）`);
  switch (def.kind) {
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return fail('param-type-mismatch', `${def.key} 必须是数字`);
      if (value < def.min || value > def.max) return fail('param-out-of-range', `${def.key} 须在 ${def.min}~${def.max}，收到 ${value}`);
      return null;
    }
    case 'boolean':
      return typeof value === 'boolean' ? null : fail('param-type-mismatch', `${def.key} 必须是布尔值`);
    case 'enum':
      if (typeof value !== 'string') return fail('param-type-mismatch', `${def.key} 必须是字符串`);
      return def.options.includes(value) ? null : fail('param-not-allowed', `${def.key} 可选 ${def.options.map((o) => JSON.stringify(o)).join('/')}，收到 ${JSON.stringify(value)}`);
    case 'string': {
      if (typeof value !== 'string') return fail('param-type-mismatch', `${def.key} 必须是字符串`);
      if (def.maxLength && value.length > def.maxLength) return fail('param-out-of-range', `${def.key} 最长 ${def.maxLength} 字`);
      if (def.live2d) {
        if (!value) return fail('param-type-mismatch', `${def.key} 不能为空`);
        if (Array.isArray(def.forbidden) && def.forbidden.includes(value)) {
          return fail('param-not-allowed', `${def.key} 不允许 ${value}（待机由引擎自播，不能手动播）`);
        }
        const bad = checkLive2dRef(live2dIds, def.live2d === 'params' ? 'params' : def.live2d, def.live2d === 'params' ? { id: value } : value);
        if (bad && bad.warning) {
          if (opts.warnings) opts.warnings.push({ reason: bad.reason, message: bad.message });
        } else if (bad) return bad;
      }
      return null;
    }
    default:
      return fail('unknown-param', `${def.key} 定义缺失`);
  }
}

function findParamDef(type, key) {
  const defs = paramDefsFor(type) || [];
  return defs.find((d) => d.key === key) || null;
}

/** 写参数（已校验）。处理 motion.name → closeMotion 联动、disabled 节点级同步。 */
function writeParam(node, key, value) {
  node.props[key] = value;
  if (key === 'disabled') node.disabled = value === true;
  if (node.type === 'motion' && key === 'name') node.props.closeMotion = pairedCloseFor(value);
}

// ---------------------------------------------------------------------------
// 图关系工具
// ---------------------------------------------------------------------------

function reaches(edges, start, target) {
  const adj = new Map();
  for (const e of edges) {
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from).push(e.to);
  }
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) {
    const cur = queue.shift();
    if (cur === target) return true;
    for (const nx of adj.get(cur) || []) {
      if (!seen.has(nx)) {
        seen.add(nx);
        queue.push(nx);
      }
    }
  }
  return false;
}

function nextId(existing, prefix) {
  let n = 1;
  while (existing.has(prefix + n)) n += 1;
  return prefix + n;
}

function requireFields(op, fields) {
  for (const f of fields) {
    if (op[f] === undefined || op[f] === null || op[f] === '') return fail('missing-field', `缺少字段 ${f}`);
  }
  return null;
}

// ---------------------------------------------------------------------------
// 单个 op 应用（就地修改工作副本 g；返回 null 表示成功，否则返回错误）
// ---------------------------------------------------------------------------

function applyOne(g, op, ctx) {
  if (!isPlain(op)) return fail('invalid-op', 'op 必须是对象');
  const kind = op.op;
  if (!Object.prototype.hasOwnProperty.call(OP_DEFS, kind)) return fail('unknown-op', `未知 op：${String(kind)}`);
  const missing = requireFields(op, OP_DEFS[kind].required);
  if (missing) return missing;
  const byId = new Map(g.nodes.map((n) => [n.id, n]));

  if (kind === 'add_node') {
    if (!NODE_TYPE_DEFS[op.type]) return fail('unknown-node-type', `未知节点类型：${String(op.type)}`);
    if (g.nodes.length >= MAX_EDITOR_NODES) return fail('too-many-nodes', `节点数已达上限 ${MAX_EDITOR_NODES}`);
    let id = op.id;
    if (id === undefined) id = nextId(new Set(byId.keys()), 'ai_');
    if (typeof id !== 'string' || !NODE_ID_RE.test(id)) return fail('invalid-node-id', `节点 id 须匹配 ${NODE_ID_RE.source}`);
    if (byId.has(id)) return fail('duplicate-node-id', `节点 id 已存在：${id}`);
    if (op.label !== undefined && (typeof op.label !== 'string' || op.label.length > 64)) {
      return fail('param-type-mismatch', 'label 必须是 ≤64 字的字符串');
    }
    let pos = { x: 0, y: 0 };
    if (op.pos !== undefined) {
      const bad = checkPos(op.pos && op.pos.x, op.pos && op.pos.y);
      if (bad) return bad;
      pos = { x: Math.round(op.pos.x), y: Math.round(op.pos.y) };
    }
    const node = { id, type: op.type, label: op.label || NODE_TYPE_DEFS[op.type].label, pos, props: defaultProps(op.type), disabled: false };
    if (op.props !== undefined) {
      if (!isPlain(op.props)) return fail('param-type-mismatch', 'props 必须是对象');
      for (const [key, value] of Object.entries(op.props)) {
        const def = findParamDef(op.type, key);
        if (!def) return fail('unknown-param', `${op.type} 没有参数 ${key}`);
        // add_node 允许显式写 closeMotion，但必须与推导值一致（否则视为只读冲突）
        if (def.readonly) {
          const derived = op.type === 'motion' ? pairedCloseFor(op.props.name !== undefined ? op.props.name : node.props.name) : value;
          if (value !== derived) return fail('param-readonly', `${key} 只读，须等于 ${JSON.stringify(derived)}`);
          continue;
        }
        const bad = checkParamValue(def, value, ctx.live2dIds, { warnings: ctx.pendingWarnings });
        if (bad) return bad;
      }
      for (const [key, value] of Object.entries(op.props)) {
        if (!findParamDef(op.type, key).readonly) writeParam(node, key, value);
      }
    }
    g.nodes.push(node);
    ctx.created.push(id);
    return null;
  }

  if (kind === 'remove_node') {
    if (!byId.has(op.id)) return fail('node-not-found', `节点不存在：${String(op.id)}`);
    g.nodes = g.nodes.filter((n) => n.id !== op.id);
    g.edges = g.edges.filter((e) => e.from !== op.id && e.to !== op.id);
    return null;
  }

  if (kind === 'set_param') {
    const node = byId.get(op.id);
    if (!node) return fail('node-not-found', `节点不存在：${String(op.id)}`);
    if (op.key === 'label') {
      if (typeof op.value !== 'string' || op.value.length > 64) return fail('param-type-mismatch', 'label 必须是 ≤64 字的字符串');
      node.label = op.value;
      return null;
    }
    const def = findParamDef(node.type, op.key);
    if (!def) return fail('unknown-param', `${node.type} 没有参数 ${String(op.key)}`);
    const bad = checkParamValue(def, op.value, ctx.live2dIds, { warnings: ctx.pendingWarnings });
    if (bad) return bad;
    writeParam(node, op.key, op.value);
    return null;
  }

  if (kind === 'connect') {
    const fromPort = op.fromPort === undefined ? 'out' : op.fromPort;
    const toPort = op.toPort === undefined ? 'in' : op.toPort;
    if (fromPort !== 'out') return fail('unknown-port', `源端口只能是 out，收到 ${String(fromPort)}`);
    if (toPort !== 'in') return fail('unknown-port', `目标端口只能是 in，收到 ${String(toPort)}`);
    const a = byId.get(op.from);
    const b = byId.get(op.to);
    if (!a) return fail('node-not-found', `节点不存在：${String(op.from)}`);
    if (!b) return fail('node-not-found', `节点不存在：${String(op.to)}`);
    if (op.from === op.to) return fail('self-loop', '不能把节点连到自己');
    if (a.props.portType !== b.props.portType) {
      return fail('port-type-mismatch', `端口类型不同（${a.props.portType} → ${b.props.portType}），同色才可连`);
    }
    if (g.edges.some((e) => e.from === op.from && e.to === op.to)) return fail('duplicate-edge', `连线已存在：${op.from} → ${op.to}`);
    const incoming = g.edges.filter((e) => e.to === op.to);
    if (incoming.length && op.replace !== true) {
      return fail('input-occupied', `${op.to} 的输入端口已有连线（来自 ${incoming.map((e) => e.from).join(',')}），替换请加 replace:true`);
    }
    const remaining = op.replace === true ? g.edges.filter((e) => e.to !== op.to) : g.edges;
    if (reaches(remaining, op.to, op.from)) return fail('cycle', `连线会成环：${op.from} → ${op.to}`);
    const edgeIds = new Set(g.edges.map((e) => e.id));
    g.edges = remaining;
    g.edges.push({ id: nextId(edgeIds, 'ai_e'), from: op.from, to: op.to });
    return null;
  }

  if (kind === 'disconnect') {
    let idx = -1;
    if (op.edgeId !== undefined) idx = g.edges.findIndex((e) => e.id === op.edgeId);
    else if (op.from !== undefined && op.to !== undefined) idx = g.edges.findIndex((e) => e.from === op.from && e.to === op.to);
    else return fail('missing-field', '需要 edgeId，或 from + to');
    if (idx < 0) return fail('edge-not-found', '连线不存在');
    g.edges.splice(idx, 1);
    return null;
  }

  if (kind === 'move_node') {
    const node = byId.get(op.id);
    if (!node) return fail('node-not-found', `节点不存在：${String(op.id)}`);
    const bad = checkPos(op.x, op.y);
    if (bad) return bad;
    node.pos = { x: Math.round(op.x), y: Math.round(op.y) };
    return null;
  }
  return fail('unknown-op', `未知 op：${String(kind)}`);
}

function checkPos(x, y) {
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
    return fail('invalid-position', 'x / y 必须是有限数字');
  }
  if (Math.abs(x) > MAX_ABS_POS || Math.abs(y) > MAX_ABS_POS) return fail('invalid-position', `x / y 绝对值须 ≤ ${MAX_ABS_POS}`);
  return null;
}

// ---------------------------------------------------------------------------
// 设计层 → 执行层编译（与编辑器 Compiler.compile / graphNode / downstream 同语义）
// ---------------------------------------------------------------------------

function execNode(n) {
  const p = n.props || {};
  const t = NODE_TYPE_DEFS[n.type].gtype;
  const o = { id: n.id, type: t };
  if (t === 'expression') {
    o.name = String(p.name == null ? '' : p.name);
    if (p.clear === true) o.clear = true;
  } else if (t === 'motion') {
    o.name = String(p.name == null ? '' : p.name);
    if (p.closeMotion) {
      o.closeMotion = String(p.closeMotion);
      if (p.closeAfterMs !== undefined && p.closeAfterMs !== '') o.closeAfterMs = Number(p.closeAfterMs);
    }
  } else if (t === 'pose') {
    o.pose = {};
    if (p.poseRight) o.pose.right = String(p.poseRight);
    if (p.poseLeft) o.pose.left = String(p.poseLeft);
  } else if (t === 'look') {
    o.x = Number(p.x) || 0;
    o.y = Number(p.y) || 0;
  } else if (t === 'delay') {
    o.delayMs = Number(p.delayMs) || 0;
  }
  if (t !== 'delay' && Number(p.stepDelayMs) > 0) o.delayMs = Number(p.stepDelayMs);
  // 非缺省优先级写入执行图，使后端分段与编辑器（按 props.priority 起新段）一致
  if (typeof p.priority === 'string' && p.priority !== 'NORMAL') o.priority = p.priority;
  return o;
}

/**
 * @param {object} graph 设计层图（已 normalize）
 * @returns {{roots: string[], nodes: object[]}}
 */
export function compileEditorGraph(graph) {
  const nodes = Array.isArray(graph && graph.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph && graph.edges) ? graph.edges : [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const active = (id) => byId.has(id) && !byId.get(id).disabled;
  const compilable = (n) => !!(NODE_TYPE_DEFS[n.type] && NODE_TYPE_DEFS[n.type].gtype);
  const adj = {};
  for (const e of edges) {
    if (!active(e.from) || !active(e.to)) continue;
    (adj[e.from] = adj[e.from] || []).push(e.to);
  }
  const downstream = (id) => {
    const out = [];
    const seen = new Set([id]);
    const queue = (adj[id] || []).slice();
    let guard = 0;
    while (queue.length && guard++ < 1024) {
      const cur = queue.shift();
      if (seen.has(cur)) continue;
      seen.add(cur);
      const n = byId.get(cur);
      if (!n || n.disabled) continue;
      if (compilable(n)) {
        out.push(cur);
        continue;
      }
      for (const nx of adj[cur] || []) if (!seen.has(nx)) queue.push(nx);
    }
    return [...new Set(out)];
  };
  const comp = nodes.filter((n) => compilable(n) && !n.disabled);
  const nextMap = new Map(comp.map((n) => [n.id, downstream(n.id)]));
  const indeg = new Map(comp.map((n) => [n.id, 0]));
  for (const arr of nextMap.values()) for (const t of arr) if (indeg.has(t)) indeg.set(t, indeg.get(t) + 1);
  let roots = comp.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  if (!roots.length && comp.length) roots = [comp[0].id];
  return {
    roots,
    nodes: comp.map((n) => ({ ...execNode(n), next: (nextMap.get(n.id) || []).slice() })),
  };
}

/** 整体校验：编译后交给 nodegraph.mjs validateNodegraph（§2 全规则 + F2 编译校验）。 */
function validateWhole(graph) {
  const execGraph = compileEditorGraph(graph);
  const checked = validateNodegraph({
    schemaVersion: NODEGRAPH_SCHEMA_VERSION,
    kind: NODEGRAPH_KIND,
    name: 'ai-edit-preview',
    graph: execGraph,
  });
  return checked.ok ? [] : checked.errors;
}

// ---------------------------------------------------------------------------
// 对外入口
// ---------------------------------------------------------------------------

/**
 * @param {object} graph 设计层节点图
 * @param {object[]} ops 编辑操作
 * @param {{mode?: 'atomic'|'skip', live2dIds?: object|null}} [options]
 * @returns {{graph: object, valid: boolean, applied: boolean, errors: Array<{opIndex: number|null, op?: string, reason: string, message: string}>,
 *           warnings: Array<{opIndex: number, op?: string, reason: string, message: string}>, appliedOps: number[]}}
 *   warnings 不阻断（如 live2d-id-not-in-model）。
 */
export function applyOps(graph, ops, options = {}) {
  const mode = options.mode === 'skip' ? 'skip' : 'atomic';
  const live2dIds = options.live2dIds || null;
  const inputErrors = checkInputGraph(graph);
  if (inputErrors.length) {
    return {
      graph: isPlain(graph) ? deep(graph) : null,
      valid: false,
      applied: false,
      errors: inputErrors.map((message) => ({ opIndex: null, reason: 'invalid-graph', message })),
      warnings: [],
      appliedOps: [],
    };
  }
  const original = normalizeGraph(graph);
  if (!Array.isArray(ops)) {
    return { graph: original, valid: false, applied: false, errors: [{ opIndex: null, reason: 'invalid-ops', message: 'ops 必须是数组' }], warnings: [], appliedOps: [] };
  }
  if (ops.length > MAX_OPS_PER_CALL) {
    return { graph: original, valid: false, applied: false, errors: [{ opIndex: null, reason: 'too-many-ops', message: `单次最多 ${MAX_OPS_PER_CALL} 个 op` }], warnings: [], appliedOps: [] };
  }

  let work = deep(original);
  const errors = [];
  const appliedOps = [];
  const warnings = [];
  const ctx = { live2dIds, created: [], pendingWarnings: [] };
  for (let i = 0; i < ops.length; i++) {
    const before = deep(work);
    ctx.pendingWarnings = [];
    const err = applyOne(work, ops[i], ctx);
    const opName = isPlain(ops[i]) && typeof ops[i].op === 'string' ? ops[i].op : undefined;
    if (!err) for (const w of ctx.pendingWarnings) warnings.push({ opIndex: i, ...(opName ? { op: opName } : {}), ...w });
    if (err) {
      work = before; // 失败 op 不留半修改
      errors.push({ opIndex: i, ...(opName ? { op: opName } : {}), reason: err.reason, message: err.message });
      if (mode === 'atomic') break;
    } else {
      appliedOps.push(i);
    }
  }
  if (errors.length && mode === 'atomic') {
    return { graph: original, valid: false, applied: false, errors, warnings: [], appliedOps: [] };
  }
  const wholeErrors = validateWhole(work);
  for (const message of wholeErrors) errors.push({ opIndex: null, reason: 'graph-invalid', message });
  return { graph: work, valid: errors.length === 0, applied: true, errors, warnings, appliedOps };
}

// ---------------------------------------------------------------------------
// 分享 JSON ↔ 设计层
// ---------------------------------------------------------------------------

/**
 * 分享 JSON → 设计层图。优先 meta.editor（编辑器导出带完整布局）；否则从 graph 回推（自动网格布局，
 * 与编辑器 Serializer.linearView 同规则）。
 */
export function editorGraphFromDoc(doc) {
  const ed = isPlain(doc) && isPlain(doc.meta) && isPlain(doc.meta.editor) ? doc.meta.editor : null;
  if (ed && Array.isArray(ed.nodes) && ed.nodes.every((n) => isPlain(n) && NODE_TYPE_DEFS[n.type])) {
    const nodes = ed.nodes.map((n) => ({
      id: n.id, type: n.type, label: typeof n.label === 'string' ? n.label : NODE_TYPE_DEFS[n.type].label,
      pos: { x: Number(n.pos && n.pos.x) || 0, y: Number(n.pos && n.pos.y) || 0 },
      props: { ...defaultProps(n.type), ...(isPlain(n.props) ? n.props : {}) },
      disabled: !!n.disabled,
    }));
    const edges = (Array.isArray(ed.edges) ? ed.edges : []).map((e) => ({ id: e.id, from: e.from, to: e.to }));
    const out = { nodes, edges };
    if (isPlain(ed.viewport)) out.viewport = { ...ed.viewport };
    return out;
  }
  const gnodes = isPlain(doc) && isPlain(doc.graph) && Array.isArray(doc.graph.nodes) ? doc.graph.nodes : [];
  const nodes = gnodes.map((n, i) => {
    const type = NODE_TYPE_DEFS[n.type] ? n.type : 'expression';
    const p = { ...defaultProps(type) };
    if (n.name !== undefined) p.name = n.name;
    if (n.clear !== undefined) p.clear = n.clear;
    if (n.closeMotion !== undefined) p.closeMotion = n.closeMotion;
    if (n.closeAfterMs !== undefined) p.closeAfterMs = n.closeAfterMs;
    if (n.delayMs !== undefined) {
      if (type === 'delay') p.delayMs = n.delayMs;
      else p.stepDelayMs = n.delayMs;
    }
    if (isPlain(n.pose)) {
      p.poseRight = n.pose.right || '';
      p.poseLeft = n.pose.left || '';
    }
    if (n.x !== undefined) p.x = n.x;
    if (n.y !== undefined) p.y = n.y;
    if (n.priority !== undefined) p.priority = n.priority;
    return { id: n.id, type, label: NODE_TYPE_DEFS[type].label, pos: { x: 80 + (i % 6) * 260, y: 120 + Math.floor(i / 6) * 170 }, props: p, disabled: false };
  });
  const ids = new Set(nodes.map((n) => n.id));
  const edges = [];
  let k = 0;
  for (const n of gnodes) {
    for (const t of Array.isArray(n.next) ? n.next : []) {
      if (ids.has(t)) edges.push({ id: 'e' + ++k, from: n.id, to: t });
    }
  }
  return { nodes, edges };
}

/**
 * 设计层图 + 原分享 JSON → 新分享 JSON（不含 segments，由 validateNodegraph 编译生成）。
 * meta.editor 写入完整设计层（与编辑器 Serializer.build 同形），其余 meta 字段保留。
 *
 * 新图默认绑定：baseDoc 没有 modelBinding（全新图）且 options.defaultBinding 提供
 * {modelId, bindingMode:'strict'} 时用它（宿主传当前模型，实现「新建图默认 strict 绑定当前模型」）；
 * 未提供 defaultBinding 或旧图已有绑定 → 照旧 'any'（旧图不自动迁移）。
 */
export function docFromEditorGraph(graph, baseDoc, options = {}) {
  const base = isPlain(baseDoc) ? baseDoc : {};
  const meta = isPlain(base.meta) ? deep(base.meta) : {};
  const prevEditor = isPlain(meta.editor) ? meta.editor : {};
  meta.editor = {
    ...prevEditor,
    version: 1,
    name: typeof base.name === 'string' ? base.name : prevEditor.name,
    nodes: deep(graph.nodes),
    edges: deep(graph.edges),
    viewport: isPlain(graph.viewport) ? deep(graph.viewport) : prevEditor.viewport || { x: 30, y: 80, k: 0.85 },
  };
  const db = isPlain(options.defaultBinding) ? options.defaultBinding : null;
  const binding = isPlain(base.modelBinding)
    ? deep(base.modelBinding)
    : db && typeof db.modelId === 'string' && db.modelId
      ? { modelId: db.modelId, modelHash: '', bindingMode: 'strict' }
      : { bindingMode: 'any' };
  return {
    schemaVersion: NODEGRAPH_SCHEMA_VERSION,
    kind: NODEGRAPH_KIND,
    name: base.name,
    modelBinding: binding,
    graph: compileEditorGraph(graph),
    meta,
  };
}

