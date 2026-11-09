import assert from 'node:assert/strict';
import { createRunRegistry } from './nodegraph-runs.mjs';

// ---------------------------------------------------------------------------
// 夹具：注入时钟（不依赖真实时间，可精确断言 startedAt/finishedAt）
// ---------------------------------------------------------------------------
function makeClock(start = 1000) {
  let t = start;
  return {
    now: () => t,
    tick: (n = 1) => {
      t += n;
      return t;
    },
  };
}

// ---------------------------------------------------------------------------
// 1) begin 登记 + get 完整记录
// ---------------------------------------------------------------------------
{
  const clock = makeClock();
  const registry = createRunRegistry({ now: clock.now });
  const begun = registry.begin('e1', '挥手打招呼');
  assert.deepEqual(begun, { ok: true, executionId: 'e1' });
  const rec = registry.get('e1');
  assert.equal(rec.executionId, 'e1');
  assert.equal(rec.name, '挥手打招呼');
  assert.equal(rec.startedAt, 1000);
  assert.equal(rec.status, 'running');
  assert.equal(rec.cancelRequested, false);
  assert.equal(rec.finishedAt, null);
  assert.equal(rec.result, null);
}

// ---------------------------------------------------------------------------
// 2) 同图互斥（busy 返回既有 executionId）；跨图并行允许（按图隔离粒度）
// ---------------------------------------------------------------------------
{
  const registry = createRunRegistry();
  assert.equal(registry.begin('a1', '图A').ok, true);
  const busy = registry.begin('a2', '图A');
  assert.equal(busy.ok, false);
  assert.equal(busy.reason, 'busy');
  assert.equal(busy.executionId, 'a1');
  // 名字相同但旧记录已终态 → 不再 busy
  assert.equal(registry.finish('a1', { ok: true, status: 'completed' }), true);
  assert.equal(registry.begin('a3', '图A').ok, true);
  // 跨图并行允许
  assert.equal(registry.begin('b1', '图B').ok, true);
}

// ---------------------------------------------------------------------------
// 3) requestCancel：running → true 且标志可读；缺失/终态 → false
// ---------------------------------------------------------------------------
{
  const registry = createRunRegistry();
  registry.begin('c1', '图C');
  assert.equal(registry.requestCancel('c1'), true);
  assert.equal(registry.get('c1').cancelRequested, true);
  assert.equal(registry.requestCancel('missing'), false);
  registry.finish('c1', { ok: false, status: 'stopped', reason: 'cancelled' });
  assert.equal(registry.requestCancel('c1'), false);
}

// ---------------------------------------------------------------------------
// 4) finish 状态映射：completed / failed / cancelled / timeout；终态不可再写
// ---------------------------------------------------------------------------
{
  const clock = makeClock();
  const registry = createRunRegistry({ now: clock.now });
  clock.tick(5);

  // completed
  registry.begin('f1', '图');
  const result = { ok: true, status: 'completed', receipts: [{ batch: 0 }] };
  assert.equal(registry.finish('f1', result), true);
  const rec1 = registry.get('f1');
  assert.equal(rec1.status, 'completed');
  assert.equal(rec1.finishedAt, 1005);
  assert.deepEqual(rec1.result, result);
  // 终态后 finish / requestCancel 均无效
  assert.equal(registry.finish('f1', { ok: true, status: 'completed' }), false);
  assert.equal(registry.requestCancel('f1'), false);

  // stopped 未请求取消 → failed
  registry.begin('f2', '图');
  registry.finish('f2', { ok: false, status: 'stopped', reason: 'conflict', receipts: [] });
  assert.equal(registry.get('f2').status, 'failed');

  // stopped + 已请求取消 → cancelled
  registry.begin('f3', '图');
  registry.requestCancel('f3');
  registry.finish('f3', { ok: false, status: 'stopped', reason: 'cancelled', receipts: [] });
  assert.equal(registry.get('f3').status, 'cancelled');

  // HTTP 层失败形状（status 为数字）→ failed
  registry.begin('f4', '图');
  registry.finish('f4', { ok: false, status: 409, reason: 'mode-blocked' });
  assert.equal(registry.get('f4').status, 'failed');

  // timeout
  registry.begin('f5', '图');
  registry.finish('f5', { ok: false, status: 'stopped', reason: 'timeout' });
  assert.equal(registry.get('f5').status, 'timeout');

  // rejected（invalid-sequence）→ failed
  registry.begin('f6', '图');
  registry.finish('f6', { ok: false, status: 'rejected', reason: 'invalid-sequence' });
  assert.equal(registry.get('f6').status, 'failed');
}

// ---------------------------------------------------------------------------
// 5) list：最新在前、limit 截断、摘要不含 result 全文
// ---------------------------------------------------------------------------
{
  const registry = createRunRegistry();
  registry.begin('l1', '图1');
  registry.finish('l1', { ok: true, status: 'completed', receipts: [{ batch: 0, receipt: { events: ['x'] } }] });
  registry.begin('l2', '图2');
  const all = registry.list();
  assert.equal(all.length, 2);
  assert.equal(all[0].executionId, 'l2');
  assert.equal(all[1].executionId, 'l1');
  for (const item of all) {
    assert.deepEqual(
      Object.keys(item).sort(),
      ['cancelRequested', 'executionId', 'finishedAt', 'name', 'startedAt', 'status'],
    );
    assert.ok(!('result' in item));
  }
  const one = registry.list({ limit: 1 });
  assert.equal(one.length, 1);
  assert.equal(one[0].executionId, 'l2');
}

// ---------------------------------------------------------------------------
// 6) get 缺失 → null（路由层映射 404）
// ---------------------------------------------------------------------------
{
  const registry = createRunRegistry();
  assert.equal(registry.get('nope'), null);
  assert.equal(registry.list().length, 0);
}

// ---------------------------------------------------------------------------
// 7) LRU 淘汰：容量满优先淘汰最旧终态；全 running 时淘汰绝对最旧
// ---------------------------------------------------------------------------
{
  const registry = createRunRegistry({ maxRecords: 3 });
  registry.begin('k1', '图1');
  registry.begin('k2', '图2');
  registry.begin('k3', '图3');
  registry.finish('k1', { ok: true, status: 'completed' });
  registry.finish('k2', { ok: true, status: 'completed' });
  registry.begin('k4', '图4'); // 满 → 淘汰最旧终态 k1，running 的 k3 保留
  assert.equal(registry.get('k1'), null);
  assert.notEqual(registry.get('k2'), null);
  assert.notEqual(registry.get('k3'), null);
  assert.notEqual(registry.get('k4'), null);
  registry.begin('k5', '图5'); // 满 → 淘汰最旧终态 k2
  assert.equal(registry.get('k2'), null);
  assert.notEqual(registry.get('k3'), null);
}

{
  const registry = createRunRegistry({ maxRecords: 2 });
  registry.begin('r1', '图1');
  registry.begin('r2', '图2');
  registry.begin('r3', '图3'); // 全 running → 淘汰绝对最旧 r1，begin 不失败
  assert.equal(registry.get('r1'), null);
  assert.notEqual(registry.get('r2'), null);
  assert.notEqual(registry.get('r3'), null);
  assert.equal(registry.list().length, 2);
}

// ---------------------------------------------------------------------------
// 8) finish / requestCancel 缺失记录 → false（不抛异常）
// ---------------------------------------------------------------------------
{
  const registry = createRunRegistry();
  assert.equal(registry.finish('ghost', { ok: true, status: 'completed' }), false);
  assert.equal(registry.requestCancel('ghost'), false);
}

console.log('nodegraph-runs.test.mjs: all assertions passed');
