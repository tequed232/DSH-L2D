/**
 * P0-D Ingestion Pipeline G0—G4 集成测试：
 * 每门至少一个通过案例 + 一个拒绝案例；G2 覆盖 PAIRED_CLOSES；G3 覆盖 registry 缺失/未知能力；
 * G4 覆盖所有权冲突；门禁失败留痕；只有全部通过才 validated + 快照。
 * 运行：node packages/dsh-l2d-db/test/ingestion-pipeline.test.mjs
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.mjs';
import { createActionsRepository } from '../src/actions-repo.mjs';
import { loadCapabilityRegistry } from '../src/capability-registry.mjs';
import { createIngestionPipeline } from '../src/ingestion-pipeline.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pipeline-'));
const db = openDb({ path: path.join(tmp, 'test.sqlite') });
const repo = createActionsRepository(db, { snapshotDir: path.join(tmp, 'motions') });
const registry = loadCapabilityRegistry();
const pipeline = createIngestionPipeline({ repository: repo, registry });

const HASH = 'sha256:' + 'b'.repeat(64);
const provenance = {
  assets: [{ id: 'asset-1', sourceType: 'image', originalPath: '/g/1.png', contentHash: HASH }],
  analyses: [{ id: 'analysis-1', assetId: 'asset-1', modelName: 'vlm-x', analysis: { action: 'point' } }],
};
function validCandidate(overrides = {}) {
  return {
    semanticKey: 'test.point',
    description: '指向',
    modelId: registry.model.id,
    sourceId: 'job-p0',
    chain: {
      schemaVersion: '1.0',
      steps: [
        { index: 0, kind: 'motion', params: {}, durationMs: 1000, admission: 'step', capabilityId: 'gesture.right_finger' },
      ],
    },
    provenance,
    ...overrides,
  };
}

let passed = 0;
function ok(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1; }
}

console.log('P0-D Ingestion Pipeline G0—G4');

// ---- happy path（全部通过案例）----
ok('全门通过 → validated + 快照落盘 + json_address/哈希登记', () => {
  const r = pipeline.ingest(validCandidate());
  assert.equal(r.status, 'validated', `期望 validated，实际 ${r.status}: ${r.reason ?? ''}`);
  assert.ok(fs.existsSync(r.snapshot.path));
  const row = db.prepare('SELECT json_address, content_sha256 FROM action_chains WHERE id = ?').get(r.chainId);
  assert.equal(row.json_address, r.snapshot.path);
  assert.equal(row.content_sha256, r.snapshot.contentSha256);
  assert.equal(repo.getMotion(r.motionId).status, 'validated');
  const job = db.prepare("SELECT * FROM learning_jobs WHERE source_id = 'job-p0'").get();
  assert.equal(job.state, 'persisted');
});

ok('R9 幂等：同键同内容重复入库 → duplicate（不产生第二行）', () => {
  const r = pipeline.ingest(validCandidate());
  assert.equal(r.status, 'duplicate');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM motion_definitions WHERE semantic_key = ?').get('test.point').n, 1);
});

ok('同键不同内容 → version_conflict（不静默覆盖、不自动新建）', () => {
  const r = pipeline.ingest(validCandidate({
    chain: { schemaVersion: '1.0', steps: [{ index: 0, kind: 'motion', params: {}, durationMs: 800, admission: 'step', capabilityId: 'gesture.right_finger' }] },
  }));
  assert.equal(r.status, 'version_conflict');
  assert.equal(r.expectedVersion, 1);
});

// ---- G0 拒绝案例 ----
ok('G0：溯源缺失 → PROVENANCE_MISSING 且留痕', () => {
  const r = pipeline.ingest(validCandidate({ semanticKey: 'test.g0a', provenance: { assets: [], analyses: [] } }));
  assert.equal(r.status, 'rejected');
  assert.equal(r.gate, 'G0');
  assert.equal(r.code, 'PROVENANCE_MISSING');
  assert.ok(repo.listRejections({ semanticKey: 'test.g0a' }).length >= 1);
});

ok('G0：素材哈希非法 → ASSET_HASH_INVALID', () => {
  const r = pipeline.ingest(validCandidate({
    semanticKey: 'test.g0b',
    provenance: { assets: [{ id: 'a', sourceType: 'image', originalPath: '/x', contentHash: 'deadbeef' }], analyses: [{ id: 'x', assetId: 'a', modelName: 'm', analysis: {} }] },
  }));
  assert.equal(r.gate, 'G0');
  assert.equal(r.code, 'ASSET_HASH_INVALID');
});

ok('G0：分析引用未知素材 → PROVENANCE_INCOMPLETE', () => {
  const r = pipeline.ingest(validCandidate({
    semanticKey: 'test.g0c',
    provenance: { assets: provenance.assets, analyses: [{ id: 'x', assetId: 'ghost', modelName: 'm', analysis: {} }] },
  }));
  assert.equal(r.gate, 'G0');
  assert.equal(r.code, 'PROVENANCE_INCOMPLETE');
});

// ---- G1 拒绝案例 ----
ok('G1：index 不连续 → SCHEMA_INVALID', () => {
  const r = pipeline.ingest(validCandidate({
    semanticKey: 'test.g1',
    chain: { schemaVersion: '1.0', steps: [
      { index: 0, kind: 'pose', params: {}, durationMs: 100, admission: 'step', capabilityId: 'gesture.right_finger' },
      { index: 2, kind: 'pose', params: {}, durationMs: 100, admission: 'step', capabilityId: 'gesture.right_finger' },
    ] },
  }));
  assert.equal(r.gate, 'G1');
  assert.equal(r.code, 'SCHEMA_INVALID');
});

ok('G1：未知 schemaVersion → SCHEMA_VERSION_UNSUPPORTED', () => {
  const r = pipeline.ingest(validCandidate({ semanticKey: 'test.g1v', chain: { schemaVersion: '2.0', steps: validCandidate().chain.steps } }));
  assert.equal(r.gate, 'G1');
  assert.equal(r.code, 'SCHEMA_VERSION_UNSUPPORTED');
});

// ---- G2 拒绝案例（含 PAIRED_CLOSES）----
ok('G2：模型参数 ID 字面量（ParamAngleX）→ MODEL_PARAM_ID_IN_CHAIN（R1）', () => {
  const r = pipeline.ingest(validCandidate({
    semanticKey: 'test.g2a',
    chain: { schemaVersion: '1.0', steps: [
      { index: 0, kind: 'pose', params: { ParamAngleX: 30 }, durationMs: 100, admission: 'keyframe', capabilityId: 'gesture.right_finger' },
    ] },
  }));
  assert.equal(r.gate, 'G2');
  assert.equal(r.code, 'MODEL_PARAM_ID_IN_CHAIN');
});

ok('G2：PAIRED_CLOSES 单边开 → PAIRING_BROKEN', () => {
  const r = pipeline.ingest(validCandidate({
    semanticKey: 'test.g2b',
    chain: { schemaVersion: '1.0', steps: [
      { index: 0, kind: 'motion', params: {}, durationMs: 500, admission: 'gate', capabilityId: 'gesture.right_finger', pairing: { pairId: 'p1', role: 'open' } },
    ] },
  }));
  assert.equal(r.gate, 'G2');
  assert.equal(r.code, 'PAIRING_BROKEN');
});

ok('G2：配对顺序颠倒（先关后开）→ PAIRING_BROKEN', () => {
  const r = pipeline.ingest(validCandidate({
    semanticKey: 'test.g2c',
    chain: { schemaVersion: '1.0', steps: [
      { index: 0, kind: 'motion', params: {}, durationMs: 500, admission: 'gate', capabilityId: 'gesture.right_finger', pairing: { pairId: 'p1', role: 'close' } },
      { index: 1, kind: 'motion', params: {}, durationMs: 500, admission: 'gate', capabilityId: 'gesture.right_finger', pairing: { pairId: 'p1', role: 'open' } },
    ] },
  }));
  assert.equal(r.gate, 'G2');
  assert.equal(r.code, 'PAIRING_BROKEN');
});

ok('G2：合法开→关配对放行（PAIRED_CLOSES 正例）', () => {
  const r = pipeline.ingest(validCandidate({
    semanticKey: 'test.g2ok',
    chain: { schemaVersion: '1.0', steps: [
      { index: 0, kind: 'motion', params: {}, durationMs: 500, admission: 'gate', capabilityId: 'gesture.right_finger', pairing: { pairId: 'p1', role: 'open' } },
      { index: 1, kind: 'motion', params: {}, durationMs: 500, admission: 'gate', capabilityId: 'gesture.right_finger', pairing: { pairId: 'p1', role: 'close' } },
    ] },
  }));
  assert.equal(r.status, 'validated', `reason: ${r.reason ?? ''}`);
});

// ---- G3 拒绝案例 ----
ok('G3：registry 不可用 → REGISTRY_UNAVAILABLE（fail-closed，不放行）', () => {
  const dead = createIngestionPipeline({ repository: repo, registry: { status: 'unavailable', errors: ['simulated outage'], revision: null } });
  const r = dead.ingest(validCandidate({ semanticKey: 'test.g3a' }));
  assert.equal(r.gate, 'G3');
  assert.equal(r.code, 'REGISTRY_UNAVAILABLE');
  assert.ok(repo.listRejections({ semanticKey: 'test.g3a' }).length >= 1);
});

ok('G3：未注册能力 → CAPABILITY_UNREGISTERED', () => {
  const r = pipeline.ingest(validCandidate({
    semanticKey: 'test.g3b',
    chain: { schemaVersion: '1.0', steps: [{ index: 0, kind: 'motion', params: {}, durationMs: 100, admission: 'step', capabilityId: 'no.such.cap' }] },
  }));
  assert.equal(r.gate, 'G3');
  assert.equal(r.code, 'CAPABILITY_UNREGISTERED');
});

ok('G3：未注册模型 → MODEL_UNREGISTERED', () => {
  const r = pipeline.ingest(validCandidate({ semanticKey: 'test.g3c', modelId: 'unregistered.model' }));
  assert.equal(r.gate, 'G3');
  assert.equal(r.code, 'MODEL_UNREGISTERED');
});

ok('G3：声明参数越界 → PARAM_OUT_OF_RANGE（fixture registry）', () => {
  const fixture = JSON.stringify({
    schemaVersion: 1, sourceCommit: 'test', model: { id: 'm1' },
    entries: [{ id: 'test.cap', kind: 'pose', paramSemantics: { intensity: { type: 'number', min: 0, max: 1 } } }],
  });
  const fixtureReg = loadCapabilityRegistry({ raw: fixture });
  const p = createIngestionPipeline({ repository: repo, registry: fixtureReg });
  const r = p.ingest(validCandidate({
    semanticKey: 'test.g3d', modelId: 'm1',
    chain: { schemaVersion: '1.0', steps: [{ index: 0, kind: 'pose', params: { intensity: 42 }, durationMs: 100, admission: 'step', capabilityId: 'test.cap' }] },
    provenance,
  }));
  assert.equal(r.gate, 'G3');
  assert.equal(r.code, 'PARAM_OUT_OF_RANGE');
});

// ---- G4 拒绝案例 ----
ok('G4：同能力未配对重复占用 → PARAM_OWNERSHIP_CONFLICT', () => {
  const r = pipeline.ingest(validCandidate({
    semanticKey: 'test.g4',
    chain: { schemaVersion: '1.0', steps: [
      { index: 0, kind: 'motion', params: {}, durationMs: 500, admission: 'step', capabilityId: 'gesture.right_finger' },
      { index: 1, kind: 'motion', params: {}, durationMs: 500, admission: 'step', capabilityId: 'gesture.right_finger' },
    ] },
  }));
  assert.equal(r.gate, 'G4');
  assert.equal(r.code, 'PARAM_OWNERSHIP_CONFLICT');
});

ok('G4：配对步骤共享 pairId 不算冲突（正例已在 G2 覆盖）', () => {
  const logs = repo.listRejections({});
  assert.ok(logs.length >= 6, `拒绝留痕应累计，实际 ${logs.length}`);
});

ok('Pipeline 从未直写动作链表（源码静态核查）', () => {
  const src = fs.readFileSync(new URL('../src/ingestion-pipeline.mjs', import.meta.url), 'utf8');
  assert.ok(!/INSERT\s+INTO\s+action_chains/i.test(src), 'pipeline 不得含 action_chains 写语句');
  assert.ok(!/UPDATE\s+action_chains/i.test(src), 'pipeline 不得含 action_chains 更新语句');
  assert.ok(/repository\.createActionChain/.test(src), '提交必须经 Repository');
});

ok('MCP 越权写入核查：动作链表写点全仓库仅存在于 @dsh/db（R4）', () => {
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../../..');
  const offenders = [];
  const scanDirs = ['packages/dsh-l2d-mcp/src', 'packages/dsh-l2d-plugin/lib', 'packages/core/src', 'packages/renderer/src'];
  const writeRe = /(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(action_chains|motion_definitions|action_steps|motion_sources|model_capabilities)/i;
  for (const dir of scanDirs) {
    const abs = path.join(repoRoot, dir);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs, { recursive: true })) {
      if (!/\.(mjs|js|ts)$/.test(String(f))) continue;
      const p = path.join(abs, String(f));
      try {
        if (writeRe.test(fs.readFileSync(p, 'utf8'))) offenders.push(path.join(dir, String(f)));
      } catch { /* 跳过不可读 */ }
    }
  }
  assert.deepEqual(offenders, [], `以下文件越权直写动作链表：${offenders.join(', ')}`);
});

console.log(`\n结果：${process.exitCode ? '存在失败' : '全部通过'}（${passed} 项断言组）`);
if (process.exitCode) process.exit(1);
