import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectBrowserMemorySnapshot,
  collectProcessMemorySnapshot,
  createMemorySampler,
  snapshotToJSON,
} from './memory-snapshot.ts';

test('浏览器快照：Chromium performance.memory 可用时读 jsHeap', () => {
  const fakeMemory = { usedJSHeapSize: 1024, totalJSHeapSize: 2048, jsHeapSizeLimit: 4096 };
  const g = globalThis;
  const savedPerf = g.performance;
  const savedMem = savedPerf ? savedPerf.memory : undefined;
  try {
    g.performance = { memory: fakeMemory };
    const snap = collectBrowserMemorySnapshot(1234);
    assert.equal(snap.process, 'renderer');
    assert.equal(snap.sampledAt, 1234);
    assert.equal(snap.fields.jsHeapUsedBytes.available, true);
    assert.equal(snap.fields.jsHeapUsedBytes.value, 1024);
    assert.equal(snap.fields.jsHeapUsedBytes.source, 'performance.memory');
    assert.equal(snap.fields.jsHeapTotalBytes.value, 2048);
    assert.equal(snap.fields.jsHeapLimitBytes.value, 4096);
    // GPU 显存永远不可得，且绝不伪造
    assert.equal(snap.fields.gpuMemoryBytes.available, false);
    assert.equal(snap.fields.gpuMemoryBytes.value, null);
    assert.deepEqual(snap.unavailable, ['gpuMemoryBytes']);
  } finally {
    g.performance = savedPerf;
    if (savedPerf && typeof savedPerf === 'object') savedPerf.memory = savedMem;
  }
});

test('浏览器快照：非 Chromium 环境降级，全部 heap 字段标 unavailable 不伪造', () => {
  const g = globalThis;
  const savedPerf = g.performance;
  try {
    g.performance = {};
    const snap = collectBrowserMemorySnapshot(5678);
    assert.equal(snap.process, 'renderer');
    for (const key of ['jsHeapUsedBytes', 'jsHeapTotalBytes', 'jsHeapLimitBytes']) {
      assert.equal(snap.fields[key].available, false);
      assert.equal(snap.fields[key].value, null);
      assert.equal(snap.fields[key].reason, 'performance.memory-unsupported');
    }
    assert.deepEqual(snap.unavailable, ['jsHeapUsedBytes', 'jsHeapTotalBytes', 'jsHeapLimitBytes', 'gpuMemoryBytes']);
  } finally {
    g.performance = savedPerf;
  }
});

test('进程快照：Node process.memoryUsage 读数，进程归属 plugin-host', () => {
  const snap = collectProcessMemorySnapshot(99);
  assert.equal(snap.process, 'plugin-host');
  assert.equal(snap.sampledAt, 99);
  assert.equal(snap.fields.rssBytes.available, true);
  assert.ok(snap.fields.rssBytes.value > 0);
  assert.equal(snap.fields.rssBytes.source, 'process.memoryUsage');
  assert.equal(snap.fields.gpuMemoryBytes.available, false);
});

test('进程快照：无 process 环境降级为 unavailable', () => {
  const g = globalThis;
  const saved = g.process;
  try {
    g.process = undefined;
    const snap = collectProcessMemorySnapshot(1);
    assert.equal(snap.fields.rssBytes.available, false);
    assert.deepEqual(snap.unavailable.length > 0, true);
  } finally {
    g.process = saved;
  }
});

test('JSON 导出：纯数值 + 可用性标记，不含正文/路径/密钥类字段', () => {
  const snap = collectProcessMemorySnapshot(42);
  const json = JSON.parse(JSON.stringify(snapshotToJSON(snap)));
  assert.equal(json.sampledAt, 42);
  assert.equal(json.process, 'plugin-host');
  const text = JSON.stringify(json);
  // 不应包含敏感键名
  for (const banned of ['apiKey', 'path', 'chat', 'message', 'text']) {
    assert.equal(text.includes(banned), false, `unexpected key: ${banned}`);
  }
});

test('createMemorySampler：采样入历史、stop 后不再增长', async () => {
  let calls = 0;
  const sampler = createMemorySampler({
    collect: (now = 0) => {
      calls++;
      return collectProcessMemorySnapshot(now);
    },
    intervalMs: 5,
    keep: 3,
  });
  const s1 = sampler.sample(100);
  assert.equal(calls, 1);
  assert.equal(s1.sampledAt, 100);
  sampler.sample(200);
  sampler.sample(300);
  sampler.sample(400); // keep=3，最老的 100 被挤掉
  assert.equal(sampler.history().length, 3);
  assert.equal(sampler.history()[0].sampledAt, 200);
  assert.equal(sampler.toJSON().latest.sampledAt, 400);
  sampler.start();
  await new Promise((r) => setTimeout(r, 30));
  sampler.stop();
  const afterStop = sampler.history().length;
  assert.ok(afterStop >= 3);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sampler.history().length, afterStop); // stop 后不再采样
});
