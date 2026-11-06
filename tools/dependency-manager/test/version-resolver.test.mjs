// version-resolver.test.mjs — 纯逻辑：解析 / 比较 / 分级 / 范围判定（node:assert 形态）
import assert from 'node:assert';
import {
  parseVersion, compareVersions, diffLevel, satisfiesRange, satisfiesEngines,
} from '../version-resolver.mjs';

// parseVersion
assert.deepStrictEqual(parseVersion('1.2.3'), { major: 1, minor: 2, patch: 3, prerelease: [], raw: '1.2.3' });
assert.deepStrictEqual(parseVersion('v2.0.0-rc.1'), { major: 2, minor: 0, patch: 0, prerelease: ['rc', '1'], raw: '2.0.0-rc.1' });
assert.strictEqual(parseVersion('1.2'), null);
assert.strictEqual(parseVersion('abc'), null);
assert.strictEqual(parseVersion('01.2.3'), null);

// compareVersions
assert.strictEqual(compareVersions('1.2.3', '1.2.3'), 0);
assert.strictEqual(compareVersions('1.3.0', '1.2.9'), 1);
assert.strictEqual(compareVersions('0.9.9', '1.0.0'), -1);
// prerelease 低于对应 release（semver 规则，禁字符串比较糊弄）
assert.strictEqual(compareVersions('1.0.0-alpha', '1.0.0'), -1);
assert.strictEqual(compareVersions('1.0.0-alpha', '1.0.0-alpha.1'), -1);
assert.strictEqual(compareVersions('1.0.0-alpha.1', '1.0.0-beta'), -1);
assert.strictEqual(compareVersions('1.0.0-beta', '1.0.0-rc.1'), -1);
assert.strictEqual(compareVersions('1.0.0-2', '1.0.0-10'), -1); // 数值比较，非字典序
assert.strictEqual(compareVersions('1.0.0-1', '1.0.0-a'), -1);  // 数字 < 字符串

// diffLevel 分级
assert.deepStrictEqual(diffLevel('1.2.3', '1.2.3'), { level: 'latest', prerelease: false });
assert.deepStrictEqual(diffLevel('1.2.3', '2.0.0'), { level: 'major', prerelease: false });
assert.deepStrictEqual(diffLevel('1.2.3', '1.3.0'), { level: 'minor', prerelease: false });
assert.deepStrictEqual(diffLevel('1.2.3', '1.2.4'), { level: 'patch', prerelease: false });
assert.deepStrictEqual(diffLevel('1.2.3', '2.0.0-beta.1'), { level: 'major', prerelease: true });
assert.deepStrictEqual(diffLevel('6.3.1', '7.8.6'), { level: 'major', prerelease: false });
assert.strictEqual(diffLevel('1.2.3', 'garbage').level, 'unknown');

// satisfiesRange
assert.strictEqual(satisfiesRange('1.2.3', '^1.2.0'), true);
assert.strictEqual(satisfiesRange('2.0.0', '^1.2.0'), false);
assert.strictEqual(satisfiesRange('1.2.9', '~1.2.3'), true);
assert.strictEqual(satisfiesRange('1.3.0', '~1.2.3'), false);
assert.strictEqual(satisfiesRange('1.2.5', '>=1.2.3 <1.3.0'), true);
assert.strictEqual(satisfiesRange('1.3.0', '>=1.2.3 <1.3.0'), false);
assert.strictEqual(satisfiesRange('1.2.9', '1.2.x'), true);
assert.strictEqual(satisfiesRange('1.3.0', '1.2.x'), false);
assert.strictEqual(satisfiesRange('0.5.0', '^0.5.0 || ^1.0.0'), true);
assert.strictEqual(satisfiesRange('1.5.0', '^0.5.0 || ^1.0.0'), true);
assert.strictEqual(satisfiesRange('2.0.0', '^0.5.0 || ^1.0.0'), false);
assert.strictEqual(satisfiesRange('2.0.0-rc.1', '^1.0.0'), false); // prerelease 不跨界命中
assert.strictEqual(satisfiesRange('1.9.0', '*'), true);
assert.strictEqual(satisfiesRange('1.2.3', '1.2.3'), true);
assert.strictEqual(satisfiesRange('1.2.4', '1.2.3'), false);

// satisfiesEngines
assert.strictEqual(satisfiesEngines('22.22.2', '>=22'), true);
assert.strictEqual(satisfiesEngines('22.22.2', '>=20 <23'), true);
assert.strictEqual(satisfiesEngines('18.0.0', '>=22'), false);
assert.strictEqual(satisfiesEngines('22.22.2', undefined), true);

console.log('version-resolver.test.mjs PASS');
