/**
 * Node Ownership 托管白名单单测（对齐 param-ownership.test.mjs 形态）。
 * 覆盖：policy 契约 / 初始托管集 / isHostable / 外部写判定（含口型红线优先）/
 * own 过滤 / registerManagedIds 显式扩展与红线拒绝。
 *
 * 注：param-injector.ts 依赖 @framework 别名（浏览器运行时），无法在 node 脚本内
 * 直接实例化；其 agent 通道闸门就是对本文件纯函数（isHostable/filterHostable/
 * evaluateExternalWrite）的三行调用，注入器集成由 vue-tsc/tsc 与浏览器侧验证覆盖。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HOST_POLICY,
  MANAGED_PARAM_IDS,
  evaluateExternalWrite,
  filterHostable,
  isHostable,
  managedSnapshot,
  registerManagedIds,
} from './param-host-policy.ts';
import { LIPSYNC_PARAMS } from '../../../core/src/index.ts';

const MOUTH_ID = LIPSYNC_PARAMS[0];

test('policy 契约字段不被放宽', () => {
  assert.deepEqual(HOST_POLICY, {
    defaultOwnership: 'none',
    unknownParameter: 'reject',
    allowDynamicDiscovery: false,
    preservePhysics: true,
  });
});

test('初始托管集 = 已核实的 8 个真实 Parameter ID', () => {
  assert.deepEqual([...MANAGED_PARAM_IDS].sort(), [
    'ParamAngleX', 'ParamAngleY', 'ParamAngleZ',
    'ParamBodyAngleX', 'ParamBodyAngleY', 'ParamBodyAngleZ',
    'ParamEyeBallX', 'ParamEyeBallY',
  ]);
});

test('isHostable：托管 id 命中，非托管（含真实存在但未托管的模型参数）拒绝', () => {
  for (const id of MANAGED_PARAM_IDS) assert.equal(isHostable(id), true, id);
  // 空白容忍
  assert.equal(isHostable('  ParamEyeBallX '), true);
  // 大肥鱼模型真实存在但不在白名单：头发/裙摆/尾巴/耳朵/四肢/拖拽输入
  for (const id of ['Clothes5', 'Param_Angle_Rotation84', 'Param52', 'LEar1', 'REar1', 'AngleZ', 'PositionX', 'Param36', 'AngryMove']) {
    assert.equal(isHostable(id), false, id);
  }
  assert.equal(isHostable('ParamNotExistXYZ'), false);
  assert.equal(isHostable(''), false);
  assert.equal(isHostable(undefined), false);
});

test('外部写判定：口型红线优先级最高，其次白名单', () => {
  assert.equal(evaluateExternalWrite(MOUTH_ID), 'lipsync_redline');
  assert.equal(evaluateExternalWrite('ParamAngleX'), 'ok');
  assert.equal(evaluateExternalWrite('Clothes5'), 'not_hostable');
  assert.equal(evaluateExternalWrite(''), 'not_hostable');
});

test('own 过滤：agent 通道只保留托管 id，口型同拒', () => {
  const out = filterHostable(['ParamAngleX', MOUTH_ID, 'Clothes5', 'ParamEyeBallY', '', 'ParamNotExistXYZ']);
  assert.deepEqual(out, ['ParamAngleX', 'ParamEyeBallY']);
});

test('registerManagedIds：显式扩展生效且幂等；口型/空值拒绝登记', () => {
  const before = managedSnapshot().length;
  const accepted = registerManagedIds(['ParamHipTestVerified', 'ParamHipTestVerified', MOUTH_ID, '', '  ']);
  assert.deepEqual(accepted, ['ParamHipTestVerified']);
  assert.equal(isHostable('ParamHipTestVerified'), true);
  assert.equal(managedSnapshot().length, before + 1);
  // 口型红线不因扩展回退
  assert.equal(evaluateExternalWrite(MOUTH_ID), 'lipsync_redline');
  assert.equal(isHostable(MOUTH_ID), false);
});
