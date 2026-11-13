/**
 * OACA 路由契约门禁（源码级，非 HTTP 行为测试）。
 *
 * 为什么是"源码级"（诚实说明，不冒充 HTTP 覆盖）：
 *   /dsh-l2d/api/actions/{dispatch,published,status} 与 /api/metrics 的处理器全部内联在
 *   packages/dsh-l2d-plugin/lib/index.js 的 apply() 闭包里，注册依赖宿主注入的 webServer，
 *   本机无法启动 DSH 宿主 ⇒ 真实 HTTP 行为测试不可行（需宿主或先把处理器抽成可注入工厂）。
 *
 *   但 QA 的 W-1 指出的真实风险是"**这层被改坏时，现有 10 条命令一条都不会红**"。
 *   本文件用契约断言把这个风险堵住：谁把回环闸门、幂等查重、终态回写、零 LLM 约束
 *   改没了，这里立刻红——按文件名定位到具体契约，不用去猜。
 *
 *   局限（明确写出来，避免误读为端到端已验）：
 *   · 断言的是**源码结构**（关键调用存在/缺失），不是运行时行为；
 *   · 不覆盖 status code、响应体形状、并发竞态——这些仍需真机 HTTP 验证。
 *
 * 直跑：node packages/mcp-bridge/tests/oaca-route-contract.test.mjs
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_PKG = path.resolve(HERE, '..', '..');
const INDEX_FILE = path.join(REPO_PKG, 'dsh-l2d-plugin', 'lib', 'index.js');
const SYNC_FILE = path.join(REPO_PKG, 'dsh-l2d-plugin', 'lib', 'action-registry-sync.mjs');
const REPO_FILE = path.join(REPO_PKG, 'dsh-l2d-db', 'src', 'action-manifest-repo.mjs');

const index = fs.readFileSync(INDEX_FILE, 'utf8');
const sync = fs.readFileSync(SYNC_FILE, 'utf8');
const repo = fs.readFileSync(REPO_FILE, 'utf8');

let passed = 0;
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

/** 取一段源码切片（起止标记之间），找不到标记直接判失败（标记被删=结构被改）。 */
function slice(source, startMarker, endMarker, label) {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `${label}：找不到起始标记「${startMarker}」——结构被改，请同步更新本门禁断言（勿直接删除本用例）`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `${label}：找不到结束标记「${endMarker}」——结构被改，请同步更新本门禁断言`);
  return source.slice(start, end);
}

function mustInclude(text, needle, label) {
  assert.ok(text.includes(needle), `${label}：缺少必需结构「${needle}」`);
}

function mustNotInclude(text, needle, label) {
  assert.ok(!text.includes(needle), `${label}：出现被禁止的结构「${needle}」`);
}

console.log('OACA 路由契约门禁（源码级）');

// enqueue 装配段：从装配注释到 actionDispatchDeps 赋值
const enqueue = slice(index, 'OACA-2/3 装配（路由侧经 actionDispatchDeps', 'actionDispatchDeps = {', 'enqueue 装配段');

// ---- 1. F-4：幂等事实源必须是 bridge_actions 主键（不是内存 Map）
ok('F-4 幂等：enqueue 以 bridge_actions 主键查重（findBridgeRequest）', () => {
  mustInclude(enqueue, 'findBridgeRequest(bridgeDb, requestId)', 'enqueue 幂等');
});

// ---- 2. F-3：四项本地闸门必须在派发前存在
ok('F-3 闸门：mode / strict 绑定 / 图存在 三项判定都在 enqueue 内', () => {
  mustInclude(enqueue, 'readMotionMode(', 'mode 互斥闸门');
  mustInclude(enqueue, 'checkRunModelBinding(', 'strict 绑定闸门');
  mustInclude(enqueue, 'loadNodegraph(', '图存在闸门');
});

ok('F-3 回执：真实执行 + 终态回写（completed 必须落 bridge_actions）', () => {
  mustInclude(enqueue, 'runNodegraph(', '真实执行入口');
  mustInclude(enqueue, "markBridgeTerminal(bridgeDb, requestId, 'completed'", '完成态回写');
  mustInclude(enqueue, "markBridgeTerminal(bridgeDb, requestId, 'failed'", '失败态回写');
});

ok('F-3 回归门禁：不得退回 fire-and-forget（禁止 void fetch( ）、失败必须以 ActionRouterError 抛出', () => {
  mustNotInclude(enqueue, 'void fetch(', 'fire-and-forget 回归');
  mustInclude(enqueue, 'new ActionRouterError(', '带 status 的错误回执');
});

// ---- 3. F-2：dispatch 路由必须回环受限
// ⚠ QA-W7 修正（假绿事故）：原断言在 dispatch 注册切片里找 `isLoopback(req)`，
// 但真正的闸门在 `actionDispatchPost` 的**定义**里（注册切片之外），而切片里恰好有
// 一个 `, { loopbackOnly: true }` 死参数 ⇒ `hasStrict || hasOption` 恒真。
// 变异实验实证：删掉闸门那一行 / 把 isLoopback 降级成 isRemoteLoopback，原断言都仍然绿。
// 现在改成两段独立断言：① 闸门必须出现在 wrapper 定义体内且必须是 isLoopback；
// ② 不得再把 loopbackOnly 当第二实参传给只收一个形参的 wrapper（否则又是死参数骗人）。
const dispatchWrapper = slice(index, 'const actionDispatchPost = ', "route('/dsh-l2d/api/actions/dispatch'", 'dispatch wrapper 定义段');
const dispatchRoute = slice(index, "route('/dsh-l2d/api/actions/dispatch'", "route('/dsh-l2d/api/actions/published'", 'dispatch 路由段');

ok('F-2 安全：dispatch wrapper 内必须以 isLoopback 拦截非回环（Host + socket 双校验）', () => {
  mustInclude(dispatchWrapper, 'isLoopback(req)', 'dispatch 回环闸门');
  // 必须是严格版 isLoopback，不接受降级成 isRemoteLoopback（后者不核 Host，挡不住 DNS-rebinding）
  mustNotInclude(dispatchWrapper, 'isRemoteLoopback(req)', 'dispatch 闸门降级');
  mustInclude(dispatchWrapper, 'nodegraphApiPost(handler)', '必须复用 nodegraphApiPost（isCrossSite/405/body 上限）');
});

ok('F-2 反假绿：不得把 loopbackOnly 当第二实参塞给只收一个形参的 wrapper（死参数）', () => {
  // wrapper 形参只有 handler —— 第二实参会被静默丢弃，看起来"有回环选项"其实没接上
  const singleParam = /const actionDispatchPost = \(handler\)\s*=>/.test(index);
  const deadArg = /actionDispatchPost\([\s\S]{0,4000}?\},\s*\{\s*loopbackOnly/.test(index);
  assert.ok(
    !(singleParam && deadArg),
    'actionDispatchPost 只收一个形参，却被传了 { loopbackOnly: … } —— 该参数被丢弃（死参数）。'
    + '要么删掉它，要么在 wrapper 内真正透传给 nodegraphApiPost(handler, opts)',
  );
  // 跨站防护由 nodegraphApiPost 统一施加（wrapper 必须走它，不得手写裸 handler 绕过）
  const wrapperBlock = index.slice(index.indexOf('const nodegraphApiPost'), index.indexOf('const nodegraphApiPost') + 1200);
  mustInclude(wrapperBlock, 'isCrossSite(req)', 'nodegraphApiPost 跨站防护');
});

ok('路由错误映射：ActionRouterError 必须按自身 status 返回（不得一律 200/500）', () => {
  mustInclude(dispatchRoute, 'instanceof ActionRouterError', '错误类型判定');
  mustInclude(dispatchRoute, 'status: err.status', '错误码透传');
});

// ---- 4. F-5：metrics 双闸 + 双路径共用同一 handler
ok('F-5 指标出口：/api/metrics 与 /api/oaca/metrics.json 共用同一回环+跨站双闸 handler', () => {
  const metricsBlock = slice(index, 'const metricsHandler', "route('/dsh-l2d/api/oaca/metrics.json'", 'metrics handler 段');
  mustInclude(metricsBlock, 'isRemoteLoopback(req)', '回环闸门');
  mustInclude(metricsBlock, 'isCrossSite(req)', '跨站闸门');
  mustInclude(metricsBlock, 'metrics.snapshot()', '指标内容');
  mustInclude(index, "route('/dsh-l2d/api/oaca/metrics.json', metricsHandler)", 'QA 验收路径');
  mustInclude(index, "route('/dsh-l2d/api/metrics', metricsHandler)", '内部诊断路径');
});

// ---- 5. status 回查端点同样双闸（只读但含 requestId 维度）
ok('status 回查：/api/actions/status 具备回环 + 跨站双闸', () => {
  const statusBlock = slice(index, "route('/dsh-l2d/api/actions/status'", 'route(', 'status 路由段');
  mustInclude(statusBlock, 'isRemoteLoopback(req)', '回环闸门');
  mustInclude(statusBlock, 'isCrossSite(req)', '跨站闸门');
  mustInclude(statusBlock, 'requestId', 'requestId 查询参数');
});

// ---- 6. 零 LLM：actions 路由段内不得出现任何 LLM 通道调用
ok('零 LLM 硬约束：/api/actions/* 路由段不得调用 LLM 通道（deepseekChatJson / openai / anthropic）', () => {
  const actionsBlock = slice(index, 'OACA-3 运行时派发', 'OACA-4 指标只读出口', 'actions 路由段');
  for (const needle of ['deepseekChatJson', 'openai', 'anthropic', 'llm-channel']) {
    mustNotInclude(actionsBlock, needle, '运行时零 LLM');
  }
});

// ---- 7. F-6：manifest 白名单必须带四层校验结论
ok('F-6：register-sync 白名单保留 layers / errors / warnings（四层结论可审计）', () => {
  mustInclude(sync, 'layers:', '四层校验结论');
  mustInclude(sync, 'errors:', '错误明细');
  mustInclude(sync, 'warnings:', 'warning 明细');
  mustNotInclude(sync, 'instruction', '编译期内部字段不得进 manifest');
});

// ---- 8. F-9：publish 收缩按 action_id 集合清扫，不得只按 manifest_id
ok('F-9：publishBundleToDb 按 action_id 集合置 stale（同 revision 收缩也生效）', () => {
  // 只看 compiled_actions 的清扫语句：manifest 表 "demote 旧 published" 步骤里出现
  // manifest_id <> 是**正确且必需**的（partial unique index），不能一概禁止。
  const sweep = slice(repo, '// 4) 收缩置 stale', 'return { manifestId, revision', 'compiled_actions 清扫段');
  mustInclude(sweep, 'action_id NOT IN', '按 action_id 集合清扫');
  // 断言的是 SQL 片段（注释里允许出现"原实现按 manifest_id 判断"这类说明文字）
  mustNotInclude(sweep, "status = 'published' AND manifest_id <> ?", '旧写法（同 revision 收缩会漏）不得回潮');
});

console.log(`\nOACA 路由契约门禁: ${passed} tests passed`);
