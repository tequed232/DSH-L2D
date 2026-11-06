/**
 * PR-D（PRD-RUNTIME-EVENT）：HttpActionExecutor 真实完成事件消费 + ownership 出口核对。
 * 全程零真实浏览器/零真实 dev-server：fetchImpl 指向内存版 ai-inbox（语义对齐 lib/ai-inbox.mjs：
 * result 一 id 一份、读取即删；events 读取即排空）。
 * 直跑：node packages/mcp-bridge/tests/action-executor-completion.test.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpActionExecutor } from '../action-executor.mjs';

/** 内存版 ai-inbox + dev-server 路由（只实现本测试用到的面）。 */
function createFakeServer() {
  let seq = 0;
  const results = new Map();
  const events = new Map();
  const stats = { modelsProbes: 0, calls: 0, resultGets: 0 };
  async function fetchImpl(url, opts = {}) {
    const u = new URL(url, 'http://fake.local');
    const json = (status, body) => ({
      ok: status === 200,
      status,
      json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
    });
    if (u.pathname === '/api/models') {
      stats.modelsProbes++;
      return json(200, { models: [] });
    }
    if (u.pathname === '/ai/call' && opts.method === 'POST') {
      stats.calls++;
      const body = JSON.parse(opts.body);
      assert.equal(body.name, 'l2d_act');
      return json(200, { ok: true, id: ++seq, queued: 1 });
    }
    if (u.pathname === '/ai/result') {
      if (opts.method === 'POST') {
        const body = JSON.parse(opts.body);
        const id = Number(body.id);
        if (body.event !== undefined) {
          const list = events.get(id) || [];
          list.push(body.event);
          events.set(id, list);
        }
        if (body.result !== undefined) results.set(id, body.result);
        return json(200, { ok: true });
      }
      stats.resultGets++;
      const id = Number(u.searchParams.get('id'));
      const drained = events.get(id) || [];
      events.delete(id);
      const out = {};
      if (results.has(id)) {
        out.ready = true;
        out.result = results.get(id);
        results.delete(id);
      } else {
        out.ready = false;
      }
      if (drained.length) out.events = drained;
      return json(200, out);
    }
    return json(404, { error: 'no route' });
  }
  return { fetchImpl, stats, lastId: () => seq, postResult: (id, result) => results.set(Number(id), result), postEvent: (id, event) => {
    const list = events.get(Number(id)) || [];
    list.push(event);
    events.set(Number(id), list);
  } };
}

const REQUEST = (chain) => ({
  requestId: 'pr-d-1', workspaceId: 'ws', controlSessionId: 's',
  action: 'test', args: { chain }, priority: 50,
});

test('① 降级路径不变：预估 end（无 completionSource）→ execute 不带真实完成字段，release 落 TTL 宽限', async () => {
  const fake = createFakeServer();
  const executor = new HttpActionExecutor({ baseUrl: 'http://fake.local', fetchImpl: fake.fetchImpl, pollIntervalMs: 10, releaseGraceMs: 5 });
  const pending = executor.execute(REQUEST([{ kind: 'motion', name: '挥手' }]));
  // 模拟 overlay：受理后 20ms 发预估 end（老渲染包形态，无 completionSource）
  setTimeout(() => {
    const id = fake.lastId();
    fake.postResult(id, { ok: true, accepted: true, runId: id });
    fake.postEvent(id, { type: 'action-done', phase: 'end', callId: id, runId: id, source: 'ai', steps: 1, ts: Date.now() });
  }, 20);
  const r = await pending;
  assert.equal(r.ok, true);
  assert.equal(r.completionSource, undefined, '预估兜底不得冒充 runtime-event');
  assert.equal(r.ownedParams, undefined);
  const rel = await executor.release({ executionId: r.executionId });
  assert.deepEqual(rel, { confirmed: false, via: 'ttl-grace' });
});

test('② 真实完成事件 + ownership 出口干净 → release confirmed（不再依赖 TTL）', async () => {
  const fake = createFakeServer();
  const executor = new HttpActionExecutor({ baseUrl: 'http://fake.local', fetchImpl: fake.fetchImpl, pollIntervalMs: 10, releaseGraceMs: 0 });
  const pending = executor.execute(REQUEST([
    { kind: 'keyframes', tracks: [{ param: 'ParamAngleZ', keys: [[0, 0], [500, 18]] }], duration: 500 },
    { kind: 'motion', name: '竖手指打开' },
  ]));
  setTimeout(() => {
    const id = fake.lastId();
    fake.postResult(id, { ok: true, accepted: true, runId: id });
    fake.postEvent(id, {
      type: 'action-done', phase: 'end', callId: id, runId: id, source: 'ai', steps: 2, ts: Date.now(),
      completionSource: 'runtime-event',
      ownedParams: [], // keyframes 完成时 auto-owned 已释放，出口核对应为空
    });
  }, 20);
  const r = await pending;
  assert.equal(r.completionSource, 'runtime-event');
  assert.deepEqual(r.ownedParams, []);
  assert.equal(r.ownershipExit, 'clear');
  const rel = await executor.release({ executionId: r.executionId });
  assert.deepEqual(rel, { confirmed: true, via: 'completion-event+ownership-exit' }, '真实完成+出口干净必须给 confirmed');
});

test('③ 出口残留如实上报：本链 keyframes 参数仍在认领 → confirmed:false + leaked（fail-closed 不伪报）', async () => {
  const fake = createFakeServer();
  const executor = new HttpActionExecutor({ baseUrl: 'http://fake.local', fetchImpl: fake.fetchImpl, pollIntervalMs: 10, releaseGraceMs: 5 });
  const pending = executor.execute(REQUEST([
    { kind: 'keyframes', tracks: [{ param: 'Param4', keys: [[0, 0], [400, 1]] }] },
  ]));
  setTimeout(() => {
    const id = fake.lastId();
    fake.postResult(id, { ok: true, accepted: true, runId: id });
    fake.postEvent(id, {
      type: 'action-done', phase: 'end', callId: id, runId: id, ts: Date.now(),
      completionSource: 'runtime-event',
      ownedParams: ['Param4', 'Param99'], // Param4 残留（异常），Param99 是他链持有（不在核对范围）
    });
  }, 20);
  const r = await pending;
  assert.equal(r.ownershipExit, 'residual');
  assert.deepEqual(r.leakedParams, ['Param4'], '只核对本链范围，不误伤其他链的持有');
  const rel = await executor.release({ executionId: r.executionId });
  assert.equal(rel.confirmed, false);
  assert.equal(rel.via, 'completion-event-ownership-residual');
  assert.deepEqual(rel.leaked, ['Param4']);
});

test('④ 事件订阅优先：注入 subscribeEvents 后不轮询 /ai/result', async () => {
  const fake = createFakeServer();
  let subscribed = 0;
  const executor = new HttpActionExecutor({
    baseUrl: 'http://fake.local', fetchImpl: fake.fetchImpl, pollIntervalMs: 10,
    subscribeEvents: async (callId, onEvent) => {
      subscribed++;
      assert.equal(String(callId), String(fake.lastId()), '订阅按 callId 关联');
      fake.postEvent(callId, {
        type: 'action-done', phase: 'end', callId, runId: callId, ts: Date.now(),
        completionSource: 'runtime-event', ownedParams: [],
      });
      onEvent({ type: 'action-done', phase: 'end', completionSource: 'runtime-event', ownedParams: [] });
      return { phase: 'end', completionSource: 'runtime-event', ownedParams: [] };
    },
  });
  const r = await executor.execute(REQUEST([{ kind: 'motion', name: '点头' }]));
  assert.equal(subscribed, 1);
  assert.equal(fake.stats.resultGets, 0, '订阅可用时不得走轮询');
  assert.equal(r.completionSource, 'runtime-event');
  const rel = await executor.release({ executionId: r.executionId });
  assert.equal(rel.confirmed, true);
});

test('⑤ 订阅不可达 → 轮询降级照样拿到完成（fail-closed）', async () => {
  const fake = createFakeServer();
  const executor = new HttpActionExecutor({
    baseUrl: 'http://fake.local', fetchImpl: fake.fetchImpl, pollIntervalMs: 10,
    subscribeEvents: async () => {
      throw new Error('subscription transport down');
    },
  });
  const pending = executor.execute(REQUEST([{ kind: 'motion', name: '点头' }]));
  setTimeout(() => {
    const id = fake.lastId();
    fake.postResult(id, { ok: true, accepted: true, runId: id });
    fake.postEvent(id, { type: 'action-done', phase: 'end', callId: id, runId: id, ts: Date.now() });
  }, 20);
  const r = await pending;
  assert.equal(r.ok, true);
  assert.equal(fake.stats.resultGets > 0, true, '降级后必须真的在轮询');
  const rel = await executor.release({ executionId: r.executionId });
  assert.deepEqual(rel, { confirmed: false, via: 'ttl-grace' });
});

test('⑥ 拒绝路径保持原语义：result 通道 ok:false 即时失败', async () => {
  const fake = createFakeServer();
  const executor = new HttpActionExecutor({ baseUrl: 'http://fake.local', fetchImpl: fake.fetchImpl, pollIntervalMs: 10 });
  const pending = executor.execute(REQUEST([{ kind: 'look', x: 0, y: 0 }]));
  setTimeout(() => {
    fake.postResult(fake.lastId(), { ok: false, accepted: false, reason: 'priority-blocked' });
  }, 20);
  const r = await pending;
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'priority-blocked');
});

test('⑦ 构造校验：subscribeEvents 非函数必须抛错', () => {
  assert.throws(
    () => new HttpActionExecutor({ baseUrl: 'http://fake.local', subscribeEvents: 'nope' }),
    /subscribeEvents/,
  );
});

console.log('\nPR-D action-executor 完成事件/释放核对测试全部通过');
