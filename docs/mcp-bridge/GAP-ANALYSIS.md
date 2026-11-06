# Supervisor 落地现状 Gap 分析（SUPERVISOR-PHASE0）

> 依据：docs/mcp-bridge/SUPERVISOR-DECREE.md §1/§2。对照基准=五工作区分工 + Bridge Core 六组件。
> 结论标注：【已有实现】/【部分实现】/【缺失】。所有证据为文件:行号实读，未改任何代码。

## 1. 五工作区对照

| 工作区 | 现状 | 证据与差距 |
|---|---|---|
| 01 Chat Orchestrator | 【已有实现】 | 专属 Live2D Agent 会话经 DSH workspaceRegistry/sessionController 创建（workspace-agent.mjs:394-433 ensure：registry.create + controller.create）；prompt 驱动（workspace-agent.mjs:286-291）。差距：与 Bridge 的 Chat 会话（bridge_workspaces.chat_session_id，workspace-manager.mjs:97-119）未打通——CHAT-DECOUPLE S3 未做，chat 消息未进桥记忆镜像。 |
| 02 Multimodal Analysis | 【已有实现】 | 图库语义域 schema v2（schema.mjs:310-366 gallery_items/gallery_labels/prompt_templates）；动作知识域 v3（schema.mjs:380-489 motion_analysis/learning_jobs）。61 条标签审计产物 docs/LABEL-AUDIT-CLASSIFIED.md（审计视图，无 approve/reject 决策，行 1-8）。 |
| 03 MCP Runtime | 【已有实现】 | stdio 薄壳（packages/dsh-l2d-mcp/src/server.mjs:10-11）+ Bridge 动作通道（mcp-bridge/action-queue.mjs、action-executor.mjs）+ Capability Registry（dsh-l2d-db/src/capability-registry.mjs，w3-registry 语义键 fail-closed，头注 1-25 行）。 |
| 04 Supervisor Observer | 【缺失】 | 无 WorkspaceEvent 协议、无 Event Bus、无 dispatchOnce 查重、无优先级调度（p100/p75/p90/p40）。最接近的既有件：getWorkspaceAgentStates（index.js:552-625，只读跨工作区状态）与 workspace-agent decideNotification（workspace-agent.mjs:186-215，单工作区编排门控）——都不是 Observer，缺事件化与调度指令通道。 |
| 05 Action Composer | 【缺失】 | 无 DAG 组合器、无两阶段验证（静态 A/沙箱 B）、无临时 Chain 隔离。最接近：ingestion-pipeline G0-G4 只做**入库**验证，不是执行前组合验证。 |

## 2. Bridge Core 六组件对照

| 组件 | 现状 | 证据与差距 |
|---|---|---|
| Event Bus | 【缺失】 | 现有通道全是轮询：/ai/poll（index.js:1020-1026）、/agent-state.json（index.js:1362-1367）、StatusReporter 30-120s 定时（status-reporter.mjs:59-63）。无推送、无订阅语义。裁决书 §6「事件推送优先，轮询兜底」的推送层不存在。 |
| Workspace State Observer | 【部分实现】 | 状态底料已齐：summarizeSession 七态+双子态+jobs/commands/approvals（session-events.mjs:260-535）、老化规则 ageSummaryState（session-events.mjs:231-253）、env-state 30s 过期（env-state.mjs:19 ENV_STATE_MAX_AGE_MS）。缺：WorkspaceEvent 形状（eventId/revision/waitingAgentId）、五态归类器、去重登记、跨工作区只读订阅器。 |
| Action Router | 【部分实现】 | l2d_action_enqueue/status/cancel + scope 白名单（mcp-tools.mjs:47-99、scope.mjs）+ FIFO 队列幂等（action-queue.mjs:59-94）。缺：意图→检索路由、按事件优先级的调度入口（现在 priority 仅记录不重排，action-queue.mjs 头注）。 |
| Local Action Matcher | 【缺失】 | capability-registry 有语义键与 fail-closed 断言（capability-registry.mjs），但无 SQLite 加权检索、无 85/65 阈值、无历史成功率（execution_history 有底料，schema.mjs:464-474，无查询路径）。 |
| Chain Validator | 【部分实现】 | G0-G4 入库门禁齐（ingestion-pipeline.mjs:1-40 头注 + :85/:120/:152/:187/:206 各 gate）；choreography 校验面向宿主短链（choreography.mjs:587-628）。缺：Composer DAG 执行前验证器与沙箱测试阶段（裁决书 §5 两阶段）。 |
| Action Executor | 【已有实现】 | ModelActionQueue + HttpActionExecutor（PR-C，B10-B18 全绿，test:bridge 挂载）。 |

## 3. 情绪/神态元数据对照

- 【部分实现】motion_definitions 已有 emotion/expression/gaze/body_language 四列（schema.mjs:402-418），但是**单值 TEXT**，无 intensity/confidence/多标签，无 review_state。
- 【缺失】action_emotions / action_chain_tags 两表（裁决书 §4）。
- 【部分实现】Model Profile 映射底料：motion_model_bindings.adapter_json（schema.mjs:455-462）+ model_capabilities.capability_json（schema.mjs:446-453）+ w3-registry entries（kind 含 'expression'，capability-registry.mjs:26）。
- 61 条标签审计：人工逐条裁决流程已定义（LABEL-AUDIT-CLASSIFIED.md §八），设计文档必须承接「不批量凭名称推断」约束（行 5 前置警示）。

## 4. 设置与查重存储

- 【缺失】BridgeSettings 三开关（observer/composition/localRetrieval/emotionRouting，裁决书 §6）。现状插件设置 SETTINGS_SHAPE 无任何桥设置项（index.js:109-127）。
- 【缺失】dispatchOnce 查重表（§10 解除禁令范围内）。
- Redis 禁令继续有效（§10）；全部持久化走既有 bootstrap-state.sqlite 迁移链。

## 5. 一句话结论

状态底料（七态/双子态/jobs/approvals/env-state）与执行底座（队列/执行器/能力注册表/G0-G4）均已存在，缺的是三块**胶合层**：事件化 Observer（含五态归类+查重）、加权检索 Matcher（含情绪标签表）、Composer DAG 管线（含两阶段验证）——P1/P2 恰好落在前两块。
