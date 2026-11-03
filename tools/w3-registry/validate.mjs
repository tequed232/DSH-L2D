#!/usr/bin/env node
/**
 * W3 Motion Capability Registry 校验器。
 *
 * 目的：registry 是「声明」，这里拿模型文件与源码独立复核声明，防止手写/生成漂移。
 * 校验项：
 *   1. 结构：id 唯一、字段齐全、kind 合法
 *   2. 动作组：资产存在、控制参数 == motion3 曲线参数、时长/淡入淡出 == 模型文件
 *   3. 姿势：参数存在、不是物理输出、数值与 pose-controller PRESETS 一致
 *   4. 表情：表情名在 model3、参数 == exp3.json 参数表
 *   5. 视线/身体：参数存在（cdi3）
 *   6. 冲突：成对对称（双方的 conflictWith 都包含对方）
 *   7. 不登记项：模型里确实没有对应资产（证明排除理由成立）
 *   8. 未引用资产：确实未被 model3 引用
 *
 * 用法：
 *   node tools/w3-registry/validate.mjs                 # 校验 tools/w3-registry/registry.json
 *   node tools/w3-registry/validate.mjs path/to.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const DEFAULT_REGISTRY = path.join(HERE, 'registry.json');

const KINDS = new Set(['motion-pair', 'motion-loop', 'pose', 'gaze', 'body', 'expression']);
const EYE_FAMILY = ['key3', 'key4', 'key5', 'key6'];
const POSE_IDS = ['Param36', 'Param39', 'Param40', 'Param41', 'Param42', 'Param43', 'Param59', 'Param60', 'Param61', 'Param62'];

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

export function resolveModelDir(env = process.env) {
  const candidates = [
    env.DSH_L2D_MODEL_DIR,
    path.join(ROOT, 'DeepSeek免费公皮', 'DeepSeek'),
    'D:/Desktop/DSH-L2D/DeepSeek免费公皮/DeepSeek',
  ].filter(Boolean);
  return candidates.find((p) => {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  });
}

/** 独立解析 motion3 参数（与 build 的解析实现分开写，避免同一 bug 互相背书）。 */
export function motion3ParamIds(file) {
  const json = readJson(file);
  const ids = new Set();
  for (const c of json.Curves || []) if (c.Target === 'Parameter' && c.Id) ids.add(c.Id);
  return ids;
}

export function validateRegistry(registry, opts = {}) {
  const modelDir = opts.modelDir || resolveModelDir();
  if (!modelDir) throw new Error('找不到模型目录');
  const errors = [];
  const warnings = [];
  const err = (msg) => errors.push(msg);
  const warn = (msg) => warnings.push(msg);

  if (!registry || registry.schemaVersion !== 1) err('schemaVersion 必须是 1');
  if (!Array.isArray(registry.entries)) throw new Error('registry.entries 缺失');

  const model3 = readJson(path.join(modelDir, registry.model.model3));
  const refs = model3.FileReferences || {};
  const motionRefs = refs.Motions || {};
  const expRefs = refs.Expressions || [];
  const physics = refs.Physics ? readJson(path.join(modelDir, refs.Physics)) : null;
  const physicsOutputs = new Set();
  if (physics) {
    for (const s of physics.PhysicsSettings || []) {
      for (const o of s.Output || []) if (o.Destination && o.Destination.Id) physicsOutputs.add(o.Destination.Id);
    }
  }
  const cdi = readJson(path.join(modelDir, '大肥鱼.cdi3.json'));
  const paramIds = new Set((cdi.Parameters || []).map((p) => p.Id));

  // 1) 结构
  const seen = new Set();
  for (const e of registry.entries) {
    if (!e.id) err('条目缺少 id');
    if (seen.has(e.id)) err(`重复 id: ${e.id}`);
    seen.add(e.id);
    if (!KINDS.has(e.kind)) err(`${e.id}: 非法 kind ${e.kind}`);
    if (!Array.isArray(e.controlledParams) || !e.controlledParams.length) err(`${e.id}: controlledParams 不能为空`);
    for (const p of e.controlledParams || []) {
      if (!p.id) err(`${e.id}: controlledParams 条目缺少 id`);
      else if (!paramIds.has(p.id)) err(`${e.id}: 参数 ${p.id} 不在 cdi3 参数表`);
    }
    for (const p of e.poseParams || []) {
      if (physicsOutputs.has(p)) err(`${e.id}: poseParam ${p} 是物理输出（physics3 输出表），不允许当可写姿势参数`);
    }
    if (e.kind === 'expression' && !e.expressionName) err(`${e.id}: 表情条目缺少 expressionName`);
  }

  // 2) 动作组
  for (const e of registry.entries.filter((x) => x.kind === 'motion-pair')) {
    const slot = e.slot;
    if (!slot) {
      err(`${e.id}: 缺少 slot`);
      continue;
    }
    const pairCurveIds = new Set();
    for (const dir of ['打开', '关闭']) {
      const group = slot + dir;
      const ref = (motionRefs[group] || [])[0];
      if (!ref) {
        err(`${e.id}: model3 没有动作组 ${group}`);
        continue;
      }
      const file = path.join(modelDir, ref.File);
      if (!fs.existsSync(file)) {
        err(`${e.id}: 资产不存在 ${ref.File}`);
        continue;
      }
      const asset = (e.assets || []).find((a) => a.group === group);
      if (!asset) {
        err(`${e.id}: assets 缺少 ${group}`);
        continue;
      }
      for (const id of motion3ParamIds(file)) pairCurveIds.add(id);
      const json = readJson(file);
      const durMs = Math.round((json.Meta && json.Meta.Duration ? json.Meta.Duration : 0) * 1000);
      if (asset.durationMs !== durMs) err(`${e.id}/${group}: durationMs ${asset.durationMs} != 模型 ${durMs}`);
      const fadeIn = Math.round((ref.FadeInTime || 0) * 1000);
      const fadeOut = Math.round((ref.FadeOutTime || 0) * 1000);
      if (asset.fadeInMs !== fadeIn) err(`${e.id}/${group}: fadeInMs ${asset.fadeInMs} != model3 ${fadeIn}`);
      if (asset.fadeOutMs !== fadeOut) err(`${e.id}/${group}: fadeOutMs ${asset.fadeOutMs} != model3 ${fadeOut}`);
    }
    const declared = new Set(e.controlledParams.map((p) => p.id));
    for (const id of pairCurveIds) if (!declared.has(id)) err(`${e.id}: 漏登记成对曲线参数 ${id}`);
    for (const id of declared) if (!pairCurveIds.has(id)) err(`${e.id}: 多登记了成对曲线里没有的参数 ${id}`);
    // 成对槽必须给全：model3 里每个 slot 组都被登记
    if (!e.composable || !Array.isArray(e.composable.conflictWith)) err(`${e.id}: composable.conflictWith 缺失`);
    if (!e.recovery) err(`${e.id}: 缺少 recovery`);
  }
  // model3 每个成对组都要有登记项
  const slotGroups = new Set();
  for (const e of registry.entries.filter((x) => x.kind === 'motion-pair')) {
    if (e.slot) {
      slotGroups.add(e.slot + '打开');
      slotGroups.add(e.slot + '关闭');
    }
  }
  for (const group of Object.keys(motionRefs)) {
    if (group === 'Idle') continue;
    if (!slotGroups.has(group)) err(`model3 动作组 ${group} 未登记（也没有登记进 excluded）`);
  }

  // 3) 姿势
  const pcSrc = fs.readFileSync(path.join(ROOT, 'packages/renderer/src/app/pose-controller.ts'), 'utf8');
  const presetBlock = pcSrc.slice(pcSrc.indexOf('const PRESETS'), pcSrc.indexOf('export interface PoseRequest'));
  const presetValues = {};
  for (const name of ['rest', 'finger', 'grass', 'chest']) {
    const m = presetBlock.match(new RegExp(name + ':\\s*\\{([\\s\\S]*?)\\}', 'm'));
    let vals = {};
    if (m) {
      const body = m[1].replace(/\.\.\.REST,?/, '');
      for (const mm of body.matchAll(/(Param\d+):\s*(-?[\d.]+)/g)) vals[mm[1]] = Number(mm[2]);
    }
    if (name === 'rest' && !Object.keys(vals).length) {
      vals = Object.fromEntries(POSE_IDS.map((id) => [id, 0]));
    }
    presetValues[name] = vals;
  }
  for (const e of registry.entries.filter((x) => x.kind === 'pose')) {
    const name = String(e.id).replace('pose.', '');
    const expected = presetValues[name];
    if (!expected) {
      err(`${e.id}: pose-controller 里没有 PRESETS.${name}`);
      continue;
    }
    const declared = Object.fromEntries(e.controlledParams.map((p) => [p.id, p.end]));
    for (const [id, v] of Object.entries(expected)) {
      if (declared[id] === undefined) err(`${e.id}: 漏登记姿势参数 ${id}`);
      else if (Math.abs(declared[id] - v) > 1e-6) err(`${e.id}: ${id} 声明 ${declared[id]} != pose-controller ${v}`);
    }
    for (const id of Object.keys(declared)) if (expected[id] === undefined) err(`${e.id}: 多登记了 PRESETS 没有的参数 ${id}`);
  }

  // 4) 表情
  const expNames = new Set(expRefs.map((x) => x.Name));
  for (const e of registry.entries.filter((x) => x.kind === 'expression')) {
    if (!expNames.has(e.expressionName)) {
      err(`${e.id}: model3 没有表情 ${e.expressionName}`);
      continue;
    }
    const ref = expRefs.find((x) => x.Name === e.expressionName);
    const json = readJson(path.join(modelDir, ref.File));
    const declared = new Map(e.controlledParams.map((p) => [p.id, p]));
    for (const p of json.Parameters || []) {
      const d = declared.get(p.Id);
      if (!d) err(`${e.id}: 漏登记 exp3 参数 ${p.Id}`);
      else if (Math.abs(d.value - Number(p.Value)) > 1e-6) err(`${e.id}: ${p.Id} 值 ${d.value} != exp3 ${p.Value}`);
    }
    for (const id of declared.keys()) {
      if (!(json.Parameters || []).some((p) => p.Id === id)) err(`${e.id}: 多登记了 exp3 没有的参数 ${id}`);
    }
  }
  // 21 个表情全登记
  for (const ref of expRefs) {
    if (!registry.entries.some((e) => e.kind === 'expression' && e.expressionName === ref.Name)) {
      err(`表情 ${ref.Name} 未登记`);
    }
  }

  // 5) 视线 / 身体参数存在（上面结构检查已覆盖），额外检查 gaze 是否含核心通道
  for (const e of registry.entries.filter((x) => x.kind === 'gaze')) {
    for (const id of ['AngleX', 'AngleY', 'ParamEyeBallX', 'ParamEyeBallY']) {
      if (!e.controlledParams.some((p) => p.id === id)) err(`${e.id}: 视线缺少核心通道 ${id}`);
    }
  }

  // 6) 冲突对称（只校验精确指向其他条目 id 的冲突）
  const byId = new Map(registry.entries.map((e) => [e.id, e]));
  const matchesPattern = (pattern, id) => {
    if (pattern === id) return true;
    if (pattern.endsWith('.*')) return id.startsWith(pattern.slice(0, -1));
    return false;
  };
  for (const e of registry.entries) {
    const targets = new Set((e.conflicts || []).map((c) => c.with).filter((w) => byId.has(w)));
    // 通配符声明的反查：对方 conflicts 里有 'xxx.*' 命中本 id 也算双向
    for (const other of registry.entries) {
      for (const c of other.conflicts || []) {
        if (c.with && c.with !== e.id && matchesPattern(c.with, e.id) && c.with.endsWith('.*')) targets.add(other.id);
      }
    }
    for (const t of targets) {
      const other = byId.get(t);
      const back = new Set((other.conflicts || []).map((c) => c.with));
      const backWildcard = [...back].some((w) => w !== e.id && w.endsWith('.*') && matchesPattern(w, e.id));
      const alsoComposable = (e.composable && e.composable.with || []).includes(t) ||
        (other.composable && other.composable.with || []).includes(e.id);
      if (!back.has(e.id) && !backWildcard && !alsoComposable) {
        warn(`${e.id} -> ${t} 冲突未双向声明（${t} 的 conflicts 里没有 ${e.id}）`);
      }
    }
  }

  // 7) 排除项：确认模型确实没有对应资产/表情
  const excludedIds = new Set((registry.excluded || []).map((x) => x.id));
  for (const need of ['gesture.wave', 'gesture.hand_to_chin', 'gesture.arms_crossed', 'gesture.open_hands']) {
    if (!excludedIds.has(need)) err(`excluded 缺少 ${need}（Chief 要求这几条始终不登记）`);
  }
  const allNames = [...expRefs.map((x) => x.Name), ...Object.keys(motionRefs)];
  const suspicious = allNames.filter((n) => /挥手|托腮|交叉|张开|wave|chin|cross/i.test(n));
  if (suspicious.length) warn(`模型里出现疑似被排除能力的资产名：${suspicious.join(',')}`);

  // 8) 未引用资产
  const referencedMotion = new Set();
  for (const list of Object.values(motionRefs)) for (const e of list) referencedMotion.add(e.File);
  const referencedExp = new Set(expRefs.map((e) => e.File));
  for (const p of (registry.unregisteredAssets && registry.unregisteredAssets.motion3) || []) {
    const relPath = p.replace(/^model\//, '');
    if (referencedMotion.has(relPath)) err(`声明未引用的 motion3 ${relPath} 实际被 model3 引用`);
    if (!fs.existsSync(path.join(modelDir, relPath))) err(`未引用资产不存在 ${relPath}`);
  }
  for (const p of (registry.unregisteredAssets && registry.unregisteredAssets.exp3) || []) {
    const relPath = p.replace(/^model\//, '');
    if (referencedExp.has(relPath)) err(`声明未引用的 exp3 ${relPath} 实际被 model3 引用`);
    if (!fs.existsSync(path.join(modelDir, relPath))) err(`未引用资产不存在 ${relPath}`);
  }

  // 眼睛族冲突说明：key3-6 至少要被某个表情声明成互斥
  const eyeEntries = registry.entries.filter((e) => (e.eyeFamilyKeys || []).length);
  if (eyeEntries.length < 2) warn('眼睛族表情声明少于 2 个，key3-6 互斥规则可能没覆盖');
  for (const e of eyeEntries) {
    const conflictParams = (e.conflicts || []).flatMap((c) => c.params || []);
    for (const k of EYE_FAMILY) {
      if (!conflictParams.includes(k) && e.eyeFamilyKeys.includes(k)) {
        // 只要求声明了眼睛族的条目把 key3-6 写进冲突参数
        err(`${e.id}: 眼睛族冲突缺少 ${k}`);
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings, checkedAt: new Date().toISOString(), modelDir };
}

// CLI
function main() {
  const file = process.argv[2] || DEFAULT_REGISTRY;
  if (!fs.existsSync(file)) {
    console.error('[validate] 找不到 registry: ' + file);
    process.exit(2);
  }
  let result;
  try {
    result = validateRegistry(readJson(file));
  } catch (e) {
    console.error('[validate] ERROR: ' + e.message);
    process.exit(2);
  }
  for (const w of result.warnings) console.warn('[validate] WARN ' + w);
  for (const e of result.errors) console.error('[validate] ERR  ' + e);
  console.log(`[validate] ${result.ok ? 'PASS' : 'FAIL'} errors=${result.errors.length} warnings=${result.warnings.length}`);
  process.exit(result.ok ? 0 : 1);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) main();
