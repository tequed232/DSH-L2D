/**
 * nodegraph-memory 测试：动作链行为记忆（Phase 3 检索 + Phase 4 执行摘要）。
 * 覆盖：记忆汇编（语义/链摘要提取、损坏文档容错）/ 关键词评分（name>semantic>链节点、
 * 同模型加权）/ 空 q 全量 / limit 上限 / lastRun 摘要（completed 与 interrupted 失败锚点）/
 * 守卫接线。全部注入假注册表，不联网、不触碰真实 $DSH_HOME。
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildActionMemory, handleMemorySearch } from './nodegraph-memory.mjs';
import { guardGraphCall, HOST_GRAPH_TOOLS } from './host-guard.mjs';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-'));
// homeDir 语义 = DSH home；图目录 = home/l2d-nodegraphs（与 nodegraph.mjs 一致）
const homeDir = path.join(tmpRoot, 'home');
const graphDir = path.join(homeDir, 'l2d-nodegraphs');
fs.mkdirSync(graphDir, { recursive: true });

/** 写入一份最小合法形状的图文档（memory 只读，不要求过全量校验） */
function writeGraph(name, obj) {
  fs.writeFileSync(path.join(graphDir, name + '.json'), JSON.stringify(obj), 'utf8');
}
function graphDoc({ name, modelId = '测试模型', semantic = '', chain = [], templateId = '' }) {
  // graph 结构与真实导出图同形（roots + nodes 链式 next），保证 listNodegraphs 校验 valid:true
  const nodes = chain.map((step, i) => ({
    id: step.name || 'n' + i,
    type: step.kind,
    name: step.name || undefined,
    delayMs: 0,
    ...(step.kind === 'look' ? { x: Number(step.x) || 0, y: Number(step.y) || 0 } : {}),
    next: i + 1 < chain.length ? [chain[i + 1].name || 'n' + (i + 1)] : [],
  }));
  return {
    schemaVersion: 1,
    kind: 'dsh-l2d-nodegraph',
    name,
    modelBinding: { modelId, modelHash: '', bindingMode: 'strict' },
    graph: { roots: nodes.length ? [nodes[0].id] : [], nodes },
    segments: chain.length ? [{ priority: 'NORMAL', chain }] : [],
    meta: { ...(semantic ? { semantic } : {}), ...(templateId ? { templateId } : {}) },
  };
}

// ---------------------------------------------------------------------------
// 1) 白名单接线
// ---------------------------------------------------------------------------
{
  assert.ok(HOST_GRAPH_TOOLS.includes('l2d_graph_search'), 'search 必须在图工具白名单里');
  assert.equal(guardGraphCall({ name: 'l2d_graph_search', args: {} }).ok, true);
  console.log('ok 1 白名单接线');
}

// ---------------------------------------------------------------------------
// 2) 记忆汇编：语义/链摘要提取 + 损坏文档容错
// ---------------------------------------------------------------------------
{
  writeGraph('shy', graphDoc({
    name: 'shy',
    semantic: '害羞：脸红后视线躲闪',
    chain: [
      { kind: 'expression', name: '脸红' },
      { kind: 'look', name: '', x: 0.2, y: 0.25 },
      { kind: 'motion', name: '抚胸手打开' },
    ],
  }));
  writeGraph('greet', graphDoc({
    name: 'greet',
    modelId: '另一模型',
    semantic: '打招呼：举手挥动',
    chain: [{ kind: 'motion', name: '竖手指打开' }],
    templateId: 'greet',
  }));
  writeGraph('broken', { kind: 'not-a-graph' }); // 缺 segments → 容错为空链
  fs.writeFileSync(path.join(graphDir, 'garbage.json'), '{not json', 'utf8'); // 解析失败 → 容错
  const mem = buildActionMemory({ homeDir });
  assert.equal(mem.ok, true);
  assert.equal(mem.total, 4);
  const shy = mem.items.find((i) => i.name === 'shy');
  assert.equal(shy.semantic, '害羞：脸红后视线躲闪');
  assert.equal(shy.nodeCount, 3);
  assert.equal(shy.chain[0].name, '脸红');
  assert.equal(shy.valid, true);
  assert.equal(shy.lastRun, undefined, '无注册表时无 lastRun');
  const broken = mem.items.find((i) => i.name === 'broken');
  assert.deepEqual(broken.chain, [], '损坏文档链为空但不抛');
  const garbage = mem.items.find((i) => i.name === 'garbage');
  assert.equal(garbage.valid, false, '解析失败文档 valid:false');
  console.log('ok 2 记忆汇编与容错');
}

// ---------------------------------------------------------------------------
// 3) 关键词评分：semantic 命中 / 链节点名命中 / 同模型加权
// ---------------------------------------------------------------------------
{
  const out = handleMemorySearch({ q: '害羞' }, { homeDir });
  assert.equal(out.status, 200);
  assert.equal(out.payload.matched >= 1, true);
  assert.equal(out.payload.items[0].name, 'shy', 'semantic「害羞」命中 shy 排第一');
  const out2 = handleMemorySearch({ q: '竖手指' }, { homeDir, getCurrentModelId: () => '另一模型' });
  assert.equal(out2.payload.items[0].name, 'greet', '链节点名「竖手指」命中 greet，同模型加权第一');
  const out3 = handleMemorySearch({ q: '不存在的意图xyz' }, { homeDir });
  assert.equal(out3.payload.matched, 0);
  assert.equal(out3.payload.items.length, 0);
  console.log('ok 3 关键词评分与加权');
}

// ---------------------------------------------------------------------------
// 4) 空 q 全量 + limit 上限
// ---------------------------------------------------------------------------
{
  const all = handleMemorySearch({}, { homeDir });
  assert.equal(all.payload.matched, 4);
  assert.equal(all.payload.hint.includes('l2d_graph_ai_plan'), true, 'hint 必须给出工作流指引');
  const limited = handleMemorySearch({ limit: 2 }, { homeDir });
  assert.equal(limited.payload.items.length, 2);
  const capped = handleMemorySearch({ limit: 999 }, { homeDir });
  assert.ok(capped.payload.items.length <= 50);
  console.log('ok 4 空 q 全量与 limit');
}

// ---------------------------------------------------------------------------
// 5) Phase 4：lastRun 执行摘要（completed / interrupted 失败锚点）
// ---------------------------------------------------------------------------
{
  const records = new Map();
  let seq = 0;
  const registry = {
    list: ({ limit }) => [...records.values()].reverse().slice(0, limit ?? 20).map((r) => ({ ...r, result: undefined })),
    get: (id) => records.get(id) || null,
  };
  // shy：最近一次 interrupted，带失败回执
  records.set('e1', {
    executionId: 'e1', name: 'shy', startedAt: 1, finishedAt: 2, status: 'interrupted', cancelRequested: false,
    result: {
      ok: false, status: 'stopped', reason: 'interrupted',
      completedSegments: 1, remainingSegments: 2, replanRequired: true,
      receipts: [
        { batch: 0, receipt: { outcome: 'completed' } },
        { batch: 1, receipt: { outcome: 'interrupted', reason: 'conflict', errors: ['动作被更高优先级抢占'] } },
      ],
    },
  });
  // greet：最近一次 completed
  records.set('e2', {
    executionId: 'e2', name: 'greet', startedAt: 3, finishedAt: 4, status: 'completed', cancelRequested: false,
    result: { ok: true, status: 'completed', completedSegments: 2, remainingSegments: 0, replanRequired: false, receipts: [{ batch: 0, receipt: { outcome: 'completed' } }] },
  });
  const out = handleMemorySearch({ q: '害羞' }, { homeDir, registry });
  const shy = out.payload.items[0];
  assert.equal(shy.lastRun.status, 'interrupted');
  assert.equal(shy.lastRun.ok, false);
  assert.equal(shy.lastRun.completedSegments, 1);
  assert.equal(shy.lastRun.remainingSegments, 2);
  assert.equal(shy.lastRun.replanRequired, true);
  assert.equal(shy.lastRun.failure.outcome, 'interrupted');
  assert.equal(shy.lastRun.failure.reason, 'conflict');
  assert.ok(shy.lastRun.failure.error.includes('抢占'), '失败锚点必须带错误详情');
  const out2 = handleMemorySearch({ q: '打招呼' }, { homeDir, registry });
  const greet = out2.payload.items[0];
  assert.equal(greet.lastRun.status, 'completed');
  assert.equal(greet.lastRun.failure, undefined, 'completed 无 failure 锚点');
  // list 摘要缺 result 字段时 get 补全——验证汇总路径不依赖 list 全文
  assert.equal(records.get('e1').result.receipts.length, 2);
  console.log('ok 5 lastRun 执行摘要');
}

// ---------------------------------------------------------------------------
// 6) 注册表异常容错（list 抛错不影响记忆汇编）
// ---------------------------------------------------------------------------
{
  const badRegistry = { list: () => { throw new Error('boom'); }, get: () => null };
  const out = handleMemorySearch({ q: '害羞' }, { homeDir, registry: badRegistry });
  assert.equal(out.status, 200);
  assert.equal(out.payload.items[0].name, 'shy');
  assert.equal(out.payload.items[0].lastRun, undefined);
  console.log('ok 6 注册表异常容错');
}

fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log('nodegraph-memory tests passed');
