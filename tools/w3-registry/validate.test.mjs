#!/usr/bin/env node
/**
 * W3 Registry 校验器自测。
 *
 * 正例：真实 registry.json 必须通过。
 * 负例：对副本做定点破坏，校验器必须报错/告警——证明它不是「永远 PASS」的摆设。
 *
 * 运行：node tools/w3-registry/validate.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { validateRegistry } from './validate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY = JSON.parse(fs.readFileSync(path.join(HERE, 'registry.json'), 'utf8'));
const clone = () => JSON.parse(JSON.stringify(REGISTRY));

let passed = 0;
let failed = 0;
const cases = [];

function check(name, fn) {
  try {
    fn();
    passed++;
    cases.push({ name, ok: true });
    console.log(`  PASS ${name}`);
  } catch (e) {
    failed++;
    cases.push({ name, ok: false, error: e.message });
    console.log(`  FAIL ${name}: ${e.message}`);
  }
}

function expectErrors(result, pattern, label) {
  assert.equal(result.ok, false, label + ' 应当失败');
  assert.ok(
    result.errors.some((e) => pattern.test(e)),
    label + ' 报错不符合预期，实际: ' + result.errors.join(' | '),
  );
}

console.log('[w3-registry test] 正例');
check('真实 registry 校验通过', () => {
  const r = validateRegistry(REGISTRY);
  assert.equal(r.ok, true, 'errors: ' + r.errors.join(' | '));
  assert.equal(r.errors.length, 0);
  assert.equal(r.warnings.length, 0, 'warnings: ' + r.warnings.join(' | '));
});

console.log('[w3-registry test] 负例');
check('篡改动作时长会被抓到', () => {
  const r = clone();
  const entry = r.entries.find((e) => e.kind === 'motion-pair');
  entry.assets[0].durationMs += 500;
  expectErrors(validateRegistry(r), /durationMs/, '时长篡改');
});

check('漏登记动作曲线参数会被抓到', () => {
  const r = clone();
  const entry = r.entries.find((e) => e.kind === 'motion-pair');
  entry.controlledParams = entry.controlledParams.slice(0, 2);
  expectErrors(validateRegistry(r), /漏登记成对曲线参数/, '漏登记');
});

check('登记不存在的参数会被抓到', () => {
  const r = clone();
  const entry = r.entries.find((e) => e.kind === 'expression');
  entry.controlledParams[0].id = 'NoSuchParam_xyz';
  expectErrors(validateRegistry(r), /不在 cdi3 参数表/, '未知参数');
});

check('用物理输出当姿势可写参数会被抓到', () => {
  const r = clone();
  const entry = r.entries.find((e) => e.kind === 'pose');
  entry.poseParams = ['RArm'];
  entry.controlledParams.push({ id: 'RArm', end: 1 });
  expectErrors(validateRegistry(r), /物理输出/, '物理输出');
});

check('表情数值和 exp3.json 不一致会被抓到', () => {
  const r = clone();
  const entry = r.entries.find((e) => e.kind === 'expression' && e.expressionName === '兔牙');
  entry.controlledParams[0].value = 0.3;
  expectErrors(validateRegistry(r), /!= exp3/, '表情数值');
});

check('漏登记 model3 里的动作组会被抓到', () => {
  const r = clone();
  r.entries = r.entries.filter((e) => !(e.kind === 'motion-pair' && e.slot === '狗尾巴草'));
  expectErrors(validateRegistry(r), /动作组 狗尾巴草打开 未登记/, '漏登记动作组');
});

check('删除「始终不登记」条目会被抓到', () => {
  const r = clone();
  r.excluded = r.excluded.filter((x) => x.id !== 'gesture.open_hands');
  expectErrors(validateRegistry(r), /excluded 缺少 gesture\.open_hands/, 'excluded 完整性');
});

check('把被引用的 motion3 谎报为未引用会被抓到', () => {
  const r = clone();
  r.unregisteredAssets.motion3 = ['Animation/竖手指切出来动画.motion3.json'];
  expectErrors(validateRegistry(r), /实际被 model3 引用/, '未引用资产');
});

check('冲突单向声明会产生 warning', () => {
  const r = clone();
  // 去掉右侧双向声明，保留左侧单向
  const finger = r.entries.find((e) => e.id === 'gesture.right_finger');
  finger.conflicts = [{ with: 'gesture.grass', type: 'param-overlap', params: ['Param36'], reason: 'test' }];
  const grass = r.entries.find((e) => e.id === 'gesture.grass');
  grass.conflicts = [];
  const res = validateRegistry(r);
  assert.ok(res.warnings.some((w) => /未双向声明/.test(w)), '应给出单向冲突 warning');
});

console.log(`\n[w3-registry test] ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
fs.writeFileSync(
  path.join(HERE, 'test-result.json'),
  JSON.stringify({ generatedAt: new Date().toISOString(), passed, failed, cases }, null, 2) + '\n',
  'utf8',
);
