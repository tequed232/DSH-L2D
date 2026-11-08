/**
 * Mapping Tests：unit vs bipolar 正确性 / invert / 边界 clamp / 扫描建映射（适配后端席 API：
 * createBindingFromScan 位于 adapter，吃 CubismParameterAdapter，fail-closed 语义）。
 */
import assert from 'node:assert';
import {
  mapNormalizedValue,
  mapRange,
  mapUnitRange,
  mapBipolarRange,
  DEFAULT_PARAMETER_BINDINGS,
  type ParameterBinding,
} from '../src/controller/parameter-mapping.ts';
import { createBindingFromScan, type CubismParameterAdapter } from '../src/adapter/cubism-adapter.ts';

const ANGLE: ParameterBinding = { parameterId: 'ParamAngleX', semantic: 'head.yaw', min: -30, max: 30, defaultValue: 0, enabled: true };
const EYE: ParameterBinding = { parameterId: 'ParamEyeLOpen', semantic: 'eyes.leftOpen', min: 0, max: 1, defaultValue: 1, enabled: true };

// M1 bipolar：-1→min、+1→max、0→center
{
  assert.equal(mapBipolarRange(-1, ANGLE), -30);
  assert.equal(mapBipolarRange(1, ANGLE), 30);
  assert.equal(mapBipolarRange(0, ANGLE), 0);
  assert.equal(mapBipolarRange(0.5, ANGLE), 15);
  console.log('M1 bipolar 映射 ok');
}

// M2 unit：0→min、1→max
{
  assert.equal(mapUnitRange(0, EYE), 0);
  assert.equal(mapUnitRange(1, EYE), 1);
  assert.equal(mapUnitRange(0.5, EYE), 0.5);
  assert.equal(mapUnitRange(-0.3, EYE), 0, 'unit 域输入越界 clamp 到 0');
  console.log('M2 unit 映射 ok');
}

// M2b 域错误示范：unit 值错用 bipolar 公式会得到范围中点（防止回归的文档性断言）
{
  assert.notEqual(mapUnitRange(0.5, EYE), mapBipolarRange(0.5, EYE));
  console.log('M2b 域分派差异 ok');
}

// M3 invert
{
  const inv: ParameterBinding = { ...ANGLE, invert: true };
  assert.equal(mapBipolarRange(1, inv), -30);
  const invEye: ParameterBinding = { ...EYE, invert: true };
  assert.equal(mapUnitRange(1, invEye), 0, 'unit invert: openness=1 → 0');
  console.log('M3 invert ok');
}

// M4 边界 clamp
{
  assert.equal(mapBipolarRange(99, ANGLE), 30);
  assert.equal(mapBipolarRange(-99, ANGLE), -30);
  assert.equal(mapNormalizedValue(2, ANGLE), 30);
  assert.equal(mapNormalizedValue(-2, ANGLE), -30);
  console.log('M4 边界 clamp ok');
}

// M5 mapRange 通用
{
  assert.equal(mapRange(5, 0, 10, 0, 100), 50);
  assert.equal(mapRange(15, 0, 10, 0, 100), 100, '输入越界 clamp');
  console.log('M5 mapRange ok');
}

// ---- 扫描建映射（adapter 夹具）----
function adapterOf(params: Array<{ id: string; min: number; max: number; defaultValue: number }>): CubismParameterAdapter {
  const byId = new Map(params.filter((p) => p.max > p.min).map((p) => [p.id, p]));
  return {
    getModelFingerprint: () => (params.length ? 'fixture' : ''),
    hasParameter: (id) => byId.has(id),
    getParameterValue: (id) => (byId.get(id) ? byId.get(id)!.defaultValue : null),
    getParameterRange: (id) => {
      const p = byId.get(id);
      return p ? { min: p.min, max: p.max, defaultValue: p.defaultValue } : null;
    },
    setParameterValue: () => false,
  };
}

const BIGFEIYU_PARAMS = [
  { id: 'ParamAngleX', min: -30, max: 30, defaultValue: 0 },
  { id: 'ParamAngleY', min: -30, max: 30, defaultValue: 0 },
  { id: 'ParamAngleZ', min: -15, max: 15, defaultValue: 0 },
  { id: 'ParamEyeLOpen', min: 0, max: 1, defaultValue: 1 },
  { id: 'ParamEyeROpen', min: 0, max: 1, defaultValue: 1 },
  { id: 'ParamEyeBallX', min: -1, max: 1, defaultValue: 0 },
  { id: 'ParamEyeBallY', min: -1, max: 1, defaultValue: 0 },
  { id: 'ParamMouthOpenY', min: 0, max: 1, defaultValue: 0 },
  { id: 'ParamHairFront', min: -1, max: 1, defaultValue: 0 }, // 头发：非面部语义
];

// M6 扫描建映射：存在的参数生成、头发/眉毛缺失跳过、真实范围（不套默认值）
{
  const scan = createBindingFromScan(adapterOf(BIGFEIYU_PARAMS));
  assert.equal(scan.fingerprint, 'fixture');
  assert.equal(scan.bindings.length, 8, '匹配 8 个面部语义: ' + JSON.stringify(scan.bindings.map((b) => b.semantic)));
  assert.ok(!scan.bindings.some((b) => b.semantic.startsWith('brows')), '无眉毛参数不得伪造映射');
  const yaw = scan.bindings.find((b) => b.semantic === 'head.yaw')!;
  assert.equal(yaw.parameterId, 'ParamAngleX');
  assert.equal(yaw.min, -30, '真实扫描范围');
  assert.ok(scan.unsupported.some((u) => u.semantic.startsWith('brows')), '缺失语义进 unsupported');
  console.log('M6 扫描建映射 ok');
}

// M6b 模型未就绪（空参数表）fail-closed：全部语义 unsupported，不产出 binding
{
  const scan = createBindingFromScan(adapterOf([]));
  assert.equal(scan.bindings.length, 0, 'fail-closed 不产出任何 binding');
  assert.ok(scan.unsupported.length >= 9);
  console.log('M6b 模型未就绪 fail-closed ok');
}

// M6c 非法范围（max<=min）视同不存在
{
  const scan = createBindingFromScan(adapterOf([{ id: 'ParamAngleX', min: 30, max: -30, defaultValue: 0 }]));
  assert.equal(scan.bindings.length, 0, '非法范围不得建映射');
  console.log('M6c 非法范围拒绝 ok');
}

// M7 默认绑定表完整
{
  assert.equal(DEFAULT_PARAMETER_BINDINGS.length, 9);
  const semantics = new Set(DEFAULT_PARAMETER_BINDINGS.map((b) => b.semantic));
  assert.equal(semantics.size, 9, '语义无重复');
  console.log('M7 默认绑定表 ok');
}

console.log('mapping ok');
