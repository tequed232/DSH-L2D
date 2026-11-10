#!/usr/bin/env node
/**
 * 从真实模型文件 + overlay/host-guard 代码生成 Live2D 目录：
 *   docs/nodegraph/LIVE2D-CATALOG.md
 *   docs/nodegraph/live2d-catalog.json
 *   docs/nodegraph/live2d-ids.json   ← 后端校验用，严格字段
 *
 * 按模型生成（2026-11-10 统一约定）：modelId = 模型文件名去 .model3.json（如 大肥鱼.dsl2d.2048）。
 * 每次运行都会写 docs/nodegraph/models/<modelId>/ 下的三份文件（live2d-ids.json / live2d-catalog.json /
 * LIVE2D-CATALOG.md）；仅当 modelId 为 大肥鱼.dsl2d.2048 时才额外写 docs/nodegraph/ 全局三份
 * （全局文档是历史产物，其它模型不覆盖）。
 *
 * 环境变量：
 *   DSH_L2D_MODEL_DIR  模型目录（含 *.model3.json / *.cdi3.json / moc3）
 *   DSH_L2D_CUBISM_CORE  live2dcubismcore.min.js 路径（可选）
 *
 * 纪律：不编造任何 ID；量程来自 Cubism Core 读 moc3；找不到的写明来源缺失。
 * model3 FileReferences 为空时（VTS 导出如 miku）回退目录扫描 *.exp3.json / *.motion3.json。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
// 目录扫描回退与运行时同一份事实（host-guard 注释：「两处绝不分叉」）。
import { scanExpressionFiles, scanMotionGroups } from '../../packages/dsh-l2d-plugin/lib/host-guard.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../..');
const OUT_DIR = path.join(REPO, 'docs/nodegraph');
const MODELS_OUT_DIR = path.join(OUT_DIR, 'models');
/** 全局 docs（历史产物）只属于大肥鱼；其它模型只写 models/<modelId>/。 */
const GLOBAL_DOC_MODEL_ID = '大肥鱼.dsl2d.2048';

const MODEL_DIR = process.env.DSH_L2D_MODEL_DIR ||
  path.join(REPO, 'DeepSeek免费公皮', 'DeepSeek');
const FALLBACK_MODEL_DIRS = [
  MODEL_DIR,
  '/workspace/test/DSH-L2D/DeepSeek免费公皮/DeepSeek',
];

function resolveModelDir() {
  for (const d of FALLBACK_MODEL_DIRS) {
    if (discoverModel3Files(d).length) return d;
  }
  throw new Error(`找不到模型目录。请设置 DSH_L2D_MODEL_DIR。试过：${FALLBACK_MODEL_DIRS.join(' | ')}`);
}

/** 目录下全部 .model3.json（排序）。目录不可读 → 空数组。 */
function discoverModel3Files(dir) {
  try {
    return fs.readdirSync(dir).filter((n) => n.endsWith('.model3.json')).sort();
  } catch {
    return [];
  }
}

/**
 * 选 model3：同目录多变体时优先 `.2048.model3.json`（纹理降档变体，与既有 catalog 的
 * modelId 一致），否则取排序第一个。
 */
function pickModel3File(dir) {
  const files = discoverModel3Files(dir);
  if (!files.length) throw new Error(`模型目录里没有 .model3.json：${dir}`);
  return files.find((f) => f.endsWith('.2048.model3.json')) || files[0];
}

function findFile(dir, names, extRegex) {
  for (const n of names) {
    if (!n) continue;
    const p = path.join(dir, n);
    if (fs.existsSync(p)) return p;
  }
  if (extRegex) {
    try {
      const hit = fs.readdirSync(dir).filter((n) => extRegex.test(n)).sort();
      if (hit.length) return path.join(dir, hit[0]);
    } catch {
      /* 目录不可读按未找到处理 */
    }
  }
  return null;
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/** 用 Cubism Core 从 moc3 读全部参数 min/max/default */
async function extractRangesFromMoc3(moc3Path, coreMinPath) {
  const minSrc = fs.readFileSync(coreMinPath, 'utf8');
  const from = '_em_module())}(Live2DCubismCore=Live2DCubismCore||{});';
  if (!minSrc.includes(from)) {
    throw new Error(`Cubism Core 末尾签名不匹配，无法打补丁: ${coreMinPath}`);
  }
  const to = `(function(){
  var M=_em_module();
  globalThis.__EM=M;
  globalThis.__EM_READY=new Promise(function(resolve){
    if(M.calledRun){resolve();return;}
    var prev=M.onRuntimeInitialized;
    M.onRuntimeInitialized=function(){
      try{if(typeof prev==='function')prev();}catch(e){}
      resolve();
    };
  });
  return M;
})())}(globalThis.Live2DCubismCore=globalThis.Live2DCubismCore||{});
module.exports=globalThis.Live2DCubismCore;
`;
  const patchedPath = path.join(tmpdir(), `live2dcubismcore.catalog.${process.pid}.cjs`);
  fs.writeFileSync(patchedPath, minSrc.replace(from, to));
  const require = createRequire(import.meta.url);
  delete require.cache[patchedPath];
  const core = require(patchedPath);
  await globalThis.__EM_READY;
  // WASM 可能永不让进程退出；调用方自行 process.exit
  const buf = fs.readFileSync(moc3Path);
  const ab = new ArrayBuffer(buf.byteLength);
  new Uint8Array(ab).set(buf);
  const moc = core.Moc.fromArrayBuffer(ab);
  const model = core.Model.fromMoc(moc);
  const p = model.parameters;
  const parameters = [];
  for (let i = 0; i < p.count; i++) {
    parameters.push({
      id: String(p.ids[i]),
      min: p.minimumValues[i],
      max: p.maximumValues[i],
      default: p.defaultValues[i],
    });
  }
  try { fs.unlinkSync(patchedPath); } catch {}
  return {
    source: 'cubism-core-6.0.1 (csmGetParameterMinimum/Maximum/DefaultValues)',
    moc3: moc3Path,
    count: parameters.length,
    parameters,
  };
}

function extractBodyTypes(overlaySrc) {
  const m = overlaySrc.match(/var BODY_TYPES = \[([\s\S]*?)\];/);
  if (!m) return [];
  // 安全解析：只取 label/value/factor 字面量
  const items = [];
  const re = /\{\s*label:\s*'([^']*)'\s*,\s*value:\s*([0-9.]+)\s*,\s*factor:\s*([0-9.]+)\s*\}/g;
  let hit;
  while ((hit = re.exec(m[1]))) {
    items.push({
      index: items.length,
      label: hit[1],
      clothes2: Number(hit[2]),
      factor: Number(hit[3]),
      paramId: 'Clothes2',
    });
  }
  return items;
}

function extractOverlayCommands(overlaySrc) {
  const cases = [...overlaySrc.matchAll(/case\s+'([^']+)':/g)]
    .map((m) => m[1])
    .filter((c) => c.startsWith('l2d_'));
  return [...new Set(cases)];
}

function extractHostAllowedTools(hostGuardSrc) {
  const m = hostGuardSrc.match(/HOST_ALLOWED_TOOLS = Object\.freeze\(\[([\s\S]*?)\]\)/);
  if (!m) return [];
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

function physicsOutputIds(physics) {
  const outs = new Set();
  for (const s of physics.PhysicsSettings || []) {
    for (const o of s.Output || []) {
      const id = o?.Destination?.Id;
      if (id) outs.add(id);
    }
  }
  return [...outs].sort();
}

function buildMd(catalog) {
  const lines = [];
  const L = (s = '') => lines.push(s);
  L(`# Live2D 目录 · ${catalog.modelId}（给 AI / 校验用）`);
  L();
  L('## 用途与纪律');
  L();
  L('- AI 编辑节点图时，**只能使用本目录列出的 ID**（参数 / 动作组 / 表情 / 形态 / 指令名）。');
  L('- **ID、指令名、reason 代码永不翻译**；界面显示名可按语言表翻译。');
  L('- 节点图 JSON **只存 ID**（及数值），不存显示名，避免换语言后对不上模型。');
  L('- 本文件由 `tools/live2d-catalog/build-live2d-catalog.mjs` 从真实模型与代码生成；**禁止手改 ID 列表**。');
  L('- 机器可读副本：`live2d-catalog.json`（完整）、`live2d-ids.json`（后端校验精简）。');
  L();
  L('## 模型来源');
  L();
  L(`| 项 | 值 |`);
  L(`|---|---|`);
  L(`| modelId | \`${catalog.modelId}\` |`);
  L(`| model3 | \`${catalog.model.model3File}\` |`);
  L(`| moc3 | \`${catalog.model.moc3File}\` |`);
  L(`| cdi3 | \`${catalog.model.cdi3File || '未在模型目录中找到'}\` |`);
  L(`| physics3 | \`${catalog.model.physics3File || '未在模型目录中找到'}\` |`);
  L(`| pose3 | \`${catalog.model.pose3File || '未在模型目录中找到'}\` |`);
  L(`| 量程来源 | ${catalog.ranges.source} |`);
  L(`| 参数数 | ${catalog.parameters.length} |`);
  L(`| 物理输出数 | ${catalog.physicsOutputIds.length} |`);
  L(`| 动作组数 | ${catalog.motions.length} |`);
  L(`| 表情数 | ${catalog.expressions.length} |`);
  L(`| HitAreas | ${catalog.hitAreas.length ? catalog.hitAreas.map((h) => h.Id || h.Name).join(', ') : '（空，model3 未声明）'} |`);
  L();
  L('## 形态（forms）');
  L();
  if (!catalog.forms.length) {
    L('（本模型没有宿主 overlay `BODY_TYPES` 形态定义，forms 为空；`l2d_set_form` 不可用。）');
    L();
  } else {
  L('来源：`packages/dsh-l2d-plugin/lib/overlay.js` 的 `BODY_TYPES`；切换写参数 `Clothes2`。');
  L();
  L('| index | label（显示名，可译） | Clothes2 取值 | 视觉系数 factor |');
  L('|---|---|---|---|');
  for (const f of catalog.forms) {
    L(`| ${f.index} | ${f.label} | ${f.clothes2} | ${f.factor} |`);
  }
  L();
  L('- 直达切换：指令 `l2d_set_form`，`index` ∈ {0,1,2}（不钳制、不猜测）。');
  L('- 循环 +1：指令 `l2d_change_form`（只能往上切，不能回退）。');
  L();
  }
  L('## 动作组（motions）');
  L();
  L(catalog.model.motionSource === 'scan' ? '来源：model3 `FileReferences.Motions` 为空，回退扫描同目录 `*.motion3.json`（组名去序号后缀）。播放用组名（不是文件名）。' : '来源：model3 `FileReferences.Motions`。播放用组名（不是文件名）。');
  L();
  L('| 组名（ID） | 文件 | 成对槽（motion-director） |');
  L('|---|---|---|');
  for (const m of catalog.motions) {
    L(`| \`${m.group}\` | \`${m.file}\` | ${m.pairSlot || '—'} |`);
  }
  L();
  if (catalog.motionPairs.length) {
  L('成对规则（`packages/renderer/src/app/motion-director.ts`）：');
  for (const s of catalog.motionPairs) {
    L(`- **${s.base}**：打开 \`${s.openGroup}\` / 关闭 \`${s.closeGroup}\`；姿态骨 ${s.poseParams.map((x) => '`' + x + '`').join(', ')}`);
  }
  L('- `竖手指` 与 `狗尾巴草` 共用右臂姿态骨，不可同时打开；`抚胸手` 用左臂，可与右臂共存。');
  L();
  }
  L('## 表情（expressions）');
  L();
  L(catalog.model.expressionSource === 'scan' ? '来源：model3 `FileReferences.Expressions` 为空，回退扫描同目录 `*.exp3.json`（表情名 = 文件名去扩展名）。' : '来源：model3 `FileReferences.Expressions`（Name 为 ID）。');
  L();
  L('| 表情名（ID） | 文件 | 写入参数（来自 exp3） |');
  L('|---|---|---|');
  for (const e of catalog.expressions) {
    const params = (e.parameters || []).map((p) => `\`${p.Id}\`=${p.Value}`).join(', ') || '—';
    L(`| \`${e.name}\` | \`${e.file}\` | ${params} |`);
  }
  L();
  L('## 指令名（overlay / host-guard）');
  L();
  L('### overlay.js `case` 列表');
  L();
  for (const c of catalog.commands.overlay) L(`- \`${c}\``);
  L();
  L('### host-guard `HOST_ALLOWED_TOOLS`（LLM 白名单）');
  L();
  for (const c of catalog.commands.hostAllowed) L(`- \`${c}\``);
  L();
  L('仅在 overlay 出现、未进 HOST 白名单的：');
  const onlyOverlay = catalog.commands.overlay.filter((c) => !catalog.commands.hostAllowed.includes(c));
  if (onlyOverlay.length) for (const c of onlyOverlay) L(`- \`${c}\``);
  else L('- （无）');
  L();
  L('## 参数分组（cdi3 ParameterGroups）');
  L();
  L('| GroupId | 显示名 | 参数数 |');
  L('|---|---|---|');
  for (const g of catalog.parameterGroups) {
    L(`| \`${g.id}\` | ${g.name} | ${g.count} |`);
  }
  L();
  L('## 参数全表');
  L();
  L('量程 / 默认：Cubism Core 读 moc3。显示名 / 分组：cdi3（cdi3 **不含** min/max/default）。');
  L('`physicsOutput=是` 时，直写需 `own:true`（见 host-guard / param-guards）。');
  L();
  L('| Id | 显示名 | 分组 | min | max | default | 物理输出 |');
  L('|---|---|---|---|---|---|---|');
  const phys = new Set(catalog.physicsOutputIds);
  for (const p of catalog.parameters) {
    L(`| \`${p.id}\` | ${p.name || ''} | ${p.groupName || p.groupId || ''} | ${p.min} | ${p.max} | ${p.default} | ${phys.has(p.id) ? '是' : '否'} |`);
  }
  L();
  L('## 口型禁区 / 引擎组');
  L();
  L('来源：model3 `Groups` + `packages/dsh-l2d-plugin/lib/param-guards.mjs`。');
  L();
  L('| 组 | 参数 | 说明 |');
  L('|---|---|---|');
  for (const g of catalog.engineGroups) {
    L(`| ${g.name} | ${g.ids.map((x) => '`' + x + '`').join(', ')} | ${g.note || ''} |`);
  }
  L();
  L('代码口型禁区 `LIPSYNC_PARAMS`：');
  for (const id of catalog.lipsyncParams) {
    const inModel = catalog.parameters.some((p) => p.id === id);
    L(`- \`${id}\`${inModel ? '' : '（**未在 moc3/cdi3 中找到**；仍作保留名拦截）'}`);
  }
  L();
  L('## 节点图引用方式');
  L();
  L('来源：`packages/dsh-l2d-plugin/lib/nodegraph.mjs`、`docs/nodegraph/SPEC.md`。');
  L();
  L('- 节点类型：`expression` / `motion` / `pose` / `look` / `delay`（及文档中的动作链 step kind）。');
  L('- `expression.name`、`motion` 组名必须是本目录 ID。');
  L('- 参数直写（`l2d_set_parameters` / keyframes / posture）的键必须是本目录参数 Id，且值 ∈ [min, max]。');
  L('- 形态用 `l2d_set_form` 的 index，不要把 `Clothes2` 当「形态枚举名」写进节点显示字段。');
  L();
  L('## 校验规则建议');
  L();
  L('来源于当前代码现状，供 `ai-edit` / `apply-ops` / MCP 共用：');
  L();
  L('1. **参数 Id** 必须存在于本目录；值必须在 `min..max` 内（闭区间）。');
  L('2. **口型禁区**（`ParamMouthOpenY` / `ParamMouthOpen` / `ParamMouthForm`）任何通道拒绝写入；四子阶段模板（thinking/working/attention/idle 等 choreography）不得出现这些 Id。');
  L('3. **物理输出**参数直写必须带 `own:true`，否则 reason `physics-unowned`（以 host-guard 为准）。');
  L('4. **动作组**必须存在于本目录；成对动作遵守 motion-director 冲突/幂等（already-open / conflict）。');
  L('5. **表情名**必须存在于本目录。');
  L('6. **形态**只用 `l2d_set_form`，`index` 为整数 0..2；非法 → `invalid-form-index`。不可用的渲染器 → `form-unavailable`。');
  L('7. **reason 代码保持英文**（如 `invalid-form-index`、`form-unavailable`、`reserved-param`）；前端按语言表翻译提示文案。');
  L('8. 节点图 JSON **只存 ID**，不存显示名；三种语言导出应逐字节一致。');
  L('9. 已知：部分 exp3（`裙子切换`/`尾巴开关`）把 `Clothes1`/`Clothes5` 写成 `-1`，**超出 moc3 量程 0..1**；校验仍以 moc3 为准，播放表情由运行时钳制。');
  L();
  L('## 未找到 / 推断说明');
  L();
  for (const n of catalog.notes) L(`- ${n}`);
  L();
  return lines.join('\n');
}

async function main() {
  const modelDir = resolveModelDir();
  const model3File = pickModel3File(modelDir);
  const model3Path = path.join(modelDir, model3File);
  // modelId = 模型文件名去 .model3.json（统一裁决：单个点放行，如 大肥鱼.dsl2d.2048）
  const modelId = model3File.slice(0, -'.model3.json'.length);
  const model3 = readJson(model3Path);
  const fr = model3.FileReferences || {};

  // 资源文件按 model3 自声明（FileReferences）优先；未声明时按目录通用名/首文件兜底。
  const moc3Path = fr.Moc
    ? path.join(modelDir, fr.Moc)
    : findFile(modelDir, [`${modelId}.moc3`, 'model.moc3'], /\.moc3$/);
  const cdi3Path = findFile(modelDir, [moc3Path ? path.basename(moc3Path).replace(/\.moc3$/, '.cdi3.json') : ''], /\.cdi3\.json$/);
  const physicsPath = fr.Physics
    ? path.join(modelDir, fr.Physics)
    : findFile(modelDir, [], /\.physics3\.json$/);
  const pose3Path = findFile(modelDir, [], /\.pose3\.json$/);

  if (!model3Path || !moc3Path) {
    throw new Error(`模型文件不完整：model3=${model3Path} moc3=${moc3Path}`);
  }

  const coreCandidates = [
    process.env.DSH_L2D_CUBISM_CORE,
    path.join(REPO, 'vendor/cubism/CubismSdkForWeb-5-r.5/Core/live2dcubismcore.min.js'),
    '/workspace/test/DSH-L2D/vendor/cubism/CubismSdkForWeb-5-r.5/Core/live2dcubismcore.min.js',
  ].filter(Boolean);
  const corePath = coreCandidates.find((p) => fs.existsSync(p));
  if (!corePath) throw new Error('找不到 live2dcubismcore.min.js，请设 DSH_L2D_CUBISM_CORE');

  console.log('modelDir', modelDir);
  console.log('model3', model3Path);
  console.log('modelId', modelId);
  console.log('core', corePath);

  const cdi3 = cdi3Path ? readJson(cdi3Path) : { Parameters: [], ParameterGroups: [] };
  const physics = physicsPath ? readJson(physicsPath) : { PhysicsSettings: [] };
  const ranges = await extractRangesFromMoc3(moc3Path, corePath);

  const groupById = new Map(
    (cdi3.ParameterGroups || []).map((g) => [g.Id, g.Name || '']),
  );
  const cdiById = new Map(
    (cdi3.Parameters || []).map((p) => [p.Id, p]),
  );
  const rangeById = new Map(ranges.parameters.map((p) => [p.id, p]));

  // 对齐：moc3 与 cdi3 都应同数
  const onlyMoc = ranges.parameters.filter((p) => !cdiById.has(p.id)).map((p) => p.id);
  const onlyCdi = [...cdiById.keys()].filter((id) => !rangeById.has(id));

  const physIds = physicsOutputIds(physics);

  const parameters = ranges.parameters.map((r) => {
    const c = cdiById.get(r.id);
    return {
      id: r.id,
      name: c?.Name || '',
      groupId: c?.GroupId || '',
      groupName: groupById.get(c?.GroupId) || '',
      min: r.min,
      max: r.max,
      default: r.default,
      physicsOutput: physIds.includes(r.id),
      rangeSource: 'moc3+cubism-core',
    };
  });

  const parameterGroups = (cdi3.ParameterGroups || []).map((g) => ({
    id: g.Id,
    name: g.Name || '',
    count: parameters.filter((p) => p.groupId === g.Id).length,
  }));

  // 动作组：FileReferences.Motions 为空（或只有无效空组名）时回退扫描同目录 *.motion3.json
  //（组名去序号后缀）。空字符串组名是损坏的 model3（VTS 导出缺陷），按组名不可播放处理，
  // 只记录异常 note，不进清单。
  let motionSource = 'model3';
  let motionGroups;
  let emptyMotionGroupFiles = 0;
  if (fr.Motions && typeof fr.Motions === 'object') {
    motionGroups = Object.keys(fr.Motions).filter((g) => typeof g === 'string' && g.trim());
    for (const g of Object.keys(fr.Motions)) {
      if (!g || !g.trim()) emptyMotionGroupFiles += (fr.Motions[g] || []).length;
    }
    if (!motionGroups.length) {
      motionSource = 'scan';
      motionGroups = scanMotionGroups(modelDir, fs);
    }
  } else {
    motionSource = 'scan';
    motionGroups = scanMotionGroups(modelDir, fs);
  }
  const motions = [];
  for (const group of motionGroups) {
    const list = (fr.Motions && fr.Motions[group]) || [];
    for (const item of list) {
      motions.push({ group, file: item.File || '' });
    }
    if (!list.length) motions.push({ group, file: '' });
  }

  // 成对动作槽是宿主 motion-director 代码事实（大肥鱼）；组名在本模型不存在时自动消失。
  const pairSlots = [
    { base: '抚胸手', openGroup: '抚胸手打开', closeGroup: '抚胸手关闭', poseParams: ['Param59', 'Param60', 'Param61', 'Param62'] },
    { base: '竖手指', openGroup: '竖手指打开', closeGroup: '竖手指关闭', poseParams: ['Param36', 'Param39', 'Param40', 'Param41', 'Param42', 'Param43'] },
    { base: '狗尾巴草', openGroup: '狗尾巴草打开', closeGroup: '狗尾巴草关闭', poseParams: ['Param36', 'Param39', 'Param41', 'Param42', 'Param43'] },
  ].filter((s) => motionGroups.includes(s.openGroup) && motionGroups.includes(s.closeGroup));
  const pairByGroup = new Map();
  for (const s of pairSlots) {
    pairByGroup.set(s.openGroup, s.base);
    pairByGroup.set(s.closeGroup, s.base);
  }
  for (const m of motions) m.pairSlot = pairByGroup.get(m.group) || null;

  // 表情：FileReferences.Expressions 为空（或 Name 全无效）时回退扫描同目录 *.exp3.json
  //（表情名 = 文件名去扩展名）。
  let expressionSource = 'model3';
  let expressionEntries;
  if (Array.isArray(fr.Expressions) && fr.Expressions.some((e) => e && typeof e.Name === 'string' && e.Name.trim())) {
    expressionEntries = fr.Expressions
      .filter((e) => e && typeof e.Name === 'string' && e.Name.trim())
      .map((e) => ({ Name: e.Name, File: e.File || '' }));
  } else {
    expressionSource = 'scan';
    expressionEntries = scanExpressionFiles(modelDir, fs).map((name) => ({ Name: name, File: name + '.exp3.json' }));
  }
  const expressions = [];
  for (const e of expressionEntries) {
    const file = e.File || '';
    const expPath = path.join(modelDir, file);
    let parametersInExp = [];
    if (fs.existsSync(expPath)) {
      const exp = readJson(expPath);
      parametersInExp = (exp.Parameters || []).map((p) => ({ Id: p.Id, Value: p.Value }));
    }
    expressions.push({ name: e.Name, file, parameters: parametersInExp });
  }

  const overlayPath = path.join(REPO, 'packages/dsh-l2d-plugin/lib/overlay.js');
  const hostGuardPath = path.join(REPO, 'packages/dsh-l2d-plugin/lib/host-guard.mjs');
  const paramGuardsPath = path.join(REPO, 'packages/dsh-l2d-plugin/lib/param-guards.mjs');
  const overlaySrc = fs.readFileSync(overlayPath, 'utf8');
  const hostGuardSrc = fs.readFileSync(hostGuardPath, 'utf8');
  const paramGuardsSrc = fs.readFileSync(paramGuardsPath, 'utf8');

  // 形态来自宿主 overlay 的 BODY_TYPES（写参数 Clothes2）：只有模型 moc3 里真有
  // Clothes2 参数才有意义，否则 forms 为空（不给 AI 编造形态切换能力）。
  const forms = extractBodyTypes(overlaySrc).filter((f) => parameters.some((p) => p.id === f.paramId));
  const overlayCommands = extractOverlayCommands(overlaySrc);
  const hostAllowed = extractHostAllowedTools(hostGuardSrc);

  const lipsync = [...paramGuardsSrc.matchAll(/'(ParamMouth[^']*)'/g)].map((m) => m[1]);
  const lipsyncParams = [...new Set(lipsync)];

  const engineGroups = (model3.Groups || []).map((g) => ({
    name: g.Name,
    target: g.Target,
    ids: g.Ids || [],
    note: g.Name === 'LipSync' ? '口型红线，行为/节点不得写' : g.Name === 'EyeBlink' ? '眨眼组，引擎可接管' : '',
  }));

  // 表情文件把参数写出 moc3 量程是模型既有行为（如大肥鱼 裙子切换 Clothes1=-1）：目录仍以 moc3 为准。
  const outOfRange = [];
  for (const e of expressions) {
    for (const p of e.parameters || []) {
      const r = rangeById.get(p.Id);
      if (r && (Number(p.Value) < r.min || Number(p.Value) > r.max)) outOfRange.push(`exp3 \`${e.name}\` 写 ${p.Id}=${p.Value}（moc3 量程 ${r.min}..${r.max}）`);
    }
  }

  const notes = [
    `参数量程全部来自 Cubism Core 读取 \`${path.basename(moc3Path)}\`，不是命名推断。`,
    cdi3Path ? 'cdi3 只有 Id/GroupId/Name，**不含** min/max/default。' : 'cdi3 未找到：显示名/分组为空，量程仍以 moc3 为准。',
    pose3Path ? `pose3: ${path.basename(pose3Path)}` : 'pose3：未在模型目录中找到。',
    `HitAreas：model3 声明为 ${JSON.stringify(model3.HitAreas || [])}。`,
    onlyMoc.length ? `仅在 moc3、不在 cdi3：${onlyMoc.join(', ')}` : 'moc3 与 cdi3 参数 Id 集合一致（0 差异）。',
    onlyCdi.length ? `仅在 cdi3、不在 moc3：${onlyCdi.join(', ')}` : null,
    outOfRange.length ? `${outOfRange.join('；')}；超出 moc3 量程，目录仍以 moc3 为准（播放由运行时钳制）。` : null,
    emptyMotionGroupFiles ? `FileReferences.Motions 含**空字符串组名**（${emptyMotionGroupFiles} 个 motion 文件）：空组名不可播放，未计入清单；${motionSource === 'scan' ? '已回退目录扫描' : '有效组名仍按 FileReferences 为准'}。` : null,
    '目录扫描（exp3/motion3）只覆盖模型目录**顶层**（与运行时 loadModelIndex 同规则）；子目录里的资源不索引。',
    '`ParamMouthOpen` 在 LIPSYNC_PARAMS 中但未出现在本模型 moc3/cdi3（保留名拦截）。',
    '成对动作槽 poseParams 来自 motion-director.ts，不是 moc3 字段（仅当动作组存在时列出）。',
    'forms 来自宿主 overlay 的 BODY_TYPES（大肥鱼专用）；本模型没有该表时 forms 为空。',
    'HOST_ALLOWED_TOOLS 与 overlay case 列表是宿主代码事实，与模型无关。',
  ].filter(Boolean);

  const catalog = {
    schemaVersion: 1,
    modelId,
    generatedBy: 'tools/live2d-catalog/build-live2d-catalog.mjs',
    generatedAt: new Date().toISOString(),
    model: {
      dir: modelDir,
      model3File: path.basename(model3Path),
      moc3File: path.basename(moc3Path),
      cdi3File: cdi3Path ? path.basename(cdi3Path) : null,
      physics3File: physicsPath ? path.basename(physicsPath) : null,
      pose3File: pose3Path ? path.basename(pose3Path) : null,
      motionSource,
      expressionSource,
    },
    ranges: { source: ranges.source, count: ranges.count },
    forms,
    motions,
    motionPairs: pairSlots,
    expressions,
    commands: { overlay: overlayCommands, hostAllowed },
    parameterGroups,
    parameters,
    physicsOutputIds: physIds,
    engineGroups,
    lipsyncParams,
    hitAreas: model3.HitAreas || [],
    notes,
  };

  // 后端校验精简文件：严格字段
  const idsStrict = {
    params: Object.fromEntries(
      parameters.map((p) => [p.id, { min: p.min, max: p.max }]),
    ),
    motions: [...new Set(motions.map((m) => m.group))],
    expressions: expressions.map((e) => e.name),
    forms: forms.map((f) => f.index),
  };

  const writeOutputs = (dir) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'live2d-catalog.json'), JSON.stringify(catalog, null, 2) + '\n');
    fs.writeFileSync(path.join(dir, 'live2d-ids.json'), JSON.stringify(idsStrict, null, 2) + '\n');
    fs.writeFileSync(path.join(dir, 'LIVE2D-CATALOG.md'), buildMd(catalog) + '\n');
    console.log('wrote', path.join(dir, 'LIVE2D-CATALOG.md'));
    console.log('wrote', path.join(dir, 'live2d-catalog.json'));
    console.log('wrote', path.join(dir, 'live2d-ids.json'));
  };

  // 按模型目录（唯一权威位置；docs/nodegraph/models/ 不入库，授权待主理人裁定）
  writeOutputs(path.join(MODELS_OUT_DIR, modelId));
  // 全局 docs 是历史产物（大肥鱼）：只有大肥鱼的运行才写，其它模型不覆盖。
  if (modelId === GLOBAL_DOC_MODEL_ID) writeOutputs(OUT_DIR);

  console.log('stats', {
    modelId,
    params: parameters.length,
    motions: idsStrict.motions.length,
    expressions: idsStrict.expressions.length,
    forms: idsStrict.forms,
    physicsOutputs: physIds.length,
    overlayCommands: overlayCommands.length,
  });

  // Cubism WASM 会挂住事件循环
  setTimeout(() => process.exit(0), 50);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
