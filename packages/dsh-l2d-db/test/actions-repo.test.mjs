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

ok('Actions Lib：缺失或非法 durationMs 必须拒绝；链级 totalDurationMs>0（PR #27 收敛）', () => {
  const missingDuration = { schemaVersion: '1.0', steps: [{ index: 0, kind: 'pose', params: {} }] };
  assert.throws(() => repo.createActionChain({ semanticKey: 'test.no_duration', description: '缺时长', chain: missingDuration, provenance }), /durationMs/);
  const invalidDuration = { schemaVersion: '1.0', steps: [{ index: 0, kind: 'pose', params: {}, durationMs: 30001 }] };
  assert.throws(() => repo.createActionChain({ semanticKey: 'test.bad_duration', description: '非法时长', chain: invalidDuration, provenance }), /durationMs/);
  const allZero = { schemaVersion: '1.0', steps: [{ index: 0, kind: 'pose', params: {}, durationMs: 0 }] };
  assert.throws(() => repo.createActionChain({ semanticKey: 'test.zero_total', description: '全 0 链', chain: allZero, provenance }), /totalDurationMs/);
});

ok('Actions Lib：链级 totalDurationMs 含步间间隔并持久化进 validation_report', () => {
  const withDelay = { schemaVersion: '1.0', steps: [
    { index: 0, kind: 'look', params: { direction: 'left', delayMs: 120 }, durationMs: 400, admission: 'step' },
    { index: 1, kind: 'pose', params: { bodyAngleZ: 10 }, durationMs: 800, admission: 'step' },
  ] };
  const r = repo.createActionChain({ semanticKey: 'test.total_duration', description: '总时长', chain: withDelay, provenance });
  assert.equal(r.totalDurationMs, 1320, '400+120(步间间隔)+800');
  const row = repo.getActionChain(r.motionId);
  assert.equal(row.validationReport?.totalDurationMs, 1320, '链级总时长持久化进 validation_report');
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

// CODE-REVIEW-1 #1 回归：params 键序不同但内容相同 → 同一哈希（R9 幂等）
ok('canonicalChainHash 对 params 键序不敏感（同内容同哈希）', () => {
  const a = { schemaVersion: '1.0', steps: [{ index: 0, kind: 'expression', params: { name: '兔牙', ms: 100 } }] };
  const b = { schemaVersion: '1.0', steps: [{ index: 0, kind: 'expression', params: { ms: 100, name: '兔牙' } }] };
  assert.equal(canonicalChainHash(a), canonicalChainHash(b));
  // 嵌套对象同样规范化
  const c = { schemaVersion: '1.0', steps: [{ index: 0, kind: 'expression', params: { opts: { y: 1, x: 2 } } }] };
  const d = { schemaVersion: '1.0', steps: [{ index: 0, kind: 'expression', params: { opts: { x: 2, y: 1 } } }] };
  assert.equal(canonicalChainHash(c), canonicalChainHash(d));
  // 内容真的不同 → 哈希不同
  const e = { schemaVersion: '1.0', steps: [{ index: 0, kind: 'expression', params: { name: '兔牙', ms: 200 } }] };
  assert.notEqual(canonicalChainHash(a), canonicalChainHash(e));
});

// CODE-REVIEW-1 #1 回归：同键同内容但键序不同的重复提交应幂等 duplicate 而非 VERSION_CONFLICT
ok('R9 同键同内容（键序不同）→ 幂等 duplicate', () => {
  const first = { schemaVersion: '1.0', steps: [{ index: 0, kind: 'expression', params: { ms: 100, name: '兔牙', opts: { y: 1, x: 2 } }, durationMs: 100 }] };
  const reordered = { schemaVersion: '1.0', steps: [{ index: 0, kind: 'expression', params: { opts: { x: 2, y: 1 }, name: '兔牙', ms: 100 }, durationMs: 100 }] };
  const r1 = repo.createActionChain({ semanticKey: 'test.keyorder', description: '键序', chain: first, provenance });
  assert.equal(r1.status, 'created');
  const r2 = repo.createActionChain({ semanticKey: 'test.keyorder', description: '键序', chain: reordered, provenance });
  assert.equal(r2.status, 'duplicate');
});

// CODE-REVIEW-1 #3 回归：motion_sources 按分析声明的 assetId 配对（不按位置）
ok('provenance 分析按 assetId 归属关联（位置错序不张冠李戴）', () => {
  const aA = 'sha256:' + 'b'.repeat(64);
  const aB = 'sha256:' + 'c'.repeat(64);
  const prov = {
    assets: [
      { id: 'asset-A', sourceType: 'image', originalPath: '/x/a.png', contentHash: aA },
      { id: 'asset-B', sourceType: 'image', originalPath: '/x/b.png', contentHash: aB },
    ],
    analyses: [
      // 分析 1 声明属于 asset-B，分析 2 声明属于 asset-A —— 与 assets 顺序相反
      { id: 'an-B', assetId: 'asset-B', modelName: 'vlm', analysis: { which: 'B' } },
      { id: 'an-A', assetId: 'asset-A', modelName: 'vlm', analysis: { which: 'A' } },
    ],
  };
  const r = repo.createActionChain({ semanticKey: 'test.pairing', description: '配对', chain: chainV1, provenance: prov });
  const rows = db.prepare('SELECT ms.asset_id AS assetId, ms.analysis_id AS analysisId FROM motion_sources ms WHERE ms.motion_id = ?').all(r.motionId);
  const anRow = db.prepare("SELECT analysis_json FROM motion_analysis WHERE id = ?").get(rows.find((x) => x.assetId === 'asset-B')?.analysisId);
  assert.ok(anRow, 'asset-B 应有关联分析');
  assert.ok(anRow.analysis_json.includes('which'), '关联的分析应是声明属于 asset-B 的那条');
  const rowA = db.prepare("SELECT analysis_json FROM motion_analysis WHERE id = ?").get(rows.find((x) => x.assetId === 'asset-A')?.analysisId);
  assert.ok(rowA, 'asset-A 应有关联分析');
});

console.log(`\n结果：${process.exitCode ? '存在失败' : '全部通过'}（${passed} 项断言组）`);
if (process.exitCode) process.exit(1);
