/**
 * OACA-4 指标收集器测试（metrics.mjs）。
 * 纯内存断言：计数递增 / cacheHitRate 0 与有效值 / token 三态 / reset。
 * 直跑：node packages/mcp-bridge/tests/metrics.test.mjs
 */
import assert from 'node:assert';
import { createMetrics, COUNTER_NAMES } from '../metrics.mjs';

let passed = 0;
function ok(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err && err.message ? err.message : err}`);
    process.exitCode = 1;
  }
}

console.log('OACA-4 指标与 LLM 隔离');

// ---- 1. 计数器名固定 + 初始全 0
ok('counters：五个计数器存在且初始为 0', () => {
  const m = createMetrics();
  const snap = m.snapshot();
  assert.deepEqual(Object.keys(snap.counters).sort(), [...COUNTER_NAMES].sort());
  for (const name of COUNTER_NAMES) assert.equal(snap.counters[name], 0, name);
  assert.deepEqual(snap.cache, { hits: 0, misses: 0 });
});

// ---- 2. 计数递增（含增量）
ok('increment：逐个计数器递增 + 支持增量累加', () => {
  const m = createMetrics();
  m.increment('chatPromptCount');
  m.increment('chatPromptCount');
  m.increment('actionPromptCount', 3);
  m.increment('agentPromptCount');
  m.increment('runtimeCallCount', 4);
  m.increment('runtimeLlmCallCount');
  const c = m.snapshot().counters;
  assert.equal(c.chatPromptCount, 2);
  assert.equal(c.actionPromptCount, 3);
  assert.equal(c.agentPromptCount, 1);
  assert.equal(c.runtimeCallCount, 4);
  assert.equal(c.runtimeLlmCallCount, 1);
});

// ---- 3. 未知计数器 / 非法增量必须抛错（指标不能静默丢）
ok('increment：拼错计数器名或非法增量直接抛错', () => {
  const m = createMetrics();
  assert.throws(() => m.increment('chatPromptCounts'), /未知计数器/);
  assert.throws(() => m.increment('chatPromptCount', -1), /增量/);
  assert.throws(() => m.increment('chatPromptCount', Number.NaN), /增量/);
  assert.equal(m.snapshot().counters.chatPromptCount, 0, '抛错后不得部分写入');
});

// ---- 4. cacheHitRate：分母 0 → null；有效值精确
ok('cacheHitRate：无缓存事件 → null；hits/misses 有效 → 精确比值', () => {
  const m = createMetrics();
  assert.equal(m.snapshot().cacheHitRate, null, '分母为 0 时不能报 100%');

  m.recordCacheHit();
  assert.equal(m.snapshot().cacheHitRate, 1);

  m.recordCacheMiss();
  assert.equal(m.snapshot().cacheHitRate, 0.5);

  m.recordCacheHit();
  m.recordCacheHit();
  m.recordCacheMiss();
  assert.equal(m.snapshot().cacheHitRate, 0.6, 'hits=3 / misses=2 → 3/5 = 0.6');
  assert.deepEqual(m.snapshot().cache, { hits: 3, misses: 2 });
});

ok('cacheHitRate：recordCache(hit) 布尔门面与显式 hit/miss 等价', () => {
  const m = createMetrics();
  m.recordCache(true);
  m.recordCache(false);
  assert.deepEqual(m.snapshot().cache, { hits: 1, misses: 1 });
  assert.equal(m.snapshot().cacheHitRate, 0.5);
});

// ---- 5. Token 三态
ok('tokens：全缺 → actual=null 且 unavailable=true', () => {
  const m = createMetrics();
  m.recordTokens({});
  const t = m.snapshot().tokens;
  assert.equal(t.actual, null);
  assert.equal(t.estimated, null);
  assert.equal(t.unavailable, true, '拿不到 token 必须落 unavailable，禁止用 0 或字符数冒充');
});

ok('tokens：只有 estimated → actual=null 但 unavailable=true（不得把估算当 actual）', () => {
  const m = createMetrics();
  m.recordTokens({ estimated: 512 });
  const t = m.snapshot().tokens;
  assert.equal(t.actual, null);
  assert.equal(t.estimated, 512);
  assert.equal(t.unavailable, true, 'estimated 存在不等于 actual 可得');
});

ok('tokens：actual 可得 → unavailable=false 且累计', () => {
  const m = createMetrics();
  m.recordTokens({ actual: 100, estimated: 120 });
  m.recordTokens({ actual: 50 });
  const t = m.snapshot().tokens;
  assert.equal(t.actual, 150, 'actual 累计');
  assert.equal(t.estimated, 120, 'estimated 独立累计');
  assert.equal(t.unavailable, false);
});

ok('tokens：非法 actual（字符数/NaN/负数）不被采纳，保持 unavailable', () => {
  const m = createMetrics();
  m.recordTokens({ actual: '42 字符' }); // 典型的"用字符数冒充 token"误用
  m.recordTokens({ actual: Number.NaN });
  m.recordTokens({ actual: -1 });
  const t = m.snapshot().tokens;
  assert.equal(t.actual, null);
  assert.equal(t.unavailable, true);
});

// ---- 6. reset 清空全部状态
ok('reset：计数器 / 缓存 / token 全部归零，且 snapshot 是快照不影响内部状态', () => {
  const m = createMetrics();
  m.increment('runtimeLlmCallCount', 2);
  m.recordCacheHit();
  m.recordTokens({ actual: 30 });
  const snap = m.snapshot();
  snap.counters.runtimeLlmCallCount = 999;
  snap.tokens.actual = 999;
  assert.equal(m.snapshot().counters.runtimeLlmCallCount, 2, 'snapshot 返回副本，外部改写不得污染内部');
  assert.equal(m.snapshot().tokens.actual, 30);

  m.reset();
  const after = m.snapshot();
  for (const name of COUNTER_NAMES) assert.equal(after.counters[name], 0, name);
  assert.equal(after.cacheHitRate, null);
  assert.deepEqual(after.tokens, { actual: null, estimated: null, unavailable: true });
});

// ---- 7. 实例隔离：两个 metrics 互不影响（模块级单例不共享状态给测试）
ok('实例隔离：两个 createMetrics 互不影响', () => {
  const a = createMetrics();
  const b = createMetrics();
  a.increment('chatPromptCount', 5);
  assert.equal(b.snapshot().counters.chatPromptCount, 0);
});

console.log(`\nOACA-4 指标: ${passed} tests passed`);
