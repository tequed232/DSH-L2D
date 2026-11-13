/**
 * OACA-2 同步桥测试（插件侧 action-registry-sync.mjs → DB 层 publishBundleToDb）。
 * 不调 LLM：直接构造 compileModelActions() 的返回值形状（bundle + published）。
 * 直跑：node --experimental-sqlite packages/dsh-l2d-db/test/action-registry-sync.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.mjs';
import { getCurrentManifest, getPublishedAction, listPublishedActions } from '../src/action-manifest-repo.mjs';
import { syncCompiledBundle } from '../../dsh-l2d-plugin/lib/action-registry-sync.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oaca2-registry-sync-'));
const db = openDb({ path: path.join(tmp, 'l2d-bridge.sqlite') });

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  [OK] ${name}`);
}

const MODEL = '大肥鱼.dsl2d.2048';

/** 模拟 compileModelActions 的返回（结构照 action-compiler.mjs 实际产出）。 */
function fakeResult({ revision, actions }) {
  return {
    ok: true,
    modelId: MODEL,
    capabilityRevision: 'rcap-abc123',
    bundle: {
      bundleVersion: 1,
      compilerVersion: 'oaca-1.0.0',
      modelId: MODEL,
      capabilityRevision: 'rcap-abc123',
      compiledAt: '2026-11-20T10:00:00.000Z',
      profileSource: 'tools/capability-scan/profile.json',
      actions,
      graphs: {},
    },
    summary: { requested: actions.length, compiled: actions.filter((a) => a.status === 'compiled').length, rejected: 0 },
    published: { ok: true, revision, dir: `/tmp/bundles/${MODEL}/rev-${revision}`, manifestHash: 'h', publishedActions: actions.filter((a) => a.status === 'compiled').map((a) => a.actionId) },
  };
}

function entry(actionId, over = {}) {
  return {
    actionId,
    graphId: 'graph_' + actionId.replace(/\./g, '_'),
    category: 'head',
    triggers: ['interaction.x'],
    priority: 'NORMAL',
    interruptible: true,
    parameters: { intensity: { type: 'number', min: 0, max: 1, default: 0.6 } },
    requiredControls: ['head.pitch'],
    requiresOwn: ['ParamAngleX'],
    graphHash: 'gh-' + actionId,
    status: 'compiled',
    layers: { schema: { status: 'pass' }, execution: { status: 'skipped', reason: 'deferred-to-oaca-4' } },
    instruction: '内部编译期字段，不应进入 manifest',
    ...over,
  };
}

// ---- 1. 未发布 → 不写库
test('not published: no DB writes, reason=not-published', () => {
  const draft = { ok: true, modelId: MODEL, bundle: { modelId: MODEL, actions: [entry('head.nod')], capabilityRevision: 'x' }, published: null };
  const out = syncCompiledBundle({ db, result: draft });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'not-published');
  assert.equal(getCurrentManifest(db, { modelId: MODEL }), null);
  assert.deepEqual(listPublishedActions(db, { modelId: MODEL }), []);

  const failed = syncCompiledBundle({ db, result: { ...draft, published: { ok: false, reason: 'no-valid-action' } } });
  assert.equal(failed.reason, 'not-published');
  assert.equal(getCurrentManifest(db, { modelId: MODEL }), null);
});

test('missing db or invalid result is rejected explicitly', () => {
  assert.deepEqual(syncCompiledBundle({ result: { bundle: { modelId: MODEL }, published: { revision: 1 } } }), { ok: false, reason: 'db-required' });
  assert.deepEqual(syncCompiledBundle({ db }), { ok: false, reason: 'invalid-result' });
  assert.deepEqual(syncCompiledBundle({ db, result: { bundle: null, published: { revision: 1 } } }), { ok: false, reason: 'invalid-bundle' });
});

// ---- 2. 发布成功：manifest 形状 + 只有 compiled 动作入表
test('published: manifest written with whitelisted fields, only compiled actions routable', () => {
  const result = fakeResult({
    revision: 1,
    actions: [entry('head.nod'), entry('gaze.look', { priority: 'BACKGROUND' }), entry('head.tilt', { status: 'rejected', graphHash: null, reason: 'validation-failed' })],
  });
  const out = syncCompiledBundle({ db, result });
  assert.equal(out.ok, true);
  assert.equal(out.revision, 1);
  assert.deepEqual(out.publishedActions, ['head.nod', 'gaze.look'], '被拒动作不进 compiled_actions');

  const current = getCurrentManifest(db, { modelId: MODEL });
  assert.equal(current.revision, 1);
  assert.equal(current.manifest.manifestVersion, 1);
  assert.equal(current.manifest.modelId, MODEL);
  assert.equal(current.manifest.capabilityRevision, 'rcap-abc123');
  assert.equal(current.manifest.compilerVersion, 'oaca-1.0.0');
  assert.equal(current.manifest.compiledAt, '2026-11-20T10:00:00.000Z');
  assert.equal(current.manifest.actions.length, 3, 'manifest 保留全量条目（含被拒，供审计）');

  const nod = current.manifest.actions.find((a) => a.actionId === 'head.nod');
  // QA-F6：白名单现在必须带四层校验结论（layers/errors/warnings），
  // 但编译期内部信息（instruction 等）仍不外泄。
  assert.deepEqual(Object.keys(nod).sort(), [
    'actionId', 'category', 'errors', 'graphHash', 'graphId', 'interruptible', 'layers',
    'parameters', 'priority', 'requiredControls', 'requiresOwn', 'status', 'triggers', 'warnings',
  ].sort(), 'manifest 必须带四层校验结论，且不带 instruction 等编译期内部字段');
  assert.equal(nod.status, 'compiled');
  assert.ok(!('instruction' in nod), '编译期 instruction 不外泄');
  // L4 execution 如实保留 skipped —— 绝不被改写成 pass
  assert.deepEqual(nod.layers.execution, { status: 'skipped', reason: 'deferred-to-oaca-4' });
  assert.equal(nod.layers.schema.status, 'pass');
  assert.deepEqual(nod.errors, []);

  const rejectedEntry = current.manifest.actions.find((a) => a.actionId === 'head.tilt');
  assert.equal(rejectedEntry.status, 'rejected');
  assert.equal(rejectedEntry.reason, 'validation-failed', 'F-6：被拒原因可审计');
  assert.ok(rejectedEntry.layers, 'F-6：被拒动作的四层结论同样保留');

  const gaze = getPublishedAction(db, { modelId: MODEL, actionId: 'gaze.look' });
  assert.equal(gaze.priority, 'BACKGROUND');
  assert.deepEqual(gaze.requiresOwn, ['ParamAngleX']);
  assert.equal(gaze.capabilityRevision, 'rcap-abc123');
});

// ---- 3. 第二次同步（rev2）：旧 manifest superseded，动作集合按新结果收敛
test('second sync supersedes rev1 and drops actions no longer compiled', () => {
  const result = fakeResult({ revision: 2, actions: [entry('head.nod', { graphHash: 'gh-v2' })] });
  const out = syncCompiledBundle({ db, result });
  assert.equal(out.ok, true);
  assert.equal(out.revision, 2);

  const current = getCurrentManifest(db, { modelId: MODEL });
  assert.equal(current.revision, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM action_manifests WHERE model_id = ? AND status='published'").get(MODEL).n, 1);

  assert.deepEqual(listPublishedActions(db, { modelId: MODEL }).map((a) => a.actionId), ['head.nod']);
  assert.equal(getPublishedAction(db, { modelId: MODEL, actionId: 'head.nod' }).graphHash, 'gh-v2');
  assert.equal(getPublishedAction(db, { modelId: MODEL, actionId: 'gaze.look' }).status, 'stale');
});

// ---- 4. 同 revision 重复同步幂等
test('re-syncing the same revision is idempotent', () => {
  const before = db.prepare('SELECT COUNT(*) AS n FROM compiled_actions').get().n;
  const result = fakeResult({ revision: 2, actions: [entry('head.nod'), entry('head.shake')] });
  syncCompiledBundle({ db, result });
  syncCompiledBundle({ db, result });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM compiled_actions').get().n, before + 1, 'head.shake 新增 1 行，head.nod 原地覆盖');
  assert.deepEqual(listPublishedActions(db, { modelId: MODEL }).map((a) => a.actionId), ['head.nod', 'head.shake']);
});

console.log(`\nOACA-2 同步桥: ${passed} tests passed`);
try { db.close(); } catch { /* 忽略重复关闭 */ }
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows WAL 句柄延迟释放，忽略 */ }
