/**
 * ModelActionQueue 验收（PR-C，B10-B18 + 背压 + cancel）。fake executor + 注入 clock，
 * A2A/HTTP 零真实调用；B15/B17 用真实 sqlite 临时库验持久化语义。
 * 用法纪律：h.settle() 放行 execute → h.releaseOk() 放行 release → await enqueue 回执
 * → 下一动作的 handle 才会就绪（串行语义本身保证该顺序，乱序即死锁=测试自暴露）。
 * 直跑：node --experimental-sqlite packages/mcp-bridge/tests/action-queue.test.mjs
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ModelActionQueue } from '../action-queue.mjs';
import * as actionsRepo from '../../dsh-l2d-db/src/bridge-actions-repo.mjs';
import { openDb } from '../../dsh-l2d-db/src/db.mjs';

let passed = 0;
async function okAsync(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1; }
}

/**
 * 可控 fake executor：execute/release 返回未决 promise，外部经 handle 放行。
 * nextExecute() 预约「下一次 execute 被调用」→ Promise<handle>；
 * release 走 FIFO 等待队列，handle.releaseOk/releaseErr 放行当前队首。
 */
function makeFakeExecutor() {
  const log = [];
  const executeWaiters = []; // nextExecute 的 resolve（预约在前）
  const lateHandles = []; // execute 先于预约发生：handle 暂存，nextExecute 优先补交
  const releaseWaiters = [];
  return {
    log,
    nextExecute() {
      if (lateHandles.length) return Promise.resolve(lateHandles.shift());
      return new Promise((resolve) => executeWaiters.push(resolve));
    },
    execute(request) {
      log.push(['execute', request.requestId]);
      return new Promise((resolve, reject) => {
        const handle = {
          request,
          settle: (r = { ok: true }) => resolve(r),
          fail: (reason = 'rejected') => resolve({ ok: false, reason }),
          throw: (m = 'executor-threw') => reject(new Error(m)),
          releaseOk: () => releaseWaiters.splice(0).forEach((w) => w.resolve()),
          releaseErr: (m = 'release-broken') => releaseWaiters.splice(0).forEach((w) => w.reject(new Error(m))),
        };
        const waiter = executeWaiters.shift();
        if (waiter) waiter(handle);
        else lateHandles.push(handle);
      });
    },
    release() {
      return new Promise((resolve, reject) => releaseWaiters.push({ resolve, reject }));
    },
    cancel: async (request) => { log.push(['cancel', request?.requestId ?? null]); },
  };
}

/** fake clock：手动触发 setTimeout 回调（队列超时测试用）。 */
function fakeClock() {
  const timers = [];
  return {
    timers,
    setTimeout(fn, ms) { timers.push({ fn, ms, alive: true }); return timers.length; },
    clearTimeout(id) { if (timers[id - 1]) timers[id - 1].alive = false; },
    fireTimeout() {
      const t = timers.find((x) => x.alive);
      if (!t) throw new Error('fakeClock: 无存活定时器可触发');
      t.alive = false;
      t.fn();
    },
  };
}

function makeRequest(i, over = {}) {
  return { requestId: `r-${i}`, workspaceId: 'ws-test', controlSessionId: 'sess-test', action: 'wave.right', args: {}, priority: 50, timeoutMs: 30_000, createdAt: Date.now(), memoryRevision: 0, ...over };
}

const drain = () => new Promise((r) => setImmediate(r));

console.log('PR-C ModelActionQueue（B10-B18）');

await okAsync('B10 三动作严格 FIFO（executor 调用序 = 入队序）', async () => {
  const ex = makeFakeExecutor();
  const h1 = await (async () => { const p = ex.nextExecute(); const queue = new ModelActionQueue({ executor: ex }); const r = queue.enqueue(makeRequest(1)); return { p, queue, r, h: await p }; })();
  const q = h1.queue;
  const h2wait = ex.nextExecute();
  const r2 = q.enqueue(makeRequest(2));
  const r3 = q.enqueue(makeRequest(3));
  await drain();
  assert.equal(ex.log.length, 1, '串行：r-2/r-3 不得提前执行');
  h1.h.settle(); await drain(); h1.h.releaseOk();
  assert.equal((await h1.r).state, 'completed');
  const h2 = await h2wait;
  h2.settle(); await drain(); h2.releaseOk();
  assert.equal((await r2).state, 'completed');
  const h3 = await ex.nextExecute();
  h3.settle(); await drain(); h3.releaseOk();
  assert.equal((await r3).state, 'completed');
  assert.deepEqual(ex.log.filter((e) => e[0] === 'execute').map((e) => e[1]), ['r-1', 'r-2', 'r-3'], 'FIFO 顺序');
});

await okAsync('B11 第一动作未完成第二不启动（executor 仅调用一次）', async () => {
  const ex = makeFakeExecutor();
  const p1 = ex.nextExecute();
  const queue = new ModelActionQueue({ executor: ex });
  const r1 = queue.enqueue(makeRequest(1));
  const h1 = await p1;
  const r2 = queue.enqueue(makeRequest(2));
  await drain();
  assert.equal(ex.log.length, 1, '第一动作未完成，executor 不得再被调用');
  assert.deepEqual(queue.getState(), { depth: 1, activeRequestId: 'r-1', processing: true, faulted: false, state: 'running' });
  h1.settle(); await drain(); h1.releaseOk();
  assert.equal((await r1).state, 'completed');
  const h2 = await ex.nextExecute();
  h2.settle(); await drain(); h2.releaseOk();
  assert.equal((await r2).state, 'completed');
});

await okAsync('B12 完成但未释放不启动下一条（release 放行后才继续）', async () => {
  const ex = makeFakeExecutor();
  const p1 = ex.nextExecute();
  const queue = new ModelActionQueue({ executor: ex });
  const r1 = queue.enqueue(makeRequest(1));
  const h1 = await p1;
  const r2 = queue.enqueue(makeRequest(2));
  h1.settle(); // execute 完成，release 未放行
  await drain();
  assert.equal(ex.log.length, 1, '未确认释放，下一条不得启动');
  h1.releaseOk();
  assert.equal((await r1).state, 'completed');
  const h2 = await ex.nextExecute();
  h2.settle(); await drain(); h2.releaseOk();
  assert.equal((await r2).state, 'completed');
});

await okAsync('B13 超时 → cancel + 确认释放 → failed → 队列继续', async () => {
  const ex = makeFakeExecutor();
  const p1 = ex.nextExecute();
  const clock = fakeClock();
  const queue = new ModelActionQueue({ executor: ex, clock });
  const r1 = queue.enqueue(makeRequest(1, { timeoutMs: 1000 }));
  const h1 = await p1;
  const r2 = queue.enqueue(makeRequest(2));
  clock.fireTimeout(); // r-1 超时 → STOPPING：cancel + release 确认
  await drain();
  h1.releaseOk(); // STOPPING 路径的释放确认
  const rec1 = await r1;
  assert.equal(rec1.state, 'failed');
  assert.equal(rec1.error, 'timeout');
  assert.ok(ex.log.some((e) => e[0] === 'cancel' && e[1] === 'r-1'), '超时必须走 cancel');
  const h2 = await ex.nextExecute();
  assert.equal(queue.getState().activeRequestId, 'r-2', '超时处理完继续下一条');
  h2.settle(); await drain(); h2.releaseOk();
  assert.equal((await r2).state, 'completed');
});

await okAsync('B14 释放失败 → FAULTED 且后续 enqueue 拒绝 → recover 解锁', async () => {
  const ex = makeFakeExecutor();
  const p1 = ex.nextExecute();
  const queue = new ModelActionQueue({ executor: ex });
  const r1 = queue.enqueue(makeRequest(1));
  const h1 = await p1;
  const r2 = queue.enqueue(makeRequest(2));
  h1.settle();
  await drain();
  h1.releaseErr('release-broken'); // 释放失败 → FAULTED
  const rec1 = await r1;
  assert.equal(rec1.state, 'failed');
  assert.match(rec1.error, /release-failed.*release-broken/);
  assert.equal(queue.getState().faulted, true);
  const blocked = await queue.enqueue(makeRequest(3));
  assert.equal(blocked.error, 'FAULTED', 'FAULTED 后 enqueue 拒绝');
  assert.equal(ex.log.length, 1, 'FAULTED 阻断执行');
  assert.equal(queue.recover(), true, 'recover 解锁');
  const h2 = await ex.nextExecute(); // 解锁后 pending 的 r-2 继续
  h2.settle(); await drain(); h2.releaseOk();
  assert.equal((await r2).state, 'completed');
  assert.equal(queue.getState().faulted, false);
});

await okAsync('B15 重复 requestId 不重复执行（repo 幂等：返回既有行）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-bridge-c-'));
  const db = openDb({ path: path.join(tmp, 'actions.sqlite') });
  const repo = {
    findById: (id) => actionsRepo.findById(db, id),
    insertRequest: (req) => actionsRepo.insertRequest(db, req),
    markRunning: (id) => actionsRepo.markRunning(db, id),
    markTerminal: (id, state, o) => actionsRepo.markTerminal(db, id, state, o),
    markInterruptedAll: () => actionsRepo.markInterruptedAll(db),
  };
  const ex = makeFakeExecutor();
  const p1 = ex.nextExecute();
  const queue = new ModelActionQueue({ executor: ex, repo });
  const req = makeRequest(1, { timeoutMs: 5000 });
  const r1 = queue.enqueue(req);
  const h1 = await p1;
  // 同 requestId 重试：r-1 已 running → 直接回执，不重复执行（B15）
  const retry = await queue.enqueue({ ...req });
  assert.equal(retry.requestId, 'r-1');
  assert.equal(retry.state, 'running', `重试返回既有行 running，收到 ${JSON.stringify(retry)}`);
  assert.equal(ex.log.length, 1, '不重复执行');
  h1.settle(); await drain(); h1.releaseOk();
  assert.equal((await r1).state, 'completed');
  // 终态后重试：返回 completed 既有回执
  const retryAfter = await queue.enqueue({ ...req });
  assert.equal(retryAfter.state, 'completed', '终态重试返回既有回执（幂等）');
  assert.equal(ex.log.length, 1);
  const row = actionsRepo.findById(db, 'r-1');
  assert.equal(row.state, 'completed');
  assert.ok(row.startedAt && row.completedAt, 'repo 记录 started/completed');
});

await okAsync('B16 dispose 后 pending 全 cancelled', async () => {
  const ex = makeFakeExecutor();
  const p1 = ex.nextExecute();
  const queue = new ModelActionQueue({ executor: ex });
  const r1 = queue.enqueue(makeRequest(1));
  const h1 = await p1;
  const r2 = queue.enqueue(makeRequest(2));
  const r3 = queue.enqueue(makeRequest(3));
  await drain();
  h1.settle(); // worker 进入 release 等待
  await drain(); // worker 的 release waiter 先入队
  const disposeP = queue.dispose();
  await drain(); // dispose 自己的 release waiter 随后入队
  h1.releaseOk(); // 一次放行同时满足 worker 与 dispose
  await disposeP;
  assert.equal((await r2).state, 'cancelled');
  assert.equal((await r3).state, 'cancelled');
  assert.equal(ex.log.filter((e) => e[0] === 'execute').length, 1, '只执行过 r-1');
  assert.ok(ex.log.some((e) => e[0] === 'cancel'), 'dispose cancel 活动项');
  const r1State = (await r1).state;
  assert.ok(r1State === 'completed' || r1State === 'cancelled', `活动项到达终态（双 release 确认竞态下为 ${r1State}）`);
  const after = await queue.enqueue(makeRequest(4));
  assert.equal(after.error, 'DISPOSED', 'dispose 后拒绝新请求');
});

await okAsync('B17 重启恢复：预置 unfinished 行 → markInterruptedAll → 不重放', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-bridge-c2-'));
  const db = openDb({ path: path.join(tmp, 'actions.sqlite') });
  // 预置：上次进程遗留 queued + running 各一条
  actionsRepo.insertRequest(db, makeRequest(90, { requestId: 'stale-queued', createdAt: 1 }));
  actionsRepo.insertRequest(db, makeRequest(91, { requestId: 'stale-running', createdAt: 2 }));
  actionsRepo.markRunning(db, 'stale-running', 3);
  assert.equal(actionsRepo.findUnfinished(db).length, 2);
  const repo = {
    findById: (id) => actionsRepo.findById(db, id),
    insertRequest: (req) => actionsRepo.insertRequest(db, req),
    markRunning: (id) => actionsRepo.markRunning(db, id),
    markTerminal: (id, state, o) => actionsRepo.markTerminal(db, id, state, o),
    markInterruptedAll: () => actionsRepo.markInterruptedAll(db),
  };
  const ex = makeFakeExecutor();
  const queue = new ModelActionQueue({ executor: ex, repo });
  const recovered = queue.recoverFromRestart();
  assert.equal(recovered, 2, '恢复条数');
  assert.equal(actionsRepo.findUnfinished(db).length, 0, '无残留未完成');
  assert.equal(actionsRepo.findById(db, 'stale-queued').state, 'interrupted');
  assert.equal(actionsRepo.findById(db, 'stale-running').state, 'interrupted');
  await drain();
  assert.equal(ex.log.length, 0, '不重放（executor 未被调用）');
});

await okAsync('B18 Runtime 未就绪拒绝（execute 抛错 → failed，队列继续）', async () => {
  const ex = makeFakeExecutor();
  const p1 = ex.nextExecute();
  const queue = new ModelActionQueue({ executor: ex });
  const r1 = queue.enqueue(makeRequest(1));
  const h1 = await p1;
  const r2 = queue.enqueue(makeRequest(2));
  h1.throw('RUNTIME_NOT_READY: /api/models 503');
  const rec1 = await r1;
  assert.equal(rec1.state, 'failed');
  assert.match(rec1.error, /RUNTIME_NOT_READY/);
  const h2 = await ex.nextExecute();
  assert.equal(queue.getState().faulted, false, '单条失败不阻断队列');
  h2.settle(); await drain(); h2.releaseOk();
  assert.equal((await r2).state, 'completed');
});

await okAsync('背压：pending ≥ maxPending → {error:QUEUE_FULL}（不抛穿）', async () => {
  const ex = makeFakeExecutor();
  const p1 = ex.nextExecute();
  const queue = new ModelActionQueue({ executor: ex, maxPending: 2 });
  const r1 = queue.enqueue(makeRequest(1));
  const h1 = await p1;
  const r2 = queue.enqueue(makeRequest(2));
  const r3 = queue.enqueue(makeRequest(3));
  const full = await queue.enqueue(makeRequest(4)); // 1 running + 2 pending → 满
  assert.equal(full.error, 'QUEUE_FULL');
  h1.settle(); await drain(); h1.releaseOk();
  assert.equal((await r1).state, 'completed');
  const h2 = await ex.nextExecute();
  h2.settle(); await drain(); h2.releaseOk();
  assert.equal((await r2).state, 'completed');
  const h3 = await ex.nextExecute();
  h3.settle(); await drain(); h3.releaseOk();
  assert.equal((await r3).state, 'completed');
});

await okAsync('cancel：pending 直接 cancelled；未知名返回 not-found', async () => {
  const ex = makeFakeExecutor();
  const p1 = ex.nextExecute();
  const queue = new ModelActionQueue({ executor: ex });
  const r1 = queue.enqueue(makeRequest(1));
  const h1 = await p1;
  const r2 = queue.enqueue(makeRequest(2));
  const c2 = await queue.cancel('r-2');
  assert.equal(c2.state, 'cancelled');
  assert.equal((await r2).state, 'cancelled');
  const nf = await queue.cancel('r-nope');
  assert.equal(nf.state, 'not-found');
  h1.settle(); await drain(); h1.releaseOk();
  assert.equal((await r1).state, 'completed');
});

console.log(`\n结果：${process.exitCode ? '存在失败' : '全部通过'}（${passed} 项用例）`);
if (process.exitCode) process.exit(1);
