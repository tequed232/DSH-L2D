/**
 * MCP Tools + Scope 验收（PR-B）。
 * queue/cancel/getStatus 全 fake 注入（PR-C 才接真队列），零真实 HTTP。
 * 直跑：node packages/mcp-bridge/tests/mcp-tools.test.mjs
 */
import assert from 'node:assert';
import { registerLive2DTools } from '../mcp-tools.mjs';
import { createScopedRegistry } from '../scope.mjs';

let passed = 0;
async function okAsync(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1; }
}

function makeDeps(over = {}) {
  const calls = { enqueue: [], status: [], cancel: [] };
  return {
    calls,
    deps: {
      workspace: { id: 'ws-1', controlSessionId: 'sess-control-1' },
      validateAction: (action) => ['wave.right', 'nod', 'wave.left'].includes(action),
      enqueue: async (request) => { calls.enqueue.push(request); return { requestId: request.requestId, state: 'queued' }; },
      getStatus: async (requestId) => { calls.status.push(requestId); return { receipt: { requestId, state: 'running' }, queue: { depth: 2, activeRequestId: 'r-active' } }; },
      cancel: async (requestId) => { calls.cancel.push(requestId); return requestId === 'r-cancellable'; },
      ...over,
    },
  };
}

function captureRegistry() {
  const tools = {};
  return { tools, registerTool: (name, handler) => { tools[name] = handler; } };
}

console.log('PR-B MCP Tools + Scope');

await okAsync('happy path：三工具注册且 enqueue 携带完整 ModelActionRequest 形状', async () => {
  const reg = captureRegistry();
  const { deps, calls } = makeDeps();
  const names = registerLive2DTools(reg, deps);
  assert.deepEqual(names.sort(), ['l2d_action_cancel', 'l2d_action_enqueue', 'l2d_action_status']);
  const r = await reg.tools.l2d_action_enqueue({ requestId: 'r-1', action: 'wave.right', args: { speed: 1 }, priority: 30, timeoutMs: 10000, memoryRevision: 5 });
  assert.deepEqual(r, { requestId: 'r-1', state: 'queued' });
  assert.equal(calls.enqueue.length, 1);
  const req = calls.enqueue[0];
  assert.equal(req.workspaceId, 'ws-1');
  assert.equal(req.controlSessionId, 'sess-control-1');
  assert.equal(req.action, 'wave.right');
  assert.deepEqual(req.args, { speed: 1 });
  assert.equal(req.priority, 30);
  assert.equal(req.timeoutMs, 10000);
  assert.equal(req.memoryRevision, 5);
  assert.ok(Number.isInteger(req.createdAt));
  const s = await reg.tools.l2d_action_status({ requestId: 'r-1' });
  assert.deepEqual(s, { receipt: { requestId: 'r-1', state: 'running' }, queue: { depth: 2, activeRequestId: 'r-active' } });
  const c = await reg.tools.l2d_action_cancel({ requestId: 'r-cancellable' });
  assert.deepEqual(c, { cancelled: true });
});

await okAsync('校验拒绝矩阵：缺 requestId/非法 action/args 数组/priority 101/timeoutMs 500', async () => {
  const reg = captureRegistry();
  const { deps, calls } = makeDeps();
  registerLive2DTools(reg, deps);
  const enq = reg.tools.l2d_action_enqueue;
  assert.match((await enq({ action: 'wave.right' })).detail, /requestId/);
  assert.match((await enq({ requestId: '', action: 'wave.right' })).detail, /requestId/);
  assert.match((await enq({ requestId: 'r', action: '' })).detail, /action/);
  assert.match((await enq({ requestId: 'r', action: 'ParamAngleX' })).detail, /未注册/, '任意 Cubism 参数 ID 拒绝');
  assert.match((await enq({ requestId: 'r', action: 'wave.right', args: [1, 2] })).detail, /args/);
  assert.match((await enq({ requestId: 'r', action: 'wave.right', priority: 101 })).detail, /priority/);
  assert.match((await enq({ requestId: 'r', action: 'wave.right', priority: -1 })).detail, /priority/);
  assert.match((await enq({ requestId: 'r', action: 'wave.right', timeoutMs: 500 })).detail, /timeoutMs/);
  assert.match((await enq({ requestId: 'r', action: 'wave.right', timeoutMs: 300001 })).detail, /timeoutMs/);
  assert.match((await reg.tools.l2d_action_status({})).detail, /requestId/);
  assert.match((await reg.tools.l2d_action_cancel({ requestId: 42 })).detail, /requestId/);
  assert.equal(calls.enqueue.length, 0, '被拒请求不得到达队列');
});

await okAsync('缺省值：priority=50 / timeoutMs=30000 / args={} / memoryRevision=0', async () => {
  const reg = captureRegistry();
  const { deps, calls } = makeDeps();
  registerLive2DTools(reg, deps);
  await reg.tools.l2d_action_enqueue({ requestId: 'r-2', action: 'nod' });
  const req = calls.enqueue[0];
  assert.equal(req.priority, 50);
  assert.equal(req.timeoutMs, 30000);
  assert.deepEqual(req.args, {});
  assert.equal(req.memoryRevision, 0);
});

await okAsync('validateAction 拒绝理由透传：{ok:false, reason}', async () => {
  const reg = captureRegistry();
  const { deps } = makeDeps({ validateAction: () => ({ ok: false, reason: 'capability-missing' }) });
  registerLive2DTools(reg, deps);
  const r = await reg.tools.l2d_action_enqueue({ requestId: 'r', action: 'wave.right' });
  assert.match(r.detail, /capability-missing/);
});

await okAsync('deps 缺失即抛：不静默降级', async () => {
  const reg = captureRegistry();
  const { deps } = makeDeps();
  assert.throws(() => registerLive2DTools(reg, { ...deps, enqueue: undefined }), /enqueue/);
  assert.throws(() => registerLive2DTools(reg, { ...deps, workspace: null }), /workspace/);
  assert.throws(() => registerLive2DTools(reg, { ...deps, validateAction: undefined }), /validateAction/);
});

await okAsync('scope 白名单：l2d_chat_tool 注册 throw / l2d_action_enqueue / l2d_get_status_x 通过', async () => {
  const inner = captureRegistry();
  const scoped = createScopedRegistry(inner);
  assert.throws(() => scoped.registerTool('l2d_chat_tool', () => {}), /scope-forbidden/);
  assert.throws(() => scoped.registerTool('workspace_delete', () => {}), /scope-forbidden/);
  scoped.registerTool('l2d_action_enqueue', async () => ({}));
  scoped.registerTool('l2d_get_status_snapshot', async () => ({}));
  scoped.registerTool('l2d_gallery_top', async () => ({}));
  assert.ok(inner.tools.l2d_action_enqueue && inner.tools.l2d_get_status_snapshot && inner.tools.l2d_gallery_top, '白名单前缀正常透传');
  assert.deepEqual(scoped.allowedPrefixes, ['l2d_action_', 'l2d_get_status', 'l2d_gallery_']);
  assert.throws(() => createScopedRegistry(inner, []), /allowedPrefixes/);
});

await okAsync('组合：scoped registry + tools 注册（Model Control 会话真实装配形状）', async () => {
  const inner = captureRegistry();
  const scoped = createScopedRegistry(inner);
  const { deps } = makeDeps();
  registerLive2DTools(scoped, deps);
  assert.deepEqual(Object.keys(inner.tools).sort(), ['l2d_action_cancel', 'l2d_action_enqueue', 'l2d_action_status']);
  const r = await inner.tools.l2d_action_enqueue({ requestId: 'r-9', action: 'nod' });
  assert.equal(r.state, 'queued');
});

console.log(`\n结果：${process.exitCode ? '存在失败' : '全部通过'}（${passed} 项用例）`);
if (process.exitCode) process.exit(1);
