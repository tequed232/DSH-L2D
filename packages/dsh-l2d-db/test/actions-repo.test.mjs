/**
 * P0-A Actions Lib Repository 测试：版本不可变 / 幂等 / 状态机 / 快照 / 拒绝留痕 / 执行历史
 * 运行：node packages/dsh-l2d-db/test/actions-repo.test.mjs
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { openDb } from '../src/db.mjs';
import { canonicalChainHash, createActionsRepository } from '../src/actions-repo.mjs';
import { upsertActionChain } from '../src/repo.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-actions-repo-'));
const db = openDb({ path: path.join(tmp, 'test.sqlite') });
const repo = createActionsRepository(db, { snapshotDir: path.join(tmp, 'motions') });

const chainV1 = {
  schemaVersion: '1.0',
  steps: [
    { index: 0, kind: 'pose', params: { rightArmAngle: 45 }, durationMs: 600, admission: 'step', capabilityId: 'gesture.right_finger' },
  ],
};
const provenance = {
  assets: [{ id: 'a1', sourceType: 'image', originalPath: '/x/1.png', contentHash: 'sha256:' + 'a'.repeat(64) }],
  analyses: [{ id: 'an1', assetId: 'a1', modelName: 'test-vlm', analysis: { action: 'wave' } }],
};

let passed = 0;
function ok(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1; }
}

console.log('P0-A Actions Lib Repository');

ok('createActionChain 创建 validated 动作并落链', () => {
  const r = repo.createActionChain({ semanticKey: 'test.wave', description: '挥手', chain: chainV1, provenance, sourceId: 'job-1' });
  assert.equal(r.status, 'created');
  assert.equal(repo.getMotion(r.motionId).status, 'validated');
  const c = repo.getActionChain(r.motionId);
  assert.equal(c.steps.length, 1);
  assert.equal(c.steps[0].kind, 'pose');
});

ok('Actions Lib：缺失或非法 durationMs 必须拒绝', () => {
  const missingDuration = { schemaVersion: '1.0', steps: [{ index: 0, kind: 'pose', params: {} }] };
  assert.throws(() => repo.createActionChain({ semanticKey: 'test.no_duration', description: '缺时长', chain: missingDuration, provenance }), /durationMs/);
  const invalidDuration = { schemaVersion: '1.0', steps: [{ index: 0, kind: 'pose', params: {}, durationMs: 30001 }] };
  assert.throws(() => repo.createActionChain({ semanticKey: 'test.bad_duration', description: '非法时长', chain: invalidDuration, provenance }), /durationMs/);
});

ok('R9 同键同内容 → 幂等 duplicate', () => {
  const r = repo.createActionChain({ semanticKey: 'test.wave', description: '挥手', chain: chainV1, provenance });
  assert.equal(r.status, 'duplicate');
});

ok('R9 同键不同内容 → VERSION_CONFLICT（不静默覆盖）', () => {
  const chainV1b = { schemaVersion: '1.0', steps: [{ index: 0, kind: 'look', params: { direction: 'up' }, durationMs: 300, admission: 'step', capabilityId: 'gesture.right_finger' }] };
  assert.throws(() => repo.createActionChain({ semanticKey: 'test.wave', description: '挥手', chain: chainV1b, provenance }), (e) => e.code === 'VERSION_CONFLICT');
});

ok('createActionChainVersion 乐观并发：错误 expectedVersion 拒绝', () => {
  const motion = repo.getMotionBySemanticKey('test.wave');
  const chainV2 = { schemaVersion: '1.0', steps: [{ index: 0, kind: 'pose', params: { rightArmAngle: 60 }, durationMs: 500, admission: 'step', capabilityId: 'gesture.right_finger' }] };
  const missingDuration = { schemaVersion: '1.0', steps: [{ index: 0, kind: 'pose', params: {} }] };
  assert.throws(() => repo.createActionChainVersion(motion.id, { chain: missingDuration }, motion.version), /durationMs/);
  assert.throws(() => repo.createActionChainVersion(motion.id, { chain: chainV2 }, 99), (e) => e.code === 'VERSION_CONFLICT');
});

ok('createActionChainVersion 正确版本号 → v2 创建且 v1 仍可读（不可变）', () => {
  const motion = repo.getMotionBySemanticKey('test.wave');
  const chainV2 = { schemaVersion: '1.0', steps: [{ index: 0, kind: 'pose', params: { rightArmAngle: 60 }, durationMs: 500, admission: 'step', capabilityId: 'gesture.right_finger' }] };
  const r = repo.createActionChainVersion(motion.id, { chain: chainV2, provenance }, motion.version);
  assert.equal(r.version, 2);
  const v1 = repo.getActionChain(motion.id, 1);
  assert.equal(v1.steps[0].params.rightArmAngle, 45); // v1 未被覆盖
  const v2 = repo.getActionChain(motion.id, 2);
  assert.equal(v2.steps[0].params.rightArmAngle, 60);
  assert.equal(repo.getActionChain(motion.id).steps[0].params.rightArmAngle, 60); // 省略版本=最新
});

ok('状态机：validated → draft 非法转换被拒绝', () => {
  const motion = repo.getMotionBySemanticKey('test.wave');
  assert.throws(() => repo.transitionActionChainStatus(motion.id, 99, 'deprecated', 'test', 'x'), (e) => e.code === 'VERSION_CONFLICT');
  assert.throws(() => repo.transitionActionChainStatus(motion.id, motion.version, 'draft', 'test', 'x'), (e) => e.code === 'ILLEGAL_TRANSITION');
});

ok('状态机：validated → deprecated 合法并留痕', () => {
  const motion = repo.getMotionBySemanticKey('test.wave');
  repo.transitionActionChainStatus(motion.id, motion.version, 'deprecated', 'test', 'retire');
  assert.equal(repo.getMotion(motion.id).status, 'deprecated');
  const logs = db.prepare("SELECT * FROM motion_status_log WHERE motion_id = ? AND to_status = 'deprecated'").all(motion.id);
  assert.equal(logs.length, 1);
});

ok('upsertActionChain 覆盖写已被封堵（R8 必修项）', () => {
  const motion = repo.getMotionBySemanticKey('test.wave');
  // 同内容幂等
  assert.doesNotThrow(() => upsertActionChain(db, {
    chainId: repo.getActionChain(motion.id, 1).id, motionId: motion.id,
    chain: chainV1, schemaVersion: '1.0', steps: chainV1.steps,
  }));
  // 不同内容 → 拒绝
  const chainV1b = { schemaVersion: '1.0', steps: [{ index: 0, kind: 'look', params: { direction: 'up' }, durationMs: 300, admission: 'step' }] };
  assert.throws(() => upsertActionChain(db, {
    chainId: repo.getActionChain(motion.id, 1).id, motionId: motion.id,
    chain: chainV1b, schemaVersion: '1.0', steps: chainV1b.steps,
  }), /禁止覆盖已有版本 chain_json/);
});

ok('R7 非 validated 不可导出快照', () => {
  const r = repo.createActionChain({ semanticKey: 'test.nod', description: '点头', chain: chainV1, provenance });
  repo.transitionActionChainStatus(r.motionId, 1, 'deprecated', 'test', 't');
  assert.throws(() => repo.exportActionSnapshot(r.motionId), (e) => e.code === 'SNAPSHOT_NOT_ALLOWED');
});

ok('R6/R7 validated 导出：文件存在、哈希与库内一致、路径登记', () => {
  const r = repo.createActionChain({ semanticKey: 'test.export', description: '导出', chain: chainV1, provenance, sourceId: 'job-e' });
  const snap = repo.exportActionSnapshot(r.motionId);
  assert.ok(fs.existsSync(snap.path));
  const chainRow = db.prepare('SELECT json_address, content_sha256 FROM action_chains WHERE id = ?').get(r.chainId);
  assert.equal(chainRow.json_address, snap.path);
  assert.equal(chainRow.content_sha256, snap.contentSha256);
  const written = JSON.parse(fs.readFileSync(snap.path, 'utf8'));
  delete written.contentSha256;
  const recomputed = 'sha256:' + createHash('sha256').update(JSON.stringify(written)).digest('hex');
  assert.equal(recomputed, snap.contentSha256);
  // R3 一版一件不可变
  assert.throws(() => repo.exportActionSnapshot(r.motionId), (e) => e.code === 'SNAPSHOT_EXISTS');
});

ok('R6 快照写入失败不产生伪成功状态', () => {
  const r = repo.createActionChain({ semanticKey: 'test.fail', description: '失败', chain: chainV1, provenance });
  // 制造失败：把快照目标目录变成文件
  const badRepo = createActionsRepository(db, { snapshotDir: path.join(tmp, 'blocked') });
  fs.writeFileSync(path.join(tmp, 'blocked'), 'not a dir');
  assert.throws(() => badRepo.exportActionSnapshot(r.motionId), (e) => e.code === 'SNAPSHOT_WRITE_FAILED');
  const row = db.prepare('SELECT json_address, content_sha256 FROM action_chains WHERE id = ?').get(r.chainId);
  assert.equal(row.json_address, null); // 库内无伪成功登记
});

ok('R10 拒绝记录可查询、可追溯，且不覆盖既有 validated', () => {
  const r = repo.recordRejectedAction(
    { semanticKey: 'test.reject', description: '坏链', chain: chainV1, code: 'SCHEMA_INVALID', sourceId: 'job-r' },
    'G1', 'steps 为空',
    provenance,
  );
  assert.equal(r.status, 'rejected');
  assert.equal(repo.getMotion(r.motionId).status, 'rejected');
  assert.ok(repo.listRejections({ semanticKey: 'test.reject' }).length >= 1);
  // 同键但已有 validated → 只留痕不动 validated
  const validated = repo.createActionChain({ semanticKey: 'test.keep', description: '保留', chain: chainV1, provenance });
  const r2 = repo.recordRejectedAction(
    { semanticKey: 'test.keep', chain: chainV1, code: 'X', sourceId: 'job-r2' }, 'G3', '能力缺失', null,
  );
  assert.equal(r2.status, 'rejected_logged');
  assert.equal(repo.getMotion(validated.motionId).status, 'validated');
  const job = db.prepare("SELECT * FROM learning_jobs WHERE source_id = 'job-r2'").get();
  assert.equal(job.state, 'failed');
});

ok('recordExecutionHistory：受控写入 + chainId 归属校验', () => {
  const r = repo.createActionChain({ semanticKey: 'test.exec', description: '执行', chain: chainV1, provenance });
  repo.recordExecutionHistory({ motionId: r.motionId, chainId: r.chainId, modelId: 'm1', status: 'completed', result: { ok: true } });
  const wrong = repo.createActionChain({ semanticKey: 'test.exec2', description: '其他', chain: chainV1, provenance });
  assert.throws(() => repo.recordExecutionHistory({ motionId: wrong.motionId, chainId: r.chainId, modelId: 'm1', status: 'completed' }), /不属于/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM execution_history WHERE motion_id = ?').get(r.motionId).n, 1);
});

ok('canonicalChainHash 与顺序无关的字段序列稳定', () => {
  const h1 = canonicalChainHash(chainV1);
  const h2 = canonicalChainHash(JSON.parse(JSON.stringify(chainV1)));
  assert.equal(h1, h2);
});

console.log(`\n结果：${process.exitCode ? '存在失败' : '全部通过'}（${passed} 项断言组）`);
if (process.exitCode) process.exit(1);
