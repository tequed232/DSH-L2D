/**
 * 部位联动 bridge 规则核心（纯函数 + 内存状态机，无任何 IO）。
 *
 * 契约：docs/nodegraph/BODY-BRIDGE.md；依据表：docs/nodegraph/models/<modelId>/body-regions.json。
 *
 * 谁用它：
 *   - overlay.js（浏览器）：经 `import('/dsh-l2d/body-bridge.mjs')` 动态加载同一份文件，
 *     `createBridge(table)` 得到的实例是**唯一的占用状态权威**（谁占着哪个模块、排队、收尾、插值）；
 *   - 宿主 index.js / MCP：只用 `compileBodyTable` + `validateBridgeCommand` 做静态校验
 *     （模块名、动作归属、可写参数、口型红线、表情互斥），校验通过再经 aiInbox 转发给 overlay。
 * 两端是同一份代码、同一张表，所以节点编辑器和 LLM 走的是同一套规则。
 *
 * 为什么不许 import：这个文件要被浏览器以 ES 模块直接加载，宿主路由只发这一个文件，
 * 一旦 import 别的模块浏览器就会去拉相对路径而 404。同步测试（body-bridge-sync.test.mjs）会拦。
 */

/** 五个模块（与 body-regions.json 的 regions 键一致）。 */
export const BRIDGE_REGIONS = Object.freeze(['hair', 'face', 'hands', 'torso', 'legs']);
/** 两个独立层：表情层只判互斥组；形态层只管 Clothes2 / Param，走现有 l2d_set_form。 */
export const BRIDGE_LAYERS = Object.freeze(['expression', 'form']);
export const BRIDGE_SOURCES = Object.freeze(['llm', 'nodegraph', 'user']);

/**
 * 四档优先级。数值与 ActGate（core/src/action-chain.ts：BACKGROUND 10 / NORMAL 50 / FORCE 90）对齐，
 * HIGH 落在 NORMAL 与 FORCE 之间。BACKGROUND 作为 LOW 的别名接受（l2d_act 老调用方的写法）。
 * 规则：严格更高才能抢占；同级或更低一律 region-busy（与 l2d_act「同级可打断」不同，见文档）。
 */
export const BRIDGE_PRIORITY_RANK = Object.freeze({ LOW: 10, NORMAL: 50, HIGH: 70, FORCE: 90 });
export const BRIDGE_PRIORITIES = Object.freeze(Object.keys(BRIDGE_PRIORITY_RANK));

/** 失败原因码（对外契约，只增不改）。 */
export const BRIDGE_REASONS = Object.freeze([
  'invalid-command',
  'empty-steps',
  'invalid-step',
  'invalid-priority',
  'invalid-source',
  'unknown-region',
  'unknown-layer',
  'duplicate-region',
  'unknown-motion',
  'motion-not-in-region',
  'param-not-writable',
  'lipsync-redline',
  'invalid-value',
  'unknown-expression',
  'expression-conflict',
  'invalid-form',
  'region-busy',
  'wait-timeout',
  'table-unavailable',
  'not-found',
]);

/**
 * 渲染端 injector 以「叠加（add）」方式注入的参数，与
 * packages/renderer/src/app/param-injector.ts 的 ADDITIVE_INPUTS 同一份（同步测试校验）。
 * 用途只有一个：set 插值的起点——add 参数从偏移 0 起插，其余参数从当前读数起插。
 */
export const ADDITIVE_INPUT_PARAMS = Object.freeze([
  'AngleX', 'AngleY', 'AngleZ',
  'PositionX', 'PositionY', 'PositionZ',
  'LeanInput',
  'Movement1', 'Movement2', 'Movement3',
]);

/** 腿部模块第一版只开放这一个参数（鞋子）。 */
export const LEGS_WRITABLE = Object.freeze(['Clothes4']);
/** 形态层管的两个参数（Clothes2「2. 大小变」、Param「大小变位置」），只能经 l2d_set_form 改。 */
export const FORM_PARAMS = Object.freeze(['Clothes2', 'Param']);
/** 形态序号范围（与 l2d_set_form 一致：0=默认体型 1=体型1 2=体型2）。 */
export const FORM_INDEX_MAX = 2;

/**
 * 与模块直写冲突、按群里定稿改走模块指令的表情：
 *   - 「前倾」Add LeanInput -30 → torso set LeanInput（躯干优先）；
 *   - 「脱鞋」Add Clothes4 1    → legs set Clothes4（腿部优先）。
 * on:false 时写 off 值（LeanInput 是叠加输入，0 = 不偏移；Clothes4 默认 0）。
 */
export const EXPRESSION_REGION_CONVERSIONS = Object.freeze({
  前倾: Object.freeze({ region: 'torso', param: 'LeanInput', on: -30, off: 0 }),
  脱鞋: Object.freeze({ region: 'legs', param: 'Clothes4', on: 1, off: 0 }),
});

/** durationMs 上限（防止插值把模块占住太久；需要更久请分多条指令）。 */
export const MAX_SET_DURATION_MS = 30000;
/** onBusy:'wait' 的 waitMs 缺省与上限。 */
export const DEFAULT_WAIT_MS = 3000;
export const MAX_WAIT_MS = 30000;
/** 一条指令最多几步（5 个模块 + 若干表情 + 形态，足够）。 */
export const MAX_STEPS = 12;

const PRI_ALIASES = { BACKGROUND: 'LOW' };

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** 动作组名 → 成对槽位名（「竖手指打开」→「竖手指」）；非成对返回 ''。 */
export function motionSlotBase(group) {
  const name = String(group || '');
  const m = name.match(/^(.+?)(打开|关闭)$/);
  return m ? m[1] : '';
}

/** 动作组名是不是「打开」那一半。 */
export function isOpenMotion(group) {
  return /打开$/.test(String(group || ''));
}

/**
 * 编译分区表：把 body-regions.json 变成查表结构。表形状不对时抛错（调用方转 table-unavailable）。
 * @param {object} table body-regions.json 内容
 */
export function compileBodyTable(table) {
  if (!isPlainObject(table) || !isPlainObject(table.regions)) {
    throw new Error('body-regions 表形状不对：缺 regions');
  }
  const redline = new Set();
  const eg = isPlainObject(table.engineGroups) ? table.engineGroups : {};
  for (const id of asArray(eg.lipSync && eg.lipSync.ids)) redline.add(String(id));
  for (const id of asArray(eg.lipSyncCatalog)) redline.add(String(id));
  for (const id of asArray(table.policy && table.policy.lipSyncRedLine)) redline.add(String(id));
  const blink = new Set(asArray(eg.eyeBlink && eg.eyeBlink.ids).map(String));

  const physicsOutputs = new Set();
  const paramHome = new Map(); // param → region 名 | 'shared' | 'unassigned' | 'expressionLayer'
  const regions = {};
  const motionRegion = new Map();
  for (const name of BRIDGE_REGIONS) {
    const raw = table.regions[name];
    if (!isPlainObject(raw)) throw new Error('body-regions 表缺模块：' + name);
    const outs = new Set(asArray(raw.physicsOutputs).map(String));
    for (const id of outs) physicsOutputs.add(id);
    const params = asArray(raw.params).map(String);
    for (const id of params) paramHome.set(id, name);
    let writable = params.filter((id) => !outs.has(id) && !redline.has(id));
    if (name === 'legs') writable = writable.filter((id) => LEGS_WRITABLE.includes(id));
    const motions = asArray(raw.motions).map(String);
    for (const group of motions) motionRegion.set(group, name);
    regions[name] = {
      name,
      label: String(raw.label || name),
      params: new Set(params),
      writable: new Set(writable),
      motions,
      expressions: asArray(raw.expressions).map(String),
      physicsOutputs: outs,
    };
  }
  for (const item of asArray(table.shared)) {
    if (!item || !item.param) continue;
    paramHome.set(String(item.param), 'shared');
    if (item.physicsOutput) physicsOutputs.add(String(item.param));
  }
  for (const item of asArray(table.unassigned)) {
    if (!item || !item.id) continue;
    paramHome.set(String(item.id), 'unassigned');
    if (item.physicsOutput) physicsOutputs.add(String(item.id));
  }
  const layer = isPlainObject(table.expressionLayer) ? table.expressionLayer : {};
  for (const id of asArray(layer.params)) paramHome.set(String(id), 'expressionLayer');

  // 表情 → 写入参数；互斥组（conflicts 里不带 regionOwners 的那些：眼型 key3–key6、三个体型）
  const expressions = new Map();
  for (const item of asArray(layer.expressions)) {
    if (!item || !item.name) continue;
    expressions.set(String(item.name), {
      name: String(item.name),
      writes: asArray(item.writes).map((w) => ({ param: String(w.param), value: Number(w.value), blend: String(w.blend || 'Add') })),
    });
  }
  const exprGroup = new Map();
  const groups = [];
  for (const conflict of asArray(layer.conflicts)) {
    if (!conflict || asArray(conflict.regionOwners).length) continue; // 前倾这类归模块，走转换
    const members = asArray(conflict.expressions).map(String).filter((n) => expressions.has(n));
    if (members.length < 2) continue;
    const id = 'g' + groups.length + ':' + asArray(conflict.params).join('/');
    groups.push({ id, params: asArray(conflict.params).map(String), expressions: members });
    for (const n of members) exprGroup.set(n, id);
  }
  // 表情写到模块参数（裙长切换 → torso Clothes1 等）：记下来，和模块直写冲突时模块优先
  const exprRegionWrites = new Map();
  for (const [n, e] of expressions) {
    const hits = [];
    for (const w of e.writes) {
      const home = paramHome.get(w.param);
      if (home && BRIDGE_REGIONS.includes(home)) hits.push({ region: home, param: w.param });
    }
    if (hits.length) exprRegionWrites.set(n, hits);
  }
  const bodyTypeExpressions = new Set();
  for (const [n, e] of expressions) {
    if (e.writes.some((w) => FORM_PARAMS.includes(w.param))) bodyTypeExpressions.add(n);
  }
  const conversions = {};
  for (const [n, conv] of Object.entries(EXPRESSION_REGION_CONVERSIONS)) {
    if (!expressions.has(n)) continue;
    const r = regions[conv.region];
    if (r && r.writable.has(conv.param)) conversions[n] = conv;
  }

  return {
    modelId: String(table.modelId || ''),
    regions,
    motionRegion,
    physicsOutputs,
    paramHome,
    redline,
    blink,
    expressions,
    exprGroup,
    groups,
    exprRegionWrites,
    bodyTypeExpressions,
    conversions,
    armPairs: asArray(table.motionArmConflicts && table.motionArmConflicts.pairs)
      .filter((p) => p && p.shareArm === true)
      .map((p) => [String(p.a), String(p.b)]),
  };
}

/** 表里的成对冲突（motionArmConflicts）作为 shareArm 缺省实现；overlay 会注入渲染端 motionsShareArm。 */
export function tableShareArm(compiled) {
  return function shareArm(a, b) {
    const x = motionSlotBase(a) || String(a || '');
    const y = motionSlotBase(b) || String(b || '');
    if (!x || !y) return false;
    if (x === y) return true;
    return compiled.armPairs.some(([p, q]) => (p === x && q === y) || (p === y && q === x));
  };
}

function normPriority(value) {
  if (value === undefined || value === null || value === '') return { ok: true, value: 'NORMAL' };
  const key = String(value).trim().toUpperCase();
  const k = PRI_ALIASES[key] || key;
  if (BRIDGE_PRIORITY_RANK[k] === undefined) return { ok: false };
  return { ok: true, value: k };
}

function err(stepIndex, reason, detail, extra) {
  const e = { reason, detail: String(detail || '') };
  if (stepIndex !== null && stepIndex !== undefined) e.stepIndex = stepIndex;
  if (extra) Object.assign(e, extra);
  return e;
}

/**
 * 静态校验 + 归一化一条联动指令（宿主和 overlay 都调它；不看占用状态）。
 * 成功返回 { ok:true, command, warnings }，command.steps 已归一：
 *   { region, kind:'motion', motion, index }
 *   { region, kind:'set', set:{id:value}, durationMs, convertedFrom? }
 *   { layer:'expression', kind:'expression', expression, on }
 *   { layer:'form', kind:'form', form }
 * 失败返回 { ok:false, reason, errors:[{stepIndex, reason, detail}] }，reason 取第一条。
 */
export function validateBridgeCommand(compiled, input) {
  if (!compiled) return { ok: false, reason: 'table-unavailable', errors: [err(null, 'table-unavailable', '分区表未加载')] };
  if (!isPlainObject(input)) return { ok: false, reason: 'invalid-command', errors: [err(null, 'invalid-command', '指令必须是对象')] };
  const errors = [];
  const warnings = [];
  const pri = normPriority(input.priority);
  if (!pri.ok) errors.push(err(null, 'invalid-priority', String(input.priority)));
  const source = input.source === undefined ? 'llm' : String(input.source);
  if (!BRIDGE_SOURCES.includes(source)) errors.push(err(null, 'invalid-source', source));
  const onBusy = input.onBusy === undefined ? 'reject' : String(input.onBusy);
  if (onBusy !== 'reject' && onBusy !== 'wait') errors.push(err(null, 'invalid-command', 'onBusy 只能是 reject 或 wait'));
  let waitMs = 0;
  if (onBusy === 'wait') {
    waitMs = input.waitMs === undefined ? DEFAULT_WAIT_MS : Number(input.waitMs);
    if (!Number.isFinite(waitMs) || waitMs < 0) errors.push(err(null, 'invalid-command', 'waitMs 必须是非负数'));
    waitMs = Math.min(MAX_WAIT_MS, Math.max(0, Math.floor(waitMs) || 0));
  }
  const rawSteps = input.steps;
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    errors.push(err(null, 'empty-steps', 'steps 至少一步'));
  } else if (rawSteps.length > MAX_STEPS) {
    errors.push(err(null, 'invalid-command', 'steps 最多 ' + MAX_STEPS + ' 步'));
  }
  const steps = [];
  const regionSeen = new Map();
  const groupSeen = new Map();
  let formStep = -1;
  const bodyTypeOn = [];
  asArray(rawSteps).slice(0, MAX_STEPS).forEach((raw, i) => {
    if (!isPlainObject(raw)) {
      errors.push(err(i, 'invalid-step', '每一步必须是对象'));
      return;
    }
    let step = null;
    if (raw.layer !== undefined && raw.region !== undefined) {
      errors.push(err(i, 'invalid-step', 'region 与 layer 只能二选一'));
      return;
    }
    if (raw.layer !== undefined) {
      const layer = String(raw.layer);
      if (!BRIDGE_LAYERS.includes(layer)) {
        errors.push(err(i, 'unknown-layer', layer));
        return;
      }
      if (layer === 'form') {
        const f = raw.form;
        if (typeof f !== 'number' || !Number.isInteger(f) || f < 0 || f > FORM_INDEX_MAX) {
          errors.push(err(i, 'invalid-form', String(f)));
          return;
        }
        if (formStep >= 0) {
          errors.push(err(i, 'invalid-step', '一条指令只能有一个形态步'));
          return;
        }
        formStep = i;
        step = { layer: 'form', kind: 'form', form: f };
      } else {
        const name = typeof raw.expression === 'string' ? raw.expression : '';
        if (!compiled.expressions.has(name)) {
          errors.push(err(i, 'unknown-expression', name));
          return;
        }
        const on = raw.on === undefined ? true : raw.on === true;
        if (raw.on !== undefined && typeof raw.on !== 'boolean') {
          errors.push(err(i, 'invalid-step', 'on 必须是布尔值'));
          return;
        }
        const conv = compiled.conversions[name];
        if (conv) {
          // 前倾 / 脱鞋：改走模块指令（模块优先），不进表情层
          const set = {};
          set[conv.param] = on ? conv.on : conv.off;
          step = { region: conv.region, kind: 'set', set, durationMs: 0, convertedFrom: name };
          warnings.push('expression-converted:' + name + '->' + conv.region);
        } else {
          const g = compiled.exprGroup.get(name);
          if (on && g) {
            if (groupSeen.has(g) && groupSeen.get(g) !== name) {
              errors.push(err(i, 'expression-conflict', name + ' 与 ' + groupSeen.get(g) + ' 互斥（同写 ' + g.split(':')[1] + '）', { with: groupSeen.get(g) }));
              return;
            }
            groupSeen.set(g, name);
          }
          if (on && compiled.bodyTypeExpressions.has(name)) bodyTypeOn.push({ i, name });
          step = { layer: 'expression', kind: 'expression', expression: name, on };
        }
      }
    } else if (raw.region !== undefined) {
      const region = String(raw.region);
      const r = compiled.regions[region];
      if (!r) {
        errors.push(err(i, 'unknown-region', region));
        return;
      }
      const hasMotion = raw.motion !== undefined;
      const hasSet = raw.set !== undefined;
      if (hasMotion === hasSet) {
        errors.push(err(i, 'invalid-step', '模块步必须且只能带 motion 或 set 其一'));
        return;
      }
      if (hasMotion) {
        const motion = typeof raw.motion === 'string' ? raw.motion : '';
        const home = compiled.motionRegion.get(motion);
        if (!home) {
          errors.push(err(i, 'unknown-motion', motion));
          return;
        }
        if (home !== region) {
          errors.push(err(i, 'motion-not-in-region', motion + ' 属于 ' + home + '，不属于 ' + region, { expectedRegion: home }));
          return;
        }
        if (motion === 'Idle') warnings.push('idle-motion');
        const index = raw.index === undefined ? 0 : Number(raw.index);
        step = { region, kind: 'motion', motion, index: Number.isInteger(index) && index >= 0 ? index : 0 };
      } else {
        if (!isPlainObject(raw.set) || !Object.keys(raw.set).length) {
          errors.push(err(i, 'invalid-step', 'set 必须是非空对象 {参数:值}'));
          return;
        }
        const set = {};
        let bad = false;
        for (const [id, value] of Object.entries(raw.set)) {
          const reason = writeDenyReason(compiled, region, id);
          if (reason) {
            errors.push(err(i, reason.reason, id + '：' + reason.detail, { param: id }));
            bad = true;
            continue;
          }
          const num = Number(value);
          if (typeof value !== 'number' || !Number.isFinite(num)) {
            errors.push(err(i, 'invalid-value', id + '=' + String(value), { param: id }));
            bad = true;
            continue;
          }
          if (compiled.blink.has(id)) warnings.push('eye-blink-engine:' + id);
          set[id] = num;
        }
        if (bad) return;
        let durationMs = raw.durationMs === undefined ? 0 : Number(raw.durationMs);
        if (!Number.isFinite(durationMs) || durationMs < 0) {
          errors.push(err(i, 'invalid-value', 'durationMs=' + String(raw.durationMs)));
          return;
        }
        durationMs = Math.min(MAX_SET_DURATION_MS, Math.floor(durationMs));
        step = { region, kind: 'set', set, durationMs };
      }
    } else {
      errors.push(err(i, 'invalid-step', '每一步要么带 region，要么带 layer'));
      return;
    }
    if (step && step.region) {
      if (regionSeen.has(step.region)) {
        errors.push(err(i, 'duplicate-region', step.region + ' 在第 ' + regionSeen.get(step.region) + ' 步已出现；同一模块一条指令只能一步'));
        return;
      }
      regionSeen.set(step.region, i);
    }
    if (step) steps.push(step);
  });
  // 表情写模块参数（裙长切换 / 胸口衣服）与同指令里该模块直写同一参数：模块优先，表情拒绝
  for (const s of steps) {
    if (s.kind !== 'expression' || !s.on) continue;
    for (const hit of compiled.exprRegionWrites.get(s.expression) || []) {
      const other = steps.find((x) => x.region === hit.region && x.kind === 'set' && Object.prototype.hasOwnProperty.call(x.set, hit.param));
      if (other) errors.push(err(null, 'expression-conflict', s.expression + ' 与 ' + hit.region + ' 直写 ' + hit.param + ' 冲突（模块优先）'));
    }
  }
  // 形态步与体型表情同一条：形态优先
  if (formStep >= 0 && bodyTypeOn.length) {
    for (const b of bodyTypeOn) errors.push(err(b.i, 'expression-conflict', b.name + ' 与形态步冲突（形态优先，改用 layer:form）'));
  }
  if (bodyTypeOn.length) warnings.push('prefer-form-layer');
  if (errors.length) return { ok: false, reason: errors[0].reason, errors };
  return {
    ok: true,
    command: { source, priority: pri.value, onBusy, waitMs, steps },
    warnings,
  };
}

/** 某参数能不能由某模块直写；能写返回 null，否则返回 {reason, detail}。 */
export function writeDenyReason(compiled, region, id) {
  const key = String(id);
  if (compiled.redline.has(key)) return { reason: 'lipsync-redline', detail: '口型红线，任何模块都不能写' };
  if (compiled.physicsOutputs.has(key)) return { reason: 'param-not-writable', detail: '物理输出只读，请改写它的物理输入' };
  if (FORM_PARAMS.includes(key)) return { reason: 'param-not-writable', detail: '形态参数归 form 层，请用 {layer:"form", form}' };
  const home = compiled.paramHome.get(key);
  if (home === 'unassigned') return { reason: 'param-not-writable', detail: '未分区参数（尾巴/兽耳/饰品等），第一版不开放' };
  if (home === 'expressionLayer') return { reason: 'param-not-writable', detail: '表情层开关键，请用 {layer:"expression"}' };
  if (home === 'shared') return { reason: 'param-not-writable', detail: '共享参数，不由模块直写' };
  const r = compiled.regions[region];
  if (!home) return { reason: 'param-not-writable', detail: '表里没有这个参数' };
  if (home !== region) return { reason: 'param-not-writable', detail: '属于 ' + home + ' 模块，不属于 ' + region };
  if (!r || !r.writable.has(key)) return { reason: 'param-not-writable', detail: region + ' 模块不开放这个参数' };
  return null;
}

/** 给人和 LLM 看的模块能力摘要（MCP 工具描述、GET state 都用它）。 */
export function describeRegions(compiled) {
  const out = {};
  for (const name of BRIDGE_REGIONS) {
    const r = compiled.regions[name];
    out[name] = {
      label: r.label,
      motions: r.motions.slice(),
      writable: [...r.writable],
    };
  }
  return {
    regions: out,
    expression: {
      expressions: [...compiled.expressions.keys()].filter((n) => !compiled.conversions[n]),
      mutexGroups: compiled.groups.map((g) => ({ params: g.params.slice(), expressions: g.expressions.slice() })),
      converted: Object.fromEntries(Object.entries(compiled.conversions).map(([n, c]) => [n, c.region + '.' + c.param])),
    },
    form: { params: FORM_PARAMS.slice(), index: [0, FORM_INDEX_MAX] },
  };
}

function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

/**
 * 创建一个 bridge 实例（占用状态机）。实例只在 overlay 里有一个——那是权威。
 *
 * @param {object} table body-regions.json
 * @param {{shareArm?: (a:string,b:string)=>boolean, idPrefix?: string}} [options]
 */
export function createBridge(table, options = {}) {
  const compiled = compileBodyTable(table);
  const shareArm = typeof options.shareArm === 'function' ? options.shareArm : tableShareArm(compiled);
  const idPrefix = options.idPrefix || 'bc-';
  let seq = 0;
  /** region → { commandId, priority, source, kind, motion?, startedAt, borrowed[] } */
  const holders = new Map();
  /** commandId → { id, source, priority, pending:Set<target>, steps, createdAt } */
  const commands = new Map();
  /** set 插值：region → { commandId, from:{}, to:{}, startedAt, durationMs } */
  const tweens = new Map();
  /** bridge 最近一次写出的值（叠加参数的插值起点：渲染端粘滞保持着这个偏移）。 */
  const lastWritten = new Map();
  /** 等待队列：[{ commandId, command, deadline, enqueuedAt }] */
  const queue = [];
  /** 表情层：当前生效的表情（渲染端是单槽，新表情会淡入替换旧表情）及其来源。 */
  let expression = null; // { name, commandId, priority, group }
  /** 最近事件环（GET state 带出，便于观察）。 */
  const recent = [];

  function rank(p) {
    return BRIDGE_PRIORITY_RANK[p] || 0;
  }

  function pushEvent(list, ev) {
    list.push(ev);
    recent.push(ev);
    while (recent.length > 50) recent.shift();
  }

  function doneEvent(commandId, target, phase, extra) {
    const ev = { type: 'action-done', phase, commandId, runId: commandId };
    if (BRIDGE_REGIONS.includes(target)) ev.region = target;
    else ev.layer = target;
    if (extra) Object.assign(ev, extra);
    return ev;
  }

  function commandActive(id) {
    const c = commands.get(id);
    return !!(c && c.pending.size);
  }

  function holderView(h) {
    return h ? { commandId: h.commandId, priority: h.priority, source: h.source } : null;
  }

  /** 只判占用，不改状态：返回 { ok, busy[], preempt[] }。 */
  function judge(command) {
    const busy = [];
    const preempt = [];
    const incoming = rank(command.priority);
    for (const s of command.steps) {
      if (!s.region) continue;
      const h = holders.get(s.region);
      if (!h) continue;
      if (incoming > rank(h.priority)) preempt.push({ region: s.region, ...holderView(h) });
      else busy.push({ region: s.region, holder: holderView(h), convertedFrom: s.convertedFrom });
    }
    // 表情层：只在互斥组内判冲突；当前表情来自仍在执行、且优先级不低于本指令的另一条指令时拒绝
    for (const s of command.steps) {
      if (s.kind !== 'expression' || !s.on || !expression) continue;
      const g = compiled.exprGroup.get(s.expression);
      if (!g || g !== expression.group || expression.name === s.expression) continue;
      if (commandActive(expression.commandId) && rank(expression.priority) >= incoming) {
        busy.push({ layer: 'expression', expression: expression.name, holder: { commandId: expression.commandId, priority: expression.priority }, conflict: true });
      }
    }
    // 表情写模块参数：该模块正被别的指令直写同一参数 → 模块优先
    for (const s of command.steps) {
      if (s.kind !== 'expression' || !s.on) continue;
      for (const hit of compiled.exprRegionWrites.get(s.expression) || []) {
        const tw = tweens.get(hit.region);
        const h = holders.get(hit.region);
        if (h && tw && Object.prototype.hasOwnProperty.call(tw.to, hit.param)) {
          busy.push({ layer: 'expression', expression: s.expression, region: hit.region, param: hit.param, holder: holderView(h), conflict: true });
        }
      }
    }
    return { ok: busy.length === 0, busy, preempt };
  }

  function busyReason(busy) {
    return busy.some((b) => b.conflict || b.convertedFrom) ? 'expression-conflict' : 'region-busy';
  }

  /** 成对动作收尾：要打开的动作与已打开的槽共用手臂 → 先播那个槽的关闭动作（只收这一只手）。 */
  function armCloses(motion, slots) {
    if (!isOpenMotion(motion) || !isPlainObject(slots)) return [];
    const base = motionSlotBase(motion);
    const closes = [];
    for (const [slot, state] of Object.entries(slots)) {
      if (state !== 'open' || slot === base) continue;
      if (!shareArm(slot + '打开', motion)) continue;
      const close = slot + '关闭';
      if (compiled.motionRegion.has(close)) closes.push(close);
    }
    return closes;
  }

  /** 真正落账：抢占、登记占用、生成执行计划。调用前 judge 必须通过。 */
  function commit(command, ctx, warnings) {
    const now = Number(ctx.now) || 0;
    const id = idPrefix + ++seq;
    const events = [];
    const preempted = [];
    for (const s of command.steps) {
      if (!s.region) continue;
      const h = holders.get(s.region);
      if (h && h.commandId !== id) {
        preempted.push({ region: s.region, commandId: h.commandId, priority: h.priority, source: h.source });
        finishTarget(h.commandId, s.region, 'interrupted', { reason: 'preempted', by: id }, events);
      }
    }
    const rec = { id, source: command.source, priority: command.priority, pending: new Set(), steps: command.steps, createdAt: now };
    commands.set(id, rec);
    const plan = [];
    const accepted = [];
    for (const s of command.steps) {
      if (s.region) {
        const holder = { commandId: id, priority: command.priority, source: command.source, kind: s.kind, startedAt: now, borrowed: [] };
        if (s.kind === 'motion') {
          holder.motion = s.motion;
          // 手部动作播放期间 Param56/57（以及动作曲线里其它未分区参数）算手部的，结束才还 Idle
          const m = asArray(table.motions).find((x) => x && x.group === s.motion);
          holder.borrowed = asArray(m && m.alsoWrites).map((w) => String(w.param));
          plan.push({ region: s.region, kind: 'motion', motion: s.motion, index: s.index, closeFirst: armCloses(s.motion, ctx.slots) });
        } else {
          const to = { ...s.set };
          const from = {};
          const read = typeof ctx.read === 'function' ? (ctx.read(Object.keys(to)) || {}) : {};
          for (const pid of Object.keys(to)) {
            if (ADDITIVE_INPUT_PARAMS.includes(pid)) {
              from[pid] = lastWritten.has(pid) ? lastWritten.get(pid) : 0;
            } else {
              from[pid] = Number.isFinite(Number(read[pid])) ? Number(read[pid]) : to[pid];
            }
          }
          tweens.set(s.region, { commandId: id, from, to, current: { ...from }, startedAt: now, durationMs: s.durationMs });
          plan.push({ region: s.region, kind: 'set', set: to, durationMs: s.durationMs, convertedFrom: s.convertedFrom });
        }
        holders.set(s.region, holder);
        rec.pending.add(s.region);
        accepted.push(s.region);
      } else if (s.kind === 'expression') {
        const g = compiled.exprGroup.get(s.expression) || '';
        let replaces = null;
        if (s.on) {
          if (expression && expression.name !== s.expression) {
            replaces = expression.name;
            if (!g || g !== expression.group) warnings.push('expression-single-slot:' + expression.name);
          }
          expression = { name: s.expression, commandId: id, priority: command.priority, group: g };
        }
        const active = !!(expression && expression.name === s.expression);
        if (!s.on && active) expression = null;
        plan.push({ layer: 'expression', kind: 'expression', expression: s.expression, on: s.on, replaces, wasActive: s.on ? undefined : active });
        rec.pending.add('expression');
        accepted.push('expression');
      } else if (s.kind === 'form') {
        const clearExpression = !!(expression && compiled.bodyTypeExpressions.has(expression.name));
        if (clearExpression) {
          warnings.push('form-overrides-body-expression:' + expression.name);
          expression = null;
        }
        plan.push({ layer: 'form', kind: 'form', form: s.form, clearExpression });
        rec.pending.add('form');
        accepted.push('form');
      }
    }
    return {
      ok: true,
      commandId: id,
      accepted,
      preempted,
      warnings,
      priority: command.priority,
      source: command.source,
      plan,
      events,
    };
  }

  /** 某目标（模块或层）完成/中断；返回是否真的结算了（被抢占后迟到的完成回调会返回 false）。 */
  function finishTarget(commandId, target, phase, extra, events) {
    const rec = commands.get(commandId);
    if (!rec || !rec.pending.has(target)) return false;
    rec.pending.delete(target);
    if (BRIDGE_REGIONS.includes(target)) {
      const h = holders.get(target);
      if (h && h.commandId === commandId) holders.delete(target);
      const tw = tweens.get(target);
      if (tw && tw.commandId === commandId && phase !== 'end') tweens.delete(target);
    }
    pushEvent(events, doneEvent(commandId, target, phase, extra));
    if (!rec.pending.size) {
      // 保留短暂记录供 release(commandId) 幂等返回；超过 200 条时丢最老的
      if (commands.size > 200) {
        for (const key of commands.keys()) {
          if (!commands.get(key).pending.size) {
            commands.delete(key);
            break;
          }
        }
      }
    }
    return true;
  }

  function pumpQueue(ctx) {
    const now = Number(ctx.now) || 0;
    const admitted = [];
    const expired = [];
    for (let i = 0; i < queue.length; ) {
      const item = queue[i];
      const verdict = judge(item.command);
      if (verdict.ok) {
        queue.splice(i, 1);
        const res = commit(item.command, ctx, item.warnings.slice());
        res.waitedMs = Math.max(0, now - item.enqueuedAt);
        res.ticket = item.ticket;
        admitted.push(res);
        continue;
      }
      if (now >= item.deadline) {
        queue.splice(i, 1);
        expired.push({ ok: false, reason: 'region-busy', timeout: true, ticket: item.ticket, waitedMs: Math.max(0, now - item.enqueuedAt), busy: verdict.busy, warnings: item.warnings.slice() });
        continue;
      }
      i++;
    }
    return { admitted, expired };
  }

  let ticketSeq = 0;

  return {
    compiled,
    describe: () => describeRegions(compiled),

    /** 只做静态校验（不看占用）。 */
    validate: (input) => validateBridgeCommand(compiled, input),

    /**
     * 下发一条联动指令。
     * ctx：{ now, slots?: 渲染端成对槽位 open/closed, read?: (ids)=>当前参数值 }
     * 返回：
     *   成功 { ok:true, commandId, accepted, preempted, warnings, plan, events }
     *   排队 { ok:true, queued:true, ticket, deadline, busy, warnings }（onBusy:'wait'）
     *   失败 { ok:false, reason, errors? | busy?, warnings }
     */
    act(input, ctx = {}) {
      const v = validateBridgeCommand(compiled, input);
      if (!v.ok) return { ok: false, reason: v.reason, errors: v.errors, warnings: [] };
      const command = v.command;
      const verdict = judge(command);
      if (verdict.ok) return commit(command, ctx, v.warnings.slice());
      if (command.onBusy === 'wait' && command.waitMs > 0) {
        const now = Number(ctx.now) || 0;
        const ticket = 'bw-' + ++ticketSeq;
        queue.push({ ticket, command, deadline: now + command.waitMs, enqueuedAt: now, warnings: v.warnings.slice() });
        return { ok: true, queued: true, ticket, deadline: now + command.waitMs, busy: verdict.busy, warnings: v.warnings.slice() };
      }
      return { ok: false, reason: busyReason(verdict.busy), busy: verdict.busy, warnings: v.warnings.slice() };
    },

    /**
     * 执行端回报：某模块 / 层做完（end）、失败（failed）、跳过（skipped 视作 end 带 note）。
     * 返回 { settled, events, admitted, expired }——settled=false 表示该模块已被抢占或释放（迟到回调，忽略）。
     */
    complete(commandId, target, phase = 'end', extra, ctx = {}) {
      const events = [];
      const ph = phase === 'failed' ? 'failed' : phase === 'interrupted' ? 'interrupted' : 'end';
      const settled = finishTarget(String(commandId), String(target), ph, extra, events);
      const pumped = settled ? pumpQueue(ctx) : { admitted: [], expired: [] };
      return { settled, events, ...pumped };
    },

    /**
     * 释放：{ commandId } 一次释放该指令占着的全部模块（及未完成的层）；{ region } 释放单个模块。
     * 被释放的目标发 action-done phase:'interrupted' reason:'released'。
     */
    release(selector = {}, ctx = {}) {
      const events = [];
      const released = [];
      const sel = isPlainObject(selector) ? selector : {};
      if (sel.commandId !== undefined && sel.commandId !== null && sel.commandId !== '') {
        const id = String(sel.commandId);
        const rec = commands.get(id);
        const queuedIdx = queue.findIndex((q) => q.ticket === id);
        if (queuedIdx >= 0) {
          queue.splice(queuedIdx, 1);
          return { ok: true, released: [], dequeued: id, events, admitted: [], expired: [] };
        }
        if (!rec) return { ok: false, reason: 'not-found', released, events, admitted: [], expired: [] };
        for (const target of [...rec.pending]) {
          if (finishTarget(id, target, 'interrupted', { reason: 'released' }, events)) released.push({ target, commandId: id });
        }
      } else if (sel.region !== undefined) {
        const region = String(sel.region);
        if (!BRIDGE_REGIONS.includes(region)) return { ok: false, reason: 'unknown-region', released, events, admitted: [], expired: [] };
        const h = holders.get(region);
        if (h && finishTarget(h.commandId, region, 'interrupted', { reason: 'released' }, events)) released.push({ target: region, commandId: h.commandId });
      } else {
        return { ok: false, reason: 'invalid-command', released, events, admitted: [], expired: [] };
      }
      const pumped = pumpQueue(ctx);
      return { ok: true, released, events, ...pumped };
    },

    /**
     * 每帧推进（overlay 在 preLateUpdateHook 里调）：
     *   - set 的 durationMs 插值算出本帧要写的值（writes），插值到头的模块结算 end；
     *   - 等待队列：能拿到模块的出队执行（admitted），超过 waitMs 的判 region-busy（expired）。
     * 返回 { writes:{id:value}, events, admitted, expired }。
     */
    frame(ctx = {}) {
      const now = Number(ctx.now) || 0;
      const writes = {};
      const events = [];
      for (const [region, tw] of tweens) {
        const holder = holders.get(region);
        const live = holder && holder.commandId === tw.commandId;
        const span = tw.durationMs;
        const t = span > 0 ? Math.max(0, Math.min(1, (now - tw.startedAt) / span)) : 1;
        const k = easeInOut(t);
        for (const pid of Object.keys(tw.to)) {
          const v = tw.from[pid] + (tw.to[pid] - tw.from[pid]) * k;
          tw.current[pid] = v;
          writes[pid] = v;
          lastWritten.set(pid, v);
        }
        if (t >= 1) {
          // 到头：写最后一次（渲染端 injector 粘滞保持该值），然后不再每帧写
          tweens.delete(region);
          if (live) finishTarget(tw.commandId, region, 'end', undefined, events);
        }
      }
      const pumped = pumpQueue(ctx);
      return { writes, events, ...pumped };
    },

    /**
     * 只推进等待队列（不算插值、不产生写入）：渲染暂停时 overlay 用定时器调它，
     * 保证 waitMs 超时照样判定。插值只能在 frame()（preLateUpdateHook）里推进。
     */
    pump(ctx = {}) {
      return pumpQueue(ctx);
    },

    /** 是否还有需要每帧推进的东西（插值或排队）。 */
    busy() {
      return tweens.size > 0 || queue.length > 0;
    },

    /** 状态快照（GET /dsh-l2d/api/bridge/state、l2d_regions_get 用）。 */
    snapshot(ctx = {}) {
      const now = Number(ctx.now) || 0;
      const regions = {};
      for (const name of BRIDGE_REGIONS) {
        const h = holders.get(name);
        regions[name] = h
          ? {
              busy: true,
              commandId: h.commandId,
              priority: h.priority,
              source: h.source,
              kind: h.kind,
              motion: h.motion,
              heldMs: Math.max(0, now - h.startedAt),
              borrowed: h.borrowed.slice(),
              tween: tweens.has(name) ? { to: { ...tweens.get(name).to }, durationMs: tweens.get(name).durationMs } : undefined,
            }
          : { busy: false };
      }
      return {
        modelId: compiled.modelId,
        regions,
        expression: expression ? { name: expression.name, commandId: expression.commandId, priority: expression.priority } : null,
        queue: queue.map((q) => ({ ticket: q.ticket, priority: q.command.priority, source: q.command.source, remainingMs: Math.max(0, q.deadline - now) })),
        recentEvents: recent.slice(-20),
      };
    },

    /** 外部（右键「恢复默认脸」、l2d_reset）清了表情时同步表情层。 */
    noteExpressionCleared() {
      expression = null;
    },
  };
}
