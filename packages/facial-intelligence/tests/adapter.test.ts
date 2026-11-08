/**
 * Cubism Adapter 写入诊断测试（任务书 Part 10 / Part 18 Cubism Tests）。
 *
 * 用例编号 AD-xx 对照（补充 mapping.test.ts 的扫描覆盖，聚焦 applyToAdapter）：
 *   AD-01  存在的参数可以写入（成功 + 回读 appliedValue）
 *   AD-02  不存在的参数返回明确错误 PARAMETER_NOT_FOUND，不静默成功
 *   AD-03  模型未就绪（指纹为空）→ MODEL_NOT_READY
 *   AD-04  越界默认裁剪写入；关闭裁剪 → OUT_OF_RANGE 且不写
 *   AD-05  非有限值 / 非法范围 → ADAPTER_ERROR；禁用映射不产生条目
 *   AD-06  setParameterValue 抛异常被收敛为 ADAPTER_ERROR（不炸调用方）
 *   AD-07  未请求的参数不产生结果条目
 */
import assert from 'node:assert';
import { applyToAdapter, createBindingFromScan } from '../src/adapter/cubism-adapter.ts';
import type { CubismParameterAdapter } from '../src/adapter/cubism-adapter.ts';
import { DEFAULT_PARAMETER_BINDINGS } from '../src/controller/parameter-mapping.ts';
import type { ParameterBinding } from '../src/controller/parameter-mapping.ts';

// 顺带冒烟：渲染侧桥接的集成契约入口必须能从 barrel 导入（@dsh/facial-intelligence → src/index.ts）
{
  const barrel = await import('../src/index.ts');
  for (const name of ['FacialController', 'ParamMixer', 'validateFacialPlan', 'createBindingFromScan']) {
    assert.ok(typeof (barrel as Record<string, unknown>)[name] === 'function', `barrel 缺少 ${name}`);
  }
  console.log('AD-00 barrel 集成契约 ok');
}

const yaw = (overrides: Partial<ParameterBinding> = {}): ParameterBinding => ({
  parameterId: 'ParamAngleX',
  semantic: 'head.yaw',
  min: -30,
  max: 30,
  defaultValue: 0,
  enabled: true,
  ...overrides,
});

function makeAdapter(bindings: ParameterBinding[], options: {
  fingerprint?: string;
  failWrite?: Set<string>;
  throwOnWrite?: Set<string>;
} = {}) {
  const byId = new Map(bindings.map((b) => [b.parameterId, b]));
  const written: Record<string, number> = {};
  return {
    written,
    hasParameter: (id: string) => byId.has(id),
    getParameterValue: (id: string) =>
      written[id] !== undefined ? written[id] : (byId.get(id)?.defaultValue ?? null),
    getParameterRange: (id: string) => {
      const b = byId.get(id);
      return b ? { min: b.min, max: b.max, defaultValue: b.defaultValue } : null;
    },
    setParameterValue: (id: string, value: number): boolean => {
      if (options.throwOnWrite?.has(id)) throw new Error('cubism boom');
      if (options.failWrite?.has(id)) return false;
      written[id] = value;
      return true;
    },
    getModelFingerprint: () => options.fingerprint ?? 'model-a',
  } satisfies CubismParameterAdapter & { written: Record<string, number> };
}

// AD-01 存在参数可写入
{
  const a = makeAdapter(DEFAULT_PARAMETER_BINDINGS);
  const r = applyToAdapter(a, DEFAULT_PARAMETER_BINDINGS, { ParamAngleX: 12, ParamMouthOpenY: 0.8 });
  assert.equal(r.length, 2);
  assert.ok(r.every((x) => x.success && x.appliedValue === x.requestedValue), JSON.stringify(r));
  assert.equal(a.written.ParamAngleX, 12);
  console.log('AD-01 写入成功 ok');
}

// AD-02 不存在参数明确报错
{
  const a = makeAdapter(DEFAULT_PARAMETER_BINDINGS);
  const r = applyToAdapter(a, [yaw({ parameterId: 'ParamBrowLY', semantic: 'brows.leftRaise' })], { ParamBrowLY: 0.5 });
  assert.equal(r[0].success, false);
  assert.equal(r[0].reason, 'PARAMETER_NOT_FOUND');
  console.log('AD-02 PARAMETER_NOT_FOUND ok');
}

// AD-03 模型未就绪 fail-closed
{
  const a = makeAdapter(DEFAULT_PARAMETER_BINDINGS, { fingerprint: '' });
  const r = applyToAdapter(a, DEFAULT_PARAMETER_BINDINGS, { ParamAngleX: 10 });
  assert.ok(r.every((x) => !x.success && x.reason === 'MODEL_NOT_READY'));
  assert.equal(Object.keys(a.written).length, 0);
  console.log('AD-03 MODEL_NOT_READY ok');
}

// AD-04 越界裁剪 vs OUT_OF_RANGE
{
  const a = makeAdapter(DEFAULT_PARAMETER_BINDINGS);
  const r1 = applyToAdapter(a, DEFAULT_PARAMETER_BINDINGS, { ParamAngleX: 500 });
  assert.equal(r1[0].success, true);
  assert.equal(r1[0].appliedValue, 30);
  const b = makeAdapter(DEFAULT_PARAMETER_BINDINGS);
  const r2 = applyToAdapter(b, DEFAULT_PARAMETER_BINDINGS, { ParamAngleX: 500 }, { clampOutOfRange: false });
  assert.equal(r2[0].success, false);
  assert.equal(r2[0].reason, 'OUT_OF_RANGE');
  assert.equal(Object.keys(b.written).length, 0);
  console.log('AD-04 越界处理 ok');
}

// AD-05 非有限值 / 非法范围 / 禁用映射
{
  const a = makeAdapter(DEFAULT_PARAMETER_BINDINGS);
  const r1 = applyToAdapter(a, DEFAULT_PARAMETER_BINDINGS, { ParamAngleX: NaN });
  assert.equal(r1[0].reason, 'ADAPTER_ERROR');
  const r2 = applyToAdapter(makeAdapter([yaw({ min: 30, max: -30 })]), [yaw({ min: 30, max: -30 })], { ParamAngleX: 1 });
  assert.equal(r2[0].reason, 'ADAPTER_ERROR');
  const r3 = applyToAdapter(a, [yaw({ enabled: false })], { ParamAngleX: 5 });
  assert.equal(r3.length, 0, '禁用映射不产生条目');
  console.log('AD-05 非法输入收敛 ok');
}

// AD-06 适配器异常不炸调用方
{
  const a = makeAdapter(DEFAULT_PARAMETER_BINDINGS, { throwOnWrite: new Set(['ParamAngleX']) });
  const r = applyToAdapter(a, DEFAULT_PARAMETER_BINDINGS, { ParamAngleX: 3 });
  assert.equal(r[0].success, false);
  assert.equal(r[0].reason, 'ADAPTER_ERROR');
  console.log('AD-06 异常收敛 ok');
}

// AD-07 未请求参数无条目
{
  const a = makeAdapter(DEFAULT_PARAMETER_BINDINGS);
  const r = applyToAdapter(a, DEFAULT_PARAMETER_BINDINGS, {});
  assert.equal(r.length, 0);
  console.log('AD-07 未请求无条目 ok');
}

// AD-08 扫描 + 写入全链路：扫描建立的映射可直接用于写入
{
  const a = makeAdapter(DEFAULT_PARAMETER_BINDINGS, { fingerprint: 'model-bigfeiyu' });
  const scan = createBindingFromScan(a);
  assert.equal(scan.bindings.length, DEFAULT_PARAMETER_BINDINGS.length);
  const r = applyToAdapter(a, scan.bindings, { ParamAngleX: -10, ParamEyeBallX: 0.5 });
  assert.ok(r.every((x) => x.success), JSON.stringify(r));
  console.log('AD-08 扫描→写入链路 ok');
}

console.log('facial adapter ok');
