/**
 * host 侧 `/dsh-l2d/ai/call` 入队前守卫（M1-d 纵深防御第一道闸）。
 *
 * 渲染端仍按 ownership 表最终裁定，这里只做**静态可判定**的拒绝：
 *   - 未知工具名（避免 /ai/call 变成任意函数调用面）
 *   - 口型参数（任何通道永拒；静态名单，不依赖模型文件）
 *   - 物理输出未 `own:true`（仅 `l2d_set_parameters`；keyframes 由渲染端按轨道时长自动认领）
 *   - 未索引表情 / 未索引动作组（静态名单 ∪ 运行时 model3 索引；Idle 明确拒绝）
 *
 * 失败语义（重要）：
 *   - 参数名守卫**不 fail-open**：口型名单是代码里的静态事实，模型文件读不到也照样拒；
 *   - 物理输出守卫**fail-open**：physics3 读不到时无法判定哪些 id 是物理输出，放行并由渲染端兜底，
 *     同时在结果里带 `warnings: ['physics-table-unavailable']`，绝不抛异常 / 500。
 *
 * 为什么单独成模块：index.js 里的路由闭包没法单测；这里全部是纯函数 +
 * 一个只读文件索引缓存，`host-guard.test.mjs` 直接打这些出口。
 */
import fs from 'node:fs';
import path from 'node:path';
import { MODEL_EXPRESSIONS, MODEL_MOTION_GROUPS } from './choreography.mjs';
import { checkParameterWrite, collectReservedParams } from './param-guards.mjs';

/** 渲染端实际加载的模型文件（与 overlay.js 的 MODEL_URL 一致；2048 是降档版）。 */
export const MODEL_FILE = '大肥鱼.dsl2d.model3.json';
/** 物理设置文件；输出表决定哪些参数默认只读。 */
export const PHYSICS_FILE = '大肥鱼.physics3.json';

/**
 * /ai/call 白名单：与 index.js 原 ALLOWED 集合一致。
 * 低层 set_parameters / play_keyframes 只留给 HTTP 调试，不进 MCP。
 */
export const HOST_ALLOWED_TOOLS = Object.freeze([
  'l2d_set_expression',
  'l2d_play_motion',
  'l2d_look_at',
  'l2d_set_parameters',
  'l2d_reset_pose',
  'l2d_play_keyframes',
  'l2d_stop_keyframes',
  'l2d_set_pose',
  'l2d_emote',
  'l2d_gaze',
  'l2d_say',
  'l2d_act',
  'l2d_get_state',
  'l2d_reset',
]);

const ALLOWED_SET = new Set(HOST_ALLOWED_TOOLS);

/** 入参里可能以参数名为键的工具：先做口型递归扫描。 */
const PARAM_KEYED_TOOLS = new Set(['l2d_set_parameters', 'l2d_play_keyframes']);

/**
 * 物理输出必须显式 `own:true` 的工具。
 * `l2d_play_keyframes` 故意不在内：渲染端 playKeyframes 会按轨道时长自动认领物理输出
 * （c9be149），若 host 再要求 own 会直接把这条合法通道堵死。
 */
const OWN_REQUIRED_TOOLS = new Set(['l2d_set_parameters']);

const STATIC_EXPRESSIONS = new Set(MODEL_EXPRESSIONS);
const STATIC_MOTION_GROUPS = new Set(MODEL_MOTION_GROUPS);

/** 从 model3.json 抽表情名与动作组名。解析失败由调用方兜（返回空数组不抛）。 */
export function parseModel3(json) {
  const refs = (json && json.FileReferences) || {};
  const expressions = Array.isArray(refs.Expressions)
    ? refs.Expressions.map((e) => e && e.Name).filter((n) => typeof n === 'string' && n)
    : [];
  const motionGroups =
    refs.Motions && typeof refs.Motions === 'object' && !Array.isArray(refs.Motions)
      ? Object.keys(refs.Motions)
      : [];
  return { expressions, motionGroups };
}

/** 从 physics3.json 抽物理输出参数表（Output[].Destination.Id）。 */
export function parsePhysics3(json) {
  const settings = json && Array.isArray(json.PhysicsSettings) ? json.PhysicsSettings : [];
  const outputs = new Set();
  for (const setting of settings) {
    const list = setting && Array.isArray(setting.Output) ? setting.Output : [];
    for (const output of list) {
      const id = output && output.Destination && output.Destination.Id;
      if (typeof id === 'string' && id) outputs.add(id);
    }
  }
  return outputs;
}

/**
 * 读模型索引。任何读取/解析错误都吞进 `warnings`，绝不抛。
 *
 * @param {string} modelDir
 * @param {{fs?: typeof fs, modelFile?: string, physicsFile?: string}} [options]
 * @returns {{modelDir:string, expressions:Set<string>|null, motionGroups:Set<string>|null,
 *            physicsOutputs:Set<string>|null, warnings:string[]}}
 */
export function loadModelIndex(modelDir, options = {}) {
  const fsImpl = options.fs || fs;
  const result = {
    modelDir,
    expressions: null,
    motionGroups: null,
    physicsOutputs: null,
    warnings: [],
  };
  if (typeof modelDir !== 'string' || !modelDir) {
    result.warnings.push('model-dir-unavailable');
    return result;
  }
  const readJson = (file) => JSON.parse(fsImpl.readFileSync(path.join(modelDir, file), 'utf8'));
  try {
    const parsed = parseModel3(readJson(options.modelFile || MODEL_FILE));
    result.expressions = new Set(parsed.expressions);
    result.motionGroups = new Set(parsed.motionGroups);
  } catch (err) {
    result.warnings.push('model3-unavailable: ' + String((err && err.message) || err));
  }
  try {
    result.physicsOutputs = parsePhysics3(readJson(options.physicsFile || PHYSICS_FILE));
  } catch (err) {
    result.warnings.push('physics3-unavailable: ' + String((err && err.message) || err));
  }
  return result;
}

/**
 * 带 TTL 的索引缓存：模型文件是运行时可替换的，但 /ai/call 不该每次都读磁盘。
 * `now` 可注入，测试里用假时钟验证过期重载。
 */
export function createModelIndexCache(modelDir, options = {}) {
  const ttlMs = Number.isFinite(Number(options.ttlMs)) ? Math.max(0, Number(options.ttlMs)) : 10_000;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  let cached = null;
  let loadedAt = 0;
  return {
    get() {
      const at = now();
      if (!cached || at - loadedAt >= ttlMs) {
        cached = loadModelIndex(modelDir, options);
        loadedAt = at;
      }
      return cached;
    },
    invalidate() {
      cached = null;
      loadedAt = 0;
    },
  };
}

/**
 * 从工具入参里抽"会被写到的参数名"。
 * 只认渲染端实际读取的字段：`values`（对象）/ `tracks[].param`。
 */
export function extractParamIds(name, args) {
  const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  if (name === 'l2d_set_parameters') {
    const values = a.values && typeof a.values === 'object' && !Array.isArray(a.values) ? a.values : {};
    return Object.keys(values);
  }
  if (name === 'l2d_play_keyframes') {
    const tracks = Array.isArray(a.tracks) ? a.tracks : [];
    return tracks.map((t) => (t && typeof t.param === 'string' ? t.param : null)).filter(Boolean);
  }
  return [];
}

function deny(reason, detail, message) {
  const text = String(detail == null ? '' : detail);
  return {
    ok: false,
    status: 400,
    reason,
    detail: text,
    // 兼容旧响应文案：未知工具沿用 `unknown tool: X`（外部脚本可能按文本匹配）。
    message: message || (text ? reason + ': ' + text : reason),
  };
}

function expressionSet(index) {
  // 允许 model3 动态扩展（模型换皮后不必改代码），但静态名单永远生效。
  if (!index || !index.expressions || index.expressions.size === 0) return STATIC_EXPRESSIONS;
  return new Set([...STATIC_EXPRESSIONS, ...index.expressions]);
}

function motionGroupSet(index) {
  if (!index || !index.motionGroups || index.motionGroups.size === 0) return STATIC_MOTION_GROUPS;
  return new Set([...STATIC_MOTION_GROUPS, ...index.motionGroups]);
}

/**
 * 一次 `/ai/call` 的入队前校验。
 *
 * @param {{name?:string, args?:object}} request
 * @param {{index?: ReturnType<typeof loadModelIndex>|null}} [options]
 * @returns {{ok:true, warnings:string[]} |
 *           {ok:false, status:400, reason:string, detail:string, message:string}}
 */
export function guardAiCall(request = {}, options = {}) {
  const req = request && typeof request === 'object' ? request : {};
  const name = typeof req.name === 'string' ? req.name.trim() : '';
  const raw = req.args;
  const args = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const index = options.index && typeof options.index === 'object' ? options.index : null;
  const warnings = [];

  if (!ALLOWED_SET.has(name)) return deny('unknown-tool', name, 'unknown tool: ' + name);

  // 口型：任何以参数名为键的工具，入参出现即拒（递归，含嵌套/数组形式）。
  if (PARAM_KEYED_TOOLS.has(name)) {
    const hits = collectReservedParams(args);
    if (hits.length) return deny('reserved-param', hits.join(','));
  }

  if (name === 'l2d_set_expression') {
    const expr = typeof args.name === 'string' ? args.name : '';
    if (!expr) return deny('empty-expression', '');
    if (!expressionSet(index).has(expr)) return deny('unknown-expression', expr);
  }

  if (name === 'l2d_play_motion') {
    const group = typeof args.group === 'string' ? args.group : '';
    if (!group) return deny('empty-motion-group', '');
    // Idle 只由引擎在动作队列空闲时自播，外部手动播会和引擎抢同一组。
    if (group === 'Idle') return deny('idle-not-playable', group);
    if (!motionGroupSet(index).has(group)) return deny('unknown-motion-group', group);
  }

  if (OWN_REQUIRED_TOOLS.has(name)) {
    const ids = extractParamIds(name, args);
    const physics = index && index.physicsOutputs instanceof Set ? index.physicsOutputs : null;
    if (!physics) {
      // fail-open：没有物理输出表就不判定，交给渲染端；不 500。
      warnings.push('physics-table-unavailable');
    } else {
      const checked = checkParameterWrite(
        { paramIds: ids, own: args.own === true },
        { physicsOutputs: physics },
      );
      if (!checked.ok) return deny(checked.reason, checked.params.join(','));
    }
  }

  return { ok: true, warnings };
}
