# Phase 1 — WORKSPACE-RESPONSIBILITIES.md

> 配套：`docs/architecture/ARCHITECTURE.md`、`docs/PHASE0-REPOSITORY-AUDIT.md`
> 状态：待用户审阅。

---

## 1. Workspace 1 — Chat Orchestrator

**职责**
- 主对话、用户意图识别、场景与上下文理解。
- 情绪与动作意图识别。
- 向 Workspace 2 派发学习任务，向 Workspace 3 派发执行任务。
- 接收子工作区结构化结果，向用户反馈学习进度与执行状态。
- 管理任务生命周期与异常处理（超时、中断、失败重试）。

**输入**：用户消息、会话状态、子工作区 `WorkspaceResult`。
**输出**：学习任务派发、执行任务派发、回复、进度/状态反馈。

**禁止**
- 直接写入 Cubism 参数。
- 直接修改 Actions Lib。
- 自行生成未经验证的动作链。

**现有代码映射**：演进自 `packages/dsh-l2d-plugin/lib/workspace-agent.mjs`（`decideNotification`/`createWorkspaceAgentBridge`）与 `context-analyzer.mjs`（情境判定，须先确认调用方）。其"固定决策（decide/aggregateWorkspaceState）"被新意图识别取代；其"派发 Agent 调 `l2d_choreograph`"被新结构化派发取代。

---

## 2. Workspace 2 — Motion Learning

**职责**
- 接收用户上传的动作图库（图片 / 压缩包 / 视频 / GIF）。
- Asset Intelligence 解包、建索引、计算哈希、识别重复。
- 调用多模态模型分析动作、神态、情绪、视线（保留时间顺序与动作阶段）。
- 生成标准 Motion Description（结构化，见 `MOTION-DATA-SCHEMA.md`）。
- 据目标 Live2D 模型能力（Capability Registry）生成 Actions Chain。
- 经 Capability Validator 校验参数与冲突。
- 通过后写入 Actions Lib（SQLite），记录原始素材、分析报告、版本、验证信息。
- 支持失败恢复（状态机 `uploaded→extracted→analyzed→planned→validated→persisted`）与重复学习检测。

**输入**：图片、压缩包、模型能力清单（`modelCapabilityId`）。
**输出**：Motion JSON、动作链、学习报告。

**禁止**
- 直接控制 Renderer。
- 绕过模型能力校验。
- 将未经验证的动作标记为可执行。

**现有代码映射**：多模态分析为新增（外部多模态模型）；动作链生成复用 `packages/core` 的 planner 纯函数（`chain-normalize`、`motion-intent`、`motion-contract`）；能力校验复用 `core/src/motion-profile.ts` 的 `validateMotionProfile`；落库走新建 Actions Lib Repository。

---

## 3. Workspace 3 — MCP Runtime

**职责**
- 提供 MCP 工具接口（见 `MCP-API-CONTRACT.md`）。
- 查询 Actions Lib（语义检索 + 模型兼容性过滤）。
- 返回匹配置信度与匹配理由。
- 查询模型能力（Capability Registry）。
- 验证动作链与当前模型兼容性。
- 调用统一 Execution Manager 执行。
- 管理执行状态、超时、取消、冲突。
- 将执行记录写入 SQLite（`execution_history`）。

**输入**：动作意图、模型 ID。
**输出**：执行任务、执行状态。

**禁止**
- 直接生成未经验证的动作链。
- 绕过 ParamInjector（唯一参数写入边界）。
- 将 `accepted` 伪装为 `completed`。

**现有代码映射**：演进自 `packages/dsh-l2d-mcp/src/server.mjs`（移除 `l2d_choreograph` 固定预设）与 `packages/dsh-l2d-plugin/lib/overlay.js` 的 `exec()` 执行通道；原子能力（`l2d_set_pose`/`l2d_gaze`/`l2d_get_state`/`l2d_posture`）经 Model Adapter 暴露，不再作为"决策入口"。

---

## 4. Shared Infrastructure（公共基础层，独立且唯一）

| 模块 | 主要职责 | 现有映射 / 新建 |
| --- | --- | --- |
| Actions Lib Repository | SQLite 数据访问（CRUD + 检索） | **新建**（仓库无 DB） |
| Database Service | 连接管理、事务、WAL、迁移 | **新建**（`actions-lib.sqlite`） |
| Capability Registry | 动态模型能力登记与查询 | 迁移 `tools/w3-registry/registry.json` + `capability-scan`（运行时加载） |
| Model Adapter | 语义动作 → 模型参数映射；原子能力执行 | 迁移 `l2d_posture.planPostureExecution` + `core/src/semantic-binding` |
| MCP Gateway | MCP 工具统一注册与调用 | 演进 `packages/dsh-l2d-mcp` + `host-guard` |
| Execution Manager | 执行状态、取消、超时、冲突 | 复用 `act-result.mjs` + `action-sequence.mjs` + `motion-director.ts` |
| Motion Provenance | 原始素材与分析过程追溯 | 新建（绑定 `motion_assets`/`motion_analysis`/`motion_sources`） |
| Learning Queue | 待学习动作任务队列 | 新建（状态机驱动） |
| Task Event Bus | 跨工作区事件/日志 | 新建（承载 `WorkspaceTaskContract` 流转） |
| Live2D Renderer | Cubism Renderer → ParamInjector → Physics Output Gate | **保留并审计**（CRITICAL-1/2/3） |

**SQLite 为统一数据源**：三工作区不得各自维护独立数据库副本。

---

## 5. 职责边界红线（对应任务书 §0 核心原则）

1. 唯一参数写入边界 = `Cubism Renderer → ParamInjector → Physics Output Gate`；三工作区都不能绕过。
2. 不许使用未经验证的动作链（`status !== 'validated'` 不得进入执行）。
3. 所有动作必须具备原始素材来源与版本追溯（Motion Provenance）。
4. 底层 Cubism Renderer / ParamInjector / Physics Output Gate / 必要安全机制不得因替换动作系统被误删。

---

## 6. Agent 分工（按任务书 §9）

| Agent | 在本架构中的落点 |
| --- | --- |
| 总架构 Agent | 统一接口契约、分派、审集成、保替换完整性 |
| 多模态 Agent | W2 的图库分析、Cubism/资产研究 |
| 后端 Agent | Actions Lib Repository、Schema Migration、检索、追溯 |
| MCP Agent | MCP Gateway、工具 Schema、执行状态管理 |
| 前端 Agent | 三工作区界面、素材上传、学习/执行状态展示 |
| 测试 Agent | 单元/集成/MCP 契约/模型兼容性/端到端测试 |
