/**
 * host 侧 `/dsh-l2d/ai/call` 入队前守卫（M1-d 纵深防御第一道闸）。
 *
 * 渲染端仍按 ownership 表最终裁定，这里只做**静态可判定**的拒绝：
 *   - 未知工具名（避免 /ai/call 变成任意函数调用面）
 *   - 口型参数（任何通道永拒；静态名单，不依赖模型文件；含 l2d_posture 的 values）
 *   - 物理输出未 `own:true`（`l2d_set_parameters` / `l2d_posture` 的 values 直写；
 *     keyframes 由渲染端按轨道时长自动认领，posture 的 post 相 acquire 语义由渲染端终审）
 *   - `own:true` 只登记物理输出（R10b）：非物理 id 忽略不算错误，`ignored` 清单随回执带出
 *   - 未索引表情 / 未索引动作组（静态名单 ∪ 运行时 model3 索引；Idle 明确拒绝）
 *   - 节点图模式互斥（docs/nodegraph/SPEC.md §3）：options.mode==='nodegraph' 时拒绝
 *     l2d_act / l2d_emote（纯 LLM 整链编排），单步原语放行作 LLM 辅助底层通道
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
import { MODEL_EXPRESSIONS, MODEL_MOTION_GROUPS, STEP_KINDS, validateStep } from './choreography.mjs';
import { checkParameterWrite, collectReservedParams } from './param-guards.mjs';

/**
 * 渲染端实际加载的模型文件：两个入口加载的是不同变体。
 *   - overlay.js 主窗 → 大肥鱼.dsl2d.model3.json（4096 贴图高清版）
 *   - pet.html 独立桌宠窗 / assets/test.html → 大肥鱼.dsl2d.2048.model3.json（降档版）
 * 两个变体 2026-11 实测 motions/expressions 完全相同，但索引按"能读到的变体取并集"，
 * 换模型/换变体时不会因为写死其中一个文件名而误拒合法表情/动作组。
 */
export const MODEL_FILES = Object.freeze([
  '大肥鱼.dsl2d.model3.json',
  '大肥鱼.dsl2d.2048.model3.json',
]);
/** 兼容旧引用与测试夹具：主窗（overlay.js）加载的那个变体。 */
export const MODEL_FILE = MODEL_FILES[0];
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
  'l2d_posture',
  'l2d_get_state',
  'l2d_reset',
  // 无参形态切换工具：不写参数，故不进 PARAM_KEYED_TOOLS / OWN_REQUIRED_TOOLS。
  'l2d_change_form',
  // FI PR-01（feat/facial-intelligence）：语义面部意图。plan 全文经渲染层
  // validateFacialPlan 二次验证（本层不做字段级校验，仅准入白名单 + 载荷大小限制）。
  // 口型红线天然适用：renderer 口型参数在 injector.set 不区分通道无条件拒绝。
  'l2d_facial',
  'l2d_facial_manual',
]);

const ALLOWED_SET = new Set(HOST_ALLOWED_TOOLS);

/**
 * 入参里可能以参数名为键的工具：先做口型递归扫描。
 * `l2d_posture` 的 values 也是参数名键（语义姿态直写参数 id），口型红线同样适用。
 */
const PARAM_KEYED_TOOLS = new Set(['l2d_set_parameters', 'l2d_play_keyframes', 'l2d_posture']);

/**
 * 物理输出必须显式 `own:true` 的工具。
 * `l2d_play_keyframes` 故意不在内：渲染端 playKeyframes 会按轨道时长自动认领物理输出
 * （c9be149），若 host 再要求 own 会直接把这条合法通道堵死。
 * `l2d_posture` 的 values 直写与 set_parameters 同语义；post 相的 acquire/release
 * 语义由渲染端 LimbController 终审，宿主只拦 values 直写物理输出且未 own。
 */
const OWN_REQUIRED_TOOLS = new Set(['l2d_set_parameters', 'l2d_posture']);

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
  // [#28] 模型自声明引用的物理文件（相对模型目录）；没有则由调用方回退默认名。
  const physics = typeof refs.Physics === 'string' && refs.Physics ? refs.Physics : null;
  return { expressions, motionGroups, physics };
}

/**
 * [#28] 发现目录下全部 .model3.json（按文件名排序）。
 * 目录不可读 / 不是目录时返回空数组不抛，调用方回退到写死名单。
 */
export function discoverModelFiles(modelDir, fsImpl = fs) {
  try {
    return fsImpl
      .readdirSync(modelDir)
      .filter((n) => typeof n === 'string' && n.endsWith('.model3.json'))
      .sort();
  } catch {
    return [];
  }
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
  // [#28] 未显式指定时不再写死大肥鱼名单：按目录实际发现的 .model3.json 建索引，
  // 目录不可读 / 为空才回退 MODEL_FILES（保持旧目录名下的旧行为）。
  const discovered = discoverModelFiles(modelDir, fsImpl);
  const modelFiles = options.modelFile
    ? [options.modelFile]
    : Array.isArray(options.modelFiles) && options.modelFiles.length
      ? options.modelFiles
      : discovered.length
        ? discovered
        : MODEL_FILES;
  const expressions = new Set();
  const motionGroups = new Set();
  const modelFailures = [];
  // [#28] 记录模型自声明的 physics3 文件名（优先于写死的 PHYSICS_FILE）。
  let physicsRef = null;
  for (const file of modelFiles) {
    try {
      const parsed = parseModel3(readJson(file));
      if (!physicsRef && parsed.physics) physicsRef = parsed.physics;
      for (const name of parsed.expressions) expressions.add(name);
      for (const name of parsed.motionGroups) motionGroups.add(name);
    } catch (err) {
      modelFailures.push(file + ': ' + String((err && err.message) || err));
    }
  }
  if (modelFailures.length < modelFiles.length) {
    result.expressions = expressions;
    result.motionGroups = motionGroups;
  } else {
    result.warnings.push('model3-unavailable: ' + modelFailures.join('; '));
  }
  try {
    result.physicsOutputs = parsePhysics3(readJson(options.physicsFile || physicsRef || PHYSICS_FILE));
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
 * 只认渲染端实际读取的字段：`values`（对象，l2d_set_parameters / l2d_posture）/ `tracks[].param`。
 */
export function extractParamIds(name, args) {
  const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  if (name === 'l2d_set_parameters' || name === 'l2d_posture') {
    const values = a.values && typeof a.values === 'object' && !Array.isArray(a.values) ? a.values : {};
    return Object.keys(values);
  }
  if (name === 'l2d_play_keyframes') {
    const tracks = Array.isArray(a.tracks) ? a.tracks : [];
    return tracks.map((t) => (t && typeof t.param === 'string' ? t.param : null)).filter(Boolean);
  }
  return [];
}

/** MCP 工具面的动作链上限（server.mjs 的 z.array(...).max(8)）。 */
const MAX_CHAIN_STEPS = 8;

/**
 * `/ai/call` 的 l2d_act 支持的动作步骤类型：MCP 的四种 + HTTP 调试专用的 keyframes
 * （overlay.js playbackAct 有 `step.kind === 'keyframes'` 分支，poke 链路也会产出它）。
 */
export const HOST_STEP_KINDS = Object.freeze([...STEP_KINDS, 'keyframes']);

const HOST_STEP_KIND_SET = new Set(HOST_STEP_KINDS);

/** keyframes 步骤的轻量结构校验（口型/数值范围由渲染端 playKeyframes 终审）。 */
function validateKeyframeStep(step, index) {
  const at = 'chain[' + index + ']';
  if (!step || typeof step !== 'object' || Array.isArray(step)) return [at + ' 不是对象'];
  if (!Array.isArray(step.tracks) || step.tracks.length === 0) return [at + ' keyframes 步骤缺 tracks'];
  const errors = [];
  for (let i = 0; i < step.tracks.length; i++) {
    const track = step.tracks[i];
    if (!track || typeof track.param !== 'string' || !track.param) {
      errors.push(at + '.tracks[' + i + '] 缺 param');
    } else if (!Array.isArray(track.keys) || track.keys.length < 2) {
      errors.push(at + '.tracks[' + i + '] keys 少于 2 个关键帧');
    }
  }
  return errors;
}

/**
 * l2d_act 的 chain 静态校验：MCP 侧有 validateActChain，HTTP 直连是同一条工具面，
 * 不能成为绕过白名单的旁路。结构与取值范围复用 choreography.validateStep，
 * 口型用同一份 param-guards 名单递归扫描。
 *
 * @returns {{ok:boolean, errors:string[]}}
 */
export function checkActChain(chain) {
  if (chain === undefined) return { ok: true, errors: [] };
  if (!Array.isArray(chain)) return { ok: false, errors: ['chain 必须是数组'] };
  if (chain.length > MAX_CHAIN_STEPS) {
    return { ok: false, errors: ['chain 超过 ' + MAX_CHAIN_STEPS + ' 步'] };
  }
  const errors = [];
  for (let i = 0; i < chain.length; i++) {
    const step = chain[i];
    const kind = step && typeof step === 'object' ? step.kind : undefined;
    if (!HOST_STEP_KIND_SET.has(kind)) {
      errors.push('chain[' + i + '] kind 非法：' + String(kind));
      continue;
    }
    if (kind === 'keyframes') {
      errors.push(...validateKeyframeStep(step, i));
      continue;
    }
    const result = validateStep(step, i);
    errors.push(...((result && result.errors) || []));
  }
  const reserved = collectReservedParams(chain);
  if (reserved.length) errors.push('动作链不得包含口型参数：' + reserved.join(', '));
  return { ok: errors.length === 0, errors };
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
 * @returns {{ok:true, warnings:string[], ignored:string[]} |
 *           {ok:false, status:400, reason:string, detail:string, message:string}}
 */
export function guardAiCall(request = {}, options = {}) {
  const req = request && typeof request === 'object' ? request : {};
  const name = typeof req.name === 'string' ? req.name.trim() : '';
  const raw = req.args;
  const args = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const index = options.index && typeof options.index === 'object' ? options.index : null;
  const warnings = [];
  // R10b：own:true 请求里非物理输出的 id（只登记物理输出，其余忽略且回执可见）。
  const ignored = [];

  if (!ALLOWED_SET.has(name)) return deny('unknown-tool', name, 'unknown tool: ' + name);

  // 节点图模式互斥（docs/nodegraph/SPEC.md §3）：mode==='nodegraph' 时拦截纯 LLM
  // 编排类整链工具；单步原语（set_expression/play_motion 等）不拦。mode 缺省或
  // 'llm' 时与既有行为完全一致（现状兼容）。
  if (options.mode === 'nodegraph' && (name === 'l2d_act' || name === 'l2d_emote')) {
    return deny('mode-blocked', name, 'mode-blocked: ' + name + '（节点图模式下 LLM 整链编排被互斥拦截）');
  }

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
      // R10b：own 只登记物理输出；非物理 id 忽略不算错误。
      // ignored 同时进 warnings（index.js 会随回执带出给调用方）与结果字段。
      if (Array.isArray(checked.ignored) && checked.ignored.length) {
        ignored.push(...checked.ignored);
        warnings.push('own-ignored-non-physical:' + checked.ignored.join(','));
      }
    }
  }

  // l2d_act：MCP 侧有 validateActChain，HTTP 直连必须同规则（不能成为绕过白名单的旁路）。
  if (name === 'l2d_act') {
    const chainCheck = checkActChain(args.chain);
    if (!chainCheck.ok) return deny('invalid-chain', chainCheck.errors.join('; '));
  }

  return { ok: true, warnings, ignored };
}
