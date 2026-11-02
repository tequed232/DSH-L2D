import assert from 'node:assert/strict';
import {
  LIPSYNC_PARAMS,
  collectReservedParams,
  isReservedParam,
} from './param-guards.mjs';

// 名单：与 core/src/index.ts 的 LIPSYNC_PARAMS 保持同一份。
assert.deepEqual([...LIPSYNC_PARAMS], ['ParamMouthOpenY', 'ParamMouthOpen', 'ParamMouthForm']);
assert.equal(isReservedParam('ParamMouthOpenY'), true);
assert.equal(isReservedParam('ParamMouthForm'), true);
assert.equal(isReservedParam('AngleX'), false);
assert.equal(isReservedParam(''), false);
assert.equal(isReservedParam(null), false);

// 1) 以参数名为键的对象（l2d_set_parameters 的 values）。
assert.deepEqual(
  collectReservedParams({ values: { ParamMouthOpenY: 0.8, AngleX: 3 } }),
  ['ParamMouthOpenY'],
);
assert.deepEqual(collectReservedParams({ ParamMouthForm: 1 }), ['ParamMouthForm']);

// 2) 以参数名为字符串值（keyframes tracks / 动作链字段）。
assert.deepEqual(
  collectReservedParams([{ param: 'ParamMouthOpenY', keys: [[0, 0.2]] }]),
  ['ParamMouthOpenY'],
);
assert.deepEqual(collectReservedParams({ name: 'ParamMouthOpen' }), ['ParamMouthOpen']);

// 3) 嵌套、数组、混合：去重且只报口型。
const nested = {
  a: [{ b: { c: 'ParamMouthForm' } }, { d: ['ParamMouthOpenY', 'AngleY'] }],
  e: { ParamMouthOpen: 'x' },
};
assert.deepEqual(collectReservedParams(nested).sort(), ['ParamMouthForm', 'ParamMouthOpen', 'ParamMouthOpenY']);

// 4) 干净入参 → 空数组（不能误报）。
assert.deepEqual(collectReservedParams({ chain: [{ kind: 'look', x: 0.2, y: -0.1 }] }), []);
assert.deepEqual(collectReservedParams(null), []);
assert.deepEqual(collectReservedParams(42), []);
assert.deepEqual(collectReservedParams('ParamMouthOpenY'), ['ParamMouthOpenY']);

// 5) 环引用不炸（渲染端/调用方可能传复用对象）。
const cyclic = { values: {} };
cyclic.values.self = cyclic;
assert.deepEqual(collectReservedParams(cyclic), []);
const cyclicHit = { values: { ParamMouthOpenY: 1 } };
cyclicHit.values.self = cyclicHit;
assert.deepEqual(collectReservedParams(cyclicHit), ['ParamMouthOpenY']);

// 6) 深度上限：超过 maxDepth 不再深入（防恶意深嵌套）。
let deep = { v: 'ParamMouthOpenY' };
for (let i = 0; i < 20; i++) deep = { child: deep };
assert.deepEqual(collectReservedParams(deep, { maxDepth: 3 }), []);
assert.deepEqual(collectReservedParams(deep, { maxDepth: 30 }), ['ParamMouthOpenY']);

console.log('param-guards ok');
