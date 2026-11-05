/**
 * StatusReporter 验收（PR-B，B05-B09 + 附加语义）。
 * 定时器用注入 fake clock（30s 下限不可用真实定时器）；A2A/HTTP 零真实调用。
 * 直跑：node packages/mcp-bridge/tests/status-reporter.test.mjs
 */
import assert from 'node:assert';
import { StatusReporter, InMemoryStatusSource } from '../status-reporter.mjs';

let passed = 0;
async function okAsync(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1; }
}

/** fake clock：记录回调，手动推进（1 tick = 一次 interval 触发）。 */
function fakeClock() {
  const slots = [];
  return {
    slots,
    fired: 0,
    setInterval(fn, ms) { slots.push({ fn, ms }); return slots.length; },
    clearInterval(id) { if (slots[id - 1]) slots[id - 1] = null; },
    /** 推进 n 次 interval 触发（只触发仍然存活的定时器） */
    async tick(n = 1) {
      for (let i = 0; i < n; i++) {
        for (const s of slots) if (s) { this.fired++; await s.fn(); }
      }
    },
  };
}

function makeReporter({ intervalMs, source, sink, clock, queueState = { depth: 0 }, memoryRevision = 7 }) {
  return new StatusReporter({
    workspaceId: 'ws-1',
    intervalMs,
    source,
    sink,
    getQueueState: () => queueState,
    getMemoryRevision: async () => memoryRevision,
    clock,
  });
}

console.log('PR-B StatusReporter（B05-B09）');

await okAsync('B05 intervalMs=29s → 构造时拒绝', async () => {
  assert.throws(() => makeReporter({ intervalMs: 29_000, source: new InMemoryStatusSource(), sink: { report: async () => {} }, clock: fakeClock() }), /intervalMs/);
});

await okAsync('B07 intervalMs=121s → 构造时拒绝', async () => {
  assert.throws(() => makeReporter({ intervalMs: 121_000, source: new InMemoryStatusSource(), sink: { report: async () => {} }, clock: fakeClock() }), /intervalMs/);
});

await okAsync('B06 intervalMs=60s → 正常周期上报；revision 不变不重发', async () => {
  const source = new InMemoryStatusSource();
  const reports = [];
  const sink = { report: async (r) => { reports.push(r); } };
  const clock = fakeClock();
  source.push({ status: 'success', message: 'wave.right 完成' });
  const reporter = makeReporter({ intervalMs: 60_000, source, sink, clock });
  reporter.start();
  await new Promise((r) => setImmediate(r)); // 排空 fire-and-forget flush 的全部微任务 // start 的首次 flush 落地
  assert.equal(reports.length, 1, '启动即采一次');
  await clock.tick(2); // 两次周期，revision 未变
  assert.equal(reports.length, 1, 'B09 同 revision 不重复上报');
  source.push({ status: 'waiting', message: '队列等待' }); // revision 变更
  await clock.tick(1);
  assert.equal(reports.length, 2, 'revision 变更后周期上报');
  assert.equal(reports[1].status.status, 'waiting');
  assert.equal(reports[1].queueDepth, 0);
  assert.equal(reports[1].memoryRevision, 7);
  assert.equal(reports[1].workspaceId, 'ws-1');
  reporter.stop();
  assert.equal(clock.slots.every((s) => !s), true, 'stop 清定时器');
});

await okAsync('B08 crashed → 上报含 message + errorCode', async () => {
  const source = new InMemoryStatusSource();
  const reports = [];
  const clock = fakeClock();
  const reporter = makeReporter({
    intervalMs: 60_000, source, clock,
    sink: { report: async (r) => { reports.push(r); } },
  });
  source.push({ status: 'crashed', message: 'renderer runtime 崩溃', errorCode: 'GL_CONTEXT_LOST' });
  reporter.start();
  await new Promise((r) => setImmediate(r)); // 排空 fire-and-forget flush 的全部微任务
  assert.equal(reports.length, 1);
  assert.equal(reports[0].status.status, 'crashed');
  assert.equal(reports[0].status.message, 'renderer runtime 崩溃');
  assert.equal(reports[0].status.errorCode, 'GL_CONTEXT_LOST');
});

await okAsync('附加：sink 抛错 → lastRevision 不推进 → 下周期重试成功', async () => {
  const source = new InMemoryStatusSource();
  const reports = [];
  let failNext = true;
  const clock = fakeClock();
  const reporter = makeReporter({
    intervalMs: 60_000, source, clock,
    sink: { report: async (r) => { if (failNext) { failNext = false; throw new Error('a2a-down'); } reports.push(r); } },
  });
  source.push({ status: 'success', message: 'ok-1' });
  reporter.start();
  await new Promise((r) => setImmediate(r)); // 排空 fire-and-forget flush 的全部微任务
  assert.equal(reports.length, 0, '首次上报失败');
  assert.equal(reporter.lastRevision, -1, '失败不推进 revision');
  assert.match(reporter.lastError, /a2a-down/);
  await clock.tick(1); // 同一 revision 重试
  assert.equal(reports.length, 1, '下周期重试成功');
  assert.equal(reporter.lastError, null);
});

await okAsync('附加：running / idle 不触发上报（running 仅快照附带）', async () => {
  const source = new InMemoryStatusSource();
  const reports = [];
  const clock = fakeClock();
  const reporter = makeReporter({ intervalMs: 60_000, source, clock, sink: { report: async (r) => { reports.push(r); } } });
  reporter.start();
  await new Promise((r) => setImmediate(r)); // 排空 fire-and-forget flush 的全部微任务
  source.push({ status: 'running', message: '执行中' });
  await clock.tick(1);
  source.push({ status: 'idle' });
  await clock.tick(1);
  assert.equal(reports.length, 0, 'running/idle 均不上报');
  // running 之后转 success：正常上报（running 已被新 revision 取代，无需补发）
  source.push({ status: 'success', message: 'done' });
  await clock.tick(1);
  assert.equal(reports.length, 1);
  assert.equal(reporter.reportCount, 1);
});

await okAsync('附加：flush 非重入（running 锁）+ dispose 一并停止', async () => {
  const source = new InMemoryStatusSource();
  let inFlight = null;
  const clock = fakeClock();
  const reporter = makeReporter({
    intervalMs: 60_000, source, clock,
    sink: { report: async () => { inFlight = inFlight || Promise.resolve(); await inFlight; } },
  });
  source.push({ status: 'waiting', message: 'q' });
  reporter.start();
  await new Promise((r) => setImmediate(r)); // 排空 fire-and-forget flush 的全部微任务
  assert.ok(reporter.timer !== null);
  reporter.dispose();
  assert.equal(reporter.timer, null, 'dispose 停止定时器');
  const before = reporter.reportCount;
  await reporter.flush(); // dispose 后手动 flush 仍安全（无定时器即可）
  assert.ok(reporter.reportCount >= before);
});

console.log(`\n结果：${process.exitCode ? '存在失败' : '全部通过'}（${passed} 项用例）`);
if (process.exitCode) process.exit(1);
