/** MCP 部位联动工具描述：由分区表生成，写清每模块能做什么、可写参数。 */
import assert from 'node:assert/strict';
import { loadCapabilitiesForDescription, regionsActDescription, REGIONS_GET_DESCRIPTION, REGIONS_RELEASE_DESCRIPTION } from './regions-tools.mjs';

const loaded = loadCapabilitiesForDescription({ modelId: '大肥鱼.dsl2d.2048' });
assert.ok(loaded, '应能读到仓库里的分区表');
assert.equal(loaded.modelId, '大肥鱼.dsl2d.2048');
const text = regionsActDescription(loaded);
for (const name of ['hair', 'face', 'hands', 'torso', 'legs', 'expression', 'form']) assert.ok(text.includes('- ' + name), '描述缺模块 ' + name);
assert.match(text, /hands（手部）：动作 抚胸手打开/);
assert.match(text, /legs（腿部）：无动作；可写参数 Clothes4/);
assert.match(text, /LeanInput/);
assert.ok(!/- face[^\n]*ParamMouthOpenY/.test(text), '口型红线参数不得出现在 face 可写列表里');
for (const reason of ['region-busy', 'param-not-writable', 'motion-not-in-region', 'expression-conflict', 'lipsync-redline', 'unknown-region']) {
  assert.ok(text.includes(reason), '描述缺原因码 ' + reason);
}
// 表不存在时退化为通用说明，不抛
assert.equal(loadCapabilitiesForDescription({ modelsDir: '/nonexistent-dir' }), null);
assert.ok(regionsActDescription(null).includes('hands'));
assert.ok(REGIONS_GET_DESCRIPTION.includes('capabilities'));
assert.ok(REGIONS_RELEASE_DESCRIPTION.includes('commandId'));
console.log('regions-tools ok');
