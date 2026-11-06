/**
 * P0-C Capability Registry 测试：加载真实 registry.json / fail-closed / 参数范围正反例
 * 运行：node packages/dsh-l2d-db/test/capability-registry.test.mjs
 */
import assert from 'node:assert';
import { loadCapabilityRegistry, validateRegistryDocument, defaultRegistryPath } from '../src/capability-registry.mjs';

let passed = 0;
function ok(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1; }
}

console.log('P0-C Capability Registry');

ok('真实 registry.json 正确加载（现有数据源，不另建）', () => {
  const reg = loadCapabilityRegistry();
  assert.equal(reg.status, 'available');
  assert.ok(reg.revision && reg.revision.length > 0);
  assert.ok(reg.model.id && reg.model.id.length > 0);
  assert.ok(reg.has('gesture.right_finger'), '实测首条能力应存在');
  assert.ok(reg.list().length > 0);
});

ok('未注册模型明确拒绝', () => {
  const reg = loadCapabilityRegistry();
  assert.equal(reg.checkModel(reg.model.id).ok, true);
  const r = reg.checkModel('some.other.model');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'MODEL_UNREGISTERED');
});

ok('未注册能力 fail-closed', () => {
  const reg = loadCapabilityRegistry();
  const r = reg.checkStep({ capabilityId: 'totally.unknown', durationMs: 100, admission: 'step' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'CAPABILITY_UNREGISTERED');
});

ok('已注册能力 + 合法时长放行（正例）', () => {
  const reg = loadCapabilityRegistry();
  const r = reg.checkStep({ capabilityId: 'gesture.right_finger', durationMs: 1000, admission: 'step', params: {} });
  assert.equal(r.ok, true);
});

ok('时长越界拒绝（素材时长 ×10 上限）', () => {
  const reg = loadCapabilityRegistry();
  const r = reg.checkStep({ capabilityId: 'gesture.right_finger', durationMs: 999999, admission: 'step' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'DURATION_OUT_OF_RANGE');
});

ok('registry 文件缺失 → unavailable（fail-closed）', () => {
  const reg = loadCapabilityRegistry({ registryPath: '/nonexistent/registry.json' });
  assert.equal(reg.status, 'unavailable');
  assert.equal(reg.checkStep({ capabilityId: 'anything' }).ok, false);
  assert.equal(reg.checkStep({ capabilityId: 'anything' }).code, 'REGISTRY_UNAVAILABLE');
});

ok('registry JSON 损坏 → unavailable', () => {
  const reg = loadCapabilityRegistry({ raw: '{ not valid json !!!' });
  assert.equal(reg.status, 'unavailable');
});

ok('registry Schema 不匹配 → invalid（fail-closed）', () => {
  const bad = JSON.stringify({ schemaVersion: 99, model: {}, sourceCommit: 'x', entries: [] });
  const reg = loadCapabilityRegistry({ raw: bad });
  assert.equal(reg.status, 'invalid');
  assert.ok(reg.errors.length > 0);
  assert.equal(reg.checkStep({ capabilityId: 'x' }).code, 'REGISTRY_UNAVAILABLE');
});

ok('文档校验：缺 entries / 缺 model.id / controlledParams 字段漂移均报错', () => {
  assert.ok(validateRegistryDocument(null).length > 0);
  assert.ok(validateRegistryDocument({ schemaVersion: 1, sourceCommit: 'c', entries: [] }).some((e) => e.includes('model.id')));
  assert.ok(validateRegistryDocument({
    schemaVersion: 1, sourceCommit: 'c', model: { id: 'm' },
    entries: [{ id: 'a', kind: 'motion', controlledParams: [{ id: 1, min: 'x', max: 0 }] }],
  }).length > 0);
});

ok('paramSemantics 声明参数的范围校验（正反例，fixture）', () => {
  const fixture = JSON.stringify({
    schemaVersion: 1, sourceCommit: 'test', model: { id: 'm1' },
    entries: [{
      id: 'test.cap', kind: 'pose', label: '测试',
      paramSemantics: { intensity: { type: 'number', min: 0, max: 1 }, label: { type: 'string' } },
    }],
  });
  const reg = loadCapabilityRegistry({ raw: fixture });
  assert.equal(reg.status, 'available');
  // 正例
  assert.equal(reg.checkStep({ capabilityId: 'test.cap', durationMs: 100, params: { intensity: 0.5, label: 'x' } }).ok, true);
  // 越界反例
  const over = reg.checkStep({ capabilityId: 'test.cap', durationMs: 100, params: { intensity: 1.5 } });
  assert.equal(over.code, 'PARAM_OUT_OF_RANGE');
  // 类型反例
  const badType = reg.checkStep({ capabilityId: 'test.cap', durationMs: 100, params: { intensity: 'high' } });
  assert.equal(badType.code, 'PARAM_TYPE_INVALID');
});

ok('默认路径解析落在仓库 tools/w3-registry/registry.json', () => {
  assert.ok(defaultRegistryPath().replace(/\\/g, '/').endsWith('tools/w3-registry/registry.json'));
});

console.log(`\n结果：${process.exitCode ? '存在失败' : '全部通过'}（${passed} 项断言组）`);
if (process.exitCode) process.exit(1);
