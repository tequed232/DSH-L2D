// scan.test.mjs — 只读扫描：真实 registry 查询 + 分级识别 + 缓存落库
import assert from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DependencyManager } from '../dependency-manager.mjs';
import { makeFixtureProject, npmInstallIn } from './helpers.mjs';

const proj = makeFixtureProject({ deps: { semver: '^6.3.1', 'is-odd': '^3.0.1' } });
npmInstallIn(proj); // semver 无依赖、is-odd 仅小依赖，控制耗时

const dataDir = mkdtempSync(join(tmpdir(), 'dsh-dep-scan-'));
const mgr = new DependencyManager({ projectDir: proj, dataDir, config: { updatePolicy: { autoInstall: false, requireApproval: true } } });

const rows = await mgr.check();
assert.strictEqual(rows.length, 2);
const semverRow = rows.find((r) => r.pkg === 'semver');
const isOddRow = rows.find((r) => r.pkg === 'is-odd');

// semver: 6.x → 7.x 必为 major
assert.ok(semverRow.installed.startsWith('6.'), `installed=${semverRow.installed}`);
assert.ok(semverRow.latest.startsWith('7.'), `latest=${semverRow.latest}`);
assert.strictEqual(semverRow.level, 'major');
assert.strictEqual(semverRow.prerelease, false);

// is-odd ^3.0.1 已是最新（若上游发新版则允许 latest/major，不允许 unknown）
assert.ok(['latest', 'major', 'minor', 'patch'].includes(isOddRow.level), `level=${isOddRow.level}`);
assert.ok(!isOddRow.error, isOddRow.error);

// 缓存落库（dependency-cache.sqlite）
const cached = mgr.cache.latestScan(proj);
assert.strictEqual(cached.length, 2);
assert.ok(cached.every((r) => r.latest && r.level));

mgr.close();
console.log('scan.test.mjs PASS');
