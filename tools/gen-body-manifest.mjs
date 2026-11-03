#!/usr/bin/env node
/**
 * 生成 body manifest（M1-g / G1 数据层）——**生成物，勿手改**。
 *
 * 输入（唯一事实源，不做参数名推测）：
 *   - DeepSeek免费公皮/DeepSeek/大肥鱼.physics3.json
 *       手臂物理输出 = 指定 PhysicsSetting 的 Output 目标集合（G0 审计 §2.3/§3.2）；
 *       共享枢纽 = 同时出现在 Input 与 Output 中的 id（G0 §3.3 S1/S2）；
 *       共享开关 = PhysicsSetting128 的 Input(Movement1/2/3) 与 Output(Param35)（G0 §3.3 S5）；
 *       跨域 = 姿态参数里同时是物理 Source 的那些（G0 §3.3 S4，本模型只有 Param42）。
 *   - DeepSeek免费公皮/DeepSeek/大肥鱼.cdi3.json
 *       姿态层参数 = 参数组「动画参数」的成员（GroupId 从 ParameterGroups 里按名称解析，
 *       不写死 ParamGroup26）；一组成员同时用于校验 SEED_POSE 的归属。
 *
 * 输出：packages/renderer/src/app/body-manifest.ts（静态 TS 模块，node/vite 都可直读）
 *
 * 用法：
 *   node tools/gen-body-manifest.mjs           # 写文件（幂等：重复执行 diff 为空）
 *   node tools/gen-body-manifest.mjs --check   # 只校验：与磁盘内容不一致 → exit 1
 *   node tools/gen-body-manifest.mjs --print   # 打印生成的模块文本（不写盘）
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const MODEL_DIR =
  process.env.DSH_L2D_MODEL_DIR || path.join(ROOT, 'DeepSeek免费公皮', 'DeepSeek');
const PHYSICS_FILE = path.join(MODEL_DIR, '大肥鱼.physics3.json');
const CDI_FILE = path.join(MODEL_DIR, '大肥鱼.cdi3.json');
const OUT_FILE = path.join(ROOT, 'packages', 'renderer', 'src', 'app', 'body-manifest.ts');

/**
 * 手臂物理输出的 setting 编号（G0 §3.2 的域划分，**编号是唯一稳定键**：
 * setting 名称是美术命名，重命名不影响物理语义）。
 * 右臂：73 大臂/小臂/手腕、75 手、78 袖子X、79 袖子Y、80 飘带X。
 * 左臂：72、74、76、77、81（同名同构；左侧无 LSleeveY1，物理输出叫 LSleeveY）。
 */
const ARM_SETTINGS = {
  right: [73, 75, 78, 79, 80],
  left: [72, 74, 76, 77, 81],
};

/** 共享开关 setting（G0 §3.3 S5）：三条 Movement* 同权汇入 Param35。 */
const SHARED_SWITCH_SETTING = 128;

/**
 * 姿态层锚点（G0 §3.1 表「姿态/可写参数」列的人工审读结果）。
 * 这些 id 无法从 physics3 图推导（它们不在图里，这正是问题所在），
 * 因此在此声明，并由下面的断言强制与 cdi3 参数组、physics3 图保持一致：
 *   - 必须全部属于 cdi3「动画参数」组；
 *   - 必须全部不是物理输出；
 *   - 与物理图的交集必须恰好等于 CROSS_DOMAIN。
 * 侧别（右/左）来自 G0 §3.1 的逐行归属；Param39/59 同名「大臂透视」，
 * 名字无法区分左右，故侧别只能取审计结论，不做名字推断。
 */
const SEED_POSE = {
  right: ['Param36', 'Param39', 'Param40', 'Param41', 'Param43'],
  left: ['Param59', 'Param60', 'Param61', 'Param62'],
};

/** 只在物理图里可推导的头部/躯干根输入（G0 §3.1「根输入」列），逐项断言存在性。 */
const ROOT_ONLY_SEED = {
  head: ['AngleX', 'AngleY', 'AngleZ'],
  torso: ['PositionX', 'PositionY', 'PositionZ', 'LeanInput'],
};

/** 稳定排序：码位序（localeCompare 受 locale 影响，会破坏跨机幂等）。 */
function byCodeUnit(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function fail(msg) {
  throw new Error('[gen-body-manifest] ' + msg);
}

/** 从 physics3 建图：outputs / inputs / 每个 setting 的 in-out。 */
function graphOf(physics) {
  const settings = new Map();
  const outputs = new Set();
  const inputs = new Set();
  for (const s of physics.PhysicsSettings || []) {
    const id = Number(String(s.Id || '').replace('PhysicsSetting', ''));
    const ins = (s.Input || []).map((i) => i.Source && i.Source.Id).filter(Boolean);
    const outs = (s.Output || []).map((o) => o.Destination && o.Destination.Id).filter(Boolean);
    if (settings.has(id)) fail('重复的 PhysicsSetting 编号 ' + id);
    settings.set(id, { ins, outs });
    for (const o of outs) outputs.add(o);
    for (const i of ins) inputs.add(i);
  }
  return { settings, outputs, inputs };
}

/** cdi3「动画参数」组成员（按组名解析 GroupId）。 */
function animParamsOf(cdi) {
  const groups = cdi.ParameterGroups || [];
  const group = groups.find((g) => g && g.Name === '动画参数');
  if (!group) fail('cdi3 里找不到「动画参数」参数组');
  const ids = (cdi.Parameters || [])
    .filter((p) => p && p.GroupId === group.Id)
    .map((p) => p.Id);
  if (!ids.length) fail('「动画参数」组为空');
  return new Set(ids);
}

/** 纯函数：输入两份 JSON 原文，输出 manifest 结构（测试与 CLI 共用）。 */
export function buildManifest(physics, cdi) {
  const { settings, outputs, inputs } = graphOf(physics);
  const anim = animParamsOf(cdi);

  const armPhysics = {};
  for (const side of ['right', 'left']) {
    const ids = new Set();
    for (const n of ARM_SETTINGS[side]) {
      const s = settings.get(n);
      if (!s) fail('physics3 缺少 PhysicsSetting' + n + '（' + side + ' 臂域）');
      for (const o of s.outs) ids.add(o);
    }
    armPhysics[side] = [...ids].sort(byCodeUnit);
  }

  const pose = { right: [...SEED_POSE.right].sort(byCodeUnit), left: [...SEED_POSE.left].sort(byCodeUnit) };
  const poseAll = [...pose.right, ...pose.left];

  // ---- 断言：姿态层与物理图的关系必须与审计结论一致（漂移即失败，不静默）
  for (const id of poseAll) {
    if (!anim.has(id)) fail('姿态参数 ' + id + ' 不属于 cdi3「动画参数」组（审计分组漂移）');
    if (outputs.has(id)) fail('姿态参数 ' + id + ' 成了物理输出（域划分与 G0 不一致）');
  }
  // 跨域 = 「动画参数」组里同时是物理 Source 的 id（G0 §3.3 S4）。这类参数在姿态层可见，
  // 又会喂给别处物理，因此既不进 ARM_*_POSE（免得被当成"纯姿态"），也不进可 own 名单。
  const crossDomain = [...anim].filter((id) => inputs.has(id)).sort(byCodeUnit);
  if (!crossDomain.length) fail('姿态层与物理图无交集：G0 §3.3 S4 的跨域结论无法复现');
  for (const id of crossDomain) {
    if (outputs.has(id)) fail('跨域参数 ' + id + ' 同时是物理输出，超出 G0 §3.3 S4 的口径');
  }
  for (const id of poseAll) {
    if (crossDomain.includes(id)) fail('姿态参数 ' + id + ' 应在 CROSS_DOMAIN 而不是 ARM_*_POSE');
  }

  // ---- 断言：手臂物理输出不得有任何下游消费者（叶子域，G0 §0-1）
  const armAll = [...armPhysics.right, ...armPhysics.left];
  if (new Set(armAll).size !== armAll.length) fail('左右手臂物理输出集合有重复 id');
  for (const id of armAll) {
    if (inputs.has(id)) fail('手臂物理输出 ' + id + ' 存在下游消费者，不再是叶子域');
  }

  // ---- 共享枢纽：物理输出 ∩ 物理输入，且按审计口径限定 ParamAngle*/ParamBodyAngle* 族（S1/S2）
  const sharedHubs = [...outputs]
    .filter((id) => inputs.has(id))
    .filter((id) => /^Param(Body)?Angle/.test(id))
    .sort(byCodeUnit);

  // ---- 共享开关（S5）：单条 setting 的 Input 全部同权汇入同一 Output
  const sw = settings.get(SHARED_SWITCH_SETTING);
  if (!sw) fail('physics3 缺少 PhysicsSetting' + SHARED_SWITCH_SETTING + '（手臂开关物理）');
  if (sw.outs.length !== 1) fail('手臂开关 setting 的输出不是单一参数');
  const sharedSwitch = [...sw.ins, ...sw.outs].sort(byCodeUnit);
  const sharedForbidden = [...new Set([...sharedHubs, ...sharedSwitch])].sort(byCodeUnit);

  // ---- 根输入：必须存在且不是物理输出
  for (const list of Object.values(ROOT_ONLY_SEED)) {
    for (const id of list) {
      if (!inputs.has(id)) fail('根输入 ' + id + ' 不是任何 physics setting 的 Source');
      if (outputs.has(id)) fail('根输入 ' + id + ' 同时是物理输出，不能作为可直写根输入');
    }
  }

  return {
    armPhysics,
    pose,
    crossDomain,
    sharedForbidden,
    rootOnly: {
      head: [...ROOT_ONLY_SEED.head].sort(byCodeUnit),
      torso: [...ROOT_ONLY_SEED.torso].sort(byCodeUnit),
    },
    meta: {
      settingCount: settings.size,
      outputCount: outputs.size,
      sourceSha256: {
        physics3: sha256File(PHYSICS_FILE),
        cdi3: sha256File(CDI_FILE),
      },
    },
  };
}

function sha256File(file) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16);
  } catch {
    return 'unavailable';
  }
}

function tsArray(name, ids, comment) {
  const lines = ids.map((id) => "  '" + id + "',");
  return (
    '/** ' +
    comment +
    '（' +
    ids.length +
    ' 个） */\nexport const ' +
    name +
    ': readonly string[] = [\n' +
    lines.join('\n') +
    '\n];\n'
  );
}

/** 纯函数：manifest → TS 模块文本（幂等：同一输入逐字节相同）。 */
export function renderModule(m) {
  const armAll = [...m.armPhysics.right, ...m.armPhysics.left].sort(byCodeUnit);
  return (
    '/**\n' +
    ' * 身体部位参数域清单（M1-g / G1）。\n' +
    ' *\n' +
    ' * **生成物，勿手改**：由 `node tools/gen-body-manifest.mjs` 从\n' +
    ' * `DeepSeek免费公皮/DeepSeek/大肥鱼.physics3.json` + `大肥鱼.cdi3.json` 生成。\n' +
    ' * 依据：docs/M1-G-PHYSICS-RIG-AUDIT.md §2.3（292 个物理输出的精确 id）与 §3（域映射/S1–S5）。\n' +
    ' *\n' +
    ' * 分层（G0 §1.3 事实 3、§4.1 两条接管路径）：\n' +
    ' *  - `ARM_*_PHYSICS`：物理叶子域的**输出**（可 own，post 覆盖；0 下游消费者）。\n' +
    ' *  - `ARM_*_POSE`：姿态层（**不是**物理输出，普通写即可，不需要也不能 own）。\n' +
    ' *  - `CROSS_DOMAIN`：既是姿态层又是物理 Source（本模型 Param42 → 尾巴 PhysicsSetting131）。\n' +
    ' *  - `SHARED_FORBIDDEN`：共享枢纽/共享开关，**禁止**按侧独占（S1/S2/S5）。\n' +
    ' *  - `ROOT_ONLY`：头/躯干的物理根输入（只能写根，不能 own 输出；S1/S2）。\n' +
    ' *\n' +
    ' * 源文件指纹：physics3=' +
    m.meta.sourceSha256.physics3 +
    ' cdi3=' +
    m.meta.sourceSha256.cdi3 +
    '（' +
    m.meta.settingCount +
    ' settings / ' +
    m.meta.outputCount +
    ' 物理输出）。\n' +
    ' */\n\n' +
    tsArray('ARM_RIGHT_PHYSICS', m.armPhysics.right, '右臂物理输出（settings 73/75/78/79/80）') +
    '\n' +
    tsArray('ARM_LEFT_PHYSICS', m.armPhysics.left, '左臂物理输出（settings 72/74/76/77/81）') +
    '\n' +
    tsArray('ARM_ALL_PHYSICS', armAll, '双臂物理输出合集 = limb 可 own 白名单的全集') +
    '\n' +
    tsArray('ARM_RIGHT_POSE', m.pose.right, '右臂姿态层（非物理输出，普通写）') +
    '\n' +
    tsArray('ARM_LEFT_POSE', m.pose.left, '左臂姿态层（非物理输出，普通写）') +
    '\n' +
    tsArray('CROSS_DOMAIN', m.crossDomain, '姿态层同时是物理 Source（跨域耦合）') +
    '\n' +
    tsArray('SHARED_FORBIDDEN', m.sharedForbidden, '共享枢纽/开关，禁止按侧独占') +
    '\n' +
    '/** 头/躯干物理根输入（只写根输入，不 own 输出）。 */\n' +
    'export const ROOT_ONLY: Readonly<{ head: readonly string[]; torso: readonly string[] }> = {\n' +
    '  head: [\n' +
    m.rootOnly.head.map((id) => "    '" + id + "',").join('\n') +
    '\n  ],\n' +
    '  torso: [\n' +
    m.rootOnly.torso.map((id) => "    '" + id + "',").join('\n') +
    '\n  ],\n' +
    '};\n\n' +
    '/** `ARM_ALL_PHYSICS` 的集合视图（LimbController.isOwnable 的唯一判据）。 */\n' +
    'export const MANIFEST_ALL_PHYSICS: ReadonlySet<string> = new Set(ARM_ALL_PHYSICS);\n'
  );
}

function main() {
  const argv = process.argv.slice(2);
  const check = argv.includes('--check');
  const print = argv.includes('--print');
  for (const f of [PHYSICS_FILE, CDI_FILE]) {
    if (!fs.existsSync(f)) {
      console.error('[gen-body-manifest] 缺少输入文件：' + f);
      process.exit(1);
    }
  }
  const physics = JSON.parse(fs.readFileSync(PHYSICS_FILE, 'utf8'));
  const cdi = JSON.parse(fs.readFileSync(CDI_FILE, 'utf8'));
  let text;
  try {
    text = renderModule(buildManifest(physics, cdi));
  } catch (err) {
    console.error(String(err && err.message ? err.message : err));
    process.exit(1);
  }
  if (print) {
    process.stdout.write(text);
    return;
  }
  const prev = fs.existsSync(OUT_FILE) ? fs.readFileSync(OUT_FILE, 'utf8') : null;
  if (check) {
    if (prev !== text) {
      console.error('[gen-body-manifest] --check 失败：' + OUT_FILE + ' 与生成结果不一致');
      process.exit(1);
    }
    console.log('[gen-body-manifest] --check OK（生成物与源数据一致）');
    return;
  }
  if (prev === text) {
    console.log('[gen-body-manifest] 无变化（幂等）：' + path.relative(ROOT, OUT_FILE));
    return;
  }
  fs.writeFileSync(OUT_FILE, text);
  console.log('[gen-body-manifest] 已写入：' + path.relative(ROOT, OUT_FILE));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
