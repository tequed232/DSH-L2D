/**
 * 纹理预算计算器测试（零依赖，不需要测试框架）
 * 运行：node --experimental-strip-types packages/core/test/texture-budget.ts
 */
import assert from 'node:assert/strict';
import {
  DEFAULT_BUDGET_BYTES,
  MIPMAP_FACTOR,
  TEXTURE_TIERS,
  computeTextureBudget,
  estimateTextureBytes,
  scaledSizeForTier,
} from '../src/texture-budget.ts';

let passed = 0;
const test = (name: string, fn: () => void) => {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
};

console.log('\n纹理预算计算器\n');

test('估算基准：2048²≈22.3MB、1024²≈5.6MB（RGBA8+mipmap，方案参考值）', () => {
  const b2048 = estimateTextureBytes({ id: 't', width: 2048, height: 2048 });
  assert.equal(b2048, Math.round(2048 * 2048 * 4 * MIPMAP_FACTOR));
  assert.ok(Math.abs(b2048 - 22.3e6) / 22.3e6 < 0.01, `2048² 应约 22.3MB，实际 ${(b2048 / 1e6).toFixed(2)}MB`);
  // 1024² RGBA8 = 4MiB，×1.33 mipmap ≈ 5.6MB/张
  const b1024 = estimateTextureBytes({ id: 't', width: 1024, height: 1024 });
  assert.equal(b1024, Math.round(1024 * 1024 * 4 * MIPMAP_FACTOR));
  assert.ok(Math.abs(b1024 - 5.6e6) / 5.6e6 < 0.01, `1024² 应约 5.6MB，实际 ${(b1024 / 1e6).toFixed(2)}MB`);
});

test('5 张纹理降到 1024 档 ≈ 28MB ≤ 32MB → 自动建议 1024 可行', () => {
  const items = [0, 1, 2, 3, 4].map((i) => ({ id: `texture_0${i}.png`, width: 2048, height: 2048 }));
  const report = computeTextureBudget(items);
  assert.equal(report.tier, 1024);
  assert.equal(report.tierFeasible, true);
  assert.equal(report.originalBytes > DEFAULT_BUDGET_BYTES, true, '原始 2048 档必须超预算（约 106MB）');
  assert.equal(report.totalBytes, 5 * Math.round(1024 * 1024 * 4 * MIPMAP_FACTOR), `1024 档 5 张 ≈ 28MB，实际 ${(report.totalBytes / 1024 / 1024).toFixed(1)}MB`);
  assert.equal(report.totalBytes <= DEFAULT_BUDGET_BYTES, true);
  assert.ok(report.perTexture.every((t) => t.tierWidth === 1024 && t.tierHeight === 1024));
});

test('mipmap 关闭时不含 1.33 系数', () => {
  assert.equal(estimateTextureBytes({ id: 't', width: 1024, height: 1024, mipmap: false }), 1024 * 1024 * 4);
});

test('像素格式字节数参与估算；未知格式兜底 rgba8', () => {
  assert.equal(estimateTextureBytes({ id: 't', width: 100, height: 100, pixelFormat: 'rgb8', mipmap: false }), 30000);
  assert.equal(estimateTextureBytes({ id: 't', width: 100, height: 100, pixelFormat: 'nope', mipmap: false }), 40000);
});

test('档位缩放：只缩不放，最长边钳到档位', () => {
  assert.deepEqual(scaledSizeForTier(4096, 8192, 1024), { tierWidth: 512, tierHeight: 1024 });
  assert.deepEqual(scaledSizeForTier(1024, 1024, 2048), { tierWidth: 1024, tierHeight: 1024 });
  assert.deepEqual(scaledSizeForTier(2048, 2048, 512), { tierWidth: 512, tierHeight: 512 });
});

test('用户覆盖档位：overrideApplied 生效，超预算照实标记', () => {
  const items = [0, 1, 2, 3, 4].map((i) => ({ id: `t${i}`, width: 4096, height: 4096 }));
  const report = computeTextureBudget(items, { tier: 2048 });
  assert.equal(report.overrideApplied, true);
  assert.equal(report.tier, 2048);
  assert.equal(report.tierFeasible, false, '5×4096²+mipmap ≈ 141MB 超预算');
  assert.ok(report.warnings.some((w) => w.includes('模型超出低配预算')));
});

test('所有自动档位都超预算时给出 512 + 不可行警告', () => {
  // 30 × 1024²：1024 档 ≈ 167MB，512 档 ≈ 40MB，都超 32MB
  const items = Array.from({ length: 30 }, (_, i) => ({ id: `t${i}`, width: 1024, height: 1024 }));
  const report = computeTextureBudget(items);
  assert.equal(report.tier, 512);
  assert.equal(report.tierFeasible, false);
  assert.ok(report.warnings.some((w) => w.includes('超出低配预算')));
});

test('用户覆盖预算字节数', () => {
  const items = [{ id: 't', width: 2048, height: 2048 }];
  const tight = computeTextureBudget(items, { budgetBytes: 4 * 1024 * 1024 });
  assert.equal(tight.tier, 512, '预算 4MB 时 2048² 张要降到 512 档');
  assert.equal(tight.tierFeasible, true);
});

test('原始尺寸合计超预算时追加警告（与档位可行性无关）', () => {
  const items = [{ id: 't', width: 8192, height: 8192 }];
  const report = computeTextureBudget(items);
  assert.ok(report.warnings.some((w) => w.includes('原始纹理合计')));
});

test('无效条目被跳过并产生警告；refCount 不参与字节数', () => {
  const report = computeTextureBudget([
    { id: 'good', width: 1024, height: 1024, refCount: 5 },
    { id: '', width: 1024, height: 1024 },
    { id: 'bad-size', width: 0, height: 100 },
  ]);
  assert.equal(report.perTexture.length, 1);
  assert.equal(report.perTexture[0].refCount, 5);
  // refCount=5 不乘进字节数：GPU 上同路径只驻留一份
  assert.equal(report.totalBytes, Math.round(1024 * 1024 * 4 * MIPMAP_FACTOR));
  assert.ok(report.warnings.some((w) => w.includes('无效纹理条目')));
});

test('档位枚举固定为 2048/1024/512', () => {
  assert.deepEqual(TEXTURE_TIERS, [2048, 1024, 512]);
});

console.log(`\n${passed} 项通过${process.exitCode ? '，存在失败' : ''}\n`);
