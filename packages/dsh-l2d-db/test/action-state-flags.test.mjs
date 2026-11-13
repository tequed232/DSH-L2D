/**
 * Phase 1/2 · 动作三态语义测试（schema v13）。
 *
 * 直跑：node --experimental-sqlite packages/dsh-l2d-db/test/action-state-flags.test.mjs
 * 守的不变式：
 *   1. 三条语义互相独立（通过校验 / 真机跑过 / 人工批准），不许联动；
 *   2. 程序未变 → 重发布保留既有验证与批准；
 *   3. 程序变了（哪怕 graph 没变，只改参数默认值）→ 旧结论一律清零；
 *   4. 旧动作库写入可被冻结，且冻结时报出明确 code。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.mjs';
import {
  getActionState, getPublishedAction, programHashOf, publishBundleToDb,
  setApproved, setRuntimeVerified,
} from '../src/action-manifest-repo.mjs';

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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oaca-flags-'));
const db = openDb({ path: path.join(tmpDir, 'flags.sqlite') });

const MODEL = 'm-flags';
const ACTION = {
  actionId: 'head.nod',
  graphId: 'graph_head_nod',
  graphHash: 'gh-aaa',
  capabilityRevision: 'rTEST',
  priority: 'NORMAL',
  triggers: ['interaction.head_nod'],
  parameters: { intensity: { type: 'number', min: 0, max: 1, default: 0.6 } },
  requiresOwn: ['head.pitch'],
  status: 'compiled',
};

function publish(revision, action = ACTION) {
  return publishBundleToDb(db, {
    modelId: MODEL,
    capabilityRevision: 'rTEST',
    compilerVersion: 'oaca-test',
    revision,
    manifest: { manifestVersion: 1, modelId: MODEL, revision, actions: [action] },
    actions: [action],
  });
}

console.log('Phase 1/2 动作三态语义');

it('发布后三态默认独立：status=published / runtime=0 / approved=0 / programHash 非空', () => {
  publish(1);
  const state = getActionState(db, { modelId: MODEL, actionId: 'head.nod' });
  assert.equal(state.status, 'published');
  assert.equal(state.runtimeVerified, false);
  assert.equal(state.approved, false);
  assert.match(state.programHash, /^ph[0-9a-f]{24}$/);
});

it('置真机验证不改变 approved / status', () => {
  setRuntimeVerified(db, { modelId: MODEL, actionId: 'head.nod', verified: true });
  const state = getActionState(db, { modelId: MODEL, actionId: 'head.nod' });
  assert.equal(state.runtimeVerified, true);
  assert.equal(state.approved, false, 'approved 不得被联动');
  assert.equal(state.status, 'published');
});

it('置人工批准不改变 runtimeVerified', () => {
  setApproved(db, { modelId: MODEL, actionId: 'head.nod', approved: true });
  const state = getActionState(db, { modelId: MODEL, actionId: 'head.nod' });
  assert.equal(state.approved, true);
  assert.equal(state.runtimeVerified, true);
});

it('程序未变（重发布）→ 保留 runtimeVerified 与 approved', () => {
  publish(2);
  const state = getActionState(db, { modelId: MODEL, actionId: 'head.nod' });
  assert.equal(state.runtimeVerified, true, '同程序重发布不应丢掉验证章');
  assert.equal(state.approved, true);
});

it('程序变了（只改参数默认值，graph 未变）→ 旧结论清零', () => {
  const changed = {
    ...ACTION,
    parameters: { intensity: { type: 'number', min: 0, max: 1, default: 0.9 } },
  };
  assert.notEqual(programHashOf(changed), programHashOf(ACTION), '参数变了 programHash 必须变');
  publish(3, changed);
  const state = getActionState(db, { modelId: MODEL, actionId: 'head.nod' });
  assert.equal(state.runtimeVerified, false, '程序变了，真机验证章必须失效');
  assert.equal(state.approved, false, '程序变了，批准章必须失效');
  assert.equal(state.status, 'published', '但它仍是可派发状态');
});

it('运行时查询面（getPublishedAction）也带三态，避免调用方另拼 SQL', () => {
  const action = getPublishedAction(db, { modelId: MODEL, actionId: 'head.nod' });
  assert.equal(typeof action.runtimeVerified, 'boolean');
  assert.equal(typeof action.approved, 'boolean');
  assert.match(action.programHash, /^ph/);
});

it('旧动作库写入冻结：置环境变量后 createActionChain 抛 LEGACY_ACTIONS_FROZEN', async () => {
  const { createActionsRepository } = await import('../src/actions-repo.mjs');
  const repo = createActionsRepository(db, { snapshotDir: path.join(tmpDir, 'snap') });
  process.env.DSH_LEGACY_ACTIONS_FROZEN = '1';
  try {
    assert.throws(
      () => repo.createActionChain({}),
      (err) => err && err.code === 'LEGACY_ACTIONS_FROZEN',
      '冻结后写入必须抛出明确 code，而不是静默成功',
    );
  } finally {
    delete process.env.DSH_LEGACY_ACTIONS_FROZEN;
  }
  assert.equal(typeof repo.assertLegacyWritable, 'function', '冻结入口可被调用方探测');
});

db.close();
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log('');
if (process.exitCode) {
  console.error('action-state-flags: 存在失败');
  process.exit(1);
}
console.log(`action-state-flags: ${passed} 项全部通过`);
