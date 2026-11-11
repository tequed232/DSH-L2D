/**
 * nodegraph-planner 测试：AI 动作链规划器（Phase 2）。
 * 覆盖：静态守卫 / 非法入参 / 503 ai-unavailable / 502 ai-bad-response /
 * 成功创建并落盘（strict 绑定 + 文件可读回）/ 409 name-exists / 422 plan-invalid /
 * 垃圾 op 跳过降级 warnings / no-model。LLM 全部注入假函数，不联网。
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleAiPlan, aiPlan, buildAiPlanPrompt } from './nodegraph-planner.mjs';
import { loadNodegraph } from './nodegraph.mjs';
import { guardGraphCall, HOST_GRAPH_TOOLS } from './host-guard.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-planner-'));
const homeDir = path.join(tmpRoot, 'home');
fs.mkdirSync(homeDir, { recursive: true });

/** 合法链 ops：trigger → expression(脸红) → motion(抚胸手打开，带配对收招) */
function planOps() {
  return [
    { op: 'add_node', id: 't', type: 'trigger', pos: { x: 0, y: 0 } },
    { op: 'add_node', id: 'e', type: 'expression', pos: { x: 260, y: 0 }, props: { name: '脸红' } },
    { op: 'add_node', id: 'm', type: 'motion', pos: { x: 520, y: 0 }, props: { name: '抚胸手打开', closeMotion: '抚胸手关闭', closeAfterMs: 3000 } },
    { op: 'connect', from: 't', to: 'e' },
    { op: 'connect', from: 'e', to: 'm' },
  ];
}
const fakeLlm = () => Promise.resolve({ ops: planOps(), explanation: '害羞链：脸红后抚胸' });
const deps = (llm, extra = {}) => ({ llm, getCurrentModelId: () => '测试模型', homeDir, ...extra });

// ---------------------------------------------------------------------------
// 1) 静态守卫与白名单
// ---------------------------------------------------------------------------
{
  assert.ok(HOST_GRAPH_TOOLS.includes('l2d_graph_ai_plan'), 'ai_plan 必须在图工具白名单里');
  assert.equal(guardGraphCall({ name: 'l2d_graph_ai_plan', args: {} }).reason, 'name-required');
  assert.equal(guardGraphCall({ name: 'l2d_graph_ai_plan', args: { name: 'a' } }).reason, 'invalid-request');
  assert.equal(guardGraphCall({ name: 'l2d_graph_ai_plan', args: { name: 'a', instruction: 'x' } }).ok, true);
  const out = await handleAiPlan({ instruction: 'x' }, deps(fakeLlm));
  assert.equal(out.status, 400);
  assert.equal(out.payload.reason, 'name-required');
  console.log('ok 1 静态守卫与白名单');
}

// ---------------------------------------------------------------------------
// 2) 非法 name / no-model
// ---------------------------------------------------------------------------
{
  const bad1 = await handleAiPlan({ name: '...', instruction: '害羞' }, deps(fakeLlm));
  assert.equal(bad1.status, 400);
  assert.equal(bad1.payload.reason, 'invalid-name');
  // 路径穿越名字被清洗为安全文件名（'../escape' → '_escape'），不拒绝但也不落盘到目录外
  const cleaned = await handleAiPlan({ name: '../escape', instruction: '害羞' }, deps(fakeLlm));
  assert.equal(cleaned.status, 200);
  assert.equal(cleaned.payload.name, '_escape');
  assert.ok(loadNodegraph('_escape', { homeDir }) !== null, '清洗名应落盘');
  assert.ok(!fs.existsSync(path.join(homeDir, 'escape.json')) && !fs.existsSync(path.join(homeDir, '..', 'escape.json')), '不得逃逸出图目录');
  const bad2 = await handleAiPlan({ name: 'ok-name', instruction: '害羞' }, { llm: fakeLlm, homeDir, getCurrentModelId: () => '' });
  assert.equal(bad2.status, 400);
  assert.equal(bad2.payload.reason, 'no-model');
  console.log('ok 2 非法 name / no-model');
}

// ---------------------------------------------------------------------------
// 3) 503 ai-unavailable（不伪造结果）
// ---------------------------------------------------------------------------
{
  const out = await handleAiPlan({ name: 'no-llm', instruction: '害羞' }, deps(null));
  assert.equal(out.status, 503);
  assert.equal(out.payload.reason, 'ai-unavailable');
  assert.equal(loadNodegraph('no-llm', { homeDir }), null, '503 时不得落盘');
  console.log('ok 3 503 ai-unavailable');
}

// ---------------------------------------------------------------------------
// 4) 成功创建并落盘（strict 绑定 + 可读回 + 编译链完整）
// ---------------------------------------------------------------------------
{
  const out = await handleAiPlan({ name: 'shy-plan', instruction: '主人摸头后害羞，脸红然后抚胸' }, deps(fakeLlm));
  assert.equal(out.status, 200);
  assert.equal(out.payload.ok, true);
  assert.equal(out.payload.saved, true);
  assert.equal(out.payload.name, 'shy-plan');
  assert.equal(out.payload.modelId, '测试模型');
  assert.equal(out.payload.nodeCount, 3);
  assert.equal(out.payload.explanation, '害羞链：脸红后抚胸');
  const raw = loadNodegraph('shy-plan', { homeDir });
  assert.ok(typeof raw === 'string' && raw.length > 0, '落盘文件必须可读回');
  const doc = JSON.parse(raw);
  assert.equal(doc.kind, 'dsh-l2d-nodegraph');
  assert.equal(doc.modelBinding.bindingMode, 'strict');
  assert.equal(doc.modelBinding.modelId, '测试模型');
  assert.equal(doc.meta.semantic, '害羞链：脸红后抚胸');
  assert.ok(Array.isArray(doc.segments) && doc.segments.length >= 1, 'segments 必须已编译');
  console.log('ok 4 成功创建并落盘');
}

// ---------------------------------------------------------------------------
// 5) 409 name-exists（不覆盖既有图）
// ---------------------------------------------------------------------------
{
  const before = loadNodegraph('shy-plan', { homeDir });
  const out = await handleAiPlan({ name: 'shy-plan', instruction: '换个意图' }, deps(fakeLlm));
  assert.equal(out.status, 409);
  assert.equal(out.payload.reason, 'name-exists');
  assert.equal(loadNodegraph('shy-plan', { homeDir }), before, '冲突时原文件不得被改写');
  console.log('ok 5 409 name-exists');
}

// ---------------------------------------------------------------------------
// 6) 422 plan-invalid：LLM 返回空 ops → 图不成链，拒绝保存
// ---------------------------------------------------------------------------
{
  const out = await handleAiPlan({ name: 'empty-plan', instruction: '害羞' }, deps(() => Promise.resolve({ ops: [], explanation: '' })));
  assert.equal(out.status, 422);
  assert.equal(out.payload.reason, 'plan-invalid');
  assert.equal(loadNodegraph('empty-plan', { homeDir }), null, '422 时不得落盘');
  console.log('ok 6 422 plan-invalid');
}

// ---------------------------------------------------------------------------
// 7) 垃圾 op 跳过降级 warnings（合法部分仍成链保存）
// ---------------------------------------------------------------------------
{
  const ops = [...planOps(), { op: 'connect', from: 'e', to: '不存在的节点' }];
  const out = await handleAiPlan({ name: 'shy-warn', instruction: '害羞' }, deps(() => Promise.resolve({ ops, explanation: '带垃圾 op' })));
  assert.equal(out.status, 200);
  assert.equal(out.payload.saved, true);
  assert.ok(out.payload.warnings.length >= 1, '跳过的 op 必须进 warnings');
  assert.equal(out.payload.warnings[0].reason, 'node-not-found');
  console.log('ok 7 垃圾 op 降级 warnings');
}

// ---------------------------------------------------------------------------
// 8) 502 ai-bad-response（LLM 返回无 ops）
// ---------------------------------------------------------------------------
{
  const out = await handleAiPlan({ name: 'bad-llm', instruction: '害羞' }, deps(() => Promise.resolve({ foo: 1 })));
  assert.equal(out.status, 502);
  assert.equal(out.payload.reason, 'ai-bad-response');
  console.log('ok 8 502 ai-bad-response');
}

// ---------------------------------------------------------------------------
// 9) aiPlan 底层：指令长度上限 + 提示词包含清单与 schema
// ---------------------------------------------------------------------------
{
  const long = 'x'.repeat(2001);
  const out = await aiPlan({ instruction: long }, { llm: fakeLlm });
  assert.equal(out.status, 400);
  const prompt = buildAiPlanPrompt({ instruction: '害羞', lang: 'zh-CN', live2dIds: { expressions: ['脸红'] } });
  assert.ok(prompt.system.includes('"type":"add_node"') || prompt.system.includes('add_node'), '提示词必须带 op schema');
  assert.ok(prompt.system.includes('脸红'), '提示词必须带 live2d 清单');
  console.log('ok 9 指令上限与提示词');
}

fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log('nodegraph-planner tests passed');
