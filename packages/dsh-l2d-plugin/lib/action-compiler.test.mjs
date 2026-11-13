/**
 * OACA-1 动作编译流水线测试。
 *
 * 直跑：node packages/dsh-l2d-plugin/lib/action-compiler.test.mjs
 * 纪律：不连真 LLM、不发 HTTP、不碰用户目录（homeDir 用 mkdtemp）。
 *       假 LLM 只返回固定 ops，校验与落盘全部走真实实现。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  COMPILER_VERSION, MAX_ACTIONS_PER_COMPILE, SEED_ACTIONS,
  capabilityRevisionOf, compileModelActions, loadCapabilityProfile, normalizePriority,
  publishBundle, readCurrentBundle, validateCompiledAction,
} from './action-compiler.mjs';
import { allowedFromLive2dIds } from './nodegraph-schema.mjs';
import { validateNodegraph } from './nodegraph.mjs';

let passed = 0;
const failures = [];
async function it(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push({ name, message: err && err.message });
    console.error(`  ✗ ${name}\n    ${err && err.message}`);
  }
}

// ---- 夹具体：归一化后的清单 + 假能力档案（结构与真实 profile 一致）
const ids = {
  params: { ParamAngleX: { min: -1, max: 1 }, ParamAngleY: { min: -1, max: 1 } },
  motions: ['招手'],
  expressions: ['兔牙', '圈圈眼'],
  forms: [],
};
const allowed = allowedFromLive2dIds(ids);
const capability = {
  modelId: 'm-test',
  profileRevision: 'rTEST12345678',
  controls: [
    { id: 'head.pitch', status: 'supported', min: -1, max: 1, neutral: 0, ownership: 'requires-own' },
    { id: 'head.yaw', status: 'supported', min: -1, max: 1, neutral: 0, ownership: 'requires-own' },
    { id: 'gaze.x', status: 'supported', min: -1, max: 1, neutral: 0, ownership: 'direct' },
    { id: 'gaze.y', status: 'supported', min: -1, max: 1, neutral: 0, ownership: 'direct' },
    { id: 'head.roll', status: 'unsupported', min: -1, max: 1, neutral: 0, ownership: 'direct' },
  ],
};

/** 合法的设计层 ops：expression → look 单链。 */
const GOOD_OPS = [
  { op: 'add_node', type: 'expression', id: 'e1', pos: { x: 0, y: 0 }, props: { name: '兔牙' } },
  { op: 'add_node', type: 'look', id: 'l1', pos: { x: 260, y: 0 }, props: { x: 0, y: 0.05 } },
  { op: 'connect', from: 'e1', to: 'l1' },
];
/** 非法：引用了模型里不存在的表情（生成阶段就该被 applyOps 挡住）。 */
const BROKEN_OPS = [
  { op: 'add_node', type: 'expression', id: 'e1', pos: { x: 0, y: 0 }, props: { name: '根本不存在的表情' } },
];

function fakeLlm(ops, { calls } = {}) {
  return async (prompt) => {
    if (calls) calls.push(prompt);
    return { ops, explanation: '假编译器输出：表情后视线回正' };
  };
}

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'oaca-1-'));
const ACTION = {
  actionId: 'head.nod',
  category: 'head',
  triggers: ['interaction.head_nod'],
  instruction: '轻轻点头',
  requiredControls: ['head.pitch'],
  parameters: { intensity: { type: 'number', min: 0, max: 1, default: 0.6 } },
  priority: 'NORMAL',
  interruptible: true,
};

console.log('OACA-1 动作编译流水线');

await it('种子表只用真实能力 id，且优先级是三档枚举', () => {
  assert.ok(SEED_ACTIONS.length >= 3, '种子动作至少 3 个');
  for (const a of SEED_ACTIONS) {
    assert.match(a.actionId, /^[a-z]+\.[a-z_]+$/, `actionId 命名：${a.actionId}`);
    assert.ok(['BACKGROUND', 'NORMAL', 'FORCE'].includes(a.priority), `优先级档位：${a.priority}`);
    assert.ok(a.instruction.length > 10, '每个动作都要有可编译的语义指令');
  }
});

await it('normalizePriority：数值归一为三档，未知字符串回落 NORMAL', () => {
  assert.equal(normalizePriority(10), 'BACKGROUND');
  assert.equal(normalizePriority(50), 'NORMAL');
  assert.equal(normalizePriority(90), 'FORCE');
  assert.equal(normalizePriority('force'), 'FORCE');
  assert.equal(normalizePriority('nonsense'), 'NORMAL');
  assert.equal(normalizePriority(undefined), 'NORMAL');
});

await it('capabilityRevisionOf：优先 profileRevision，退化时按控制项稳定哈希（同输入同输出）', () => {
  assert.equal(capabilityRevisionOf(capability), 'rTEST12345678');
  const noRev = { controls: capability.controls };
  const a = capabilityRevisionOf(noRev);
  const b = capabilityRevisionOf({ controls: [...capability.controls] });
  assert.match(a, /^rcap[0-9a-f]{12}$/);
  assert.equal(a, b, '控制项顺序变化不应改变 revision');
  assert.equal(capabilityRevisionOf(null), '');
});

await it('L2 诚实性：无能力档案标 skipped，绝不冒充 pass', () => {
  const doc = { schemaVersion: 1, kind: 'dsh-l2d-nodegraph', name: 'g', modelBinding: { modelId: 'm', bindingMode: 'strict' }, graph: { nodes: [], edges: [] }, segments: [], meta: {} };
  const r = validateCompiledAction({ doc, entry: { actionId: 'x', requiredControls: ['head.pitch'], parameters: {} }, capability: null, allowed });
  assert.equal(r.layers.capability.status, 'skipped');
  assert.equal(r.layers.capability.reason, 'capability-profile-missing');
  assert.equal(r.layers.execution.status, 'skipped', 'L4 在 OACA-1 不执行');
});

await it('L3：manifest 参数域非法 → 拒绝；requires-own 只转约束不误判失败', () => {
  const doc = { schemaVersion: 1, kind: 'dsh-l2d-nodegraph', name: 'g', modelBinding: { modelId: 'm', bindingMode: 'strict' }, graph: { nodes: [], edges: [] }, segments: [], meta: {} };
  const bad = validateCompiledAction({
    doc,
    entry: { actionId: 'x', requiredControls: ['head.pitch'], parameters: { intensity: { type: 'number', min: 1, max: 0, default: 0.5 } } },
    capability, allowed,
  });
  assert.equal(bad.layers.safety.status, 'fail');
  assert.ok(bad.errors.some((e) => e.includes('min/max')), bad.errors.join('; '));

  const outOfDefault = validateCompiledAction({
    doc,
    entry: { actionId: 'x', requiredControls: ['head.pitch'], parameters: { intensity: { type: 'number', min: 0, max: 1, default: 5 } } },
    capability, allowed,
  });
  assert.equal(outOfDefault.layers.safety.status, 'fail');
  assert.ok(outOfDefault.errors.some((e) => e.includes('default')));

  const okEntry = validateCompiledAction({
    doc,
    entry: { actionId: 'x', requiredControls: ['head.pitch'], parameters: { intensity: { type: 'number', min: 0, max: 1, default: 0.5 } } },
    capability, allowed,
  });
  assert.deepEqual(okEntry.requiresOwn, ['head.pitch'], '物理输出参数必须被标记为 requires-own');
  assert.ok(okEntry.warnings.some((w) => w.reason === 'requires-own'));
});

await it('L2：能力不支持（status=unsupported）→ 该动作拒绝', async () => {
  const out = await compileModelActions({
    modelId: 'm-test',
    homeDir: tmpHome,
    capability,
    live2dIds: ids,
    allowed,
    dryRun: true,
    actions: [{ ...ACTION, actionId: 'head.tilt', requiredControls: ['head.roll'], instruction: '歪头' }],
    llm: fakeLlm(GOOD_OPS),
  });
  assert.equal(out.summary.compiled, 0);
  assert.equal(out.summary.rejected, 1);
  assert.equal(out.bundle.actions[0].status, 'rejected');
  assert.match(out.bundle.actions[0].errors.join(';'), /能力不可用 head\.roll/);
});

await it('无 LLM 通道：明确 ai-unavailable，不产生任何 bundle', async () => {
  const out = await compileModelActions({ modelId: 'm-test', homeDir: tmpHome, actions: [ACTION] });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'ai-unavailable');
  assert.equal(fs.existsSync(path.join(tmpHome, 'l2d-action-bundles')), false, '不得留下半个产物');
});

await it('合法编译：产出 manifest 条目 + 图，且图上 Schema v1 校验通过', async () => {
  const calls = [];
  const out = await compileModelActions({
    modelId: 'm-test',
    homeDir: tmpHome,
    capability,
    live2dIds: ids,
    allowed,
    actions: [ACTION],
    dryRun: true,
    llm: fakeLlm(GOOD_OPS, { calls }),
  });
  assert.equal(calls.length, 1, '一次编译一个动作 = 一次 LLM 调用');
  assert.equal(out.summary.compiled, 1, out.bundle.actions[0].errors?.join(';'));
  const entry = out.bundle.actions[0];
  assert.equal(entry.actionId, 'head.nod');
  assert.equal(entry.graphId, 'graph_head_nod');
  assert.equal(entry.priority, 'NORMAL');
  assert.deepEqual(entry.requiresOwn, ['head.pitch']);
  assert.ok(entry.graphHash, '必须记录 graphHash 供运行时校验失配');
  const doc = out.bundle.graphs.graph_head_nod;
  assert.ok(doc, '通过校验的图必须进 bundle');
  assert.equal(doc.modelBinding.bindingMode, 'strict', '编译产物 strict 绑定模型');
  assert.equal(validateNodegraph(doc, { allowed }).ok, true, '产物本身必须是合法 Schema v1');
});

await it('LLM 给出坏图：该动作 rejected，不影响其它动作，且不落盘半成品', async () => {
  const out = await compileModelActions({
    modelId: 'm-test',
    homeDir: tmpHome,
    capability,
    live2dIds: ids,
    allowed,
    dryRun: true,
    actions: [ACTION, { ...ACTION, actionId: 'head.shake', requiredControls: ['head.yaw'], instruction: '摇头' }],
    llm: async (prompt) => (prompt.user.includes('摇头') ? { ops: BROKEN_OPS } : { ops: GOOD_OPS }),
  });
  assert.equal(out.summary.requested, 2);
  assert.equal(out.summary.compiled, 1, '一个好的');
  assert.equal(out.summary.rejected, 1, '一个坏的');
  const shake = out.bundle.actions.find((a) => a.actionId === 'head.shake');
  assert.equal(shake.status, 'rejected');
  assert.equal(shake.stage, 'generate', '坏图在生成阶段就被挡住');
  assert.equal(out.bundle.graphs.graph_head_shake, undefined, '被拒动作不得留图');
});

await it('原子发布：rev-1 → rev-2，旧 revision 原样保留，指针指向最新', async () => {
  const first = await compileModelActions({
    modelId: 'm-test', homeDir: tmpHome, capability, live2dIds: ids, allowed,
    actions: [ACTION], llm: fakeLlm(GOOD_OPS),
  });
  assert.equal(first.ok, true, JSON.stringify(first.published));
  assert.equal(first.published.revision, 1);
  const rev1Manifest = path.join(first.published.dir, 'manifest.json');
  assert.ok(fs.existsSync(rev1Manifest));
  const manifest1 = JSON.parse(fs.readFileSync(rev1Manifest, 'utf8'));
  assert.equal(manifest1.manifestVersion, 1);
  assert.equal(manifest1.compilerVersion, COMPILER_VERSION);
  assert.equal(manifest1.capabilityRevision, 'rTEST12345678');
  assert.equal(manifest1.actions[0].graphId, 'graph_head_nod');
  assert.ok(fs.existsSync(path.join(first.published.dir, 'graphs', 'graph_head_nod.json')));
  assert.ok(fs.existsSync(path.join(first.published.dir, 'validation.json')));

  const second = await compileModelActions({
    modelId: 'm-test', homeDir: tmpHome, capability, live2dIds: ids, allowed,
    actions: [{ ...ACTION, parameters: { intensity: { type: 'number', min: 0, max: 1, default: 0.9 } } }],
    llm: fakeLlm(GOOD_OPS),
  });
  assert.equal(second.published.revision, 2);
  const ptr = readCurrentBundle({ modelId: 'm-test', homeDir: tmpHome });
  assert.equal(ptr.revision, 2, '指针切到 rev-2');
  assert.ok(fs.existsSync(rev1Manifest), '旧 revision 不得被覆盖或删除');
  const manifest2 = JSON.parse(fs.readFileSync(path.join(second.published.dir, 'manifest.json'), 'utf8'));
  assert.equal(manifest2.actions[0].parameters.intensity.default, 0.9);
});

await it('全部动作失败：拒绝发布，current.json 不前进', async () => {
  const before = readCurrentBundle({ modelId: 'm-test', homeDir: tmpHome });
  const out = await publishBundle({
    homeDir: tmpHome,
    bundle: {
      modelId: 'm-test', capabilityRevision: 'rX', compilerVersion: COMPILER_VERSION,
      compiledAt: new Date().toISOString(), actions: [{ actionId: 'a', graphId: 'g_a', status: 'rejected', layers: {} }], graphs: {},
    },
  });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'no-valid-action');
  const after = readCurrentBundle({ modelId: 'm-test', homeDir: tmpHome });
  assert.equal(after.revision, before.revision, '失败的发布不得推进 revision');
});

await it('动作数上限：超过 MAX_ACTIONS_PER_COMPILE 只处理前 N 个', async () => {
  const many = Array.from({ length: MAX_ACTIONS_PER_COMPILE + 3 }, (_, i) => ({
    ...ACTION, actionId: `bulk.a${i}`, instruction: `批量动作 ${i}`,
  }));
  const out = await compileModelActions({
    modelId: 'm-bulk', homeDir: tmpHome, capability, live2dIds: ids, allowed,
    actions: many, dryRun: true, llm: fakeLlm(GOOD_OPS),
  });
  assert.equal(out.summary.requested, MAX_ACTIONS_PER_COMPILE);
});

await it('真实能力档案可加载（tools/capability-scan），且 revision 来自档案本身', () => {
  const loaded = loadCapabilityProfile('大肥鱼.dsl2d.2048');
  if (!loaded.profile) {
    console.log(`    （跳过：本机无该档案，reason=${loaded.reason}）`);
    return;
  }
  const rev = capabilityRevisionOf(loaded.profile);
  assert.match(rev, /^r[0-9a-f]{12}$|^r/, `revision 应来自 profileRevision，收到 ${rev}`);
  const supported = loaded.profile.controls.filter((c) => c.status === 'supported').map((c) => c.id);
  for (const a of SEED_ACTIONS) {
    for (const cid of a.requiredControls || []) {
      assert.ok(supported.includes(cid), `种子动作引用了真实模型不支持的能力：${cid}`);
    }
  }
});

fs.rmSync(tmpHome, { recursive: true, force: true });

console.log('');
if (failures.length) {
  console.error(`失败 ${failures.length} 项 / 通过 ${passed} 项`);
  process.exit(1);
}
console.log(`action-compiler: ${passed} 项全部通过`);
