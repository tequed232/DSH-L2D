/**
 * nodegraph-exec 转发层测试（Phase 1：MCP 节点图执行侧工具补齐）。
 *
 * 只打本模块的转发与错误归一语义（fetch 全部用假实现，不依赖宿主进程）：
 *   - run 返回 executionId / receipts 原样透传；
 *   - status 透传完整执行记录（含 receipts / remainingSegments）；
 *   - cancel 透传批间取消回执，且工具描述带批间粒度语义文案；
 *   - import 成功后回查 hash，导入失败不回查；
 *   - plugin-offline / timeout / unreachable / 非 JSON 的错误归一；
 *   - 工具描述关键约束文案（对 Agent 的硬约束）不漂移。
 */
import assert from 'node:assert/strict';
import {
  NODEGRAPH_EXEC_TIMEOUTS,
  NODEGRAPH_EXEC_TOOL_DESCRIPTIONS,
  nodegraphCancel,
  nodegraphImport,
  nodegraphRun,
  nodegraphStatus,
} from './nodegraph-exec.mjs';

/** 记录请求并按脚本回放的假 fetch。calls: [{url, init}]；queue 依次出队作为响应。 */
function makeFetch(queue) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, init });
    const next = queue.shift();
    if (!next) throw new Error('unexpected extra fetch: ' + url);
    if (next.throw) throw next.throw;
    return {
      status: next.status || 200,
      text: async () => (typeof next.body === 'string' ? next.body : JSON.stringify(next.body === undefined ? {} : next.body)),
    };
  };
  return { impl, calls };
}

// ---------------------------------------------------------------------------
// 1) run：executionId / receipts 原样透传，POST 到 /nodegraphs/run?name=
// ---------------------------------------------------------------------------
{
  const runResult = {
    ok: true,
    status: 'completed',
    executionId: 'e-abc-123',
    name: 'greet',
    receipts: [{ segmentIndex: 0, ok: true, accepted: true, runId: 'r1' }],
    completedSegments: 2,
    remainingSegments: 0,
  };
  const { impl, calls } = makeFetch([{ body: runResult }]);
  const out = await nodegraphRun('greet', { base: 'http://127.0.0.1:5200', fetchImpl: impl });
  assert.equal(out.ok, true, 'run 透传 ok');
  assert.equal(out.executionId, 'e-abc-123', 'run 返回 executionId 透传');
  assert.deepEqual(out.receipts, runResult.receipts, 'run 返回 receipts 透传');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:5200/dsh-l2d/nodegraphs/run?name=greet');
  assert.equal(calls[0].init.method, 'POST');
}

// ---------------------------------------------------------------------------
// 2) run：name 需 URL 编码；modelId 透传为查询参数
// ---------------------------------------------------------------------------
{
  const { impl, calls } = makeFetch([{ body: { ok: false, reason: 'mode-blocked', status: 409 } }]);
  const out = await nodegraphRun('早 安 图', { base: 'http://127.0.0.1:5200', modelId: 'demo-model', fetchImpl: impl });
  assert.equal(out.reason, 'mode-blocked', '宿主 409 mode-blocked 原样透传');
  assert.equal(calls[0].url, 'http://127.0.0.1:5200/dsh-l2d/nodegraphs/run?name=' + encodeURIComponent('早 安 图') + '&modelId=demo-model');
}

// ---------------------------------------------------------------------------
// 3) status：完整执行记录透传（含每批 receipts / 剩余批次 / 失败原因）
// ---------------------------------------------------------------------------
{
  const record = {
    executionId: 'e-1',
    name: 'greet',
    startedAt: 1,
    finishedAt: 2,
    status: 'cancelled',
    cancelRequested: true,
    result: { ok: true, status: 'stopped', receipts: [{ segmentIndex: 1, ok: false, reason: 'cancelled' }], remainingSegments: 3 },
  };
  const { impl, calls } = makeFetch([{ body: { ok: true, record } }]);
  const out = await nodegraphStatus('e-1', { base: 'http://127.0.0.1:5200', fetchImpl: impl });
  assert.equal(out.ok, true);
  assert.equal(out.record.status, 'cancelled', 'status 透传状态');
  assert.equal(out.record.result.remainingSegments, 3, 'status 透传剩余批次');
  assert.deepEqual(out.record.result.receipts, record.result.receipts, 'status 透传每批 receipts');
  assert.equal(calls[0].url, 'http://127.0.0.1:5200/dsh-l2d/nodegraphs/executions?id=e-1');
}

// ---------------------------------------------------------------------------
// 4) cancel：批间取消回执透传；404 / 非 JSON 归一
// ---------------------------------------------------------------------------
{
  const { impl, calls } = makeFetch([{ body: { ok: true, cancelled: true, executionId: 'e-1' } }]);
  const out = await nodegraphCancel('e-1', { base: 'http://127.0.0.1:5200', fetchImpl: impl });
  assert.equal(out.cancelled, true, 'cancel 透传 cancelled');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].url, 'http://127.0.0.1:5200/dsh-l2d/nodegraphs/cancel?id=e-1');
}
{
  const { impl } = makeFetch([{ body: { ok: false, errors: ['running execution not found: e-x'] }, status: 404 }]);
  const out = await nodegraphCancel('e-x', { base: 'http://127.0.0.1:5200', fetchImpl: impl });
  assert.equal(out.ok, false, 'cancel 404 透传 ok:false');
  assert.deepEqual(out.errors, ['running execution not found: e-x']);
}
{
  const { impl } = makeFetch([{ body: 'oops not json', status: 500 }]);
  const out = await nodegraphCancel('e-x', { base: 'http://127.0.0.1:5200', fetchImpl: impl });
  assert.deepEqual(out, { ok: false, reason: 'http-500' }, '非 JSON 响应归一为 http-<status>');
}

// ---------------------------------------------------------------------------
// 5) import：成功后回查 hash；校验失败原样透传 errors 且不回查
// ---------------------------------------------------------------------------
{
  const { impl, calls } = makeFetch([
    { body: { ok: true, name: 'greet' } },
    { body: { ok: true, name: 'greet', hash: '0123456789abcdef', valid: true, modelId: 'demo-model', live2dIdsSource: 'model' } },
  ]);
  const doc = { schemaVersion: 1, kind: 'dsh-l2d-nodegraph', name: 'greet', segments: [] };
  const out = await nodegraphImport(doc, { base: 'http://127.0.0.1:5200', fetchImpl: impl });
  assert.equal(out.ok, true);
  assert.equal(out.name, 'greet', 'import 回传 saved name');
  assert.equal(out.hash, '0123456789abcdef', 'import 回传图 hash（apply-ops 的 baseHash）');
  assert.equal(out.modelId, 'demo-model');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].url, 'http://127.0.0.1:5200/dsh-l2d/nodegraphs/import');
  assert.equal(JSON.parse(calls[0].init.body).name, 'greet', 'import POST body 是完整分享 JSON 对象');
  assert.equal(calls[1].url, 'http://127.0.0.1:5200/dsh-l2d/api/nodegraph/graph?name=greet', 'hash 回查走既有 graph 路由');
}
{
  const { impl, calls } = makeFetch([{ body: { ok: false, errors: ['kind 必须是 dsh-l2d-nodegraph'] } }]);
  const out = await nodegraphImport({ kind: 'nope' }, { base: 'http://127.0.0.1:5200', fetchImpl: impl });
  assert.equal(out.ok, false);
  assert.deepEqual(out.errors, ['kind 必须是 dsh-l2d-nodegraph'], '导入校验失败原样透传宿主 errors');
  assert.equal(calls.length, 1, '导入失败不回查 hash');
}
{
  const { impl } = makeFetch([{ body: { ok: true, name: 'greet' } }, { throw: new TypeError('boom') }]);
  const out = await nodegraphImport({}, { base: 'http://127.0.0.1:5200', fetchImpl: impl });
  assert.equal(out.ok, true, 'hash 回查失败不影响导入成功语义');
  assert.equal(out.hashUnavailable, true);
  assert.equal(out.hashReason, 'unreachable');
}

// ---------------------------------------------------------------------------
// 6) 错误归一：plugin-offline / timeout / unreachable
// ---------------------------------------------------------------------------
{
  const out = await nodegraphRun('greet', {});
  assert.deepEqual(out, { ok: false, reason: 'plugin-offline' }, '无 base → plugin-offline');
  for (const fn of [nodegraphImport, nodegraphStatus, nodegraphCancel]) {
    const r = await fn(fn === nodegraphImport ? {} : 'x', {});
    assert.deepEqual(r, { ok: false, reason: 'plugin-offline' });
  }
}
{
  const { impl } = makeFetch([{ throw: Object.assign(new Error('deadline'), { name: 'TimeoutError' }) }]);
  const out = await nodegraphRun('greet', { base: 'http://127.0.0.1:5200', fetchImpl: impl });
  assert.equal(out.reason, 'timeout', '超时归一为 timeout（不吞成 unreachable）');
  assert.equal(out.timeoutMs, NODEGRAPH_EXEC_TIMEOUTS.run);
}
{
  const { impl } = makeFetch([{ throw: new TypeError('ECONNREFUSED') }]);
  const out = await nodegraphStatus('e-1', { base: 'http://127.0.0.1:5200', fetchImpl: impl });
  assert.deepEqual(out, { ok: false, reason: 'unreachable' });
}

// ---------------------------------------------------------------------------
// 7) 工具描述关键语义文案（对 Agent 的硬约束）不漂移
// ---------------------------------------------------------------------------
{
  const run = NODEGRAPH_EXEC_TOOL_DESCRIPTIONS.run;
  for (const key of ['completed', 'model-mismatch', 'executionId', 'receipts', '不得向用户宣称动作已执行', 'conflict', 'priority-blocked', 'mode-blocked']) {
    assert.ok(run.includes(key), 'run 描述必须包含：' + key);
  }
  const cancel = NODEGRAPH_EXEC_TOOL_DESCRIPTIONS.cancel;
  for (const key of ['批间粒度', '已入队动作不保证立即中断', 'l2d_nodegraph_status']) {
    assert.ok(cancel.includes(key), 'cancel 描述必须包含：' + key);
  }
  const imp = NODEGRAPH_EXEC_TOOL_DESCRIPTIONS.import;
  for (const key of ['NODE-SCHEMA.json', 'live2d-ids', 'errors', 'strict']) {
    assert.ok(imp.includes(key), 'import 描述必须包含：' + key);
  }
  const status = NODEGRAPH_EXEC_TOOL_DESCRIPTIONS.status;
  for (const key of ['completedSegments', 'remainingSegments', 'receipts', 'executionId']) {
    assert.ok(status.includes(key), 'status 描述必须包含：' + key);
  }
}

console.log('nodegraph-exec tests passed');
