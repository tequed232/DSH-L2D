# QA-OACA · OACA-2/3/4 回归验收报告（Phase 4 + 修复复验 S3）

- **Task ID**：QA-OACA
- **Assigned Model**：顾镜真 · ARCANA 席位 3（多模态回归验收官）— 承载模型为多模态（视觉输入）席位模型
- **Modified Files**：仅 `docs/bridge/QA-OACA-REPORT.md`（本文件）。业务代码 / 测试 / `package.json` 全程只读；验证用临时目录 `.qa-tmp` 已删除。
- **仓库**：`D:\Desktop\DSH-L2D`，分支 `feat/pr1-action-session`，改动全在工作区未提交
- **环境**：Windows Git Bash / Node v22.22.2 / npm 10.9.7 / pnpm 12.5.1

## 0. 快照声明（不读这节会误读全文结论）

验证期间工作区被**持续并发修改**（另一席在按缺陷清单落修）。mtime 实证：`package.json` 20:20:07、20:25:53 两次；`index.js` 20:20:47 → **20:23:15** → **20:25:30**；两个测试文件 20:21:04 / 20:21:20。因此本文保留 **3 个快照**，各自独立给 EXIT：

| 快照 | 时间 | 结果 | 说明 |
|---|---|---|---|
| **S1** | ≈20:19:20 | **2 项红** | 首次执行；`test:db` 红（路径），同步桥红（断言未跟源码） |
| **S2** | 20:21:04–20:23:39 | 10/10 绿 | 第一批修复（静态闸门 + `void fetch` 版执行） |
| **S3** | 20:26:23–20:27:35 | **10/10 绿**，md5 全程稳定 | 第二批修复（进程内执行 + `isLoopback` + dispatch-guards 抽模块） |

**S3 快照指纹（跑测前 == 跑测后，逐字相同）**：

```
82ddbe8a2f0e27141e3ae6bacdf73ada  packages/dsh-l2d-plugin/lib/index.js
f5b3b360801d3c5bec373145fc14cd12  packages/mcp-bridge/dispatch-guards.mjs
add8ef8577baf494988b09bf832c4549  packages/dsh-l2d-plugin/lib/action-registry-sync.mjs
f8238dc3856de20856c211bf90343634  packages/dsh-l2d-db/src/action-manifest-repo.mjs
```

> ⚠ **协作事实**：另一席告知他基于 `index.js` md5 `7560be7e934f2319b88bfff0ab613254` 落刀。**该值不是当前盘上文件**（当前 `82ddbe8a…`）。也就是说 HTTP 层在我复验时的那一版代码**不是**他描述的基线版本——判定一律以盘上文件为准，不以任何一方的 md5 声明为准。

---

## 1. 十条命令逐条执行（EXIT + 关键输出，S1 / S2 / S3 全记录）

| # | 命令 | S1 | S2 | **S3** | 关键输出（S3） |
|---|---|---|---|---|---|
| 1 | `node packages/dsh-l2d-plugin/lib/action-compiler.test.mjs` | 0 | 0 | **0** | `action-compiler: 14 项全部通过` |
| 2 | `node --experimental-sqlite packages/dsh-l2d-db/test/db.test.mjs` | 0 | 0 | **0** | `dsh-l2d-db: 17 tests passed` |
| 3 | `node --experimental-sqlite packages/dsh-l2d-db/test/action-manifest-repo.test.mjs` | 0 | 0 | **0** | `OACA-2 动作注册表: 10 tests passed`（S1 为 9 例） |
| 4 | `node --experimental-sqlite packages/dsh-l2d-plugin/lib/action-registry-sync.test.mjs`（**指令原文路径**） | **1** | **1** | **1** | `Error: Cannot find module 'D:\Desktop\DSH-L2D\packages\dsh-l2d-plugin\lib\action-registry-sync.test.mjs'`（见 §3.1） |
| 4b | 同上，**实际路径** `packages/dsh-l2d-db/test/action-registry-sync.test.mjs` | **1** | 0 | **0** | `OACA-2 同步桥: 5 tests passed` |
| 5 | `node packages/mcp-bridge/tests/action-router.test.mjs` | 0 | 0 | **0** | `OACA-3 确定性路由: 20 tests passed` |
| 6 | `node packages/mcp-bridge/tests/metrics.test.mjs` | 0 | 0 | **0** | `OACA-4 指标: 11 tests passed` |
| 7 | `npm run test:db` | **1** | 0 | **0** | 51 条 `[OK]`；`dsh-l2d-db:17 / model-adapter:11 / toolchain-status:3 / gif-analyzer:8 / OACA-2 动作注册表:10 / OACA-2 同步桥:5` |
| 8 | `npm run test:bridge` | 0 | 0 | **0** | 89 条 `✓`；含 `OACA-3:20 / OACA-4:11 / dispatch-guards:6 项全部通过` |
| 9 | `npm run test:core` | 0 | 0 | **0** | `action-compiler: 14 项全部通过` |
| 10 | `npm run typecheck` | 0 | 0 | **0** | `vue-tsc --noEmit` 无输出 |

### 1.1 唯一「命令不可执行」项原始输出（第 4 条，S1/S2/S3 均如此）

```
node:internal/modules/cjs/loader:1386
  throw err;
  ^

Error: Cannot find module 'D:\Desktop\DSH-L2D\packages\dsh-l2d-plugin\lib\action-registry-sync.test.mjs'
    code: 'MODULE_NOT_FOUND',
    requireStack: []

Node.js v22.22.2
```

> 该文件不存在；真实位置 `packages/dsh-l2d-db/test/action-registry-sync.test.mjs`（`package.json` 已于 20:20:07 改成这个）。属**指令路径口径**问题，不是产品缺陷；换成实际路径 S3 EXIT 0。

### 1.2 S1 的两处红（均已被后续修复消除）

```
# 第 7 条
Error: Cannot find module '…\packages\dsh-l2d-plugin\lib\action-registry-sync.test.mjs'
[ELIFECYCLE] Command failed with exit code 1.

# 第 4b 条
AssertionError [ERR_ASSERTION]: manifest 只带白名单字段（instruction/layers 等编译期内部信息不外泄）
+ actual - expected
  [ 'actionId','category','graphHash','graphId','interruptible',
+   'layers',
    'parameters','priority','requiredControls','requiresOwn','status',
```

> 成因：20:19 时源码已按 F-6 加入 `layers`，但断言（20:06 版本）仍精确比对旧白名单 → **源与测不同步**。20:21:04 断言跟上后转绿。这类"改了源码没改断言"的红，正是我不接受"我改好了"这类自述的原因。

---

## 2. 证据类检查（原始输出）

### A. 零 LLM 硬证据

```
$ grep -nE "llm|fetch|http" packages/mcp-bridge/action-router.mjs packages/mcp-bridge/trigger-router.mjs
（无输出，退出码 1 = 零命中）

$ grep -n "^import\|from '" packages/mcp-bridge/action-router.mjs packages/mcp-bridge/trigger-router.mjs
packages/mcp-bridge/trigger-router.mjs:14:import { ActionRouterError } from './action-router.mjs';

$ wc -l packages/mcp-bridge/action-router.mjs packages/mcp-bridge/trigger-router.mjs
  204 action-router.mjs / 91 trigger-router.mjs / 295 total
```

**判读**：两文件 295 行内 `llm|fetch|http` **字面零命中**；`action-router.mjs` 零 import，`trigger-router.mjs` 只 import 同目录 `action-router.mjs`。这是比"测试里有一条静态断言"更强的证据（断言可以被人改掉，grep 是对当前字节的直接观察）。

### B. v12 迁移不丢数据（线上库副本实测）

线上库本体时间戳（**证明未被动过**）：

```
-rw-r--r-- 1 User 121 462848 2026-11-07 12:26:18.325298300 +0800 /c/Users/User/.dsh/l2d-bridge.sqlite
```

副本（`.sqlite` + `-wal` + `-shm`）上先用裸 `DatabaseSync` 只读观察，再 `openDb` 触发 migrate：

```
--- 迁移前（原样副本，未执行 migrate） ---
{"schema_migrations":11,"maxVersion":11,"bridge_workspaces":1,"bridge_actions":0,
 "capability_profiles":0,"gallery_items":0,"action_manifests":"TABLE_ABSENT","compiled_actions":"TABLE_ABSENT"}
bridge_workspaces 样本: [{"workspace_id":"local-dsh-l2d","plugin_id":"dsh-l2d",
                          "chat_session_id":"local-dsh-l2d:chat","action_session_id":"local-dsh-l2d:action"}]
SCHEMA_VERSION 常量 = 12
--- 迁移后（openDb 执行 migrate） ---
{"schema_migrations":12,"maxVersion":12,"bridge_workspaces":1,"bridge_actions":0,
 "capability_profiles":0,"gallery_items":0,"action_manifests":0,"compiled_actions":0}
旧表 bridge_workspaces: 1 → 1 一致
旧表 bridge_actions: 0 → 0 一致
旧表 capability_profiles: 0 → 0 一致
旧表 gallery_items: 0 → 0 一致
旧数据行数全部原样: true
v12 新表已建: true true
v12 索引: ["idx_compiled_actions_status","ux_action_manifests_model_rev","ux_action_manifests_published"]
二次打开后 maxVersion = 12 / 迁移条数 = 12
```

**证明力边界（如实记录）**：线上库几乎为空（仅 `bridge_workspaces` 1 行，其余旧表 0 行）。证明的是「v11→v12 不改既有结构、不损既有行」，**不能**外推为"大库升级安全"。`.qa-tmp` 用完已删（`ls: cannot access '.qa-tmp'`），线上库 mtime 未变。

### C. 运行时 LLM 入口清单

```
$ grep -n "ai-action.json" packages/dsh-l2d-plugin/lib/index.js
640://  - runtimeLlmCallCount 是"运行时 0 LLM"的可验证数字（唯一运行时 LLM 入口 = /dsh-l2d/ai-action.json）；
1842:          runtimeLlmEntrypoint: '/dsh-l2d/ai-action.json',      // metrics 端点的 policy 自证字段
2002:    route('/dsh-l2d/ai-action.json', async (req, res) => {

$ grep -n "'/dsh-l2d/ai/call'" packages/dsh-l2d-plugin/lib/index.js
1105:    route('/dsh-l2d/ai/call', (req, res) => {
```

`/ai/call`（1105–1152）逐段核对，**链路内无 LLM、无出网**：

```js
if (!isRemoteLoopback(req)) → 403 'loopback only'
if (isCrossSite(req))      → 403 'forbidden'
if (req.method !== 'POST') → 405 'use POST'
req.on('data', … 累计 > 16KB → req.destroy())      // 限流
body = JSON.parse(…)                                // 400 bad json
name = String(body.name || '').trim()               // 400 name required
guarded = guardAiCall({ name, args }, { index: aiIndexCache.get(), mode: readMotionMode().mode })
if (!guarded.ok) → 400 guarded.message
const queued = aiInbox.call(name, body.args || {});  // 纯本地入队
→ 200 JSON(queued)
```

队列本体独立复核：

```
$ grep -nE "llm|deepseek|fetch\(|http" packages/dsh-l2d-plugin/lib/ai-inbox.mjs
（无输出，退出码 1 = 零命中）
```

**判读**：运行时唯一 LLM 入口 = `POST /dsh-l2d/ai-action.json`（2002）；`/ai/call` 只做「守卫 → 入队 → 回执」；`/api/actions/*`（dispatch / published / status）无 LLM 调用。

---

## 3. 发现

### 3.1 指令路径口径（影响执行，非产品缺陷）

**P-1**：指令第 4 条给的 `packages/dsh-l2d-plugin/lib/action-registry-sync.test.mjs` 不存在；实文件在 `packages/dsh-l2d-db/test/`。建议后续命令统一从 `package.json` 取路径。

### 3.2 已修复并经我复验的项（含复验方式）

| 编号 | 原问题 | 当前实现（S3 盘上事实） | 我的复验方式 |
|---|---|---|---|
| F-1 | `test:db` 路径错 → EXIT 1 | `package.json` 指向 `dsh-l2d-db/test/…` | `npm run test:db` **EXIT 0**，51 `[OK]` |
| F-2 | dispatch 缺回环闸门 | 新增 `actionDispatchPost`（`index.js:1739-1742`）：先 `isLoopback(req)`（Host 白名单 + 真实 remoteAddress）→ 再 `nodegraphApiPost`（跨站/方法/256KB） | 静态复核：确认用的是 `isLoopback` 而非 `isRemoteLoopback` ✅（我上一轮的 W-2 已消） |
| F-3 | `void fetch` 不 await → 409 被吞成 `accepted:true` | 删除 HTTP 自调用，改**进程内 `await runNodegraph`**（`index.js:2693`）+ `Promise.race` 120s 墙钟（`:2700-2710`）→ 成功回 `state:'completed'` + `executionId` + `result{completedSegments,remainingSegments,receipts}`；失败按 `runResult.status`（数值）或 502 抛 `ActionRouterError`；超时 `requestCancel` + 504 | 静态逐行复核 + grep 确认无 `void fetch`（仅剩无关的 DeepSeek 余额请求 `:388`） |
| F-4 | enqueue 未进队列 → requestId 幂等失效 | `findBridgeRequest` 命中即 `{status:'duplicate', state, executionId, duplicate:true}` 且**不再执行**；未命中 `INSERT OR IGNORE` 记账后执行 | 静态复核 + 确认 `INSERT OR IGNORE`（并发同 requestId 竞态安全）。**注**：HTTP 层 duplicate 分支无自动化用例，见 W-1 |
| F-5 | metrics 只写不读 | `metricsHandler` 双路径 `/api/metrics` + `/api/oaca/metrics.json`（`isRemoteLoopback` + `isCrossSite`），响应含 `policy{runtimeLlmEntrypoint, runtimeIsolationClaim}` | 静态复核 ✅ |
| F-6 | manifest 丢四层校验结论 | `layers`（对象或 null）、`errors`、`warnings` **恒出现**，`reason` 有归因时出现；`execution` 仍为 `{status:'skipped',reason:'deferred-to-oaca-4'}` 不被改写成 pass | 源码复核 + 同步桥测试 **EXIT 0** |
| F-8 | 迁移不变式无人锁 | `db.test.mjs:38-42` 新增 `SCHEMA_VERSION === Object.keys(MIGRATIONS).length` + 版本键 1..N 连续 | `db.test.mjs` **EXIT 0**（17 例） |
| F-9 | 同 revision 重发不清扫被移除动作 | `action-manifest-repo.mjs:150` 改 `action_id NOT IN (…)`；新增用例 QA-F9 | 我另写内存库实测：`rev1: a,b` → 重发只带 `a` → `published:["a"]`，`b → stale` ✅；注册表测试 10 例 EXIT 0 |
| F-11 | `actionPromptCount` 用 `summary.requested` 近似 | 改到 LLM 调用边界计数（包装 llm 函数，`index.js:1659-1663`） | 静态复核 ✅ |
| W-1（部分） | HTTP 层判定不可单测 | 抽出纯函数 `mcp-bridge/dispatch-guards.mjs`（`evaluateDispatchGuards`：模式互斥→strict 绑定→图存在），挂入 `test:bridge`，**6 项全过** | `npm run test:bridge` **EXIT 0**，含 `dispatch-guards: 6 项全部通过` |

### 3.3 残留项（按严重度）

**W-1（主要，已收窄）· 仍有 3 处纯 HTTP 行为零自动化覆盖**

- 已有覆盖：闸门判定（6 例）、路由/触发器/指标（20+11 例）、注册表/同步桥（10+5 例）。
- 仍无覆盖（`grep -rn "duplicate" packages/mcp-bridge/tests` 等零命中）：
  1. `actionDispatchPost` 的 `isLoopback` 403（非回环请求）；
  2. requestId **duplicate 分支**的 HTTP 契约（`duplicate:true` 且不重复执行）；
  3. `/api/metrics` 与 `/api/oaca/metrics.json` 的非回环 403。
- 影响：这 3 条一旦被后人改坏，**现有 10 条命令一条都不会红**（这正是上一轮 F-2/F-3/F-4 能被引入的原因）。
- 最小修复：`packages/mcp-bridge/tests/dispatch-route.test.mjs`，用最小 http server 或直接对 handler 注入伪 req/res 覆盖上述 3 例。

**W-2（新，主要）· 派发现在同步阻塞最长 120s，调用方契约已变**

- `index.js:2693-2710`：`/api/actions/dispatch` 现在**同步等待整条动作链跑完**（最多 120s），不再立即返回。
- 影响：① 前端/脚本若按旧"异步受理"语义设置了较短的客户端超时，会看到自己超时但动作仍在执行；② 反向代理/宿主 webServer 的空闲超时若 <120s，会先断连；③ `/api/actions/status` 的用途退化为"超时/重启后回查"，相关注释仍需对齐。
- 建议：在回执与文档里显式写"同步语义、上限 120s"，或提供 `?async=1` 走异步受理 + status 轮询。

**W-3（次要）· 超时后底层执行可能仍在跑，`bridge_actions` 已标 failed**

- 超时分支（`index.js:2705-2708`）调 `nodegraphRunRegistry.requestCancel` 后立刻 `finish(...504)` 并 `markBridgeTerminal('failed')`；而 cancel 是**协作式**的——`cancellableExecutor` 只在**批次边界**检查取消标志，已在执行中的那一批仍会下发完。
- 影响：出现"库说 failed、角色还在动"的短暂窗口；排障时容易误判。
- 建议：注释写明该窗口，或超时后延迟 finish 到下一批次边界。

**W-4（次要）· `workspaceId` 为空时派发落成 500 `internal-error`**

- `index.js:2659` 传 `workspaceId: request.workspaceId || mcpBridge.workspace?.id || ''`；`bridge-actions-repo.mjs:23` 的 `assertRequest` 直接 `throw 'insertRequest: workspaceId 必填'` → 非 `ActionRouterError` → 冒泡成 500。
- 影响：bridge 已 initialize 但 workspace 未就绪的窗口期，调用方看到的 500 会被误判为代码缺陷。
- 建议：入队前判空并抛 `ActionRouterError('bridge-not-ready', …, 503)`。

**W-5（次要，已说明）· `timeoutMs` 传入但仍不落库**

- `index.js:2662` 传 `timeoutMs: DISPATCH_TIMEOUT_MS`，但 `bridge-actions-repo` 的列集合不含该列 → 静默丢弃；已在 `:2654` 注释说明"仅作语义标注"。`priority` 已删除（上一轮的误导点已消）。
- 建议：要么删参，要么让 `assertRequest` 对未知字段抛错（"看着有、其实没落库"最容易在后续接优先级/超时仲裁时踩空）。

**W-6（次要）· `typecheck` 覆盖面**

- `npm run typecheck` = `pnpm -F @dsh/stage-web typecheck`（`vue-tsc`）；本轮 5 个新 `.mjs`（含 `dispatch-guards.mjs`）不在任何类型门禁内，其正确性只靠单测 + 人读。`test:types` 另有 663 条预存 tsc 错误不计入门禁。

### 3.4 视觉验收

本轮改动 **0 个前端 / 渲染层文件**（`apps/**`、`packages/stage-web/**`、`packages/renderer/**` 均无改动），视觉基线（纸白 `#F4F2EC` / 墨黑 `#171717` / 构成红 `#E6332A`、Swiss × Constructivist 版式）**无验收对象**。不以任何文字描述替代真实截图。

---

## 4. 覆盖清单与未执行项

**已覆盖（有实测支撑）**：v12 迁移幂等 + 三个索引 · v11→v12 旧库升级不损既有行（§2B） · 发布幂等 · 每模型唯一 published · 旧 revision superseded/stale · 同 revision 收缩清扫（F-9 实测） · 被拒动作不入 `compiled_actions` 但留档 · 能力 revision 漂移批量 stale · capability-mismatch 拒绝 · 参数四类拒绝 · requestId 必填 · 触发器优先级/字典序/确定性 · 无命中 `no_matching_action` · 同步桥未发布不写库 · 派发前置闸门（模式/绑定/图存在，6 例） · 零 LLM（字面零命中，§2A） · `/ai/call` 无 LLM（§2C）

**未执行（不得视为通过）**：
- 方案 §6 第 1 条：30 分钟真机交互断言 `runtimeLlmCallCount === 0`（新增的 `/api/oaca/metrics.json` 让这条**第一次可执行**，但仍需有人真机跑）。
- 方案 §6 第 4 条：断网/无凭据离线执行 + overlay 真机截图取证。
- 方案 §6 第 6 条：模型升级"兼容动作沿用 / 仅重编译失效项"全流程。
- 派发**成功路径**的端到端实测（需起宿主 + 切 `mode='nodegraph'` + 真实模型）：本次只有代码读取与闸门单测，未真跑一次成功派发。
- `pnpm run accept` / `test:breakpoint` / `test:chain15`（不在范围/需运行中宿主）。

---

## 5. 剩余风险

| 级别 | 风险 | 依据 |
|---|---|---|
| **高** | 派发成功路径**零端到端实测**：`await runNodegraph` + `Promise.race` 超时 + `nodegraphRunRegistry.finish` 的组合只在代码里正确，没跑过一次真实成功回执 | §4 未执行项 |
| 中 | W-1 残留 3 处 HTTP 行为零覆盖，被改坏时 10 条命令不会红（上一轮 F-2/F-3/F-4 就是这么进来的） | `grep duplicate` 零命中 |
| 中 | W-2 同步阻塞 120s：调用方超时/代理空闲超时与产品语义不匹配 | `index.js:2693-2710` |
| 中 | 真机 0-LLM 与离线 E2E 未执行；「运行时 0 LLM」目前只有静态零命中 + 单测支撑，无运行时观测数据 | §2A / §4 |
| 低 | W-3 超时窗口内"库已 failed、动作仍在动" | `index.js:2705-2708` |
| 低 | W-4 / W-5 / W-6 语义与门禁缺口 | §3.3 |
| 低 | 注册表（库）与节点图（文件）双源：图被手删 → `graph-not-found 404` fail-closed，但 `compiled_actions` 不会自动标 stale | `dispatch-guards.mjs:44-51` |

---

## 6. 裁定

**Acceptance Status：`PASS_WITH_WARNINGS`**

依据：

1. **S3 快照 10/10 命令 EXIT 0**，md5 在跑测前后一致（快照稳定），每条都有原始输出落档（§1）。
2. 上一轮 1 项阻断 + 6 项主要缺陷（F-1/F-2/F-3/F-4/F-5/F-6/F-9）**逐条修复并在我复验下成立**；其中 F-1、F-6、F-8、F-9、W-1(部分) 有独立实测证据（§3.2）。
3. 零 LLM 拿到"字面零命中"级证据（§2A/§2C），不依赖任何人的自述。
4. 不给 `PASS` 的原因有三条硬理由：① **派发成功路径从未端到端跑过一次**（§5 高风险）；② W-1 仍留 3 处 HTTP 行为零覆盖，'全绿'不能证明那一层没被改坏；③ 方案 §6 第 1、4 条验收指标未执行。

**本裁定不构成合并/发布放行**，最终决策由主理人执行。升级为 `PASS` 的最小必要动作：① 起宿主、切 `mode='nodegraph'`，真实跑一次成功派发并记录 `state:'completed'` + `executionId`（另跑一次同 requestId 重放确认 `duplicate:true` 且角色未二次动作）；② 补 3 例 HTTP 层用例；③ 真机提供 `/api/oaca/metrics.json` 读数与离线执行截图。
