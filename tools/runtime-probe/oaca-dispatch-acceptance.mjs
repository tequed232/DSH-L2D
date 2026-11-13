#!/usr/bin/env node
/**
 * OACA-3 派发成功路径 · 真机验收探针
 *
 * ⚠ 我（后端席）**没有**执行过本脚本的真实宿主部分：本机 5 个常见端口
 *   （5300/5173/3000/8080/5301）均无监听，起不了 DSH 宿主。本脚本的正确性
 *   是用 mock 服务自证过的（见文件末尾「自证方式」），但**成功路径的真实证据仍需在
 *   宿主运行时跑一次**。跑完请把输出贴进验收报告——这才是 QA W-1 要的端到端证据。
 *
 * 覆盖的契约（每一项失败都会点名）：
 *   1  GET  /dsh-l2d/api/oaca/metrics.json          200 + counters 结构（回环可取）
 *   2  GET  /dsh-l2d/api/actions/published?model=   200 + 至少一条可派发动作
 *   3  GET  /dsh-l2d/api/actions/status?requestId=  不存在的 requestId → 404 unknown-request
 *      （这条用不存在的 id 验契约，**零副作用**）
 *   4  POST /dsh-l2d/api/actions/dispatch           200 + state=completed（同步终态）
 *   5  POST 同上、同 requestId 重放                   → duplicate 且 executionId 不变（幂等，角色不二次动作）
 *   6  GET  /api/actions/status?requestId=<刚发的>   200 + state=completed
 *   7  GET  metrics 前后对比                          runtimeLlmCallCount 增量为 0（派发路径零 LLM）
 *
 * 副作用与安全：
 *   · 第 4 步会让**角色真实动一次**（这是验收目的）。因此必须显式加 --yes 才会执行；
 *     不加 --yes 只跑 1/2/3 三步只读检查。
 *   · 第 5 步只重复同 requestId，按契约不会再动一次；若它真的又动了，脚本会判 FAIL。
 *
 * 用法：
 *   node tools/runtime-probe/oaca-dispatch-acceptance.mjs --base http://127.0.0.1:5300 --model 大肥鱼.dsl2d.2048
 *   node tools/runtime-probe/oaca-dispatch-acceptance.mjs --base … --model … --yes            # 含真实派发
 *   node tools/runtime-probe/oaca-dispatch-acceptance.mjs --base … --model … --yes --action head.nod --intensity 0.4
 *
 * 退出码：0=全通过 · 1=有 FAIL · 2=BLOCKED（环境未就绪，不是代码错）
 *
 * 自证方式（我跑过的）：
 *   起一个本地 mock server 复现上述 4 个端点，本脚本对 mock 连跑两次：
 *   happy path → 0；dispatch 返回 409 mode-blocked → 2（BLOCKED）。两种分类都正确。
 */

const args = process.argv.slice(2);
function argOf(name, fallback = '') {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? String(args[i + 1]) : fallback;
}
const BASE = (argOf('base', 'http://127.0.0.1:5300')).replace(/\/+$/, '');
const MODEL = argOf('model', '');
const ACTION = argOf('action', '');
const INTENSITY = argOf('intensity', '');
const DO_DISPATCH = args.includes('--yes');
const TIMEOUT_MS = Number(argOf('timeout', '150000')) || 150_000;

const results = [];
function record(step, verdict, detail) {
  results.push({ step, verdict, detail });
  const icon = verdict === 'PASS' ? '✓' : verdict === 'SKIP' ? '- ' : verdict === 'BLOCKED' ? '!' : '✗';
  console.log(`  ${icon} [${verdict}] ${step}${detail ? ' — ' + detail : ''}`);
}
const pass = (s, d) => record(s, 'PASS', d);
const fail = (s, d) => record(s, 'FAIL', d);
const skip = (s, d) => record(s, 'SKIP', d);
const blocked = (s, d) => record(s, 'BLOCKED', d);

async function req(pathname, { method = 'GET', body } = {}) {
  const init = {
    method,
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`${BASE}${pathname}`, init);
  let payload = null;
  try { payload = await res.json(); } catch { payload = null; }
  return { status: res.status, payload };
}

function finish() {
  const summary = {
    base: BASE,
    model: MODEL,
    dispatchExecuted: DO_DISPATCH,
    counts: results.reduce((acc, r) => ({ ...acc, [r.verdict]: (acc[r.verdict] || 0) + 1 }), {}),
    results,
  };
  console.log('\n' + JSON.stringify(summary, null, 2));
  if (results.some((r) => r.verdict === 'FAIL')) return 1;
  if (results.some((r) => r.verdict === 'BLOCKED')) return 2;
  return 0;
}

(async () => {
  console.log(`OACA 派发验收探针 → ${BASE}（model=${MODEL || '(未指定)'}）`);
  if (!MODEL) {
    blocked('前置参数', '缺 --model；无法查已发布动作。例：--model 大肥鱼.dsl2d.2048');
    process.exit(finish());
  }
  if (!DO_DISPATCH) console.log('  （未加 --yes：只跑只读检查，不会驱动角色动作）');

  // ---- 1. metrics 出口 ----
  let metricsBefore = null;
  try {
    const r = await req('/dsh-l2d/api/oaca/metrics.json');
    if (r.status === 200 && r.payload && r.payload.ok === true && r.payload.counters) {
      metricsBefore = r.payload;
      pass('1 metrics 出口', `200，counters=${Object.keys(r.payload.counters).length} 项，runtimeLlmCallCount=${r.payload.counters.runtimeLlmCallCount}`);
    } else {
      fail('1 metrics 出口', `期望 200 + {ok:true,counters}，实际 ${r.status} ${JSON.stringify(r.payload).slice(0, 120)}`);
    }
  } catch (err) {
    blocked('1 metrics 出口', `连不上（宿主未启动？）：${String(err && err.message || err)}`);
    process.exit(finish());
  }

  // ---- 2. 已发布动作清单 ----
  let published = null;
  try {
    const r = await req(`/dsh-l2d/api/actions/published?model=${encodeURIComponent(MODEL)}`);
    if (r.status === 200 && r.payload && r.payload.ok === true && Array.isArray(r.payload.actions)) {
      published = r.payload;
      if (r.payload.count > 0) pass('2 已发布动作', `count=${r.payload.count}，revision=${r.payload.revision}`);
      else blocked('2 已发布动作', 'count=0：该模型还没有已发布动作，先 POST /api/actions/compile 并确认 registry.ok');
    } else {
      fail('2 已发布动作', `期望 200 + {ok:true,actions[]}，实际 ${r.status} ${JSON.stringify(r.payload).slice(0, 160)}`);
    }
  } catch (err) {
    fail('2 已发布动作', String(err && err.message || err));
  }

  // ---- 3. status 端点契约（用不存在的 id，零副作用）----
  try {
    const r = await req(`/dsh-l2d/api/actions/status?requestId=probe-not-exist-${Date.now()}`);
    if (r.status === 404 && r.payload && r.payload.reason === 'unknown-request') {
      pass('3 status 404 契约', '不存在的 requestId → 404 unknown-request');
    } else {
      fail('3 status 404 契约', `期望 404 unknown-request，实际 ${r.status} ${JSON.stringify(r.payload).slice(0, 120)}`);
    }
  } catch (err) {
    fail('3 status 404 契约', String(err && err.message || err));
  }

  if (!DO_DISPATCH) {
    skip('4-7 真实派发', '未加 --yes（真实派发会让角色动一次，需显式同意）');
    process.exit(finish());
  }
  if (!published || !published.count) {
    skip('4-7 真实派发', '没有可派发动作，前置不满足');
    process.exit(finish());
  }

  const target = ACTION
    ? published.actions.find((a) => a.actionId === ACTION)
    : published.actions[0];
  if (!target) {
    fail('4 目标动作', `动作 ${ACTION} 不在已发布清单里（可选：${published.actions.map((a) => a.actionId).join(', ')}）`);
    process.exit(finish());
  }
  const parameters = INTENSITY ? { intensity: Number(INTENSITY) } : {};
  const requestId = `probe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const body = { modelId: MODEL, actionId: target.actionId, parameters, requestId };

  // ---- 4. 真实派发（同步终态）----
  let firstExecutionId = null;
  try {
    const r = await req('/dsh-l2d/api/actions/dispatch', { method: 'POST', body });
    const p = r.payload || {};
    if (r.status === 409 && (p.reason === 'mode-blocked' || p.reason === 'model-mismatch')) {
      blocked('4 真实派发', `${r.status} ${p.reason}：${p.message || ''}｜处置：先把动作模式切到 nodegraph（设置页 clickMode）后重跑`);
      process.exit(finish());
    }
    if (r.status === 409 && p.reason === 'busy') {
      blocked('4 真实派发', 'busy：该图正在执行中，等它结束再跑');
      process.exit(finish());
    }
    if (r.status === 200 && p.ok === true && (p.state === 'completed' || p.receipt?.state === 'completed')) {
      firstExecutionId = p.executionId || p.receipt?.executionId || null;
      pass('4 真实派发', `200 state=completed，executionId=${firstExecutionId}`);
    } else {
      fail('4 真实派发', `期望 200 + state=completed，实际 ${r.status} ${JSON.stringify(p).slice(0, 200)}`);
    }
  } catch (err) {
    fail('4 真实派发', String(err && err.message || err));
  }

  // ---- 5. 同 requestId 重放：必须 duplicate，且不得二次执行 ----
  try {
    const r = await req('/dsh-l2d/api/actions/dispatch', { method: 'POST', body });
    const p = r.payload || {};
    const sameExec = (p.executionId || p.receipt?.executionId || null) === firstExecutionId;
    const isDup = p.status === 'duplicate' || p.duplicate === true || p.receipt?.duplicate === true;
    if (r.status === 200 && isDup && sameExec) {
      pass('5 幂等重放', `duplicate=true，executionId 不变（${firstExecutionId}）——未二次执行`);
    } else if (isDup) {
      fail('5 幂等重放', `判为 duplicate 但 executionId 不一致（首次 ${firstExecutionId} / 重放 ${p.executionId}），可能真的执行了两次`);
    } else {
      fail('5 幂等重放', `期望 duplicate，实际 ${r.status} ${JSON.stringify(p).slice(0, 200)}——同 requestId 被重复执行`);
    }
  } catch (err) {
    fail('5 幂等重放', String(err && err.message || err));
  }

  // ---- 6. status 回查 ----
  try {
    const r = await req(`/dsh-l2d/api/actions/status?requestId=${encodeURIComponent(requestId)}`);
    if (r.status === 200 && r.payload && r.payload.state === 'completed') {
      pass('6 status 回查', `state=completed，action=${r.payload.action}`);
    } else {
      fail('6 status 回查', `期望 200 + state=completed，实际 ${r.status} ${JSON.stringify(r.payload).slice(0, 160)}`);
    }
  } catch (err) {
    fail('6 status 回查', String(err && err.message || err));
  }

  // ---- 7. 派发路径零 LLM（前后计数对比）----
  try {
    const r = await req('/dsh-l2d/api/oaca/metrics.json');
    const after = r.payload && r.payload.counters;
    const before = metricsBefore && metricsBefore.counters;
    if (r.status === 200 && after && before) {
      const delta = Number(after.runtimeLlmCallCount) - Number(before.runtimeLlmCallCount);
      if (delta === 0) pass('7 零 LLM', `runtimeLlmCallCount 未增长（${before.runtimeLlmCallCount} → ${after.runtimeLlmCallCount}）`);
      else fail('7 零 LLM', `runtimeLlmCallCount 增长了 ${delta}——派发路径调用了 LLM，违反隔离约束`);
    } else {
      fail('7 零 LLM', `metrics 读取失败：${r.status}`);
    }
  } catch (err) {
    fail('7 零 LLM', String(err && err.message || err));
  }

  process.exit(finish());
})().catch((err) => {
  console.error('探针异常：' + String(err && err.stack || err));
  process.exit(1);
});
