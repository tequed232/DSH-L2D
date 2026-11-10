/** MCP 部位联动工具描述：由分区表生成，写清每模块能做什么、可写参数。 */
import assert from 'node:assert/strict';
import {
  ACCESSORY_SET_DESCRIPTION,
  BRIDGE_CUTS,
  BRIDGE_ON_BUSY,
  CUT_DESCRIPTION,
  FACE_COMPOSE_DESCRIPTION,
  FACE_DESCRIBE_DESCRIPTION,
  FACE_VOCAB_DESCRIPTION,
  ON_BUSY_DESCRIPTION,
  loadCapabilitiesForDescription,
  regionsActDescription,
  REGIONS_GET_DESCRIPTION,
  REGIONS_RELEASE_DESCRIPTION,
} from './regions-tools.mjs';

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
// 衔接：三个 cut 取值各有中文用途说明；默认 blend；没有 when 别名
assert.deepEqual([...BRIDGE_CUTS], ['now', 'next', 'after']);
assert.deepEqual([...BRIDGE_ON_BUSY], ['reject', 'wait', 'blend']);
assert.match(CUT_DESCRIPTION, /now = 立刻切（情绪突变/);
assert.match(CUT_DESCRIPTION, /next = [^；]*说话停顿/);
assert.match(CUT_DESCRIPTION, /after = [^；]*不想打断/);
assert.match(CUT_DESCRIPTION, /600ms/);
assert.ok(!/when/.test(CUT_DESCRIPTION + ON_BUSY_DESCRIPTION));
assert.match(ON_BUSY_DESCRIPTION, /blend（默认）/);
assert.match(ON_BUSY_DESCRIPTION, /superseded/);
assert.ok(text.includes(CUT_DESCRIPTION));
// 饰品 / 神态能力写进描述
assert.match(text, /accessory（全部可同时佩戴）：[^\n]*monocle=单片眼镜/);
assert.match(text, /face compose 情绪维度：慵懒、挑逗/);
assert.match(text, /预设配方 mood：妩媚/);
assert.ok(['face-units.json', 'face-vocab.json'].includes(loaded.faceFile));
assert.match(ACCESSORY_SET_DESCRIPTION, /同时佩戴/);
assert.match(FACE_COMPOSE_DESCRIPTION, /contributions/);
assert.match(FACE_COMPOSE_DESCRIPTION, /LeanInput 属 torso/);
assert.match(FACE_VOCAB_DESCRIPTION, /face-units\.json/);
assert.match(FACE_DESCRIBE_DESCRIPTION, /反推/);
console.log('regions-tools ok');
