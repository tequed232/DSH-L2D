/**
 * ownership/ 用例：Node Ownership 白名单纯逻辑（param-host-policy.ts +
 * param-ownership.ts），不拉浏览器。
 * - whitelist：初始托管集 / 非托管拒绝 / 显式扩展（禁运行时自动发现）
 * - accessory-exclusion：Clothes/Hair/尾巴类 ID 不托管
 * - physics-preservation：物理输出 own 语义不因白名单改变
 */
import assert from 'node:assert';
import { createSuite, standaloneIfMain } from '../lib/harness.mjs';
import {
  HOST_POLICY, MANAGED_PARAM_IDS, evaluateExternalWrite, filterHostable,
  isHostable, managedSnapshot, registerManagedIds,
} from '../../../packages/renderer/src/app/param-host-policy.ts';
import { DEFAULT_OWN_DURATION_MS, ParamOwnership, selectOwnableIds } from '../../../packages/renderer/src/app/param-ownership.ts';

const suite = createSuite('ownership/（白名单纯逻辑）');

const cases = [
  {
    name: 'whitelist：policy 契约 + 初始托管集精确等于 11 个已核实 ID',
    fn: () => {
      assert.deepEqual(HOST_POLICY, { defaultOwnership: 'none', unknownParameter: 'reject', allowDynamicDiscovery: false, preservePhysics: true });
      // S1-RACE 修复（2026-11-05，param-host-policy.ts）把短名 AngleX/Y/Z 并入托管集：
      // 模型里短名与 ParamAngle* 是并存的两套真实参数，overlay 验收契约与 MCP 写入用短名，
      // 不并入会被 not_hostable 拒绝。PositionX/Y/Z 维持拒绝（留待产品裁决）。
      assert.deepEqual([...MANAGED_PARAM_IDS].sort(), ['AngleX', 'AngleY', 'AngleZ', 'ParamAngleX', 'ParamAngleY', 'ParamAngleZ', 'ParamBodyAngleX', 'ParamBodyAngleY', 'ParamBodyAngleZ', 'ParamEyeBallX', 'ParamEyeBallY']);
      assert.equal(managedSnapshot().length, MANAGED_PARAM_IDS.length);
    },
  },
  {
    name: 'whitelist：非托管 id 外部写拒绝 / own 过滤 / 口型红线最优先',
    fn: () => {
      assert.equal(evaluateExternalWrite('ParamAngleX'), 'ok');
      assert.equal(evaluateExternalWrite('Clothes5'), 'not_hostable');
      assert.equal(evaluateExternalWrite('ParamNotExistXYZ'), 'not_hostable');
      assert.equal(evaluateExternalWrite('ParamMouthOpenY'), 'lipsync_redline', '口型红线优先于白名单');
      const filtered = filterHostable(['ParamBodyAngleZ', 'ParamMouthOpenY', 'Hair1', '']);
      assert.deepEqual(filtered, ['ParamBodyAngleZ']);
    },
  },
  {
    name: 'whitelist：registerManagedIds 显式扩展生效且幂等；口型拒绝登记',
    fn: () => {
      const before = managedSnapshot().length;
      const accepted = registerManagedIds(['ParamHipXVerified', 'ParamHipXVerified', 'ParamMouthForm', '']);
      assert.deepEqual(accepted, ['ParamHipXVerified']);
      assert.equal(isHostable('ParamHipXVerified'), true);
      assert.equal(managedSnapshot().length, before + 1);
      assert.equal(evaluateExternalWrite('ParamMouthForm'), 'lipsync_redline', '扩展后口型红线仍不回退');
    },
  },
  {
    name: 'accessory-exclusion：Clothes/Hair/尾巴/耳朵类 ID 一律不托管',
    fn: () => {
      for (const id of ['Clothes1', 'Clothes2', 'Clothes4', 'Clothes5', 'Hair1', 'HairFront', 'Param_Angle_Rotation84', 'Param_Angle_Rotation87', 'LEar1', 'REar1', 'AngryMove', 'Param52']) {
        assert.equal(isHostable(id), false, `${id} 不应被托管`);
        assert.equal(evaluateExternalWrite(id), 'not_hostable');
      }
      // 未显式注册前不因任何隐式路径被收编（allowDynamicDiscovery=false）
      assert.equal(managedSnapshot().some((id) => /Clothes|Hair|Rotation8[4567]|Ear/.test(id)), false);
    },
  },
  {
    name: 'physics-preservation：物理输出 own/release/到期语义不因白名单改变',
    fn: () => {
      assert.equal(HOST_POLICY.preservePhysics, true);
      assert.equal(DEFAULT_OWN_DURATION_MS, 1200);
      const own = new ParamOwnership();
      const t = Date.now();
      assert.deepEqual(own.own(['ParamAngleX'], 50), ['ParamAngleX']);
      assert.equal(own.isOwned('ParamAngleX'), true);
      assert.equal(own.phaseOf('ParamAngleX'), 'post');
      assert.deepEqual(own.expire(t + 100), ['ParamAngleX'], '到期自动释放回物理（expire 收绝对时间戳）');
      assert.equal(own.isOwned('ParamAngleX'), false);
      own.own(['ParamBodyAngleX'], 0);                       // 0 = 长期持有
      assert.deepEqual(own.release(['ParamBodyAngleX']), ['ParamBodyAngleX']);
      assert.equal(own.isOwned('ParamBodyAngleX'), false);
      // 物理输出判定函数与白名单解耦：selectOwnableIds 语义不变
      const phys = new Set(['ParamAngleZ']);
      assert.deepEqual(selectOwnableIds(['ParamAngleZ', 'Clothes5'], (id) => phys.has(id)), ['ParamAngleZ']);
      assert.equal(own.own(['ParamEyeBallX'], 1200).length, 1);
      own.releaseAll();
      assert.equal(own.size(), 0);
    },
  },
];

await standaloneIfMain(import.meta.url, async () => suite.run(cases));
export async function run() { return suite.run(cases); }
