/**
 * recovery/ 用例：真实子进程 SIGKILL 后的恢复语义。
 * - sqlite-reopen：未决事务回滚、库可复用
 * - process-restart：P0 Resolve 中断 → 重启重查一致
 * - interrupted-execution：P4/P5 中断 → 不自动续播 / 旧租约不复活 / 重走 admission（纯逻辑侧）
 * - corrupted-cache：脏缓存条目经 invalidate 失效后重读恢复
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { createSuite, standaloneIfMain } from '../lib/harness.mjs';
import { seedLabDb } from '../fixtures/seed.mjs';
import { spawnWorker, waitForMarker, sigkill, waitExit, writeMarker } from '../fault-injection/checkpoint.mjs';
import { createCompiledActionCache } from '../../../packages/dsh-l2d-db/src/action-cache.mjs';
import { compileActionPlan } from '../../../packages/dsh-l2d-db/src/action-plan.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(HERE, '..', 'fault-injection', 'worker-crash.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-recovery-'));

const suite = createSuite('recovery/（真实 SIGKILL 子进程）');

const cases = [
  {
    name: 'sqlite-reopen：SIGKILL 未决事务回滚，重开库数据完整且可写',
    fn: async () => {
      const dbPath = path.join(tmp, 'tx.db');
      const marker = path.join(tmp, 'tx.marker');
      const child = spawnWorker(WORKER, ['--mode', 'tx', '--db', dbPath, '--marker', marker]);
      await waitForMarker(marker);
      const markerPayload = JSON.parse(fs.readFileSync(marker, 'utf8'));
      assert.equal(markerPayload.inTxCount, 3, '子进程视角：基线 2 行 + 事务内 1 行');
      sigkill(child);
      const exit = await waitExit(child);
      assert.equal(exit.signal, 'SIGKILL', '必须是真实 SIGKILL（非 throw / 非优雅退出）');
      // 父进程重开同一 db：未决事务必须回滚
      const { openDb } = await import('../../../packages/dsh-l2d-db/src/db.mjs');
      const db = openDb({ path: dbPath });
      const n = db.prepare('SELECT COUNT(*) n FROM motion_definitions').get().n;
      assert.equal(n, 2, '未决事务的第 3 行必须回滚');
      // 库可复用：重开后写入与读取正常
      db.prepare('INSERT INTO motion_definitions (id, semantic_key, description, emotion, expression, gaze, body_language, version, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run('bp.tx.post-crash', 'bp.tx.post-crash', '', '', '', '', '', 1, 'validated', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
      assert.equal(db.prepare('SELECT COUNT(*) n FROM motion_definitions').get().n, 3);
    },
  },
  {
    name: 'process-restart：P0 Resolve 中断 → 重启后重查与中断前一致',
    fn: async () => {
      const lab = seedLabDb({ dir: path.join(tmp, 'resolve') });
      const marker = path.join(tmp, 'resolve.marker');
      const statePath = path.join(tmp, 'resolve.state.json');
      const child = spawnWorker(WORKER, ['--mode', 'resolve', '--db', lab.dbPath, '--state', statePath, '--marker', marker]);
      await waitForMarker(marker);
      const before = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      sigkill(child);
      const exit = await waitExit(child);
      assert.equal(exit.signal, 'SIGKILL');
      // 重启子进程走 verify 模式：重走 Resolve（重新查询，不信任中断前状态）
      const v = spawnWorker(WORKER, ['--mode', 'verify', '--db', lab.dbPath, '--state', statePath]);
      const vExit = await waitExit(v);
      assert.equal(vExit.code, 0, `重启校验应通过（stderr: ${vExit.stderr.slice(-200)}）`);
      const after = JSON.parse(fs.readFileSync(statePath + '.verify', 'utf8'));
      assert.equal(after.consistent, true);
      assert.equal(after.motionId, before.motionId);
      assert.equal(after.chainId, before.chainId);
    },
  },
  {
    name: 'interrupted-execution：SIGKILL 后不自动续播 / 旧租约不复活 / 重走 admission（纯逻辑侧）',
    fn: async () => {
      const dir = path.join(tmp, 'p5');
      fs.mkdirSync(dir, { recursive: true });
      const marker = path.join(dir, 'p5.marker');
      const statePath = path.join(dir, 'p5.state.json');
      const child = spawnWorker(WORKER, ['--mode', 'p5', '--state', statePath, '--marker', marker]);
      await waitForMarker(marker);
      const before = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      assert.equal(before.accepted, true);
      assert.deepEqual(before.owned.sort(), ['ParamAngleX', 'ParamEyeBallX']);
      sigkill(child);
      const exit = await waitExit(child);
      assert.equal(exit.signal, 'SIGKILL');
      // 重启 = 全新进程内存：ActGate/ParamOwnership 均为新实例
      const { ActGate } = await import('../../../packages/core/src/index.ts');
      const { ParamOwnership } = await import('../../../packages/renderer/src/app/param-ownership.ts');
      const gate = new ActGate();
      const ownership = new ParamOwnership();
      assert.equal(gate.current(), null, '重启后无活跃链——不自动续播');
      assert.deepEqual(ownership.list(), [], '旧租约不复活（所有权登记表不持久化）');
      // 重走 admission：不再被已死链的优先级阻挡
      const adm = gate.admit({ priority: 'ambient', source: 'bp-lab-restart', steps: 2 });
      assert.equal(adm.accepted, true, '重启后 admission 全新判定（无残留优先级阻挡）');
      assert.equal(adm.source, 'bp-lab-restart');
    },
  },
  {
    name: 'corrupted-cache：脏条目被命中后经 invalidate 失效重读恢复',
    fn: async () => {
      const lab = seedLabDb({ dir: path.join(tmp, 'cache-corrupt') });
      let poisoned = false;
      const cache = createCompiledActionCache({
        capacity: 8,
        getVersion: (motionId) => lab.repo.listActionChains(motionId).length,
        load: (motionId, version) => lab.repo.getActionChain(motionId, version),
        compile: (chain) => (poisoned
          ? { corrupt: true, plans: null, skips: null }   // 手工写脏编译产物
          : compileActionPlan(chain, {}, () => null)),
      });
      const hash = lab.modelHashOf('bp-model-a');
      const motionId = lab.motions['bp.tail_sway_a'].motionId;
      poisoned = true;
      const dirty = await cache.resolve(hash, motionId);
      assert.equal(dirty.corrupt, true, '缓存不做命中校验（信任编译产物）——脏条目会被原样命中');
      poisoned = false;
      cache.invalidate(hash);                            // 恢复手段：显式失效
      const clean = await cache.resolve(hash, motionId);
      assert.equal(clean.corrupt, undefined);
      assert.deepEqual(clean.skips?.map((s) => s.reason).join('; '), clean.skips.map((s) => s.reason).join('; '));
      assert.equal(clean.plans.length, 0, '空通道映射 → 全部 fail-closed 跳过（干净产物）');
      assert.equal(cache.getStats().hits >= 0, true);
    },
  },
];

await standaloneIfMain(import.meta.url, async () => suite.run(cases));
export async function run() { return suite.run(cases); }
