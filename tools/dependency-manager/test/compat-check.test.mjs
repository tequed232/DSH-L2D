// compat-check.test.mjs — engines / peerDeps 冲突识别（纯逻辑部分）
import assert from 'node:assert';
import { checkNodeEngines, checkPeerDeps } from '../compat-check.mjs';

// engines
assert.strictEqual(checkNodeEngines({ node: '>=22' }, 'v22.22.2').ok, true);
assert.strictEqual(checkNodeEngines({ node: '<20' }, 'v22.22.2').ok, false);
assert.strictEqual(checkNodeEngines({}, 'v22.22.2').ok, true);
assert.strictEqual(checkNodeEngines({ node: '>=20 <23' }, 'v22.22.2').ok, true);

// peerDeps：无冲突
const r1 = checkPeerDeps({ react: '^18.0.0' }, {}, { react: '18.2.0' });
assert.strictEqual(r1.ok, true);
assert.deepStrictEqual(r1.conflicts, []);

// peerDeps：已装版本不满足范围
const r2 = checkPeerDeps({ react: '^18.0.0' }, {}, { react: '17.0.2' });
assert.strictEqual(r2.ok, false);
assert.strictEqual(r2.conflicts.length, 1);
assert.strictEqual(r2.conflicts[0].peer, 'react');
assert.match(r2.conflicts[0].reason, /17\.0\.2/);

// peerDeps：非可选 peer 缺失 → 冲突；可选 peer 缺失 → 不冲突
const r3 = checkPeerDeps({ typescript: '^5' }, {}, {});
assert.strictEqual(r3.ok, false);
assert.strictEqual(r3.conflicts[0].reason, 'peer missing and not optional');
const r4 = checkPeerDeps({ typescript: '^5' }, { typescript: { optional: true } }, {});
assert.strictEqual(r4.ok, true);

// peerDeps：不支持的范围写法 → 显式进冲突列表（不得默认通过）
const r5 = checkPeerDeps({ foo: 'workspace:*' }, {}, { foo: '1.0.0' });
assert.strictEqual(r5.ok, false);
assert.match(r5.conflicts[0].reason, /unsupported range syntax/);

// 多 peer 混合
const r6 = checkPeerDeps({ react: '^18.0.0', vue: '^3' }, {}, { react: '18.2.0' });
assert.strictEqual(r6.ok, false);
assert.strictEqual(r6.conflicts.length, 1);
assert.strictEqual(r6.conflicts[0].peer, 'vue');

console.log('compat-check.test.mjs PASS');
