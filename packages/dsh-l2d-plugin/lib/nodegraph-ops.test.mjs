/**
 * AI 节点编辑后端测试：applyOps 每种 op 的成功/失败、整体校验、graphHash、
 * live2d-ids 可选校验（临时 fixture + 仓库真实目录）、HTTP 处理器（stale-graph 409、
 * ai-edit 503 / 预演过滤 / 不改文件）、guardGraphCall 白名单、NODE-SCHEMA.json 漂移。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { applyOps, graphHash, compileEditorGraph, editorGraphFromDoc } from './nodegraph-ops.mjs';
import {
  CODE_ONLY_PARAM_IDS, DEFAULT_LIVE2D_IDS_FILE, buildNodeSchema, checkLive2dRef, loadLive2dIds, normalizeLive2dIds,
} from './nodegraph-schema.mjs';
import { handleApplyOps, handleAiEdit, handleGraphGet } from './nodegraph-api.mjs';
import { buildAiEditPrompt } from './nodegraph-ai.mjs';
import { HOST_GRAPH_TOOLS, HOST_ALLOWED_TOOLS, guardAiCall, guardGraphCall } from './host-guard.mjs';
import { saveNodegraph, loadNodegraph } from './nodegraph.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');

/** 基础图：触发器 → 表情 → 延时 → 动作 */
function baseGraph() {
  const r = applyOps({ nodes: [], edges: [] }, [
    { op: 'add_node', id: 't', type: 'trigger', pos: { x: 0, y: 0 } },
    { op: 'add_node', id: 'e', type: 'expression', pos: { x: 260, y: 0 }, props: { name: '脸红' } },
    { op: 'add_node', id: 'd', type: 'delay', pos: { x: 520, y: 0 } },
    { op: 'add_node', id: 'm', type: 'motion', pos: { x: 780, y: 0 } },
    { op: 'connect', from: 't', to: 'e' },
    { op: 'connect', from: 'e', to: 'd' },
    { op: 'connect', from: 'd', to: 'm' },
  ]);
  assert.deepEqual(r.errors, [], '基础图应构建成功');
  assert.equal(r.valid, true);
  return r.graph;
}
const G = baseGraph();
const err1 = (r) => {
  assert.equal(r.applied, false, '失败 op 时整批不生效');
  assert.equal(r.errors.length, 1);
  return r.errors[0];
};

// ---------------------------------------------------------------------------
// 0) 不修改入参 + 编译语义
// ---------------------------------------------------------------------------
{
  const snapshot = JSON.stringify(G);
  applyOps(G, [{ op: 'remove_node', id: 'e' }, { op: 'move_node', id: 'm', x: 1, y: 2 }]);
  assert.equal(JSON.stringify(G), snapshot, 'applyOps 不得修改入参');
  const exec = compileEditorGraph(G);
  assert.deepEqual(exec.roots, ['e'], '设计层 trigger 被穿透');
  assert.deepEqual(exec.nodes.map((n) => n.id), ['e', 'd', 'm']);
  assert.equal(exec.nodes[2].closeMotion, '竖手指关闭', 'motion 默认带配对收招');
}

// ---------------------------------------------------------------------------
// 1) add_node
// ---------------------------------------------------------------------------
{
  const ok = applyOps(G, [{ op: 'add_node', type: 'look', props: { x: 0.5, y: -0.2 } }, { op: 'connect', from: 'm', to: 'ai_1' }]);
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.valid, true);
  const look = ok.graph.nodes.find((n) => n.id === 'ai_1');
  assert.equal(look.type, 'look', 'id 缺省自动分配 ai_<n>');
  assert.equal(look.props.x, 0.5);
  assert.equal(look.props.stepDelayMs, 0, '未给的参数取默认值');

  assert.equal(err1(applyOps(G, [{ op: 'add_node', type: 'hitarea' }])).reason, 'unknown-node-type');
  assert.equal(err1(applyOps(G, [{ op: 'add_node', id: 'e', type: 'delay' }])).reason, 'duplicate-node-id');
  assert.equal(err1(applyOps(G, [{ op: 'add_node', id: 'bad id!', type: 'delay' }])).reason, 'invalid-node-id');
  assert.equal(err1(applyOps(G, [{ op: 'add_node' }])).reason, 'missing-field');
  assert.equal(err1(applyOps(G, [{ op: 'add_node', type: 'look', props: { x: 2 } }])).reason, 'param-out-of-range');
  assert.equal(err1(applyOps(G, [{ op: 'add_node', type: 'look', props: { x: '0.1' } }])).reason, 'param-type-mismatch');
  assert.equal(err1(applyOps(G, [{ op: 'add_node', type: 'look', props: { zoom: 1 } }])).reason, 'unknown-param');
  assert.equal(err1(applyOps(G, [{ op: 'add_node', type: 'pose', props: { poseRight: 'wave' } }])).reason, 'param-not-allowed');
  assert.equal(err1(applyOps(G, [{ op: 'add_node', type: 'delay', pos: { x: NaN, y: 0 } }])).reason, 'invalid-position');
  const okClose = applyOps(G, [{ op: 'add_node', type: 'motion', props: { name: '抚胸手打开', closeMotion: '抚胸手关闭' } }]);
  assert.deepEqual(okClose.errors.filter((e) => e.opIndex !== null), [], 'closeMotion 与推导值一致时允许显式写');
  assert.equal(err1(applyOps(G, [{ op: 'add_node', type: 'motion', props: { closeMotion: '抚胸手关闭' } }])).reason, 'param-readonly');
  assert.equal(err1(applyOps(G, [{ op: 'add_node', type: 'motion', props: { name: 'Idle' } }])).reason, 'param-not-allowed', 'Idle 不允许');
  // 上限
  const many = [];
  for (let i = 0; i < 120 - G.nodes.length; i++) many.push({ op: 'add_node', type: 'delay' });
  const full = applyOps(G, many);
  assert.equal(full.applied, true);
  assert.equal(err1(applyOps(full.graph, [{ op: 'add_node', type: 'delay' }])).reason, 'too-many-nodes');
}

// ---------------------------------------------------------------------------
// 2) remove_node（连带删线）
// ---------------------------------------------------------------------------
{
  const ok = applyOps(G, [{ op: 'remove_node', id: 'd' }, { op: 'connect', from: 'e', to: 'm' }]);
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.graph.nodes.some((n) => n.id === 'd'), false);
  assert.equal(ok.graph.edges.some((e) => e.from === 'd' || e.to === 'd'), false, '相关连线一并删除');
  assert.equal(err1(applyOps(G, [{ op: 'remove_node', id: 'nope' }])).reason, 'node-not-found');
  // 删光动作节点：op 成功但整图不合法
  const empty = applyOps(G, [{ op: 'remove_node', id: 'e' }, { op: 'remove_node', id: 'd' }, { op: 'remove_node', id: 'm' }]);
  assert.equal(empty.applied, true);
  assert.equal(empty.valid, false);
  assert.ok(empty.errors.every((e) => e.reason === 'graph-invalid' && e.opIndex === null));
}

// ---------------------------------------------------------------------------
// 3) set_param
// ---------------------------------------------------------------------------
{
  const ok = applyOps(G, [
    { op: 'set_param', id: 'm', key: 'name', value: '狗尾巴草打开' },
    { op: 'set_param', id: 'e', key: 'stepDelayMs', value: 300 },
    { op: 'set_param', id: 'e', key: 'label', value: '害羞' },
    { op: 'set_param', id: 'e', key: 'priority', value: 'FORCE' },
  ]);
  assert.deepEqual(ok.errors, []);
  const m = ok.graph.nodes.find((n) => n.id === 'm');
  assert.equal(m.props.closeMotion, '狗尾巴草关闭', 'motion.name 改动联动只读 closeMotion');
  assert.equal(ok.graph.nodes.find((n) => n.id === 'e').label, '害羞');
  assert.equal(err1(applyOps(G, [{ op: 'set_param', id: 'm', key: 'closeMotion', value: 'x' }])).reason, 'param-readonly');
  assert.equal(err1(applyOps(G, [{ op: 'set_param', id: 'd', key: 'delayMs', value: 0 }])).reason, 'param-out-of-range');
  assert.equal(err1(applyOps(G, [{ op: 'set_param', id: 'd', key: 'delayMs', value: '100' }])).reason, 'param-type-mismatch');
  assert.equal(err1(applyOps(G, [{ op: 'set_param', id: 'd', key: 'name', value: 'x' }])).reason, 'unknown-param');
  assert.equal(err1(applyOps(G, [{ op: 'set_param', id: 'zz', key: 'delayMs', value: 10 }])).reason, 'node-not-found');
  assert.equal(err1(applyOps(G, [{ op: 'set_param', id: 'e', key: 'priority', value: 'URGENT' }])).reason, 'param-not-allowed');
  // 无 live2d-ids：表情名只做类型校验，未知名由整体校验（choreography 白名单）兜底
  const unknownExpr = applyOps(G, [{ op: 'set_param', id: 'e', key: 'name', value: '不存在的表情' }]);
  assert.equal(unknownExpr.applied, true, '无目录时不按 ID 拒');
  assert.equal(unknownExpr.valid, false);
  assert.equal(unknownExpr.errors[0].reason, 'graph-invalid');
}

// ---------------------------------------------------------------------------
// 4) connect
// ---------------------------------------------------------------------------
{
  const g2 = applyOps(G, [{ op: 'add_node', id: 'x', type: 'expression' }]).graph;
  assert.equal(err1(applyOps(g2, [{ op: 'connect', from: 'e', to: 'e' }])).reason, 'self-loop');
  assert.equal(err1(applyOps(g2, [{ op: 'connect', from: 'e', to: 'd' }])).reason, 'duplicate-edge');
  assert.equal(err1(applyOps(g2, [{ op: 'connect', from: 'm', to: 'e' }])).reason, 'input-occupied');
  assert.equal(err1(applyOps(g2, [{ op: 'connect', from: 'm', to: 'e', replace: true }])).reason, 'cycle');
  assert.equal(err1(applyOps(g2, [{ op: 'connect', from: 'm', to: 'x', fromPort: 'in' }])).reason, 'unknown-port');
  assert.equal(err1(applyOps(g2, [{ op: 'connect', from: 'm', to: 'x', toPort: 'side' }])).reason, 'unknown-port');
  assert.equal(err1(applyOps(g2, [{ op: 'connect', from: 'm', to: 'nope' }])).reason, 'node-not-found');
  const mismatch = applyOps(g2, [{ op: 'set_param', id: 'x', key: 'portType', value: 'signal' }, { op: 'connect', from: 'm', to: 'x' }]);
  assert.equal(err1(mismatch).reason, 'port-type-mismatch');
  assert.equal(mismatch.errors[0].opIndex, 1, 'errors 带 opIndex');
  const ok = applyOps(g2, [{ op: 'connect', from: 'm', to: 'x' }]);
  assert.deepEqual(ok.errors, []);
  const replaced = applyOps(ok.graph, [{ op: 'connect', from: 'e', to: 'x', replace: true }]);
  assert.deepEqual(replaced.errors, []);
  assert.deepEqual(replaced.graph.edges.filter((e) => e.to === 'x').map((e) => e.from), ['e'], 'replace 替换原输入');
}

// ---------------------------------------------------------------------------
// 5) disconnect
// ---------------------------------------------------------------------------
{
  const ok = applyOps(G, [{ op: 'disconnect', from: 'd', to: 'm' }, { op: 'remove_node', id: 'm' }]);
  assert.deepEqual(ok.errors, []);
  const edgeId = G.edges[0].id;
  const byId = applyOps(G, [{ op: 'disconnect', edgeId }]);
  assert.equal(byId.graph.edges.length, G.edges.length - 1);
  assert.equal(err1(applyOps(G, [{ op: 'disconnect', from: 'm', to: 'e' }])).reason, 'edge-not-found');
  assert.equal(err1(applyOps(G, [{ op: 'disconnect' }])).reason, 'missing-field');
}

// ---------------------------------------------------------------------------
// 6) move_node + 未知 op / 畸形输入
// ---------------------------------------------------------------------------
{
  const ok = applyOps(G, [{ op: 'move_node', id: 'e', x: 10.6, y: -20 }]);
  assert.deepEqual(ok.graph.nodes.find((n) => n.id === 'e').pos, { x: 11, y: -20 });
  assert.notEqual(graphHash(ok.graph), graphHash(G), '移动节点改变 hash');
  assert.equal(err1(applyOps(G, [{ op: 'move_node', id: 'e', x: 1e9, y: 0 }])).reason, 'invalid-position');
  assert.equal(err1(applyOps(G, [{ op: 'move_node', id: 'q', x: 1, y: 1 }])).reason, 'node-not-found');
  assert.equal(err1(applyOps(G, [{ op: 'explode' }])).reason, 'unknown-op');
  assert.equal(err1(applyOps(G, ['x'])).reason, 'invalid-op');
  assert.equal(applyOps(G, 'nope').errors[0].reason, 'invalid-ops');
  assert.equal(applyOps(G, new Array(201).fill({ op: 'move_node', id: 'e', x: 0, y: 0 })).errors[0].reason, 'too-many-ops');
  assert.equal(applyOps(null, []).errors[0].reason, 'invalid-graph');
  assert.equal(applyOps({ nodes: [{ id: 'a', type: 'pose3' }] }, []).errors[0].reason, 'invalid-graph');
  // atomic：前面成功的 op 也回滚；skip：失败跳过继续
  const atomic = applyOps(G, [{ op: 'move_node', id: 'e', x: 5, y: 5 }, { op: 'remove_node', id: 'zz' }]);
  assert.equal(atomic.applied, false);
  assert.deepEqual(atomic.graph.nodes.find((n) => n.id === 'e').pos, { x: 260, y: 0 });
  const skip = applyOps(G, [{ op: 'move_node', id: 'e', x: 5, y: 5 }, { op: 'remove_node', id: 'zz' }, { op: 'move_node', id: 'm', x: 1, y: 1 }], { mode: 'skip' });
  assert.deepEqual(skip.appliedOps, [0, 2]);
  assert.equal(skip.errors[0].opIndex, 1);
}

// ---------------------------------------------------------------------------
// 7) graphHash：稳定（键顺序无关）、viewport 不参与
// ---------------------------------------------------------------------------
{
  const reordered = JSON.parse(JSON.stringify(G));
  reordered.nodes = reordered.nodes.map((n) => Object.fromEntries(Object.entries(n).reverse()));
  reordered.viewport = { x: 999, y: 1, k: 2 };
  assert.equal(graphHash(reordered), graphHash(G));
  assert.match(graphHash(G), /^[0-9a-f]{16}$/);
}

// ---------------------------------------------------------------------------
// 8) live2d-ids：临时 fixture（不编造真实目录内容）
// ---------------------------------------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-ops-'));
{
  const fixture = path.join(tmp, 'live2d-ids.json');
  fs.writeFileSync(fixture, JSON.stringify({ params: { ParamA: { min: -1, max: 1 } }, motions: ['竖手指打开'], expressions: ['脸红'], forms: [0, 1] }));
  const loaded = loadLive2dIds(fixture);
  assert.ok(loaded.ids);
  const ids = loaded.ids;
  assert.equal(err1(applyOps(G, [{ op: 'set_param', id: 'e', key: 'name', value: '兔牙' }], { live2dIds: ids })).reason, 'unknown-live2d-id');
  assert.equal(err1(applyOps(G, [{ op: 'set_param', id: 'm', key: 'name', value: '抚胸手打开' }], { live2dIds: ids })).reason, 'unknown-live2d-id');
  assert.deepEqual(applyOps(G, [{ op: 'set_param', id: 'm', key: 'name', value: '竖手指打开' }], { live2dIds: ids }).errors, []);
  assert.equal(checkLive2dRef(ids, 'params', { id: 'ParamA', value: 2 }).reason, 'param-out-of-range');
  assert.equal(checkLive2dRef(ids, 'params', { id: 'ParamB' }).reason, 'unknown-live2d-id');
  assert.equal(checkLive2dRef(ids, 'params', { id: 'ParamA', value: 0.5 }), null);
  assert.equal(checkLive2dRef(ids, 'forms', 1), null);
  assert.equal(checkLive2dRef(ids, 'forms', 2).reason, 'unknown-live2d-id');
  const mouth = checkLive2dRef(ids, 'params', { id: 'ParamMouthOpen' });
  assert.equal(mouth.warning, true, 'ParamMouthOpen 放行');
  assert.equal(mouth.reason, 'live2d-id-not-in-model');
  assert.equal(checkLive2dRef(null, 'expressions', '任意'), null, '无目录恒通过');
  assert.equal(loadLive2dIds(path.join(tmp, 'missing.json')).reason, 'missing');
  fs.writeFileSync(path.join(tmp, 'bad.json'), '{"params":{"X":{"min":2,"max":1}}}');
  assert.equal(loadLive2dIds(path.join(tmp, 'bad.json')).reason, 'invalid-shape');
  assert.equal(normalizeLive2dIds([]), null);
  const prompt = buildAiEditPrompt({ graph: G, instruction: '加个脸红', lang: 'en', live2dIds: ids });
  assert.ok(prompt.system.includes('"ParamA"'), '目录存在时提示词带合法 ID');
  assert.ok(prompt.system.includes(JSON.stringify(buildNodeSchema())), '提示词嵌入同源 schema');
  assert.ok(!buildAiEditPrompt({ graph: G, instruction: 'x', lang: 'zh-CN', live2dIds: null }).system.includes('合法 Live2D ID'));
}

// ---------------------------------------------------------------------------
// 9) 仓库真实 live2d-ids.json（docs/nodegraph，由 Live2D 同事生成）
// ---------------------------------------------------------------------------
{
  const real = loadLive2dIds(DEFAULT_LIVE2D_IDS_FILE);
  assert.ok(real.ids, '真实目录应可读：' + (real.reason || ''));
  assert.equal(Object.keys(real.ids.params).length, 509);
  assert.equal(real.ids.motions.length, 7);
  assert.equal(real.ids.expressions.length, 21);
  assert.deepEqual(real.ids.forms, [0, 1, 2]);
  for (const id of CODE_ONLY_PARAM_IDS) assert.equal(real.ids.params[id], undefined, id + ' 确实不在模型里');
  assert.equal(checkLive2dRef(real.ids, 'params', { id: 'ParamMouthOpen' }).reason, 'live2d-id-not-in-model');
  assert.ok(real.ids.params.ParamMouthOpenY, '模型里有 ParamMouthOpenY');
  // 基础图在真实目录下全绿；每个真实表情与可手动播动作组都能写进节点
  assert.deepEqual(applyOps(G, [], { live2dIds: real.ids }).errors, []);
  for (const name of real.ids.expressions) {
    const r = applyOps(G, [{ op: 'set_param', id: 'e', key: 'name', value: name }], { live2dIds: real.ids });
    assert.deepEqual(r.errors, [], '真实表情应合法：' + name);
  }
  for (const name of real.ids.motions.filter((n) => n !== 'Idle')) {
    const r = applyOps(G, [{ op: 'set_param', id: 'm', key: 'name', value: name }], { live2dIds: real.ids });
    assert.deepEqual(r.errors, [], '真实动作组应合法：' + name);
  }
  assert.equal(err1(applyOps(G, [{ op: 'set_param', id: 'm', key: 'name', value: 'Idle' }], { live2dIds: real.ids })).reason, 'param-not-allowed');
  assert.equal(err1(applyOps(G, [{ op: 'set_param', id: 'e', key: 'name', value: '裙子切换' }], { live2dIds: real.ids })).reason, 'unknown-live2d-id');
  const rangeOk = Object.entries(real.ids.params).every(([, r]) => Number.isFinite(r.min) && Number.isFinite(r.max) && r.min <= r.max);
  assert.ok(rangeOk, '真实参数量程形状合法');
}

// ---------------------------------------------------------------------------
// 10) HTTP 处理器：apply-ops（graph / name 两种）、stale-graph 409、ai-edit
// ---------------------------------------------------------------------------
{
  const hash = graphHash(G);
  const ok = handleApplyOps({ graph: G, ops: [{ op: 'move_node', id: 'e', x: 0, y: 0 }], baseHash: hash }, { live2dIds: null });
  assert.equal(ok.status, 200);
  assert.equal(ok.payload.ok, true);
  assert.equal(ok.payload.hash, graphHash(ok.payload.graph));
  const stale = handleApplyOps({ graph: G, ops: [], baseHash: '0000000000000000' }, { live2dIds: null });
  assert.equal(stale.status, 409);
  assert.equal(stale.payload.reason, 'stale-graph');
  assert.equal(stale.payload.hash, hash);
  assert.equal(handleApplyOps({ graph: G, ops: 'x' }, {}).status, 400);
  assert.equal(handleApplyOps({ graph: G, ops: [], baseHash: 'xyz' }, {}).payload.reason, 'invalid-base-hash');
  assert.equal(handleApplyOps(null, {}).status, 400);

  // name 模式：读已导入图 → 应用 → 合法才写回
  const home = path.join(tmp, 'home');
  const doc = { schemaVersion: 1, kind: 'dsh-l2d-nodegraph', name: '测试图', graph: { roots: ['n1'], nodes: [{ id: 'n1', type: 'expression', name: '兔牙', next: [] }] } };
  assert.equal(saveNodegraph(doc, { homeDir: home }).ok, true);
  const got = handleGraphGet('测试图', { homeDir: home, live2dIds: null });
  assert.equal(got.status, 200);
  assert.equal(got.payload.valid, true);
  assert.equal(handleGraphGet('', { homeDir: home }).payload.reason, 'name-required');
  assert.equal(handleGraphGet('无', { homeDir: home }).status, 404);
  const staleByName = handleApplyOps({ name: '测试图', ops: [], baseHash: 'ffffffffffffffff' }, { homeDir: home, live2dIds: null });
  assert.equal(staleByName.status, 409);
  const before = loadNodegraph('测试图', { homeDir: home });
  const badWrite = handleApplyOps({ name: '测试图', ops: [{ op: 'remove_node', id: 'n1' }], baseHash: got.payload.hash }, { homeDir: home, live2dIds: null });
  assert.equal(badWrite.payload.valid, false);
  assert.equal(badWrite.payload.saved, false, '整体不合法不写回');
  assert.equal(loadNodegraph('测试图', { homeDir: home }), before, '原文件一个字节都不动');
  const write = handleApplyOps({
    name: '测试图',
    ops: [{ op: 'add_node', id: 'n2', type: 'look', props: { x: 0.3 } }, { op: 'connect', from: 'n1', to: 'n2' }],
    baseHash: got.payload.hash,
  }, { homeDir: home, live2dIds: null });
  assert.equal(write.payload.saved, true);
  const saved = JSON.parse(loadNodegraph('测试图', { homeDir: home }));
  assert.deepEqual(saved.segments[0].chain.map((s) => s.kind), ['expression', 'look'], '写回后 segments 由编译器重新生成');
  assert.equal(handleGraphGet('测试图', { homeDir: home, live2dIds: null }).payload.hash, write.payload.hash, 'get 与 apply 的 hash 一致');
  assert.deepEqual(editorGraphFromDoc(saved).nodes.map((n) => n.id), ['n1', 'n2'], '读回优先 meta.editor');
}

// ai-edit：503（无 LLM 通道）、预演过滤、不改入参
{
  const unavailable = await handleAiEdit({ graph: G, instruction: '加一个看向左边', lang: 'zh-CN' }, { llm: null, live2dIds: null });
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.payload.reason, 'ai-unavailable');
  assert.equal(unavailable.payload.ops, undefined, '503 不返回任何 ops');
  assert.equal((await handleAiEdit({ graph: G, instruction: '' }, { llm: null })).status, 400);
  assert.equal((await handleAiEdit({ graph: { nodes: 1 }, instruction: 'x' }, { llm: async () => ({ ops: [] }) })).status, 400);

  const snapshot = JSON.stringify(G);
  let seenPrompt = null;
  const fakeLlm = async (prompt) => {
    seenPrompt = prompt;
    return {
      ops: [
        { op: 'add_node', id: 'l1', type: 'look', pos: { x: 1040, y: 0 }, props: { x: -0.6 } },
        { op: 'connect', from: 'm', to: 'l1' },
        { op: 'set_param', id: 'l1', key: 'x', value: 5 },
        { op: 'add_node', id: 'h1', type: 'hitarea' },
      ],
      explanation: 'Added a look-left node.',
    };
  };
  const edited = await handleAiEdit({ graph: G, instruction: '最后看向左边', lang: 'en' }, { llm: fakeLlm, live2dIds: null });
  assert.equal(edited.status, 200);
  assert.deepEqual(edited.payload.ops.map((o) => o.op), ['add_node', 'connect'], '不合法 op 不返回');
  assert.deepEqual(edited.payload.warnings.map((w) => [w.opIndex, w.reason]), [[2, 'param-out-of-range'], [3, 'unknown-node-type']]);
  assert.equal(edited.payload.baseHash, graphHash(G));
  assert.equal(edited.payload.valid, true);
  assert.ok(seenPrompt.system.includes('English'));
  assert.equal(JSON.stringify(G), snapshot, 'ai-edit 不修改入参');
  // 前端确认：baseHash + ops 走 apply-ops 得到与 previewHash 一致的图
  const confirm = handleApplyOps({ graph: G, ops: edited.payload.ops, baseHash: edited.payload.baseHash }, { live2dIds: null });
  assert.equal(confirm.payload.hash, edited.payload.previewHash);

  const broken = await handleAiEdit({ graph: G, instruction: 'x' }, { llm: async () => { throw new Error('HTTP 401'); } });
  assert.equal(broken.status, 502);
  assert.equal(broken.payload.reason, 'ai-failed');
  const noOps = await handleAiEdit({ graph: G, instruction: 'x' }, { llm: async () => ({ text: 'hi' }) });
  assert.equal(noOps.payload.reason, 'ai-bad-response');
}

// ---------------------------------------------------------------------------
// 11) host-guard：图工具白名单与 /ai/call 白名单分开
// ---------------------------------------------------------------------------
{
  assert.deepEqual(
    [...HOST_GRAPH_TOOLS],
    [
      'l2d_graph_get',
      'l2d_graph_apply_ops',
      'l2d_graph_ai_edit',
      'l2d_graph_ai_plan',
      'l2d_graph_search',
      'l2d_nodegraph_import',
      'l2d_nodegraph_run',
      'l2d_nodegraph_status',
      'l2d_nodegraph_cancel',
    ],
  );
  for (const t of HOST_GRAPH_TOOLS) assert.equal(HOST_ALLOWED_TOOLS.includes(t), false, t + ' 不进 /ai/call 队列白名单');
  assert.equal(guardGraphCall({ name: 'l2d_set_form' }).reason, 'unknown-tool');
  assert.equal(guardGraphCall({ name: 'l2d_graph_get', args: { name: 'a' } }).ok, true);
  assert.equal(guardGraphCall({ name: 'l2d_graph_apply_ops', args: { ops: [] } }).ok, true);
  assert.equal(guardGraphCall({ name: 'l2d_graph_apply_ops', args: { ops: new Array(201).fill({}) } }).reason, 'too-many-ops');
  // 执行侧工具（Phase 1）：静态形状守卫
  assert.equal(guardGraphCall({ name: 'l2d_nodegraph_import', args: { doc: { kind: 'dsh-l2d-nodegraph' } } }).ok, true);
  assert.equal(guardGraphCall({ name: 'l2d_nodegraph_import', args: {} }).reason, 'invalid-doc');
  assert.equal(guardGraphCall({ name: 'l2d_nodegraph_import', args: { doc: '{"kind":"x"}' } }).reason, 'invalid-doc', 'doc 必须是对象不是字符串');
  assert.equal(guardGraphCall({ name: 'l2d_nodegraph_import', args: { doc: [1] } }).reason, 'invalid-doc');
  assert.equal(guardGraphCall({ name: 'l2d_nodegraph_run', args: { name: 'greet' } }).ok, true);
  assert.equal(guardGraphCall({ name: 'l2d_nodegraph_run', args: { name: '  ' } }).reason, 'name-required');
  assert.equal(guardGraphCall({ name: 'l2d_nodegraph_status', args: { executionId: 'e-1' } }).ok, true);
  assert.equal(guardGraphCall({ name: 'l2d_nodegraph_status', args: {} }).reason, 'execution-id-required');
  assert.equal(guardGraphCall({ name: 'l2d_nodegraph_cancel', args: { executionId: '' } }).reason, 'execution-id-required');
  // 白名单外工具仍被拒（执行侧新增不改 unknown-tool 语义）
  assert.equal(guardGraphCall({ name: 'l2d_nodegraph_execute' }).reason, 'unknown-tool');
  // 模式互斥语义保持不变：nodegraph 模式拦 LLM 整链编排（l2d_act），执行侧图工具
  // 不在 /ai/call 白名单（不进 aiInbox），guardGraphCall 侧不做模式判定。
  assert.equal(guardAiCall({ name: 'l2d_act', args: { chain: [] } }, { mode: 'nodegraph' }).reason, 'mode-blocked');
  assert.equal(guardAiCall({ name: 'l2d_emote', args: { mood: '开心' } }, { mode: 'nodegraph' }).reason, 'mode-blocked');
  assert.equal(guardGraphCall({ name: 'l2d_nodegraph_run', args: { name: 'greet' } }).ok, true);
}

// ---------------------------------------------------------------------------
// 12) NODE-SCHEMA.json 与代码定义一致（漂移检测）
// ---------------------------------------------------------------------------
execFileSync(process.execPath, [path.join(ROOT, 'tools', 'nodegraph-schema', 'gen.mjs'), '--check'], { stdio: 'pipe' });

fs.rmSync(tmp, { recursive: true, force: true });
console.log('nodegraph-ops tests passed');
