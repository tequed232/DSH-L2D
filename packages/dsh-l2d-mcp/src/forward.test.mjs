/**
 * forwardCall 超时预算回归测试（#31）。
 *
 * 复现场景（issue 原样）：宿主对 /status、/ai/call 即时响应，第一次 /ai/result
 * 延迟 4.2s 后返回 ready；配置超时 3s——修复前约 4.22s 才返回且回执为成功；
 * 修复后统一截止时间应在 ~3s 如实返回等待超时并保留可查询 id。
 *
 * 另覆盖：结果 GET 永久挂住（截止时间硬性中止）、入队 POST 挂住、
 * 正常即时回执路径、act 模式 accepted-未终态的 pending 回执带 id。
 * 运行：node packages/dsh-l2d-mcp/src/forward.test.mjs
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { forwardCall } from './forward.mjs';

/** 本机模拟 HTTP 宿主。返回 { base, close }。 */
function startHost({
  callBody = { ok: true, id: 'q1' },
  callDelayMs = 0,
  hangCall = false,
  resultDelayMs = 0,
  hangResult = false,
  resultBody = { ready: true, result: { ok: true } },
  resultEvents = [],
}) {
  const hits = { call: 0, result: 0 };
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/dsh-l2d/ai/call')) {
      hits.call++;
      if (hangCall) return; // 永不响应
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(callBody));
      }, callDelayMs);
      return;
    }
    if (req.url.startsWith('/dsh-l2d/ai/result')) {
      hits.result++;
      if (hangResult) return; // 永不响应
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ...resultBody, events: resultEvents }));
      }, resultDelayMs);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ base: `http://127.0.0.1:${server.address().port}`, hits, close: () => server.close() });
    });
  });
}

let passed = 0;
async function ok(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`);
    process.exitCode = 1;
  }
}

console.log('forwardCall 超时预算（#31）');

await ok('issue 复现：首份 /ai/result 迟到 4.2s、预算 3s → ~3s 返回 timeout 且保留 id（不误报成功）', async () => {
  const host = await startHost({ resultDelayMs: 4200, resultBody: { ready: true, result: { ok: true } } });
  try {
    const t0 = Date.now();
    const r = await forwardCall({ base: host.base, name: 'l2d_emote', args: { mood: '开心' }, timeoutMs: 3000 });
    const elapsed = Date.now() - t0;
    assert.equal(r.ok, false, `不应误报成功：${JSON.stringify(r)}`);
    assert.equal(r.reason, 'timeout');
    assert.equal(r.id, 'q1', '已入队请求必须保留可查询标识');
    assert.ok(elapsed < 3800, `总耗时应贴近 3s 预算，实际 ${elapsed}ms`);
    assert.ok(elapsed >= 2800, `不应提前放弃，实际 ${elapsed}ms`);
  } finally {
    host.close();
  }
});

await ok('结果 GET 永久挂住 → 截止时间硬性中止（不无限挂起）', async () => {
  const host = await startHost({ hangResult: true });
  try {
    const t0 = Date.now();
    const r = await forwardCall({ base: host.base, name: 'l2d_emote', args: {}, timeoutMs: 800, pollIntervalMs: 60 });
    const elapsed = Date.now() - t0;
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'timeout');
    assert.equal(r.id, 'q1');
    assert.ok(elapsed < 1800, `应在预算附近返回，实际 ${elapsed}ms`);
  } finally {
    host.close();
  }
});

await ok('入队 POST 永久挂住 → 预算内返回 timeout（不再无请求级超时）', async () => {
  const host = await startHost({ hangCall: true });
  try {
    const t0 = Date.now();
    const r = await forwardCall({ base: host.base, name: 'l2d_emote', args: {}, timeoutMs: 600 });
    const elapsed = Date.now() - t0;
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'timeout', `POST 挂住应报 timeout 而非 unreachable：${JSON.stringify(r)}`);
    assert.ok(elapsed < 1500, `应在预算附近返回，实际 ${elapsed}ms`);
  } finally {
    host.close();
  }
});

await ok('POST 网络层失败（连接拒绝）→ unreachable（保持原有清缓存语义）', async () => {
  const r = await forwardCall({ base: 'http://127.0.0.1:1', name: 'l2d_emote', args: {}, timeoutMs: 3000 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unreachable');
});

await ok('即时 ready 回执 → 照常返回成功（不受修复影响）', async () => {
  const host = await startHost({ resultBody: { ready: true, result: { ok: true, mood: '开心' } } });
  try {
    const r = await forwardCall({ base: host.base, name: 'l2d_emote', args: { mood: '开心' }, timeoutMs: 3000 });
    assert.equal(r.ok, true);
    assert.equal(r.mood, '开心');
  } finally {
    host.close();
  }
});

await ok('act 模式 accepted 但终态未知 → pending 回执带 id（可查询，不误重放）', async () => {
  const host = await startHost({
    callBody: { ok: true, id: 'a1' },
    resultBody: { ready: true, result: { ok: true, accepted: true, runId: 'r1' } },
    resultEvents: [],
  });
  try {
    const r = await forwardCall({ base: host.base, name: 'l2d_act', args: { chain: [] }, timeoutMs: 700, mode: 'act', pollIntervalMs: 60 });
    assert.equal(r.ok, true);
    assert.equal(r.accepted, true);
    assert.equal(r.settled, false);
    assert.equal(r.outcome, 'pending');
    assert.equal(r.id, 'a1', 'pending 回执必须携带 callId');
  } finally {
    host.close();
  }
});

await ok('act 模式 accepted 且事件到达 end → settled 回执（不受修复影响）', async () => {
  const host = await startHost({
    callBody: { ok: true, id: 'a2' },
    resultBody: { ready: true, result: { ok: true, accepted: true, runId: 'r2' } },
    resultEvents: [{ type: 'action-done', phase: 'end', runId: 'r2' }],
  });
  try {
    const r = await forwardCall({ base: host.base, name: 'l2d_act', args: { chain: [] }, timeoutMs: 3000, mode: 'act', pollIntervalMs: 60 });
    assert.equal(r.ok, true);
    assert.equal(r.settled, true);
    assert.equal(r.outcome, 'completed');
  } finally {
    host.close();
  }
});

if (process.exitCode) {
  console.error('forward 测试存在失败用例');
} else {
  console.log(`forward ok（${passed} 用例）`);
}
