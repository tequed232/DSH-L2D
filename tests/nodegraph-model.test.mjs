/**
 * 按单个模型编辑动作链（2026-11-10 统一约定）测试：
 *   - 每个模型读到自己的 live2d-ids.json 清单（docs/nodegraph/models/<modelId>/）；
 *   - 无清单回退全局 + model-catalog-missing 告警；
 *   - modelId 路径安全：拦 ../ 与路径分隔符，单个点（demo.model.b / 大肥鱼.dsl2d.2048）放行；
 *   - 整图校验按「静态 ∪ 该模型清单」注入 allowed（清单专属表情可过校验）；
 *   - strict 绑定模型不一致 → 409 model-mismatch 且一个动作都不发（注册表零 running 记录）；
 *   - any 模式照旧执行 + warning 字段；
 *   - GET graph 不带 name + ?model= 过滤列表（any 图列出但标记）；
 *   - apply-ops / ai-edit 按图绑定模型（或显式 modelId）选清单校验；
 *   - 新建图默认 strict 绑定（docFromEditorGraph defaultBinding）。
 *
 * 清单 fixture 全部用中性名（demo-model / demo.model.b），不含真实模型数据；
 * Smile / Blink / GlobalExp 是清单专属 ID（不在静态白名单里），专门用来证明 allowed 注入生效。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  allowedFromLive2dIds,
  isSafeModelId,
  loadLive2dIdsForModel,
  resolveModelIdsFile,
} from '../packages/dsh-l2d-plugin/lib/nodegraph-schema.mjs';
import { handleApplyOps, handleAiEdit, handleCatalog, handleGraphGet } from '../packages/dsh-l2d-plugin/lib/nodegraph-api.mjs';
import { applyOps, docFromEditorGraph } from '../packages/dsh-l2d-plugin/lib/nodegraph-ops.mjs';
import {
  checkRunModelBinding,
  evaluateModelBinding,
  runNodegraph,
  saveNodegraph,
  writeMotionMode,
} from '../packages/dsh-l2d-plugin/lib/nodegraph.mjs';
import { createRunRegistry } from '../packages/dsh-l2d-plugin/lib/nodegraph-runs.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'nodegraph-model-fixtures');
const MODELS_DIR = path.join(FIXTURES, 'models');
const GLOBAL_FILE = path.join(FIXTURES, 'global', 'live2d-ids.json');

/** 统一 deps：fixture 目录 + 可注入当前模型。 */
const withDeps = (extra = {}) => ({
  modelsDir: MODELS_DIR,
  globalFile: GLOBAL_FILE,
  ...extra,
});

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-l2d-nodegraph-model-'));
}

function clean(file) {
  try { fs.rmSync(file, { recursive: true, force: true }); } catch { /* ignore */ }
}

/** 独立缓存（避免跨用例互相污染 mtime 缓存）。 */
const freshCache = () => new Map();

/** 执行层最小图（导入/运行用；脸红在静态名单里，任何模型都能过基础校验）。 */
const execGraph = () => ({ roots: ['a'], nodes: [{ id: 'a', type: 'expression', name: '脸红', next: [] }] });

// ---------------------------------------------------------------------------
// 1) modelId 路径安全：拦 ../ 与路径分隔符，单个点放行
// ---------------------------------------------------------------------------
{
  assert.equal(isSafeModelId('demo-model'), true, '普通名放行');
  assert.equal(isSafeModelId('demo.model'), true, '单个点放行');
  assert.equal(isSafeModelId('demo.model.b'), true, '多个单点放行');
  assert.equal(isSafeModelId('大肥鱼.dsl2d.2048'), true, '真实 modelId（带点）放行');
  assert.equal(isSafeModelId('../evil'), false, '../ 拒绝');
  assert.equal(isSafeModelId('a/b'), false, '斜杠拒绝');
  assert.equal(isSafeModelId('a\\b'), false, '反斜杠拒绝');
  assert.equal(isSafeModelId('..'), false, '纯 .. 拒绝');
  assert.equal(isSafeModelId('a..b'), false, '内嵌 .. 拒绝');
  assert.equal(isSafeModelId(''), false, '空串拒绝');
  assert.throws(() => resolveModelIdsFile('../evil'), '不安全 modelId 拼路径必须抛错');
  console.log('ok 1 路径安全');
}

// ---------------------------------------------------------------------------
// 2) 每个模型读到自己的清单；无清单回退全局 + model-catalog-missing
// ---------------------------------------------------------------------------
{
  const a = loadLive2dIdsForModel('demo-model', { modelsDir: MODELS_DIR, globalFile: GLOBAL_FILE, cache: freshCache() });
  assert.equal(a.source, 'model');
  assert.ok(a.ids);
  assert.deepEqual(a.ids.motions, ['Wave', '竖手指打开'], 'demo-model 用自己的动作组');
  assert.deepEqual(a.ids.expressions, ['Smile', '脸红']);
  assert.equal(a.warning, undefined, '有清单无告警');

  const b = loadLive2dIdsForModel('demo.model.b', { modelsDir: MODELS_DIR, globalFile: GLOBAL_FILE, cache: freshCache() });
  assert.equal(b.source, 'model');
  assert.deepEqual(b.ids.motions, ['Nod', '竖手指打开'], 'demo.model.b（单点）用自己的清单');
  assert.deepEqual(b.ids.expressions, ['Blink', '兔牙']);

  const miss = loadLive2dIdsForModel('ghost-model', { modelsDir: MODELS_DIR, globalFile: GLOBAL_FILE, cache: freshCache() });
  assert.equal(miss.source, 'global', '缺清单回退全局');
  assert.equal(miss.warning, 'model-catalog-missing');
  assert.deepEqual(miss.ids.motions, ['GlobalMove', '竖手指打开'], '回退后拿到全局清单');

  const none = loadLive2dIdsForModel('ghost-model', { modelsDir: MODELS_DIR, globalFile: path.join(FIXTURES, 'nope.json'), cache: freshCache() });
  assert.equal(none.source, 'none');
  assert.equal(none.ids, null, '全局也没有 → ids null，走通用校验不报错');
  assert.equal(none.warning, 'model-catalog-missing');

  // 不存在的 modelsDir 下真实 modelId（带点）不抛，只是回退
  const safe = loadLive2dIdsForModel('大肥鱼.dsl2d.2048', { modelsDir: path.join(FIXTURES, 'empty'), globalFile: GLOBAL_FILE, cache: freshCache() });
  assert.equal(safe.source, 'global');
  console.log('ok 2 per-model 清单 + 回退');
}

// ---------------------------------------------------------------------------
// 3) mtime 缓存：文件内容变化后重读生效
// ---------------------------------------------------------------------------
{
  const dir = path.join(FIXTURES, 'cache-probe');
  fs.mkdirSync(path.join(dir, 'probe.model'), { recursive: true });
  const file = path.join(dir, 'probe.model', 'live2d-ids.json');
  fs.writeFileSync(file, JSON.stringify({ motions: ['V1'] }));
  const opts = { modelsDir: dir, globalFile: GLOBAL_FILE, cache: freshCache() };
  const first = loadLive2dIdsForModel('probe.model', opts);
  assert.deepEqual(first.ids.motions, ['V1']);
  // 改内容并把 mtime 推到未来，确保缓存失效路径被触发
  fs.writeFileSync(file, JSON.stringify({ motions: ['V2'] }));
  const at = new Date(Date.now() + 5000);
  fs.utimesSync(file, at, at);
  const second = loadLive2dIdsForModel('probe.model', opts);
  assert.deepEqual(second.ids.motions, ['V2'], 'mtime 变化后缓存失效重读');
  clean(dir);
  console.log('ok 3 mtime 缓存失效');
}

// ---------------------------------------------------------------------------
// 4) evaluateModelBinding / checkRunModelBinding / runNodegraph 运行时强制
// ---------------------------------------------------------------------------
{
  // 纯函数裁决
  const mismatch = evaluateModelBinding({ modelId: 'demo-model', bindingMode: 'strict' }, 'demo.model.b');
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.reason, 'model-mismatch');
  assert.equal(mismatch.expected, 'demo-model');
  assert.equal(mismatch.actual, 'demo.model.b');

  const strictOk = evaluateModelBinding({ modelId: 'demo-model', bindingMode: 'strict' }, 'demo-model');
  assert.equal(strictOk.ok, true);
  assert.equal(strictOk.warning, undefined);

  const hashOnly = evaluateModelBinding({ modelHash: 'abc', bindingMode: 'strict' }, 'demo-model');
  assert.equal(hashOnly.ok, true, 'strict 只有 modelHash 无法比对 → 放行');

  const anyMismatch = evaluateModelBinding({ modelId: 'demo-model', bindingMode: 'any' }, 'demo.model.b');
  assert.equal(anyMismatch.ok, true, 'any 不一致照旧放行');
  assert.equal(anyMismatch.warning, 'model-mismatch');

  const anyPlain = evaluateModelBinding({ bindingMode: 'any' }, 'demo-model');
  assert.equal(anyPlain.ok, true);
  assert.equal(anyPlain.warning, undefined, 'any 未绑模型无告警');

  // run 通道闸门 + 注册表零污染
  const home = tempHome();
  try {
    const saved = saveNodegraph(
      { schemaVersion: 1, kind: 'dsh-l2d-nodegraph', name: 'g-strict', modelBinding: { modelId: 'demo-model', bindingMode: 'strict' }, graph: execGraph() },
      { homeDir: home },
    );
    assert.equal(saved.ok, true);

    const gate = checkRunModelBinding('g-strict', { homeDir: home, currentModelId: 'demo.model.b' });
    assert.equal(gate.ok, false);
    assert.equal(gate.status, 409);
    assert.equal(gate.reason, 'model-mismatch');

    // 模拟路由顺序：闸门失败 → 不调用 registry.begin（409 直接返回，注册表零记录）
    const registry = createRunRegistry();
    if (gate.ok) registry.begin('x', 'g-strict');
    assert.deepEqual(registry.list(), [], 'strict 失败时注册表无任何 running 记录');

    const gateOk = checkRunModelBinding('g-strict', { homeDir: home, currentModelId: 'demo-model' });
    assert.equal(gateOk.ok, true);

    const gateMissing = checkRunModelBinding('no-such-graph', { homeDir: home, currentModelId: 'demo-model' });
    assert.equal(gateMissing.ok, true, '图缺失放行（后续 404 由 runNodegraph 负责）');

    // runNodegraph 纵深防御：strict 不匹配 → 409，execute 一次都不调
    let calls = 0;
    const executor = async () => { calls += 1; return { ok: true, accepted: true, outcome: 'completed', settled: true, events: [] }; };
    writeMotionMode('nodegraph', { homeDir: home });
    const result = await runNodegraph('g-strict', executor, { homeDir: home, currentModelId: 'demo.model.b' });
    assert.equal(result.ok, false);
    assert.equal(result.status, 409);
    assert.equal(result.reason, 'model-mismatch');
    assert.equal(calls, 0, '一个动作都没发');

    // any + 不匹配 → 照旧执行 + warning
    saveNodegraph(
      { schemaVersion: 1, kind: 'dsh-l2d-nodegraph', name: 'g-any', modelBinding: { modelId: 'demo-model', bindingMode: 'any' }, graph: execGraph() },
      { homeDir: home },
    );
    const anyResult = await runNodegraph('g-any', executor, { homeDir: home, currentModelId: 'demo.model.b' });
    assert.equal(anyResult.ok, true, 'any 模式照旧执行');
    assert.deepEqual(anyResult.warning, { reason: 'model-mismatch', expected: 'demo-model', actual: 'demo.model.b' });
    assert.equal(calls, 1, 'any 模式确实执行了');
  } finally {
    clean(home);
  }
  console.log('ok 4 运行时绑定强制');
}

// ---------------------------------------------------------------------------
// 5) handleGraphGet ?model= 过滤列表 + 按图绑定模型回执
// ---------------------------------------------------------------------------
{
  const home = tempHome();
  try {
    // mk 模拟导入路由：按图绑定模型注入 allowed（静态 ∪ 该模型清单）
    const mk = (name, binding, graph) => {
      const allowed = allowedFromLive2dIds(
        loadLive2dIdsForModel(binding && binding.modelId ? binding.modelId : 'demo-model', {
          modelsDir: MODELS_DIR, globalFile: GLOBAL_FILE, cache: freshCache(),
        }).ids,
      );
      return saveNodegraph({ schemaVersion: 1, kind: 'dsh-l2d-nodegraph', name, modelBinding: binding, graph: graph || execGraph() }, { homeDir: home, allowed });
    };
    assert.equal(mk('g-a', { modelId: 'demo-model', bindingMode: 'strict' }).ok, true);
    assert.equal(mk('g-b', { modelId: 'demo.model.b', bindingMode: 'strict' }).ok, true);
    assert.equal(mk('g-any', { bindingMode: 'any' }).ok, true);
    // 清单专属表情（Smile 不在静态名单）：证明整图校验按「静态 ∪ 该模型清单」放行
    const smileGraph = { roots: ['a'], nodes: [{ id: 'a', type: 'expression', name: 'Smile', next: [] }] };
    assert.equal(mk('g-smile', { modelId: 'demo-model', bindingMode: 'strict' }, smileGraph).ok, true, 'allowed 注入后清单专属表情可导入');

    const out = handleGraphGet('', { homeDir: home, listModel: 'demo-model' });
    assert.equal(out.status, 200);
    assert.equal(out.payload.ok, true);
    const names = out.payload.items.map((i) => i.name).sort();
    assert.deepEqual(names, ['g-a', 'g-any', 'g-smile'], 'strict 匹配 + any 图列出，绑定其它模型的不列');
    const gA = out.payload.items.find((i) => i.name === 'g-a');
    const gAny = out.payload.items.find((i) => i.name === 'g-any');
    assert.equal(gA.matches, true, 'strict 匹配标记 matches:true');
    assert.equal(gAny.matches, false, 'any 图列出但标记 matches:false');
    assert.equal(out.payload.model, 'demo-model');

    // 带 name：按图绑定模型回执
    const single = handleGraphGet('g-a', withDeps({ homeDir: home, getCurrentModelId: () => 'demo-model' }));
    assert.equal(single.status, 200);
    assert.equal(single.payload.name, 'g-a');
    assert.equal(single.payload.modelId, 'demo-model', '按图绑定模型回执');
    assert.equal(single.payload.live2dIds, 'loaded');
    assert.equal(single.payload.live2dIdsSource, 'model');
    assert.equal(single.payload.valid, true);

    // 图绑定优先于当前模型（当前 ghost-model 也不影响）
    const b = handleGraphGet('g-b', withDeps({ homeDir: home, getCurrentModelId: () => 'ghost-model' }));
    assert.equal(b.payload.modelId, 'demo.model.b', '图绑定优先于当前模型');
    assert.equal(b.payload.catalogWarning, undefined, 'demo.model.b 有自己的清单，无告警');

    // 图绑定模型没清单 → 回退全局 + 告警
    assert.equal(mk('g-fb', { modelId: 'ghost-model', bindingMode: 'strict' }).ok, true);
    const fb = handleGraphGet('g-fb', withDeps({ homeDir: home, getCurrentModelId: () => 'demo-model' }));
    assert.equal(fb.payload.modelId, 'ghost-model');
    assert.equal(fb.payload.catalogWarning, 'model-catalog-missing', '绑定模型缺清单 → 回退全局 + 告警');
    assert.equal(fb.payload.live2dIdsSource, 'global');

    // 无 name 无 model → 既有 400 行为
    const bad = handleGraphGet('', { homeDir: home });
    assert.equal(bad.status, 400);
    assert.equal(bad.payload.reason, 'name-required');
    assert.ok(Array.isArray(bad.payload.names));
  } finally {
    clean(home);
  }
  console.log('ok 5 ?model= 过滤列表');
}

// ---------------------------------------------------------------------------
// 6) apply-ops 按图绑定模型选清单（显式 modelId > 图绑定 > 当前模型）
// ---------------------------------------------------------------------------
{
  const home = tempHome();
  try {
    const saved = saveNodegraph(
      { schemaVersion: 1, kind: 'dsh-l2d-nodegraph', name: 'g-ops', modelBinding: { modelId: 'demo-model', bindingMode: 'strict' }, graph: execGraph() },
      { homeDir: home },
    );
    assert.equal(saved.ok, true);

    // byName：图绑定 demo-model → Smile（demo-model 清单专属）合法
    const okSmile = handleApplyOps(
      { name: 'g-ops', ops: [{ op: 'set_param', id: 'a', key: 'name', value: 'Smile' }] },
      withDeps({ homeDir: home, getCurrentModelId: () => 'demo.model.b' }),
    );
    assert.equal(okSmile.payload.ok, true, '按图绑定模型的清单校验（含清单专属 ID + allowed 注入）');
    assert.equal(okSmile.payload.modelId, 'demo-model');
    assert.equal(okSmile.payload.live2dIdsSource, 'model');
    assert.equal(okSmile.payload.saved, true);

    // 别的模型的表情被拒（op 级 unknown-live2d-id）
    const badBlink = handleApplyOps(
      { name: 'g-ops', ops: [{ op: 'set_param', id: 'a', key: 'name', value: 'Blink' }] },
      withDeps({ homeDir: home, getCurrentModelId: () => 'demo-model' }),
    );
    assert.equal(badBlink.payload.ok, false, '其它模型的表情被拒');
    assert.equal(badBlink.payload.errors[0].reason, 'unknown-live2d-id');

    // 谁的清单里都没有 → 拒
    const badAny = handleApplyOps(
      { name: 'g-ops', ops: [{ op: 'set_param', id: 'a', key: 'name', value: 'NoSuchExp' }] },
      withDeps({ homeDir: home, getCurrentModelId: () => 'demo-model' }),
    );
    assert.equal(badAny.payload.ok, false);
    assert.equal(badAny.payload.errors[0].reason, 'unknown-live2d-id');

    // 显式 modelId 覆盖图绑定：Blink 是 demo.model.b 清单专属
    const override = handleApplyOps(
      { name: 'g-ops', ops: [{ op: 'set_param', id: 'a', key: 'name', value: 'Blink' }], modelId: 'demo.model.b' },
      withDeps({ homeDir: home, getCurrentModelId: () => 'demo-model' }),
    );
    assert.equal(override.payload.ok, true, '显式 modelId 覆盖图绑定');
    assert.equal(override.payload.modelId, 'demo.model.b');

    // graph 模式（无 name）：图没绑 → 当前模型
    const graphMode = handleApplyOps(
      { graph: applyOps({ nodes: [], edges: [] }, [{ op: 'add_node', id: 'x', type: 'expression' }]).graph, ops: [{ op: 'set_param', id: 'x', key: 'name', value: 'Smile' }] },
      withDeps({ getCurrentModelId: () => 'demo-model' }),
    );
    assert.equal(graphMode.payload.ok, true, 'graph 模式用当前模型清单');
    assert.equal(graphMode.payload.modelId, 'demo-model');

    // graph 模式缺清单 → 回退全局 + 告警（GlobalExp 是全局清单专属）
    const fb = handleApplyOps(
      { graph: applyOps({ nodes: [], edges: [] }, [{ op: 'add_node', id: 'x', type: 'expression' }]).graph, ops: [{ op: 'set_param', id: 'x', key: 'name', value: 'GlobalExp' }] },
      withDeps({ getCurrentModelId: () => 'ghost-model' }),
    );
    assert.equal(fb.payload.ok, true, '回退全局清单后 GlobalExp 合法');
    assert.equal(fb.payload.catalogWarning, 'model-catalog-missing');
  } finally {
    clean(home);
  }
  console.log('ok 6 apply-ops 按模型选清单');
}

// ---------------------------------------------------------------------------
// 7) handleCatalog：唯一目录接口
// ---------------------------------------------------------------------------
{
  const deps = withDeps({ getCurrentModelId: () => 'demo-model' });
  const ok = handleCatalog('demo-model', deps);
  assert.equal(ok.status, 200);
  assert.equal(ok.payload.modelId, 'demo-model');
  assert.equal(ok.payload.source, 'model');
  assert.deepEqual(ok.payload.catalog.motions, ['Wave', '竖手指打开']);
  assert.deepEqual(ok.payload.catalog.expressions, ['Smile', '脸红']);
  assert.deepEqual(ok.payload.catalog.forms, [0, 1]);

  const fb = handleCatalog('ghost-model', deps);
  assert.equal(fb.status, 200);
  assert.equal(fb.payload.source, 'global');
  assert.equal(fb.payload.warning, 'model-catalog-missing');

  const cur = handleCatalog('', deps);
  assert.equal(cur.payload.modelId, 'demo-model', '不传 model 用当前模型');

  const evil = handleCatalog('../evil', deps);
  assert.equal(evil.status, 400);
  assert.equal(evil.payload.reason, 'invalid-model-id');

  const noModel = handleCatalog('', { modelsDir: MODELS_DIR });
  assert.equal(noModel.status, 404);
  assert.equal(noModel.payload.reason, 'no-model');
  console.log('ok 7 catalog 接口');
}

// ---------------------------------------------------------------------------
// 8) 新建图默认 strict 绑定（docFromEditorGraph defaultBinding）
// ---------------------------------------------------------------------------
{
  const g = applyOps({ nodes: [], edges: [] }, [{ op: 'add_node', id: 'e', type: 'expression' }]).graph;
  const withDefault = docFromEditorGraph(g, { name: 'n1' }, { defaultBinding: { modelId: 'demo-model', bindingMode: 'strict' } });
  assert.deepEqual(withDefault.modelBinding, { modelId: 'demo-model', modelHash: '', bindingMode: 'strict' });

  const withoutDefault = docFromEditorGraph(g, { name: 'n1' });
  assert.deepEqual(withoutDefault.modelBinding, { bindingMode: 'any' }, '未提供 defaultBinding 照旧 any');

  const oldGraph = docFromEditorGraph(g, { name: 'n1', modelBinding: { modelId: 'legacy', bindingMode: 'any' } }, { defaultBinding: { modelId: 'demo-model', bindingMode: 'strict' } });
  assert.deepEqual(oldGraph.modelBinding, { modelId: 'legacy', bindingMode: 'any' }, '旧图已有绑定不迁移');
  console.log('ok 8 新图默认 strict 绑定');
}

// ---------------------------------------------------------------------------
// 9) ai-edit 按模型选清单（提示词与预演同源）+ 显式 modelId
// ---------------------------------------------------------------------------
{
  const graph = applyOps({ nodes: [], edges: [] }, [{ op: 'add_node', id: 'e', type: 'expression' }]).graph;
  // llm 缺失 → 503（不伪造结果），但路径上已经选定了模型清单
  const out = await handleAiEdit(
    { graph, instruction: '把表情换成 Smile', modelId: 'demo-model' },
    withDeps({}),
  );
  assert.equal(out.status, 503);
  assert.equal(out.payload.reason, 'ai-unavailable');

  // 假 LLM：验证提示词里带的是该模型清单（Smile 在列、Blink 不在列）
  let captured = null;
  const fakeLlm = async (prompt) => {
    captured = prompt;
    return { ops: [], explanation: '无改动' };
  };
  const out2 = await handleAiEdit(
    { graph, instruction: '看看清单' },
    withDeps({ llm: fakeLlm, getCurrentModelId: () => 'demo-model' }),
  );
  assert.equal(out2.status, 200);
  assert.equal(out2.payload.modelId, 'demo-model');
  assert.ok(captured, 'llm 被调用');
  const systemText = typeof captured.system === 'string' ? captured.system : JSON.stringify(captured.system);
  assert.ok(systemText.includes('"Smile"'), '提示词嵌入该模型表情清单');
  assert.ok(!systemText.includes('"Blink"'), '不混入其它模型的表情');
  console.log('ok 9 ai-edit 按模型清单');
}

// ---------------------------------------------------------------------------
// 10) 真实生成目录（本机已跑三模型；存在时冒烟验证，不依赖 CI 环境）
// ---------------------------------------------------------------------------
{
  const realFile = resolveModelIdsFile('大肥鱼.dsl2d.2048');
  if (fs.existsSync(realFile)) {
    const real = loadLive2dIdsForModel('大肥鱼.dsl2d.2048');
    assert.equal(real.source, 'model');
    assert.ok(real.ids.motions.includes('竖手指打开'), '真实清单含大肥鱼动作组');
    assert.ok(real.ids.expressions.includes('脸红'), '真实清单含大肥鱼表情');
    assert.ok(real.ids.params.ParamMouthOpenY, '真实清单含口型参数量程');
    console.log('ok 10 真实大肥鱼清单冒烟');
  } else {
    console.log('skip 10 真实清单未生成（docs/nodegraph/models/ 本地产物）');
  }
}

console.log('nodegraph-model tests passed');
