import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameProfiler, percentile, percentilesOf } from './frame-profiler.ts';

test('percentile：已知样本的 P50/P95/P99 精确断言', () => {
  // 1..100 升序：线性插值下 p50=50.5, p95=95.05, p99=99.01
  const sorted = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.equal(percentile(sorted, 0.5), 50.5);
  assert.equal(percentile(sorted, 0.95), 95.05);
  assert.equal(percentile(sorted, 0.99), 99.01);
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([7], 0.95), 7);
  // percentilesOf 不修改原数组
  const raw = [30, 10, 20];
  const ps = percentilesOf(raw);
  assert.deepEqual(raw, [30, 10, 20]);
  assert.equal(ps.p50, 20);
});

test('FrameProfiler.record：环形缓冲上限与覆盖顺序', () => {
  const p = new FrameProfiler({ capacity: 5, expectedFps: 60, dropFactor: 1.5 });
  for (let i = 1; i <= 8; i++) p.record(i); // 环里剩 4..8
  const agg = p.aggregate();
  assert.equal(agg.sampleCount, 5);
  assert.equal(agg.totalFrames, 8);
  assert.deepEqual(percentilesOf([4, 5, 6, 7, 8]), {
    p50: agg.interval.p50,
    p95: agg.interval.p95,
    p99: agg.interval.p99,
  });
});

test('FrameProfiler：丢帧计数与丢帧率（60Hz 下 >25ms 记丢帧）', () => {
  const p = new FrameProfiler({ capacity: 100, expectedFps: 60, dropFactor: 1.5 });
  // 16.7ms 正常 x3，33ms 丢帧 x1
  p.record(16.7);
  p.record(16.7);
  p.record(16.7);
  p.record(33);
  const agg = p.aggregate();
  assert.equal(agg.droppedFrames, 1);
  assert.equal(agg.dropRate, 0.25);
  assert.equal(agg.interval.max, 33);
  assert.ok(Math.abs(agg.interval.mean - (16.7 * 3 + 33) / 4) < 1e-9);
});

test('FrameProfiler：帧耗时聚合（duration 与 interval 分开统计）', () => {
  const p = new FrameProfiler({ capacity: 100 });
  p.record(16, 4);
  p.record(16, 8);
  p.record(16); // 无耗时样本
  const agg = p.aggregate();
  assert.ok(agg.duration);
  assert.equal(agg.duration.p50, 6); // [4,8] 线性插值中位数
  assert.equal(agg.duration.max, 8);
  // 只有 2 个 duration 样本：p95 = 4 + (8-4)*0.95 = 7.8
  assert.ok(Math.abs(agg.duration.p95 - 7.8) < 1e-9);
});

test('FrameProfiler：detail 默认关闭，开启后保留明细', () => {
  const off = new FrameProfiler({ capacity: 10 });
  off.record(16, 5);
  assert.equal(off.aggregate().detail, null);

  const on = new FrameProfiler({ capacity: 10, detail: true, detailCapacity: 2 });
  on.record(16, 5, 1000);
  on.record(17, 6, 1100);
  on.record(18, 7, 1200); // 挤掉最老明细
  const detail = on.aggregate().detail;
  assert.equal(detail.length, 2);
  assert.equal(detail[0].intervalMs, 17);
  assert.equal(detail[1].durationMs, 7);
});

test('FrameProfiler：reset 清空全部统计；JSON 导出可直接序列化', () => {
  const p = new FrameProfiler({ capacity: 10 });
  p.record(100);
  p.reset();
  const agg = p.aggregate();
  assert.equal(agg.sampleCount, 0);
  assert.equal(agg.totalFrames, 0);
  assert.equal(agg.dropRate, null);
  assert.equal(agg.interval.p50, null);
  assert.doesNotThrow(() => JSON.stringify(p.toJSON()));
  assert.equal(p.toJSON().source, 'renderer.frame-profiler');
});

test('FrameProfiler.record：非法输入忽略，零样本聚合不抛异常', () => {
  const p = new FrameProfiler({ capacity: 4 });
  p.record(Number.NaN);
  p.record(-1);
  const agg = p.aggregate();
  assert.equal(agg.sampleCount, 0);
  assert.equal(agg.droppedFrames, 0);
});
