/**
 * dsh-l2d-db · Model Adapter 测试（P1 验收：绑定 / 拒绝 / 版本兼容 / 差异检测）
 * 运行：node --experimental-sqlite packages/dsh-l2d-db/test/model-adapter.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.mjs';
import {
  upsertModel, upsertParameter, upsertNode, upsertMotionDefinition,
} from '../src/repo.mjs';
import {
  validateAdapterShape, registeredParamIds,
  bindMotionToModel, resolveMotionParams, diffModelParameterSets,
} from '../src/model-adapter.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-l2d-adapter-'));
const db = openDb({ path: path.join(tmp, 'bootstrap-state.sqlite') });

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  [OK] ${name}`);
}

// ---- fixture：合成模型 v1（含参数 A/B/C，A/B 带范围证据） ----
function registerModelVersion(modelId, params) {
  upsertModel(db, { modelId, sourcePath: `${modelId}.moc3`, packageHash: modelId.padEnd(64, '0') });
  for (const p of params) {
    const nodeId = upsertNode(db, { modelId, nodeKey: p.paramId, nodeType: 'Parameter', displayName: p.name });
    upsertParameter(db, {
      modelId, paramId: p.paramId, name: p.name,
      minValue: p.min ?? null, maxValue: p.max ?? null, nodeId,
    });
  }
}

registerModelVersion('model-v1', [
  { paramId: 'TailSeg0', name: '[0]尾巴', min: -30, max: 30 },
  { paramId: 'TailSeg1', name: '[1]尾巴', min: -30, max: 30 },
  { paramId: 'TailSwitch', name: '尾巴开关', min: 0, max: 1 },
]);
upsertMotionDefinition(db, { id: 'motion.tail', semanticKey: 'emotion.happy.tail_sway', description: '开心摇尾', status: 'draft' });

const GOOD_ADAPTER = {
  channels: {
    tail_sway: [
      { paramId: 'TailSeg0', weight: 1.0 },
      { paramId: 'TailSeg1', weight: 0.5 },
    ],
    tail_visible: [{ paramId: 'TailSwitch', weight: 1.0 }],
  },
};

// ---- 1. 一对多绑定成功 + adapter 形态校验函数 ----
test('bindMotionToModel: one semantic channel -> multiple params', () => {
  assert.deepEqual(validateAdapterShape(GOOD_ADAPTER), []);
  bindMotionToModel(db, { motionId: 'motion.tail', modelId: 'model-v1', adapter: GOOD_ADAPTER });
  const row = db.prepare("SELECT adapter_json, compatible FROM motion_model_bindings WHERE motion_id='motion.tail' AND model_id='model-v1'").get();
  assert.equal(row.compatible, 1);
  const parsed = JSON.parse(row.adapter_json);
  assert.equal(parsed.channels.tail_sway.length, 2); // 一个语义通道映射多个参数
});

// ---- 2. 未注册模型：明确拒绝（fail-closed，不伪造） ----
test('bindMotionToModel: unregistered model rejected with MODEL_UNREGISTERED', () => {
  try {
    bindMotionToModel(db, { motionId: 'motion.tail', modelId: 'ghost-model', adapter: GOOD_ADAPTER });
    assert.fail('应当拒绝');
  } catch (err) {
    assert.equal(err.code, 'MODEL_UNREGISTERED');
  }
  assert.equal(db.prepare("SELECT COUNT(*) n FROM motion_model_bindings WHERE model_id='ghost-model'").get().n, 0);
});

// ---- 3. 未映射参数：拒绝写入（P1 验收核心负向用例） ----
test('bindMotionToModel: unmapped param rejected with PARAM_UNMAPPED', () => {
  const bad = { channels: { tail_sway: [{ paramId: 'NotExistParam', weight: 1 }] } };
  try {
    bindMotionToModel(db, { motionId: 'motion.tail', modelId: 'model-v1', adapter: bad });
    assert.fail('应当拒绝');
  } catch (err) {
    assert.equal(err.code, 'PARAM_UNMAPPED');
    assert.deepEqual(err.unknown, ['tail_sway:NotExistParam']);
  }
  // 拒绝后原绑定不受影响
  assert.equal(db.prepare("SELECT compatible FROM motion_model_bindings WHERE motion_id='motion.tail'").get().compatible, 1);
});

// ---- 4. adapter 形态非法：空 channels / paramId 缺失 ----
test('adapter shape validation rejects malformed payload', () => {
  assert.ok(validateAdapterShape({}).length > 0);
  assert.ok(validateAdapterShape({ channels: {} }).length > 0);
  assert.ok(validateAdapterShape({ channels: { a: [] } }).length > 0);
  assert.ok(validateAdapterShape({ channels: { a: [{ paramId: ' ' }] } }).length > 0);
  assert.ok(validateAdapterShape({ channels: { a: [{ paramId: 'x', weight: 'high' }] } }).length > 0);
  try {
    bindMotionToModel(db, { motionId: 'motion.tail', modelId: 'model-v1', adapter: { channels: {} } });
    assert.fail('应当拒绝');
  } catch (err) {
    assert.equal(err.code, 'ADAPTER_SHAPE_INVALID');
  }
});

// ---- 5. 能力注册表注入：未注册模型被 checkModel 拦截 ----
test('capability registry checkModel gate (injected fail-closed)', () => {
  const fakeRegistry = {
    checkModel: (id) => (id === 'model-v1' ? { ok: true } : { ok: false, code: 'MODEL_UNREGISTERED' }),
  };
  // 通过
  bindMotionToModel(db, { motionId: 'motion.tail', modelId: 'model-v1', adapter: GOOD_ADAPTER, capabilityRegistry: fakeRegistry });
  // 拒绝
  try {
    bindMotionToModel(db, { motionId: 'motion.tail', modelId: 'model-v2', adapter: GOOD_ADAPTER, capabilityRegistry: fakeRegistry });
    assert.fail('应当拒绝');
  } catch (err) {
    assert.equal(err.code, 'MODEL_UNREGISTERED');
  }
});

// ---- 6. 正常解析：返回全部通道与参数 ----
test('resolveMotionParams: resolves all channels when binding intact', () => {
  const r = resolveMotionParams(db, { motionId: 'motion.tail', modelId: 'model-v1' });
  assert.equal(r.ok, true);
  assert.equal(Object.keys(r.channels).length, 2);
  assert.equal(r.channels.tail_sway.length, 2);
});

// ---- 7. 未绑定解析：MOTION_UNBOUND ----
test('resolveMotionParams: unbound motion -> MOTION_UNBOUND', () => {
  const r = resolveMotionParams(db, { motionId: 'motion.tail', modelId: 'no-bind-model' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'MOTION_UNBOUND');
});

// ---- 8. 版本兼容（P1 验收核心用例）：模型 v2 删掉 TailSeg1 后解析 fail-closed ----
test('model version drift: resolve fails closed and marks binding incompatible', () => {
  registerModelVersion('model-v2', [
    { paramId: 'TailSeg0', name: '[0]尾巴', min: -30, max: 30 },
    // TailSeg1 在 v2 中被移除；TailSwitch 保留
    { paramId: 'TailSwitch', name: '尾巴开关', min: 0, max: 1 },
  ]);
  // v2 未绑定 → 解析该绑定不存在
  assert.equal(resolveMotionParams(db, { motionId: 'motion.tail', modelId: 'model-v2' }).code, 'MOTION_UNBOUND');

  // 模拟：把 v1 绑定指向 v2（版本切换后绑定残留的常见场景）
  db.prepare("INSERT OR REPLACE INTO motion_model_bindings (motion_id, model_id, adapter_json, compatible, verified_at) VALUES ('motion.tail','model-v2', (SELECT adapter_json FROM motion_model_bindings WHERE motion_id='motion.tail' AND model_id='model-v1'), 1, datetime('now'))").run();

  const r = resolveMotionParams(db, { motionId: 'motion.tail', modelId: 'model-v2' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'STALE_BINDING');
  assert.deepEqual(r.stale, ['tail_sway:TailSeg1']);
  // 绑定已自动置 incompatible（版本漂移防护）
  assert.equal(db.prepare("SELECT compatible FROM motion_model_bindings WHERE motion_id='motion.tail' AND model_id='model-v2'").get().compatible, 0);
  // 再次解析 → BINDING_INCOMPATIBLE（不静默重试）
  const r2 = resolveMotionParams(db, { motionId: 'motion.tail', modelId: 'model-v2' });
  assert.equal(r2.ok, false);
  assert.equal(r2.code, 'BINDING_INCOMPATIBLE');
});

// ---- 9. 差异检测：added/removed/renamed/rangeChanged ----
test('diffModelParameterSets detects all four change kinds', () => {
  registerModelVersion('model-v3', [
    { paramId: 'TailSeg0', name: '[0]尾巴·改', min: -40, max: 40 }, // renamed + rangeChanged
    { paramId: 'TailSeg1', name: '[1]尾巴', min: -30, max: 30 },    // v3 重新加入（对 v2 是 added）
    { paramId: 'NewParam', name: '新参数' },                          // added
    // TailSwitch 移除（对 v2 是 removed）
  ]);
  const d = diffModelParameterSets(db, 'model-v2', 'model-v3');
  assert.deepEqual(d.added.sort(), ['NewParam', 'TailSeg1']);
  assert.deepEqual(d.removed, ['TailSwitch']);
  assert.ok(d.renamed.some((r) => r.paramId === 'TailSeg0' && r.from === '[0]尾巴' && r.to === '[0]尾巴·改'));
  assert.ok(d.rangeChanged.some((r) => r.paramId === 'TailSeg0' && r.from.max === 30 && r.to.max === 40));
});

// ---- 10. registeredParamIds 辅助函数 ----
test('registeredParamIds returns exact set', () => {
  const s = registeredParamIds(db, 'model-v1');
  assert.deepEqual([...s].sort(), ['TailSeg0', 'TailSeg1', 'TailSwitch']);
  assert.equal(registeredParamIds(db, 'absent-model').size, 0);
});

console.log(`\nmodel-adapter: ${passed} tests passed`);
db.close();
