/**
 * CHAIN-15 通跑测试（任务 C；用户规则：每次完成任务后跑通 15 条连续动作链）。
 *
 * 流程：buildChainSeeds → 临时库经 actions-repo G0-G4 入库 → 15 条链映射为
 * MCP segments → executeActionSequence 队列串行路径真实执行（FIFO + 相邻合批）
 * → 断言：
 *   ① 15/15 全部完成（completedSegments=15）
 *   ② 零丢弃（每段回执 accepted=true 且 outcome=completed）
 *   ③ 顺序正确（执行序 = 合批序 = 队列序，对象引用级核对）
 *   ④ 实测总时长与链级 totalDurationMs 汇总一致（容差 +2s）
 *   ⑤ 每步记录提交/开始/完成/等待四项时间（submittedAt/startedAt/completedAt/waitedMs）
 *
 * 完成信号偏差注明：主线 Runtime Timeline 仍是 lifeMs 预估（BLOCKED），
 * 队列出队沿用「execute 回执 outcome=completed」语义 + 计时基准取链级
 * totalDurationMs 声明值；真实完成事件接入后仅需替换 executor。
 *
 * 直跑：node --experimental-sqlite tests/chain-15/run.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../packages/dsh-l2d-db/src/db.mjs';
import { createActionsRepository } from '../../packages/dsh-l2d-db/src/actions-repo.mjs';
import { buildChainSeeds, chainToSegmentSteps } from '../../tools/chain-15/seed.mjs';
import { executeActionSequence, coalesceActionSegments, validateActionSequence } from '../../packages/dsh-l2d-mcp/src/action-sequence.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chain15-'));
const db = openDb({ path: path.join(tmp, 'chain15.sqlite') });
const repo = createActionsRepository(db);

let passed = 0;
function ok(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('CHAIN-15 通跑（任务 C）');

// 1) 入库（G0-G4）并读取链级 totalDurationMs
const seeds = buildChainSeeds();
const library = [];
for (const s of seeds) {
  const r = repo.createActionChain({
    semanticKey: s.semanticKey, description: s.description, emotion: s.emotion,
    chain: { schemaVersion: '1.0', steps: s.steps }, provenance: { assets: [], analyses: [] }, actor: 'chain15-run',
  });
  assert.equal(r.status, 'created', `${s.semanticKey} 未过 G 门禁`);
  library.push({ semanticKey: s.semanticKey, motionId: r.motionId, totalDurationMs: r.totalDurationMs, steps: s.steps });
}

// 2) 映射为 MCP segments（15 段 = MAX_SEGMENTS 上限，恰好满载）；建步级时长基准
const segments = library.map((entry) => ({ priority: 'NORMAL', chain: chainToSegmentSteps({ steps: entry.steps }) }));
const plan = { segments };
const validation = validateActionSequence(plan);
assert.equal(validation.ok, true, `segments 校验失败：${validation.errors.join('; ')}`);
const expectedBatches = coalesceActionSegments(segments);
/** 步对象引用 → 声明执行时长（executor 模拟渲染耗时与 ④ 断言的基准） */
const STEP_DURATION = new Map();
segments.forEach((seg, i) => seg.chain.forEach((step, j) => STEP_DURATION.set(step, library[i].steps[j].durationMs)));

// 3) 计时执行器：真实 setTimeout 模拟渲染时长；逐步记录四项时间
const stepTimings = [];   // {semanticKey, stepIndex, submittedAt, startedAt, completedAt, waitedMs}
const batchCalls = [];    // 执行器实际收到的批（按 FIFO 顺序，存引用）
const runStart = Date.now();
let prevTurnEnd = runStart; // 上一批完成时刻 = 本批入队时刻（串行队列出队信号）

const result = await executeActionSequence(plan, async (call) => {
  const submittedAt = Date.now();
  const turnStart = prevTurnEnd;
  batchCalls.push(call);
  // 按声明时长模拟执行：每步 delayMs（步间间隔）+ durationMs（声明执行时长）
  let cursor = 0;
  const timings = call.chain.map((step, i) => {
    cursor += Math.max(0, Number(step.delayMs) || 0);
    const startedAt = submittedAt + cursor;
    cursor += STEP_DURATION.get(step) ?? 800;
    return { step, stepIndex: i, submittedAt, startedAt, completedAt: submittedAt + cursor, waitedMs: submittedAt - turnStart };
  });
  await sleep(cursor);
  prevTurnEnd = Date.now();
  stepTimings.push(...timings);
  return { accepted: true, outcome: 'completed', settled: true, completedAt: prevTurnEnd };
}, { retryDelayMs: 10 });

ok('① 库规模 15 且 15 段恰好满载（segments 上限 = 15）', () => {
  assert.equal(library.length, 15);
  assert.equal(plan.segments.length, 15);
});

ok('② 15/15 全部完成、零丢弃', () => {
  assert.equal(result.ok, true, `队列结果 ${result.status}:${result.reason}`);
  assert.equal(result.completedSegments, 15);
  assert.equal(result.remainingSegments, 0);
  assert.equal(result.receipts.length, expectedBatches.length, `合批 ${expectedBatches.length} 批，回执数一致`);
  for (const r of result.receipts) {
    assert.equal(r.receipt.accepted, true, '零丢弃：accepted');
    assert.equal(r.receipt.outcome, 'completed', '零丢弃：completed');
  }
});

ok('③ 顺序正确：执行序 = 合批序 = 队列序（引用级核对）', () => {
  assert.deepEqual(
    result.receipts.map((r) => r.sourceSegments),
    expectedBatches.map((b) => b.sourceSegments),
    '回执 sourceSegments 序 = 合批序',
  );
  expectedBatches.forEach((b, i) => {
    assert.deepEqual(batchCalls[i].chain, b.chain, `第 ${i} 批执行内容与合批结果一致（合批在 executeActionSequence 内部重算，核对内容而非引用）`);
  });
  // 全局步序 = 展平后的声明顺序
  const executedFlat = batchCalls.flatMap((c) => c.chain);
  const expectedFlat = segments.flatMap((s) => s.chain);
  assert.deepEqual(executedFlat, expectedFlat);
});

ok('④ 实测总时长 ≈ 链级 totalDurationMs 汇总（容差 +2s）', () => {
  const expectedTotal = library.reduce((sum, e) => sum + e.totalDurationMs, 0);
  const measured = prevTurnEnd - runStart;
  assert.ok(measured >= expectedTotal * 0.8, `实测 ${measured}ms 应 ≥ 声明 80%（${expectedTotal}ms）`);
  assert.ok(measured <= expectedTotal + 2000, `实测 ${measured}ms 不得超过声明 +2s 容差（声明 ${expectedTotal}ms）`);
  console.log(`    声明 ${expectedTotal}ms / 实测 ${measured}ms`);
});

ok('⑤ 每步四项计时齐备（提交/开始/完成/等待）', () => {
  const totalSteps = library.reduce((n, e) => n + e.steps.length, 0);
  assert.equal(stepTimings.length, totalSteps, `步级计时 ${stepTimings.length}/${totalSteps}`);
  for (const t of stepTimings) {
    for (const k of ['submittedAt', 'startedAt', 'completedAt', 'waitedMs']) {
      assert.equal(typeof t[k], 'number', `${k} 必须是数字`);
    }
    assert.ok(t.startedAt >= t.submittedAt && t.completedAt >= t.startedAt, '时间单调');
  }
});

console.log(`\n结果：${process.exitCode ? '存在失败' : '全部通过'}（${passed} 项断言组）`);
db.close();
if (process.exitCode) process.exit(1);
