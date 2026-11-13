/**
 * OACA-3 确定性路由测试（action-router / trigger-router）。
 * 用假 repo + 假 enqueue：不连真库、不发 HTTP、不调 LLM。
 * 直跑：node packages/mcp-bridge/tests/action-router.test.mjs
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ActionRouter, ActionRouterError, validateActionParameters } from '../action-router.mjs';
import { TriggerRouter } from '../trigger-router.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_DIR = path.resolve(HERE, '..');

let passed = 0;
async function okAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err && err.message ? err.message : err}`);
    process.exitCode = 1;
  }
}
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

/** 断言抛 ActionRouterError 且 reason/status 符合预期。 */
function assertRouterError(err, reason, status) {
  assert.ok(err instanceof ActionRouterError, `应为 ActionRouterError，实际 ${err && err.name}`);
  assert.equal(err.reason, reason, `reason 应为 ${reason}，实际 ${err.reason}`);
  if (status !== undefined) assert.equal(err.status, status, `status 应为 ${status}，实际 ${err.status}`);
}

const MODEL = 'm-cur';

function action(actionId, over = {}) {
  return {
    modelId: MODEL,
    actionId,
    graphId: 'graph_' + actionId.replace(/[^a-zA-Z0-9]+/g, '_'),
    graphHash: 'hash-' + actionId,
    capabilityRevision: 'rcap-1',
    status: 'published',
    priority: 'NORMAL',
    triggers: [],
    parameters: { intensity: { type: 'number', min: 0, max: 1, default: 0.6 } },
    requiresOwn: ['ParamAngleX'],
    manifestId: `${MODEL}@rev1`,
    updatedAt: 1,
    ...over,
  };
}

/** 假 repo：纯内存查表，get/list 均为同步（路由层须同时兼容同步/异步）。 */
function fakeRepo(actions) {
  return {
    getPublishedAction: ({ modelId, actionId }) => actions.find((a) => a.modelId === modelId && a.actionId === actionId) || null,
    listPublishedActions: ({ modelId }) => actions.filter((a) => a.modelId === modelId && a.status === 'published'),
  };
}

/** 假 enqueue：记录最后一次请求，返回固定回执。 */
function fakeEnqueue() {
  const calls = [];
  const enqueue = (request) => {
    calls.push(request);
    return Promise.resolve({ requestId: request.requestId, state: 'queued' });
  };
  return { enqueue, calls };
}

console.log('OACA-3 确定性动作路由');

// ---- 1. 正常派发：缺省填 default、enqueue 收到校验后参数、requiresOwn 透出
await okAsync('dispatch：参数缺省填 default，enqueue 收到校验后参数，requiresOwn 透出', async () => {
  const repo = fakeRepo([action('gaze.look', { parameters: {
    intensity: { type: 'number', min: 0, max: 1, default: 0.5 },
    holdMs: { type: 'number', min: 0, max: 3000, default: 800 },
  } })]);
  const { enqueue, calls } = fakeEnqueue();
  const router = new ActionRouter({ repo, enqueue, getCapabilityRevision: () => 'rcap-1' });

  const out = await router.dispatch({ modelId: MODEL, actionId: 'gaze.look', parameters: { intensity: 0.9 }, requestId: 'req-1' });
  assert.equal(out.ok, true);
  assert.equal(out.actionId, 'gaze.look');
  assert.equal(out.graphId, 'graph_gaze_look');
  assert.deepEqual(out.parameters, { intensity: 0.9, holdMs: 800 }, 'holdMs 取 default，intensity 保留调用值');
  assert.deepEqual(out.requiresOwn, ['ParamAngleX'], 'requiresOwn 必须透出（Runtime 先 own 再写）');
  assert.deepEqual(out.warnings, [], '能力 revision 可比对时无 warning');

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    requestId: 'req-1',
    modelId: MODEL,
    actionId: 'gaze.look',
    graphId: 'graph_gaze_look',
    capabilityRevision: 'rcap-1',
    parameters: { intensity: 0.9, holdMs: 800 },
  });
  assert.equal(out.receipt.state, 'queued');
});

// ---- 2. 未知 action → 404 unknown-action
await okAsync('dispatch：未知 action → 404 unknown-action（不调 enqueue）', async () => {
  const { enqueue, calls } = fakeEnqueue();
  const router = new ActionRouter({ repo: fakeRepo([action('head.nod')]), enqueue, getCapabilityRevision: () => 'rcap-1' });
  await assert.rejects(
    () => router.dispatch({ modelId: MODEL, actionId: 'nope.missing', requestId: 'req-2' }),
    (err) => { assertRouterError(err, 'unknown-action', 404); return true; },
  );
  assert.equal(calls.length, 0, '未命中不得入队');
});

// ---- 3. stale → 409；capability revision 不匹配 → 409
await okAsync('dispatch：stale 动作 → 409 stale-action', async () => {
  const router = new ActionRouter({
    repo: fakeRepo([action('head.nod', { status: 'stale' })]),
    enqueue: fakeEnqueue().enqueue,
    getCapabilityRevision: () => 'rcap-1',
  });
  await assert.rejects(
    () => router.dispatch({ modelId: MODEL, actionId: 'head.nod', requestId: 'req-3' }),
    (err) => { assertRouterError(err, 'stale-action', 409); return true; },
  );
});

await okAsync('dispatch：能力档案 revision 不匹配 → 409 capability-mismatch', async () => {
  const { enqueue, calls } = fakeEnqueue();
  const router = new ActionRouter({
    repo: fakeRepo([action('head.nod', { capabilityRevision: 'rcap-old' })]),
    enqueue,
    getCapabilityRevision: () => 'rcap-new',
  });
  await assert.rejects(
    () => router.dispatch({ modelId: MODEL, actionId: 'head.nod', requestId: 'req-4' }),
    (err) => { assertRouterError(err, 'capability-mismatch', 409); return true; },
  );
  assert.equal(calls.length, 0);
});

await okAsync('dispatch：能力 revision 不可得 → 跳过比对但记 warning（不伪报已核对）', async () => {
  const router = new ActionRouter({
    repo: fakeRepo([action('head.nod')]),
    enqueue: fakeEnqueue().enqueue,
    getCapabilityRevision: () => null,
  });
  const out = await router.dispatch({ modelId: MODEL, actionId: 'head.nod', requestId: 'req-5' });
  assert.equal(out.ok, true);
  assert.ok(out.warnings.some((w) => w.reason === 'capability-revision-unavailable'));
});

await okAsync('dispatch：未注入 getCapabilityRevision → 仍然派发 + warning 说明未比对', async () => {
  const router = new ActionRouter({ repo: fakeRepo([action('head.nod')]), enqueue: fakeEnqueue().enqueue });
  const out = await router.dispatch({ modelId: MODEL, actionId: 'head.nod', requestId: 'req-6' });
  assert.ok(out.warnings.some((w) => w.reason === 'capability-revision-provider-missing'));
});

// ---- 4. 越界 / 未知参数 / 非 number → 400
await okAsync('dispatch：越界参数 → 400 invalid-parameter', async () => {
  const router = new ActionRouter({ repo: fakeRepo([action('head.nod')]), enqueue: fakeEnqueue().enqueue });
  await assert.rejects(
    () => router.dispatch({ modelId: MODEL, actionId: 'head.nod', parameters: { intensity: 1.5 }, requestId: 'req-7' }),
    (err) => { assertRouterError(err, 'invalid-parameter', 400); return true; },
  );
});

await okAsync('dispatch：未知参数 → 400 unknown-parameter（不静默丢弃）', async () => {
  const router = new ActionRouter({ repo: fakeRepo([action('head.nod')]), enqueue: fakeEnqueue().enqueue });
  await assert.rejects(
    () => router.dispatch({ modelId: MODEL, actionId: 'head.nod', parameters: { velocity: 3 }, requestId: 'req-8' }),
    (err) => { assertRouterError(err, 'unknown-parameter', 400); return true; },
  );
});

await okAsync('dispatch：非 number（字符串/NaN/Infinity）→ 400 invalid-parameter', async () => {
  const router = new ActionRouter({ repo: fakeRepo([action('head.nod')]), enqueue: fakeEnqueue().enqueue });
  for (const bad of ['0.5', Number.NaN, Number.POSITIVE_INFINITY, null, true]) {
    await assert.rejects(
      () => router.dispatch({ modelId: MODEL, actionId: 'head.nod', parameters: { intensity: bad }, requestId: 'req-9' }),
      (err) => { assertRouterError(err, 'invalid-parameter', 400); return true; },
      `参数 ${String(bad)} 应被拒`,
    );
  }
});

ok('validateActionParameters：纯函数，不修改入参，schema 缺省时返回空对象', () => {
  const input = { intensity: 0.3 };
  const out = validateActionParameters(input, { intensity: { type: 'number', min: 0, max: 1, default: 0.5 } });
  assert.deepEqual(out, { intensity: 0.3 });
  assert.deepEqual(input, { intensity: 0.3 }, '入参不被修改');
  assert.deepEqual(validateActionParameters(undefined, undefined), {});
  assert.throws(() => validateActionParameters({ x: 1 }, { y: { type: 'number', min: 0, max: 1 } }),
    (err) => err.reason === 'unknown-parameter');
});

// ---- 5. 缺 requestId → 400（去重依赖它，不做服务端兜底）
await okAsync('dispatch：缺 requestId → 400 invalid-request（去重/幂等靠它）', async () => {
  const { enqueue, calls } = fakeEnqueue();
  const router = new ActionRouter({ repo: fakeRepo([action('head.nod')]), enqueue });
  await assert.rejects(
    () => router.dispatch({ modelId: MODEL, actionId: 'head.nod', parameters: {} }),
    (err) => { assertRouterError(err, 'invalid-request', 400); return true; },
  );
  await assert.rejects(
    () => router.dispatch({ modelId: MODEL, actionId: 'head.nod', requestId: '' }),
    (err) => { assertRouterError(err, 'invalid-request', 400); return true; },
  );
  assert.equal(calls.length, 0);
});

await okAsync('dispatch：缺 modelId / actionId → 400 invalid-request', async () => {
  const router = new ActionRouter({ repo: fakeRepo([action('head.nod')]), enqueue: fakeEnqueue().enqueue });
  await assert.rejects(() => router.dispatch({ actionId: 'head.nod', requestId: 'r' }),
    (err) => { assertRouterError(err, 'invalid-request', 400); return true; });
  await assert.rejects(() => router.dispatch({ modelId: MODEL, requestId: 'r' }),
    (err) => { assertRouterError(err, 'invalid-request', 400); return true; });
});

// ---- 6. TriggerRouter
function triggerFixture(actions) {
  const repo = fakeRepo(actions);
  const { enqueue, calls } = fakeEnqueue();
  const router = new ActionRouter({ repo, enqueue, getCapabilityRevision: () => 'rcap-1' });
  return { repo, router, calls, trigger: new TriggerRouter({ router, repo }) };
}

await okAsync('trigger：单命中 → 派发并标注 matchedBy=trigger', async () => {
  const f = triggerFixture([action('head.nod', { triggers: ['interaction.head_nod'] })]);
  const out = await f.trigger.handle({ type: 'interaction.head_nod', modelId: MODEL, requestId: 'req-t1' });
  assert.equal(out.matchedBy, 'trigger');
  assert.equal(out.actionId, 'head.nod');
  assert.equal(out.ok, true);
  assert.equal(f.calls.length, 1);
});

await okAsync('trigger：多命中按 FORCE > NORMAL > BACKGROUND 择优', async () => {
  const f = triggerFixture([
    action('b.bg', { triggers: ['pointer.head.click'], priority: 'BACKGROUND' }),
    action('n.normal', { triggers: ['pointer.head.click'], priority: 'NORMAL' }),
    action('z.force', { triggers: ['pointer.head.click'], priority: 'FORCE' }),
  ]);
  const out = await f.trigger.handle({ type: 'pointer.head.click', modelId: MODEL, requestId: 'req-t2' });
  assert.equal(out.actionId, 'z.force');
});

await okAsync('trigger：同级多命中取 actionId 字典序最小（确定性，不依赖返回顺序）', async () => {
  const f = triggerFixture([
    action('m.zeta', { triggers: ['e.x'], priority: 'NORMAL' }),
    action('m.alpha', { triggers: ['e.x'], priority: 'NORMAL' }),
    action('m.mid', { triggers: ['e.x'], priority: 'NORMAL' }),
  ]);
  const out = await f.trigger.handle({ type: 'e.x', modelId: MODEL, requestId: 'req-t3' });
  assert.equal(out.actionId, 'm.alpha');
  // 同样输入重复调用 → 同样结果（确定性）
  const again = await f.trigger.handle({ type: 'e.x', modelId: MODEL, requestId: 'req-t4' });
  assert.equal(again.actionId, 'm.alpha');
});

await okAsync('trigger：无命中 → no_matching_action（不抛错、不入队、不调 LLM）', async () => {
  const f = triggerFixture([action('head.nod', { triggers: ['interaction.head_nod'] })]);
  const out = await f.trigger.handle({ type: 'interaction.unknown', modelId: MODEL, requestId: 'req-t5' });
  assert.deepEqual(out, { status: 'no_matching_action', type: 'interaction.unknown', modelId: MODEL });
  assert.equal(f.calls.length, 0);
});

await okAsync('trigger：payload 多余键被丢弃，只透传 manifest 声明过的参数', async () => {
  const f = triggerFixture([action('gaze.look', {
    triggers: ['interaction.gaze'],
    parameters: {
      intensity: { type: 'number', min: 0, max: 1, default: 0.5 },
      holdMs: { type: 'number', min: 0, max: 3000, default: 800 },
    },
  })]);
  const out = await f.trigger.handle({
    type: 'interaction.gaze',
    modelId: MODEL,
    requestId: 'req-t6',
    payload: { intensity: 0.4, holdMs: 1200, html: '<script>x</script>', nested: { a: 1 }, __proto__evil: 'x' },
  });
  assert.deepEqual(out.parameters, { intensity: 0.4, holdMs: 1200 }, '未声明键一律不透传');
  assert.deepEqual(f.calls[0].parameters, { intensity: 0.4, holdMs: 1200 });
});

await okAsync('trigger：stale 动作不再被触发（repo 只返回 published）', async () => {
  const f = triggerFixture([action('head.nod', { triggers: ['interaction.head_nod'], status: 'stale' })]);
  const out = await f.trigger.handle({ type: 'interaction.head_nod', modelId: MODEL, requestId: 'req-t7' });
  assert.equal(out.status, 'no_matching_action');
});

await okAsync('trigger：缺 type/modelId → 400 invalid-request', async () => {
  const f = triggerFixture([action('head.nod', { triggers: ['interaction.head_nod'] })]);
  await assert.rejects(() => f.trigger.handle({ modelId: MODEL, requestId: 'r' }),
    (err) => { assertRouterError(err, 'invalid-request', 400); return true; });
  await assert.rejects(() => f.trigger.handle({ type: 'x', requestId: 'r' }),
    (err) => { assertRouterError(err, 'invalid-request', 400); return true; });
});

// ---- 7. 静态断言：路由文件零 LLM / 零网络依赖（负面约束的硬证据）
ok('静态断言：action-router.mjs / trigger-router.mjs 不 import 任何 LLM 或网络模块', () => {
  const routerSrc = fs.readFileSync(path.join(BRIDGE_DIR, 'action-router.mjs'), 'utf8');
  const triggerSrc = fs.readFileSync(path.join(BRIDGE_DIR, 'trigger-router.mjs'), 'utf8');

  const importSpecifiers = (src) => {
    const specs = [];
    const re = /(?:^|\n)\s*import\s+(?:[^'"]*?\bfrom\s*)?['"]([^'"]+)['"]/g;
    let m;
    while ((m = re.exec(src))) specs.push(m[1]);
    const reqRe = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
    while ((m = reqRe.exec(src))) specs.push(m[1]);
    return specs;
  };

  const routerImports = importSpecifiers(routerSrc);
  assert.deepEqual(routerImports, [], `action-router.mjs 不应有任何 import，实际：${routerImports.join(', ')}`);
  // trigger-router 只允许依赖同目录路由模块
  assert.deepEqual(importSpecifiers(triggerSrc), ['./action-router.mjs']);

  const forbidden = /(^|\n)\s*import[^\n]*(llm|openai|deepseek|anthropic|axios|node:https?|node-fetch|undici|socket)/i;
  for (const [name, src] of [['action-router.mjs', routerSrc], ['trigger-router.mjs', triggerSrc]]) {
    assert.ok(!forbidden.test(src), `${name} 不得 import LLM/网络模块`);
    assert.ok(!/\bfetch\s*\(/.test(src), `${name} 不得发起 fetch 调用`);
  }
});

console.log(`\nOACA-3 确定性路由: ${passed} tests passed`);
