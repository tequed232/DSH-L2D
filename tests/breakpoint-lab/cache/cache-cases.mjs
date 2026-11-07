/**
 * cache/ 用例：编译计划 LRU 缓存 × 真实 SQLite Repository。
 * 覆盖：cache-hit / cache-miss / lru-eviction / version-invalidation /
 * range-update-invalidation（裁决 2：parameters 变异后由调用方 invalidateModel）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createSuite, standaloneIfMain } from '../lib/harness.mjs';
import { seedLabDb } from '../fixtures/seed.mjs';
import { createCompiledActionCache } from '../../../packages/dsh-l2d-db/src/action-cache.mjs';
import { compileActionPlan } from '../../../packages/dsh-l2d-db/src/action-plan.mjs';
import { upsertParameter } from '../../../packages/dsh-l2d-db/src/repo.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-cache-'));
const lab = seedLabDb({ dir: tmp });

const RANGES_SQL = 'SELECT min_value, max_value FROM parameters WHERE model_id = ? AND param_id = ?';
const rangesFor = (modelId) => (pid) => lab.db.prepare(RANGES_SQL).get(modelId, pid);
const CHANNELS = { tail_sway: [{ paramId: 'Param_Angle_Rotation84', weight: 1 }] };

/** 用真实 Repository 作 getVersion/load，真实编译作 compile */
function makeCache({ capacity = 128 } = {}) {
  const state = { loads: 0 };
  const cache = createCompiledActionCache({
    capacity,
    // 版本 = 该 motion 的链数（与 getActionChain(motionId, version) 的 1..n 追加序一致）
    getVersion: (motionId) => lab.db.prepare('SELECT COUNT(*) n FROM action_chains WHERE motion_id = ?').get(motionId).n,
    load: (motionId, version, modelHash) => {
      state.loads++;
      return lab.repo.getActionChain(motionId, version);
    },
    compile: (chain, { modelHash }) => {
      const modelId = lab.db.prepare('SELECT model_id FROM models WHERE package_hash = ?').get(modelHash)?.model_id;
      const modelIdResolved = modelId ?? 'bp-model-a';
      return compileActionPlan(chain, CHANNELS, rangesFor(modelIdResolved));
    },
  });
  return { cache, state };
}

const suite = createSuite('cache/（真实 SQLite + Repository）');

const cases = [
  {
    name: 'cache-miss → cache-hit：同键二次 resolve 只读一次库且命中同一编译产物',
    fn: async () => {
      const { cache, state } = makeCache();
      const hash = lab.modelHashOf('bp-model-a');
      const motionId = lab.motions['bp.tail_sway_a'].motionId;
      const v1 = await cache.resolve(hash, motionId);
      assert.equal(v1.plans.length, 1, 'tailSway → tail_sway 通道应编译出 1 条轨道');
      assert.equal(v1.plans[0].tracks[0].param, 'Param_Angle_Rotation84');
      const v2 = await cache.resolve(hash, motionId);
      assert.equal(state.loads, 1);
      assert.ok(v1 === v2);
      const s = cache.getStats();
      assert.equal(s.hits, 1); assert.equal(s.misses, 1);
    },
  },
  {
    name: 'lru-eviction：capacity=2 时最旧条目被淘汰且可重读',
    fn: async () => {
      const { cache, state } = makeCache({ capacity: 2 });
      const hashes = [lab.modelHashOf('bp-model-a'), lab.modelHashOf('bp-model-a'), lab.modelHashOf('bp-model-b')];
      const motionIds = [lab.motions['bp.tail_sway_a'].motionId, lab.motions['bp.free_float'].motionId, lab.motions['bp.tail_sway_b'].motionId];
      await cache.resolve(hashes[0], motionIds[0]);
      await cache.resolve(hashes[1], motionIds[1]);
      await cache.resolve(hashes[0], motionIds[0]);      // 命中重插保活 → LRU 序 [B, A]
      await cache.resolve(hashes[2], motionIds[2]);      // 超容 → 淘汰最旧 B
      assert.equal(cache.getStats().evictions, 1);
      const before = state.loads;
      await cache.resolve(hashes[1], motionIds[1]);      // B 被淘汰 → 重读；重插把 A 挤成最旧
      assert.equal(state.loads, before + 1);
      await cache.resolve(hashes[0], motionIds[0]);      // A 已被挤出 → 也是 miss（真实 LRU 行为）
      assert.equal(state.loads, before + 2);
      await cache.resolve(hashes[1], motionIds[1]);      // B 仍命中
      assert.equal(state.loads, before + 2);
    },
  },
  {
    name: 'version-invalidation：新增链版本 → getVersion 变化 → 旧条目自然失效',
    fn: async () => {
      const { cache, state } = makeCache();
      const hash = lab.modelHashOf('bp-model-a');
      const { motionId } = lab.motions['bp.tail_sway_a'];
      const v1 = await cache.resolve(hash, motionId);
      const motion = lab.repo.getMotion(motionId);
      const v2chain = { schemaVersion: '1.0', steps: [{ step_index: 0, kind: 'keyframes', params: { track: 'tailSway', keys: [{ t: 0, value: -1 }, { t: 900, value: 1 }] }, durationMs: 900 }] };
      const r = await lab.repo.createActionChainVersion(motionId, { chain: v2chain }, motion.version);
      assert.equal(r.version, 2);
      const v2 = await cache.resolve(hash, motionId);
      assert.notDeepEqual(v1, v2, '版本推进后缓存应装载新链');
      assert.equal(v2.plans[0].durationMs, 900);
      assert.equal(state.loads, 2);
    },
  },
  {
    name: 'range-update-invalidation（裁决 2）：upsertParameter 变异后须显式 invalidateModel',
    fn: async () => {
      const { cache } = makeCache();
      const hash = lab.modelHashOf('bp-model-a');
      const motionId = lab.motions['bp.tail_sway_a'].motionId;
      const before = await cache.resolve(hash, motionId);
      // 峰值 = min + ((v·w)+1)/2 × (max-min)，v=1, w=1 → min + (max-min)
      const oldPeak = before.plans[0].tracks[0].keys[1][1];
      assert.equal(oldPeak, 10);
      // 范围变异（无 schema 版本信号）：不失效则命中旧计划（陈旧范围）
      upsertParameter(lab.db, { modelId: 'bp-model-a', paramId: 'Param_Angle_Rotation84', minValue: -20, maxValue: 20 });
      const stale = await cache.resolve(hash, motionId);
      assert.equal(stale.plans[0].tracks[0].keys[1][1], 10, '未失效前命中旧编译产物（证明失效必须显式触发）');
      // 调用方触发 invalidateModel（裁决 2 的接线约定）
      cache.invalidate(hash);
      const fresh = await cache.resolve(hash, motionId);
      assert.equal(fresh.plans[0].tracks[0].keys[1][1], 20, '失效后重编译使用新 Hard 范围');
    },
  },
];

await standaloneIfMain(import.meta.url, async () => suite.run(cases));
export async function run() { return suite.run(cases); }
