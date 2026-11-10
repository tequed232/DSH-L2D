/**
 * 节点编辑器（Motion Graph Lab）设计层节点定义 —— 后端单一数据源。
 *
 * 用途（三处同源，禁止手抄第二份）：
 *   1. nodegraph-ops.mjs 的 applyOps 逐 op 校验（节点类型 / 端口 / 参数类型与范围）；
 *   2. tools/nodegraph-schema/gen.mjs 生成 docs/nodegraph/NODE-SCHEMA.json（给 AI 与人读）；
 *   3. nodegraph-ai.mjs 的 ai-edit 提示词直接嵌入 buildNodeSchema() 的结果。
 *
 * 取值来源：动作类白名单（表情 / 动作组 / 姿势 / 数值域）全部从 choreography.mjs 导入，
 * 与执行侧 validateStep 同一份事实；设计层类型、端口与默认值对齐
 * assets/motion-graph.html 的 NodeDef / Capability（编辑器是单文件零依赖页面，暂无法 import 本模块，
 * 两边改动需同步；见 PR 已知限制）。
 *
 * 可选的 Live2D ID 清单（docs/nodegraph/live2d-ids.json，由 Live2D 同事按大肥鱼实际配置维护）：
 *   { params: { <id>: {min, max} }, motions: [<group>], expressions: [<name>], forms: [<index|name>] }
 * 存在时，带 live2d 引用标记的参数按它校验（未知 → unknown-live2d-id，越界 → param-out-of-range）；
 * 不存在时只做通用类型校验。本模块只负责读取与形状校验，绝不编造清单内容。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ACT_PRIORITIES,
  MODEL_EXPRESSIONS,
  MODEL_MOTION_GROUPS,
  PAIRED_CLOSES,
  POSE_VALUES,
  STEP_FIELD_RANGES,
} from './choreography.mjs';
import { MAX_SEGMENTS, MAX_STEPS_PER_SEGMENT } from '../../dsh-l2d-mcp/src/action-sequence.mjs';

export const NODE_SCHEMA_VERSION = 1;
/** 单次 applyOps 最多处理的 op 数（防恶意大批量）。 */
export const MAX_OPS_PER_CALL = 200;
/** 设计层节点总数上限：与 nodegraph.mjs 的 MAX_GRAPH_NODES（15 段 × 8 步）一致。 */
export const MAX_EDITOR_NODES = MAX_SEGMENTS * MAX_STEPS_PER_SEGMENT;
/** 节点 id 规则：安全字符 1~48 位（会进回执与提示词）。 */
export const NODE_ID_RE = /^[A-Za-z0-9_.:-]{1,48}$/;
/** 画布坐标绝对值上限（防 NaN / 天文数字把画布撑爆）。 */
export const MAX_ABS_POS = 100000;

export const PORT_TYPES = Object.freeze(['flow', 'signal', 'data']);
export const EXEC_STATES = Object.freeze(['idle', 'running', 'done', 'blocked']);

/** 每个节点固定一个输入端口 in、一个输出端口 out（与编辑器渲染一致）。 */
export const NODE_PORTS = Object.freeze({ in: { direction: 'input' }, out: { direction: 'output' } });

const stepDelay = { key: 'stepDelayMs', kind: 'number', min: STEP_FIELD_RANGES.delayMs[0], max: STEP_FIELD_RANGES.delayMs[1], default: 0 };

/**
 * 通用参数（所有节点类型共享，设计层元数据；priority 参与分段编译）。
 * label 与 disabled 同时是节点级字段，set_param 会同步写到节点上。
 */
export const COMMON_PARAMS = Object.freeze([
  { key: 'priority', kind: 'enum', options: [...ACT_PRIORITIES], default: 'NORMAL' },
  { key: 'cooldownMs', kind: 'number', min: 0, max: 600000, default: 0 },
  { key: 'execState', kind: 'enum', options: [...EXEC_STATES], default: 'idle' },
  { key: 'modelWhitelist', kind: 'string', maxLength: 200, default: '' },
  { key: 'portType', kind: 'enum', options: [...PORT_TYPES], default: 'flow' },
  { key: 'disabled', kind: 'boolean', default: false },
]);

/**
 * 节点类型定义。gtype = 编译进 graph.nodes 的执行类型；null = 设计层辅助节点（只存 meta.editor，
 * 编译时被穿透）。params 里 live2d 字段表示该值是 Live2D 资源引用（有 live2d-ids.json 时按它校验）。
 * enumFallback：无 live2d-ids.json 时提示给 AI 的代码内白名单（执行侧整体校验仍以它为准）。
 */
export const NODE_TYPE_DEFS = Object.freeze({
  // trigger 是设计层标注（自由文本事件名），不假设模型有 HitAreas。
  trigger: { group: 'event', label: 'Trigger', gtype: null, note: '设计层标注，不编译；本模型无 HitAreas，不要写依赖点击区域的事件', params: [{ key: 'event', kind: 'string', maxLength: 120, default: 'on_user_message' }] },
  workspace: { group: 'event', label: 'Workspace State', gtype: null, params: [{ key: 'state', kind: 'string', maxLength: 120, default: 'attention' }] },
  condition: { group: 'logic', label: 'Condition', gtype: null, params: [{ key: 'expr', kind: 'string', maxLength: 200, default: 'idle == false' }] },
  gate: { group: 'logic', label: 'Condition Gate', gtype: null, params: [{ key: 'expr', kind: 'string', maxLength: 200, default: 'state == attention' }] },
  delay: { group: 'logic', label: 'Delay', gtype: 'delay', params: [{ key: 'delayMs', kind: 'number', min: 1, max: 5000, default: 200 }] },
  motion: {
    group: 'action', label: 'Motion', gtype: 'motion',
    params: [
      // Idle 即使出现在 live2d-ids.json 的 motions 里也不允许：待机由引擎自播，手动播会抢同一组。
      { key: 'name', kind: 'string', live2d: 'motions', forbidden: ['Idle'], enumFallback: [...MODEL_MOTION_GROUPS], default: MODEL_MOTION_GROUPS[2] },
      // closeMotion 只读：由 name 的配对关系自动推导（PAIRED_CLOSES），避免手停在半空。
      { key: 'closeMotion', kind: 'string', readonly: true, derivedFrom: 'name', default: PAIRED_CLOSES[MODEL_MOTION_GROUPS[2]] },
      { key: 'closeAfterMs', kind: 'number', min: STEP_FIELD_RANGES.closeAfterMs[0], max: STEP_FIELD_RANGES.closeAfterMs[1], default: 1800 },
      stepDelay,
    ],
  },
  expression: {
    group: 'action', label: 'Expression', gtype: 'expression',
    params: [
      { key: 'name', kind: 'string', live2d: 'expressions', enumFallback: [...MODEL_EXPRESSIONS], default: MODEL_EXPRESSIONS[0] },
      { key: 'clear', kind: 'boolean', default: false },
      stepDelay,
    ],
  },
  // pose 节点 = overlay 的手臂姿势预设（choreography.POSE_VALUES），不是 Cubism pose3（本模型没有 pose3）。
  pose: {
    group: 'action', label: 'Pose', gtype: 'pose', note: '手臂姿势预设（rest/finger/grass/chest），不依赖 Cubism pose3；本模型无 pose3、无 HitAreas',
    params: [
      { key: 'poseRight', kind: 'enum', options: ['', ...POSE_VALUES], default: 'rest' },
      { key: 'poseLeft', kind: 'enum', options: ['', ...POSE_VALUES], default: '' },
      stepDelay,
    ],
  },
  look: {
    group: 'action', label: 'Look At', gtype: 'look',
    params: [
      { key: 'x', kind: 'number', min: STEP_FIELD_RANGES.x[0], max: STEP_FIELD_RANGES.x[1], default: 0 },
      { key: 'y', kind: 'number', min: STEP_FIELD_RANGES.y[0], max: STEP_FIELD_RANGES.y[1], default: 0.05 },
      stepDelay,
    ],
  },
});

export const NODE_TYPE_KEYS = Object.freeze(Object.keys(NODE_TYPE_DEFS));

/** 某类型的完整参数表（通用 + 专属）。未知类型 → null。 */
export function paramDefsFor(type) {
  const def = NODE_TYPE_DEFS[type];
  if (!def) return null;
  return [...COMMON_PARAMS, ...def.params];
}

/** 新节点的默认 props（与编辑器 Graph.addNode 的 common + NodeDef.defaults 同形）。 */
export function defaultProps(type) {
  const defs = paramDefsFor(type);
  if (!defs) return null;
  const props = {};
  for (const p of defs) props[p.key] = Array.isArray(p.default) ? [...p.default] : p.default;
  return props;
}

/** motion 的 closeMotion 推导：有配对给配对名，否则空串（编译时不产生 closeMotion）。 */
export function pairedCloseFor(name) {
  return Object.prototype.hasOwnProperty.call(PAIRED_CLOSES, name) ? PAIRED_CLOSES[name] : '';
}

/** op 格式说明（机器可读，生成进 NODE-SCHEMA.json，提示词同源）。 */
export const OP_DEFS = Object.freeze({
  add_node: { required: ['type'], optional: ['id', 'label', 'pos', 'props'], note: 'id 缺省时自动分配 ai_<n>；pos={x,y}；props 只写要覆盖默认值的参数' },
  remove_node: { required: ['id'], optional: [], note: '同时删除与该节点相连的全部连线' },
  set_param: { required: ['id', 'key', 'value'], optional: [], note: 'key 为参数名或 label；motion.name 改动会自动同步只读 closeMotion' },
  connect: { required: ['from', 'to'], optional: ['fromPort', 'toPort', 'replace'], note: "端口固定 fromPort='out' / toPort='in'；两端 portType 必须相同；禁止自连与成环；目标输入已有连线时需 replace:true 才替换" },
  disconnect: { required: [], optional: ['edgeId', 'from', 'to'], note: '给 edgeId，或给 from+to' },
  move_node: { required: ['id', 'x', 'y'], optional: [], note: `画布坐标，绝对值 ≤ ${MAX_ABS_POS}` },
});

/** 错误 / 告警 reason code（英文，不翻译；前端按 code 映射文案）。 */
export const REASON_CODES = Object.freeze([
  'invalid-graph', 'invalid-ops', 'too-many-ops', 'invalid-op', 'unknown-op', 'missing-field',
  'unknown-node-type', 'invalid-node-id', 'duplicate-node-id', 'too-many-nodes', 'node-not-found',
  'unknown-param', 'param-readonly', 'param-type-mismatch', 'param-out-of-range', 'param-not-allowed',
  'unknown-live2d-id', 'unknown-port', 'port-type-mismatch', 'self-loop', 'duplicate-edge',
  'input-occupied', 'cycle', 'edge-not-found', 'invalid-position', 'graph-invalid',
  // 告警（不阻断）
  'live2d-id-not-in-model',
]);

/**
 * 机器可读的节点说明（NODE-SCHEMA.json 的内容；确定性，无时间戳，便于漂移检测）。
 */
export function buildNodeSchema() {
  const nodeTypes = {};
  for (const [type, def] of Object.entries(NODE_TYPE_DEFS)) {
    nodeTypes[type] = {
      group: def.group,
      label: def.label,
      compilesTo: def.gtype,
      ...(def.note ? { note: def.note } : {}),
      ports: { in: 'input', out: 'output' },
      params: def.params.map((p) => ({ ...p })),
    };
  }
  return {
    schemaVersion: NODE_SCHEMA_VERSION,
    kind: 'dsh-l2d-nodegraph-editor-schema',
    generatedBy: 'tools/nodegraph-schema/gen.mjs（数据源 packages/dsh-l2d-plugin/lib/nodegraph-schema.mjs）',
    graphFormat: {
      description: '设计层节点图（与编辑器 meta.editor 同形）：{nodes:[{id,type,label,pos:{x,y},props,disabled}], edges:[{id,from,to}], viewport?}',
      hashScope: 'graphHash 只覆盖 nodes 与 edges（稳定序列化后 sha256 前 16 位），viewport 不参与',
      limits: { maxNodes: MAX_EDITOR_NODES, maxOpsPerCall: MAX_OPS_PER_CALL, nodeIdPattern: NODE_ID_RE.source, maxAbsPos: MAX_ABS_POS },
    },
    commonParams: COMMON_PARAMS.map((p) => ({ ...p })),
    nodeTypes,
    connectionRules: {
      ports: '每个节点一个输入端口 in、一个输出端口 out',
      sameColorOnly: '两端节点的 props.portType 必须相同（flow/signal/data）',
      noSelfLoop: true,
      acyclic: true,
      noDuplicateEdge: true,
      singleInputByDefault: '目标 in 端口已有连线时，connect 需 replace:true 才会替换（与编辑器拖线替换语义一致）',
      compile: '设计层辅助节点（compilesTo=null）与 disabled 节点在编译时被穿透，动作节点按 next 编译为 segments，最终由 nodegraph.mjs validateNodegraph 整体校验',
    },
    ops: Object.fromEntries(Object.entries(OP_DEFS).map(([k, v]) => [k, { ...v }])),
    reasonCodes: [...REASON_CODES],
    live2dIds: {
      file: 'docs/nodegraph/live2d-ids.json',
      format: '{params:{<id>:{min,max}}, motions:[<group>], expressions:[<name>], forms:[<index|name>]}',
      note: '可选。存在时 live2d 引用参数按它校验（unknown-live2d-id / param-out-of-range），不存在时只做通用类型校验；只校验节点 op 写入的值，不校验模型自带表情文件内部的参数值',
      codeOnlyParamIds: [...CODE_ONLY_PARAM_IDS],
      modelFacts: '大肥鱼模型没有 HitAreas，也没有 pose3',
    },
  };
}

// ---------------------------------------------------------------------------
// live2d-ids.json 读取（可选文件；缺失 / 损坏均不抛）
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const DEFAULT_LIVE2D_IDS_FILE = path.join(REPO_ROOT, 'docs', 'nodegraph', 'live2d-ids.json');

/** 解析路径：显式参数 > 环境变量 DSH_L2D_IDS_FILE > 仓库 docs/nodegraph/live2d-ids.json。 */
export function resolveLive2dIdsFile(file) {
  return file || process.env.DSH_L2D_IDS_FILE || DEFAULT_LIVE2D_IDS_FILE;
}

/**
 * 形状归一化。非法形状 → null（调用方按「文件不存在」处理并带告警）。
 * @returns {{params: Record<string,{min:number,max:number}>, motions: string[], expressions: string[], forms: Array<string|number>}|null}
 */
export function normalizeLive2dIds(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = { params: {}, motions: [], expressions: [], forms: [] };
  if (raw.params !== undefined) {
    if (!raw.params || typeof raw.params !== 'object' || Array.isArray(raw.params)) return null;
    for (const [id, range] of Object.entries(raw.params)) {
      const min = Number(range && range.min);
      const max = Number(range && range.max);
      if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) return null;
      out.params[id] = { min, max };
    }
  }
  for (const key of ['motions', 'expressions']) {
    if (raw[key] === undefined) continue;
    if (!Array.isArray(raw[key]) || raw[key].some((v) => typeof v !== 'string')) return null;
    out[key] = [...raw[key]];
  }
  if (raw.forms !== undefined) {
    if (!Array.isArray(raw.forms) || raw.forms.some((v) => typeof v !== 'string' && !Number.isInteger(v))) return null;
    out.forms = [...raw.forms];
  }
  return out;
}

/**
 * 读取 live2d-ids.json。
 * @returns {{ids: ReturnType<typeof normalizeLive2dIds>, file: string, reason?: 'missing'|'unreadable'|'invalid-json'|'invalid-shape'}}
 */
export function loadLive2dIds(file) {
  const resolved = resolveLive2dIdsFile(file);
  let text;
  try {
    text = fs.readFileSync(resolved, 'utf8');
  } catch (err) {
    return { ids: null, file: resolved, reason: err && err.code === 'ENOENT' ? 'missing' : 'unreadable' };
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ids: null, file: resolved, reason: 'invalid-json' };
  }
  const ids = normalizeLive2dIds(raw);
  return ids ? { ids, file: resolved } : { ids: null, file: resolved, reason: 'invalid-shape' };
}

/**
 * 代码（param-guards.LIPSYNC_PARAMS / core LIPSYNC_PARAMS 等）里引用、但大肥鱼模型实际不存在的参数 ID。
 * live2d-ids.json 按模型真实配置生成，不收录它们；校验遇到时放行并产出 live2d-id-not-in-model 告警。
 */
export const CODE_ONLY_PARAM_IDS = Object.freeze(['ParamMouthOpen']);

/**
 * Live2D 引用校验（ids 为 null 时恒通过）。
 * 只校验节点 op 里写的值；模型自带 exp3 表情文件内部写了什么参数值（如「裙长切换」「尾巴开关」
 * 把 Clothes 参数设为 -1）属于模型既有行为，不在这里校验。
 * kind: 'motions' | 'expressions' | 'forms' | 'params'；params 时 value 为 {id, value?}。
 * @returns {null | {warning?: true, reason: 'unknown-live2d-id'|'param-out-of-range'|'live2d-id-not-in-model', message: string}}
 */
export function checkLive2dRef(ids, kind, value) {
  if (!ids) return null;
  if (kind === 'params') {
    const id = value && value.id;
    // 代码里引用、但本模型 moc3/cdi3 不存在的 ID：放行并告警（不改目录、不报错）
    if (typeof id === 'string' && CODE_ONLY_PARAM_IDS.includes(id) && !ids.params[id]) {
      return { warning: true, reason: 'live2d-id-not-in-model', message: `${id} 被代码引用，但当前模型里不存在（放行，仅告警）` };
    }
    const range = typeof id === 'string' ? ids.params[id] : undefined;
    if (!range) return { reason: 'unknown-live2d-id', message: `Live2D 参数 ID 不在 live2d-ids.json：${String(id)}` };
    if (value.value !== undefined) {
      const n = Number(value.value);
      if (!Number.isFinite(n) || n < range.min || n > range.max) {
        return { reason: 'param-out-of-range', message: `${id} 取值须在 ${range.min}~${range.max}，收到 ${String(value.value)}` };
      }
    }
    return null;
  }
  const list = ids[kind];
  if (!Array.isArray(list)) return null;
  const hit = kind === 'forms'
    ? list.some((f) => f === value || String(f) === String(value))
    : list.includes(value);
  return hit ? null : { reason: 'unknown-live2d-id', message: `${kind} 不在 live2d-ids.json：${String(value)}` };
}
