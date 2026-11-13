/**
 * 派发前置闸门测试（QA W-1：守卫链必须有可执行断言）。
 *
 * 直跑：node packages/mcp-bridge/tests/dispatch-guards.test.mjs
 * 说明：`evaluateDispatchGuards` 是生产同一份代码（index.js 的 enqueue 直接调用它），
 *       这里用纯输入覆盖四种判定与优先级，不复制业务逻辑、不启动 HTTP。
 */
import assert from 'node:assert/strict';
import { DISPATCH_GUARD, evaluateDispatchGuards } from '../dispatch-guards.mjs';

let passed = 0;
function it(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err && err.message}`);
    process.exitCode = 1;
  }
}

const OK_BINDING = { ok: true, bindingMode: 'strict', modelId: 'm1' };
const MISMATCH = { ok: false, status: 409, reason: 'model-mismatch', expected: 'm1', actual: 'm2' };

console.log('OACA-3 派发闸门');

it('全通过 → {ok:true}', () => {
  const r = evaluateDispatchGuards({ graphId: 'graph_head_nod', mode: 'nodegraph', binding: OK_BINDING, graphExists: true });
  assert.deepEqual(r, { ok: true });
});

it('模式非 nodegraph → 409 mode-blocked（llm 模式下不得假报可派发）', () => {
  const r = evaluateDispatchGuards({ graphId: 'g', mode: 'llm', binding: OK_BINDING, graphExists: true });
  assert.equal(r.ok, false);
  assert.equal(r.status, 409);
  assert.equal(r.reason, DISPATCH_GUARD.MODE_BLOCKED);
  assert.match(r.message, /llm/);
});

it('strict 绑定不匹配 → 409 model-mismatch，带双方模型名', () => {
  const r = evaluateDispatchGuards({ graphId: 'g', mode: 'nodegraph', binding: MISMATCH, graphExists: true });
  assert.equal(r.ok, false);
  assert.equal(r.status, 409);
  assert.equal(r.reason, DISPATCH_GUARD.MODEL_MISMATCH);
  assert.match(r.message, /m1/);
  assert.match(r.message, /m2/);
});

it('图不存在 → 404 graph-not-found', () => {
  const r = evaluateDispatchGuards({ graphId: 'graph_x', mode: 'nodegraph', binding: OK_BINDING, graphExists: false });
  assert.equal(r.ok, false);
  assert.equal(r.status, 404);
  assert.equal(r.reason, DISPATCH_GUARD.GRAPH_NOT_FOUND);
  assert.match(r.message, /graph_x/);
});

it('优先级：模式问题先于绑定问题（避免误报模型不匹配）', () => {
  const r = evaluateDispatchGuards({ graphId: 'g', mode: 'llm', binding: MISMATCH, graphExists: false });
  assert.equal(r.reason, DISPATCH_GUARD.MODE_BLOCKED);
});

it('binding 缺省（undefined）按不匹配处理，不放行', () => {
  const r = evaluateDispatchGuards({ graphId: 'g', mode: 'nodegraph', binding: undefined, graphExists: true });
  assert.equal(r.ok, false);
  assert.equal(r.status, 409);
});

console.log('');
if (process.exitCode) {
  console.error('dispatch-guards: 存在失败');
  process.exit(1);
}
console.log(`dispatch-guards: ${passed} 项全部通过`);
