/**
 * Action Cache 性能基准（独立可跑）：
 *   node --experimental-sqlite tests/breakpoint-lab/bench.mjs
 * 或 pnpm bench:action-cache。
 *
 * 只测性能，不测功能（node:assert 仅做 sanity 断言）。所有数字由本脚本真实
 * 测量并写入 reports/bench-report.json——禁止手写或外推。
 *
 * 场景：
 *   cold-read    首次 resolve 全链路（SQLite 读链 + 编译），独立 cache 实例逐次冷读
 *   cache-hit    预热后同键重复 resolve（纯内存 LRU 命中路径）
 *   cache-miss   200 键灌 128 容量（持续淘汰压力下的 miss 路径）
 *   mixed-1000   1000 次混合 resolve（命中/未命中自然混合，统计命中率）
 *   concurrent   50 并发同键 + 50 并发混合键（in-flight 合并路径）各一轮
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { seedLabDb } from './fixtures/seed.mjs';
import { createCompiledActionCache } from '../../packages/dsh-l2d-db/src/action-cache.mjs';
import { compileActionPlan } from '../../packages/dsh-l2d-db/src/action-plan.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CAPACITY = 128;
const COLD_N = 200;
const HIT_N = 1000;
const MIXED_N = 1000;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-bench-'));
const lab = seedLabDb({ dir: tmp });

// 压力数据集：在种子 3 条链之外再经真实 Repository 批量造链（COLD_N 条）
const extraMotions = [];
{
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < COLD_N; i++) {
    const r = lab.repo.createActionChain({
      semanticKey: `bp.bench_key_${i}`,
      description: `bench ${i}`,
      chain: { schemaVersion: '1.0', steps: [{ step_index: 0, kind: 'keyframes', params: { track: 'tailSway', keys: [{ t: 0, value: -1 }, { t: 450, value: 1 }] }, durationMs: 450 }] },
      provenance: { assets: [], analyses: [] },
      sourceId: 'bp-bench',
    });
    extraMotions.push(r.motionId);
  }
  lab.db.prepare('INSERT INTO motion_model_bindings (motion_id, model_id, adapter_json, compatible, verified_at) SELECT ?, ?, NULL, 1, ? WHERE 1')
    .run(extraMotions[0], 'bp-model-a', new Date().toISOString());
  const seedMs = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`seed: +${COLD_N} chains via Repository in ${seedMs.toFixed(0)}ms`);
}

const CHANNELS = { tail_sway: [{ paramId: 'Param_Angle_Rotation84', weight: 1 }] };
const rangesFor = (pid) => lab.db.prepare('SELECT min_value, max_value FROM parameters WHERE model_id = ? AND param_id = ?').get('bp-model-a', pid);
const countChains = (motionId) => lab.db.prepare('SELECT COUNT(*) n FROM action_chains WHERE motion_id = ?').get(motionId).n;

function makeCache(capacity = CAPACITY) {
  return createCompiledActionCache({
    capacity,
    getVersion: (motionId) => countChains(motionId),
    load: (motionId, version) => lab.repo.getActionChain(motionId, version),
    compile: (chain) => compileActionPlan(chain, CHANNELS, rangesFor),
  });
}

const stats = (samples) => {
  const s = [...samples].sort((a, b) => a - b);
  const pct = (p) => s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
  return { n: s.length, p50: +pct(50).toFixed(3), p95: +pct(95).toFixed(3), p99: +pct(99).toFixed(3), min: +s[0].toFixed(3), max: +s[s.length - 1].toFixed(3), mean: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(3) };
};

const heapNow = () => +(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);
const bench = { env: { node: process.version, platform: process.platform, arch: process.arch, capacity: CAPACITY, coldN: COLD_N, hitN: HIT_N, mixedN: MIXED_N }, scenarios: {} };

// ---- cold-read：每次全新 cache 实例（无任何命中可能）----
{
  const t0 = process.hrtime.bigint();
  const heap0 = heapNow();
  const samples = [];
  let errors = 0;
  for (const motionId of extraMotions) {
    const cache = makeCache();
    const t = process.hrtime.bigint();
    try {
      const plan = await cache.resolve(lab.modelHashOf('bp-model-a'), motionId);
      assert.ok(plan && Array.isArray(plan.plans));
    } catch { errors++; }
    samples.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  bench.scenarios['cold-read'] = { description: `首次 resolve 全链路（SQLite + compile），${COLD_N} 个独立键 × 独立 cache 实例`, latencyMs: stats(samples), errorRate: +(errors / COLD_N).toFixed(4), wallMs: +(Number(process.hrtime.bigint() - t0) / 1e6).toFixed(1), heapUsedDeltaMB: +(heapNow() - heap0).toFixed(2) };
}

// ---- cache-hit：预热 1 键后连续命中 ----
{
  const cache = makeCache();
  const motionId = lab.motions['bp.tail_sway_a'].motionId;
  await cache.resolve(lab.modelHashOf('bp-model-a'), motionId);
  const t0 = process.hrtime.bigint();
  const heap0 = heapNow();
  const samples = [];
  let errors = 0;
  for (let i = 0; i < HIT_N; i++) {
    const t = process.hrtime.bigint();
    try {
      const plan = await cache.resolve(lab.modelHashOf('bp-model-a'), motionId);
      assert.ok(plan);
    } catch { errors++; }
    samples.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  const s = cache.getStats();
  bench.scenarios['cache-hit'] = { description: `预热后同键重复 resolve ×${HIT_N}（纯内存 LRU 命中路径）`, latencyMs: stats(samples), hitRate: +(s.hits / (s.hits + s.misses)).toFixed(4), errorRate: +(errors / HIT_N).toFixed(4), wallMs: +(Number(process.hrtime.bigint() - t0) / 1e6).toFixed(1), heapUsedDeltaMB: +(heapNow() - heap0).toFixed(2) };
}

// ---- cache-miss：200 键灌 128 容量（持续淘汰压力）----
{
  const cache = makeCache();
  const heap0 = heapNow();
  const samples = [];
  let errors = 0;
  for (const motionId of extraMotions) {
    const t = process.hrtime.bigint();
    try {
      const plan = await cache.resolve(lab.modelHashOf('bp-model-a'), motionId);
      assert.ok(plan);
    } catch { errors++; }
    samples.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  const s = cache.getStats();
  bench.scenarios['cache-miss'] = { description: `${COLD_N} 个键灌 ${CAPACITY} 容量（每键首读 + 淘汰压力）`, latencyMs: stats(samples), hitRate: +(s.hits / (s.hits + s.misses)).toFixed(4), evictions: s.evictions, errorRate: +(errors / COLD_N).toFixed(4), heapUsedDeltaMB: +(heapNow() - heap0).toFixed(2) };
}

// ---- mixed-1000：命中/未命中自然混合 ----
{
  const cache = makeCache();
  const keys = [...extraMotions.slice(0, 96), lab.motions['bp.tail_sway_a'].motionId, lab.motions['bp.tail_sway_b'].motionId, lab.motions['bp.free_float'].motionId];
  const heap0 = heapNow();
  const samples = [];
  let errors = 0;
  for (let i = 0; i < MIXED_N; i++) {
    const motionId = keys[i % keys.length];
    const t = process.hrtime.bigint();
    try {
      const plan = await cache.resolve(lab.modelHashOf('bp-model-a'), motionId);
      assert.ok(plan);
    } catch { errors++; }
    samples.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  const s = cache.getStats();
  bench.scenarios['mixed-1000'] = { description: `${MIXED_N} 次 resolve 轮转 ${keys.length} 个键（<容量，命中/未命中自然混合）`, latencyMs: stats(samples), hitRate: +(s.hits / (s.hits + s.misses)).toFixed(4), evictions: s.evictions, errorRate: +(errors / MIXED_N).toFixed(4), heapUsedDeltaMB: +(heapNow() - heap0).toFixed(2) };
}

// ---- concurrent：in-flight 合并路径 ----
{
  const cache = makeCache();
  const motionId = lab.motions['bp.tail_sway_a'].motionId;
  const heap0 = heapNow();
  let t = process.hrtime.bigint();
  await Promise.all(Array.from({ length: 50 }, () => cache.resolve(lab.modelHashOf('bp-model-a'), motionId)));
  const sameKeyWallMs = +(Number(process.hrtime.bigint() - t) / 1e6).toFixed(2);
  const s1 = cache.getStats();
  const keys = [...extraMotions.slice(0, 50)];
  t = process.hrtime.bigint();
  const results = await Promise.all(keys.map((k) => cache.resolve(lab.modelHashOf('bp-model-a'), k)));
  const mixedWallMs = +(Number(process.hrtime.bigint() - t) / 1e6).toFixed(2);
  const s2 = cache.getStats();
  assert.equal(results.length, 50);
  bench.scenarios['concurrent'] = {
    description: 'in-flight 合并：50 并发同键 + 50 并发混合键各一轮',
    sameKey50: { wallMs: sameKeyWallMs, misses: s1.misses, note: '同键并发应只触发 1 次 load（misses 含首次冷读 1 次）' },
    mixedKeys50: { wallMs: mixedWallMs, misses: s2.misses - s1.misses },
    heapUsedDeltaMB: +(heapNow() - heap0).toFixed(2),
  };
}

// ---- 汇总 ----
const report = {
  generatedAt: new Date().toISOString(),
  subject: 'createCompiledActionCache（action-cache.mjs）resolve 路径',
  clock: 'process.hrtime.bigint（毫秒，3 位小数）',
  disclaimer: '本机单次实测；数字随环境波动，仅作相对参考，不构成优化证明。',
  ...bench,
};
const reportsDir = path.join(HERE, 'reports');
fs.mkdirSync(reportsDir, { recursive: true });
const out = path.join(reportsDir, 'bench-report.json');
fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');

console.log('\n=== Action Cache Bench ===');
for (const [k, v] of Object.entries(bench.scenarios)) {
  const lat = v.latencyMs ? `P50 ${v.latencyMs.p50}ms / P95 ${v.latencyMs.p95}ms / P99 ${v.latencyMs.p99}ms` : `wall ${v.sameKey50?.wallMs ?? '?'}ms + ${v.mixedKeys50?.wallMs ?? '?'}ms`;
  console.log(`  ${k}: ${lat}${v.hitRate !== undefined ? ` | 命中率 ${(v.hitRate * 100).toFixed(1)}%` : ''} | err ${v.errorRate ?? 0} | heapΔ ${v.heapUsedDeltaMB}MB`);
}
console.log(`→ ${path.relative(process.cwd(), out)}（node ${report.env.node} / ${report.env.platform}/${report.env.arch} / capacity ${report.env.capacity}）`);
