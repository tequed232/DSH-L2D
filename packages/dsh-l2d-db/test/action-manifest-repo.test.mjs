/**
 * OACA-2 动作注册表 Repository 测试（schema v12）。
 * 覆盖：首次发布 / 二次发布 demote / 幂等 / 被拒动作不入表 / capability stale / 外键级联。
 * 直跑：node --experimental-sqlite packages/dsh-l2d-db/test/action-manifest-repo.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.mjs';
import {
  manifestIdOf, publishBundleToDb, getPublishedAction, listPublishedActions,
  getCurrentManifest, markStaleByCapability, supersedeManifest,
} from '../src/action-manifest-repo.mjs';
import { SCHEMA_VERSION } from '../src/schema.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oaca2-manifest-repo-'));
const dbFile = path.join(tmp, 'bootstrap-state.sqlite');
const db = openDb({ path: dbFile });

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  [OK] ${name}`);
}

const MODEL = '大肥鱼.dsl2d.2048';

/** 编译产物形状（与 action-compiler bundle.actions[] 字段一致）。 */
function action(actionId, over = {}) {
  return {
    actionId,
    graphId: 'graph_' + actionId.replace(/\./g, '_'),
    category: 'head',
    triggers: ['interaction.' + actionId.split('.')[1]],
    priority: 'NORMAL',
    interruptible: true,
    parameters: { intensity: { type: 'number', min: 0, max: 1, default: 0.6 } },
    requiredControls: ['head.pitch'],
    requiresOwn: ['ParamAngleX'],
    graphHash: 'hash-' + actionId,
    status: 'compiled',
    ...over,
  };
}

function manifestFor(revision, actions) {
  return {
    manifestVersion: 1,
    modelId: MODEL,
    capabilityRevision: 'rcap-v1',
    compilerVersion: 'oaca-1.0.0',
    revision,
    compiledAt: '2026-11-20T00:00:00.000Z',
    actions: actions.map((a) => ({
      actionId: a.actionId, graphId: a.graphId, category: a.category, triggers: a.triggers,
      priority: a.priority, interruptible: a.interruptible, parameters: a.parameters,
      requiredControls: a.requiredControls, requiresOwn: a.requiresOwn || [],
      graphHash: a.graphHash ?? null, status: a.status,
    })),
  };
}

// ---- 0. 迁移到位：v12 表存在
test('v12 tables exist and schema version is 12', () => {
  assert.equal(SCHEMA_VERSION, 12);
  const n = db.prepare(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('action_manifests','compiled_actions')",
  ).get().n;
  assert.equal(n, 2);
  const applied = db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n;
  assert.equal(applied, 12);
});

// ---- 1. 首次发布：1 manifest + N actions，可读回并解析 JSON 列
test('first publish: one manifest + N compiled actions, JSON columns parsed', () => {
  const actions = [action('head.nod'), action('head.shake'), action('gaze.look')];
  const out = publishBundleToDb(db, {
    modelId: MODEL,
    capabilityRevision: 'rcap-v1',
    compilerVersion: 'oaca-1.0.0',
    revision: 1,
    manifest: manifestFor(1, actions),
    actions,
  });
  assert.equal(out.manifestId, manifestIdOf(MODEL, 1));
  assert.equal(out.revision, 1);
  assert.deepEqual(out.publishedActions, ['head.nod', 'head.shake', 'gaze.look']);

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM action_manifests').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM compiled_actions').get().n, 3);

  const one = getPublishedAction(db, { modelId: MODEL, actionId: 'gaze.look' });
  assert.ok(one);
  assert.equal(one.modelId, MODEL);
  assert.equal(one.status, 'published');
  assert.equal(one.graphId, 'graph_gaze_look');
  assert.deepEqual(one.triggers, ['interaction.look']);
  assert.deepEqual(one.requiresOwn, ['ParamAngleX']);
  assert.equal(one.parameters.intensity.default, 0.6, 'parameters_json 反序列化为对象');
  assert.equal(one.manifestId, manifestIdOf(MODEL, 1));
  assert.equal(one.capabilityRevision, 'rcap-v1');

  assert.equal(listPublishedActions(db, { modelId: MODEL }).length, 3);
  const current = getCurrentManifest(db, { modelId: MODEL });
  assert.equal(current.revision, 1);
  assert.equal(current.status, 'published');
  assert.equal(current.manifest.actions.length, 3, 'manifest_json 可完整回读');
  assert.equal(current.compilerVersion, 'oaca-1.0.0');
});

// ---- 2. 二次发布：旧 published → superseded，新 published，每模型仍只 1 条
test('second publish supersedes previous manifest (exactly one published per model)', () => {
  const actions = [action('head.nod'), action('head.tilt')];
  publishBundleToDb(db, {
    modelId: MODEL,
    capabilityRevision: 'rcap-v2',
    compilerVersion: 'oaca-1.0.0',
    revision: 2,
    manifest: manifestFor(2, actions),
    actions,
  });

  // 直接 SQL 断言：每模型仅一条 published（partial unique index 的语义事实）
  const publishedRows = db
    .prepare("SELECT manifest_id, revision FROM action_manifests WHERE model_id = ? AND status = 'published'")
    .all(MODEL);
  assert.equal(publishedRows.length, 1);
  assert.equal(publishedRows[0].revision, 2);

  const superseded = db
    .prepare("SELECT revision FROM action_manifests WHERE model_id = ? AND status = 'superseded'")
    .all(MODEL);
  assert.deepEqual(superseded.map((r) => r.revision), [1]);

  const current = getCurrentManifest(db, { modelId: MODEL });
  assert.equal(current.revision, 2);
  assert.equal(current.capabilityRevision, 'rcap-v2');

  // rev2 里没有 head.shake / gaze.look → 遗留行置 stale，不再出现在可派发集合
  const live = listPublishedActions(db, { modelId: MODEL }).map((a) => a.actionId);
  assert.deepEqual(live, ['head.nod', 'head.tilt']);
  assert.equal(getPublishedAction(db, { modelId: MODEL, actionId: 'head.shake' }).status, 'stale');
});

// ---- 3. 幂等：同 revision 重复发布不抛错、行数不变
test('republishing the same revision is idempotent (no throw, no extra rows)', () => {
  const before = {
    manifests: db.prepare('SELECT COUNT(*) AS n FROM action_manifests').get().n,
    actions: db.prepare('SELECT COUNT(*) AS n FROM compiled_actions').get().n,
  };
  const actions = [action('head.nod', { graphHash: 'hash-recompiled' }), action('head.tilt')];
  const out = publishBundleToDb(db, {
    modelId: MODEL,
    capabilityRevision: 'rcap-v2',
    compilerVersion: 'oaca-1.0.1',
    revision: 2,
    manifest: manifestFor(2, actions),
    actions,
  });
  assert.equal(out.revision, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM action_manifests').get().n, before.manifests);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM compiled_actions').get().n, before.actions);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM action_manifests WHERE model_id = ? AND status='published'").get(MODEL).n, 1);
  // 覆盖语义：字段按最新一次写入更新
  assert.equal(getPublishedAction(db, { modelId: MODEL, actionId: 'head.nod' }).graphHash, 'hash-recompiled');
  assert.equal(getCurrentManifest(db, { modelId: MODEL }).compilerVersion, 'oaca-1.0.1');
});

// ---- 3b. QA-F9：同 revision 重发且动作被移除 → 被移除动作也必须下线（stale）
test('republishing the same revision with fewer actions stales the removed ones (QA-F9)', () => {
  // 现状：rev2 的 published 集合 = {head.nod, head.tilt}
  assert.deepEqual(listPublishedActions(db, { modelId: MODEL }).map((a) => a.actionId), ['head.nod', 'head.tilt']);

  // 同 revision=2 再发一次，但只带 head.nod（编译收缩：tilt 被移除）
  const out = publishBundleToDb(db, {
    modelId: MODEL,
    capabilityRevision: 'rcap-v2',
    compilerVersion: 'oaca-1.0.0',
    revision: 2,
    manifest: manifestFor(2, [action('head.nod')]),
    actions: [action('head.nod')],
  });
  assert.deepEqual(out.publishedActions, ['head.nod']);
  assert.equal(getPublishedAction(db, { modelId: MODEL, actionId: 'head.tilt' }).status, 'stale', '被移除动作不能继续可派发');
  assert.deepEqual(listPublishedActions(db, { modelId: MODEL }).map((a) => a.actionId), ['head.nod']);
  // 行不删（审计保留），只是状态下线
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM compiled_actions WHERE model_id = ? AND action_id = ?').get(MODEL, 'head.tilt').n === 1);

  // 还原 rev2 全量，后续用例按原预期继续
  publishBundleToDb(db, {
    modelId: MODEL,
    capabilityRevision: 'rcap-v2',
    compilerVersion: 'oaca-1.0.0',
    revision: 2,
    manifest: manifestFor(2, [action('head.nod'), action('head.tilt')]),
    actions: [action('head.nod'), action('head.tilt')],
  });
  assert.deepEqual(listPublishedActions(db, { modelId: MODEL }).map((a) => a.actionId), ['head.nod', 'head.tilt']);
});

// ---- 4. 被拒动作不入 compiled_actions，但 manifest_json 里可审计
test('rejected actions stay out of compiled_actions but remain auditable in manifest_json', () => {
  const okAction = action('interaction.head_poke', { priority: 'FORCE' });
  const rejected = action('head.tilt', { status: 'rejected', graphHash: null, reason: 'validation-failed' });
  const out = publishBundleToDb(db, {
    modelId: MODEL,
    capabilityRevision: 'rcap-v3',
    compilerVersion: 'oaca-1.0.0',
    revision: 3,
    manifest: manifestFor(3, [okAction, rejected]),
    actions: [okAction, rejected],
  });
  assert.deepEqual(out.publishedActions, ['interaction.head_poke']);

  const row = db.prepare('SELECT status FROM compiled_actions WHERE model_id = ? AND action_id = ?').get(MODEL, 'head.tilt');
  assert.equal(row.status, 'stale', 'review 结论：被拒动作不写 published 行，旧行降级为 stale');
  assert.notEqual(row.status, 'published');

  const current = getCurrentManifest(db, { modelId: MODEL });
  const inManifest = current.manifest.actions.find((a) => a.actionId === 'head.tilt');
  assert.ok(inManifest, '被拒动作必须留在 manifest_json 中可审计');
  assert.equal(inManifest.status, 'rejected');
  assert.deepEqual(listPublishedActions(db, { modelId: MODEL }).map((a) => a.actionId), ['interaction.head_poke']);
});

// ---- 5. capability revision 变化 → 旧动作 stale，list 不再返回
test('markStaleByCapability stales actions with an older capability revision', () => {
  const out = markStaleByCapability(db, { modelId: MODEL, capabilityRevision: 'rcap-v9' });
  assert.equal(out.staled, 1, 'rcap-v3 的 1 条 published 动作被 stale');
  assert.deepEqual(listPublishedActions(db, { modelId: MODEL }), []);
  const row = getPublishedAction(db, { modelId: MODEL, actionId: 'interaction.head_poke' });
  assert.equal(row.status, 'stale');
  // 已 stale 的重复调用是空操作（幂等）
  assert.equal(markStaleByCapability(db, { modelId: MODEL, capabilityRevision: 'rcap-v9' }).staled, 0);
});

// ---- 6. supersedeManifest（测试/回滚用）
test('supersedeManifest demotes the currently published manifest', () => {
  const current = getCurrentManifest(db, { modelId: MODEL });
  assert.equal(supersedeManifest(db, { manifestId: current.manifestId }), true);
  assert.equal(getCurrentManifest(db, { modelId: MODEL }), null);
  assert.equal(supersedeManifest(db, { manifestId: current.manifestId }), false, '再次 supersede 幂等返回 false');
});

// ---- 7. 外键级联：删 manifest → 其动作行随之删除（foreign_keys=ON）
test('deleting a manifest cascades to its compiled actions', () => {
  const M2 = '丰川祥子.dsl2d.2048';
  const actions = [action('head.nod'), action('head.shake')];
  const out = publishBundleToDb(db, {
    modelId: M2,
    capabilityRevision: 'rcap-a',
    compilerVersion: 'oaca-1.0.0',
    revision: 1,
    manifest: manifestFor(1, actions),
    actions,
  });
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1, 'foreign_keys 必须开启');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM compiled_actions WHERE model_id = ?').get(M2).n, 2);
  db.prepare('DELETE FROM action_manifests WHERE manifest_id = ?').run(out.manifestId);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM compiled_actions WHERE model_id = ?').get(M2).n, 0);
});

// ---- 8. 入参守卫：非法 revision / 缺 modelId 直接拒绝（不写半行）
test('publish rejects invalid input without partial writes', () => {
  const before = db.prepare('SELECT COUNT(*) AS n FROM action_manifests').get().n;
  assert.throws(() => publishBundleToDb(db, { modelId: '', revision: 1, manifest: {}, actions: [] }), /modelId/);
  assert.throws(() => publishBundleToDb(db, { modelId: 'm-x', revision: 0, manifest: {}, actions: [] }), /revision/);
  assert.throws(() => publishBundleToDb(db, { modelId: 'm-x', revision: 1, manifest: {}, actions: 'nope' }), /actions/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM action_manifests').get().n, before);
  assert.equal(getPublishedAction(db, { modelId: 'm-x', actionId: 'a' }), null);
  assert.deepEqual(listPublishedActions(db, { modelId: 'm-x' }), []);
});

console.log(`\nOACA-2 动作注册表: ${passed} tests passed`);
try { db.close(); } catch { /* 忽略重复关闭 */ }
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows WAL 句柄延迟释放，忽略 */ }
