// manager.test.mjs — 编排门禁：未授权拒绝 / 互斥拒绝 / 授权后真实更新成功 + 审计完整
import assert from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DependencyManager, updateLocks, DEFAULT_CONFIG } from '../dependency-manager.mjs';
import { makeFixtureProject, npmInstallIn, readText } from './helpers.mjs';

const dataDir = mkdtempSync(join(tmpdir(), 'dsh-dep-mgr-'));
const latest = '7.8.6'; // 固定目标版本；若上游更新失败原因会体现在断言信息中

// —— 场景 1：默认配置（autoInstall=false / requireApproval=true）→ update 拒绝执行 ——
const proj1 = makeFixtureProject({ deps: { semver: '^6.3.1' } });
npmInstallIn(proj1);
const mgr1 = new DependencyManager({
  projectDir: proj1, dataDir, config: DEFAULT_CONFIG,
});
const pkg1Before = readText(join(proj1, 'package.json'));
await assert.rejects(
  () => mgr1.update('semver', latest, { skipCompatCheck: true }),
  (err) => err.code === 'DEPS_UNAUTHORIZED' && /not authorized/i.test(err.message),
);
assert.strictEqual(readText(join(proj1, 'package.json')), pkg1Before, 'unauthorized update must not touch files');

// —— 场景 2：同一包互斥 → 第二个并发请求拒绝 ——
updateLocks.set('semver', true);
try {
  await assert.rejects(
    () => mgr1.update('semver', latest, { approved: true, skipCompatCheck: true }),
    (err) => err.code === 'DEPS_MUTEX',
  );
} finally {
  updateLocks.delete('semver');
}

// —— 场景 3：显式批准（--approve 语义）→ 真实事务成功，审计行完整 ——
const res = await mgr1.update('semver', latest, { approved: true, skipCompatCheck: true, verify: () => ({ ok: true }) });
assert.strictEqual(res.ok, true, res.reason || '');
assert.match(res.oldVersion, /^6\./);
assert.strictEqual(res.newVersion, latest);
assert.strictEqual(JSON.parse(readText(join(proj1, 'package.json'))).dependencies.semver, latest);

const hist = mgr1.listAudit({});
assert.strictEqual(hist.length, 1);
const row = hist[0];
assert.strictEqual(row.result, 'success');
assert.strictEqual(row.pkg, 'semver');
assert.match(row.old_version, /^6\./);
assert.strictEqual(row.new_version, latest);
assert.ok(typeof row.duration_ms === 'number' && row.duration_ms >= 0);
assert.ok(row.backup_dir && row.ts && row.command);

// —— 场景 4：回滚最近一次成功更新 ——
const rb = await mgr1.rollback('semver', { approved: true });
assert.strictEqual(rb.ok, true);
assert.strictEqual(readText(join(proj1, 'package.json')), pkg1Before, 'rollback restores package.json byte-identical');

// —— 场景 5：配置门禁矩阵 ——
assert.strictEqual(DependencyManager.isAuthorized(DEFAULT_CONFIG, {}), false);
assert.strictEqual(DependencyManager.isAuthorized(DEFAULT_CONFIG, { approved: true }), true);
assert.strictEqual(DependencyManager.isAuthorized({ updatePolicy: { autoInstall: true, requireApproval: false } }, {}), true);
assert.strictEqual(DependencyManager.isAuthorized({ updatePolicy: { autoInstall: true, requireApproval: true } }, {}), false);

mgr1.close();
console.log('manager.test.mjs PASS');
