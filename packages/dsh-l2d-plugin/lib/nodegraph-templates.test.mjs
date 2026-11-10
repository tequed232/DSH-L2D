/**
 * 语义模板生成器测试：候选回退匹配 / 缺资源跳过 / strict 绑定 / 幂等与升级重生成 /
 * 与 SPEC 校验器对拍（saveNodegraph 真实落盘）/ poke 固定图名。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SEMANTIC_TEMPLATES, instantiateTemplate, instantiateAllTemplates, ensureModelNodegraphs, pickFirstAvailable, POKE_TEMPLATE_VERSION, POKE_GRAPH_NAME } from './nodegraph-templates.mjs';
import { saveNodegraph, loadNodegraph, validateNodegraph } from './nodegraph.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ngt-'));
}

// 大肥鱼清单（真实目录里的 motions/expressions 抽样，覆盖全部候选命中路径）
const DAFEIYU = {
  params: {},
  motions: ['抚胸手打开', '抚胸手关闭', '竖手指打开', '竖手指关闭', '狗尾巴草打开', '狗尾巴草关闭', 'Idle'],
  expressions: ['兔牙', '加载', '单片眼镜', '圈圈眼', '屑', '流泪', '爱心眼', '脱鞋', '脸红', '钢盆', '裙长切换', '黑框眼镜', '黑脸', '＞＜', '体型1', '体型2', '默认体型', '前倾', '尾巴开关', '流冷汗', '胸口衣服'],
  forms: [0, 1, 2],
};
const MODEL_ID = '大肥鱼.dsl2d.2048';

// ---------------------------------------------------------------------------
// 1) pickFirstAvailable：按优先级回退
// ---------------------------------------------------------------------------
{
  assert.equal(pickFirstAvailable(['兔牙', '圈圈眼'], DAFEIYU.expressions), '兔牙', '第一候选命中');
  assert.equal(pickFirstAvailable(['不存在的', '圈圈眼'], DAFEIYU.expressions), '圈圈眼', '第一候选缺 → 回退第二候选');
  assert.equal(pickFirstAvailable(['A', 'B'], DAFEIYU.expressions), null, '全缺 → null');
  assert.equal(pickFirstAvailable(null, DAFEIYU.expressions), null, 'candidates 非数组 → null');
  assert.equal(pickFirstAvailable(['兔牙'], null), null, '清单缺失 → null');
}

// ---------------------------------------------------------------------------
// 2) instantiateTemplate：poke 实例化（候选命中 + 配对收招 + strict 绑定 + 语义注释）
// ---------------------------------------------------------------------------
{
  const template = SEMANTIC_TEMPLATES.find((t) => t.id === 'poke');
  assert.equal(template.graphName, POKE_GRAPH_NAME, 'poke 固定图名 poke-response');
  const out = instantiateTemplate(template, DAFEIYU, { modelId: MODEL_ID, templateVersion: POKE_TEMPLATE_VERSION });
  assert.equal(out.ok, true, '大肥鱼清单下 poke 应实例化成功');
  const doc = out.doc;
  assert.equal(doc.name, 'poke-response');
  assert.deepEqual(doc.modelBinding, { modelId: MODEL_ID, modelHash: '', bindingMode: 'strict' }, 'strict 绑定模型');
  assert.equal(doc.schemaVersion, 1);
  assert.equal(doc.kind, 'dsh-l2d-nodegraph');
  // 编排：表情 → 动作（配对收招）→ look 回正
  const kinds = doc.graph.nodes.map((n) => n.type);
  assert.deepEqual(kinds, ['expression', 'motion', 'look'], '编排顺序 语义=表情→动作→视线');
  assert.equal(doc.graph.nodes[0].name, '兔牙', '第一表情候选命中');
  assert.equal(doc.graph.nodes[1].name, '狗尾巴草打开', '第一动作候选命中');
  assert.equal(doc.graph.nodes[1].closeMotion, '狗尾巴草关闭', '收招由配对表推导且在清单里');
  assert.equal(doc.graph.roots[0], 'expr', 'roots 指向首节点');
  assert.deepEqual(doc.graph.nodes[2].next, [], '末端 next 为空');
  // meta 语义一致
  assert.equal(doc.meta.templateId, 'poke');
  assert.equal(doc.meta.templateVersion, POKE_TEMPLATE_VERSION);
  assert.ok(doc.meta.editor.note.includes('兔牙'), '语义注释含命中表情');
  assert.ok(doc.meta.editor.note.includes('狗尾巴草'), '语义注释含命中动作');
  assert.equal(doc.meta.semantic, template.semantic);
  assert.ok(out.picks.expression === '兔牙' && out.picks.motion === '狗尾巴草打开');
}

// ---------------------------------------------------------------------------
// 3) instantiateTemplate：候选回退（缺首选 → 次选）
// ---------------------------------------------------------------------------
{
  const catalog = { params: {}, motions: ['竖手指打开', '竖手指关闭'], expressions: ['＞＜'] };
  const template = SEMANTIC_TEMPLATES.find((t) => t.id === 'poke');
  const out = instantiateTemplate(template, catalog, { modelId: 'm' });
  assert.equal(out.ok, true);
  assert.equal(out.doc.graph.nodes[0].name, '＞＜', '表情回退到第二候选');
  assert.equal(out.doc.graph.nodes[1].name, '竖手指打开', '动作回退到第二候选');
  assert.equal(out.doc.graph.nodes[1].closeMotion, '竖手指关闭', '收招命中次选配对');
}

// ---------------------------------------------------------------------------
// 4) instantiateTemplate：缺资源跳过（模型不支持该语义）
// ---------------------------------------------------------------------------
{
  const empty = { params: {}, motions: [], expressions: [] };
  const template = SEMANTIC_TEMPLATES.find((t) => t.id === 'shy');
  const out = instantiateTemplate(template, empty, { modelId: 'm' });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'resources-missing');
  assert.equal(out.missing.length, 2, '表情与动作候选都缺失 → 两行 missing');
  // 只有表情没有动作 → 仍生成（表情 + look）
  const onlyExpr = { params: {}, motions: [], expressions: ['脸红'] };
  const out2 = instantiateTemplate(template, onlyExpr, { modelId: 'm' });
  assert.equal(out2.ok, true);
  assert.deepEqual(out2.doc.graph.nodes.map((n) => n.type), ['expression', 'look'], '缺动作 → 表情+视线两步');
  // 只有动作没有表情 → 仍生成
  const onlyMotion = { params: {}, motions: ['抚胸手打开'], expressions: [] };
  const out3 = instantiateTemplate(template, onlyMotion, { modelId: 'm' });
  assert.equal(out3.ok, true);
  assert.deepEqual(out3.doc.graph.nodes.map((n) => n.type), ['motion', 'look']);
}

// ---------------------------------------------------------------------------
// 5) instantiateAllTemplates：清单缺失全跳过；大肥鱼全命中
// ---------------------------------------------------------------------------
{
  const none = instantiateAllTemplates(null, { modelId: MODEL_ID });
  assert.equal(none.docs.length, 0, '清单缺失 → 全部跳过，绝不编造资源名');
  assert.equal(none.skipped.length, SEMANTIC_TEMPLATES.length, '跳过数=模板数');
  const full = instantiateAllTemplates(DAFEIYU, { modelId: MODEL_ID });
  assert.equal(full.docs.length, SEMANTIC_TEMPLATES.length, '大肥鱼清单全命中');
  assert.deepEqual(full.skipped, []);
}

// ---------------------------------------------------------------------------
// 6) 与 SPEC 校验器对拍：saveNodegraph 真实落盘成功（编译 + 白名单校验全过）
// ---------------------------------------------------------------------------
{
  const home = tmpHome();
  const full = instantiateAllTemplates(DAFEIYU, { modelId: MODEL_ID });
  for (const doc of full.docs) {
    const saved = saveNodegraph(doc, { homeDir: home, allowed: { expressions: new Set(DAFEIYU.expressions), motionGroups: new Set(DAFEIYU.motions) } });
    assert.equal(saved.ok, true, doc.name + ' 应通过整体校验并落盘');
    const raw = loadNodegraph(doc.name, { homeDir: home });
    assert.ok(raw, doc.name + ' 落盘可读回');
    const back = JSON.parse(raw);
    const checked = validateNodegraph(back);
    assert.equal(checked.ok, true, doc.name + ' 回读后再次校验通过');
    assert.ok(back.segments.length >= 1, doc.name + ' 编译出可执行 segments');
    assert.equal(back.segments[0].chain[0].name, back.graph.nodes[0].name, 'segments 首步与图首节点同源');
    assert.equal(back.meta.templateId, doc.meta.templateId, 'meta.templateId 落盘保留');
  }
  const pokeDoc = JSON.parse(loadNodegraph('poke-response', { homeDir: home }));
  assert.equal(pokeDoc.modelBinding.modelId, MODEL_ID, 'poke-response strict 绑定当前模型');
}

// ---------------------------------------------------------------------------
// 7) ensureModelNodegraphs：生成 → 幂等跳过 → 版本升级重生成
// ---------------------------------------------------------------------------
{
  const home = tmpHome();
  // 7a 首次：全部生成
  const first = ensureModelNodegraphs(MODEL_ID, { homeDir: home, modelsDir: null, globalFile: null, templateVersion: POKE_TEMPLATE_VERSION });
  assert.equal(first.ok, true, '首跑 ok');
  assert.deepEqual(first.generated.sort(), SEMANTIC_TEMPLATES.map((t) => t.graphName).sort(), '全部生成');
  assert.deepEqual(first.unchanged, [], '无跳过');
  assert.deepEqual(first.failed, [], '无失败');
  // ensureModelNodegraphs 不带 modelsDir 时走仓库真实清单目录：大肥鱼真实存在 → catalogSource=model
  assert.equal(first.catalogSource, 'model');
  // 7b 二次：全部 unchanged（幂等，不覆盖）
  const second = ensureModelNodegraphs(MODEL_ID, { homeDir: home, modelsDir: null, globalFile: null, templateVersion: POKE_TEMPLATE_VERSION });
  assert.equal(second.ok, true);
  assert.deepEqual(second.generated, [], '二次不生成');
  assert.deepEqual(second.regenerated, [], '二次不重生成');
  assert.deepEqual(second.unchanged.sort(), SEMANTIC_TEMPLATES.map((t) => t.graphName).sort(), '二次全部跳过');
  // 7c 用户手改保留：改掉 poke-response 的表情后重跑同版本 → 不被覆盖
  const pokeFile = loadNodegraph('poke-response', { homeDir: home });
  const edited = JSON.parse(pokeFile);
  // segments 是执行真源：手改要同时落 graph 与 segments（编辑器保存路径同样如此）
  edited.graph.nodes[0].name = '脸红';
  edited.segments[0].chain[0].name = '脸红';
  const savedAgain = saveNodegraph(edited, { homeDir: home, allowed: { expressions: new Set(DAFEIYU.expressions), motionGroups: new Set(DAFEIYU.motions) } });
  assert.equal(savedAgain.ok, true, '手改保存成功');
  const third = ensureModelNodegraphs(MODEL_ID, { homeDir: home, modelsDir: null, globalFile: null, templateVersion: POKE_TEMPLATE_VERSION });
  assert.ok(third.unchanged.includes('poke-response'), '同版本幂等跳过');
  assert.equal(JSON.parse(loadNodegraph('poke-response', { homeDir: home })).graph.nodes[0].name, '脸红', '用户手改保留');
  // 7d 版本升级：templateVersion=2 → 重生成（升级策略）
  const upgraded = ensureModelNodegraphs(MODEL_ID, { homeDir: home, modelsDir: null, globalFile: null, templateVersion: POKE_TEMPLATE_VERSION + 1 });
  assert.deepEqual(upgraded.regenerated.sort(), SEMANTIC_TEMPLATES.map((t) => t.graphName).sort(), '升级 → 全部重生成');
  assert.equal(JSON.parse(loadNodegraph('poke-response', { homeDir: home })).meta.templateVersion, POKE_TEMPLATE_VERSION + 1, 'meta.templateVersion 已升版');
  assert.equal(JSON.parse(loadNodegraph('poke-response', { homeDir: home })).graph.nodes[0].name, '兔牙', '升级后按新模板重写（覆盖手改，升级策略如实报告）');
  // 7e 图版本比代码新 → 不降级
  const downgraded = ensureModelNodegraphs(MODEL_ID, { homeDir: home, modelsDir: null, globalFile: null, templateVersion: 1 });
  assert.ok(downgraded.unchanged.includes('poke-response'), '图版本更新 → 不降级');
}

// ---------------------------------------------------------------------------
// 8) ensureModelNodegraphs：非法/缺失 modelId
// ---------------------------------------------------------------------------
{
  assert.deepEqual(ensureModelNodegraphs('', {}), { ok: false, reason: 'no-model', modelId: '' });
  assert.deepEqual(ensureModelNodegraphs('../evil', {}), { ok: false, reason: 'unsafe-model-id', modelId: '../evil' });
}

// ---------------------------------------------------------------------------
// 9) ensureModelNodegraphs：无清单模型 → 全跳过不落盘
// ---------------------------------------------------------------------------
{
  const home = tmpHome();
  const out = ensureModelNodegraphs('no-such-model', {
    home,
    modelsDir: path.join(home, 'models-dir'),
    globalFile: path.join(home, 'missing-global.json'),
    templateVersion: POKE_TEMPLATE_VERSION,
  });
  assert.equal(out.ok, true);
  assert.deepEqual(out.generated, [], '无清单 → 不生成任何图');
  assert.equal(out.catalogSource, 'none');
  assert.equal(out.skipped.length, SEMANTIC_TEMPLATES.length, '全部按 resources-missing 跳过');
}

console.log('nodegraph-templates.test.mjs: all assertions passed');
