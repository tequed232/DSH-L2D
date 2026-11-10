import assert from 'node:assert/strict';
import {
  loadAccessoriesForModel,
  menuSlots,
  planAccessoryToggle,
  isAccessoryOn,
  itemParam,
  restValueForItem,
  normalizeAccessories,
} from './accessories-catalog.mjs';
import { handleCatalog } from './nodegraph-api.mjs';

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log('  ok  ' + name))
    .catch((err) => {
      console.error('  FAIL ' + name);
      throw err;
    });
}

console.log('饰品分组表读取与开关规划');

const loaded = loadAccessoriesForModel('大肥鱼.dsl2d.2048');

await test('从 body-regions.json 的 accessories 读取正式表', () => {
  assert.equal(loaded.source, 'body-regions');
  assert.ok(loaded.file && loaded.file.endsWith('body-regions.json'));
  assert.equal(loaded.accessories.slots.length, 12);
});

await test('12 槽全部 exclusive=false，空槽不进菜单，uncertain 不进菜单', () => {
  const slots = loaded.accessories.slots;
  assert.ok(slots.every((slot) => slot.exclusive === false));
  const menu = loaded.menuSlots;
  const ids = menu.map((slot) => slot.id);
  assert.deepEqual(ids, ['glasses', 'headwear', 'tail', 'shoes', 'skirt', 'chest-clothes', 'flowers', 'glints', 'mic-glow', 'money']);
  assert.ok(!ids.includes('ears'));
  assert.ok(!ids.includes('wings'));
  assert.equal(menuSlots(loaded.accessories).length, 10);
  const itemIds = menu.flatMap((slot) => slot.items.map((item) => item.id));
  assert.ok(!itemIds.includes('body-type') && !itemIds.some((id) => /uncertain|Clothes2|form/i.test(id)));
});

await test('眼镜两项都可规划为同时打开，不写另一件的 off', () => {
  const glasses = loaded.menuSlots.find((slot) => slot.id === 'glasses');
  const mono = glasses.items.find((item) => item.id === 'monocle');
  const black = glasses.items.find((item) => item.id === 'black-glasses');
  const a = planAccessoryToggle(glasses, mono, true);
  const b = planAccessoryToggle(glasses, black, true);
  assert.deepEqual(a.values, { key12: 1 });
  assert.deepEqual(b.values, { key11: 1 });
  assert.equal(Object.keys(a.values).length, 1);
});

await test('关闭一件只写它的 off，其它参数不动', () => {
  const glasses = loaded.menuSlots.find((slot) => slot.id === 'glasses');
  const mono = glasses.items.find((item) => item.id === 'monocle');
  const plan = planAccessoryToggle(glasses, mono, false);
  assert.deepEqual(plan.values, { key12: 0 });
});

await test('若某槽 exclusive=true，打开新件才会把同槽旧件写成 off', () => {
  const exclusiveGlasses = {
    id: 'glasses',
    exclusive: true,
    items: loaded.menuSlots.find((slot) => slot.id === 'glasses').items,
  };
  const mono = exclusiveGlasses.items.find((item) => item.id === 'monocle');
  const plan = planAccessoryToggle(exclusiveGlasses, mono, true);
  assert.equal(plan.values.key12, 1);
  assert.equal(plan.values.key11, 0);
});

await test('isAccessoryOn 按更接近 on/off 判断（裙长 on=-1 / off=1）', () => {
  const skirt = loaded.menuSlots.find((slot) => slot.id === 'skirt').items[0];
  assert.equal(isAccessoryOn(-1, skirt), true);
  assert.equal(isAccessoryOn(1, skirt), false);
  assert.equal(isAccessoryOn(0, skirt), false);
  const tail = loaded.menuSlots.find((slot) => slot.id === 'tail').items[0];
  assert.equal(isAccessoryOn(1, tail), true);
  assert.equal(isAccessoryOn(-1, tail), false);
  assert.equal(restValueForItem(tail) === 1, true);
  assert.equal(isAccessoryOn(restValueForItem(tail), tail), true);
});

await test('param 饰品用 ref 当参数（飘花/光点）', () => {
  const flower = loaded.menuSlots.find((slot) => slot.id === 'flowers').items[0];
  assert.equal(itemParam(flower), 'LittleFlower2');
  assert.deepEqual(planAccessoryToggle({ id: 'flowers', exclusive: false, items: [flower] }, flower, true).values, { LittleFlower2: 1 });
});

await test('handleCatalog 带上菜单用饰品槽，不含空槽', () => {
  const res = handleCatalog('大肥鱼.dsl2d.2048');
  assert.equal(res.status, 200);
  assert.equal(res.payload.ok, true);
  assert.ok(res.payload.accessories);
  assert.equal(res.payload.accessories.source, 'body-regions');
  const ids = (res.payload.accessories.slots || []).map((slot) => slot.id);
  assert.ok(ids.includes('glasses') && ids.includes('money'));
  assert.ok(!ids.includes('ears') && !ids.includes('wings'));
});

await test('非法 modelId 不穿越路径', () => {
  const bad = loadAccessoriesForModel('../x');
  assert.equal(bad.source, 'none');
  assert.equal(bad.warning, 'invalid-model-id');
});

await test('缺表时返回空菜单而不抛错', () => {
  const missing = loadAccessoriesForModel('大肥鱼.dsl2d.2048', { modelsDir: '/tmp/dsh-missing-models-dir' });
  assert.equal(missing.source, 'none');
  assert.deepEqual(missing.menuSlots, []);
  assert.equal(normalizeAccessories(null).slots.length, 0);
});

console.log('饰品分组表读取与开关规划 ok');
