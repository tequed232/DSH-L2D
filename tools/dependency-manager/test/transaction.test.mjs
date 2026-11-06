// transaction.test.mjs — 真实 npm 事务：备份存在性 / 安装成功提交 / 验证失败回滚（lockfile 字节级还原）
import assert from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLog } from '../audit-log.mjs';
import { runUpdateTransaction } from '../update-transaction.mjs';
import { verifyBackup } from '../rollback-manager.mjs';
import { latestVersion } from '../npm-registry.mjs';
import { makeFixtureProject, npmInstallIn, readText } from './helpers.mjs';

const dataDir = mkdtempSync(join(tmpdir(), 'dsh-dep-tx-'));
const audit = new AuditLog(join(dataDir, 'history.sqlite'));
const backupsRoot = join(dataDir, 'backups');
const latest = await latestVersion('semver'); // 小包，无依赖

// —— 场景 A：安装成功 → 提交 ——
const projA = makeFixtureProject({ deps: { semver: '^6.3.1' } });
npmInstallIn(projA); // 真实安装 semver@6.3.1，生成 package-lock.json
const pkgA0 = readText(join(projA, 'package.json'));
const lockA0 = readText(join(projA, 'package-lock.json'));

const resA = await runUpdateTransaction({
  projectDir: projA, pkg: 'semver', version: latest, backupsRoot, audit,
  verify: () => ({ ok: true }),
});
assert.strictEqual(resA.ok, true);
assert.match(resA.oldVersion, /^6\./); // ^6.3.1 实装 6.x 范围内最新（6.3.x）
assert.strictEqual(resA.newVersion, latest);

// 备份目录存在且完整性校验通过
const bakCheck = await verifyBackup(resA.backupDir);
assert.strictEqual(bakCheck.ok, true, `backup verify: ${bakCheck.reason}`);
assert.ok(bakCheck.manifest.files.some((f) => f.name === 'package.json'));
assert.ok(bakCheck.manifest.files.some((f) => f.name === 'package-lock.json'));

// package.json 已记录精确新版本
const pkgA1 = JSON.parse(readText(join(projA, 'package.json')));
assert.strictEqual(pkgA1.dependencies.semver, latest);
assert.notStrictEqual(readText(join(projA, 'package-lock.json')), lockA0);

// —— 场景 B：验证失败 → 回滚（package.json + lockfile 字节级还原）——
const projB = makeFixtureProject({ deps: { semver: '^6.3.1' } });
npmInstallIn(projB);
const pkgB0 = readText(join(projB, 'package.json'));
const lockB0 = readText(join(projB, 'package-lock.json'));

const resB = await runUpdateTransaction({
  projectDir: projB, pkg: 'semver', version: latest, backupsRoot, audit,
  verify: () => ({ ok: false, reason: 'intentional fixture failure' }),
});
assert.strictEqual(resB.ok, false);
assert.strictEqual(resB.stage, 'verify');
assert.strictEqual(resB.rolledBack, true, `rollback: ${resB.rollbackError}`);
assert.strictEqual(readText(join(projB, 'package.json')), pkgB0);
assert.strictEqual(readText(join(projB, 'package-lock.json')), lockB0);

// —— 审计行完整 ——
const rows = audit.list({ limit: 10 });
assert.strictEqual(rows.length, 2);
const successRow = rows.find((r) => r.result === 'success');
const rollbackRow = rows.find((r) => r.result === 'rolled_back');
assert.ok(successRow && rollbackRow);
for (const r of [successRow, rollbackRow]) {
  assert.ok(r.ts && r.pkg === 'semver' && r.command && typeof r.duration_ms === 'number' && r.backup_dir);
}
assert.strictEqual(successRow.new_version, latest);
assert.strictEqual(rollbackRow.new_version, latest);
assert.strictEqual(rollbackRow.detail.includes('intentional fixture failure'), true);
assert.strictEqual(rollbackRow.command.includes('ghp_'), false);

audit.close();
console.log('transaction.test.mjs PASS');
