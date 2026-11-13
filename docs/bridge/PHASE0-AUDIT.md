# Phase 0 审查报告 —— 双会话 / 按需动作编程架构改造

- 审查日期：2026-11-13
- 审查基线：本地 `main` @ `9628f2d`（领先 `origin/main` @ `703daad` 14 个提交）；远程默认分支 HEAD 经 GitHub API 核对为 `703daad`（2026-11-10 19:08 CST）
- 审查方式：只读代码阅读 + 线上 SQLite 实查 + 真实 manifest 核对；未修改任何代码
- 结论：**目标可行，但存在 3 个必须先裁决的"事实性缺口"**（见 §6 风险 R1/R2/R3），否则 PR-1 会重演"Mock 冒充生产链路"

---

## 1. 现状真实架构（不是设计图）

```
┌───────────────────────────── DSH Host 进程 ─────────────────────────────┐
│                                                                         │
│  ① 真实 Agent 侧（唯一真实 LLM 会话）                                     │
│     workspace-agent.mjs                                                 │
│       workspaceId  22a2240a-c1eb-45de-840d-2f3783490bd1  ← 真（manifest）│
│       sessionId    session-713ca8ef-40c0-4ee4-a267-8f5e210b0a8f       │
│       ├─ setInterval 4000ms → refresh()          【隐式触发 #1】          │
│       ├─ ensure() → bootstrap prompt 一次        【显式，可保留】          │
│       └─ /workspace/status.json → status() → refresh(notify=true)         │
│                                                  【隐式触发 #2】          │
│       ↓ prompt(text)  (controller.prompt)                                │
│     同一个会话既做"反应演出"又做"动作编排"——没有职责分离                   │
│                                                                         │
│  ② MCP 工具面（两套，互不相通）                                           │
│     A. dsh-l2d-mcp/src/server.mjs  25 个工具 ← Agent 实际调用             │
│        l2d_choreograph / l2d_act / l2d_graph_ai_plan / l2d_nodegraph_run │
│        ↓ forward.mjs / nodegraph-exec.mjs                                │
│     B. mcp-bridge/mcp-tools.mjs     4 个工具 ← 注册到宿主工具注册表        │
│        l2d_action_enqueue / status / cancel / gallery_top                │
│        ↓ ModelActionQueue → HttpActionExecutor                           │
│        ⚠ bridge_actions 表**线上 0 行**：该链路从未承载过生产动作          │
│                                                                         │
│  ③ Runtime（受保护，本次不改）                                            │
│     /dsh-l2d/ai/call → aiInbox（队列 + 消费者租约 + epoch fencing）        │
│       → /ai/poll → overlay.js → Cubism Renderer                          │
│       → /ai/result + action-done 回执 → aiInbox.subscribeCompletion      │
│                                                                         │
│  ④ 持久化                                                               │
│     $DSH_HOME/l2d-bridge.sqlite   schema v10（bridge_workspaces / actions）│
│     <repo>/data/bootstrap-state.sqlite  同 schema，另一份库               │
│     节点图：**文件** $DSH_HOME/l2d-nodegraphs/*.json（无 DB 索引）         │
└─────────────────────────────────────────────────────────────────────────┘
```

### 1.1 关键事实（带证据）

| # | 事实 | 证据 |
|---|---|---|
| F1 | `bridge_workspaces` 已是"两会话"结构：`chat_session_id` + `control_session_id` | `schema.mjs:566-571`（v7） |
| F2 | **这两个 sessionId 是本地伪造字符串，不是宿主会话** | `index.js:2308-2313` `localAgentClient`：`workspaceId = 'local-'+pluginId`，`sessionId = workspaceId+':'+key`；线上实查为 `local-dsh-l2d:chat` / `local-dsh-l2d:model-control` |
| F3 | 真实宿主会话只有一个，由 workspace-agent 创建，带 `agentPreset: 'dsh-l2d'` | `workspace-agent.mjs:442-455`；`~/.dsh/l2d-workspace-agent.json` 实查 |
| F4 | `injectControlContext` 明确未接线，返回 `wired:false` | `mcp-bridge/index.mjs:60-63` |
| F5 | 动作队列链路存在且有测试，但生产零使用 | `bridge_actions` 0 行（线上库实查） |
| F6 | 迁移机制安全：逐版本事务 + `schema_migrations` 门禁，只追加 | `db.mjs:63-84`，`SCHEMA_VERSION=10` |
| F7 | L0 检索内核已存在：五维加权打分 + 阈值 0.85/0.65 + 成功率只读 `execution_history` | `action-matcher.mjs:54/133` |
| F8 | L2 能力已存在，但形态是**进程内 LLM**，不是独立会话 | `nodegraph-planner.mjs`（`aiPlan`，189 行）+ `llm-channel.mjs` |
| F9 | 节点图持久化在文件系统，DB 无任何 nodegraph 表 | `nodegraph.mjs:45/558/598`；`grep nodegraph` 于 `dsh-l2d-db/src` 无命中 |
| F10 | 无 `BridgeEnvelope` / `correlationId` 概念 | 全仓 grep 无命中 |

---

## 2. 隐式推理路径全量追踪（PR-2 的靶子）

`controller.prompt()` 全部调用点共 **2 处**，但触发源有 **3 个**：

| 触发源 | 代码路径 | 判定 | 处理 |
|---|---|---|---|
| **T1 周期轮询** | `setInterval(4000)` → `refresh()` → `decideNotification` → `prompt()` | **违规**：普通状态变化触发 LLM | 移除默认触发，改纯本地快照 |
| **T2 状态查询** | `GET /dsh-l2d/workspace/status.json` → `status()` → `refresh()`（`notify` 缺省 `true`） | **违规且隐蔽**：UI 拉状态就能触发推理 | `status()` 必须 `refresh(false)` |
| **T3 首启引导** | `ensure()` → bootstrap prompt（`bootstrapSent` 幂等） | 合规，一次性 | 保留 |

放大问题的三处细节：

1. `fingerprint()` 把 `session.state / lastTool / lastTurnEnd` 全部计入 → **任何工具回执、任何 turn/end 都会改变指纹**，进而走 `decide()` → 冷却 3s 后即可 `fire`。这正是"动作完成事件唤醒 Agent"的实现机制（`workspace-agent.mjs:155-187`）。
2. `hasPendingAction()` 只在动作**在途**时抑制（`228-236`），回执到达后抑制解除 → 完成事件立刻成为下一次推理的输入。
3. `workspace-agent.mjs` **完全不读设置**：全文件无 `agentLink / autoAct / proactive` 判断，唯一门控是 env 的 away/typing（`decideNotification:199-207`）。即"主动演出"默认常开，无法 opt-in/opt-out。

> 结论：T1+T2 必须切断，主动演出要新加独立开关（默认关）；本地快照、agent.md、Diagnostics、Persona 更新、状态追踪全部保留。

---

## 3. 目标架构 → 现状映射

| 目标组件 | 现状 | 差距等级 |
|---|---|---|
| Chat Session | 存在但**非真实宿主会话**（F2）；真实会话由 workspace-agent 持有（F3） | **阻断性（需裁决）** |
| Action Session | 完全不存在；`control_session_id` 是伪造占位 | 新建 + 需真实宿主 API |
| Bridge Router | 无。分散能力：`action-matcher`（匹配）、`ModelActionQueue`（队列/去重/超时/取消）、`aiInbox`（回执/租约） | 组装为主，少量新写 |
| BridgeEnvelope | 无（F10） | 新建（纯新增，零兼容风险） |
| L0 Exact Graph Match | 打分器有（F7），但**节点图无 DB 索引**（F9），"命中 SQLite Actions Lib" 的图↔链映射不存在 | 需新增索引层 |
| L1 确定性组合 | 无。有 `compileGraphToSegments` + `validateNodegraph` + `applyOps` 可复用 | 新建组合器（纯函数） |
| L2 新动作编程 | 有，但走进程内 LLM（F8） | 改造为"经 Action Session 调用既有 `l2d_graph_ai_plan`" |
| Runtime 不动 | `/ai/call` + `aiInbox` + overlay 完整 | 零改动（受保护） |
| Token Metrics | 无任何计数 | 新建（`chatPromptCount` 等 5 项 + 实际/估算分离） |

---

## 4. 逐 PR 修改文件清单

### PR-1 `refactor(bridge): introduce dedicated action session`
| 文件 | 动作 |
|---|---|
| `packages/dsh-l2d-db/src/schema.mjs` | 新增 v11：`ALTER TABLE bridge_workspaces ADD COLUMN action_session_id TEXT NOT NULL DEFAULT ''`（只加列，不动 `control_session_id`） |
| `packages/dsh-l2d-db/src/bridge-repo.mjs` | `COLS` / `toDomain` / `COLUMN_BY_KEY` 支持 `action`；`updateBridgeWorkspaceSession` 白名单加列；`control` 读写保留兼容 |
| `packages/mcp-bridge/workspace-manager.mjs` | `SESSION_KEYS` 增 `action`；`ensureSession` 接受 `'action'`；`ensureWorkspace` 返回 `{id, chatSessionId, actionSessionId}`（`controlSessionId` 标记 deprecated）；并发幂等：先查后建改为"查→建→条件回填"，回填后二次读校验 |
| `packages/dsh-l2d-plugin/lib/index.js` | `localAgentClient` 必须替换/明确降级（见 R1），启动日志改打印 `action=` |
| `packages/mcp-bridge/contracts.mjs` | `Live2DWorkspace` typedef 增 `actionSessionId` |
| `packages/mcp-bridge/tests/workspace.test.mjs` | 断言"恰好两个活动会话"、旧行升级不丢数据、并发导入不产生第三个会话 |

### PR-2 `fix(bridge): eliminate implicit agent notifications`
| 文件 | 动作 |
|---|---|
| `packages/dsh-l2d-plugin/lib/workspace-agent.mjs` | `refresh()` 拆为 `refreshLocal()`（写 agent.md/快照/状态，永不 prompt）与 `notifyIfOptedIn()`；`status()` 调 `refreshLocal()`；新增 `proactivePerformance` 设置项，默认 `false` |
| `packages/dsh-l2d-plugin/lib/index.js` | 接线设置读取；`intervalMs` 走本地刷新；`/workspace/status.json` 保证不触发推理 |
| `packages/dsh-l2d-plugin/lib/workspace-agent.test.mjs` | 新增：10 分钟轮询 0 次 prompt；连续 10 次已有动作 0 次额外推理；`status()` 幂等无 prompt |
| `packages/dsh-l2d-plugin/lib/settings-entry.js` | 主动演出开关 UI（默认关） |

### PR-3 `feat(bridge): add lazy action session dispatch`
| 文件 | 动作 |
|---|---|
| `packages/mcp-bridge/envelope.mjs`（新） | `BridgeEnvelope` v1 + 校验 + `correlationId` 生成；事件 `action.request/compile/execute/completed/failed/cancelled` |
| `packages/mcp-bridge/l0-index.mjs`（新） | 节点图索引：扫描 `$DSH_HOME/l2d-nodegraphs` + `listNodegraphs`，键 `(modelId, graphHash, name)`；可选落 `nodegraph_index` 表（v11 同批） |
| `packages/mcp-bridge/composer.mjs`（新） | L1 确定性组合：复用 `applyOps`/`compileGraphToSegments`/`validateNodegraph`，产出候选图并过 Schema + Capability Profile + 参数范围 |
| `packages/mcp-bridge/router.mjs`（新） | 分级裁决 L0/L1/L2 → 唤醒 Action Session（仅 L2）→ 去重/超时/取消/失败隔离 |
| `packages/mcp-bridge/action-matcher.mjs` | 复用既有 `matchIntent`，补 graph 维度（不改打分函数签名） |
| `packages/mcp-bridge/index.mjs` | `enqueueAction` 前挂 Router 前置裁决；`makeActionToolDeps` 暴露分级结果 |

### PR-4 `test(bridge): verify dual-session isolation and token efficiency`
| 文件 | 动作 |
|---|---|
| `packages/mcp-bridge/tests/router.test.mjs`（新） | L0/L1=0 次 Action Session；L2 仅 1 次；重复 requestId 不重复执行 |
| `packages/mcp-bridge/tests/envelope.test.mjs`（新） | 协议校验、超时、取消、重启恢复 |
| `packages/mcp-bridge/tests/metrics.test.mjs`（新） | 5 项计数 + 实际/估算/unavailable 三态 |
| `packages/mcp-bridge/metrics.mjs`（新） | `chatPromptCount / actionPromptCount / agentPromptCount / runtimeCallCount / cacheHitRate` |
| `tools/acceptance/*` | 补一条真实模型 E2E（复用既有 `tools/runtime-probe` 与 5300 端口真机链路） |

**保护范围确认**：Node Editor、Nodegraph Schema v1、Engine、Actions Lib、Capability Profile、Nodegraph MCP、ModelActionQueue、HttpActionExecutor、`/ai/call`、Overlay、Cubism Renderer —— 本清单**零触碰**。

---

## 5. PR 依赖关系

```
PR-1（DB + 会话事实）
  └─→ PR-3（Lazy Dispatcher 需要 actionSessionId 才能"按需唤醒"）
        └─→ PR-4（度量需要分级裁决才能证明 0 推理）
PR-2（切断隐式触发）
  └─→ PR-4（若不先切断，"0 次额外推理"断言必然失败）
```

- PR-1 与 PR-2 **可并行**（文件不重叠：db/bridge-repo/workspace-manager vs workspace-agent/index.js）—— 但 `index.js` 双方都碰，需明确分段所有权。
- PR-3 依赖 PR-1；PR-4 依赖 PR-1/2/3 全部落地。
- **不得自动 Merge**，每个 PR 需 GLM 独立验收。

---

## 6. 风险登记（含 3 个阻断项）

| 编号 | 级别 | 风险 | 处置建议 |
|---|---|---|---|
| **R1** | **CRITICAL** | `localAgentClient` 是伪造客户端：`workspaceId='local-dsh-l2d'`、`sessionId='...:chat'`。若照此实现 PR-1，`actionSessionId` 会变成 `local-dsh-l2d:action`——**验收"恰好两个真实会话"必然假通过** | 裁决二选一：①接入真实宿主 `workspaceRegistry/sessionController`（与 workspace-agent 同源）；②明确降级为"逻辑会话"，验收标准改为"恰好两个逻辑会话 + 1 个真实宿主会话"并写进文档。**建议①** |
| **R2** | **HIGH** | 两套 MCP 工具面并存：Agent 实际用 `server.mjs`（25 工具），队列用 `mcp-tools.mjs`（4 工具），`bridge_actions` 线上 0 行。Router 若只挂在队列侧，则**拦截不到真实动作流量** | PR-3 的 Router 必须同时覆盖 `server.mjs` 的 `l2d_act`/`l2d_choreograph` 入口，否则 L0/L1 命中率恒为 0 |
| **R3** | **HIGH** | 节点图在文件系统、Actions Lib 在 SQLite，两者无映射（F9）。"Exact Graph Match 命中 SQLite Actions Lib" 在现状下**字面不可实现** | PR-3 增 `nodegraph_index` 表（additive）或明确 L0 语义为"命中节点图库 + Capability 校验"，不入 SQLite |
| R4 | MEDIUM | 双库现象：`<repo>/data/bootstrap-state.sqlite` 与 `$DSH_HOME/l2d-bridge.sqlite` 同 schema 各自迁移 | v11 需在两库都验证（幂等重复执行） |
| R5 | MEDIUM | `consumerLeaseEnabled` 默认 `false` → 回执可能被多消费者竞争 | PR-4 的 runtimeCallCount 统计需在租约关/开两态各测一次 |
| R6 | LOW | 节点图模板升级会覆盖用户手改（`meta.templateVersion` 可追溯） | 与本次改造无关，仅登记 |
| R7 | LOW | 本地 14 个未推送提交含 `nodegraph-planner/memory`，PR-3 依赖它们 | 开工前先确认基线分支（建议基于本地 main 拉工作分支，避免与 origin/main 混基线） |

---

## 7. 验收口径（可执行、可反驳）

| 目标 | 可执行验证 |
|---|---|
| 恰好两个活动会话 | 查 `bridge_workspaces` 单行 + 宿主 session 列表；断言 `action_session_id != control_session_id != chat_session_id` 且三者非空 |
| 旧库升级不丢数据 | 用线上 `l2d-bridge.sqlite` 副本跑 v11，比对 `bridge_actions`/`bridge_workspaces` 行数与内容哈希 |
| 轮询不触发推理 | 注入计数 controller，跑 10 分钟轮询（含 `/status.json` 每 2s 拉取），断言 `promptCount === 0` |
| 已有动作不触发推理 | 连续 10 次 `l2d_nodegraph_run` 已存图，断言 `actionPromptCount === 0` |
| L0/L1 = 0 次 LLM | Router 单测：注入 spy LLM，断言调用 0 次且 `cacheHitRate` 记账 |
| L2 只调 Action Session | 断言 `actionPromptCount === 1 && chatPromptCount === 0` |
| 幂等/取消/超时/恢复 | 复用 `action-queue.test.mjs` 既有断言 + 新增 Router 层同构用例 |
| 真实模型 E2E | 5300 端口 + `DeepSeek免费公皮/大肥鱼` 真机，走 overlay 真渲染截图 |
| Token 指标 | 三态字段：`actual` / `estimated` / `unavailable`；无宿主 usage 时**标 unavailable**，禁止字符估算冒充 |

---

## 8. 待用户裁决（阻塞 PR-1 开工）

1. **R1 选路**：接真实宿主 session API，还是接受"逻辑会话"降级并改验收口径？
2. **R3 L0 语义**：给节点图建 DB 索引（新增表），还是 L0 定义为"节点图库命中"？
3. **R7 基线**：PR 基于本地 `main`（含 14 个未推送提交）还是先把这些推上去/另开分支？
4. **R2 范围**：Router 是否必须同时接管 `server.mjs` 的 `l2d_act`/`l2d_choreograph`（这会使 PR-3 工作量显著增大，但不接管则 L0 无意义）？

> 上述 4 项未定前，不动代码。
