import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  HOST_ALLOWED_TOOLS,
  MODEL_FILE,
  PHYSICS_FILE,
  createModelIndexCache,
  extractParamIds,
  guardAiCall,
  loadModelIndex,
  discoverModelFiles,
  parseModel3,
  parsePhysics3,
} from './host-guard.mjs';

// ---------------------------------------------------------------------------
// 夹具：临时模型目录（不依赖真实模型资产，测试可在任何机器上跑）
// ---------------------------------------------------------------------------
const tmpDirs = [];
function makeModelDir({ model3, physics3 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-l2d-hostguard-'));
  tmpDirs.push(dir);
  const write = (file, value) => {
    if (value === undefined) return;
    fs.writeFileSync(path.join(dir, file), typeof value === 'string' ? value : JSON.stringify(value));
  };
  write(MODEL_FILE, model3);
  write(PHYSICS_FILE, physics3);
  return dir;
}

const MODEL3 = {
  FileReferences: {
    Expressions: [{ Name: '兔牙' }, { Name: '动态表情' }],
    Motions: { 抚胸手打开: [], 竖手指关闭: [], 新动作组: [], Idle: [] },
  },
};
const PHYSICS3 = {
  PhysicsSettings: [
    { Output: [{ Destination: { Id: 'ParamAngleX' } }] },
    {
      Output: [
        { Destination: { Id: 'HipAngleX' } },
        { Destination: { Id: 'ParamAngleX' } },
      ],
    },
  ],
};

const fullIndex = loadModelIndex(makeModelDir({ model3: MODEL3, physics3: PHYSICS3 }));
const guarded = (name, args, index) => guardAiCall({ name, args }, { index });

// ---------------------------------------------------------------------------
// 0) 索引解析：表情/动作组/物理输出表
// ---------------------------------------------------------------------------
assert.deepEqual(parseModel3(MODEL3), {
  expressions: ['兔牙', '动态表情'],
  motionGroups: ['抚胸手打开', '竖手指关闭', '新动作组', 'Idle'],
  physics: null,
});
assert.deepEqual([...parsePhysics3(PHYSICS3)].sort(), ['HipAngleX', 'ParamAngleX']);
// 结构缺失/畸形不抛，返回空集合。
assert.deepEqual(parseModel3(null), { expressions: [], motionGroups: [], physics: null });
assert.deepEqual([...parsePhysics3({ PhysicsSettings: [{ Output: [{ Destination: null }] }, null] })], []);

assert.deepEqual([...fullIndex.expressions].sort(), ['动态表情', '兔牙'].sort());
assert.deepEqual([...fullIndex.physicsOutputs].sort(), ['HipAngleX', 'ParamAngleX']);
assert.deepEqual(fullIndex.warnings, []);

// ---------------------------------------------------------------------------
// 1) 工具白名单：只放行 index.js 原 ALLOWED 集合
// ---------------------------------------------------------------------------
// FI 轮（2026-11-08）：+l2d_facial / +l2d_facial_manual（Facial Intelligence PR-01）
assert.equal(HOST_ALLOWED_TOOLS.length, 18);
for (const tool of HOST_ALLOWED_TOOLS) {
  // 空入参可能因"缺字段"被拒（如空表情名），但绝不能是 unknown-tool。
  const r = guardAiCall({ name: tool, args: {} });
  assert.notEqual(r.reason, 'unknown-tool', `白名单工具被当成未知工具：${tool}`);
}
for (const bad of ['l2d_unknown', 'rm -rf', 'l2d_set_parameter', '', ' L2D_RESET']) {
  const r = guardAiCall({ name: bad });
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.equal(r.reason, 'unknown-tool');
  assert.equal(r.detail, bad.trim()); // 工具名先 trim 再比对
  assert.equal(r.message, 'unknown tool: ' + bad.trim()); // 兼容旧响应文案
}
// 请求体本身畸形也不能抛。
assert.equal(guardAiCall(null).reason, 'unknown-tool');
assert.equal(guardAiCall({}).reason, 'unknown-tool');
assert.equal(guardAiCall({ name: 42 }).reason, 'unknown-tool');

// ---------------------------------------------------------------------------
// 1b) l2d_change_form：无参形态切换工具（白名单末尾追加，既有工具零改动）
// ---------------------------------------------------------------------------
// (1) 白名单含新名，且前 15 项名称与顺序未变。
const LEGACY_ALLOWED_TOOLS = [
  'l2d_set_expression', 'l2d_play_motion', 'l2d_look_at', 'l2d_set_parameters',
  'l2d_reset_pose', 'l2d_play_keyframes', 'l2d_stop_keyframes', 'l2d_set_pose',
  'l2d_emote', 'l2d_gaze', 'l2d_say', 'l2d_act', 'l2d_posture', 'l2d_get_state', 'l2d_reset',
];
assert.ok(HOST_ALLOWED_TOOLS.includes('l2d_change_form'), '白名单应含 l2d_change_form');
// FI 轮：l2d_facial_manual 追加在末尾
assert.equal(HOST_ALLOWED_TOOLS[HOST_ALLOWED_TOOLS.length - 1], 'l2d_facial_manual', '新工具应追加在末尾');
assert.deepEqual(HOST_ALLOWED_TOOLS.slice(0, 15), LEGACY_ALLOWED_TOOLS, '前 15 项名称与顺序零改动');
// (2) guardAiCall 对无参调用放行，且不触发参数写入类守卫。
const changeForm = guardAiCall({ name: 'l2d_change_form', args: {} });
assert.equal(changeForm.ok, true, '无参形态切换应放行');
assert.deepEqual(changeForm.warnings, []);
assert.deepEqual(changeForm.ignored, []);
assert.equal(guardAiCall({ name: 'l2d_change_form', args: { values: { ParamMouthOpenY: 1 } } }).ok, true,
  '无参工具不进 PARAM_KEYED_TOOLS / OWN_REQUIRED_TOOLS');
// (3) 既有工具仍可用，且顺序未变。
assert.equal(guarded('l2d_set_expression', { name: '兔牙' }).ok, true);
assert.equal(guarded('l2d_get_state', {}).ok, true);
assert.equal(HOST_ALLOWED_TOOLS.indexOf('l2d_set_expression'), 0);
assert.equal(HOST_ALLOWED_TOOLS.indexOf('l2d_get_state'), 13);

// ---------------------------------------------------------------------------
// 2) 口型参数：任何通道永拒（含嵌套 / 数组形式），且优先于其它规则
// ---------------------------------------------------------------------------
const mouthCases = [
  // 平铺 values
  { name: 'l2d_set_parameters', args: { values: { ParamMouthOpenY: 0.5, AngleX: 1 } } },
  // values 不是对象时，参数名藏在别处也要被递归扫描到
  { name: 'l2d_set_parameters', args: { values: 42, nested: ['ParamMouthOpenY'] } },
  // 嵌套对象（扫描是递归的，不能只扫 values 第一层）
  { name: 'l2d_set_parameters', args: { values: { nested: { ParamMouthForm: 1 } } } },
  // 数组形式
  { name: 'l2d_set_parameters', args: { values: [{ ParamMouthOpen: 0.2 }] } },
  // keyframes 轨道
  { name: 'l2d_play_keyframes', args: { tracks: [{ param: 'ParamMouthOpenY', keys: [[0, 0.1], [100, 0.2]] }] } },
  // keyframes 里嵌套的轨道（防御性扫描）
  { name: 'l2d_play_keyframes', args: { tracks: [{ param: 'AngleX', keys: [[0, 0]], extra: { ParamMouthForm: 1 } }] } },
];
for (const c of mouthCases) {
  const r = guarded(c.name, c.args, fullIndex);
  assert.equal(r.ok, false, `口型应被拒：${JSON.stringify(c.args)}`);
  assert.equal(r.status, 400);
  assert.equal(r.reason, 'reserved-param');
  assert.match(r.detail, /^ParamMouth/);
  assert.match(r.message, /^reserved-param: ParamMouth/);
}
// own:true 也不能给口型开口子（口型优先级更高）。
assert.equal(
  guarded('l2d_set_parameters', { values: { ParamMouthOpenY: 1 }, own: true }, fullIndex).reason,
  'reserved-param',
);
// 非参数键工具里的同名文本只是文本，不能误伤。
assert.equal(guarded('l2d_say', { text: 'ParamMouthOpenY 是口型参数' }, fullIndex).ok, true);
// 干净入参不误报。
assert.equal(guarded('l2d_set_parameters', { values: { AngleX: 1, ParamMouthFree: 1 } }, fullIndex).ok, true);

// ---------------------------------------------------------------------------
// 3) 物理输出：仅 own:true 放行（与 checkParameterWrite 同一语义）
// ---------------------------------------------------------------------------
const ownRequires = (args) => guarded('l2d_set_parameters', args, fullIndex);

// 未 own / own:false / 非严格 true → 400，且只报物理输出 id
const noOwn = ownRequires({ values: { ParamAngleX: 3 } });
assert.equal(noOwn.ok, false);
assert.equal(noOwn.status, 400);
assert.equal(noOwn.reason, 'physics-output-requires-own');
assert.equal(noOwn.detail, 'ParamAngleX');
assert.equal(ownRequires({ values: { ParamAngleX: 3 }, own: false }).ok, false);
assert.equal(ownRequires({ values: { HipAngleX: 1 }, own: 1 }).reason, 'physics-output-requires-own'); // 严格 === true
assert.equal(ownRequires({ values: { HipAngleX: 1 }, own: 'true' }).reason, 'physics-output-requires-own');

// own:true 放行；非物理参数不需要 own
assert.equal(ownRequires({ values: { ParamAngleX: 3 }, own: true }).ok, true);
assert.equal(ownRequires({ values: { AngleX: 3 } }).ok, true);
// 混写：只报物理输出，非物理参数不受影响
const mixed = ownRequires({ values: { AngleX: 1, HipAngleX: 2 } });
assert.equal(mixed.reason, 'physics-output-requires-own');
assert.equal(mixed.detail, 'HipAngleX');
// 重复 id 去重后报一次
assert.equal(ownRequires({ values: { ParamAngleX: 1, ' ParamAngleX': 1 } }).detail, 'ParamAngleX');

// keyframes 是**刻意**不对称：渲染端 playKeyframes 按轨道时长自动认领物理输出（c9be149），
// host 若再要求 own 会把这条合法通道堵死。
assert.equal(
  guarded('l2d_play_keyframes', { tracks: [{ param: 'ParamAngleX', keys: [[0, 0], [500, 5]] }] }, fullIndex).ok,
  true,
);

// ---------------------------------------------------------------------------
// 4) 物理表不可用 → fail-open：放行 + warning，绝不 500 / 抛异常
// ---------------------------------------------------------------------------
const failOpen = guarded('l2d_set_parameters', { values: { ParamAngleX: 3 } }, null);
assert.equal(failOpen.ok, true);
assert.deepEqual(failOpen.warnings, ['physics-table-unavailable']);

// model3 在、physics3 缺失：物理表 null → 同样 fail-open
const noPhysics = loadModelIndex(makeModelDir({ model3: MODEL3 }));
assert.equal(noPhysics.physicsOutputs, null);
assert.ok(noPhysics.warnings.some((w) => w.startsWith('physics3-unavailable')));
assert.equal(guarded('l2d_set_parameters', { values: { ParamAngleX: 3 } }, noPhysics).ok, true);

// physics3 可读但没有输出：不算 fail-open，正常判定（这里没有可拦的 id）
const emptyPhysics = loadModelIndex(makeModelDir({ model3: MODEL3, physics3: { PhysicsSettings: [] } }));
assert.deepEqual(emptyPhysics.warnings, []);
const emptyRes = guarded('l2d_set_parameters', { values: { ParamAngleX: 3 } }, emptyPhysics);
assert.equal(emptyRes.ok, true);
assert.deepEqual(emptyRes.warnings, []);

// 目录不存在 / model3 畸形 / physics3 畸形：不抛，只 warnings
const missing = loadModelIndex(path.join(os.tmpdir(), 'dsh-l2d-hostguard-does-not-exist'));
assert.equal(missing.expressions, null);
assert.equal(missing.physicsOutputs, null);
assert.equal(missing.warnings.length, 2);
assert.equal(loadModelIndex(null).warnings[0], 'model-dir-unavailable');

const badModel = loadModelIndex(makeModelDir({ model3: '{ not json', physics3: PHYSICS3 }));
assert.equal(badModel.expressions, null);
assert.ok(badModel.warnings.some((w) => w.startsWith('model3-unavailable')));
assert.deepEqual([...badModel.physicsOutputs].sort(), ['HipAngleX', 'ParamAngleX']);
// model3 读不到时表情/动作组退回静态名单（安全侧：不 fail-open 放行未索引名）。
assert.equal(guarded('l2d_set_expression', { name: '兔牙' }, badModel).ok, true);
assert.equal(guarded('l2d_set_expression', { name: '动态表情' }, badModel).reason, 'unknown-expression');
assert.equal(guarded('l2d_play_motion', { group: '抚胸手打开' }, badModel).ok, true);

const badPhysics = loadModelIndex(makeModelDir({ model3: MODEL3, physics3: '{ not json' }));
assert.equal(badPhysics.physicsOutputs, null);
assert.ok(badPhysics.warnings.some((w) => w.startsWith('physics3-unavailable')));
assert.equal(guarded('l2d_set_parameters', { values: { ParamAngleX: 1 } }, badPhysics).ok, true);

// 让 modelFile 指向一个目录：读取抛 EISDIR，必须被吞掉
const dirAsFile = makeModelDir({ model3: MODEL3, physics3: PHYSICS3 });
fs.mkdirSync(path.join(dirAsFile, 'sub.json'));
const dirIndex = loadModelIndex(dirAsFile, { modelFile: 'sub.json' });
assert.equal(dirIndex.expressions, null);
assert.ok(dirIndex.warnings.some((w) => w.startsWith('model3-unavailable')));
assert.equal(dirIndex.physicsOutputs instanceof Set, true);

// ---------------------------------------------------------------------------
// 5) 未索引表情 / 动作组：400；Idle 明确拒绝
// ---------------------------------------------------------------------------
// 静态名单（无索引也能判）
assert.equal(guarded('l2d_set_expression', { name: '兔牙' }).ok, true);
assert.equal(guarded('l2d_set_expression', { name: '爱心眼' }).ok, true);
const unknownExpr = guarded('l2d_set_expression', { name: '不存在的表情' });
assert.equal(unknownExpr.ok, false);
assert.equal(unknownExpr.status, 400);
assert.equal(unknownExpr.reason, 'unknown-expression');
assert.equal(unknownExpr.detail, '不存在的表情');
assert.equal(guarded('l2d_set_expression', { name: '' }).reason, 'empty-expression');
assert.equal(guarded('l2d_set_expression', {}).reason, 'empty-expression');
// model3 动态扩展：换模型后不必改代码
assert.equal(guarded('l2d_set_expression', { name: '动态表情' }, fullIndex).ok, true);
assert.equal(guarded('l2d_set_expression', { name: '动态表情' }).reason, 'unknown-expression');

assert.equal(guarded('l2d_play_motion', { group: '抚胸手打开' }, fullIndex).ok, true);
assert.equal(guarded('l2d_play_motion', { group: '新动作组' }, fullIndex).ok, true);
const idle = guarded('l2d_play_motion', { group: 'Idle' }, fullIndex);
assert.equal(idle.ok, false);
assert.equal(idle.status, 400);
assert.equal(idle.reason, 'idle-not-playable');
// Idle 即使出现在 model3 动态表里也拒（引擎自播）
assert.equal(guarded('l2d_play_motion', { group: 'Idle' }, fullIndex).reason, 'idle-not-playable');
const unknownGroup = guarded('l2d_play_motion', { group: '不存在的组' }, fullIndex);
assert.equal(unknownGroup.reason, 'unknown-motion-group');
assert.equal(unknownGroup.detail, '不存在的组');
assert.equal(guarded('l2d_play_motion', { group: '' }).reason, 'empty-motion-group');
assert.equal(guarded('l2d_play_motion', {}).reason, 'empty-motion-group');

// ---------------------------------------------------------------------------
// 6) set_parameters 与 play_keyframes 共用同一套入队守卫
// ---------------------------------------------------------------------------
for (const tool of ['l2d_set_parameters', 'l2d_play_keyframes']) {
  assert.equal(guarded(tool, { value: 'ParamMouthOpenY' }).reason, 'reserved-param');
}
// 参数名提取：只认渲染端实际读取的字段
assert.deepEqual(
  extractParamIds('l2d_set_parameters', { values: { AngleX: 1, HipAngleX: 2 }, own: true }),
  ['AngleX', 'HipAngleX'],
);
assert.deepEqual(extractParamIds('l2d_set_parameters', { values: null }), []);
assert.deepEqual(extractParamIds('l2d_set_parameters', { values: [1, 2] }), []);
assert.deepEqual(
  extractParamIds('l2d_play_keyframes', { tracks: [{ param: 'AngleX' }, { keys: [[0, 0]] }, { param: 42 }] }),
  ['AngleX'],
);
assert.deepEqual(extractParamIds('l2d_get_state', { values: { AngleX: 1 } }), []);

// keyframes 里 host 不认识的参数名不前置拒（cdi3 参数表不在 host，渲染端会筛掉）；
// 但口型名必须拒——两条规则在同一个 guard 里按顺序生效。
assert.equal(
  guarded('l2d_play_keyframes', { tracks: [{ param: 'NoSuchParam', keys: [[0, 0], [10, 1]] }] }, fullIndex).ok,
  true,
);

// ---------------------------------------------------------------------------
// 7) 畸形入参：guard 绝不抛（路由层还有一层 try/catch 兜底）
// ---------------------------------------------------------------------------
const cyclic = { values: {}, own: true };
cyclic.values.self = cyclic;
const weirdArgCases = [undefined, null, 42, 'str', [], [{ values: 1 }], cyclic];
for (let i = 0; i < weirdArgCases.length; i++) {
  const r = guarded('l2d_set_parameters', weirdArgCases[i], fullIndex);
  assert.equal(typeof r.ok, 'boolean', `第 ${i} 个畸形 args 不应抛`);
}

// ---------------------------------------------------------------------------
// 8) 索引缓存：TTL 过期重载、invalidate、运行时换模型
// ---------------------------------------------------------------------------
let clock = 1_000;
const cacheDir = makeModelDir(); // 先空目录（模型读不到）
const cache = createModelIndexCache(cacheDir, { ttlMs: 1_000, now: () => clock });
assert.equal(cache.get().physicsOutputs, null);
const first = cache.get();
assert.equal(cache.get(), first); // TTL 内复用同一对象
fs.writeFileSync(path.join(cacheDir, MODEL_FILE), JSON.stringify(MODEL3));
fs.writeFileSync(path.join(cacheDir, PHYSICS_FILE), JSON.stringify(PHYSICS3));
clock += 1_000; // 过期
const second = cache.get();
assert.notEqual(second, first);
assert.deepEqual([...second.physicsOutputs].sort(), ['HipAngleX', 'ParamAngleX']);
cache.invalidate();
assert.notEqual(cache.get(), second);

// ---------------------------------------------------------------------------
// 9) M1-d：l2d_posture 口型红线 / posture 物理输出 requires-own / R10b ignored
// ---------------------------------------------------------------------------
// 9a) posture 的 values 出现口型参数 → 400 reserved-param（与 set_parameters 同一名单，不重写）
const postureMouth = guarded('l2d_posture', { values: { ParamMouthOpenY: 0.6, AngleX: 1 } }, fullIndex);
assert.equal(postureMouth.ok, false);
assert.equal(postureMouth.status, 400);
assert.equal(postureMouth.reason, 'reserved-param');
assert.equal(postureMouth.detail, 'ParamMouthOpenY');
// 嵌套形式也拦（递归扫描），且 own:true 不开口子
assert.equal(guarded('l2d_posture', { values: { nested: { ParamMouthForm: 1 } } }, fullIndex).reason, 'reserved-param');
assert.equal(guarded('l2d_posture', { values: { ParamMouthOpen: 1 }, own: true }, fullIndex).reason, 'reserved-param');
// 干净 posture 入参不受影响
assert.equal(guarded('l2d_posture', { values: { AngleX: 1, ParamMouthFree: 1 } }, fullIndex).ok, true);

// 9b) posture values 直写物理输出且未 own:true → 400（与 set_parameters 同语义）
const postureNoOwn = guarded('l2d_posture', { values: { HipAngleX: 1 } }, fullIndex);
assert.equal(postureNoOwn.ok, false);
assert.equal(postureNoOwn.status, 400);
assert.equal(postureNoOwn.reason, 'physics-output-requires-own');
assert.equal(postureNoOwn.detail, 'HipAngleX');
// own:true 放行；非物理参数不需要 own
assert.equal(guarded('l2d_posture', { values: { HipAngleX: 1 }, own: true }, fullIndex).ok, true);
assert.equal(guarded('l2d_posture', { values: { AngleX: 1 } }, fullIndex).ok, true);
// 物理表不可用 → fail-open + warning，不 500
const postureFailOpen = guarded('l2d_posture', { values: { HipAngleX: 1 } }, null);
assert.equal(postureFailOpen.ok, true);
assert.deepEqual(postureFailOpen.warnings, ['physics-table-unavailable']);

// 9c) R10b：own:true 只登记物理输出，非物理 id → ignored（不算错误，回执可见）
const ownMixed = guarded('l2d_set_parameters', { values: { HipAngleX: 1, AngleX: 0.5 }, own: true }, fullIndex);
assert.equal(ownMixed.ok, true);
assert.deepEqual(ownMixed.ignored, ['AngleX']);
assert.ok(ownMixed.warnings.includes('own-ignored-non-physical:AngleX'), 'ignored 应进 warnings 随回执带出');
const postureOwnMixed = guarded('l2d_posture', { values: { HipAngleX: 1, AngleX: 2 }, own: true }, fullIndex);
assert.equal(postureOwnMixed.ok, true);
assert.deepEqual(postureOwnMixed.ignored, ['AngleX']);
assert.ok(postureOwnMixed.warnings.includes('own-ignored-non-physical:AngleX'));
// 全物理输出 → 无 ignored；未带 own → 也不产生 ignored
assert.deepEqual(guarded('l2d_set_parameters', { values: { HipAngleX: 1 }, own: true }, fullIndex).ignored, []);
assert.deepEqual(guarded('l2d_set_parameters', { values: { AngleX: 1 } }, fullIndex).ignored, []);
// 物理表不可用时 own 请求照旧 fail-open，不产生 ignored
assert.deepEqual(guarded('l2d_set_parameters', { values: { AngleX: 1 }, own: true }, null).ignored, []);

// 9d) extractParamIds 认识 l2d_posture 的 values
assert.deepEqual(
  extractParamIds('l2d_posture', { values: { HipAngleX: 1, AngleX: 2 } }),
  ['HipAngleX', 'AngleX'],
);
assert.deepEqual(extractParamIds('l2d_posture', {}), []);
assert.deepEqual(extractParamIds('l2d_posture', { values: [1, 2] }), []);

// 10) [#28] 目录发现：不再写死大肥鱼名单，索引跟随目录里的真实 model3.json
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-l2d-hostguard-'));
  tmpDirs.push(dir);
  fs.writeFileSync(
    path.join(dir, 'Haru.model3.json'),
    JSON.stringify({
      FileReferences: {
        Expressions: [{ Name: 'F01' }],
        Motions: { TapBody: [], Idle: [] },
        Physics: 'Haru.physics3.json',
      },
    }),
  );
  fs.writeFileSync(path.join(dir, 'Haru.physics3.json'), JSON.stringify(PHYSICS3));
  const idx = loadModelIndex(dir);
  assert.ok(idx.expressions.has('F01'), '发现机制应索引到目录里的 Haru');
  assert.ok(idx.motionGroups.has('TapBody'));
  // physics 优先用模型自声明引用，不再写死大肥鱼.physics3.json
  assert.deepEqual([...idx.physicsOutputs].sort(), ['HipAngleX', 'ParamAngleX']);
  assert.deepEqual(discoverModelFiles(dir), ['Haru.model3.json']);

  // 目录不可读 → 空数组不抛；空目录 → 回退写死名单路径（model3-unavailable 警告）
  assert.deepEqual(discoverModelFiles(path.join(dir, 'not-exist')), []);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-l2d-hostguard-'));
  tmpDirs.push(empty);
  const emptyIdx = loadModelIndex(empty);
  assert.equal(emptyIdx.expressions, null);
  assert.ok(emptyIdx.warnings.some((w) => w.startsWith('model3-unavailable')));
}

// ---------------------------------------------------------------------------
for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
console.log('host-guard ok');
