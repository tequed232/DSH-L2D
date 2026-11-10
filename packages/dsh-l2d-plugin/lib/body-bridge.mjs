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
export const BRIDGE_LAYERS = Object.freeze(['expression', 'form', 'accessory']);
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
  'unknown-accessory',
  'unknown-mood',
  'unknown-face-unit',
  'unknown-dimension',
  'unknown-recipe',
  'face-units-unavailable',
  'expression-conflict',
  'invalid-form',
  'region-busy',
  'wait-timeout',
  'superseded',
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

/**
 * 饰品层（body-regions.json accessories）：
 *   - 所有饰品可同时穿戴（accessories.policy.compatibility = all-compatible），槽位只做分组显示，不判冲突；
 *   - 每件单独开关：戴新的不摘旧的，关一件只写它自己的 off 值（表情类按 fadeMs 淡出），其他饰品不动；
 *   - 参数归腿部 / 躯干模块的（鞋、裙长、胸口衣服）转成该模块的 set（模块仲裁照旧），饰品层只开关；
 *   - 其余有表情的（眼镜、钢盆、尾巴）由表情层按「饰品表情」处理：直接写表情的开关键，
 *     不进渲染端单槽表情管理器，所以彼此、以及与脸部表情都不互斥；
 *   - 只有参数开关的（飘花、逸散光点、麦克风光、钱）直接写开关参数；
 *   - 没有可切换项的槽（兽耳、翅膀）、uncertain、体型都不对外暴露。
 */
export const ACCESSORY_FADE_MS = 300;

/**
 * 神态组合（docs/nodegraph/models/<模型>/face-units.json，旧名 face-vocab.json）：
 *   步骤 {region:'face', compose:{units?, dimensions?, recipes?, side?, energy?, expressions?, autoExpressions?, enterMs?, holdMs?}}
 *   或   {region:'face', mood:'<配方名>'}（= compose:{recipes:{<配方名>:1}}）。
 *   - 部件权重 = 显式 units + Σ 维度强度 × 维度内部件权重 + Σ 配方比例 × 配方部件权重；夹到 0..1（head_turn 夹到 -1..1）；
 *   - energy = 显式值；否则按维度强度（与配方比例）加权平均各自的 energy；都没有时 0.3；
 *   - 侧向：lateral 部件写入值乘 s（L=+1，R=-1）；有 mirror 的在 R 时交换左右参数；一条指令统一一个 side；
 *   - 叠加：value = neutral + Σ 权重 × (写入值 − neutral)，夹到 range；相反部件同时给出自然抵消；
 *   - 摆动：幅度 = 量程 × 0.03 × (0.5 + energy)，周期 = [4100…8900][参数序号 % 8] × (1.3 − 0.6·energy)；
 *   - 进入 enterMs（缺省 1000）渐入，退出 600ms 渐回 neutral，然后以 weight 0 中和粘滞值交还引擎；
 *   - 写 ParamEyeLOpen/ROpen 时 bridge 自带眨眼：开度 = value × 眨眼系数（0..1），不会拉回全睁；
 *   - 表情型部件（脸红 / 流泪 / 爱心眼）与维度超阈值（expressionAt）的表情走表情层，不占 face；
 *   - 每个参数的模块一律按 body-regions.json 判定：face 之外的（LeanInput → torso）一起占用；
 *     那个模块被同级或更高优先级占着时跳过涉及它的参数，记进 blocked，face 其余照常；
 *   - 不可写的参数（口型红线 ParamMouthForm、neverWrite、物理输出等）记进 blocked，同一部件的其余参数照写。
 */
export const FACE_UNITS_FILES = Object.freeze(['face-units.json', 'face-vocab.json']);
export const COMPOSE_ENTER_MS = 1000;
export const COMPOSE_EXIT_MS = 600;
export const COMPOSE_DEFAULT_ENERGY = 0.3;
export const COMPOSE_SWAY_PERIODS = Object.freeze([4100, 5300, 5900, 6300, 6700, 7300, 7900, 8900]);
/** 自带眨眼的节奏（与 CubismEyeBlink 缺省接近：闭 100ms、合 50ms、睁 150ms，间隔 2.5–6s 随机）。 */
export const COMPOSE_BLINK = Object.freeze({ closingMs: 100, closedMs: 50, openingMs: 150, minIntervalMs: 2500, maxIntervalMs: 6000 });

/**
 * 在一组候选文件名里挑第一个存在的（先 face-units.json，再 face-vocab.json）。
 * @param {(name:string)=>boolean} exists
 * @returns {string|null}
 */
export function pickFaceUnitsFile(exists, names = FACE_UNITS_FILES) {
  for (const n of names) if (exists(n)) return n;
  return null;
}

function expandNeverWrite(obj) {
  const out = new Set();
  const keys = Array.isArray(obj) ? obj : isPlainObject(obj) ? Object.keys(obj) : [];
  for (const k of keys) {
    const key = String(k);
    // 「ParamAngleX/Y/Z」→ ParamAngleX、ParamAngleY、ParamAngleZ
    const m = key.match(/^(.*?)([A-Za-z0-9])((?:\/[A-Za-z0-9])+)$/);
    if (m) {
      out.add(m[1] + m[2]);
      for (const suf of m[3].split('/').filter(Boolean)) out.add(m[1] + suf);
    } else out.add(key);
  }
  return out;
}

function num(x, d) {
  const n = Number(x);
  return Number.isFinite(n) ? n : d;
}

/** 编译神态部件表；表形状不对返回 null。 */
export function compileFaceUnits(compiled, file) {
  if (!isPlainObject(file) || !isPlainObject(file.params) || !isPlainObject(file.actionUnits)) return null;
  const params = new Map();
  let order = 0;
  for (const [id, raw] of Object.entries(file.params)) {
    if (!isPlainObject(raw)) continue;
    const range = Array.isArray(raw.range) && raw.range.length === 2 ? raw.range.map(Number) : [-Infinity, Infinity];
    params.set(id, {
      id,
      meaning: String(raw.meaning || ''),
      min: Math.min(range[0], range[1]),
      max: Math.max(range[0], range[1]),
      neutral: num(raw.neutral, 0),
      order: order++,
    });
  }
  const neverWrite = expandNeverWrite(file.neverWrite);
  // 参数路由：按 body-regions.json 判定模块与可写性
  const route = new Map();
  const routeOf = (id) => {
    if (route.has(id)) return route.get(id);
    let r;
    if (neverWrite.has(id)) r = { blocked: compiled.redline.has(id) ? 'lipsync-redline' : 'param-not-writable', detail: 'face-units neverWrite' };
    else {
      const home = compiled.paramHome.get(id);
      const region = home && BRIDGE_REGIONS.includes(home) ? home : 'face';
      const deny = writeDenyReason(compiled, region, id);
      r = deny ? { blocked: deny.reason, detail: deny.detail } : { region };
    }
    route.set(id, r);
    return r;
  };
  const negativeUnits = new Set();
  const dimRaw = isPlainObject(file.dimensions) ? file.dimensions : {};
  for (const line of asArray(dimRaw.combine)) {
    const m = String(line).match(/([a-z_]+)\s*夹到\s*-1\s*\.\.\s*1/);
    if (m) negativeUnits.add(m[1]);
  }
  const units = new Map();
  for (const [id, raw] of Object.entries(file.actionUnits)) {
    if (!isPlainObject(raw) || !isPlainObject(raw.writes)) continue;
    const writes = {};
    for (const [pid, v] of Object.entries(raw.writes)) if (Number.isFinite(Number(v))) writes[pid] = Number(v);
    const mirror = {};
    if (isPlainObject(raw.mirror)) for (const [x, y] of Object.entries(raw.mirror)) { mirror[x] = String(y); mirror[String(y)] = x; }
    units.set(id, {
      id,
      name: String(raw['名'] || raw.name || id),
      conveys: String(raw['传达'] || ''),
      writes,
      lateral: raw.lateral === true,
      mirror,
      opposes: raw.opposes ? String(raw.opposes) : '',
    });
  }
  const exprUnits = new Map();
  for (const [id, raw] of Object.entries(isPlainObject(file.expressionsAsAU) ? file.expressionsAsAU : {})) {
    if (!isPlainObject(raw) || typeof raw.expression !== 'string') continue;
    exprUnits.set(id, { id, name: String(raw['名'] || id), conveys: String(raw['传达'] || ''), expression: raw.expression });
  }
  const dimensions = new Map();
  for (const [name, raw] of Object.entries(isPlainObject(dimRaw.table) ? dimRaw.table : {})) {
    if (!isPlainObject(raw) || !isPlainObject(raw.units)) continue;
    dimensions.set(name, {
      name,
      units: Object.fromEntries(Object.entries(raw.units).map(([u, w]) => [u, num(w, 0)])),
      energy: num(raw.energy, COMPOSE_DEFAULT_ENERGY),
      expressions: asArray(raw.expressions).map(String),
      expressionAt: num(raw.expressionAt, Infinity),
    });
  }
  const recipes = new Map();
  for (const [name, raw] of Object.entries(isPlainObject(file.recipes) ? file.recipes : {})) {
    if (!isPlainObject(raw) || !isPlainObject(raw.aus)) continue;
    recipes.set(name, {
      name,
      aus: Object.fromEntries(Object.entries(raw.aus).map(([u, w]) => [u, num(w, 0)])),
      energy: num(raw.energy, COMPOSE_DEFAULT_ENERGY),
      expressions: asArray(raw.expressions).map(String),
    });
  }
  return { params, units, exprUnits, dimensions, recipes, negativeUnits, neverWrite, routeOf, raw: file };
}

function normWeights(input, keyName, valueName) {
  // 对象 {k: v} 或数组 [{unit|dimension, intensity}]
  if (input === undefined) return { ok: true, list: [] };
  if (isPlainObject(input)) return { ok: true, list: Object.entries(input).map(([k, v]) => ({ key: k, value: v })) };
  if (Array.isArray(input)) return { ok: true, list: input.map((x) => (isPlainObject(x) ? { key: x[keyName], value: x[valueName] === undefined ? 1 : x[valueName], direction: x.direction } : { key: undefined })) };
  return { ok: false };
}

/**
 * 神态组合换算（纯函数，静态：不看占用）。
 * @returns {{ok:true, units, energy, side, expressions, params:[{id,value,meaning,region,contributions,amp,periodMs,min,max,neutral}], blocked, warnings} | {ok:false, errors}}
 */
export function composeFace(fc, spec) {
  const errors = [];
  const warnings = [];
  if (!fc) return { ok: false, errors: [{ reason: 'face-units-unavailable', detail: '该模型没有 face-units.json（或 face-vocab.json）' }] };
  if (!isPlainObject(spec)) return { ok: false, errors: [{ reason: 'invalid-step', detail: 'compose 必须是对象' }] };
  const side = spec.side === undefined ? 'L' : String(spec.side).toUpperCase();
  if (side !== 'L' && side !== 'R') errors.push({ reason: 'invalid-value', detail: "side 只能是 'L' 或 'R'" });
  const s = side === 'R' ? -1 : 1;
  const w = new Map();
  const add = (u, v) => w.set(u, (w.get(u) || 0) + v);
  const energySum = { num: 0, den: 0 };
  const expressions = [];
  const pushExpr = (name, why) => { if (!expressions.some((e) => e.name === name)) expressions.push({ name, why }); };
  const autoExpr = spec.autoExpressions !== false;

  const u = normWeights(spec.units, 'unit', 'intensity');
  if (!u.ok) errors.push({ reason: 'invalid-step', detail: 'units 必须是对象或数组' });
  for (const it of u.list) {
    const v = Number(it.value);
    if (!fc.units.has(it.key) && !fc.exprUnits.has(it.key)) errors.push({ reason: 'unknown-face-unit', detail: String(it.key) });
    else if (!Number.isFinite(v)) errors.push({ reason: 'invalid-value', detail: it.key + '=' + String(it.value) });
    else add(it.key, v);
    if (it.direction !== undefined) warnings.push('unit-direction-ignored:' + it.key + '（同一指令统一用 side）');
  }
  const d = normWeights(spec.dimensions, 'dimension', 'intensity');
  if (!d.ok) errors.push({ reason: 'invalid-step', detail: 'dimensions 必须是对象或数组' });
  for (const it of d.list) {
    const dim = fc.dimensions.get(it.key);
    const v = Number(it.value);
    if (!dim) { errors.push({ reason: 'unknown-dimension', detail: String(it.key) }); continue; }
    if (!Number.isFinite(v) || v < 0) { errors.push({ reason: 'invalid-value', detail: it.key + '=' + String(it.value) }); continue; }
    const k = Math.min(1, v);
    for (const [unit, uw] of Object.entries(dim.units)) add(unit, k * uw);
    energySum.num += k * dim.energy;
    energySum.den += k;
    if (autoExpr && k >= dim.expressionAt) for (const e of dim.expressions) pushExpr(e, 'dimension:' + dim.name);
  }
  const r = normWeights(spec.recipes, 'recipe', 'ratio');
  if (!r.ok) errors.push({ reason: 'invalid-step', detail: 'recipes 必须是对象或数组' });
  for (const it of r.list) {
    const rec = fc.recipes.get(it.key);
    const v = Number(it.value);
    if (!rec) { errors.push({ reason: 'unknown-recipe', detail: String(it.key) }); continue; }
    if (!Number.isFinite(v) || v < 0) { errors.push({ reason: 'invalid-value', detail: it.key + '=' + String(it.value) }); continue; }
    for (const [unit, uw] of Object.entries(rec.aus)) add(unit, v * uw);
    energySum.num += v * rec.energy;
    energySum.den += v;
    if (autoExpr && v >= 0.5) for (const e of rec.expressions) pushExpr(e, 'recipe:' + rec.name);
  }
  for (const e of asArray(spec.expressions)) pushExpr(String(e), 'explicit');
  if (spec.expressions !== undefined && !Array.isArray(spec.expressions)) errors.push({ reason: 'invalid-step', detail: 'expressions 必须是数组' });
  for (const unit of w.keys()) if (!fc.units.has(unit) && !fc.exprUnits.has(unit)) errors.push({ reason: 'unknown-face-unit', detail: unit + '（维度或配方引用了表里没有的部件）' });
  let energy;
  if (spec.energy !== undefined) {
    energy = Number(spec.energy);
    if (!Number.isFinite(energy)) errors.push({ reason: 'invalid-value', detail: 'energy=' + String(spec.energy) });
    energy = Math.max(0, Math.min(1, energy || 0));
  } else energy = energySum.den > 0 ? energySum.num / energySum.den : COMPOSE_DEFAULT_ENERGY;
  if (errors.length) return { ok: false, errors };

  // 夹权重；表情型部件 → 表情层
  const units = {};
  for (const [unit, v] of w) {
    const lo = fc.negativeUnits.has(unit) ? -1 : 0;
    const cv = Math.max(lo, Math.min(1, v));
    if (cv === 0) continue;
    units[unit] = cv;
    const eu = fc.exprUnits.get(unit);
    if (eu && cv > 0) pushExpr(eu.expression, 'unit:' + unit);
  }
  // 叠加
  const acc = new Map(); // param → { sum, contributions[] }
  const blockedMap = new Map();
  for (const [unit, cw] of Object.entries(units)) {
    const au = fc.units.get(unit);
    if (!au) continue;
    for (const [pid0, raw] of Object.entries(au.writes)) {
      let pid = pid0;
      let v = raw;
      if (au.lateral) {
        if (au.mirror[pid0]) { if (s < 0) pid = au.mirror[pid0]; }
        else v = raw * s;
      }
      const rt = fc.routeOf(pid);
      if (rt.blocked) {
        const b = blockedMap.get(pid) || { param: pid, reason: rt.blocked, detail: rt.detail, units: [] };
        if (!b.units.includes(unit)) b.units.push(unit);
        blockedMap.set(pid, b);
        continue;
      }
      const meta = fc.params.get(pid) || { neutral: 0, min: -Infinity, max: Infinity, meaning: '', order: fc.params.size };
      const a = acc.get(pid) || { sum: 0, contributions: [], region: rt.region, meta };
      const amount = cw * (v - meta.neutral);
      a.sum += amount;
      a.contributions.push({ unit, amount });
      acc.set(pid, a);
    }
  }
  const params = [];
  for (const [pid, a] of acc) {
    const m = a.meta;
    const value = Math.max(m.min, Math.min(m.max, m.neutral + a.sum));
    const span = Number.isFinite(m.max - m.min) ? m.max - m.min : 0;
    params.push({
      id: pid,
      value,
      meaning: m.meaning,
      region: a.region,
      contributions: a.contributions,
      neutral: m.neutral,
      min: m.min,
      max: m.max,
      amp: span * 0.03 * (0.5 + energy),
      periodMs: COMPOSE_SWAY_PERIODS[m.order % COMPOSE_SWAY_PERIODS.length] * (1.3 - 0.6 * energy),
    });
  }
  params.sort((x, y) => (fc.params.get(x.id)?.order ?? 999) - (fc.params.get(y.id)?.order ?? 999));
  if (!params.length) warnings.push('compose-empty');
  return { ok: true, units, energy, side, expressions, params, blocked: [...blockedMap.values()], warnings };
}

/** compose 回执里给前端 / LLM 看的形状。 */
export function composeView(c) {
  return {
    units: { ...c.units },
    energy: c.energy,
    side: c.side,
    expressions: c.expressions.map((e) => e.name),
    written: c.params.map((p) => ({ param: p.id, value: p.value, meaning: p.meaning, region: p.region, contributions: p.contributions.map((x) => ({ ...x })) })),
    blocked: c.blocked.map((b) => ({ ...b, units: b.units ? b.units.slice() : undefined })),
  };
}

/**
 * 反推：当前参数值 → 各部件强度（按量程归一后做非负最小二乘；head_turn 允许 -1..1）。
 * 侧向部件两侧都试，取残差小的。表情型部件按 activeExpressions 给 1。
 * @param {object} fc compileFaceUnits 结果
 * @param {Record<string, number>} values 当前参数值
 * @param {{activeExpressions?: string[], minWeight?: number}} [opts]
 */
export function describeFace(fc, values, opts = {}) {
  if (!fc) return { ok: false, reason: 'face-units-unavailable' };
  const minWeight = opts.minWeight === undefined ? 0.05 : opts.minWeight;
  const pids = [...fc.params.keys()].filter((p) => !fc.routeOf(p).blocked && Number.isFinite(Number(values && values[p])));
  const norm = (p) => {
    const m = fc.params.get(p);
    const span = m.max - m.min;
    return Number.isFinite(span) && span > 0 ? span : 1;
  };
  const y = pids.map((p) => (Number(values[p]) - fc.params.get(p).neutral) / norm(p));
  function solve(sign) {
    const ids = [...fc.units.keys()];
    const cols = ids.map((uid) => {
      const au = fc.units.get(uid);
      const col = pids.map(() => 0);
      for (const [p0, raw] of Object.entries(au.writes)) {
        let p = p0;
        let v = raw;
        if (au.lateral) {
          if (au.mirror[p0]) { if (sign < 0) p = au.mirror[p0]; }
          else v = raw * sign;
        }
        const i = pids.indexOf(p);
        if (i >= 0) col[i] += (v - fc.params.get(p).neutral) / norm(p);
      }
      return col;
    });
    const wts = ids.map(() => 0);
    const resid = y.slice();
    for (let iter = 0; iter < 300; iter++) {
      let moved = 0;
      for (let j = 0; j < ids.length; j++) {
        const c = cols[j];
        let cc = 0;
        let cr = 0;
        for (let i = 0; i < c.length; i++) { cc += c[i] * c[i]; cr += c[i] * resid[i]; }
        if (cc === 0) continue;
        const lo = fc.negativeUnits.has(ids[j]) ? -1 : 0;
        const nw = Math.max(lo, Math.min(1, wts[j] + cr / cc));
        const dw = nw - wts[j];
        if (dw !== 0) {
          for (let i = 0; i < c.length; i++) resid[i] -= dw * c[i];
          wts[j] = nw;
          moved = Math.max(moved, Math.abs(dw));
        }
      }
      if (moved < 1e-7) break;
    }
    const residual = Math.sqrt(resid.reduce((a, b) => a + b * b, 0));
    return { ids, wts, residual };
  }
  const L = solve(1);
  const R = solve(-1);
  const best = R.residual + 1e-9 < L.residual ? { ...R, side: 'R' } : { ...L, side: 'L' };
  const units = [];
  best.ids.forEach((uid, j) => {
    const v = best.wts[j];
    if (Math.abs(v) >= minWeight) units.push({ unit: uid, name: fc.units.get(uid).name, weight: Math.round(v * 1000) / 1000 });
  });
  for (const name of asArray(opts.activeExpressions)) {
    for (const eu of fc.exprUnits.values()) if (eu.expression === name) units.push({ unit: eu.id, name: eu.name, weight: 1, expression: name });
  }
  units.sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
  return {
    ok: true,
    side: best.side,
    units,
    residual: Math.round(best.residual * 1000) / 1000,
    params: pids,
    summary: units.map((x) => x.name + (Math.round(Math.abs(x.weight) * 10) / 10)).join('、'),
  };
}

/**
 * 动作衔接（不排队，在合适位置衔接）：
 *   onBusy: 'reject' | 'wait' | 'blend'（缺省 blend）；cut: 'now' | 'next' | 'after'（缺省 next）；fadeMs 200–400（缺省 300）。
 *   - 同模块最多一条待执行（pending），新的顶替旧的，旧的回执 / 事件 reason:'superseded'；
 *   - 低优先级不能 now / next 打断高优先级：一律按 after（等它播完；超过 waitMs 判 region-busy）；
 *   - 动作数据（motion-cutpoints.json）：abortBefore 之前可立即中止（手势不变）；abortBefore..chainFrom 之间
 *     HIGH/FORCE 立即切（手势按已切换算），NORMAL/LOW 等到 chainFrom；到 chainFrom 立即交叉淡入；anytime（Idle）随时可切；
 *   - 没有标注的动作：用自动检测的衔接点兜底；手部动作与没有标注的动作 cut:'next' 最长等 600ms，
 *     超时按高优先级处理（立即切，手势按已切换算，先补播「关闭」再接）；
 *   - 两个非默认手势之间禁止直接交叉淡变（Movement* 开关切图层）：一律按 handStates 路径「先关后开」，cut:'now' 也一样；
 *   - cut:'now' 立即切（仍受优先级约束）；cut:'after' 等旧动作播完；
 *   - 神态 / 表情 / 饰品 / set 是持续写值，blend 时直接渐变到新目标；
 *   - 手部按 handStates 状态图跟踪手势，换手势自动插过渡（抚胸→竖手指 = 「抚胸手关闭」在它的 chainFrom 接「竖手指打开」）。
 */
export const BRIDGE_ON_BUSY = Object.freeze(['reject', 'wait', 'blend']);
export const BRIDGE_CUTS = Object.freeze(['now', 'next', 'after']);
export const BLEND_FADE_MS = Object.freeze({ min: 200, max: 400, default: 300 });
/** 没有标注数据的动作，cut:'next' 最多等这么久就强制切。 */
export const UNANNOTATED_MAX_WAIT_MS = 600;
const STRONG_PRIORITIES = new Set(['HIGH', 'FORCE']);

const secMs = (x) => (x === null || x === undefined || !Number.isFinite(Number(x)) ? null : Math.round(Number(x) * 1000));

/**
 * 编译动作衔接数据：motion-cutpoints.json（标注，优先）+ 自动检测（兜底）。
 * @returns {{motions: Map<string, {durationMs, loop, abortBeforeMs, chainFromMs, anytime, fadeInMs, fadeOutMs, cutPointsMs, source}>, gestures: null | {states, edges: Map, motionEdge: Map<motion,{from,to}>, initial}}}
 */
export function compileMotionCuts(file, autoCuts) {
  const motions = new Map();
  const raw = isPlainObject(file) && isPlainObject(file.motions) ? file.motions : {};
  for (const [group, m] of Object.entries(raw)) {
    if (!isPlainObject(m)) continue;
    motions.set(group, {
      durationMs: secMs(m.durationSec),
      loop: m.loop === true,
      abortBeforeMs: secMs(m.abortBeforeSec),
      chainFromMs: secMs(m.chainFromSec),
      anytime: m.anytime === true,
      fadeInMs: secMs(m.fadeInSec),
      fadeOutMs: secMs(m.fadeOutSec),
      cutPointsMs: asArray(m.cutWindowsSec).map((w) => secMs(Array.isArray(w) ? w[0] : w)).filter((x) => x !== null),
      source: 'file',
    });
  }
  for (const [group, a] of Object.entries(isPlainObject(autoCuts) ? autoCuts : {})) {
    if (motions.has(group) || !isPlainObject(a)) continue;
    motions.set(group, {
      durationMs: Number.isFinite(Number(a.durationMs)) ? Number(a.durationMs) : null,
      loop: a.loop === true,
      abortBeforeMs: null,
      chainFromMs: null,
      anytime: false,
      fadeInMs: Number.isFinite(Number(a.fadeInMs)) ? Number(a.fadeInMs) : null,
      fadeOutMs: null,
      cutPointsMs: asArray(a.cutPointsMs).map(Number).filter(Number.isFinite),
      source: 'auto',
    });
  }
  let gestures = null;
  const hs = isPlainObject(file) && isPlainObject(file.handStates) ? file.handStates : null;
  if (hs && isPlainObject(hs.edges)) {
    const edges = new Map();
    const motionEdge = new Map();
    for (const [key, list] of Object.entries(hs.edges)) {
      const m = String(key).split('→');
      if (m.length !== 2 || !Array.isArray(list) || !list.length) continue;
      edges.set(key, list.map(String));
      if (list.length === 1) motionEdge.set(String(list[0]), { from: m[0], to: m[1] });
    }
    const states = asArray(hs.states).map(String);
    gestures = { states, edges, motionEdge, initial: states[0] || '默认' };
  }
  return { motions, gestures };
}

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
export function compileBodyTable(table, options = {}) {
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
  const accRaw = isPlainObject(table.accessories) ? table.accessories : {};
  for (const id of asArray(accRaw.physicsOutputs)) physicsOutputs.add(String(id));
  for (const id of asArray(accRaw.params)) if (!paramHome.has(String(id))) paramHome.set(String(id), 'accessories');
  for (const slot of asArray(accRaw.slots)) for (const id of asArray(slot && slot.params)) if (!paramHome.has(String(id))) paramHome.set(String(id), 'accessories');
  for (const u of asArray(accRaw.uncertain)) for (const id of asArray(u && u.params)) if (!paramHome.has(String(id))) paramHome.set(String(id), 'accessories');

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

  // 饰品：只收有可切换项的槽；items 编译成 { id, slot, via:'region'|'expression'|'param', param, on, off, ... }
  const accessorySlots = [];
  const accessoryItems = new Map();
  const accessoryByExpression = new Map(); // 饰品表情名 → item（表情层按饰品处理，不进单槽表情管理器）
  const accessoryByParam = new Map(); // 开关参数 → item（模块直写同一参数时同步佩戴状态）
  for (const slot of asArray(accRaw.slots)) {
    if (!slot || !slot.id) continue;
    const items = [];
    for (const it of asArray(slot.items)) {
      if (!it || !it.id || accessoryItems.has(String(it.id))) continue;
      const on = Number(it.on);
      const off = Number(it.off);
      if (!Number.isFinite(on) || !Number.isFinite(off)) continue;
      const base = { id: String(it.id), label: String(it.label || it.id), slot: String(slot.id), slotLabel: String(slot.label || slot.id), on, off };
      let item = null;
      if (it.kind === 'expression') {
        const ref = String(it.ref || '');
        const e = expressions.get(ref);
        if (!e || bodyTypeExpressions.has(ref)) continue; // 体型不算饰品
        const param = String(it.writesParam || (e.writes[0] && e.writes[0].param) || '');
        if (!param || physicsOutputs.has(param) || redline.has(param) || FORM_PARAMS.includes(param)) continue;
        // 表情「应用」对应哪一端：表情写入值等于 on → 应用=戴上；等于 off → 应用=摘下（尾巴开关）
        const w = e.writes.find((x) => x.param === param);
        const appliedIsOn = !(w && w.value === off && w.value !== on);
        const home = paramHome.get(param);
        if (home && BRIDGE_REGIONS.includes(home)) {
          if (!regions[home].writable.has(param)) continue;
          item = { ...base, via: 'region', region: home, param, expression: ref, appliedIsOn };
          if (!conversions[ref]) {
            conversions[ref] = Object.freeze({ region: home, param, on: appliedIsOn ? on : off, off: appliedIsOn ? off : on });
          }
        } else {
          item = { ...base, via: 'expression', param, expression: ref, appliedIsOn };
          accessoryByExpression.set(ref, item);
        }
      } else if (it.kind === 'param') {
        const param = String(it.ref || '');
        if (!param || physicsOutputs.has(param) || redline.has(param) || FORM_PARAMS.includes(param)) continue;
        const home = paramHome.get(param);
        if (home && BRIDGE_REGIONS.includes(home)) continue; // 参数开关落在模块里的没有，有也不由饰品层直写
        item = { ...base, via: 'param', param };
      }
      if (!item) continue;
      items.push(item);
      accessoryItems.set(item.id, item);
      accessoryByParam.set(item.param, item);
    }
    if (items.length) accessorySlots.push({ id: String(slot.id), label: String(slot.label || slot.id), items });
  }

  const result = {
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
    accessorySlots,
    accessoryItems,
    accessoryByExpression,
    accessoryByParam,
    face: null,
    armPairs: asArray(table.motionArmConflicts && table.motionArmConflicts.pairs)
      .filter((p) => p && p.shareArm === true)
      .map((p) => [String(p.a), String(p.b)]),
  };
  if (options && options.faceUnits) result.face = compileFaceUnits(result, options.faceUnits);
  return result;
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
  const onBusy = input.onBusy === undefined ? 'blend' : String(input.onBusy);
  if (!BRIDGE_ON_BUSY.includes(onBusy)) errors.push(err(null, 'invalid-command', 'onBusy 只能是 reject、wait 或 blend'));
  const cut = input.cut === undefined ? 'next' : BRIDGE_CUTS.includes(String(input.cut)) ? String(input.cut) : '';
  if (!cut) errors.push(err(null, 'invalid-command', 'cut 只能是 now、next 或 after'));
  let fadeMs = input.fadeMs === undefined ? BLEND_FADE_MS.default : Number(input.fadeMs);
  if (!Number.isFinite(fadeMs)) errors.push(err(null, 'invalid-value', 'fadeMs=' + String(input.fadeMs)));
  fadeMs = Math.max(BLEND_FADE_MS.min, Math.min(BLEND_FADE_MS.max, Math.round(fadeMs) || BLEND_FADE_MS.default));
  let waitMs = 0;
  if (onBusy === 'wait' || onBusy === 'blend') {
    waitMs = input.waitMs === undefined ? (onBusy === 'wait' ? DEFAULT_WAIT_MS : MAX_WAIT_MS) : Number(input.waitMs);
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
  const accSeen = new Set();
  const composeExpressions = [];
  const composeSteps = [];
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
      if (layer === 'accessory') {
        const itemId = typeof raw.item === 'string' ? raw.item : '';
        const item = compiled.accessoryItems.get(itemId);
        if (!item) {
          errors.push(err(i, 'unknown-accessory', itemId || '(缺 item)'));
          return;
        }
        if (raw.slot !== undefined && String(raw.slot) !== item.slot) {
          errors.push(err(i, 'unknown-accessory', itemId + ' 属于槽 ' + item.slot + '，不属于 ' + String(raw.slot), { expectedSlot: item.slot }));
          return;
        }
        if (raw.on !== undefined && typeof raw.on !== 'boolean') {
          errors.push(err(i, 'invalid-step', 'on 必须是布尔值'));
          return;
        }
        const on = raw.on === undefined ? true : raw.on;
        let durationMs = raw.durationMs === undefined ? (item.via === 'expression' ? ACCESSORY_FADE_MS : 0) : Number(raw.durationMs);
        if (!Number.isFinite(durationMs) || durationMs < 0) {
          errors.push(err(i, 'invalid-value', 'durationMs=' + String(raw.durationMs)));
          return;
        }
        durationMs = Math.min(MAX_SET_DURATION_MS, Math.floor(durationMs));
        step = accessoryStep(item, on, durationMs, warnings);
        if (step.kind === 'accessory') {
          if (accSeen.has(item.id)) {
            errors.push(err(i, 'invalid-step', '饰品 ' + item.id + ' 在一条指令里出现了两次'));
            return;
          }
          accSeen.add(item.id);
        }
      } else if (layer === 'form') {
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
        const accItem = compiled.accessoryByExpression.get(name);
        if (accItem) {
          // 饰品表情（眼镜 / 钢盆 / 尾巴开关）：按饰品开关处理，彼此不互斥，也不替换脸部表情
          step = accessoryStep(accItem, accItem.appliedIsOn ? on : !on, ACCESSORY_FADE_MS, warnings);
          warnings.push('expression-as-accessory:' + name + '->' + accItem.id);
          if (accSeen.has(accItem.id)) {
            errors.push(err(i, 'invalid-step', '饰品 ' + accItem.id + ' 在一条指令里出现了两次'));
            return;
          }
          accSeen.add(accItem.id);
        } else if (conv) {
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
      const hasMood = raw.mood !== undefined;
      const hasCompose = raw.compose !== undefined;
      if (Number(hasMotion) + Number(hasSet) + Number(hasMood) + Number(hasCompose) !== 1) {
        errors.push(err(i, 'invalid-step', '模块步必须且只能带 motion、set、compose、mood 其一'));
        return;
      }
      if (hasMood || hasCompose) {
        if (region !== 'face') {
          errors.push(err(i, 'invalid-step', 'compose / mood 只能用于 face 模块'));
          return;
        }
        let spec = raw.compose;
        let label = 'compose';
        if (hasMood) {
          const name = typeof raw.mood === 'string' ? raw.mood : '';
          if (!compiled.face || !compiled.face.recipes.has(name)) {
            errors.push(err(i, compiled.face ? 'unknown-mood' : 'face-units-unavailable', name || '(缺 mood)'));
            return;
          }
          spec = { recipes: { [name]: 1 } };
          label = name;
        }
        const c = composeFace(compiled.face, spec);
        if (!c.ok) {
          for (const e of c.errors) errors.push(err(i, e.reason, e.detail));
          return;
        }
        for (const wn of c.warnings) warnings.push(wn);
        let enterMs = isPlainObject(spec) && spec.enterMs !== undefined ? Number(spec.enterMs) : raw.durationMs !== undefined ? Number(raw.durationMs) : COMPOSE_ENTER_MS;
        let holdMs = isPlainObject(spec) && spec.holdMs !== undefined ? Number(spec.holdMs) : 0;
        if (!Number.isFinite(enterMs) || enterMs < 0 || !Number.isFinite(holdMs) || holdMs < 0) {
          errors.push(err(i, 'invalid-value', 'enterMs / holdMs 必须是非负数'));
          return;
        }
        enterMs = Math.min(MAX_SET_DURATION_MS, Math.floor(enterMs));
        holdMs = Math.floor(holdMs);
        for (const e of c.expressions) composeExpressions.push({ i, name: e.name, on: true, why: e.why });
        step = { region, kind: 'compose', label, compose: c, enterMs, exitMs: COMPOSE_EXIT_MS, holdMs };
        composeSteps.push(step);
      } else if (hasMotion) {
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
  // 神态组合：face 之外的参数（LeanInput → torso）跟同条该模块的显式步撞车 → 跳过并记进 blocked
  for (const cs of composeSteps) {
    const keep = [];
    for (const pr of cs.compose.params) {
      if (pr.region !== 'face' && steps.some((x) => x !== cs && x.region === pr.region)) {
        cs.compose.blocked.push({ param: pr.id, reason: 'duplicate-region', region: pr.region, units: pr.contributions.map((x) => x.unit) });
      } else keep.push(pr);
    }
    cs.compose.params = keep;
    cs.extraRegions = [...new Set(keep.map((pr) => pr.region).filter((r) => r !== 'face'))];
  }
  // 神态组合的伴随表情（表情型部件 / 维度超阈值 / 配方 / 显式）：追加为表情层步骤，不占 face
  for (const me of composeExpressions) {
    if (steps.some((x) => x.kind === 'expression' && x.expression === me.name)) continue;
    if (!compiled.expressions.has(me.name) || compiled.conversions[me.name] || compiled.accessoryByExpression.has(me.name)) {
      errors.push(err(me.i, 'unknown-expression', '伴随表情 ' + me.name + ' 不是表情层表情'));
      continue;
    }
    const g = compiled.exprGroup.get(me.name);
    if (g) {
      if (groupSeen.has(g) && groupSeen.get(g) !== me.name) {
        errors.push(err(me.i, 'expression-conflict', '伴随表情 ' + me.name + ' 与 ' + groupSeen.get(g) + ' 互斥'));
        continue;
      }
      groupSeen.set(g, me.name);
    }
    steps.push({ layer: 'expression', kind: 'expression', expression: me.name, on: true, accompanies: 'compose' });
  }
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
    command: { source, priority: pri.value, onBusy, cut: cut || 'next', fadeMs, waitMs, steps },
    warnings,
  };
}

/** 饰品开关 → 归一化步：参数归模块的转成模块 set（模块仲裁），其余是饰品层步。 */
function accessoryStep(item, on, durationMs, warnings) {
  const value = on ? item.on : item.off;
  if (item.via === 'region') {
    warnings.push('accessory-via-region:' + item.id + '->' + item.region);
    return { region: item.region, kind: 'set', set: { [item.param]: value }, durationMs, convertedFrom: item.expression, accessory: item.id };
  }
  return { layer: 'accessory', kind: 'accessory', item: item.id, slot: item.slot, on, param: item.param, value, via: item.via, durationMs };
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
  if (home === 'accessories') return { reason: 'param-not-writable', detail: '饰品参数，请用 {layer:"accessory", item, on}（只开放可切换项）' };
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
      expressions: [...compiled.expressions.keys()].filter((n) => !compiled.conversions[n] && !compiled.accessoryByExpression.has(n)),
      mutexGroups: compiled.groups.map((g) => ({ params: g.params.slice(), expressions: g.expressions.slice() })),
      converted: Object.fromEntries(Object.entries(compiled.conversions).map(([n, c]) => [n, c.region + '.' + c.param])),
      asAccessory: Object.fromEntries([...compiled.accessoryByExpression].map(([n, it]) => [n, it.id])),
    },
    accessory: {
      compatibility: 'all-compatible',
      slots: compiled.accessorySlots.map((sl) => ({
        id: sl.id,
        label: sl.label,
        items: sl.items.map((it) => ({ id: it.id, label: it.label, via: it.via === 'region' ? 'region:' + it.region : it.via, param: it.param, expression: it.expression })),
      })),
    },
    form: { params: FORM_PARAMS.slice(), index: [0, FORM_INDEX_MAX] },
    face: compiled.face
      ? {
          params: [...compiled.face.params.values()].map((x) => {
            const rt = compiled.face.routeOf(x.id);
            return { id: x.id, meaning: x.meaning, range: [x.min, x.max], neutral: x.neutral, region: rt.region, blocked: rt.blocked };
          }),
          units: [...compiled.face.units.values()].map((x) => ({ id: x.id, name: x.name, conveys: x.conveys, lateral: x.lateral, opposes: x.opposes || undefined })),
          expressionUnits: [...compiled.face.exprUnits.values()].map((x) => ({ id: x.id, name: x.name, expression: x.expression })),
          dimensions: [...compiled.face.dimensions.keys()],
          recipes: [...compiled.face.recipes.keys()],
        }
      : null,
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
  const compiled = compileBodyTable(table, { faceUnits: options.faceUnits });
  const random = typeof options.random === 'function' ? options.random : Math.random;
  const cuts = compileMotionCuts(options.motionCuts, options.autoCuts);
  /** 手势状态（handStates）：settled = 已落定的手势；进行中的过渡看 hands 占用者的 timeline。 */
  let gestureSettled = cuts.gestures ? cuts.gestures.initial : null;
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
  /** 饰品层：itemId → 插值 { commandId, param, from, to, startedAt, durationMs }；佩戴记录 itemId → bool。 */
  const accTweens = new Map();
  const worn = new Map();
  /** 神态预设：当前（占着 face 的）与正在退出的。 */
  /** 神态组合：region → { commandId, label, params:[{id,value,amp,periodMs,min,max,neutral,from}], startedAt, enterMs, exitMs, holdMs, holdAt, blink }。 */
  const composes = new Map();
  let lastNow = 0; // 最近一次调用带来的时钟（退出插值从「被释放/抢占的那一刻」起算）
  const composeExits = []; // [{ label, region, params:[{id, from, to}], startedAt, exitMs }]
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
    else if (target.startsWith('accessory:')) {
      ev.layer = 'accessory';
      ev.item = target.slice('accessory:'.length);
    } else ev.layer = target;
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

  function timingOf(motion) {
    return cuts.motions.get(motion) || null;
  }

  /** 占用者此刻正在播 timeline 里的哪一段：{ entry, elapsed, index }；不是动作返回 null。 */
  function currentEntry(h, now) {
    if (!h || !Array.isArray(h.timeline) || !h.timeline.length) return null;
    let cur = h.timeline[0];
    let idx = 0;
    h.timeline.forEach((e, i) => {
      if (now >= e.startAt) {
        cur = e;
        idx = i;
      }
    });
    return { entry: cur, elapsed: Math.max(0, now - cur.startAt), index: idx };
  }

  /** 某时刻的手势：落定值 + hands 占用者 timeline 里已过「姿势开关」（abortBefore）的段。 */
  function gestureAt(now) {
    if (!cuts.gestures) return null;
    let g = gestureSettled;
    const h = holders.get('hands');
    if (h && Array.isArray(h.timeline)) {
      for (const e of h.timeline) {
        const edge = cuts.gestures.motionEdge.get(e.motion);
        if (!edge) continue;
        const t = timingOf(e.motion);
        const sw = t && t.abortBeforeMs !== null ? t.abortBeforeMs : 0;
        if (now >= e.startAt + sw) g = edge.to;
      }
    }
    return g;
  }

  /** 没有手部占用者时，用渲染端成对槽位状态校正手势（开着的槽 = 当前手势）。 */
  function syncGestureFromSlots(slots, now) {
    if (!cuts.gestures || holders.get('hands') || !isPlainObject(slots)) return;
    let g = cuts.gestures.initial;
    for (const [slot, state] of Object.entries(slots)) {
      if (state !== 'open') continue;
      const edge = cuts.gestures.motionEdge.get(slot + '打开');
      if (edge) g = edge.to;
    }
    gestureSettled = g;
  }

  /** 手部换手势的过渡链：当前手势 → 目标手势按状态图插「关闭」；返回 [{motion, offsetMs}]。 */
  function gestureChain(motion, now) {
    if (!cuts.gestures) return null;
    const edge = cuts.gestures.motionEdge.get(motion);
    if (!edge) return null;
    const cur = gestureAt(now);
    let list = [motion];
    if (cur !== edge.from) {
      const path = cuts.gestures.edges.get(cur + '→' + edge.to);
      const home = cuts.gestures.initial;
      if (path) list = path.slice();
      else if (cur === edge.to) list = [];
      else if (cur !== home) {
        // 表里没有直达路径：两个非默认手势之间也不直接交叉淡变，拼「cur→默认」+「默认→目标」
        const down = cuts.gestures.edges.get(cur + '→' + home) || [];
        const up = edge.to === home ? [] : cuts.gestures.edges.get(home + '→' + edge.to) || [motion];
        list = down.concat(up);
      }
    }
    const chain = [];
    let offset = 0;
    list.forEach((m, i) => {
      chain.push({ motion: m, offsetMs: offset });
      const t = timingOf(m);
      if (i < list.length - 1) offset += t ? (t.chainFromMs !== null ? t.chainFromMs : t.durationMs || 0) : 0;
    });
    return { from: cur, to: edge.to, chain };
  }

  /**
   * blend：此刻能不能切（每个被占模块都给一个决定）。
   * 返回 { ready, readyAt (最早可切的绝对时间，null=等播完), cuts:{region:{reason, atMs}} }。
   */
  function blendDecision(command, now, enqueuedAt) {
    const incoming = rank(command.priority);
    let ready = true;
    let readyAt = now;
    const out = {};
    for (const s of command.steps) {
      if (!s.region) continue;
      const h = holders.get(s.region);
      if (!h) continue;
      const cur = currentEntry(h, now);
      const atMs = cur ? Math.round(cur.elapsed) : null;
      if (incoming < rank(h.priority)) {
        // 低优先级不能 now / next 打断高优先级：等它播完
        ready = false;
        readyAt = null;
        out[s.region] = { reason: 'lower-priority-after', atMs };
        continue;
      }
      if (!cur) {
        out[s.region] = { reason: command.cut === 'after' ? 'continuous-after' : 'continuous', atMs: null };
        if (command.cut === 'after') {
          ready = false;
          readyAt = null;
        }
        continue; // 神态 / set / 组合：直接渐变到新目标
      }
      const t = timingOf(cur.entry.motion);
      if (command.cut === 'after') {
        ready = false;
        readyAt = null;
        out[s.region] = { reason: 'after-finish', atMs };
        continue;
      }
      if ((t && t.anytime) || cur.entry.motion === 'Idle') {
        out[s.region] = { reason: 'anytime', atMs };
        continue;
      }
      if (command.cut === 'now') {
        out[s.region] = { reason: 'now', atMs };
        continue;
      }
      // cut:'next'
      if (t && t.source === 'file' && (t.abortBeforeMs !== null || t.chainFromMs !== null)) {
        const ab = t.abortBeforeMs;
        const cf = t.chainFromMs;
        if (ab !== null && cur.elapsed < ab) {
          out[s.region] = { reason: 'abort-before-switch', atMs };
          continue;
        }
        if (cf === null || cur.elapsed >= cf) {
          out[s.region] = { reason: cf === null ? 'no-chain-point' : 'chain-point', atMs };
          continue;
        }
        if (STRONG_PRIORITIES.has(command.priority)) {
          out[s.region] = { reason: 'strong-priority', atMs };
          continue;
        }
        // 手部：等待上限 600ms，超时按高优先级处理
        const capAt = s.region === 'hands' ? enqueuedAt + UNANNOTATED_MAX_WAIT_MS : Infinity;
        if (now >= capAt) {
          out[s.region] = { reason: 'cap-600ms', atMs };
          continue;
        }
        const at = Math.min(cur.entry.startAt + cf, capAt);
        ready = false;
        if (readyAt !== null) readyAt = Math.max(readyAt, at);
        out[s.region] = { reason: 'wait-chain-point', atMs, readyAt: at };
        continue;
      }
      // 没有标注：HIGH/FORCE 抢更低优先级的照旧立即切；其余按自动衔接点兜底，最长 600ms
      if (STRONG_PRIORITIES.has(command.priority) && incoming > rank(h.priority)) {
        out[s.region] = { reason: 'strong-priority', atMs };
        continue;
      }
      const cap = enqueuedAt + UNANNOTATED_MAX_WAIT_MS;
      const next = t ? t.cutPointsMs.find((c) => c >= cur.elapsed) : undefined;
      const at = next === undefined ? cap : Math.min(cap, cur.entry.startAt + next);
      if (now >= at || (next !== undefined && next <= cur.elapsed + 1)) {
        const atCut = next !== undefined && (next <= cur.elapsed + 1 || now >= cur.entry.startAt + next);
        out[s.region] = { reason: atCut ? 'auto-cut' : 'fallback-600ms', atMs };
        continue;
      }
      ready = false;
      if (readyAt !== null) readyAt = Math.max(readyAt, at);
      out[s.region] = { reason: 'wait-auto-cut', atMs, readyAt: at };
    }
    return { ready, readyAt, cuts: out };
  }

  /** 同模块最多一条待执行：新的进来前把碰到同一模块的旧待执行顶掉。 */
  function supersede(command, byTicket) {
    const regions = new Set(command.steps.filter((x) => x.region).map((x) => x.region));
    const gone = [];
    for (let i = 0; i < queue.length; ) {
      const q = queue[i];
      if (q.command.steps.some((x) => x.region && regions.has(x.region))) {
        queue.splice(i, 1);
        gone.push({ ok: false, reason: 'superseded', ticket: q.ticket, by: byTicket, waitedMs: Math.max(0, lastNow - q.enqueuedAt), warnings: q.warnings.slice() });
        pushEvent([], { type: 'bridge-pending', phase: 'superseded', ticket: q.ticket, by: byTicket });
        continue;
      }
      i++;
    }
    return gone;
  }

  /** 真正落账：抢占、登记占用、生成执行计划。调用前 judge 必须通过。 */
  function commit(command, ctx, warnings, blend) {
    const now = Number(ctx.now) || 0;
    const id = idPrefix + ++seq;
    const events = [];
    const preempted = [];
    let cutInfo;
    if (command.onBusy === 'blend') {
      const regs = blend && blend.cuts ? blend.cuts : {};
      const firstCut = Object.values(regs)[0];
      cutInfo = {
        mode: command.cut,
        atMs: firstCut ? firstCut.atMs : null,
        fadeMs: command.fadeMs,
        waitedMs: blend && Number.isFinite(blend.waitedMs) ? blend.waitedMs : 0,
        reason: firstCut ? firstCut.reason : 'free',
        regions: regs,
      };
    }
    // 手势：切之前先按「此刻」落定（已过姿势开关的算已切换，未过的算原手势）
    if (cuts.gestures && command.steps.some((x) => x.region === 'hands')) {
      if (holders.get('hands')) gestureSettled = gestureAt(now);
      else syncGestureFromSlots(ctx.slots, now);
    }
    for (const s of command.steps) {
      if (!s.region) continue;
      const h = holders.get(s.region);
      if (h && h.commandId !== id) {
        preempted.push({ region: s.region, commandId: h.commandId, priority: h.priority, source: h.source });
        // 更高优先级抢占仍叫 preempted；同级经衔接接管叫 blended
        const why = command.onBusy === 'blend' && rank(command.priority) <= rank(h.priority) ? 'blended' : 'preempted';
        finishTarget(h.commandId, s.region, 'interrupted', { reason: why, by: id, atMs: cutInfo && cutInfo.regions[s.region] ? cutInfo.regions[s.region].atMs : undefined }, events);
      }
    }
    const rec = { id, source: command.source, priority: command.priority, pending: new Set(), steps: command.steps, createdAt: now };
    commands.set(id, rec);
    const plan = [];
    const accepted = [];
    let composeResult;
    for (const s of command.steps) {
      if (s.region) {
        const holder = { commandId: id, priority: command.priority, source: command.source, kind: s.kind, startedAt: now, borrowed: [] };
        if (s.kind === 'compose') {
          holder.compose = s.label;
          const c = s.compose;
          const blocked = c.blocked.slice();
          // face 之外的模块：空闲就一起占；能抢就抢；被同级或更高占着就跳过这些参数
          const extraOk = new Set();
          for (const r of s.extraRegions || []) {
            const h2 = holders.get(r);
            if (h2 && h2.commandId !== id && rank(command.priority) <= rank(h2.priority)) {
              for (const pr of c.params) if (pr.region === r) blocked.push({ param: pr.id, reason: 'region-busy', region: r, holder: holderView(h2), units: pr.contributions.map((x) => x.unit) });
              continue;
            }
            if (h2 && h2.commandId !== id) {
              preempted.push({ region: r, commandId: h2.commandId, priority: h2.priority, source: h2.source });
              finishTarget(h2.commandId, r, 'interrupted', { reason: 'preempted', by: id }, events);
            }
            extraOk.add(r);
          }
          const used = c.params.filter((pr) => pr.region === 'face' || extraOk.has(pr.region));
          const ids = used.map((x) => x.id);
          const read = typeof ctx.read === 'function' && ids.length ? ctx.read(ids) || {} : {};
          const byRegion = new Map();
          for (const pr of used) {
            const additive = ADDITIVE_INPUT_PARAMS.includes(pr.id);
            const rv = Number(read[pr.id]);
            const from = additive ? (lastWritten.has(pr.id) ? lastWritten.get(pr.id) : 0) : Number.isFinite(rv) ? rv : pr.neutral;
            if (!byRegion.has(pr.region)) byRegion.set(pr.region, []);
            byRegion.get(pr.region).push({ ...pr, from });
          }
          if (!byRegion.has('face')) byRegion.set('face', []);
          for (const [r, list] of byRegion) {
            const blinkIds = list.filter((x) => compiled.blink.has(x.id)).map((x) => x.id);
            composes.set(r, { commandId: id, label: s.label, params: list, startedAt: now, enterMs: s.enterMs, exitMs: s.exitMs, holdMs: s.holdMs, holdAt: null, blink: blinkIds.length ? { ids: blinkIds, nextAt: null, startedAt: null } : null });
            if (r !== 'face') {
              holders.set(r, { commandId: id, priority: command.priority, source: command.source, kind: 'compose', compose: s.label, startedAt: now, borrowed: [] });
              rec.pending.add(r);
              accepted.push(r);
            }
          }
          composeResult = composeView({ ...c, params: used, blocked });
          plan.push({ region: s.region, kind: 'compose', label: s.label, enterMs: s.enterMs, regions: [...byRegion.keys()] });
        } else if (s.kind === 'motion') {
          holder.motion = s.motion;
          // 手部动作播放期间 Param56/57（以及动作曲线里其它未分区参数）算手部的，结束才还 Idle
          const m = asArray(table.motions).find((x) => x && x.group === s.motion);
          holder.borrowed = asArray(m && m.alsoWrites).map((w) => String(w.param));
          const gc = s.region === 'hands' ? gestureChain(s.motion, now) : null;
          const chain = gc ? gc.chain : [{ motion: s.motion, offsetMs: 0 }];
          holder.timeline = chain.map((c) => ({ motion: c.motion, startAt: now + c.offsetMs }));
          if (gc) holder.gesture = { from: gc.from, to: gc.to };
          const blending = !!(cutInfo && preempted.some((x) => x.region === s.region));
          plan.push({
            region: s.region,
            kind: 'motion',
            motion: s.motion,
            index: s.index,
            chain,
            gesture: gc ? { from: gc.from, to: gc.to } : undefined,
            interrupt: blending || chain.length > 1,
            fadeMs: cutInfo ? cutInfo.fadeMs : undefined,
            // 手势状态图接管换手势时不再按手臂补关；没有状态图时沿用 armCloses
            closeFirst: gc ? [] : blending ? [] : armCloses(s.motion, ctx.slots),
          });
          if (gc && !chain.length) warnings.push('gesture-already:' + gc.to);
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
          plan.push({ region: s.region, kind: 'set', set: to, durationMs: s.durationMs, convertedFrom: s.convertedFrom, accessory: s.accessory });
          // 模块直写饰品开关参数（Clothes4 / Clothes1 / Clothes3）：同步佩戴记录
          for (const pid of Object.keys(to)) {
            const it = compiled.accessoryByParam.get(pid);
            if (!it) continue;
            if (to[pid] === it.on) worn.set(it.id, true);
            else if (to[pid] === it.off) worn.set(it.id, false);
            else worn.delete(it.id);
          }
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
        plan.push({ layer: 'expression', kind: 'expression', expression: s.expression, on: s.on, replaces, wasActive: s.on ? undefined : active, accompanies: s.accompanies });
        rec.pending.add('expression');
        accepted.push('expression');
      } else if (s.kind === 'accessory') {
        // 饰品层不判冲突、不占模块：只登记插值，frame() 写，插值到头结算 end
        const target = 'accessory:' + s.item;
        const prev = accTweens.get(s.item);
        if (prev && prev.commandId !== id) finishTarget(prev.commandId, target, 'interrupted', { reason: 'superseded', by: id }, events);
        const read = typeof ctx.read === 'function' ? (ctx.read([s.param]) || {}) : {};
        const from = Number.isFinite(Number(read[s.param])) ? Number(read[s.param]) : lastWritten.has(s.param) ? lastWritten.get(s.param) : s.value;
        accTweens.set(s.item, { commandId: id, param: s.param, from, to: s.value, startedAt: now, durationMs: s.durationMs });
        worn.set(s.item, s.on);
        plan.push({ layer: 'accessory', kind: 'accessory', item: s.item, slot: s.slot, on: s.on, param: s.param, value: s.value, via: s.via, durationMs: s.durationMs });
        rec.pending.add(target);
        accepted.push(target);
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
      compose: composeResult,
      cut: cutInfo ? { mode: cutInfo.mode, atMs: cutInfo.atMs, fadeMs: cutInfo.fadeMs, waitedMs: cutInfo.waitedMs, reason: cutInfo.reason } : undefined,
      gesture: cuts.gestures && command.steps.some((x) => x.region === 'hands') ? { from: gestureSettled, to: (holders.get('hands') && holders.get('hands').gesture && holders.get('hands').gesture.to) || gestureSettled } : undefined,
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
      if (h && h.commandId === commandId && target === 'hands' && cuts.gestures) {
        gestureSettled = phase === 'end' ? gestureAt(Number.MAX_SAFE_INTEGER) : gestureAt(lastNow);
      }
      if (h && h.commandId === commandId) holders.delete(target);
      const tw = tweens.get(target);
      if (tw && tw.commandId === commandId && phase !== 'end') tweens.delete(target);
      const cs = composes.get(target);
      if (cs && cs.commandId === commandId) {
        // 收尾只针对这个模块：exitMs 内渐回 neutral，再中和粘滞
        composeExits.push({ label: cs.label, region: target, params: cs.params.map((x) => ({ id: x.id, from: lastWritten.has(x.id) ? lastWritten.get(x.id) : x.value, to: x.neutral })), startedAt: lastNow, exitMs: cs.exitMs });
        extra = { ...(extra || {}), compose: cs.label };
        composes.delete(target);
      }
    } else if (target.startsWith('accessory:')) {
      const key = target.slice('accessory:'.length);
      const tw = accTweens.get(key);
      if (tw && tw.commandId === commandId && phase !== 'end') accTweens.delete(key);
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
      if (item.command.onBusy === 'blend') {
        const bd = blendDecision(item.command, now, item.enqueuedAt);
        if (bd.ready) {
          queue.splice(i, 1);
          // 旧占用者已自然结束（after / 低优先级等播完）：回执沿用排队时的判定理由
          const cutsUsed = Object.keys(bd.cuts).length ? bd.cuts : item.lastCuts || {};
          const res = commit(item.command, ctx, item.warnings.slice(), { ...bd, cuts: cutsUsed, waitedMs: Math.max(0, now - item.enqueuedAt) });
          res.waitedMs = Math.max(0, now - item.enqueuedAt);
          res.ticket = item.ticket;
          admitted.push(res);
          continue;
        }
        item.lastCuts = bd.cuts;
        if (now >= item.deadline) {
          queue.splice(i, 1);
          expired.push({ ok: false, reason: 'region-busy', timeout: true, ticket: item.ticket, waitedMs: Math.max(0, now - item.enqueuedAt), cut: { mode: item.command.cut, regions: bd.cuts }, warnings: item.warnings.slice() });
          continue;
        }
        i++;
        continue;
      }
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

  /** state 用：remainingMs（预计还要多久）、nextCutInMs（NORMAL 的 cut:'next' 最早多久后能切）、pending（该模块唯一的待执行）。 */
  function regionTiming(name, h, now) {
    const q = queue.find((x) => x.command.steps.some((st) => st.region === name));
    const pending = q
      ? { ticket: q.ticket, priority: q.command.priority, source: q.command.source, onBusy: q.command.onBusy, cut: q.command.cut, waitedMs: Math.max(0, now - q.enqueuedAt) }
      : null;
    if (!h) return { remainingMs: 0, nextCutInMs: 0, pending };
    const tw = tweens.get(name);
    if (tw && tw.commandId === h.commandId) {
      return { remainingMs: Math.max(0, tw.startedAt + tw.durationMs - now), nextCutInMs: 0, pending };
    }
    const cur = currentEntry(h, now);
    if (!cur) {
      const cs = composes.get(name);
      const remaining = cs && cs.holdMs > 0 ? Math.max(0, (cs.holdAt === null ? cs.startedAt + cs.enterMs : cs.holdAt) + cs.holdMs - now) : null;
      return { remainingMs: remaining, nextCutInMs: 0, pending };
    }
    const last = h.timeline[h.timeline.length - 1];
    const lt = timingOf(last.motion);
    const remainingMs = lt && lt.durationMs !== null ? Math.max(0, last.startAt + lt.durationMs - now) : null;
    const t = timingOf(cur.entry.motion);
    let nextCutInMs = null;
    if ((t && t.anytime) || cur.entry.motion === 'Idle') nextCutInMs = 0;
    else if (t && t.source === 'file') {
      if (t.abortBeforeMs !== null && cur.elapsed < t.abortBeforeMs) nextCutInMs = 0;
      else if (t.chainFromMs === null || cur.elapsed >= t.chainFromMs) nextCutInMs = 0;
      else nextCutInMs = Math.round(t.chainFromMs - cur.elapsed);
    } else {
      const next = t ? t.cutPointsMs.find((c) => c >= cur.elapsed) : undefined;
      nextCutInMs = Math.min(UNANNOTATED_MAX_WAIT_MS, next === undefined ? UNANNOTATED_MAX_WAIT_MS : Math.round(next - cur.elapsed));
    }
    return { remainingMs, nextCutInMs, pending, playing: cur.entry.motion };
  }

  /** 各槽佩戴情况：有 bridge 记录用记录；没有（开机默认、外部改过）就按当前读数离 on/off 哪端近判断。 */
  function accessorySnapshot(ctx) {
    const ids = compiled.accessorySlots.flatMap((sl) => sl.items.map((it) => it.param));
    const read = typeof ctx.read === 'function' && ids.length ? ctx.read(ids) || {} : {};
    return compiled.accessorySlots.map((sl) => {
      const items = sl.items.map((it) => {
        let state = worn.has(it.id) ? worn.get(it.id) : null;
        let from = state === null ? 'unknown' : 'bridge';
        const v = Number(read[it.param]);
        if (state === null && Number.isFinite(v)) {
          const dOn = Math.abs(v - it.on);
          const dOff = Math.abs(v - it.off);
          if (dOn !== dOff) {
            state = dOn < dOff;
            from = 'read';
          }
        }
        const out = { id: it.id, label: it.label, worn: state, stateFrom: from, via: it.via === 'region' ? 'region:' + it.region : it.via, param: it.param };
        if (accTweens.has(it.id)) out.fading = true;
        return out;
      });
      return { slot: sl.id, label: sl.label, worn: items.filter((x) => x.worn === true).map((x) => x.id), items };
    });
  }

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
      lastNow = Number(ctx.now) || lastNow;
      const v = validateBridgeCommand(compiled, input);
      if (!v.ok) return { ok: false, reason: v.reason, errors: v.errors, warnings: [] };
      const command = v.command;
      const now = Number(ctx.now) || 0;
      if (cuts.gestures && command.steps.some((x) => x.region === 'hands')) syncGestureFromSlots(ctx.slots, now);
      if (command.onBusy === 'blend') {
        // 表情层互斥 / 表情写模块参数这类冲突不是「占用」，blend 也照旧判
        const verdict = judge(command);
        const hard = verdict.busy.filter((b) => b.layer === 'expression');
        if (hard.length) return { ok: false, reason: busyReason(hard), busy: hard, warnings: v.warnings.slice() };
        const ticket = 'bw-' + ++ticketSeq;
        const superseded = supersede(command, ticket);
        const bd = blendDecision(command, now, now);
        if (bd.ready) {
          const res = commit(command, ctx, v.warnings.slice(), { ...bd, waitedMs: 0 });
          if (superseded.length) res.superseded = superseded;
          return res;
        }
        queue.push({ ticket, command, deadline: now + command.waitMs, enqueuedAt: now, warnings: v.warnings.slice(), lastCuts: bd.cuts });
        return {
          ok: true,
          queued: true,
          pending: true,
          ticket,
          deadline: now + command.waitMs,
          readyInMs: bd.readyAt === null ? null : Math.max(0, bd.readyAt - now),
          cut: { mode: command.cut, regions: bd.cuts },
          superseded,
          warnings: v.warnings.slice(),
        };
      }
      const verdict = judge(command);
      if (verdict.ok) return commit(command, ctx, v.warnings.slice());
      if (command.onBusy === 'wait' && command.waitMs > 0) {
        const now = Number(ctx.now) || 0;
        const ticket = 'bw-' + ++ticketSeq;
        const superseded = supersede(command, ticket);
        queue.push({ ticket, command, deadline: now + command.waitMs, enqueuedAt: now, warnings: v.warnings.slice() });
        return { ok: true, queued: true, ticket, deadline: now + command.waitMs, busy: verdict.busy, superseded, warnings: v.warnings.slice() };
      }
      return { ok: false, reason: busyReason(verdict.busy), busy: verdict.busy, warnings: v.warnings.slice() };
    },

    /**
     * 执行端回报：某模块 / 层做完（end）、失败（failed）、跳过（skipped 视作 end 带 note）。
     * 返回 { settled, events, admitted, expired }——settled=false 表示该模块已被抢占或释放（迟到回调，忽略）。
     */
    complete(commandId, target, phase = 'end', extra, ctx = {}) {
      lastNow = Number(ctx.now) || lastNow;
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
      lastNow = Number(ctx.now) || lastNow;
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
      lastNow = now || lastNow;
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
      const neutral = [];
      // 正在退出的组合：不写新占用者正在写的参数
      const claimed = new Set();
      for (const tw of tweens.values()) for (const pid of Object.keys(tw.to)) claimed.add(pid);
      for (const cs of composes.values()) for (const x of cs.params) claimed.add(x.id);
      for (let i = 0; i < composeExits.length; ) {
        const ex = composeExits[i];
        const t = ex.exitMs > 0 ? Math.max(0, Math.min(1, (now - ex.startedAt) / ex.exitMs)) : 1;
        const k = easeInOut(t);
        for (const x of ex.params) {
          if (claimed.has(x.id)) continue;
          const val = x.from + (x.to - x.from) * k;
          writes[x.id] = val;
          lastWritten.set(x.id, val);
        }
        if (t >= 1) {
          composeExits.splice(i, 1);
          for (const x of ex.params) if (!claimed.has(x.id)) neutral.push(x.id);
          continue;
        }
        i++;
      }
      for (const [region, m] of [...composes]) {
        const tEnter = m.enterMs > 0 ? Math.max(0, Math.min(1, (now - m.startedAt) / m.enterMs)) : 1;
        if (tEnter >= 1 && m.holdAt === null) m.holdAt = now;
        const k = easeInOut(tEnter);
        let blinkFactor = 1;
        if (m.blink && m.holdAt !== null) {
          const b = m.blink;
          const gap = () => COMPOSE_BLINK.minIntervalMs + (COMPOSE_BLINK.maxIntervalMs - COMPOSE_BLINK.minIntervalMs) * random();
          if (b.nextAt === null) b.nextAt = m.holdAt + gap();
          if (b.startedAt === null && now >= b.nextAt) b.startedAt = now;
          if (b.startedAt !== null) {
            const dt = now - b.startedAt;
            const { closingMs, closedMs, openingMs } = COMPOSE_BLINK;
            if (dt < closingMs) blinkFactor = 1 - dt / closingMs;
            else if (dt < closingMs + closedMs) blinkFactor = 0;
            else if (dt < closingMs + closedMs + openingMs) blinkFactor = (dt - closingMs - closedMs) / openingMs;
            else {
              blinkFactor = 1;
              b.startedAt = null;
              b.nextAt = now + gap();
            }
          }
        }
        for (const x of m.params) {
          let val;
          if (m.holdAt === null) val = x.from + (x.value - x.from) * k;
          else val = x.value + (x.amp > 0 && x.periodMs > 0 ? x.amp * Math.sin((2 * Math.PI * (now - m.holdAt)) / x.periodMs) : 0);
          val = Math.max(x.min, Math.min(x.max, val));
          if (m.blink && m.blink.ids.includes(x.id)) val *= blinkFactor;
          writes[x.id] = val;
          lastWritten.set(x.id, val);
        }
        if (m.holdMs > 0 && m.holdAt !== null && now - m.holdAt >= m.holdMs) {
          const h = holders.get(region);
          if (h && h.commandId === m.commandId) finishTarget(m.commandId, region, 'end', undefined, events);
        }
      }
      for (const [itemId, tw] of accTweens) {
        const t = tw.durationMs > 0 ? Math.max(0, Math.min(1, (now - tw.startedAt) / tw.durationMs)) : 1;
        const v = tw.from + (tw.to - tw.from) * easeInOut(t);
        writes[tw.param] = v;
        lastWritten.set(tw.param, v);
        if (t >= 1) {
          accTweens.delete(itemId);
          finishTarget(tw.commandId, 'accessory:' + itemId, 'end', undefined, events);
        }
      }
      for (const pid of neutral) delete writes[pid];
      const pumped = pumpQueue(ctx);
      return { writes, neutral, events, ...pumped };
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
      return tweens.size > 0 || accTweens.size > 0 || queue.length > 0 || composes.size > 0 || composeExits.length > 0;
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
              compose: h.compose,
              heldMs: Math.max(0, now - h.startedAt),
              borrowed: h.borrowed.slice(),
              tween: tweens.has(name) ? { to: { ...tweens.get(name).to }, durationMs: tweens.get(name).durationMs } : undefined,
            }
          : { busy: false };
        Object.assign(regions[name], regionTiming(name, h, now));
      }
      return {
        modelId: compiled.modelId,
        regions,
        expression: expression ? { name: expression.name, commandId: expression.commandId, priority: expression.priority } : null,
        accessories: accessorySnapshot(ctx),
        compose: Object.fromEntries([...composes].map(([r, m]) => [r, { label: m.label, commandId: m.commandId, phase: m.holdAt === null ? 'enter' : 'hold', sinceMs: Math.max(0, now - m.startedAt), params: m.params.map((x) => x.id) }])),
        composeExiting: composeExits.map((ex) => ({ label: ex.label, region: ex.region })),
        gesture: cuts.gestures ? { current: gestureAt(now), settled: gestureSettled, to: holders.get('hands') && holders.get('hands').gesture ? holders.get('hands').gesture.to : null, states: cuts.gestures.states.slice() } : null,
        queue: queue.map((q) => ({ ticket: q.ticket, priority: q.command.priority, source: q.command.source, onBusy: q.command.onBusy, cut: q.command.cut, remainingMs: Math.max(0, q.deadline - now) })),
        recentEvents: recent.slice(-20),
      };
    },

    /** 反推当前神态（l2d_face_describe）：读参数 → 部件强度。 */
    describeFace(ctx = {}) {
      if (!compiled.face) return { ok: false, reason: 'face-units-unavailable' };
      const ids = [...compiled.face.params.keys()];
      const values = typeof ctx.read === 'function' ? ctx.read(ids) || {} : {};
      return describeFace(compiled.face, values, { activeExpressions: expression ? [expression.name] : [] });
    },

    /** 外部（右键「恢复默认脸」、l2d_reset）清了表情时同步表情层。 */
    noteExpressionCleared() {
      expression = null;
    },
  };
}
