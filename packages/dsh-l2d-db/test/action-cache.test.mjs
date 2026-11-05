/**
 * Action Cache（编译计划 LRU）单测。对齐 actions-repo.test.mjs 形态
 * （node:assert + ok() 断言组 + 临时目录 SQLite）。
 * 覆盖：miss→hit / 版本变更失效 / 模型隔离 / LRU 淘汰顺序 / 并发合并 /
 * load 抛错不缓存 / unbound 退化 / invalidate / snapshot 一致性 /
 * resolveActionModelHash 绑定映射 / compileActionPlan 纯函数编译。
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.mjs';
import { resolveActionModelHash } from '../src/actions-repo.mjs';
import { createCompiledActionCache } from '../src/action-cache.mjs';
import { compileActionPlan } from '../src/action-plan.mjs';

let passed = 0;
function ok(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1; }
}
async function okAsync(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1; }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'action-cache-'));
const db = openDb({ path: path.join(tmp, 'test.sqlite') });

// ---- 种子：模型 + 绑定（供 resolveActionModelHash 用）----
db.prepare(`INSERT INTO models (model_id, source_path, package_hash) VALUES (?, ?, ?)`)
  .run('m1', 'x/m1.model3.json', 'hash-m1');
db.prepare(`INSERT INTO models (model_id, source_path, package_hash) VALUES (?, ?, ?)`)
  .run('m2', 'x/m2.model3.json', 'hash-m2');
db.prepare(`INSERT INTO motion_definitions (id, semantic_key, description, emotion, expression, gaze, body_language, version, status, created_at, updated_at) VALUES ('motion-bound', 'test.bound', '', '', '', '', '', 1, 'validated', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`).run();
db.prepare(`INSERT INTO motion_definitions (id, semantic_key, description, emotion, expression, gaze, body_language, version, status, created_at, updated_at) VALUES ('motion-free', 'test.free', '', '', '', '', '', 1, 'validated', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`).run();
db.prepare(`INSERT INTO motion_model_bindings (motion_id, model_id, adapter_json, compatible, verified_at) VALUES ('motion-bound', 'm1', NULL, 1, '2026-01-01T00:00:00Z')`).run();

console.log('P2 Action Cache');

function makeCache() {
  const state = { versions: {}, loads: 0 };
  const cache = createCompiledActionCache({
    getVersion: (actionId) => state.versions[actionId] ?? 1,
    load: (actionId, version, modelHash) => {
      state.loads++;
      return { raw: `${modelHash}:${actionId}@v${version}` };
    },
  });
  return { cache, state };
}

await okAsync('首次 miss / 二次 hit，且命中返回同一编译产物', async () => {
  const { cache, state } = makeCache();
  const v1 = await cache.resolve('hash-m1', 'act.a');
  assert.deepEqual(v1, { raw: 'hash-m1:act.a@v1' });
  const v2 = await cache.resolve('hash-m1', 'act.a');
  assert.equal(state.loads, 1);
  assert.ok(v1 === v2, '命中应返回同一编译产物');
  const s = cache.getStats();
  assert.equal(s.hits, 1); assert.equal(s.misses, 1); assert.equal(s.evictions, 0);
});

await okAsync('版本号变更 → 旧键失效重读', async () => {
  const { cache, state } = makeCache();
  state.versions['act.v'] = 1;
  const v1 = await cache.resolve('hash-m1', 'act.v');
  state.versions['act.v'] = 2;
  const v2 = await cache.resolve('hash-m1', 'act.v');
  assert.notDeepEqual(v1, v2);
  assert.equal(state.loads, 2);
  const v2again = await cache.resolve('hash-m1', 'act.v');
  assert.ok(v2again === v2);
  assert.equal(state.loads, 2);
  assert.equal(cache.getStats().hits, 1);
});

await okAsync('模型隔离：同 actionId 同版本不跨模型串用', async () => {
  const { cache, state } = makeCache();
  const [v1, v2] = await Promise.all([
    cache.resolve('hash-m1', 'act.iso'),
    cache.resolve('hash-m2', 'act.iso'),
  ]);
  assert.notDeepEqual(v1, v2);
  assert.equal(state.loads, 2);
});

await okAsync('LRU 淘汰：命中重插保活，超容淘汰最旧', async () => {
  const state = { loads: 0 };
  const c = createCompiledActionCache({
    capacity: 2,
    getVersion: () => 1,
    load: (actionId) => { state.loads++; return { raw: actionId }; },
  });
  await c.resolve('k', 'A');
  await c.resolve('k', 'B');          // 容量满：A(旧) B(新)
  await c.resolve('k', 'A');          // A 命中重插 → A(新) B(旧)
  await c.resolve('k', 'C');          // 超容淘汰 B
  const s = c.getStats();
  assert.equal(s.evictions, 1);
  assert.equal(s.size, 2);
  const loadsBefore = state.loads;
  const a2 = await c.resolve('k', 'A');
  assert.equal(state.loads, loadsBefore);      // A 未重读（命中重插保活）
  const b2 = await c.resolve('k', 'B');
  assert.equal(state.loads, loadsBefore + 1);  // B 已被淘汰 → 重读
  assert.deepEqual(b2, { raw: 'B' });
  assert.deepEqual(a2, { raw: 'A' });
});

await okAsync('并发合并：同键并发 resolve 只触发一次 load', async () => {
  let loadCalls = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const c = createCompiledActionCache({
    capacity: 8,
    getVersion: () => 1,
    load: async () => { loadCalls++; await gate; return { raw: 'slow' }; },
  });
  const p1 = c.resolve('h', 'act.slow');
  const p2 = c.resolve('h', 'act.slow');
  assert.ok(p1 === p2, '并发请求应共享同一 in-flight Promise');
  release();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(loadCalls, 1);
  assert.ok(r1 === r2);
  // 两次都是缓存 miss（第二次命中 in-flight 合并），合并效果以 load 只跑一次为准
  assert.equal(c.getStats().misses, 2);
});

await okAsync('load 抛错：不缓存失败结果、原样上抛、下次重读', async () => {
  let calls = 0;
  const c = createCompiledActionCache({
    capacity: 8,
    getVersion: () => 1,
    load: () => { calls++; if (calls === 1) throw new Error('boom'); return { raw: 'ok' }; },
  });
  await assert.rejects(() => c.resolve('h', 'act.err'), /boom/);
  assert.equal(c.getStats().size, 0);       // 失败不入缓存
  const v = await c.resolve('h', 'act.err');
  assert.deepEqual(v, { raw: 'ok' });
  assert.equal(calls, 2);
  assert.equal(c.getStats().hits, 0);
});

await okAsync('unbound 退化：null 模型哈希走 unbound 桶并计数', async () => {
  const { cache } = makeCache();
  await cache.resolve(null, 'act.u');
  await cache.resolve(null, 'act.u');
  const s = cache.getStats();
  assert.equal(s.unbound, 2);
  assert.equal(s.hits, 1);
});

await okAsync('invalidate：整模型清除与单动作清除', async () => {
  const { cache } = makeCache();
  await cache.resolve('h1', 'act.x');
  await cache.resolve('h1', 'act.y');
  await cache.resolve('h2', 'act.x');
  cache.invalidate('h1', 'act.x');                 // 单动作清除
  await cache.resolve('h1', 'act.x');              // miss（重读）
  assert.equal(cache.getStats().misses, 4);
  cache.invalidate('h1');                          // 整模型清除
  await cache.resolve('h1', 'act.y');              // miss
  assert.equal(cache.getStats().misses, 5);
  await cache.resolve('h2', 'act.x');              // h2 未清除 → hit
  assert.equal(cache.getStats().hits, 1);
});

await okAsync('一致性快照：getVersion 与 load 在同一 snapshot 钩子内读取', async () => {
  let snapshotCalls = 0;
  let inside = false;
  let bothInside = 0;
  const c = createCompiledActionCache({
    capacity: 8,
    getVersion: () => { if (inside) bothInside++; return 1; },
    load: () => { if (inside) bothInside++; return { raw: 'snap' }; },
    snapshot: (fn) => { snapshotCalls++; inside = true; try { return fn(); } finally { inside = false; } },
  });
  const v = await c.resolve('h', 'act.snap');
  assert.deepEqual(v, { raw: 'snap' });
  assert.equal(snapshotCalls, 1);
  assert.equal(bothInside, 2, '版本与内容读取须同处一个快照');
});

ok('resolveActionModelHash：绑定映射取 package_hash，未绑返回 null', () => {
  assert.equal(resolveActionModelHash(db, 'motion-bound'), 'hash-m1');
  assert.equal(resolveActionModelHash(db, 'motion-free'), null);
  assert.equal(resolveActionModelHash(db, 'motion-not-exist'), null);
});

ok('compileActionPlan：归一化缩放与 fail-closed 跳过（供缓存 compile 用）', () => {
  const chain = { steps: [{ step_index: 0, kind: 'keyframes', params: { track: 'tailSway', keys: [{ t: 0, value: -1 }, { t: 450, value: 1 }] } }] };
  const channels = { tail_sway: [{ paramId: 'Param_Angle_Rotation84', weight: 1 }] };
  const rows = { Param_Angle_Rotation84: { min_value: -10, max_value: 10 } };
  const paramRanges = (pid) => rows[pid] ?? null;
  const { plans, skips, guardViolation } = compileActionPlan(chain, channels, paramRanges);
  assert.equal(guardViolation, null);
  assert.equal(skips.length, 0);
  assert.equal(plans.length, 1);
  // v=1 → min + ((1·1)+1)/2 × (max-min) = -10 + 1 × 20 = 10；v=-1 → -10
  assert.deepEqual(plans[0].tracks[0].keys, [[0, -10], [450, 10]]);
  assert.equal(plans[0].durationMs, 450);
  // 无范围证据 → fail-closed 跳过
  const r2 = compileActionPlan(chain, channels, () => null);
  assert.equal(r2.plans.length, 0);
  assert.match(r2.skips[0].reason, /Hard 范围证据/);
});

console.log(`\n结果：${process.exitCode ? '存在失败' : '全部通过'}（${passed} 项断言组）`);
if (process.exitCode) process.exit(1);
