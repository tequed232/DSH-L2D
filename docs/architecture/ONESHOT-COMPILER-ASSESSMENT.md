# DSH-L2D「一次性编译 + 确定性运行时」方案评估与落地改进

- 评估对象：《DSH-L2D 架构梳理与精简方案》（One-shot Motion Compiler）
- 评估基准：**本仓库工作区实际代码**（分支 `feat/pr1-action-session`，HEAD `adbb198`，schema v12）
- 评估日期：2026-11-13
- 评估方式：逐条核对方案主张与盘上文件、import 引用面、DB 表、运行时闸门；不以 README 规划为已完成依据
- 结论：**方向正确且已部分落地；但方案的"删除清单"与"表结构重构"两处会打坏现有资产，需按本文件修订后执行**

---

## 0. 结论先行

| 维度 | 判定 | 依据 |
|---|---|---|
| 架构方向 | **成立** | 与已交付的 OACA 编译期/运行期分离一致 |
| 技术可行性 | **高**（运行期零 LLM 已可证） | `action-router.mjs` 295 行内 llm/fetch/http 字面零命中；`/ai/call` 链路无 LLM |
| 方案完成度 | **约 65% 已在仓库落地**（比方案自述的"待做"要多） | OACA-1..4：编译器、v12 注册表、确定性路由、指标与隔离 |
| 删除清单可行性 | **低，按名字删会打坏 3 处** | `semantic-binding` 服务导入期扫描；`cue-loop` 被 Renderer 消费；`choreography` 是 MCP 预设真源 |
| 表结构重构建议 | **不建议照做** | `models` / `model_capabilities` / `action_chains` / `execution_history` 已存在；再建 `action_programs` 会产生第三套动作真源 |
| 新增最大风险（方案未提） | **动作真源三份并存** | `action_chains+action_steps`（旧 Lib）／`action_manifests+compiled_actions`（新注册表）／`$DSH_HOME/l2d-nodegraphs/*.json`（图文件） |

**一句话**：把方案里的「删什么」换成「先建唯一真源、再按 import 面收口」，其余按方案走，可在 6 个阶段内安全收敛。

---

## 1. 目标拆解（把方案转成可验证命题）

| 编号 | 目标命题 | 判定方式（可执行） |
|---|---|---|
| G-A | 导入期只编程一次 | `metrics.actionPromptCount` 增量 = 1 次编译的 N 次动作调用，且导入结束后不再增长 |
| G-B | 运行期零 LLM | 断网 + 跑 30 分钟交互，`metrics.runtimeLlmCallCount` 增量 = 0 |
| G-C | 动作只来自已发布产物 | `getPublishedAction()` 是唯一入口；非 `published` 状态一律 404/409 |
| G-D | 运行期不需要用户选模式 | 目前**不成立**：`dispatch-guards` 在 `mode !== 'nodegraph'` 时 409（这是硬事实，方案未覆盖） |

> G-D 是本方案最容易被忽略的一条：方案说"不再需要让用户选择节点图模式还是 LLM 模式"，但当前运行时代码里模式判断是**派发前置闸门**。要取消双模式，必须先决定"谁来替代这道闸门"，否则只能改文案不能改行为。

---

## 2. 与仓库真实状态的对照（方案说"待做"，其实已有）

| 方案章节 | 方案主张 | 仓库现状 | 差距 |
|---|---|---|---|
| §3 阶段一 | 导入期 LLM 编译动作程序 | `action-compiler.mjs`：能力档案 → aiPlan → 四层校验 → 原子发布（rev 目录 + current.json） | LLM 产物质量未验（本机无 Key） |
| §3 阶段一 | Schema/参数/能力/冲突校验 | L1 `validateNodegraph` + L2 `controls.status` + L3 参数域/ownership；L4 显式 `skipped` | L4 真机试执行未做 |
| §3 阶段二 | 运行时读已编译产物执行 | `action-manifest-repo.mjs`（v12）+ `action-router.mjs` + `trigger-router.mjs` + `/api/actions/dispatch` | 成功路径未真机取证 |
| §3.1 | 两阶段职责分离 | 已分离：编译接口 `/api/actions/compile`，运行接口 `/api/actions/dispatch` | 运行时仍有 `ai-edit`/`ai-plan` 属"用户主动"入口，需在文档层明确边界 |
| §5 | 动作程序不可变版本 | `action_manifests.revision` 单调递增 + partial unique index（每模型仅一条 published）+ `stale` | 不可变语义成立；但**旧 Lib 的 `action_chains` 仍在写** |
| §5 | `validation_status` / `runtime_verified` / `approved` 分离 | `compiled_actions.status` 只有 `published|stale|rejected`；`layers` 存四层结论 | `runtime_verified` / `approved` **缺失**，需补列或补表 |
| §4 | Node Editor 变为可视化 IDE | `nodegraph.mjs` 已有 schema 校验、Graph→Segments 编译、同图重入保护 | 定位调整属产品决策，非代码问题 |
| §6 | 全局动作排队只一个权威调度器 | `ModelActionQueue` + `bridge_actions`（requestId 主键幂等）是权威；`ai-inbox` 是执行通道不是队列 | **仍然双通道**：`/ai/call` → ai-inbox → `executeActionSequence` 与 dispatch → runNodegraph 并存 |
| §6 | 拆掉运行时 LLM | `/ai-action.json`（clickMode='api'）仍在，已单独计数 | 需产品决策：保留（可控）或下线（彻底）；不能"假装已删" |

---

## 3. 可行性分析

### 3.1 技术可行性：高

- 运行期零 LLM **已经是事实**而非目标：`action-router.mjs` / `trigger-router.mjs` 无 llm/fetch import（有静态断言 + QA 独立验证 295 行字面零命中）。
- 执行层确定性已有：`runNodegraph` → `compileGraphToSegments` → `executeActionSequence`，同图重入保护、批次取消、终态回执齐全。
- 数据层已具备不可变版本能力（revision + superseded + stale）。

### 3.2 工作量评估（以本仓库规模，不含真机联调）

| 阶段 | 主要内容 | 规模 |
|---|---|---|
| 真源收口 | 三份动作数据收敛为一份 + 迁移脚本 | 3–4 天 |
| 状态补列 | `runtime_verified` / `approved` + 审核流 | 2 天 |
| 双模式收敛 | 取消 mode 闸门，改为"程序可用性"判定 | 2–3 天（含回归） |
| 双通道收敛 | dispatch 与 `/ai/call` 统一到一个执行入口 | 3 天（高风险） |
| Legacy 收口 | 按 import 面关入口 → 观察 → 删文件 | 5–8 天分三批 |
| 真机验收 | 探针跑通 + 断网 30 分钟 | 1 天（需宿主时窗） |

### 3.3 风险矩阵

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| 按方案删除清单直接删，打断 Renderer | 高 | 高 | 先 import 审计，Renderer 侧通道零改动 |
| 三份动作真源长期并存 → 行为不一致 | **已发生** | 高 | Phase 1 先定唯一真源，其余降为只读/导出 |
| 双模式取消后老用户动作失效 | 中 | 中 | 保留兼容层 + 一次性迁移提示 |
| 运行时 LLM 入口"名义删除、实际保留" | 中 | 中 | 用 metrics 增量做验收断言，不靠注释 |
| 不可变版本导致磁盘膨胀 | 低 | 低 | revision 保留 N 版 + GC 策略 |

---

## 4. 方案的不足与需修订之处（逐条给证据）

### 4.1 `semantic-binding.ts` 不是纯运行时模块（**删除会打断导入期**）

方案写"语义到动作的动态映射可在导入期完成 → 评估后删除"。真实引用：
- `tools/capability-scan/bindings.mjs` —— **导入期扫描器**用它生成绑定；
- `packages/core/src/posture.ts`、`shared-arbitration.ts` —— 参数仲裁链用它；
- `packages/core/src/motion-contract.ts`、`index.ts` —— 契约层导出。

**修订**：保留为"导入期 + 仲裁共用"的纯函数库，删除的只是"运行时按语义动态查表"这条调用路径。

### 4.2 `cue-loop.ts` 被 Renderer 消费（触碰受保护层）

`packages/renderer/src/app/cue-bridge.ts` 与 `renderer/src/index.ts` 引用 cue-loop/embodied-cue。方案把它归为"旧决策系统可删"，但删除等于改 Renderer 通道——与本方案自己列出的"保留 renderer"原则冲突。

**修订**：先把 `cue-bridge` 降级为"仅执行编译产物"（保留接口、清空决策），再谈删 `cue-loop`。

### 4.3 `choreography.mjs` 仍是 MCP 预设真源

`dsh-l2d-mcp/src/action-sequence.mjs`、`server.mjs`、`validate.mjs` 引用它，`l2d_act` 的 demo/preset 链路依赖它。方案说"迁移后删除"，但没给迁移目标。

**修订**：把预设链**编译成动作程序**入库（走同一个 compiler），`choreography` 退化为"预设清单常量"，再删实现。

### 4.4 表结构建议与既有 schema 冲突

方案提议 `models` / `model_capabilities` / `action_programs` / `execution_records` 四表。实际 v12 已有 48 张表，其中：
- `models`、`model_capabilities`、`action_chains`、`action_steps`、`execution_history` **已存在**；
- 本轮又新增 `action_manifests`、`compiled_actions`。

**修订**：不新建 `action_programs`。做法是**给 `compiled_actions` 补列**（`runtime_verified`、`approved`、`program_hash`），并把 `action_chains/action_steps` 标记为 legacy 只读，迁移完成后冻结。

### 4.5 方案未识别「动作真源三份」这个当前最大隐患

同一动作现在可能存在于：旧 `action_chains+action_steps`、新 `action_manifests+compiled_actions`、文件 `rev-<n>/graphs/*.json` + 物化到 `l2d-nodegraphs`。三者没有一致性约束。

**修订**：确立层级——**DB 注册表是唯一查询真源；文件是编译产物快照；旧 Lib 只读**。并加一致性巡检（见 Phase 1 门禁）。

### 4.6 "运行期零 LLM"缺一条：HTTP 层未限死

`/dsh-l2d/ai-action.json` 仍是运行时 LLM 入口（`clickMode='api'`）。方案说"拆除运行时依赖"，但没给判定手段。

**修订**：验收用 `metrics.runtimeLlmCallCount` 增量 = 0 做硬断言；若要彻底删，需产品确认 `clickMode='api'` 下线，而不是只在文档里写"已不推荐"。

### 4.7 双模式闸门未处理（见 §1 G-D）

`dispatch-guards.mjs` 三闸门之一就是 `mode==='nodegraph'`。方案要"取消模式选择"，却没说要删这道闸门及其替代物。

**修订**：用"程序可用性"替代"全局模式"——即：有 published 程序即可派发，无则 409 `no-published-program`。这比"切模式"更可解释，也不会让用户面对开关。

### 4.8 阶段划分缺"回滚点"与"观测先行"

方案 7 阶段是单向推进，没有"每阶段可回滚"的产物定义，也没有"先加观测再加限制"的顺序。

**修订**：每阶段必须产出 ①可回滚开关 ②可观测指标 ③回归基线，三者缺一不进下一阶段。

---

## 5. 改进后的可执行方案（7 阶段，带依赖/门禁/回滚）

> 原则：**先建唯一真源 → 先观测后限制 → 先关入口后删文件 → 每阶段可回滚**。

### Phase 0：Legacy Runtime Dependency Audit（1–2 天）｜前置：无

**做什么**：对方案 P0/P1/P2 清单里每个文件，产出机器可读审计表：
`文件 → 出度 import（谁引用它）→ 入度 import（它引用谁）→ 运行时入口是否可达 → 测试覆盖 → 数据依赖（哪些表/文件）→ 判定（保留/抽离/降级/删除）`

已知事实（本轮已核实，可直接入表）：
- `planner`：13 处引用（`core/index.ts`、`motion-contract`、`motion-intent`、`motion-profile`、`motion-trajectory`、`planner/actions-lib`…）
- `semantic-binding`：8 处，含 `tools/capability-scan/bindings.mjs`（导入期）
- `cue-loop`：5 处，含 `renderer/src/app/cue-bridge.ts`（受保护层）
- `choreography`：6 处，含 `dsh-l2d-mcp/src/action-sequence.mjs`（MCP 预设真源）
- `workspace-agent`：6 处；`context-analyzer`：4 处

**产物**：`docs/architecture/LEGACY-DEPENDENCY-AUDIT.md` + `audit.json`
**门禁**：每个"删除"判定必须附「无运行时可达路径」的证据（入口 grep + 测试引用图），否则降级为"关入口"。
**回滚**：纯文档，无代码风险。

### Phase 1：动作真源收口（3–4 天）｜依赖：Phase 0

**做什么**：
1. 明确层级：`compiled_actions`（查询真源）> `rev-*/manifest.json`（编译快照）> `action_chains`（legacy 只读）。
2. `compiled_actions` 补列：`runtime_verified INTEGER DEFAULT 0`、`approved INTEGER DEFAULT 0`、`program_hash TEXT`。
3. 加一致性巡检 `tools/actions-consistency/check.mjs`：DB ↔ 文件 ↔ nodegraph 仓三方比对，输出差异清单。
4. 旧 Lib 写入路径标记 `legacy-write-blocked`（只允许读）。

**门禁**：巡检零差异；`getPublishedAction` 出来的每条都能在 nodegraph 仓找到同 hash 图。
**回滚**：迁移脚本可逆（保留旧列，不 drop）。

### Phase 2：状态语义补齐（2 天）｜依赖：Phase 1

**做什么**：把"通过校验"与"真机跑过"与"人工批准"分成三个独立字段，并让路由按用途消费：
- `dispatch` 要求 `status='published'`；
- 需要真机保证的场景要求 `runtime_verified=1`；
- 对外发布/给 Agent 用时要求 `approved=1`。

**门禁**：三个字段互不覆盖（有测试断言：`approved=1` 不会自动把 `runtime_verified` 置 1）。
**回滚**：字段默认 0，行为不突变。

### Phase 3：双模式收敛（2–3 天）｜依赖：Phase 1

**做什么**：
1. 用 `program-availability` 替代 `mode==='nodegraph'` 闸门：有 published 程序 → 可派发；无 → 409 `no-published-program`（附"先编译"提示）。
2. 保留 `readMotionMode` 一轮，仅作为**观测**（记录还有多少用户停在 llm 模式），不退场。
3. 设置页文案从"选择模式"改为"动作库状态：已编译 N 条 / 未编译"。

**门禁**：老用户首次派发得到的是可解释的 409 + 编译入口，而不是"请切模式"。
**回滚**：`readMotionMode` 仍在，开关恢复旧行为 < 1 行。

### Phase 4：执行通道收敛（3 天，高风险）｜依赖：Phase 3

**做什么**：确立"全局排队只有 `ModelActionQueue` 一个权威"。`/ai/call` → `ai-inbox` 通道保留为**执行器接口**（不排队、不重试、不调度），所有排队/去重/取消统一在 `bridge_actions`。

**门禁**：并发 20 个动作，`bridge_actions` 行数 = 20、无重复执行、无跨通道乱序（压力脚本入 `tools/runtime-probe/`）。
**回滚**：保留 feature flag `single-queue`，可切回双通道。

### Phase 5：Legacy 关入口 → 观察 → 删文件（5–8 天，分三批）｜依赖：Phase 4

按 Phase 0 审计表分三批：
- **5a 关入口**：`workspace-agent` 运行时决策、`context-analyzer` 自动分析、`planner` 实时入口、`l2d_emote` 动态路由 —— 只关调用点，文件保留。
- **5b 观察 7 天**：`metrics` 加"legacy 命中计数"，确认 0 后再动文件。
- **5c 删文件**：按审计表逐文件删，每删一个跑全量回归。

**门禁**：每批删完 `test:core/db/bridge/typecheck` 全绿；`renderer` 与 `node-editor` 测试零改动仍绿。
**回滚**：分批提交，可单独 revert。

### Phase 6：真机验收（1 天，需宿主时窗）｜依赖：Phase 3+

**做什么**：
```bash
# 只读三查（不动角色）
node tools/runtime-probe/oaca-dispatch-acceptance.mjs --base http://127.0.0.1:<端口> --model <modelId>
# 真实派发（角色动一次）
node tools/runtime-probe/oaca-dispatch-acceptance.mjs --base http://127.0.0.1:<端口> --model <modelId> --yes
# 断网 30 分钟交互后取指标
curl 'http://127.0.0.1:<端口>/dsh-l2d/api/metrics'
```
**门禁**：`state=completed` + 重放 `duplicate:true` + `runtimeLlmCallCount` 增量 0。
**回滚**：只读探针无副作用；`--yes` 前可先跑只读三查。

---

## 6. 验收标准（把方案的 10 条改成可断言）

| # | 方案原文 | 可执行断言 | 当前状态 |
|---|---|---|---|
| 1 | 导入时 LLM 只编程一次 | 一次导入 `actionPromptCount` 增量 ≤ N（N=动作数），之后不再增长 | 未验证（无 Key） |
| 2 | 通过 G0–G4 校验 | `validation.json` 中 L1/L2/L3=pass，L4 状态如实 | L1–L3 已验；L4 skipped |
| 3 | 保存后可断开 LLM | 屏蔽 DeepSeek Key 后 compile 返回 503、dispatch 正常 | 编译侧已验证；dispatch 未真机 |
| 4 | Bridge 直读 SQLite | `getPublishedAction` 单测 + `/api/actions/published` 返回非空 | **已满足** |
| 5 | 同一程序可连续执行多次 | 同 actionId 连续 5 次 dispatch 全 completed | 未真机 |
| 6 | 执行过程无 LLM 请求 | `runtimeLlmCallCount` 增量 = 0 | 静态可证；动态待真机 |
| 7 | 取消/超时/异常/释放正常 | 409 busy / 504 timeout / 502 failed 三态有测试；超时不误判 failed | **已修**（W-3） |
| 8 | 参数范围与 Physics 不退化 | `param-guards`/`physics-gate`/`keyframe-admission` 测试全绿 | 已绿 |
| 9 | 重启可恢复、不重放未知状态 | `findUnfinished` + `markInterruptedAll` 行为有测试 | 已有，需补"不重放"断言 |
| 10 | 删旧模块后 Renderer/Editor/MCP 全绿 | 三套测试零改动仍绿 | 未开始 |

**补充 3 条方案缺失的验收**：
- 11 动作真源唯一性：巡检工具零差异；
- 12 状态语义不混淆：`runtime_verified`/`approved` 独立测试；
- 13 单队列权威：并发 20 动作无重复执行。

---

## 7. 立即可执行的下一步（建议顺序）

1. **今天就能做**：把 Phase 0 的审计表生成脚本写出来（`tools/legacy-audit/audit.mjs`），跑出 `audit.json`。我可以直接做——本轮已手工核过 8 个模块的引用面，脚本化后覆盖全部 P0/P1 清单。
2. **本周**：Phase 1 真源收口（DB 补列 + 一致性巡检 + 旧 Lib 冻结）。
3. **需你决策的两件事**：
   - `clickMode='api'`（运行时 LLM）**保留还是下线**？保留则验收口径改为"计数受控"，下线则要迁移少数依赖自然语言触发的用户。
   - `action_chains/action_steps` 是**冻结**还是**迁移后删除**？建议冻结 1 个版本周期再删。
4. **需你给时窗的一件事**：Phase 6 真机验收（会占用桌面 + 角色动一次）。

---

## 8. 附：本轮已落地、可直接复用的资产（避免重复投入）

| 资产 | 位置 | 可复用点 |
|---|---|---|
| 编译器 + 四层校验 | `packages/dsh-l2d-plugin/lib/action-compiler.mjs` | Phase 1 的"编译产物"生产者 |
| 注册表 | `packages/dsh-l2d-db/src/action-manifest-repo.mjs` | Phase 1 的"唯一查询真源" |
| 确定性路由 | `packages/mcp-bridge/action-router.mjs` + `trigger-router.mjs` | Phase 3/4 的派发层 |
| 派发闸门（纯函数） | `packages/mcp-bridge/dispatch-guards.mjs` | Phase 3 改 mode 判定的唯一改动点 |
| 指标 | `packages/mcp-bridge/metrics.mjs` + `/api/metrics` | Phase 5 的"legacy 命中=0"观测 |
| 真机探针 | `tools/runtime-probe/oaca-dispatch-acceptance.mjs` | Phase 6 验收 |
| 验收报告 | `docs/bridge/OACA-FULL-DELIVERY.md`、`QA-OACA-REPORT.md` | 基线证据（含未闭合项） |
