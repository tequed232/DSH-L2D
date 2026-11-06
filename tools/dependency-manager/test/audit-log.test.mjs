// audit-log.test.mjs — 审计落库 / Token 脱敏 / 查询
import assert from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLog, redact } from '../audit-log.mjs';

// 脱敏
assert.strictEqual(redact('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456'), '[REDACTED]');
assert.strictEqual(redact('npm_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh'), '[REDACTED]');
assert.strictEqual(redact('github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ_1234567890'), '[REDACTED]');
assert.strictEqual(redact('--registry-auth-token=SECRETVAL').includes('SECRETVAL'), false);
assert.strictEqual(redact('install semver@7.8.6 --no-audit'), 'install semver@7.8.6 --no-audit'); // 普通命令不动
assert.strictEqual(redact(null), null);

// 落库与查询
const dir = mkdtempSync(join(tmpdir(), 'dsh-dep-audit-'));
const log = new AuditLog(join(dir, 'update-history.sqlite'));
log.record({
  projectDir: 'C:/proj', pkg: 'semver', oldVersion: '6.3.1', newVersion: '7.8.6',
  level: 'major', command: 'npm install semver@7.8.6 token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456',
  result: 'success', durationMs: 1234, backupDir: 'C:/backups/x', detail: { stage: 'verify' },
});
log.record({
  projectDir: 'C:/proj', pkg: 'is-odd', oldVersion: '3.0.1', newVersion: '3.0.1',
  result: 'rolled_back', durationMs: 456,
});

const rows = log.list({ projectDir: 'C:/proj' });
assert.strictEqual(rows.length, 2);
const [top, second] = rows; // id DESC
assert.strictEqual(top.pkg, 'is-odd');
assert.strictEqual(top.result, 'rolled_back');
assert.strictEqual(second.pkg, 'semver');
assert.strictEqual(second.old_version, '6.3.1');
assert.strictEqual(second.new_version, '7.8.6');
assert.strictEqual(second.level, 'major');
assert.strictEqual(second.duration_ms, 1234);
assert.ok(second.ts);
assert.ok(second.backup_dir);
assert.strictEqual(second.command.includes('ghp_'), false); // Token 未落库
assert.strictEqual(second.command, 'npm install semver@7.8.6 [REDACTED]');

// lastRecord 过滤
const last = log.lastRecord({ projectDir: 'C:/proj', pkg: 'semver', result: 'success' });
assert.strictEqual(last.new_version, '7.8.6');
assert.strictEqual(log.lastRecord({ projectDir: 'C:/proj', pkg: 'nope', result: 'success' }), null);

log.close();
console.log('audit-log.test.mjs PASS');
