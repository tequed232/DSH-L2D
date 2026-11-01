#!/usr/bin/env node
/**
 * DSH-L2D · VTube Studio 模型适配器（POC）
 *
 * 解决的问题：
 *   VTS 导出的模型包，表情(.exp3.json)与动作(.motion3.json)的引用关系记录在
 *   .vtube.json 的 Hotkeys 里，而标准 Cubism 运行时只认 model3.json 的
 *   FileReferences.Expressions / Motions。因此任何非 VTS 的渲染器（包括我们）
 *   加载这类模型时会得到「能显示但无表情、无动作」的结果。
 *
 * 本工具做四件事：
 *   1. 解析 .vtube.json Hotkeys，把表情/动作重新挂回 model3.json
 *   2. 校验 VTS 参数映射表（ParameterSettings）是否指向真实存在的 Live2D 参数
 *   3. 计算纹理显存预算，标出超出移动端上限的图集
 *   4. 产出 capabilities.json（供 LLM 工具定义与 UI 使用）
 *
 * 用法：
 *   node index.mjs "<模型目录>" [--out dist]
 *
 * 无第三方依赖。
 */

import fs from 'node:fs';
import path from 'node:path';

const ARG_DIR = process.argv[2];
if (!ARG_DIR) {
  console.error('用法: node index.mjs "<模型目录>" [--out dist]');
  process.exit(1);
}
const OUT_DIR = (() => {
  const i = process.argv.indexOf('--out');
  return i > -1 ? process.argv[i + 1] : 'dist';
})();

const MODEL_DIR = path.resolve(ARG_DIR);
const posix = (p) => p.split(path.sep).join('/');

function readJson(p) {
  // 兼容带 BOM 与 GBK 之外的情况：优先 UTF-8
  let raw = fs.readFileSync(p, 'utf8');
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  return JSON.parse(raw);
}

function walk(dir, depth = 0, acc = []) {
  if (depth > 4) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (/^(node_modules|dist|\.git)$/.test(e.name)) continue;
      walk(full, depth + 1, acc);
    } else {
      acc.push(full);
    }
  }
  return acc;
}

// ---------------------------------------------------------------- 1. 定位文件
const allFiles = walk(MODEL_DIR);
const vtubePath = allFiles.find((f) => f.toLowerCase().endsWith('.vtube.json'));
if (!vtubePath) {
  console.error('未找到 .vtube.json，该模型可能不是 VTS 导出格式，脚本不适用。');
  process.exit(2);
}
const vtube = readJson(vtubePath);
const baseName = path.basename(vtubePath).replace(/\.vtube\.json$/i, '');

const model3Name = vtube.FileReferences?.Model || `${baseName}.model3.json`;
const model3Path = path.join(MODEL_DIR, model3Name);
if (!fs.existsSync(model3Path)) {
  console.error(`未找到 model3.json: ${model3Path}`);
  process.exit(3);
}
const model3 = readJson(model3Path);

const cdi3Name = model3.FileReferences?.DisplayInfo;
const cdi3 = cdi3Name && fs.existsSync(path.join(MODEL_DIR, cdi3Name))
  ? readJson(path.join(MODEL_DIR, cdi3Name))
  : null;

// ------------------------------------------------- 2. 文件解析（复刻 VTS 行为）
// VTS 的 Hotkey.File 常常只写裸文件名，实际文件在 Animation/、Exp3/ 等子目录里。
const SUBDIRS = ['', 'Exp3', 'Expressions', 'expressions', 'expr', 'Animation',
  'animations', 'Animation', 'motions', 'motion', 'Motion'];

const fileIndex = new Map(); // basename(lower) -> [相对路径]
for (const f of allFiles) {
  const rel = posix(path.relative(MODEL_DIR, f));
  if (!/\.(exp3|motion3)\.json$/i.test(f)) continue;
  const k = path.basename(f).toLowerCase();
  if (!fileIndex.has(k)) fileIndex.set(k, []);
  fileIndex.get(k).push(rel);
}

function resolveAsset(fileRef) {
  if (!fileRef) return null;
  const clean = fileRef.split(/[\\/]/).pop().toLowerCase();
  const hits = fileIndex.get(clean) || [];
  if (hits.length === 0) return null;
  if (hits.length === 1) return hits[0];
  // 多个同名文件：优先与 File 字段目录名一致的
  const dirHint = path.dirname(fileRef).toLowerCase();
  const preferred = hits.find((h) => dirHint && h.toLowerCase().includes(dirHint));
  return preferred || hits[0];
}

// ---------------------------------------------------------- 3. 重建 Motions/Expressions
const hotkeys = Array.isArray(vtube.Hotkeys) ? vtube.Hotkeys : [];
const expressions = [];
const motions = {};
const unresolvedAssets = [];

for (const hk of hotkeys) {
  const action = hk.Action;
  if (action === 'ToggleExpression' || action === 'TriggerExpression') {
    const rel = resolveAsset(hk.File);
    if (!rel) { unresolvedAssets.push({ name: hk.Name, file: hk.File, kind: 'expression' }); continue; }
    expressions.push({ Name: hk.Name, File: rel });
  } else if (action === 'TriggerAnimation') {
    const rel = resolveAsset(hk.File);
    if (!rel) { unresolvedAssets.push({ name: hk.Name, file: hk.File, kind: 'motion' }); continue; }
    if (!motions[hk.Name]) motions[hk.Name] = [];
    motions[hk.Name].push({ File: rel, FadeInTime: 0.3, FadeOutTime: 0.3 });
  }
}

// 待机动作单独成组，供 idle 调度使用
const idleRel = vtube.FileReferences?.IdleAnimation
  ? resolveAsset(vtube.FileReferences.IdleAnimation) : null;
if (idleRel) {
  motions['Idle'] = [{ File: idleRel, FadeInTime: 0.5, FadeOutTime: 0.5 }];
}

const patched = structuredClone(model3);
patched.FileReferences = patched.FileReferences || {};
patched.FileReferences.Motions = motions;
patched.FileReferences.Expressions = expressions;

// 部分渲染器（pixi-live2d-display）会直接读 HitAreas.map，缺省时补空数组
if (!Array.isArray(patched.HitAreas)) patched.HitAreas = [];

// ------------------------------------------------------- 4. 参数映射校验
const paramIds = cdi3 ? cdi3.Parameters.map((p) => p.Id) : [];
const paramIdLower = new Map(paramIds.map((id) => [id.toLowerCase(), id]));

// VTS 内部参数名 → 模型参数名的约定别名
const KNOWN_ALIAS = {
  anglex: 'ParamAngleX', angley: 'ParamAngleY', anglez: 'ParamAngleZ',
  eyeballx: 'ParamEyeBallX', eyebally: 'ParamEyeBallY',
  eyeopenleft: 'ParamEyeLOpen', eyeopenright: 'ParamEyeROpen',
  mouthopen: 'ParamMouthOpenY', mouthsmile: 'ParamMouthForm',
  brows: 'ParamBrowLY', breath: 'ParamBreath',
  bodyanglex: 'ParamBodyAngleX', bodyangley: 'ParamBodyAngleY', bodyanglez: 'ParamBodyAngleZ',
  positionx: 'ParamBodyAngleX', positiony: 'ParamBodyAngleY', positionz: 'ParamBodyAngleZ',
};

function resolveParam(name) {
  if (!name) return null;
  const raw = String(name).trim();
  if (!raw) return null;
  if (paramIdLower.has(raw.toLowerCase())) return paramIdLower.get(raw.toLowerCase());
  const withPrefix = 'param' + raw.toLowerCase();
  if (paramIdLower.has(withPrefix)) return paramIdLower.get(withPrefix);
  const alias = KNOWN_ALIAS[raw.toLowerCase()];
  if (alias && paramIdLower.has(alias.toLowerCase())) return paramIdLower.get(alias.toLowerCase());
  return null;
}

const settings = Array.isArray(vtube.ParameterSettings) ? vtube.ParameterSettings : [];
const mappingReport = [];
const unresolvedParams = [];
for (const s of settings) {
  const target = resolveParam(s.OutputLive2D);
  const row = {
    input: s.Input || '(none)',
    label: s.Name || '',
    declaredTarget: s.OutputLive2D,
    resolvedTarget: target,
    outRange: [s.OutputRangeLower, s.OutputRangeUpper],
    smoothing: s.Smoothing,
  };
  mappingReport.push(row);
  if (!target && s.OutputLive2D) unresolvedParams.push(row);
}

// ---------------------------------------- 4.5 补全 model3.json 的 Groups
// 该模型导出的 Groups.LipSync 为空，必须注入实际的嘴部参数，
// 否则任何标准的「按 LipSync 组口型同步」实现都会静默失效。
patched.Groups = Array.isArray(patched.Groups) ? patched.Groups : [];
const lipRow = mappingReport.find((r) => r.input === 'MouthOpen' && r.resolvedTarget);
const lipParam = lipRow ? lipRow.resolvedTarget : paramIdLower.get('parammouthopeny');
const groupFixes = [];
if (lipParam) {
  const g = patched.Groups.find((x) => x.Name === 'LipSync');
  if (g) {
    if (!(g.Ids || []).length) { g.Ids = [lipParam]; groupFixes.push(`LipSync 组为空 → 注入 ${lipParam}`); }
  } else {
    patched.Groups.push({ Target: 'Parameter', Name: 'LipSync', Ids: [lipParam] });
    groupFixes.push(`缺少 LipSync 组 → 新建 [${lipParam}]`);
  }
}

// -------------------------------------------------------------- 5. 纹理预算
function pngSize(file) {
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(33);
  fs.readSync(fd, buf, 0, 33, 0);
  fs.closeSync(fd);
  if (buf.toString('ascii', 1, 4) !== 'PNG') return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

const texList = (model3.FileReferences?.Textures || []).map((rel) => {
  const full = path.join(MODEL_DIR, rel);
  const dim = fs.existsSync(full) ? pngSize(full) : null;
  const bytes = fs.existsSync(full) ? fs.statSync(full).size : 0;
  const vram = dim ? dim.w * dim.h * 4 : 0;
  return {
    file: rel,
    width: dim?.w ?? 0,
    height: dim?.h ?? 0,
    diskMB: +(bytes / 1048576).toFixed(1),
    vramMB: +(vram / 1048576).toFixed(1),
    exceeds4096: !!dim && (dim.w > 4096 || dim.h > 4096),
    exceeds8192: !!dim && (dim.w > 8192 || dim.h > 8192),
  };
});
const totalVram = texList.reduce((a, t) => a + t.vramMB, 0);

// -------------------------------------------------- 6. 能力清单（给 LLM / UI）
const has = (id) => paramIdLower.has(id.toLowerCase());
const SEMANTIC = {
  '兔牙': 'cute', '脸红': 'blush', '流泪': 'cry', '流冷汗': 'nervous', '黑脸': 'angry',
  '爱心眼': 'love', '圈圈眼': 'dizzy', '屑屑眼': 'smug', '＞＜': 'squint', '钢盆': 'shock',
  '单片眼镜': 'monocle', '黑框眼镜': 'glasses', '脱鞋': 'shoes_off', '尾巴开关': 'tail',
  '胸口衣服': 'clothes', '裙长切换': 'skirt', '前倾': 'lean', '加载': 'loading',
};
const semanticOf = (name) => SEMANTIC[name] || null;
// 从 VTS 映射表反推语义参数（比按标准参数名猜测更可靠）
// 注意：同一输入可扇出到多个参数（如 MouthSmile → EyeSmile + ParamMouthForm），故返回数组。
const byInput = (inputName) =>
  mappingReport.filter((r) => r.input === inputName && r.resolvedTarget).map((r) => r.resolvedTarget);
const semantic = (inputName, standardCandidates) => {
  const fanout = byInput(inputName);
  if (fanout.length) return { id: fanout[0], all: fanout, from: 'vts' };
  const std = pick(standardCandidates);
  return std ? { id: std, all: [std], from: 'standard' } : { id: null, all: [], from: 'none' };
};

const capabilities = {
  modelId: vtube.ModelID,
  name: vtube.Name || baseName,
  format: 'vts',
  source: { vtube: posix(path.relative(MODEL_DIR, vtubePath)), model3: model3Name },
  cubismVersion: model3.Version === 3 ? (detectCubism5() ? 5 : 4) : 2,
  expressions: expressions.map((e, i) => ({
    id: `expr_${i}`,
    name: e.Name,
    semantic: semanticOf(e.Name),
    file: e.File,
  })),
  motionGroups: Object.entries(motions).map(([name, arr]) => ({
    name,
    count: arr.length,
    files: arr.map((m) => m.File),
  })),
  params: {
    lipSync: semantic('MouthOpen', ['ParamMouthOpenY', 'ParamMouthOpen']),
    jawOpen: semantic('JawOpen', ['ParamJawOpen']),
    mouthForm: semantic('MouthSmile', ['ParamMouthForm']),
    eyeBlinkL: semantic('EyeOpenLeft', ['ParamEyeLOpen']),
    eyeBlinkR: semantic('EyeOpenRight', ['ParamEyeROpen']),
    eyeBallX: semantic('EyeRightX', ['ParamEyeBallX']),
    eyeBallY: semantic('EyeRightY', ['ParamEyeBallY']),
    angleX: semantic('FaceAngleX', ['ParamAngleX']),
    angleY: semantic('FaceAngleY', ['ParamAngleY']),
    angleZ: semantic('FaceAngleZ', ['ParamAngleZ']),
    bodyAngleX: semantic('BodyAngleX', ['ParamBodyAngleX']),
    bodyAngleY: semantic('BodyAngleY', ['ParamBodyAngleY']),
    bodyAngleZ: semantic('BodyAngleZ', ['ParamBodyAngleZ']),
    breath: semantic('(none)', ['ParamBreath']),
  },
  faceTracking: mappingReport.filter((r) => r.resolvedTarget),
  textures: texList,
  stats: {
    paramCount: paramIds.length,
    hotkeyCount: hotkeys.length,
    expressionCount: expressions.length,
    motionGroupCount: Object.keys(motions).length,
    unresolvedAssetCount: unresolvedAssets.length,
    unresolvedParamMappingCount: unresolvedParams.length,
    totalVramMB: +totalVram.toFixed(0),
  },
};

function pick(cands) {
  for (const c of cands) if (has(c)) return paramIdLower.get(c.toLowerCase());
  return null;
}

function detectCubism5() {
  const moc = model3.FileReferences?.Moc;
  if (!moc) return false;
  const p = path.join(MODEL_DIR, moc);
  if (!fs.existsSync(p)) return false;
  const buf = Buffer.alloc(8);
  const fd = fs.openSync(p, 'r');
  fs.readSync(fd, buf, 0, 8, 0);
  fs.closeSync(fd);
  if (buf.toString('ascii', 0, 4) !== 'MOC3') return false;
  return buf.readUInt32BE(4) >= 4; // moc3 版本号 >=4 即 Cubism 4/5
}

// ---------------------------------------------------------------- 7. 输出
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'capabilities.json'), JSON.stringify(capabilities, null, 2), 'utf8');
fs.writeFileSync(path.join(OUT_DIR, 'param-mapping.json'), JSON.stringify(mappingReport, null, 2), 'utf8');

const patchedName = `${baseName}.dsl2d.model3.json`;
fs.writeFileSync(path.join(MODEL_DIR, patchedName), JSON.stringify(patched, null, '\t'), 'utf8');

// ---------------------------------------------------------------- 8. 报告
const line = (s = '') => console.log(s);
line('═'.repeat(64));
line(`模型: ${vtube.Name}  (${capabilities.modelId})`);
line(`格式: VTS  →  已重建为标准 Cubism model3.json`);
line('═'.repeat(64));
line();
line(`【资源解析】`);
line(`  热键总数        ${hotkeys.length}`);
line(`  表情 (exp3)     ${expressions.length}`);
line(`  动作组 (motion) ${Object.keys(motions).length}  共 ${Object.values(motions).reduce((a, b) => a + b.length, 0)} 个文件`);
line(`  未解析资源      ${unresolvedAssets.length}`);
for (const u of unresolvedAssets) line(`      ✗ ${u.name}: ${u.file}`);
line();
line(`【参数映射校验】${unresolvedParams.length} / ${settings.length} 条无效`);
if (groupFixes.length) line(`【Groups 修复】`);
for (const g of groupFixes) line(`      ✓ ${g}`);
for (const u of unresolvedParams.slice(0, 12)) {
  line(`      ✗ ${u.input} → "${u.declaredTarget}"  (未在 cdi3 中找到该参数)`);
}
if (unresolvedParams.length > 12) line(`      … 另有 ${unresolvedParams.length - 12} 条`);
line();
line(`【纹理预算】合计 ${totalVram.toFixed(0)} MB 显存`);
for (const t of texList) {
  const flag = t.exceeds8192 ? '  ⚠ 超 8192 上限' : t.exceeds4096 ? '  ⚠ 超 4096' : '';
  line(`      ${t.width}x${t.height}  ${String(t.vramMB).padStart(6)} MB  ${t.file}${flag}`);
}
line();
line(`【输出】`);
line(`  ${posix(path.relative(process.cwd(), path.join(MODEL_DIR, patchedName)))}  （原位生成，未覆盖原文件）`);
line(`  ${posix(path.join(OUT_DIR, 'capabilities.json'))}`);
line(`  ${posix(path.join(OUT_DIR, 'param-mapping.json'))}`);
line();
