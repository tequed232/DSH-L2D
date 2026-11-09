import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MAX_GRAPH_NODES,
  MOTION_MODES,
  NODE_TYPES,
  compileGraphToSegments,
  listNodegraphs,
  loadNodegraph,
  motionModePath,
  nodegraphsDir,
  readMotionMode,
  runNodegraph,
  createInboxActExecutor,
  sanitizeFileName,
  saveNodegraph,
  segmentsToGraph,
  validateNodegraph,
  writeMotionMode,
} from './nodegraph.mjs';
import { HOST_ALLOWED_TOOLS, guardAiCall } from './host-guard.mjs';

// ---------------------------------------------------------------------------
// 夹具：临时 $DSH_HOME（不依赖真实环境，测试可在任何机器上跑）
// ---------------------------------------------------------------------------
const tmpHomes = [];
function makeHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-l2d-nodegraph-'));
  tmpHomes.push(dir);
  return dir;
}

const GOOD_GRAPH = {
  roots: ['n1'],
  nodes: [
    { id: 'n1', type: 'expression', name: '兔牙', delayMs: 180, next: ['n2'] },
    { id: 'n2', type: 'pose', pose: { right: 'rest' }, next: [] },
  ],
};

function makeDoc(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: 'dsh-l2d-nodegraph',
    name: '挥手打招呼',
    modelBinding: { modelId: '大肥鱼', modelHash: '', bindingMode: 'any' },
    graph: GOOD_GRAPH,
    meta: { author: 'test' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 0) 常量与路径解析
// ---------------------------------------------------------------------------
assert.deepEqual([...NODE_TYPES], ['expression', 'motion', 'pose', 'look', 'delay']);
assert.deepEqual([...MOTION_MODES], ['nodegraph', 'llm']);
assert.equal(MAX_GRAPH_NODES, 120);
assert.equal(motionModePath('/tmp/h'), path.join('/tmp/h', 'l2d-motion-mode.json'));
assert.equal(nodegraphsDir('/tmp/h'), path.join('/tmp/h', 'l2d-nodegraphs'));

// ---------------------------------------------------------------------------
// 1) 合法文档：校验通过 + graph→segments 编译等价
// ---------------------------------------------------------------------------
const good = validateNodegraph(makeDoc());
assert.equal(good.ok, true, '合法文档应通过：' + JSON.stringify(good.errors));
assert.deepEqual(good.normalized.segments, [
  { priority: 'NORMAL', chain: [{ kind: 'expression', name: '兔牙', delayMs: 180 }, { kind: 'pose', pose: { right: 'rest' } }] },
]);
assert.deepEqual(good.normalized.modelBinding, { modelId: '大肥鱼', modelHash: '', bindingMode: 'any' });
assert.equal(good.normalized.meta.author, 'test');
// 只有 graph 时保留原 graph（视图不回算覆盖）
assert.equal(good.normalized.graph, GOOD_GRAPH);
// 编译结果再过 F2 校验器（segments 直通同构）
assert.deepEqual(validateNodegraph({ ...makeDoc(), graph: undefined, segments: good.normalized.segments }).normalized.segments,
  good.normalized.segments);

// bindingMode 缺省 → 'any'（导入即用）
const defaultBinding = validateNodegraph(makeDoc({ modelBinding: { modelId: '大肥鱼' } }));
assert.equal(defaultBinding.ok, true);
assert.equal(defaultBinding.normalized.modelBinding.bindingMode, 'any');

// ---------------------------------------------------------------------------
// 2) schema 拒绝用例（SPEC §5.1）
// ---------------------------------------------------------------------------
const badCases = [
  ['坏 version', makeDoc({ schemaVersion: 2 })],
  ['坏 kind', makeDoc({ kind: 'other-graph' })],
  ['缺 name', makeDoc({ name: '   ' })],
  ['未知顶层字段', makeDoc({ extra: 1 })],
  ['未知节点 type', makeDoc({ graph: { roots: ['n1'], nodes: [{ id: 'n1', type: 'teleport', next: [] }] } })],
  ['存在环', makeDoc({
    graph: {
      roots: ['n1'],
      nodes: [
        { id: 'n1', type: 'expression', name: '兔牙', next: ['n2'] },
        { id: 'n2', type: 'delay', delayMs: 100, next: ['n1'] },
      ],
    },
  })],
  ['悬空 next', makeDoc({ graph: { roots: ['n1'], nodes: [{ id: 'n1', type: 'expression', name: '兔牙', next: ['ghost'] }] } })],
  ['roots 引用不存在', makeDoc({ graph: { roots: ['ghost'], nodes: [{ id: 'n1', type: 'expression', name: '兔牙', next: [] }] } })],
  ['节点不可达', makeDoc({
    graph: {
      roots: ['n1'],
      nodes: [
        { id: 'n1', type: 'expression', name: '兔牙', next: [] },
        { id: 'n9', type: 'delay', delayMs: 100, next: [] },
      ],
    },
  })],
  ['graph 与 segments 全缺', { schemaVersion: 1, kind: 'dsh-l2d-nodegraph', name: 'x', modelBinding: { bindingMode: 'any' } }],
  ['graph 结构坏', makeDoc({ graph: { roots: [], nodes: [] } })],
  ['strict 缺绑定', makeDoc({ modelBinding: { modelId: '', modelHash: '', bindingMode: 'strict' } })],
  ['坏 bindingMode', makeDoc({ modelBinding: { bindingMode: 'always' } })],
  ['look 缺坐标', makeDoc({ graph: { roots: ['n1'], nodes: [{ id: 'n1', type: 'look', next: [] }] } })],
  ['pose 非法值', makeDoc({ graph: { roots: ['n1'], nodes: [{ id: 'n1', type: 'pose', pose: { right: 'wave' }, next: [] }] } })],
  ['delay 非法时长', makeDoc({ graph: { roots: ['n1'], nodes: [{ id: 'n1', type: 'delay', delayMs: 9000, next: [] }] } })],
  ['编译出非法表情名（复用 F2 白名单）', makeDoc({
    graph: { roots: ['n1'], nodes: [{ id: 'n1', type: 'expression', name: '不存在的表情', next: [] }] },
  })],
];
for (const [label, doc] of badCases) {
  const r = validateNodegraph(doc);
  assert.equal(r.ok, false, `${label} 应被拒绝`);
  assert.ok(Array.isArray(r.errors) && r.errors.length > 0, `${label} 应给出 errors`);
  assert.equal(r.normalized, null, `${label} 失败时不得给出 normalized`);
}

// ---------------------------------------------------------------------------
// 3) segments 校验拒绝：超 8 步 / 超 15 段 / 超时长（复用 F2 validateActionSequence）
// ---------------------------------------------------------------------------
const poseStep = { kind: 'pose', pose: { right: 'rest' } };
const tooManySteps = validateNodegraph(makeDoc({
  graph: undefined,
  segments: [{ priority: 'NORMAL', chain: Array.from({ length: 9 }, () => ({ ...poseStep })) }],
}));
assert.equal(tooManySteps.ok, false);
assert.ok(tooManySteps.errors.some((e) => e.includes('8')), '超 8 步应报上限');

const tooManySegments = validateNodegraph(makeDoc({
  graph: undefined,
  segments: Array.from({ length: 16 }, () => ({ priority: 'NORMAL', chain: [{ ...poseStep }] })),
}));
assert.equal(tooManySegments.ok, false);
assert.ok(tooManySegments.errors.some((e) => e.includes('15')), '超 15 段应报上限');

const tooLong = validateNodegraph(makeDoc({
  graph: undefined,
  segments: [{
    priority: 'NORMAL',
    chain: Array.from({ length: 3 }, () => ({ kind: 'expression', name: '兔牙', delayMs: 4000 })),
  }],
}));
assert.equal(tooLong.ok, false);
assert.ok(tooLong.errors.some((e) => e.includes('上限')), '超时长应报 estimateLifeMs 上限');

// ---------------------------------------------------------------------------
// 4) 编译语义：delay 并入 / 末端丢弃 / 分支 DFS 线性化 / 编译器独立调用超段
// ---------------------------------------------------------------------------
const delayMerged = validateNodegraph(makeDoc({
  graph: {
    roots: ['a'],
    nodes: [
      { id: 'a', type: 'delay', delayMs: 200, next: ['b'] },
      { id: 'b', type: 'expression', name: '兔牙', next: ['c'] },
      { id: 'c', type: 'delay', delayMs: 100, next: [] },
    ],
  },
}));
assert.equal(delayMerged.ok, true, JSON.stringify(delayMerged.errors));
assert.deepEqual(delayMerged.normalized.segments[0].chain, [{ kind: 'expression', name: '兔牙', delayMs: 200 }]);

const branched = validateNodegraph(makeDoc({
  graph: {
    roots: ['r'],
    nodes: [
      { id: 'r', type: 'expression', name: '爱心眼', next: ['a', 'b'] },
      { id: 'a', type: 'expression', name: '兔牙', next: [] },
      { id: 'b', type: 'pose', pose: { right: 'rest' }, next: [] },
    ],
  },
}));
assert.equal(branched.ok, true, JSON.stringify(branched.errors));
assert.deepEqual(branched.normalized.segments[0].chain, [
  { kind: 'expression', name: '爱心眼' },
  { kind: 'expression', name: '兔牙' },
  { kind: 'pose', pose: { right: 'rest' } },
]);

// 编译器独立调用：121 步 → 16 段 → 超 MAX_SEGMENTS
const bigNodes = Array.from({ length: 121 }, (_, i) => ({
  id: 'n' + i, type: 'expression', name: '兔牙', next: ['n' + (i + 1)],
}));
bigNodes[120].next = [];
const bigCompiled = compileGraphToSegments({ roots: ['n0'], nodes: bigNodes });
assert.equal(bigCompiled.ok, false);
assert.ok(bigCompiled.errors.some((e) => e.includes('15')), '独立编译超 15 段应报错');
// 整体校验路径：121 节点先被 MAX_GRAPH_NODES 拦下
const bigDoc = validateNodegraph(makeDoc({ graph: { roots: ['n0'], nodes: bigNodes } }));
assert.equal(bigDoc.ok, false);
assert.ok(bigDoc.errors.some((e) => e.includes('120')), '超 120 节点应报 graph.nodes 上限');

// ---------------------------------------------------------------------------
// 4b) priority 分段对拍：多分支 next + delay 折叠 + 三种 priority + 8 步上限
// （与编辑器 motion-graph.html Compiler「每 8 步一段；优先级变化也起新段」同语义）
// ---------------------------------------------------------------------------
const priorityFixture = {
  roots: ['r'],
  nodes: [
    { id: 'r', type: 'expression', name: '兔牙', delayMs: 100, priority: 'BACKGROUND', next: ['a', 'b'] },
    { id: 'a', type: 'motion', name: '竖手指打开', closeMotion: '竖手指关闭', closeAfterMs: 1800, priority: 'NORMAL', next: ['c'] },
    { id: 'c', type: 'delay', delayMs: 300, next: ['d'] },
    { id: 'd', type: 'look', x: 0, y: 0.1, priority: 'FORCE', next: ['e'] },
    { id: 'e', type: 'expression', name: '屑', next: ['f'] },
    { id: 'f', type: 'pose', pose: { right: 'chest' }, next: ['g'] },
    { id: 'g', type: 'look', x: 0, y: 0, next: ['h'] },
    { id: 'h', type: 'expression', name: '兔牙', delayMs: 50, next: ['i'] },
    { id: 'i', type: 'look', x: 0.2, y: 0, next: [] },
    { id: 'b', type: 'pose', pose: { right: 'rest' }, priority: 'BACKGROUND', next: [] },
  ],
};
const priorityCompiled = compileGraphToSegments(priorityFixture);
assert.equal(priorityCompiled.ok, true, JSON.stringify(priorityCompiled.errors));
// 步序为 DFS 前序（分支按 next 数组顺序；delay 不产生步、其 delayMs 折叠进下一动作步）
assert.deepEqual(priorityCompiled.steps, [
  { kind: 'expression', name: '兔牙', delayMs: 100 },
  { kind: 'motion', name: '竖手指打开', closeMotion: '竖手指关闭', closeAfterMs: 1800 },
  { kind: 'look', x: 0, y: 0.1, delayMs: 300 },
  { kind: 'expression', name: '屑' },
  { kind: 'pose', pose: { right: 'chest' } },
  { kind: 'look', x: 0, y: 0 },
  { kind: 'expression', name: '兔牙', delayMs: 50 },
  { kind: 'look', x: 0.2, y: 0 },
  { kind: 'pose', pose: { right: 'rest' } },
]);
// 段边界与优先级：优先级变化起新段，同优先级共享一段；delay 合并语义不变、末端无遗留
assert.deepEqual(priorityCompiled.segments, [
  { priority: 'BACKGROUND', chain: [{ kind: 'expression', name: '兔牙', delayMs: 100 }] },
  { priority: 'NORMAL', chain: [{ kind: 'motion', name: '竖手指打开', closeMotion: '竖手指关闭', closeAfterMs: 1800 }] },
  { priority: 'FORCE', chain: [{ kind: 'look', x: 0, y: 0.1, delayMs: 300 }] },
  {
    priority: 'NORMAL',
    chain: [
      { kind: 'expression', name: '屑' },
      { kind: 'pose', pose: { right: 'chest' } },
      { kind: 'look', x: 0, y: 0 },
      { kind: 'expression', name: '兔牙', delayMs: 50 },
      { kind: 'look', x: 0.2, y: 0 },
    ],
  },
  { priority: 'BACKGROUND', chain: [{ kind: 'pose', pose: { right: 'rest' } }] },
]);
// 整体校验路径同构：graph-only 导入编译出的 segments 与独立编译一致
const priorityDoc = validateNodegraph(makeDoc({ name: '优先级对拍', graph: priorityFixture }));
assert.equal(priorityDoc.ok, true, JSON.stringify(priorityDoc.errors));
assert.deepEqual(priorityDoc.normalized.segments, priorityCompiled.segments);

// 8 步上限与优先级变化共同作用：8 步 BACKGROUND 满段后，第 9 步换 NORMAL 起新段
const boundaryNodes = Array.from({ length: 9 }, (_, i) => ({
  id: 'b' + i, type: 'expression', name: '兔牙',
  priority: i < 8 ? 'BACKGROUND' : 'NORMAL',
  next: ['b' + (i + 1)],
}));
boundaryNodes[8].next = [];
const boundaryCompiled = compileGraphToSegments({ roots: ['b0'], nodes: boundaryNodes });
assert.equal(boundaryCompiled.ok, true);
assert.deepEqual(
  boundaryCompiled.segments.map((s) => ({ priority: s.priority, n: s.chain.length })),
  [{ priority: 'BACKGROUND', n: 8 }, { priority: 'NORMAL', n: 1 }],
);

// 向后兼容（硬编码断言）：无 priority 字段的旧 fixture → 全 NORMAL、纯 8 步切分，
// 编译结果与改动前逐字节一致
const legacyNodes = [
  { id: 'l1', type: 'expression', name: '兔牙', delayMs: 100, next: ['l2'] },
  { id: 'l2', type: 'look', x: 0, y: 0, next: ['l3'] },
  { id: 'l3', type: 'pose', pose: { right: 'rest' }, next: ['l4'] },
  { id: 'l4', type: 'expression', name: '屑', next: ['l5'] },
  { id: 'l5', type: 'look', x: 0.1, y: 0, next: ['l6'] },
  { id: 'l6', type: 'expression', name: '兔牙', delayMs: 200, next: ['l7'] },
  { id: 'l7', type: 'look', x: 0.2, y: 0, next: ['l8'] },
  { id: 'l8', type: 'pose', pose: { right: 'chest' }, next: ['l9'] },
  { id: 'l9', type: 'expression', name: '兔牙', next: ['l10'] },
  { id: 'l10', type: 'look', x: 0, y: 0.2, next: [] },
];
const legacyCompiled = compileGraphToSegments({ roots: ['l1'], nodes: legacyNodes });
assert.equal(legacyCompiled.ok, true);
assert.deepEqual(legacyCompiled.segments, [
  {
    priority: 'NORMAL',
    chain: [
      { kind: 'expression', name: '兔牙', delayMs: 100 },
      { kind: 'look', x: 0, y: 0 },
      { kind: 'pose', pose: { right: 'rest' } },
      { kind: 'expression', name: '屑' },
      { kind: 'look', x: 0.1, y: 0 },
      { kind: 'expression', name: '兔牙', delayMs: 200 },
      { kind: 'look', x: 0.2, y: 0 },
      { kind: 'pose', pose: { right: 'chest' } },
    ],
  },
  {
    priority: 'NORMAL',
    chain: [
      { kind: 'expression', name: '兔牙' },
      { kind: 'look', x: 0, y: 0.2 },
    ],
  },
]);

// validateGraph：合法 priority 接受 / 非法 priority 拒绝 / 缺省仍合法
const priorityOk = validateNodegraph(makeDoc({
  graph: { roots: ['n1'], nodes: [{ id: 'n1', type: 'expression', name: '兔牙', priority: 'FORCE', next: [] }] },
}));
assert.equal(priorityOk.ok, true, JSON.stringify(priorityOk.errors));
assert.deepEqual(priorityOk.normalized.segments, [
  { priority: 'FORCE', chain: [{ kind: 'expression', name: '兔牙' }] },
]);
const priorityBad = validateNodegraph(makeDoc({
  graph: { roots: ['n1'], nodes: [{ id: 'n1', type: 'expression', name: '兔牙', priority: 'HIGH', next: [] }] },
}));
assert.equal(priorityBad.ok, false);
assert.ok(priorityBad.errors.some((e) => e.includes('priority')), '非法 priority 值应报错');

// ---------------------------------------------------------------------------
// 5) segments 优先 + graph 回算；只有 segments 时回算
// ---------------------------------------------------------------------------
const bothGiven = validateNodegraph(makeDoc({
  graph: { roots: ['x'], nodes: [{ id: 'x', type: 'delay', delayMs: 999, next: [] }] },
  segments: [{ priority: 'FORCE', bubble: '嗨', chain: [{ kind: 'expression', name: '兔牙' }] }],
}));
assert.equal(bothGiven.ok, true, JSON.stringify(bothGiven.errors));
// 以 segments 为准
assert.deepEqual(bothGiven.normalized.segments, [
  { priority: 'FORCE', bubble: '嗨', chain: [{ kind: 'expression', name: '兔牙' }] },
]);
// graph 回算为线性视图
assert.deepEqual(bothGiven.normalized.graph, {
  roots: ['s1'],
  nodes: [{ id: 's1', type: 'expression', name: '兔牙', next: [] }],
});

const segmentsOnly = validateNodegraph(makeDoc({
  graph: undefined,
  segments: [
    { priority: 'NORMAL', chain: [{ kind: 'look', x: 0.5, y: 0 }] },
    { priority: 'NORMAL', chain: [{ kind: 'expression', name: '兔牙' }] },
  ],
}));
assert.equal(segmentsOnly.ok, true, JSON.stringify(segmentsOnly.errors));
assert.deepEqual(segmentsOnly.normalized.graph, {
  roots: ['s1'],
  nodes: [
    { id: 's1', type: 'look', x: 0.5, y: 0, next: ['s2'] },
    { id: 's2', type: 'expression', name: '兔牙', next: [] },
  ],
});
// segmentsToGraph 空输入
assert.deepEqual(segmentsToGraph([]), { roots: [], nodes: [] });

// ---------------------------------------------------------------------------
// 6) 模式文件：缺省 llm / 读写 / 非法拒绝 / 坏文件回 llm（SPEC §3 + §5.1）
// ---------------------------------------------------------------------------
const home = makeHome();
const missing = readMotionMode({ homeDir: home });
assert.equal(missing.available, false);
assert.equal(missing.mode, 'llm', '文件不存在必须回缺省 llm（现状兼容）');

writeMotionMode('nodegraph', { homeDir: home, now: 1700000000000 });
const afterWrite = readMotionMode({ homeDir: home });
assert.equal(afterWrite.available, true);
assert.equal(afterWrite.mode, 'nodegraph');
assert.equal(afterWrite.updatedAt, new Date(1700000000000).toISOString());

writeMotionMode('llm', { homeDir: home });
assert.equal(readMotionMode({ homeDir: home }).mode, 'llm');

assert.throws(() => writeMotionMode('auto', { homeDir: home }), /mode 必须是/);
fs.writeFileSync(motionModePath(home), '{ not json');
assert.equal(readMotionMode({ homeDir: home }).mode, 'llm');
assert.equal(readMotionMode({ homeDir: home }).reason, 'invalid-json');
fs.writeFileSync(motionModePath(home), JSON.stringify({ mode: 'yolo' }));
assert.equal(readMotionMode({ homeDir: home }).reason, 'invalid-mode');

// ---------------------------------------------------------------------------
// 7) guardAiCall 互斥拒绝（SPEC §3 强制点）+ 既有白名单零回归
// ---------------------------------------------------------------------------
const ACT_ARGS = { chain: [{ kind: 'expression', name: '兔牙' }] };
// 缺省 / 显式 llm：行为与从前完全一致
assert.equal(guardAiCall({ name: 'l2d_act', args: ACT_ARGS }).ok, true);
assert.equal(guardAiCall({ name: 'l2d_act', args: ACT_ARGS }, { mode: 'llm' }).ok, true);
assert.equal(guardAiCall({ name: 'l2d_emote', args: { mood: '开心' } }).ok, true);
// nodegraph 模式：纯 LLM 整链编排类被拦
const blockedAct = guardAiCall({ name: 'l2d_act', args: ACT_ARGS }, { mode: 'nodegraph' });
assert.equal(blockedAct.ok, false);
assert.equal(blockedAct.status, 400);
assert.equal(blockedAct.reason, 'mode-blocked');
assert.equal(blockedAct.detail, 'l2d_act');
assert.equal(guardAiCall({ name: 'l2d_emote', args: { mood: '开心' } }, { mode: 'nodegraph' }).reason, 'mode-blocked');
// 单步原语放行（LLM 辅助底层通道）
assert.equal(guardAiCall({ name: 'l2d_set_expression', args: { name: '兔牙' } }, { mode: 'nodegraph' }).ok, true);
assert.equal(guardAiCall({ name: 'l2d_play_motion', args: { group: '抚胸手打开' } }, { mode: 'nodegraph' }).ok, true);
assert.equal(guardAiCall({ name: 'l2d_get_state', args: {} }, { mode: 'nodegraph' }).ok, true);
assert.equal(guardAiCall({ name: 'l2d_change_form', args: {} }, { mode: 'nodegraph' }).ok, true);
// 未知工具优先于 mode-blocked（unknown-tool 语义不变）
assert.equal(guardAiCall({ name: 'l2d_unknown' }, { mode: 'nodegraph' }).reason, 'unknown-tool');
// 白名单 18 项（FI 轮：追加 l2d_facial / l2d_facial_manual，其余顺序零改动）
assert.equal(HOST_ALLOWED_TOOLS.length, 18);
assert.equal(HOST_ALLOWED_TOOLS[17], 'l2d_facial_manual');

// ---------------------------------------------------------------------------
// 8) 存取：保存 / 重名覆盖 / 失败原子性 / 列表 / 导出 / 文件名安全化（SPEC §4 + §5.1）
// ---------------------------------------------------------------------------
const home2 = makeHome();
const firstSave = saveNodegraph(makeDoc(), { homeDir: home2 });
assert.ok(firstSave.ok, JSON.stringify(firstSave.errors));
assert.equal(firstSave.name, '挥手打招呼');

// 重名合法覆盖
const secondSave = saveNodegraph(makeDoc({ name: '挥手打招呼' }), { homeDir: home2 });
assert.ok(secondSave.ok);
assert.equal(secondSave.file, firstSave.file);

// 重名覆盖前校验：失败原文件一个字节都不动
const before = fs.readFileSync(firstSave.file, 'utf8');
const failedOverwrite = saveNodegraph(makeDoc({
  name: '挥手打招呼',
  graph: { roots: ['n1'], nodes: [{ id: 'n1', type: 'teleport', next: [] }] },
}), { homeDir: home2 });
assert.equal(failedOverwrite.ok, false);
assert.equal(fs.readFileSync(firstSave.file, 'utf8'), before, '失败的导入不得触碰原文件');

// 列表
const listed = listNodegraphs({ homeDir: home2 });
assert.equal(listed.ok, true);
const item = listed.items.find((i) => i.name === '挥手打招呼');
assert.ok(item, '列表应含已导入节点图');
assert.equal(item.modelId, '大肥鱼');
assert.equal(item.bindingMode, 'any');
assert.equal(item.valid, true);

// 坏文件 → valid:false 不抛
fs.writeFileSync(path.join(nodegraphsDir(home2), 'broken.json'), '{ not json');
const listed2 = listNodegraphs({ homeDir: home2 });
assert.equal(listed2.items.find((i) => i.name === 'broken').valid, false);
// 目录不存在 → 空列表
assert.deepEqual(listNodegraphs({ homeDir: makeHome() }), { ok: true, items: [] });

// 导出：JSON 原文回读
const raw = loadNodegraph('挥手打招呼', { homeDir: home2 });
assert.ok(typeof raw === 'string' && raw.length > 0);
const roundTrip = JSON.parse(raw);
assert.equal(roundTrip.kind, 'dsh-l2d-nodegraph');
assert.deepEqual(roundTrip.segments, firstSave ? good.normalized.segments : null);
assert.equal(loadNodegraph('不存在', { homeDir: home2 }), null);

// 文件名安全化：路径分隔符 / Windows 非法字符 / 开头点 / 控制字符
assert.equal(sanitizeFileName('a/b\\c:d*e?"<>|'), 'a_b_c_d_e_____');
assert.equal(sanitizeFileName('  挥手  '), '挥手');
const sneaky = sanitizeFileName('../etc/passwd');
assert.ok(!sneaky.includes('..') && !sneaky.includes('/'), '不得包含路径穿越字符');
assert.equal(sanitizeFileName('///'), '___'); // 清洗后仍非空且不含分隔符，可安全落盘
assert.throws(() => sanitizeFileName('...')); // 清洗后为空 → 抛
assert.throws(() => sanitizeFileName(''));
// 含非法字符的 name 仍可导入（清洗后落盘）
const dirty = saveNodegraph(makeDoc({ name: 'a/b' }), { homeDir: home2 });
assert.ok(dirty.ok);
assert.ok(fs.existsSync(dirty.file));
assert.equal(path.basename(dirty.file), 'a_b.json', "'a/b' 应清洗为单文件 a_b.json，不得产生子目录");

// ---------------------------------------------------------------------------
// 9) run 执行入口（SPEC §4 第 4 行，NG-RUN）：互斥另一半 / 404 / 注入 execute 全链路
// ---------------------------------------------------------------------------
const homeRun = makeHome();
const fakeCalls = [];
const fakeExecute = async (input) => {
  fakeCalls.push(input);
  return { ok: true, accepted: true, runId: 'r' + fakeCalls.length, outcome: 'completed', settled: true };
};

// 9a. 缺省 llm 模式（文件不存在）→ 409 mode-blocked，且 execute 一次都不被调（互斥的另一半）
const runBlocked = await runNodegraph('挥手打招呼', fakeExecute, { homeDir: homeRun });
assert.equal(runBlocked.ok, false);
assert.equal(runBlocked.status, 409);
assert.equal(runBlocked.reason, 'mode-blocked');
assert.ok(String(runBlocked.message).includes('节点图模式'), '409 消息应提示切换到节点图模式');
assert.ok(String(runBlocked.message).includes('设置页切换动作模式'), '409 消息应提示导入新图后在设置页切换动作模式');
assert.equal(fakeCalls.length, 0, 'mode-blocked 时不得下发任何动作');

// 9b. nodegraph 模式 + 不存在的 name → 404
writeMotionMode('nodegraph', { homeDir: homeRun });
const runMissing = await runNodegraph('不存在的图', fakeExecute, { homeDir: homeRun });
assert.equal(runMissing.ok, false);
assert.equal(runMissing.status, 404);
assert.equal(runMissing.reason, 'nodegraph-not-found');

// 9c. 合法 3 段 + 假 execute 成功 → receipts 完整、completedSegments=3、remainingSegments=0
const runSaved = saveNodegraph(makeDoc({
  graph: undefined,
  segments: [
    { priority: 'NORMAL', chain: [{ kind: 'expression', name: '兔牙' }] },
    { priority: 'NORMAL', bubble: '嗨', chain: [{ kind: 'pose', pose: { right: 'rest' } }] },
    { priority: 'FORCE', chain: [{ kind: 'expression', name: '兔牙' }] },
  ],
}), { homeDir: homeRun });
assert.ok(runSaved.ok, JSON.stringify(runSaved.errors));
const runOk = await runNodegraph('挥手打招呼', fakeExecute, { homeDir: homeRun });
assert.equal(runOk.ok, true);
assert.equal(runOk.status, 'completed');
assert.equal(runOk.name, '挥手打招呼');
assert.equal(runOk.completedSegments, 3);
assert.equal(runOk.remainingSegments, 0);
assert.equal(runOk.replanRequired, false);
// 段间 priority / bubble 任一不同即不合并（与 MCP 同源 coalesce）：三段各自成批
assert.equal(runOk.receipts.length, 3);
assert.deepEqual(runOk.receipts.map((r) => r.sourceSegments), [[0], [1], [2]]);
assert.equal(fakeCalls.length, 3);
assert.equal(fakeCalls[0].priority, 'NORMAL');
assert.equal(fakeCalls[0].bubble, undefined);
assert.equal(fakeCalls[1].bubble, '嗨');
assert.deepEqual(fakeCalls[2].chain, [{ kind: 'expression', name: '兔牙' }]);
assert.equal(fakeCalls[2].priority, 'FORCE');

// 9d. 假 execute 瞬时拒绝（conflict）→ stopped + replanRequired（语义照抄 action-sequence）
const rejectExecute = async () => ({ ok: false, accepted: false, reason: 'conflict', outcome: 'rejected' });
const runConflict = await runNodegraph('挥手打招呼', rejectExecute, { homeDir: homeRun });
assert.equal(runConflict.ok, false);
assert.equal(runConflict.status, 'stopped');
assert.equal(runConflict.reason, 'conflict');
assert.equal(runConflict.replanRequired, true);
assert.equal(runConflict.completedSegments, 0);
assert.equal(runConflict.remainingSegments, 3);
assert.ok(runConflict.receipts.length >= 1, '拒绝也必须留下回执');

// 9e. execute 抛异常 → execution-error 回执，不向调用方崩
const runThrow = await runNodegraph('挥手打招呼', async () => { throw new Error('boom'); }, { homeDir: homeRun });
assert.equal(runThrow.ok, false);
assert.equal(runThrow.status, 'stopped');
assert.equal(runThrow.reason, 'execution-error');
assert.ok(String(runThrow.receipts[0].receipt.detail).includes('boom'));

// 9f. createInboxActExecutor：超时 / pending / 终态三种语义（与 forward.mjs mode='act' 对齐）
const baseRunId = 'rx';
const terminalExecutor = createInboxActExecutor(
  {
    call: (name, args) => { fakeCalls.push({ name, args }); return { ok: true, id: 7, queued: 1 }; },
    read: () => ({
      ready: true,
      result: { ok: true, accepted: true, runId: baseRunId },
      events: [{ type: 'action-done', phase: 'end', runId: baseRunId }],
    }),
  },
  { timeoutMs: 50, pollIntervalMs: 5 },
);
const settledReceipt = await terminalExecutor({ chain: [{ kind: 'expression', name: '兔牙' }], priority: 'NORMAL' });
assert.equal(settledReceipt.accepted, true);
assert.equal(settledReceipt.outcome, 'completed');
assert.equal(settledReceipt.settled, true);
assert.equal(fakeCalls[fakeCalls.length - 1].name, 'l2d_act', '执行器必须走 l2d_act 既有下发链路');

// pending：accepted 但无终态事件 → 预算耗尽回 pending 语义 + 保留 id（不误报完成）
const pendingExecutor = createInboxActExecutor(
  {
    call: () => ({ ok: true, id: 8, queued: 1 }),
    read: () => ({ ready: true, result: { ok: true, accepted: true, runId: 'rp' } }),
  },
  { timeoutMs: 20, pollIntervalMs: 5, sleep: () => Promise.resolve() },
);
const pendingReceipt = await pendingExecutor({ chain: [] });
assert.equal(pendingReceipt.accepted, true);
assert.equal(pendingReceipt.outcome, 'pending');
assert.equal(pendingReceipt.reason, 'pending');
assert.equal(pendingReceipt.id, 8);

// 无回执：入队成功但 read 永不 ready → timeout + 保留 id
const silentExecutor = createInboxActExecutor(
  {
    call: () => ({ ok: true, id: 9, queued: 1 }),
    read: () => ({ ready: false }),
  },
  { timeoutMs: 20, pollIntervalMs: 5, sleep: () => Promise.resolve() },
);
const silentReceipt = await silentExecutor({ chain: [] });
assert.equal(silentReceipt.ok, false);
assert.equal(silentReceipt.reason, 'timeout');
assert.equal(silentReceipt.id, 9);

// 入队失败：call 返回失败 → 明确拒绝回执（executeActionSequence 消费为 stopped）
const deadExecutor = createInboxActExecutor({ call: () => ({ ok: false, reason: 'queue-overflow' }), read: () => ({ ready: false }) });
const deadReceipt = await deadExecutor({ chain: [] });
assert.equal(deadReceipt.ok, false);
assert.equal(deadReceipt.reason, 'queue-overflow');
assert.equal(deadReceipt.outcome, 'rejected');

// ---------------------------------------------------------------------------
for (const dir of tmpHomes) fs.rmSync(dir, { recursive: true, force: true });
console.log('nodegraph ok');
