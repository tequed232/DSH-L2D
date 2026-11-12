# DSH-L2D · LLM Action Programming 方案与 Phase 1 任务拆解

> 基线：`main` @ `e4a3eb1`（2026-11-12）
> 本文所有行号、路由、工具名均以该提交为准，改动后需同步更新。
> 结论先行：**Phase 1–4 已在本仓库落地并全绿**（§6 台账），本文仍完整给出 Phase 1 的 PR 级任务拆解（可直接执行/可追溯），末尾列出真正的下一阶段待办（§8）。

---

## 1. 架构分层与现状映射

方案主张「LLM 写行为程序，Runtime 执行行为程序」，四层与现有模块的对应关系：

| 层 | 职责 | 现有实现 | 状态 |
|---|---|---|---|
| L1 LLM Planner | 意图 → 行为程序 | `packages/dsh-l2d-plugin/lib/nodegraph-planner.mjs`（`aiPlan` / `handleAiPlan`） | ✅ |
| L2 Nodegraph Compiler | JSON/Graph 校验与落盘 | `nodegraph.mjs`（`validateNodegraph` / `saveNodegraph`）+ `nodegraph-ops.mjs`（`applyOps` / `docFromEditorGraph`）+ `nodegraph-ai.mjs`（`aiEdit`） | ✅ |
| L3 Action Runtime | 执行、互斥、取消、回执 | `nodegraph-runs.mjs`（注册表）+ `runNodegraph` → `executeActionSequence` → `createInboxActExecutor` → `aiInbox('l2d_act')` | ✅（取消为批间粒度，见 §7） |
| L4 Live2D Renderer | Cubism/WebGL 呈现 | `packages/renderer` + overlay | 不改造（本方案红线） |

**关键判断已在本仓库验证成立**：执行器复用 `aiInbox('l2d_act')` 既有的动作传输，没有另建通道；MCP 侧只做转发，校验/持久化/生命周期全部在宿主。

---

## 2. 接口契约

### 2.1 HTTP 路由（宿主 `packages/dsh-l2d-plugin/lib/index.js` / dev-server `tools/dev-server/index.mjs`，双侧同规格）

| 路由 | 宿主行 | dev-server 行 | 方法 | 职责 |
|---|---|---|---|---|
| `/dsh-l2d/nodegraphs/import` | 1204 | 672 | POST | 完整 Schema v1 分享 JSON 导入（`saveNodegraph` 全量校验） |
| `/dsh-l2d/nodegraphs/export` | 1260 | 710 | GET | 图 JSON 导出 |
| `/dsh-l2d/nodegraphs/run` | 1443 | 731 | POST `?name=` | 执行；`strict` 绑定模型与当前模型不符 → 409 `model-mismatch`（registry.begin 之前拦截，零动作下发） |
| `/dsh-l2d/nodegraphs/executions` | 1515 | 777 | GET `?id=` / `?limit=` | 执行记录回查（含 result/receipts 全文 / 最近 N 条摘要） |
| `/dsh-l2d/nodegraphs/cancel` | 1550 | 800 | POST `?id=` | 取消（**批间粒度**：下一批下发前生效） |
| `/dsh-l2d/api/nodegraph/graph` | 1639 | 612 | GET `?name=` / `?model=` | 读设计层图（含 hash，供 apply-ops 的 baseHash） |
| `/dsh-l2d/api/nodegraph/apply-ops` | 1600 | 565 | POST | 原子批量编辑（`applyOps` + 写回） |
| `/dsh-l2d/api/nodegraph/ai-edit` | 1601 | 565 | POST | 自然语言 → ops（不落盘，返回预览） |
| `/dsh-l2d/api/nodegraph/ai-plan` | 1610 | 565 | POST | 自然语言 → 新图并落盘（`strict` 绑定） |
| `/dsh-l2d/api/nodegraph/memory` | 1619 | 628 | GET `?q=&model=&limit=` | 行为记忆检索 + lastRun 执行摘要 |
| `/dsh-l2d/api/nodegraph/catalog` | 1657 | 545 | GET `?model=` | 模型动作组/表情/参数目录 |

守卫：全部图类入口经 `host-guard.mjs` 的 `guardGraphCall`（`HOST_GRAPH_TOOLS` 白名单，:88-99 共 10 项）；`nodegraph` 与 `llm` 模式互斥在 :499 `mode-blocked` 拦截。

### 2.2 MCP 工具（`packages/dsh-l2d-mcp/src/server.mjs`）

| 工具 | 行 | 入参 | 出参（关键字段） |
|---|---|---|---|
| `l2d_graph_get` | 482 | `name` | 设计层图 + `hash`（编辑前必取） |
| `l2d_graph_apply_ops` | 494 | `name` / `ops[]` / `baseHash` / `modelId?` | `graph` / `saved` / `errors[]`(opIndex+reason) / `hash` |
| `l2d_graph_ai_plan` | 527 | `name` / `instruction` / `lang?` / `modelId?` | `saved` / `nodeCount` / `explanation` / `warnings[]` / `hash` |
| `l2d_graph_search` | 558 | `q?` / `modelId?` / `limit?` | `items[]`（含 `semantic` / `chain` / `lastRun`）/ `hint` |
| `l2d_nodegraph_import` | 591 | `doc`（完整 Schema v1） | 导入结果 + `saved` |
| `l2d_nodegraph_run` | 605 | `name` / `modelId?` | **真实执行结果**：`status` / `receipts[]` / `completedSegments` / `remainingSegments` / `executionId` |
| `l2d_nodegraph_status` | 617 | `executionId` | `execution`（status / result 全文 / receipts / 失败原因） |
| `l2d_nodegraph_cancel` | 628 | `executionId` | `{cancelled:true}` 或 404（无 running 记录） |

### 2.3 Schema v1 文档结构（`nodegraph.mjs` 常量）

```json
{
  "schemaVersion": 1,
  "kind": "dsh-l2d-nodegraph",
  "name": "shy",
  "modelBinding": { "modelId": "大肥鱼.dsl2d.2048", "modelHash": "", "bindingMode": "strict" },
  "graph": { "roots": ["e"], "nodes": [{ "id": "e", "type": "expression", "name": "脸红", "delayMs": 0, "next": ["m"] }] },
  "segments": [{ "priority": "NORMAL", "chain": [{ "kind": "expression", "name": "脸红" }] }],
  "meta": { "semantic": "害羞：脸红后视线躲闪", "templateId": "shy", "templateVersion": 1 }
}
```

**语义索引字段（Phase 3 检索依据）**：`meta.semantic`（LLM/人工写的语义描述）、`meta.templateId`/`templateVersion`（模板来源）、`name`（文件即索引键）、`modelBinding.modelId`（跨模型过滤）。检索实现在 `nodegraph-memory.mjs`：`name×4 > semantic×2 > 链节点名×1`，同模型/`any` 加权。

运行时节点类型仅 `expression` / `motion` / `pose` / `look` / `delay`（`nodegraph.mjs` `NODE_TYPES`）；设计层入口 `trigger` 在编译时被穿透（`compileGraphToSegments`）。

---

## 3. LLM 动作编程工作流（工具调用序列）

```
1 读能力      l2d_get_state + l2d_graph_catalog?model=X      → 真实表情/动作组/参数清单
2 查重        l2d_graph_search {q:意图}                       → 命中且 lastRun=completed → 直接执行
3 生成/修补   未命中 → l2d_graph_ai_plan {name,instruction}   （新建，严格整图校验）
               命中但失败 → l2d_graph_ai_edit / l2d_graph_apply_ops（最小修改）
4 校验保存    由宿主完成（applyOps 预演/复核 + saveNodegraph 原子写）；MCP 不重复实现
5 执行        l2d_nodegraph_run {name}                        → executionId + 首批结果
6 观察回执    l2d_nodegraph_status {executionId}              → receipts / remainingSegments / failure
              未 completed / interrupted / timeout 一律不得宣称成功
```

约束（写进工具描述，硬性）：
- 动作/表情名必须来自当前模型 `live2d-ids.json`（`docs/nodegraph/models/<modelId>/live2d-ids.json`，缺失回退全局清单并带 `catalogWarning`）；
- 动作组 `Idle` 由引擎自播，禁止写入节点；
- 不得让 LLM 生成 5 种执行节点之外的底层参数节点。

---

## 4. Phase 划分与验收标准

| 阶段 | 内容 | 验收标准 |
|---|---|---|
| **Phase 1** | MCP import / run / status / cancel | 不经过编辑器即可完整操作 JSON；run 返回真实 executionId 与回执；status 可回查 receipts；cancel 在批间生效；测试全绿 |
| **Phase 2** | LLM Action Planner | 自然语言生成合法节点图；非法/残链拒绝落盘（422）；同名不覆盖（409）；无 Key 503 不伪造 |
| **Phase 3** | Action Memory | 语义检索命中既有链；空 q 全量；limit/同模型加权；损坏文档容错 |
| **Phase 4** | Runtime Feedback | 每条链附 lastRun（状态/完成与剩余段数/replanRequired/首个失败回执）；注册表异常不阻塞记忆汇编 |

---

## 5. Phase 1 PR 任务拆解（可直接执行 · 与已落地实现逐条对照）

> 说明：本 PR 已在 `7b3081d` 落地。下表保留完整拆解，供后续同类改造（如新增执行侧工具）复用同一模板。

| # | 任务 | 涉及文件 | 完成判据 | 实际提交 |
|---|---|---|---|---|
| T1 | 执行侧转发层：错误归一（plugin-offline / unreachable / http-<status> / timeout），不重复校验 | `packages/dsh-l2d-mcp/src/nodegraph-exec.mjs`（新） | 四类错误归一单测通过 | 7b3081d |
| T2 | `l2d_nodegraph_import`：转发 `POST /nodegraphs/import`，回查 graph hash 附回（失败置 `hashUnavailable`，不影响导入语义） | `src/server.mjs`（:591） | 导入后 hash 可作 apply-ops 的 baseHash | 7b3081d |
| T3 | `l2d_nodegraph_run`：转发 `POST /nodegraphs/run?name=`，返回真实结果与 executionId；描述写明「未 completed 不得宣称成功」「409 model-mismatch / conflict 原样读出」 | `src/server.mjs`（:605） | 测试断言 executionId 透传、失败语义不被吞 | 7b3081d |
| T4 | `l2d_nodegraph_status`：转发 `GET /nodegraphs/executions?id=`，透传 receipts / remainingSegments / 失败原因 | `src/server.mjs`（:617） | receipts 全文可回查 | 7b3081d |
| T5 | `l2d_nodegraph_cancel`：转发 `POST /nodegraphs/cancel?id=`，描述写明「批间粒度，已入队不保证立即中断」 | `src/server.mjs`（:628） | 终态取消返回 404 not-cancellable | 7b3081d |
| T6 | 守卫接入：`HOST_GRAPH_TOOLS` 扩至 7 项（现 10 项），`guardGraphCall` 增静态分支（import doc 形状 / run name / status·cancel executionId）；宿主与 dev-server 四路由入口同规格过守卫 | `host-guard.mjs`（:88-99 / :115-145）、`lib/index.js`、`tools/dev-server/index.mjs` | 白名单外工具仍 unknown-tool；模式互斥不回归 | 7b3081d |
| T7 | 测试：executionId/receipts 透传、cancel 语义文案防漂移、错误归一、白名单与互斥回归 | `src/nodegraph-exec.test.mjs`、`nodegraph-ops.test.mjs` | `pnpm run test:core` 全绿 | 7b3081d |
| T8 | 文档：接口契约与调用序写进 `docs/nodegraph/` | 本文件 | 行号与实现一致 | 本文件 |

**红线（本 PR 及同类改造均适用）**：不改 `nodegraph.mjs` / `nodegraph-ops.mjs` / `nodegraph-runs.mjs` 核心、不改编辑器、不改 Renderer、Schema v1 兼容、不新增节点类型、不绕过模式互斥。

---

## 6. 已交付台账（Phase 1–4）

| 阶段 | 提交 | 内容 |
|---|---|---|
| Phase 1 | `7b3081d` | MCP 执行侧四工具 + host-guard 白名单 + 双侧路由守卫 + 测试（+516/-11） |
| Phase 2 | `e7d6017` | `nodegraph-planner.mjs`：`l2d_graph_ai_plan`（空图创建、整图 valid 硬门槛、409 不覆盖、503 不伪造） |
| Phase 3+4 | `584d831` | `nodegraph-memory.mjs`：`l2d_graph_search`（语义检索 + lastRun 执行摘要闭环） |
| 配套 | `3e18e52` / `280a47f` / `26f77f1` / `f34f9e9` / `e4a3eb1` / `133de21` / `dbefb7d` / `2375341` | 模型导入管线 / 导入 UI / 模型导出 / 导航 / 快捷导入导出 |

验证口径：`pnpm run test:core` 与 `pnpm run test:db` 均 exit 0；真实 dev-server 冒烟覆盖导入→执行→回执→导出→回导。

---

## 7. 明确保留的限制（写进验收标准，不得豁免）

1. **模式互斥**：`nodegraph` 模式下 `l2d_act` / `l2d_emote` 整链工具被 `mode-blocked` 拦截，不得绕过（`host-guard.mjs:499`）。
2. **取消为批间粒度**：`cancel` 只阻止下一批下发，已入队/正在播的单批动作不立即中断；`status` 会如实反映 `interrupted`。
3. **宿主 3080 真机全链路验收仍待完成**：dev-server 测试全绿 **不等于** 真机闭环；需在宿主 3080 以真实模型跑「plan → run → status 回执 → 视觉确认」，并留存截图证据。
4. **模型切换语义**：新模型是否成为「当前模型」取决于 `discoverModelFiles` 排序首位，不保证导入即切换（`switched` 字段如实返回）。
5. **node:sqlite 实验特性**：Node ≥ 22.5，必要时 `--experimental-sqlite`；不可用时认知入库降级 warnings，不阻塞导入。
6. **live2d-ids.json 入库**：维持 `.gitignore`（用户已否决入库），仅本地生成。

---

## 8. 下一阶段待办（Phase 5 候选，按优先级）

| # | 事项 | 价值 | 涉及文件 |
|---|---|---|---|
| P5-1 | **宿主 3080 真机全链路验收**：真实模型 plan→run→status→视觉留存 | 关闭唯一未完成的端到端证据链 | `docs/nodegraph/`、`tools/acceptance/` |
| P5-2 | 取消升级为批内中断（动作级 cancel 指令下发） | 消除「已入队不中断」的用户感知延迟 | `nodegraph-runs.mjs`、`overlay`、`nodegraph-exec.mjs` |
| P5-3 | 设置页「认知档案」视图（C-4）：读 SQLite 渲染参数/资源/证据/控制关系 | 让认知档案可见可用 | `settings.html`、`@dsh/db` 查询 |
| P5-4 | probe 证据挂接（C-3）：audit36/expression-probe 结论与截图写入证据表 | 证据链可溯源 | `tools/runtime-probe`、`@dsh/db` |
| P5-5 | `analysis_jobs` 每次入库一个 job 档 | 认知过程可审计 | `cognition-ingest.mjs` |
| P5-6 | 变体选择导出（当前只导 status 报的当前模型） | 多档模型导出体验 | `settings.html`、`model-export.mjs` |

---

## 附录 A：本轮新增文件索引

| 文件 | 职责 |
|---|---|
| `lib/nodegraph-exec.mjs` | MCP 执行侧转发（四路由 + 错误归一） |
| `lib/nodegraph-planner.mjs` | NL → 新图（`aiPlan` / `handleAiPlan`） |
| `lib/nodegraph-memory.mjs` | 行为记忆汇编 + 检索 + lastRun 摘要 |
| `lib/zip-writer.mjs` | zip 运行时构造器（唯一实现，与 reader 共用 crc32） |
| `lib/model-export.mjs` | 模型导出三级定位打包 |
| `packages/dsh-l2d-db/src/cognition-ingest.mjs` | 模型认知入库（IR 事务幂等 upsert） |
