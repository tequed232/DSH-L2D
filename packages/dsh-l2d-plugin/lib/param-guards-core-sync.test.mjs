/**
 * 口型禁区名单单源校验。
 *
 * 名单有四份历史拷贝：core 的 `LIPSYNC_PARAMS`（renderer 的真源）、host 的
 * `param-guards.mjs`、`index.js` 的 keyframe 过滤、`choreography.mjs` 的编排扫描。
 * 本测试保证插件侧全部来自 `param-guards.mjs`，且与 core 名单逐项一致——
 * 任何一处再抄一份（或改名）都会红。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIPSYNC_PARAMS } from './param-guards.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

// ---------------------------------------------------------------------------
// 1) 与 core 真源逐项一致
// ---------------------------------------------------------------------------
const coreIndex = read('packages/core/src/index.ts');
const match = coreIndex.match(/export const LIPSYNC_PARAMS\s*=\s*\[([^\]]*)\]/);
assert.ok(match, 'core/src/index.ts 里找不到 LIPSYNC_PARAMS 声明（也许被改名了，需同步）');
const coreList = [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
assert.ok(coreList.length > 0, 'core LIPSYNC_PARAMS 解析为空');
assert.deepEqual([...LIPSYNC_PARAMS].sort(), [...coreList].sort(), 'param-guards 与 core 口型名单漂移');

// 三项是设计常量：多一项少一项都属于契约变更，必须显式改这里。
assert.deepEqual([...LIPSYNC_PARAMS].sort(), ['ParamMouthForm', 'ParamMouthOpen', 'ParamMouthOpenY']);

// ---------------------------------------------------------------------------
// 2) 插件侧不再有第二份名单字面量（必须 import param-guards）
// ---------------------------------------------------------------------------
const pluginFiles = [
  'packages/dsh-l2d-plugin/lib/index.js',
  'packages/dsh-l2d-plugin/lib/choreography.mjs',
  'packages/dsh-l2d-plugin/lib/host-guard.mjs',
];
for (const file of pluginFiles) {
  const source = read(file);
  assert.ok(source.includes('param-guards.mjs'), file + ' 应从 param-guards.mjs 取口型名单');
  // 同一行里出现两项以上口型名 = 又抄了一份名单
  const lines = source.split('\n');
  for (const [index, line] of lines.entries()) {
    const hits = LIPSYNC_PARAMS.filter((name) => line.includes(name));
    assert.ok(hits.length < 2, file + ':' + (index + 1) + ' 出现口型名单字面量拷贝：' + hits.join(','));
  }
}

// index.js 的 keyframe 过滤只能通过 isReservedParam 判定
const indexSource = read('packages/dsh-l2d-plugin/lib/index.js');
assert.ok(!indexSource.includes('KEYFRAME_MOUTH_BLOCKLIST'), 'index.js 的旧名单常量应已删除');
assert.ok(indexSource.includes('isReservedParam'), 'index.js 应用 isReservedParam 判口型');

// choreography 的编排扫描必须遍历 LIPSYNC_PARAMS 而不是硬编码三项
const choreo = read('packages/dsh-l2d-plugin/lib/choreography.mjs');
assert.match(choreo, /for \(const key of LIPSYNC_PARAMS\)/, 'choreography 应遍历 LIPSYNC_PARAMS');

// ---------------------------------------------------------------------------
// 3) MCP 侧共用同一份（validate.mjs 通过 collectReservedParams 复用）
// ---------------------------------------------------------------------------
const mcpValidate = read('packages/dsh-l2d-mcp/src/validate.mjs');
assert.ok(mcpValidate.includes('param-guards.mjs'), 'MCP validate 应复用 param-guards');
assert.ok(!/'ParamMouthOpenY'/.test(mcpValidate), 'MCP validate 不应再写死口型名');

console.log('param-guards-core-sync ok');
