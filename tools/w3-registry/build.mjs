#!/usr/bin/env node
/**
 * W3 Motion Capability Registry 生成器。
 *
 * 原则：登记项必须有资产/曲线/源码证据，**不靠命名推断**。
 *   - 动作控制哪些参数：从 motion3.json 曲线解析（不是按名字猜）
 *   - 表情控制哪些参数：从 exp3.json 参数表解析
 *   - 时长/淡入淡出/loop 标记：motion3 Meta + model3 FadeInTime/FadeOutTime
 *   - 冲突/组合/中断/前置/恢复：来自 motion-director / pose-controller / index.ts 的实际行为，
 *     每条带源码或实测证据；无法确认的写 "unverified" 并在文档里标「待验证」。
 *
 * 用法：
 *   node tools/w3-registry/build.mjs            # 写 tools/w3-registry/registry.json + docs/W3-Motion-Capability-Registry.md
 *   node tools/w3-registry/build.mjs --check    # 只打印摘要，不写文件（CI/测试用）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
// 模型文件不入库：优先环境变量，其次本 worktree，最后共享 checkout（只读）。
const modelDirCandidates = [
  process.env.DSH_L2D_MODEL_DIR,
  path.join(ROOT, 'DeepSeek免费公皮', 'DeepSeek'),
  'D:/Desktop/DSH-L2D/DeepSeek免费公皮/DeepSeek',
].filter(Boolean);
const MODEL_DIR = modelDirCandidates.find((p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
});
if (!MODEL_DIR) throw new Error('找不到模型目录，请设置 DSH_L2D_MODEL_DIR');
const MODEL3 = process.env.DSH_L2D_MODEL3 || '大肥鱼.dsl2d.model3.json';
const CHECK_ONLY = process.argv.includes('--check');

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

/** 解析 motion3 曲线：返回每个参数的 min/max/末值，以及曲线段类型统计。 */
function parseMotion3(file) {
  const json = readJson(file);
  const params = new Map();
  for (const curve of json.Curves || []) {
    if (curve.Target !== 'Parameter' || !curve.Id) continue;
    const seg = curve.Segments || [];
    if (seg.length < 2) continue;
    const values = [Number(seg[1])];
    const types = new Set();
    let i = 2;
    while (i < seg.length - 1) {
      const type = Number(seg[i]);
      types.add(type);
      const step = type === 1 ? 6 : 2;
      const endValue = Number(seg[i + step]);
      if (Number.isFinite(endValue)) values.push(endValue);
      // 贝塞尔段还要记录控制点极值（曲线可能中途越界）
      if (type === 1) {
        for (let k = 1; k <= 3; k++) {
          const v = Number(seg[i + k * 2]);
          if (Number.isFinite(v)) values.push(v);
        }
      }
      i += 1 + step;
    }
    const cur = params.get(curve.Id) || { id: curve.Id, min: Infinity, max: -Infinity, end: 0, segments: 0, valueTypes: new Set() };
    cur.segments += values.length - 1;
    for (const t of types) cur.valueTypes.add(t);
    for (const v of values) {
      if (!Number.isFinite(v)) continue;
      cur.min = Math.min(cur.min, v);
      cur.max = Math.max(cur.max, v);
    }
    cur.end = values[values.length - 1];
    params.set(curve.Id, cur);
  }
  const paramsOut = [...params.values()].map((p) => ({
    id: p.id,
    min: round(p.min),
    max: round(p.max),
    end: round(p.end),
    segments: p.segments,
    // 0=linear 1=bezier 2=stepped 3=inverse-stepped
    curveTypes: [...p.valueTypes].sort(),
  }));
  return {
    meta: json.Meta || {},
    curves: (json.Curves || []).length,
    params: paramsOut,
  };
}

function round(v) {
  return Number.isFinite(v) ? Math.round(v * 1000) / 1000 : v;
}

function parseExp3(file) {
  const json = readJson(file);
  return (json.Parameters || []).map((p) => ({
    id: p.Id,
    value: round(Number(p.Value)),
    blend: p.Blend || 'Add',
  }));
}

// ---------------------------------------------------------------------------
// 语义骨架（authoring）：这里只写「人/代码已经确认」的语义、API、冲突与证据。
// 参数清单、时长、淡入淡出由模型文件生成后合并进来，避免手抄漂移。
// ---------------------------------------------------------------------------

/** 源码证据：基线 96069c9 的行号，供审计追溯。 */
const SRC = {
  motionDirector: 'packages/renderer/src/app/motion-director.ts',
  poseController: 'packages/renderer/src/app/pose-controller.ts',
  index: 'packages/renderer/src/index.ts',
  overlay: 'packages/dsh-l2d-plugin/lib/overlay.js',
  contract: 'docs/Ownership-Invariants.md',
};

/** pose-controller.ts 的姿势参数表（与 POSE_IDS 一致）。 */
const POSE_IDS = ['Param36', 'Param39', 'Param40', 'Param41', 'Param42', 'Param43', 'Param59', 'Param60', 'Param61', 'Param62'];

const MOTION_SEMANTICS = {
  竖手指: {
    id: 'gesture.right_finger',
    label: '竖手指（右手指向）',
    slot: '竖手指',
    arm: 'right',
    interruptible: true,
    composable: { with: ['gesture.chest'], conflictWith: ['gesture.grass'] },
    preconditions: ['右臂空闲（狗尾巴草未打开）', '动作槽未被 FORCE 动作占用'],
    recovery: '播放「竖手指关闭」或 l2d_reset / resetPose（终态参数被姿势层 adopt，可继续持有）',
    conflicts: [
      { with: 'gesture.grass', type: 'param-overlap', params: ['Param36', 'Param39', 'Param41', 'Param42', 'Param43'], reason: '同为右臂姿态骨，同开逐帧互抢' },
    ],
    stateNotes: ['重复播放「竖手指打开」返回 skipped(already-open)；未打开时播放「竖手指关闭」返回 skipped(already-closed)'],
    evidence: [SRC.motionDirector + ':32-49 PAIRED_SLOTS[竖手指]', SRC.motionDirector + ':105-140 decide() 冲突/幂等', SRC.overlay + ':1758 executePokeAction'],
  },
  狗尾巴草: {
    id: 'gesture.grass',
    label: '狗尾巴草（右手道具）',
    slot: '狗尾巴草',
    arm: 'right',
    interruptible: true,
    composable: { with: ['gesture.chest'], conflictWith: ['gesture.right_finger'] },
    preconditions: ['右臂空闲（竖手指未打开）'],
    recovery: '播放「狗尾巴草关闭」或 l2d_reset',
    conflicts: [
      { with: 'gesture.right_finger', type: 'param-overlap', params: ['Param36', 'Param39', 'Param41', 'Param42', 'Param43'], reason: '同为右臂姿态骨' },
    ],
    evidence: [SRC.motionDirector + ':32-49 PAIRED_SLOTS[狗尾巴草]'],
  },
  抚胸手: {
    id: 'gesture.chest',
    label: '抚胸手（左手抚胸）',
    slot: '抚胸手',
    arm: 'left',
    interruptible: true,
    composable: { with: ['gesture.right_finger', 'gesture.grass'], conflictWith: [] },
    preconditions: ['左臂空闲'],
    recovery: '播放「抚胸手关闭」或 l2d_reset',
    conflicts: [],
    evidence: [SRC.motionDirector + ':32-49 PAIRED_SLOTS[抚胸手]（左臂参数不相交，可与右臂动作共存）'],
  },
};

const POSE_SEMANTICS = {
  rest: {
    id: 'pose.rest',
    label: 'rest（自然下垂）',
    arm: 'both',
    interruptible: true,
    notes: 'PoseController 的 REST 全 0 基线；6s 空闲自动缓回 rest（idleReturnSec 默认 6）',
    evidence: [SRC.poseController + ':28-38 REST', SRC.poseController + ':113-114 idleReturnSec', SRC.index + ':1592 setPose'],
  },
  finger: {
    id: 'pose.finger',
    label: 'finger（竖起手指）',
    arm: 'right',
    interruptible: true,
    notes: '数值来自竖手指 motion3 终态；动作播放期间 setPose 返回 motion-playing',
    evidence: [SRC.poseController + ':42-52 finger', SRC.index + ':1592-1606 setPose 拒绝 motion-playing'],
  },
  grass: {
    id: 'pose.grass',
    label: 'grass（拿狗尾巴草）',
    arm: 'right',
    interruptible: true,
    notes: '与 finger 同占右臂；左手可同时 chest',
    evidence: [SRC.poseController + ':42-58 grass'],
  },
  chest: {
    id: 'pose.chest',
    label: 'chest（抚胸）',
    arm: 'left',
    interruptible: true,
    notes: '只写左臂 4 个参数，可与右臂姿势共存',
    evidence: [SRC.poseController + ':42-59 chest'],
  },
};

const GAZE_SEMANTICS = {
  'gaze.look_up': { id: 'gaze.look_up', label: '抬头看（视线向上）', direction: [0, 1] },
  'gaze.look_down': { id: 'gaze.look_down', label: '低头看（视线向下）', direction: [0, -1] },
  'gaze.look_left': { id: 'gaze.look_left', label: '视线向左', direction: [-1, 0] },
  'gaze.look_right': { id: 'gaze.look_right', label: '视线向右', direction: [1, 0] },
};

const BODY_SEMANTICS = {
  'body.lean_forward': {
    id: 'body.lean_forward',
    label: '前倾（物理根输入 LeanInput）',
    expression: '前倾',
    conflicts: [
      { with: 'gaze.*', type: 'param-write', params: ['LeanInput'], reason: 'gaze 身体通道每帧 set LeanInput；表情是 Add，会叠加/被覆盖，二者必须经所有权仲裁' },
      { with: 'motion.head', type: 'param-write', params: ['LeanInput'], reason: '动作播放期 gaze 锁存身体值，LeanInput 与动作头/身体曲线可能同帧写' },
    ],
    preconditions: ['若与 gaze 身体同时使用，需 ownParameters([LeanInput])'],
    recovery: 'clearExpression() / l2d_reset',
    evidence: ['Exp3/前倾.exp3.json', SRC.index + ':1385-1393 writeGazeBody(LeanInput)', SRC.contract + ' S-01..S-06 source 优先级'],
  },
  'body.straighten': {
    id: 'body.straighten',
    label: '站直/回正（姿势与角度总线归零）',
    api: 'l2d_reset_pose / l2d_reset',
    preconditions: [],
    recovery: '无（本身就是恢复路径）',
    controlledParams: [
      ...POSE_IDS.map((id) => ({ id, end: 0 })),
      { id: 'AngleX', end: 0 }, { id: 'AngleY', end: 0 }, { id: 'AngleZ', end: 0 },
      { id: 'PositionX', end: 0 }, { id: 'PositionY', end: 0 },
    ],
    evidence: [SRC.index + ':1556-1572 resetPose zeroAngleBus/injector.releaseAll/poseController.resetToRest'],
  },
  'body.relax': {
    id: 'body.relax',
    label: '放松（等同 rest 姿势）',
    api: 'l2d_set_pose({right:"rest",left:"rest"})',
    recovery: '6s 空闲自动缓回 rest；l2d_reset_pose 立即回 rest',
    controlledParams: POSE_IDS.map((id) => ({ id, end: 0 })),
    evidence: [SRC.poseController + ':28-38 REST'],
  },
};

const EXPRESSION_NOTES = {
  圈圈眼: { tags: ['eyes.surprised'], family: 'key3-6-eye' },
  爱心眼: { tags: ['eyes.bright'], family: 'key3-6-eye' },
  '＞＜': { tags: ['eyes.narrowed', 'emotion.pain'], family: 'key3-6-eye' },
  屑: { tags: ['eyes.bright', 'emotion.tease'], family: 'key3-6-eye' },
  流泪: { tags: ['emotion.sad'], family: 'effect-tear' },
  黑脸: { tags: ['emotion.angry'], family: 'overlay' },
  脸红: { tags: ['emotion.shy'], family: 'overlay' },
  加载: { tags: ['state.working'], family: 'state' },
  兔牙: { tags: ['mouth.happy'], family: 'mouth' },
  钢盆: { tags: ['prop'], family: 'prop' },
  黑框眼镜: { tags: ['prop'], family: 'prop' },
  单片眼镜: { tags: ['prop'], family: 'prop' },
  脱鞋: { tags: ['clothes'], family: 'clothes' },
  裙长切换: { tags: ['clothes'], family: 'clothes' },
  胸口衣服: { tags: ['clothes'], family: 'clothes' },
  尾巴开关: { tags: ['clothes'], family: 'clothes' },
  体型1: { tags: ['body-shape'], family: 'body-shape' },
  体型2: { tags: ['body-shape'], family: 'body-shape' },
  默认体型: { tags: ['body-shape'], family: 'body-shape' },
  前倾: { tags: ['body.lean_forward'], family: 'body' },
  流冷汗: { tags: ['emotion.anxious'], family: 'effect-sweat' },
};

// 眼睛族：key3-6 互斥（同一时间只能有一个表情占用，切换靠表情淡出，不是清零）
const EYE_FAMILY = ['key3', 'key4', 'key5', 'key6'];

// 明确不登记的条目（Chief 指令：挥手/托腮/交叉手/双手张开始终不登记）
const EXCLUDED = [
  { id: 'gesture.wave', label: '挥手（right_wave / left_wave）', reason: '无 authored motion3 资产；现有 7 个动作组里没有挥手曲线（Animation/*.motion3.json 全部解析，无手部挥动约束）' },
  { id: 'gesture.hand_to_chin', label: '托腮（hand_to_chin）', reason: '无 authored 资产；Exp3 只有嘴/眼/道具开关，无托腮表情' },
  { id: 'gesture.arms_crossed', label: '交叉手（arms_crossed）', reason: '无 authored 资产，且左右臂参数由两套独立姿势层控制，交叉需要同时驱动双臂且无混合规则' },
  { id: 'gesture.open_hands', label: '双手张开（open_hands）', reason: '无 authored 资产；手指无独立参数（W0 审计），无法用参数近似' },
];

// ---------------------------------------------------------------------------
// 生成
// ---------------------------------------------------------------------------
const model3Path = path.join(MODEL_DIR, MODEL3);
const model3 = readJson(model3Path);
const refs = model3.FileReferences || {};
const motionRefs = refs.Motions || {};
const expRefs = refs.Expressions || [];
const physicsPath = path.join(MODEL_DIR, refs.Physics || '');
const physics = refs.Physics && fs.existsSync(physicsPath) ? readJson(physicsPath) : null;

const physicsOutputs = new Set();
if (physics) {
  for (const s of physics.PhysicsSettings || []) {
    for (const o of s.Output || []) if (o.Destination && o.Destination.Id) physicsOutputs.add(o.Destination.Id);
  }
}

const cdiPath = path.join(MODEL_DIR, '大肥鱼.cdi3.json');
const cdi = fs.existsSync(cdiPath) ? readJson(cdiPath) : { Parameters: [] };
const paramIds = new Set((cdi.Parameters || []).map((p) => p.Id));

const motionGroups = {};
for (const [group, list] of Object.entries(motionRefs)) {
  motionGroups[group] = (list || []).map((entry) => {
    const file = path.join(MODEL_DIR, entry.File);
    const parsed = fs.existsSync(file) ? parseMotion3(file) : { meta: {}, curves: 0, params: [] };
    return {
      group,
      asset: 'model/' + entry.File,
      file: rel(file),
      fadeInMs: Math.round((entry.FadeInTime || 0) * 1000),
      fadeOutMs: Math.round((entry.FadeOutTime || 0) * 1000),
      durationMs: Math.round((parsed.meta.Duration || 0) * 1000),
      // Cubism 5 Web SDK 不读 motion3 的 Meta.Loop（曲线播完即结束），这里只记录源文件标记
      sourceLoopFlag: parsed.meta.Loop === true,
      curveCount: parsed.curves,
      params: parsed.params,
    };
  });
}

const groupMotion = (g) => (motionGroups[g] || [])[0] || null;

const entries = [];

// ---- 动作组（成对） ----
const pairOfGroup = {
  抚胸手: '抚胸手',
  竖手指: '竖手指',
  狗尾巴草: '狗尾巴草',
};
for (const [base, sem] of Object.entries(MOTION_SEMANTICS)) {
  const openGroup = base + '打开';
  const closeGroup = base + '关闭';
  const open = groupMotion(openGroup);
  const close = groupMotion(closeGroup);
  const paramMap = new Map();
  for (const m of [open, close]) {
    if (!m) continue;
    for (const p of m.params) {
      const prev = paramMap.get(p.id) || { id: p.id, min: Infinity, max: -Infinity, end: 0 };
      prev.min = Math.min(prev.min, p.min);
      prev.max = Math.max(prev.max, p.max);
      prev.end = p.end;
      paramMap.set(p.id, prev);
    }
  }
  const poseParams = [...paramMap.keys()].filter((id) => !/^(Movement|Param5[67]$)/.test(id) && !physicsOutputs.has(id));
  entries.push({
    id: sem.id,
    kind: 'motion-pair',
    label: sem.label,
    slot: sem.slot,
    arm: sem.arm,
    api: `l2d_play_motion("${openGroup}") / ("${closeGroup}")`,
    assets: [open, close].filter(Boolean).map((m) => ({ group: m.group, asset: m.asset, file: m.file, durationMs: m.durationMs, fadeInMs: m.fadeInMs, fadeOutMs: m.fadeOutMs, sourceLoopFlag: m.sourceLoopFlag })),
    controlledParams: [...paramMap.values()].map((p) => ({ id: p.id, min: round(p.min), max: round(p.max), end: round(p.end) })),
    poseParams,
    interruptible: sem.interruptible,
    composable: sem.composable,
    conflicts: sem.conflicts,
    preconditions: sem.preconditions,
    recovery: sem.recovery,
    stateNotes: sem.stateNotes || [],
    evidence: sem.evidence,
  });
}

// ---- Idle（背景） ----
{
  const idle = groupMotion('Idle');
  if (idle) {
    entries.push({
      id: 'idle.background',
      kind: 'motion-loop',
      label: '待机（Idle，渲染端自动续播）',
      arm: 'none',
      api: '无（渲染端 motionManager 空闲时自动 startRandomMotion(Idle)）',
      assets: [{ group: 'Idle', asset: idle.asset, file: idle.file, durationMs: idle.durationMs, fadeInMs: idle.fadeInMs, fadeOutMs: idle.fadeOutMs, sourceLoopFlag: idle.sourceLoopFlag }],
      controlledParams: idle.params.map((p) => ({ id: p.id, min: p.min, max: p.max, end: p.end })),
      poseParams: [],
      interruptible: true,
      composable: { with: ['*'], conflictWith: [] },
      conflicts: [],
      preconditions: ['无更高优先级动作播放'],
      recovery: '自动；被动作打断后动作结束继续续播',
      evidence: ['packages/renderer/src/app/lappmodel.ts:643-660 startRandomMotion(Idle, PriorityIdle)', SRC.index + ':1159 playMotionAsync'],
    });
  }
}

// ---- 姿势（API 枚举） ----
{
  // 从 pose-controller.ts 抓 PRESETS 的终态值，避免手抄
  const pcSrc = fs.readFileSync(path.join(ROOT, SRC.poseController), 'utf8');
  const presetBlock = pcSrc.slice(pcSrc.indexOf('const PRESETS'), pcSrc.indexOf('export interface PoseRequest'));
  const presetValues = {};
  for (const name of ['rest', 'finger', 'grass', 'chest']) {
    const re = new RegExp(name + ':\\s*\\{([\\s\\S]*?)\\}', 'm');
    const m = presetBlock.match(re);
    const vals = {};
    if (m) {
      const body = m[1].replace(/\.\.\.REST,?/, '');
      for (const mm of body.matchAll(/(Param\d+):\s*(-?[\d.]+)/g)) vals[mm[1]] = Number(mm[2]);
    }
    presetValues[name] = vals;
  }
  for (const [name, sem] of Object.entries(POSE_SEMANTICS)) {
    let vals = presetValues[name] || {};
    if (name === 'rest' && !Object.keys(vals).length) {
      vals = Object.fromEntries(POSE_IDS.map((id) => [id, 0]));
    }
    const owned = Object.entries(vals).map(([id, v]) => ({ id, value: v }));
    entries.push({
      id: sem.id,
      kind: 'pose',
      label: sem.label,
      arm: sem.arm,
      api: name === 'rest' ? 'l2d_set_pose({right:"rest",left:"rest"})' : `l2d_set_pose(${sem.arm === 'both' ? '' : sem.arm === 'right' ? '{right:"' + name + '"}' : '{left:"' + name + '"}'})`,
      assets: [],
      controlledParams: owned.map((o) => ({ id: o.id, end: o.value })),
      poseParams: owned.map((o) => o.id),
      interruptible: true,
      composable: {
        // 左右臂参数不相交，可分别设置；同臂互斥由 PoseController 单一 target 决定
        with: ['l2d_set_pose 同一次调用里另一只手的姿势'],
        conflictWith: [],
      },
      conflicts: [],
      preconditions: ['动作未播放（setPose 在 motion-playing 时返回 false）'],
      recovery: '6s 空闲自动缓回 rest；l2d_reset_pose 立即回 rest',
      notes: sem.notes,
      evidence: sem.evidence,
    });
  }
}

// ---- 视线 ----
{
  const gazeIds = ['AngleX', 'AngleY', 'ParamEyeBallX', 'ParamEyeBallY', 'PositionX', 'LeanInput'];
  for (const [key, sem] of Object.entries(GAZE_SEMANTICS)) {
    entries.push({
      id: sem.id,
      kind: 'gaze',
      label: sem.label,
      arm: 'none',
      api: `l2d_gaze({x:${sem.direction[0]},y:${sem.direction[1]}})`,
      assets: [],
      controlledParams: gazeIds.map((id) => ({ id })),
      poseParams: [],
      interruptible: true,
      composable: { with: ['pose.*', 'gesture.*'], conflictWith: ['body.lean_forward'] },
      conflicts: [
        { with: 'body.lean_forward', type: 'param-write', params: ['LeanInput'], reason: '身体通道与「前倾」表情同写 LeanInput' },
        { with: 'motion.head', type: 'phase', params: ['AngleX', 'AngleY'], reason: '动作播放期 motionWritesHead() 时头部跟随让路' },
      ],
      preconditions: ['渲染包 ready；动作播放期头部让路'],
      recovery: 'l2d_gaze({x:0,y:0}) 或 clearGaze()',
      evidence: [SRC.index + ':1292 gaze', SRC.index + ':1395-1448 applyGazeBody/applyGazeEyes'],
    });
  }
}

// ---- 身体 ----
for (const sem of Object.values(BODY_SEMANTICS)) {
  const expressionAsset = sem.expression ? expRefs.find((e) => e.Name === sem.expression) : null;
  let controlledParams = [];
  if (expressionAsset) {
    const expFile = path.join(MODEL_DIR, expressionAsset.File);
    if (fs.existsSync(expFile)) controlledParams = parseExp3(expFile);
  }
  entries.push({
    id: sem.id,
    kind: 'body',
    label: sem.label,
    arm: 'none',
    api: sem.api || (sem.expression ? `l2d_set_expression("${sem.expression}")` : ''),
    assets: expressionAsset ? [{ group: sem.expression, asset: 'model/' + expressionAsset.File, file: rel(path.join(MODEL_DIR, expressionAsset.File)), durationMs: 0 }] : [],
    controlledParams: sem.controlledParams || controlledParams,
    poseParams: [],
    interruptible: true,
    composable: { with: ['gaze.*', 'pose.*'], conflictWith: (sem.conflicts || []).map((c) => c.with) },
    conflicts: sem.conflicts || [],
    preconditions: sem.preconditions || [],
    recovery: sem.recovery,
    evidence: sem.evidence,
  });
}

// ---- 表情 ----
const expressionEntries = [];
for (const ref of expRefs) {
  const file = path.join(MODEL_DIR, ref.File);
  if (!fs.existsSync(file)) continue;
  const params = parseExp3(file);
  const note = EXPRESSION_NOTES[ref.Name] || {};
  const keyIds = params.filter((p) => /^key\d+$/.test(p.id)).map((p) => p.id);
  const eyeKeys = keyIds.filter((k) => EYE_FAMILY.includes(k));
  const conflicts = [];
  if (eyeKeys.length) {
    conflicts.push({
      with: 'expression.* (key3-6 eye family)',
      type: 'expression-exclusive',
      params: EYE_FAMILY,
      reason: '眼睛族 key3-6 同属一组：同一时刻只允许一个眼睛表情生效；切换时旧表情 1s 淡出、Add 叠加在过渡期可能短暂共存，必须 clearExpression 或等淡出完成',
    });
  }
  expressionEntries.push({
    id: 'expression.' + (note.idSuffix || ref.Name),
    kind: 'expression',
    label: `表情：${ref.Name}`,
    expressionName: ref.Name,
    arm: 'none',
    api: `l2d_set_expression("${ref.Name}")`,
    assets: [{ group: ref.Name, asset: 'model/' + ref.File, file: rel(file), durationMs: 0 }],
    controlledParams: params,
    poseParams: [],
    interruptible: true,
    composable: { with: ['gaze.*', 'pose.*', 'gesture.*'], conflictWith: eyeKeys.length ? ['expression.key3-6-eye'] : [] },
    conflicts,
    preconditions: ['表情为 Add 且持续；切换前需 clearExpression 或等 1s 淡出'],
    recovery: 'l2d_set_expression 其它表情 / clearExpression() / l2d_reset',
    evidence: ['Exp3/' + ref.Name + '.exp3.json', 'docs/Embodied-Behavior.md', SRC.index + ':cubismexpressionmotion.ts DefaultFadeTime=1.0'],
    tags: note.tags || [],
    family: note.family || 'other',
    eyeFamilyKeys: eyeKeys,
  });
}
entries.push(...expressionEntries);

// ---- 未登记资产（存在但不该开放） ----
const referencedMotionFiles = new Set();
for (const list of Object.values(motionRefs)) for (const e of list) referencedMotionFiles.add(e.File);
const animationDir = path.join(MODEL_DIR, 'Animation');
const allMotionFiles = fs.readdirSync(animationDir).filter((f) => f.endsWith('.motion3.json'));
const unreferencedMotion = allMotionFiles.filter((f) => !referencedMotionFiles.has('Animation/' + f));

const referencedExpFiles = new Set(expRefs.map((e) => e.File));
const allExpFiles = fs.readdirSync(path.join(MODEL_DIR, 'Exp3')).filter((f) => f.endsWith('.exp3.json'));
const unreferencedExp = allExpFiles.filter((f) => !referencedExpFiles.has('Exp3/' + f));

const registry = {
  schemaVersion: 1,
  generatedBy: 'tools/w3-registry/build.mjs',
  model: {
    id: '大肥鱼.dsl2d',
    model3: MODEL3,
    moc3: refs.Moc,
    physics3: refs.Physics,
    physicsOutputCount: physicsOutputs.size,
    expressionCount: expRefs.length,
    motionGroupCount: Object.keys(motionRefs).length,
  },
  sourceCommit: (() => {
    try {
      return execSync('git rev-parse HEAD', { cwd: ROOT, encoding: 'utf8' }).trim();
    } catch {
      return 'unknown';
    }
  })(),
  entries,
  excluded: EXCLUDED,
  unregisteredAssets: {
    motion3: unreferencedMotion.map((f) => 'model/Animation/' + f),
    exp3: unreferencedExp.map((f) => 'model/Exp3/' + f),
    note: '存在但 model3 未引用；不允许在 W3/W4 被当作可用能力（除非先验证并登记）',
  },
  semanticsNotes: [
    '动作组是「状态切换」而非一次性动作：打开后保持，直到对应关闭（motion-director.ts:1-15）。',
    'Cubism 5 Web SDK 不读 motion3 的 Meta.Loop；循环由渲染端 motionManager 对 Idle 单独处理。',
    '成对动作的冲突判定只看姿态骨（poseParams），共用光效/待机参数（Param56/57、Movement*）不参与冲突。',
    '表情是 Add 且持久：切换必须 clearExpression 或等 1s 交叉淡出；眼睛族 key3-6 同一时刻只允许一个表情。',
  ],
};

// ---------------------------------------------------------------------------
// 写出
// ---------------------------------------------------------------------------
function writeMd() {
  const lines = [];
  lines.push('# W3 Motion Capability Registry');
  lines.push('');
  lines.push('> 生成器：`tools/w3-registry/build.mjs`（数据来自模型文件与源码，不靠命名推断）。');
  lines.push('> 基线 commit：`' + registry.sourceCommit + '`；模型：`' + registry.model.id + '`。');
  lines.push('> 机器可读版：`tools/w3-registry/registry.json`（校验脚本 `validate.mjs`）。');
  lines.push('');
  lines.push('## 摘要');
  lines.push('');
  lines.push(`- 登记条目 ${entries.length} 条：动作组 ${entries.filter((e) => e.kind === 'motion-pair').length}、Idle ${entries.filter((e) => e.kind === 'motion-loop').length}、姿势 ${entries.filter((e) => e.kind === 'pose').length}、视线 ${entries.filter((e) => e.kind === 'gaze').length}、身体 ${entries.filter((e) => e.kind === 'body').length}、表情 ${expressionEntries.length}。`);
  lines.push(`- 明确不登记：${EXCLUDED.map((e) => e.label).join('、')}。`);
  lines.push(`- 未引用资产：motion3 ${unreferencedMotion.length} 个（${unreferencedMotion.join('、') || '无'}），exp3 ${unreferencedExp.length} 个（${unreferencedExp.join('、') || '无'}）。`);
  lines.push('');
  lines.push('## 动作组（成对状态切换）');
  lines.push('');
  lines.push('| ID | 打开/关闭组 | 时长 (ms) | 淡入/淡出 (ms) | 控制参数（曲线解析） | 右/左臂 | 可组合 | 冲突 |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const e of entries.filter((x) => x.kind === 'motion-pair')) {
    const asset = (g) => e.assets.find((a) => a.group === g) || {};
    const o = asset(e.slot + '打开');
    const c = asset(e.slot + '关闭');
    lines.push(`| \`${e.id}\` | ${e.slot} | ${o.durationMs} / ${c.durationMs} | ${o.fadeInMs}/${o.fadeOutMs} | ${e.controlledParams.map((p) => p.id).join(', ')} | ${e.arm} | ${e.composable.with.join(', ') || '—'} | ${e.conflicts.map((c2) => c2.with).join(', ') || '—'} |`);
  }
  lines.push('');
  lines.push('## Idle');
  lines.push('');
  for (const e of entries.filter((x) => x.kind === 'motion-loop')) {
    lines.push(`- \`${e.id}\`：${e.label}，时长 ${e.assets[0].durationMs}ms，控制 ${e.controlledParams.map((p) => p.id).join(', ')}；${e.recovery}`);
  }
  lines.push('');
  lines.push('## 姿势（l2d_set_pose 枚举）');
  lines.push('');
  lines.push('| ID | API | 控制参数（来自 pose-controller PRESETS） | 前置 | 恢复 |');
  lines.push('|---|---|---|---|---|');
  for (const e of entries.filter((x) => x.kind === 'pose')) {
    lines.push(`| \`${e.id}\` | ${e.api} | ${e.controlledParams.map((p) => `${p.id}=${p.end}`).join(', ') || 'rest（全 0）'} | ${(e.preconditions || []).join('；') || '—'} | ${e.recovery} |`);
  }
  lines.push('');
  lines.push('## 视线 / 身体');
  lines.push('');
  lines.push('| ID | API | 控制参数 | 冲突 | 恢复 |');
  lines.push('|---|---|---|---|---|');
  for (const e of entries.filter((x) => x.kind === 'gaze' || x.kind === 'body')) {
    lines.push(`| \`${e.id}\` | ${e.api} | ${e.controlledParams.map((p) => p.id).join(', ') || '—'} | ${e.conflicts.map((c) => c.with).join(', ') || '—'} | ${e.recovery} |`);
  }
  lines.push('');
  lines.push('## 表情（21 个，参数取自 exp3.json）');
  lines.push('');
  lines.push('| 表情 | 写入参数（值/Blend） | 语义标签 | 冲突 |');
  lines.push('|---|---|---|---|');
  for (const e of expressionEntries) {
    lines.push(`| ${e.expressionName} | ${e.controlledParams.map((p) => `${p.id}=${p.value}(${p.blend})`).join(', ')} | ${(e.tags || []).join(', ') || '—'} | ${e.conflicts.map((c) => c.with).join(', ') || '—'} |`);
  }
  lines.push('');
  lines.push('## 明确不登记');
  lines.push('');
  for (const e of EXCLUDED) lines.push(`- **${e.label}**（\`${e.id}\`）：${e.reason}`);
  lines.push('');
  lines.push('## 未引用资产');
  lines.push('');
  lines.push('- motion3：' + (unreferencedMotion.join('、') || '无'));
  lines.push('- exp3：' + (unreferencedExp.join('、') || '无'));
  lines.push('');
  lines.push('## 语义约束');
  lines.push('');
  for (const n of registry.semanticsNotes) lines.push('- ' + n);
  lines.push('');
  return lines.join('\n');
}

if (!CHECK_ONLY) {
  fs.mkdirSync(path.join(ROOT, 'tools', 'w3-registry'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'tools', 'w3-registry', 'registry.json'), JSON.stringify(registry, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(ROOT, 'docs', 'W3-Motion-Capability-Registry.md'), writeMd(), 'utf8');
  console.log('[w3-registry] 写出 registry.json + docs/W3-Motion-Capability-Registry.md');
}

console.log('[w3-registry] entries=' + entries.length +
  ' motionPairs=' + entries.filter((e) => e.kind === 'motion-pair').length +
  ' poses=' + entries.filter((e) => e.kind === 'pose').length +
  ' gazes=' + entries.filter((e) => e.kind === 'gaze').length +
  ' bodies=' + entries.filter((e) => e.kind === 'body').length +
  ' expressions=' + expressionEntries.length +
  ' excluded=' + EXCLUDED.length +
  ' unreferencedMotion=' + unreferencedMotion.length +
  ' unreferencedExp=' + unreferencedExp.length);
