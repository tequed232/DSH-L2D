/**
 * 触发层测试（schema v14）：emote 查表 + 区间不重叠 + no_match 兜底。
 * 直跑：node --experimental-sqlite packages/dsh-l2d-db/test/trigger-map.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.mjs';
import { getTriggerMap, resolveEmoteProgram, setTriggerMap } from '../src/trigger-map-repo.mjs';

let passed = 0;
function it(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err && err.message}`);
    process.exitCode = 1;
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oaca-trigger-'));
const db = openDb({ path: path.join(tmp, 't.sqlite') });
const M = 'm-trigger';

// fail-closed 校验要求命中的 programId 真实存在且 published——先发布测试程序
import { publishBundleToDb } from '../src/action-manifest-repo.mjs';
function publishProgram(programId, revision) {
  const action = {
    actionId: programId, graphId: `graph_${programId}`, graphHash: `gh-${programId}`,
    capabilityRevision: 'rT', priority: 'NORMAL', triggers: [], parameters: {}, requiresOwn: [],
    status: 'compiled',
  };
  publishBundleToDb(db, {
    modelId: M, capabilityRevision: 'rT', compilerVersion: 't', revision,
    manifest: { manifestVersion: 1, modelId: M, revision, actions: [action] },
    actions: [action],
  });
}
// 一次 bundle 发布全部程序（发布是收缩语义：每次发布只保留本次集合，
// 分开发布会让前面的程序变 stale）
{
  const ids = ['happy.light.v1', 'happy.strong.v1', 'shy.v1', 'shy.v2'];
  const actions = ids.map((id) => ({
    actionId: id, graphId: `graph_${id}`, graphHash: `gh-${id}`,
    capabilityRevision: 'rT', priority: 'NORMAL', triggers: [], parameters: {}, requiresOwn: [],
    status: 'compiled',
  }));
  publishBundleToDb(db, {
    modelId: M, capabilityRevision: 'rT', compilerVersion: 't', revision: 1,
    manifest: { manifestVersion: 1, modelId: M, revision: 1, actions },
    actions,
  });
}

console.log('v14 触发层');

it('写入映射并按 (emotion, intensity) 命中 programId', () => {
  const r = setTriggerMap(db, {
    modelId: M,
    version: 1,
    rules: [
      { emotion: 'happy', intensity: [0, 0.5], programId: 'happy.light.v1' },
      { emotion: 'happy', intensity: [0.5, 1], programId: 'happy.strong.v1' },
    ],
  });
  assert.equal(r.rules, 2);
  assert.equal(resolveEmoteProgram(db, { modelId: M, emotion: 'happy', intensity: 0.3 }).programId, 'happy.light.v1');
  assert.equal(resolveEmoteProgram(db, { modelId: M, emotion: 'happy', intensity: 0.9 }).programId, 'happy.strong.v1');
});

it('区间边界闭区间：0.5 命中后段（[0,0.5] 与 [0.5,1] 端点相接不算重叠）', () => {
  assert.equal(resolveEmoteProgram(db, { modelId: M, emotion: 'happy', intensity: 0.5 }).programId, 'happy.strong.v1');
});

it('未命中 / 未知情绪 / 非法 intensity → no_match，绝不回退实时规划', () => {
  assert.deepEqual(resolveEmoteProgram(db, { modelId: M, emotion: 'sad', intensity: 0.5 }), { match: false, reason: 'no_match' });
  assert.deepEqual(resolveEmoteProgram(db, { modelId: M, emotion: 'happy', intensity: 'high' }), { match: false, reason: 'no_match' });
  assert.deepEqual(resolveEmoteProgram(db, { modelId: 'unknown', emotion: 'happy', intensity: 0.5 }), { match: false, reason: 'no_match' });
});

it('同一 emotion 区间重叠 → 写入被拒（确定性前提）', () => {
  assert.throws(
    () => setTriggerMap(db, {
      modelId: M,
      version: 2,
      rules: [
        { emotion: 'angry', intensity: [0, 0.7], programId: 'a' },
        { emotion: 'angry', intensity: [0.5, 1], programId: 'b' },
      ],
    }),
    /重叠/,
  );
});

it('同 (modelId, version) 重写 = 整体替换（不留旧规则残影）', () => {
  setTriggerMap(db, {
    modelId: M,
    version: 3,
    rules: [{ emotion: 'shy', intensity: [0, 1], programId: 'shy.v1' }],
  });
  setTriggerMap(db, {
    modelId: M,
    version: 3,
    rules: [{ emotion: 'shy', intensity: [0, 1], programId: 'shy.v2' }],
  });
  assert.equal(resolveEmoteProgram(db, { modelId: M, emotion: 'shy', intensity: 0.5 }).programId, 'shy.v2');
  const map = getTriggerMap(db, { modelId: M });
  assert.equal(map.rules.length, 1, '旧规则必须被替换而非追加');
});

it('fail-closed：映射命中但程序不存在/不可派发 → no_match（账实一致）', () => {
  setTriggerMap(db, {
    modelId: M,
    version: 4,
    rules: [{ emotion: 'curious', intensity: [0, 1], programId: 'ghost.program.v1' }],
  });
  const r = resolveEmoteProgram(db, { modelId: M, emotion: 'curious', intensity: 0.5 });
  assert.equal(r.match, false, '指向不存在的程序必须放行为 no_match，不能宣称命中');
  assert.match(r.detail || '', /不可派发/);
});

it('getTriggerMap 取最大 version；无映射返回空', () => {
  const map = getTriggerMap(db, { modelId: M });
  assert.equal(map.version, 4);
  assert.deepEqual(getTriggerMap(db, { modelId: 'nobody' }), { version: 0, rules: [] });
});

db.close();
fs.rmSync(tmp, { recursive: true, force: true });

console.log('');
if (process.exitCode) {
  console.error('trigger-map: 存在失败');
  process.exit(1);
}
console.log(`trigger-map: ${passed} 项全部通过`);
