/**
 * bridge 规则单源同步测试（参照 param-guards-core-sync 的做法）。
 *
 * 规则只有一份：lib/body-bridge.mjs。它被三处使用——宿主静态校验（body-bridge-api.mjs）、
 * overlay 占用权威（浏览器动态 import 同一文件）、MCP 工具描述（server.mjs）。本测试保证：
 *   1) body-bridge.mjs 能被浏览器直接当 ES 模块加载：没有 import / require / Node 全局；
 *   2) 它镜像的渲染端事实与真源一致：叠加输入名单 = param-injector.ts 的 ADDITIVE_INPUTS，
 *      成对动作共用手臂判定 = motion-director.ts 的 motionsShareArm，口型红线 ⊇ param-guards；
 *   3) overlay 与宿主都从这一份取规则，不再各写一份。
 * 运行：node --experimental-strip-types packages/dsh-l2d-plugin/lib/body-bridge-sync.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADDITIVE_INPUT_PARAMS, compileBodyTable, tableShareArm } from './body-bridge.mjs';
import { LIPSYNC_PARAMS } from './param-guards.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
const table = JSON.parse(read('docs/nodegraph/models/大肥鱼.dsl2d.2048/body-regions.json'));
const compiled = compileBodyTable(table);

// 1) 浏览器可直接加载
const core = read('packages/dsh-l2d-plugin/lib/body-bridge.mjs');
const code = core.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
assert.ok(!/^\s*import\s/m.test(code), 'body-bridge.mjs 不得 import（浏览器按单文件加载）');
assert.ok(!/\brequire\s*\(/.test(code), 'body-bridge.mjs 不得 require');
for (const g of ['process.', 'Buffer', '__dirname', 'node:']) assert.ok(!code.includes(g), 'body-bridge.mjs 不得依赖 Node：' + g);

// 2a) 叠加输入名单与 renderer injector 一致
const injector = read('packages/renderer/src/app/param-injector.ts');
const m = injector.match(/const ADDITIVE_INPUTS = new Set\(\[([\s\S]*?)\]\)/);
assert.ok(m, 'param-injector.ts 找不到 ADDITIVE_INPUTS（改名了？需同步 body-bridge.mjs）');
const injectorList = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
assert.deepEqual([...ADDITIVE_INPUT_PARAMS].sort(), injectorList.sort(), 'ADDITIVE_INPUT_PARAMS 与 renderer ADDITIVE_INPUTS 漂移');

// 2b) 共用手臂判定：表（motionArmConflicts）与 motion-director 一致
const director = await import(path.join(repoRoot, 'packages/renderer/src/app/motion-director.ts'));
const share = tableShareArm(compiled);
const groups = compiled.regions.hands.motions;
for (const x of groups) {
  for (const y of groups) {
    assert.equal(share(x, y), director.motionsShareArm(x, y), 'shareArm 漂移：' + x + ' / ' + y);
  }
}

// 2c) 口型红线：表的 lipSync ∪ lipSyncCatalog 覆盖 param-guards 名单
for (const id of LIPSYNC_PARAMS) assert.ok(compiled.redline.has(id), '口型红线缺 ' + id);

// 3) 单源：overlay 动态 import 同一文件；宿主发的就是 lib/body-bridge.mjs；宿主与 MCP import 它
const overlay = read('packages/dsh-l2d-plugin/lib/overlay.js');
assert.ok(overlay.includes("versioned('/dsh-l2d/body-bridge.mjs')"), 'overlay 应动态 import /dsh-l2d/body-bridge.mjs');
assert.ok(!overlay.includes('function validateBridgeCommand') && !overlay.includes('BRIDGE_PRIORITY_RANK'), 'overlay 不得再写一份 bridge 规则');
const index = read('packages/dsh-l2d-plugin/lib/index.js');
assert.ok(index.includes("path.join(PKG_ROOT, 'lib', 'body-bridge.mjs')"), 'index.js 应发 lib/body-bridge.mjs');
assert.ok(index.includes("route('/dsh-l2d/body-bridge.mjs'"), 'index.js 缺 /dsh-l2d/body-bridge.mjs 路由');
assert.ok(read('packages/dsh-l2d-plugin/lib/body-bridge-api.mjs').includes("from './body-bridge.mjs'"), '宿主校验应 import body-bridge.mjs');
assert.ok(read('packages/dsh-l2d-mcp/src/server.mjs').includes('body-bridge.mjs'), 'MCP 工具描述应来自 body-bridge.mjs');

console.log('body-bridge-sync ok');
