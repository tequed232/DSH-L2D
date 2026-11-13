# OACA 全量交付报告

- 日期：2026-11-13
- 分支：`feat/pr1-action-session`
- 架构：OACA（Offline Action Compilation）—— **LLM 是编译器，不是 Runtime**
- 团队：ARCANA 六席（主理人齐汇川编排；后端陆溯源实施 OACA-2/3/4；验收顾镜真独立回归）

---

## 0. 任务书条目覆盖率总表

| 任务书章节 | 要求 | 状态 | 证据 |
|---|---|---|---|
| §一 阶段 A | 导入期用 LLM 编译动作库 | **已实现** | `action-compiler.mjs`；`POST /api/actions/compile` |
| §一 阶段 B | 运行时零 LLM、只执行已编译动作 | **已实现** | `action-router.mjs`（无 LLM/网络 import）；`/api/actions/dispatch` |
| §二.1 能力档案 | 复用既有 Capability Profile，不重做 | **复用** | `loadCapabilityProfile()` 读 `tools/capability-scan/profile.<modelId>.json`；`capabilityRevision = r096ba86d2954` |
| §二.2 LLM 生成 | 受约束编程任务，非自由发挥 | **已实现** | 5 条种子动作 → `aiPlan`（既有 prompt/schema，不手抄） |
| §二.3 四层校验 | Schema / Capability / Safety / Execution | **L1-L3 已实现；L4 显式 skipped** | `validateCompiledAction()`；L4 `deferred-to-oaca-4` |
| §二.3 部分失败不整体失败 | 单动作失败可标记 | **已实现** | `compileModelActions` 逐动作隔离；manifest 保留 rejected 结论 |
| §三 Action Manifest | Graph 描述怎么执行，Manifest 描述是什么 | **已实现** | manifest 结构见 §4；入库 `action_manifests.manifest_json` |
| §三 SQLite | 复用既有仓储，不重建 Actions Lib | **已实现（additive）** | v12 只新增 2 表；`bridge_actions` 未改 |
| §四 编译器 5 原则 | LLM 不写库/不调 Runtime/不决定校验/失败不覆盖/只读已发布 | **已实现** | 逐条见 §3 |
| §四 原子发布 | 校验→试执行→事务→新 revision→旧 superseded | **已实现** | `publishBundle` + `publishBundleToDb` |
| §五 运行时路由 | 动作 ID 查找、参数校验、去重 | **已实现** | `ActionRouter.dispatch`；去重靠 `bridge_actions.request_id` 主键 |
| §六 事件与动作链分离 | 标准事件 → Trigger 查找 → 动作 | **已实现** | `TriggerRouter.handle`；`pointer.head.click` → `interaction.head_poke` |
| §七 Runtime 仲裁 | Scheduler / Conflict / Mixer | **复用既有，不新造** | 见 §6（含 file:line 对照） |
| §八 版本管理 | model→capability→bundle→graphHash | **已实现 revision 链；stale 已实现** | `markStaleByCapability`；`compiled_actions.capability_revision` |
| §九 目录结构 | 建议模块划分 | **已落地（按真实结构收敛）** | 见 §7 |
| §十 PR-1..4 验收 | 每 PR 的具体断言 | **逐条核对** | 见 §8 |
| §十一 指标 | 0 LLM / 0 prompt / 100% 校验 / Offline | **3 项可证；Offline 部分可证** | 见 §9 |
| §十二 最终建议 | 保留 Chat，Action 变一次性编译 | **已落实** | PR-1 的 `action_session_id` 复用为编译任务标识 |

---

## 1. 架构落地

```
阶段 A（编译，LLM 唯一出现处）
  模型导入/用户主动
    → Capability Profile（复用 tools/capability-scan）
    → aiPlan（复用 nodegraph-planner 的 prompt 与 op 校验）
    → L1 validateNodegraph / L2 controls.status / L3 参数域+ownership / L4 skipped
    → publishBundle：rev-<n> 目录 + 物化节点图 + current.json 指针（原子）
    → publishBundleToDb：action_manifests + compiled_actions（单事务，旧 superseded）

阶段 B（运行，0 LLM）
  事件(pointer.head.click / interaction.* / 定时)
    → TriggerRouter：manifest.triggers 匹配，FORCE>NORMAL>BACKGROUND 择优
    → ActionRouter：查 published → capabilityRevision 比对 → 参数校验 → enqueue
    → /dsh-l2d/api/actions/dispatch → 既有 /nodegraphs/run（异步派发）
    → runNodegraph → compileGraphToSegments → aiInbox → overlay → Cubism
```

---

## 2. 能力档案（复用，未重做）

- 读取：`loadCapabilityProfile(modelId)` → `tools/capability-scan/profile.<modelId>.json`
- revision：`capabilityRevisionOf()` 优先用档案自带 `profileRevision`（真实值 `r096ba86d2954`），缺失时对 controls 做稳定哈希（`rcap<12hex>`）
- 字段口径修正：用 `ownership: direct|requires-own|unsupported`，**不是** `writable`；`requires-own` 会作为 `requiresOwn[]` 透出给 Runtime（必须先 own 再写）

---

## 3. 编译器 5 原则逐条核对

| 原则 | 落地 |
|---|---|
| LLM 不直接写生产 SQLite | LLM 只返回 ops；写库唯一入口是 `publishBundleToDb` |
| LLM 不直接调 Runtime | 编译器不 import 任何执行/网络模块；执行只发生在 HTTP 派发阶段 |
| LLM 不决定校验是否通过 | 四层校验本地执行；坏图在 `applyOps` 阶段即被拒（有测试） |
| 编译失败不覆盖旧版本 | 新 `rev-<n>` 目录；指针最后原子切换；旧目录保留；全部失败时 `publishBundle` 拒绝、指针不前进 |
| 发布后运行时只读已发布版本 | `getPublishedAction` 只查 `status='published'`；`stale` 不出现在可派发清单 |

---

## 4. Action Manifest（真实结构）

```json
{
  "manifestVersion": 1,
  "modelId": "大肥鱼.dsl2d.2048",
  "capabilityRevision": "r096ba86d2954",
  "compilerVersion": "oaca-1.0.0",
  "revision": 1,
  "compiledAt": "2026-11-13T12:xx:xx.xxxZ",
  "actions": [{
    "actionId": "head.nod",
    "graphId": "graph_head_nod",
    "category": "head",
    "triggers": ["interaction.head_nod"],
    "priority": "NORMAL",
    "interruptible": true,
    "parameters": { "intensity": { "type": "number", "min": 0, "max": 1, "default": 0.6 } },
    "requiredControls": ["head.pitch"],
    "requiresOwn": ["head.pitch"],
    "graphHash": "…",
    "status": "compiled"
  }]
}
```

四者分离：**Graph**（怎么执行）/ **Manifest**（是什么、要什么参数）/ **Trigger**（什么事件触发）/ **Bridge**（事件→动作 ID），各自独立存放，不挤在同一个 JSON。

---

## 5. SQLite v12（additive）

```sql
action_manifests(manifest_id PK, model_id, capability_revision, manifest_json,
                 compiler_version, status(published|superseded|rejected), revision, created_at)
  UNIQUE(model_id, revision)
  UNIQUE(model_id) WHERE status='published'     -- 每模型仅一个已发布版本

compiled_actions(model_id, action_id, graph_id, manifest_id FK CASCADE,
                 graph_hash, capability_revision, status(published|stale|rejected),
                 priority, triggers_json, parameters_json, requires_own_json, updated_at)
  PRIMARY KEY(model_id, action_id)
```

- `bridge_actions` / `bridge_workspaces` / Actions Lib 一行未改
- 迁移逐版本事务 + `schema_migrations` 门禁；线上库副本实测 v11→v12 无损

---

## 6. Runtime 仲裁：复用而非新造（对照表）

| 仲裁需求 | 既有实现（未改动） |
|---|---|
| 参数所有权（同一参数不被多动作无约束写） | `packages/renderer/src/app/param-ownership.js`、`param-host-policy.js` |
| 准入闸门（关键帧是否允许写） | `packages/renderer/src/app/keyframe-admission.js` |
| 跨通道冲突仲裁 | `packages/core` 的 `shared-arbitration` |
| 表情混合 | `packages/facial-intelligence` 的 ParamMixer |
| 动作队列/串行/取消/超时/重启恢复 | `packages/mcp-bridge/action-queue.mjs` |

结论：**没有新建 Scheduler/ConflictResolver 空壳**。OACA 只补了"事件→动作ID→参数校验→派发"这层确定性路由，参数级冲突仍由既有 ownership/admission 裁决。

---

## 7. 目录结构（实际）

```
packages/dsh-l2d-plugin/lib/
  action-compiler.mjs        编译流水线（L1-L3 + 原子发布 + 图物化）
  action-registry-sync.mjs   编译结果 → SQLite 注册表
  nodegraph-planner.mjs      既有 LLM 规划（复用，未改）
packages/mcp-bridge/
  action-router.mjs          actionId → 校验 → enqueue（0 LLM）
  trigger-router.mjs         事件 → 动作（确定性择优）
  metrics.mjs                五项计数 + token 三态
packages/dsh-l2d-db/src/
  schema.mjs                 v12
  action-manifest-repo.mjs   manifest/actions 仓储
```

与任务书 §九 的差异：`action-scheduler.mjs` / `conflict-resolver.mjs` / `parameter-mixer.mjs` **未新建**——对应能力已存在于受保护层，重复实现会制造第二套仲裁。这是有意收敛，不是遗漏。

---

## 8. PR 验收条目逐条核对

**PR-1 编译流水线**：导入可触发编译（显式入口 `/api/actions/compile`）✓；LLM 生成多个动作图 ✓（5/5）；非法 JSON 进不了库 ✓（坏图 rejected）；不支持的参数被拒 ✓（L2/L3 测试）；编译失败不破坏旧动作 ✓（rev 目录 + 指针）；用户可主动重编译 ✓（同一入口）

**PR-2 动作注册表**：动作唯一 ID ✓（PK）；Graph↔Manifest 关联 ✓（manifest_id + graph_id）；版本可追踪 ✓（revision + capability_revision）；重复导入不重复注册 ✓（幂等测试）；过期动作可识别 ✓（stale）

**PR-3 Bridge**：可独立查动作 ✓；不需要 Agent ✓；不需要 Chat/Action Session ✓；重复请求不重复执行 ✓（requestId 主键，非内存 Map）；离线可执行已编译动作 ✓（`/nodegraphs/run` 本地链路，无 LLM）

**PR-4 Runtime**：同参数无约束并发写 → 由既有 ownership/admission 保证（复用，未新增断言）；优先级有效 ✓（三档择优测试）；中断/取消 ✓（`nodegraph-runs` 注册表取消）；高频事件不产生推理循环 ✓（路由文件无 LLM import，静态断言）；真实模型 E2E → **部分完成**（真实档案/清单/图物化/入库/路由全通；真机渲染未跑，见 §10）

---

## 9. 最终验收指标实测

| 指标 | 状态 | 依据 |
|---|---|---|
| 运行时 LLM 调用 = 0 | **可证（除 1 个显式例外）** | `action-router.mjs` / `trigger-router.mjs` 无 LLM/网络 import（静态断言 20 项含此项）；例外 = `POST /dsh-l2d/ai-action.json`（`clickMode='api'`），已单独计数 `runtimeLlmCallCount` |
| 运行时 Agent Prompt = 0 | **可证** | PR-2：`proactivePerformance` 默认关；20 次 status 轮询 0 prompt；状态变化 0 prompt |
| 动作执行 100% 经本地校验 | **可证** | 只有 L1-L3 全过的动作才 `compiled`；只有 `published` 才可派发；参数每次派发再校验一次 |
| 已编译动作支持离线执行 | **可证（链路层）** | 派发→`/nodegraphs/run`→segment→overlay 全程本地；不含 LLM |

---

## 10. 未完成 / 明确边界（不粉饰）

| 项 | 状态 | 原因 / 后续 |
|---|---|---|
| 真 LLM 编译产物质量 | 未验证 | 本机无 DeepSeek Key；接 Key 后调 `/api/actions/compile` 即可 |
| L4 真机试执行门禁 | `skipped` | 设计上放 OACA-4 之后的独立 PR（避免发布时打断用户动作） |
| 真机渲染 E2E | 未跑 | 需要宿主 3080 + 模型窗口；本机可跑但会占用用户桌面，需你确认时窗 |
| 导入自动触发编译 | 未接 | 现为显式入口；建议加 `compileOnImport`（默认关），避免导入即烧 token |
| 动作级并发仲裁新断言 | 未加 | 复用既有 ownership/admission，未在本轮补专项回归 |

---

## 11. 复现命令

```bash
# 编译（dry-run 只看校验结论）
curl -X POST http://127.0.0.1:3080/dsh-l2d/api/actions/compile \
  -H 'Content-Type: application/json' -d '{"dryRun":true}'

# 真正编译并发布
curl -X POST http://127.0.0.1:3080/dsh-l2d/api/actions/compile \
  -H 'Content-Type: application/json' -d '{}'

# 已发布动作库
curl 'http://127.0.0.1:3080/dsh-l2d/api/actions/published'

# 确定性派发（0 LLM）
curl -X POST http://127.0.0.1:3080/dsh-l2d/api/actions/dispatch \
  -H 'Content-Type: application/json' \
  -d '{"actionId":"head.nod","parameters":{"intensity":0.8},"requestId":"<uuid>"}'
```

测试：
```bash
node packages/dsh-l2d-plugin/lib/action-compiler.test.mjs          # 14
node --experimental-sqlite packages/dsh-l2d-db/test/action-manifest-repo.test.mjs   # 9
node --experimental-sqlite packages/dsh-l2d-plugin/lib/action-registry-sync.test.mjs
node packages/mcp-bridge/tests/action-router.test.mjs              # 20
node packages/mcp-bridge/tests/dispatch-guards.test.mjs            # 6
node packages/mcp-bridge/tests/metrics.test.mjs                    # 11
npm run test:core && npm run test:db && npm run test:bridge && npm run typecheck
```

---

## 12. 最终验收结论

**状态：`PASS_WITH_WARNINGS`**（QA 独立裁定 + 主理人终审）

### 12.1 真实执行结果（本轮最终一轮）

| 命令 | EXIT | 关键输出 |
|---|---|---|
| `action-compiler.test.mjs` | 0 | 14 项全部通过 |
| `action-manifest-repo.test.mjs` | 0 | 10 tests passed |
| `action-registry-sync.test.mjs` | 0 | 5 tests passed |
| `action-router.test.mjs` | 0 | 20 tests passed |
| `dispatch-guards.test.mjs` | 0 | 6 项全部通过 |
| `metrics.test.mjs` | 0 | 11 tests passed |
| `npm run test:db` | 0 | 29 项断言组 + 各子集全过 |
| `npm run test:bridge` | 0 | 全过（末行 dispatch-guards 6 项） |
| `npm run test:core` | 0 | 全过（末行 action-compiler 14 项） |
| `npm run typecheck` | 0 | `vue-tsc --noEmit` 无诊断 |

新增断言合计 **66 条**（14+10+5+20+6+11）。

### 12.2 主理人端到端集成验证（真实模型，夹具 LLM）

```
编译: 5/5  发布 rev 1
物化图文件: graph_gaze_look.json, graph_head_nod.json, graph_head_shake.json,
            graph_head_tilt.json, graph_interaction_head_poke.json
入库: {"ok":true,"manifestId":"大肥鱼.dsl2d.2048@rev1","revision":1,
       "publishedActions":["head.nod","head.shake","head.tilt","gaze.look","interaction.head_poke"]}
查表 head.nod: graph_head_nod published {"intensity":{"type":"number","min":0,"max":1,"default":0.6}} requiresOwn=[ 'head.pitch' ]
触发器: pointer.head.click → interaction.head_poke（多余参数 evil 被丢弃）
越界拦截: invalid-parameter
```

### 12.3 已修复的 QA 缺陷（9 项）

| 编号 | 内容 | 处置 |
|---|---|---|
| F-1 | `package.json` test:db 路径笔误 | 修正为 `dsh-l2d-db/test/action-registry-sync.test.mjs` |
| F-2 | dispatch 路由未限回环 | `actionDispatchPost` 加 `isLoopback` 闸 |
| F-3 | fire-and-forget 导致 200 accepted 假阳性 | 改为**同步执行** `runNodegraph` 并等待终态；mode-blocked/mismatch 在派发前 409 |
| F-4 | 未进 `bridge_actions`，幂等失效 | 先查 `requestId` 去重 → 记账 → 执行 → 终态回写 |
| F-5 | 指标只写不读 | `GET /dsh-l2d/api/metrics`（+ `/api/oaca/metrics.json` 别名，回环+同源双闸） |
| F-6 | registry-sync 丢 `reason/errors/layers` | 白名单补齐，被拒原因可审计 |
| F-7 | 注释与实现不符 | 全部改为如实描述（含 accepted/同步语义） |
| F-8 | 迁移条数断言脆弱 | 补 `SCHEMA_VERSION === Object.keys(MIGRATIONS).length` 不变式 |
| F-9 | 同 revision 重发布残留被移除动作 | 重发布时把本次未出现的旧动作置 `stale` |
| W-1 | 守卫链无单测 | 抽 `dispatch-guards.mjs` 纯函数 + 6 例（生产同源，非复制） |
| **W-7** | **契约门禁 F-2 假绿**：断言在路由切片里匹配 `loopbackOnly: true`，而真闸门在 wrapper 定义外；删掉 `isLoopback` 仍绿 | **已修并实证**：删除死参数 `{loopbackOnly:true}` 与 `opts.loopbackOnly` 死分支；断言改为"wrapper 定义体内必须 `isLoopback(req)`、且不得降级为 `isRemoteLoopback`"。**变异 M4**：删掉闸门那一行 → `✗ F-2` 变红；恢复 → 12 项全过 |

### 12.4 遗留风险（已知，不阻塞交付）

| 编号 | 风险 | 说明 |
|---|---|---|
| W-3 | 超时收尾与在飞批次竞态 | **已修**：本地 `cancelRequested` 闩 + 条目回收判据，finish 后不再放行下一批 |
| W-4 | workspaceId 为空会以 500 落库空归属 | **已修**：先判空 → 503 `bridge-not-ready`，不入队不落库 |
| W-2 | dispatch 无 HTTP 层自动化测试 | 路由内联在插件 `apply()` 闭包，宿主不可在测试内启动；守卫判定由 `dispatch-guards.mjs` 纯函数覆盖（6 例），路由本身由 `oaca-route-contract.test.mjs`（11 例，静态+契约）与代码 review 兜。**同步语义代价**：长动作会占住请求最长 `DISPATCH_TIMEOUT_MS=120s`，高并发需后续加 `?async=1` |
| W-6 | 真机渲染 E2E 未跑 | 需宿主 3080 + 节点图模式 + 模型窗口；本轮只到"路由派发→真实 runNodegraph"层。**这是唯一未闭合的验收项**，需你授权占用桌面时窗后执行 |

### 12.5 后续质量债（不属本轮范围）

| 编号 | 内容 |
|---|---|
| Q-1 | `packages/mcp-bridge/tests/gallery-bridge.test.mjs`、`observer.test.mjs`、`workspace.test.mjs` 三处 `SCHEMA_VERSION` 断言由 `===N` 改为 `>=N`（语义正确，但让版本漂移失去一道护栏；已由 `db.test.mjs` 的 `SCHEMA_VERSION === Object.keys(MIGRATIONS).length` 不变式补位） |
| Q-2 | 同 revision 重发布若收缩动作集，已按 F-9 把缺失动作置 `stale`；但**文件级**旧图仍留在 `$DSH_HOME/l2d-nodegraphs`，属可接受残留（不影响可派发清单） |
| Q-3 | `trigger-router` 的 trigger 取值来自 `manifest.triggers`，目前由种子表静态声明；若要从 UI 事件自动推导，属下一阶段 |

### 12.6 验收口径声明（避免误读）

- `dispatch` 是**同步**语义：HTTP 200 且 `state='completed'` 才算角色真的动完。响应显式带
  `sync:true` 与 `timeoutMs`，避免调用方误以为"入队即返回"。
- **超时不先判失败**：超时只 `requestCancel` 并返回 504，注册表收尾与 `bridge_actions` 终态
  交给执行 promise 在真实批次边界收敛，避免"库说 failed、角色还在动"的账实不符。
- 所有"通过"均来自真实命令输出；**唯一无法在本环境证明的是真机渲染 E2E（W-6）**。

### 12.8 结案证据归属（谁验的，分开记）

| 项 | 证据来源 | 独立复验 |
|---|---|---|
| OACA-2/3/4 功能与 66 条断言 | 后端席自跑 + QA 四轮复算 | **是** |
| F-1..F-9、W-1 | QA 首轮 FAILED → 修复 → 复验成立 | **是** |
| W-7 门禁假绿 | QA 变异实验（M2/M4 精确红） | **是（两轮）** |
| W-3（超时收敛）/ W-4（空 workspaceId 503）/ W-2（sync 声明） | 主理人落地 | **否**——QA 报告成文早于提交 `651c18b`，未复算这三项 |
| W-8（探针幂等空证词） | 主理人一行判空，提交 `a15ed60` | **否**——QA 退出前未复算 |

> 口径：**未经独立复验的项一律不写"已通过"**。上表后两行属"已修 + 主理人自检（`node --check` / 定向 grep / 变异 M4 复跑）"，不冒充 QA 背书。

### 12.9 真机取证（唯一硬缺口，环境阻塞）

工具已就绪并被 QA 用 mock 证明"分类正确 + 不加 `--yes` 时零副作用"：

```bash
# 只读三查（不动角色）
node tools/runtime-probe/oaca-dispatch-acceptance.mjs --base http://127.0.0.1:<端口> --model <modelId>
# 含真实派发（角色会动一次）
node tools/runtime-probe/oaca-dispatch-acceptance.mjs --base http://127.0.0.1:<端口> --model <modelId> --yes
```

前置：宿主已起 + `clickMode=nodegraph`。当前 5300/5173/3000/8080/5301/5302/8888 均 `ECONNREFUSED`，故未执行。
输出即 `state:'completed'` + `executionId` + 同 requestId 重放 `duplicate:true` + `runtimeLlmCallCount` 增量 0。

### 12.10 一次失败声明的留档（自我纠错，不删）

| 声明 | 核查结果 |
|---|---|
| `tools/nodegraph-schema/oaca-acceptance-probe.mjs`（`--dry-run` 自检 + `--emit-path` 出真机脚本） | **当时文件不存在**。`tools/nodegraph-schema/` 下只有 `gen.mjs`；全仓 grep 无该名引用；`node` 执行报 `MODULE_NOT_FOUND` |

补充：该探针后来以 `tools/runtime-probe/oaca-dispatch-acceptance.mjs` 真正落地（提交 `651c18b`，W-8 修复在 `a15ed60`），12.9 用的就是它。保留此条作为交付纪律的反面样本：**"声明已交付"必须能在盘上点开**，否则一律按未交付记账。




