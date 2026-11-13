# One-shot Compiler 落地实施记录（Phase 0–3 已交付）

- 日期：2026-11-13
- 分支：`feat/pr1-action-session`
- 依据：`docs/architecture/ONESHOT-COMPILER-ASSESSMENT.md`（评估与 7 阶段方案）
- 状态：**Phase 0 / 1 / 2 / 3 已实施并通过回归；Phase 4–6 待推进**

---

## 1. Phase 0 · Legacy 依赖审计（工具化，不再按名字删）

**产物**
- `tools/legacy-audit/audit.mjs`：解析全仓 import 图（`.mjs/.js/.ts`，含相对路径扩展名与 `/index` 解析），从运行期入口 BFS 求可达性，按 entry 归类引用方（runtime / import-time / test）
- `tools/legacy-audit/audit.test.mjs`：6 项自测（目标可解析、判定枚举合法、plumbing 不得判删、planner 无运行期引用、cue-loop 必为 detach-first、semantic-binding 有运行期依赖）
- `docs/architecture/LEGACY-DEPENDENCY-AUDIT.md` + `audit.json`：机器可读判定表

**判定结果（13 项）**

| 判定 | 目标 | 含义 |
|---|---|---|
| `retire-with-test` | `core.planner` | 无运行期引用，仅一个测试撑着 → 删实现时同步删测试 |
| `keep-with-boundary` | `plugin.llm-channel`、`plugin.nodegraph-ai`、`plugin.ai-inbox` | 执行/编译通道，**文件必须留**，要做的是限制调用边界 |
| `detach-first` | `core.cue-loop`、`core.embodied-cue`、`core.motion-intent`、`core.semantic-binding`、`plugin.workspace-agent`、`plugin.context-analyzer`、`plugin.choreography`、`core.continuous-action`、`renderer.cue-bridge` | 运行期可达：先关入口、观察命中为 0，再删文件 |
| `delete-safe` | 无 | 没有任何一项能直删 |

**关键发现（推翻了首版评估的一处判断）**：`tools/capability-scan/bindings.mjs` 只在**注释**里提到 `core/semantic-binding`，不是 import 依赖。真正依赖它的是 `core/src/index.ts` 与 `posture.ts`（参数仲裁）。已同步更正评估文档 §4.1。

**命令**
```bash
node tools/legacy-audit/audit.mjs          # 人读
node tools/legacy-audit/audit.mjs --json   # 机器可读
node tools/legacy-audit/audit.mjs --write  # 刷新 docs/architecture/ 产物
```

---

## 2. Phase 1 · 动作真源收口

**问题**：同一动作可能存在于 ①`compiled_actions`（查询真源）②`rev-<n>/manifest.json`（编译快照）③`l2d-nodegraphs/<graphId>.json`（可执行图），三者无一致性约束。

**实施**
1. `tools/actions-consistency/check.mjs`：四方比对（DB / manifest / 图文件 / current.json 指针），输出 `error`（阻断）与 `warning`（可清理）两级问题，退出码 0/1/2 三分类。
2. `tools/actions-consistency/check.test.mjs`：5 项，含**去齿验证**——删图 → 必须 EXIT 1 且精确报 `graph-file-missing`；孤儿图 → 只 warning 不阻断。
3. 旧 Lib 冻结开关：`DSH_LEGACY_ACTIONS_FROZEN=1` 时 `createActionChain` / `createActionChainVersion` 抛 `LEGACY_ACTIONS_FROZEN`。默认关闭（零行为变化），但让"唯一真源"**可验证**——冻结后若还有写入方会立刻暴露。

**命令**
```bash
node --experimental-sqlite tools/actions-consistency/check.mjs   # 真实环境实测：无 published 动作 → EXIT 0
```

---

## 3. Phase 2 · 状态语义分离（schema v13）

**为什么要做**：`published` 只回答"通过校验"。方案的 `runtime_verified` / `approved` 若与它合并成一个 `success`，就再也答不出"这条动作被谁验过"。

**实施（v13，additive）**
```sql
ALTER TABLE compiled_actions ADD COLUMN runtime_verified INTEGER NOT NULL DEFAULT 0;
ALTER TABLE compiled_actions ADD COLUMN approved        INTEGER NOT NULL DEFAULT 0;
ALTER TABLE compiled_actions ADD COLUMN program_hash    TEXT;
CREATE INDEX idx_compiled_actions_gate ON compiled_actions(model_id, status, approved, runtime_verified);
```

**核心不变式（有测试）**
- 三态互不联动：`setRuntimeVerified` 不动 `approved`，反之亦然；
- `program_hash` ≠ `graph_hash`：只改参数默认值/触发器/优先级 → `graph_hash` 不变但程序已变；
- **程序变了，旧验证章必须失效**：重发布时 `runtime_verified/approved` 用 `CASE WHEN program_hash 相同 THEN 保留 ELSE 0` 清零。

**接口**：`programHashOf()`、`setRuntimeVerified()`、`setApproved()`、`getActionState()`；`getPublishedAction` / `listPublishedActions` 返回值新增 `runtimeVerified` / `approved` / `programHash`。

**测试**：`packages/dsh-l2d-db/test/action-state-flags.test.mjs`（7 项，含冻结开关）。

---

## 4. Phase 3 · 双模式收敛

**问题**：`dispatch-guards` 把 `mode==='nodegraph'` 当派发前置闸门，用户必须先手动切模式；`runNodegraph` 内部还有第二道同样的闸门。

**实施**
- `dispatch-guards.mjs`：新增 `gate` 参数，**默认 `'program'`**——已发布程序即授权，不再要求切模式；`gate='mode'` 为旧行为回滚开关。
- `nodegraph.mjs runNodegraph`：新增 `options.requireNodegraphMode`，仅当显式传 `false` 时跳过模式闸门（普通 `/nodegraphs/run` 行为不变）。
- `index.js`：`DSH_ACTION_GATE=mode` 一行回滚；`gate='program'` 时派发路径传 `requireNodegraphMode: false`。
- **收敛不放松安全**：strict 绑定、图存在、参数域、ownership 全部保持。

**测试**：`dispatch-guards.test.mjs` 扩到 8 项，新增两条关键断言——
- 默认口径下 `mode='llm'` + 有效程序 → `{ok:true}`；
- 同一条件下绑定不符 / 图缺失 **仍然拦**。

---

## 4.5 Phase 5a · 关入口的"观测先行"部分（已做）

按本方案自定的顺序（**先观测，再加限制**），5a 只落地了可观测 + 可关闭，不删任何文件：

- `metrics` 新增两个计数器：
  - `legacyDecisionCount`：旧决策层（`context-analyzer`、`workspace-agent`）被调用次数；
  - `legacyBlockedCount`：被开关拦下的次数。
- `DSH_LEGACY_RUNTIME=off` 总开关（默认 on = 保持现状）：
  - `context-analyzer` 不再运行（workspace 快照里 `activity=null`）；
  - `workspace-agent` 的 `proactivePerformance` 被强制关（不再由旧决策层决定动作）；
  - **不删文件、不改接口**，一行环境变量回滚。
- 放行判据（进 5c 删文件的前置）：`legacyDecisionCount === 0 && legacyBlockedCount === 0`，
  由 `packages/mcp-bridge/tests/legacy-metrics.test.mjs`（5 项）把这条判据钉住。

**为什么先不直接关**：直接关会让 `l2d_emote` / 主动演出对现有用户立即失效，属产品行为变更。
观测期的作用是拿到"到底还有谁在用"的数据，再决定是关死还是迁移。

---

## 5. 回归结果（本轮最终）

| 命令 | EXIT | 关键输出 |
|---|---|---|
| `npm run test:db` | 0 | 29 项断言组 + 注册表 10 + 同步桥 5 + 三态 7 + 巡检 5 |
| `npm run test:bridge` | 0 | 全过（含 dispatch-guards 8、route-contract 12、legacy-metrics 5） |
| `npm run test:core` | 0 | 全过（含 legacy-audit 6、action-compiler 14） |
| `npm run typecheck` | 0 | `vue-tsc --noEmit` 无诊断 |

新增断言：审计 6 + 巡检 5 + 三态 7 + 闸门 +2 + 旧决策观测 5 = **25 条**。

---

## 6. 下一步（未做，按顺序）

| Phase | 内容 | 前置 | 需要你决策 |
|---|---|---|---|
| 4 | 执行通道收敛（单一权威队列）：`/ai/call`→`ai-inbox` 降为执行器接口，排队/去重/取消统一在 `bridge_actions` | Phase 3 已就绪 | 是否接受"`ai-inbox` 不再排队"的语义变化 |
| 5a | 关入口：`context-analyzer` / `workspace-agent` 已做（开关 + 计数）；`l2d_emote` 动态路由待做 | Phase 0 审计表 | `l2d_emote` 是否允许直接下线 |
| 5b | 观察 7 天：`metrics` 加 legacy 命中计数，确认 0 | 5a | — |
| 5c | 删文件（分批）：`planner` + 其测试可先退休；`cue-loop` 需先降级 renderer 通道 | 5b | — |
| 6 | 真机验收：探针跑通 + 断网 30 分钟 `runtimeLlmCallCount===0` | 宿主启动 | **需要你给桌面时窗** |

**Phase 4 的阻塞点（必须说清）**：`ai-inbox` 目前既当执行通道又参与队列语义，直接改成"纯执行器"会影响 `l2d_act` 的 accepted/pending 语义与 MCP 工具回执。这一步建议单独开一轮，用 `single-queue` 开关灰度，而不是顺手改。
