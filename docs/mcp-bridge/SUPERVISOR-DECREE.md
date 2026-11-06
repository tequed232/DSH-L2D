# Bridge Workspace Supervisor 设计裁决书（实施基准）

> 来源：用户裁决 2026-11-05 18:11。状态：**架构文档阶段，未实现**。本文件为唯一实施基准，原文以会话记录为准。
> 前置关系：依赖 CHAT-DECOUPLE（S1/S2/S4）与 BRIDGE-MOUNT 落地后的桥挂载结构；实施顺序见 §8。

## 0. 核心原则（不可妥协）
1. 能用本地算法解决的不交给 LLM；Actions Lib 有现成动作链的不重新生成；确实没有才自主编排。
2. 每个工作区独立上下文；Observer 只读状态，不接管其他工作区。
3. 情绪/神态是 Actions 的正式元数据（结构化标签），不是 Prompt 里的自然语言。
4. Composer 按需激活（未命中才启动），不得成为常驻 Token 消耗源。
5. Token 消耗三层：L1 确定性引擎（SQLite 查询/状态映射/情绪匹配/固定链）→ L2 行为规划（DAG/规则重组）→ L3 LLM Composer（最后手段）。Agent 不感知动作库内容，只知 Bridge 能力接口。

## 1. 五工作区分工
| 工作区 | 职责 |
|---|---|
| 01 Chat Orchestrator | 对话与任务协调（已有） |
| 02 Multimodal Analysis | 多模态分析，统一写入 Actions Lib（已有） |
| 03 MCP Runtime | 动作检索、验证与执行（已有） |
| 04 **Supervisor Observer（新增）** | 订阅各工作区状态事件→识别错误/等待→判优先级→从 Actions Lib 检索动作链→把调度指令交给 Bridge（不直改其他工作区上下文） |
| 05 **Action Composer（新增）** | 接收未命中意图→组合现有 Actions 为 DAG→参数/顺序/安全校验→测试通过才交付执行 |

Bridge Core 组件：Event Bus、Workspace State Observer、Action Router、Local Action Matcher、Chain Validator、Action Executor。
三条边界：Observer 不控制其他工作区内部 Agent；Matcher 是 Bridge 自有算法（不请求 LLM）；Composer 只能用已验证 Actions，不得绕过 Validator 直控 Live2D。

## 2. Observer 事件协议
```ts
type WorkspaceStatus = 'idle'|'running'|'error'|'waiting_subagent'|'waiting_input'|'succeeded';
interface WorkspaceEvent { eventId; workspaceId; sessionId; status; taskId?; errorCode?; waitingAgentId?; timestamp; revision; }
```
分类→动作：error→diagnose(p100)；waiting_subagent→inspect_dependency(p75)；waiting_input→request_user_input(p90，**不得代答**)；succeeded→success_feedback(p40)；running/idle→低频观察/回归待机。
防重复：`dispatchOnce` 以 `workspaceId:eventId` 查重（bridge 层表或已有持久化），事件登记+任务创建同事务或 Outbox，崩溃恢复不漏调度。
DSH 现实映射：状态源=session-events 七态+SESSION_SUBSTATE+env-state（30s 过期）；**waiting_subagent 与 waiting_input 不得混用**。

## 3. 本地动作链检索（核心）
意图→提取(状态/情绪/能力标签)→SQLite 索引→匹配打分→权限/依赖校验→执行；未命中且允许→Composer。
加权：capability 35% / status 25% / emotion 20% / expression 10% / 历史成功率 10%。
阈值（可配置，测试数据校准，不冒充模型置信度）：≥85 直接采用（过校验）；65-84 查兼容；<65 未命中。
未命中且未开自主编排→返回 `{status:'unmatched'}`，**不偷偷调 Composer**。

## 4. 情绪/神态元数据（schema 兼容迁移）
新表：`action_emotions(action_id, emotion, expression, intensity, confidence, PK(action_id,emotion,expression))`；`action_chain_tags(chain_id, tag)`。`expression` 是语义描述，执行时由模型 Profile 映射到具体 Expression ID/参数（换模型不重训 Bridge）。
约束：沿用 Actions JSON 入库规则（G0-G4、Repository 唯一写入口、事务原子、拒绝留痕）；SCHEMA_VERSION 8→9 迁移；标记工作（61 条标签审计的延续）走人工审计流程，不批量凭名称推断。

## 5. Composer 约束
输出 DAG（nodes+depends_on，source:'action_composer'，requires_validation:true）。四约束：优先复用已有 Action ID；不得发明未注册工具；每节点过权限/参数/依赖校验；新组合先进临时 Chain 不覆盖正式库。两阶段：A 静态验证→B 沙箱测试→入可执行集。写/删/网络/跨工作区动作走权限检查。最大节点 12。

## 6. 设置（三开关独立，默认全开）
BridgeSettings：`observer{enabled, pollingIntervalMs}` / `composition{enabled, maxNodes, requireValidation}` / `localRetrieval{enabled, matchThreshold, cacheEnabled}` / `emotionRouting{enabled, preferTaggedActions}`。
高级默认：Observer 兜底轮询 60s（范围 30-120s，**事件推送优先，轮询只作丢事件兜底**）；匹配阈值 85；maxNodes 12；禁自动执行未验证 Chain；检索缓存 SQLite。

## 7. 测试与验收
目录 tests/workspace-observer|action-retrieval|action-composer|integration（见原文清单）。三个负面测试必须：命中已有链时 LLM 调用数=0；关 Composition 后不得偷偷调 Composer；Observer 不得修改其他工作区会话历史/私有上下文。
指标落库：缓存命中率/LLM 调用/匹配分/输入输出 Token/链耗时/成功率（真实数据判断 Token 节省，禁虚构）。

## 8. 实施阶段（Phase 1+2 先行）
| 阶段 | 内容 | 验收 |
|---|---|---|
| P1 | Workspace Observer | 正确识别五种关键状态 |
| P2 | SQLite Action Matcher | 命中已有动作不调 LLM |
| P3 | Emotion Metadata | 按情绪/神态找到 Action |
| P4 | Action Composer | 生成/验证/测试 DAG |
| P5 | Settings & Cache | 三开关独立生效 |
| P6 | Integration Tests | 多工作区并发/断点恢复/重复事件 |

Phase 0（本次）：架构文档 + 数据模型 + 测试计划 → 主程 Review → P1+P2。

## 9. 技术决策与参考
协调=Supervisor；状态传播=Event Bus+SSE/WS；状态存储=SQLite；检索=本地确定性+FTS；编排=DAG+行为树；情绪=VAD+FACS/AU+Emotion Tags；Live2D 适配=Model Profile；权限=Workspace-scoped Capability。
参考仓库（提取设计不引依赖）：toustifer/agentflow（状态机/SQLite/行为树）、diosastudio/mission-control-v2（事件订阅/实时状态）、temporal-community/temporal-ai-hitl-adk-langgraph（等待恢复/幂等）、nanlingyin/soullink-emotion-sdk（情绪分层/模型适配）、waifuai/hermes-waifu（情绪→Expression ID 映射）。

## 10. 与既有任务的衔接（主程裁定）
- CHAT-DECOUPLE S1(llm-client)/S2(poke-gate)/S4(persona) 独立于本裁决，先行；S3(chat-pipeline) 等苏格致 overlay 落地。
- BRIDGE-MOUNT / CD-BUSY-GATE 在解耦后结构上实施；Bridge 挂载点=index.js workspaceRegistry inject 闭包；dev-server /action/queue 反查走共享 SQLite（bridge_actions，WAL）。
- 本裁决 P1/P2 在 Bridge 挂载落地后开工（Observer 需要桥的事件通道）。
- 旧约束「禁止新增表」由本裁决显式解除（限 §4 两表 + Observer 查重存储）；Redis 仍然禁止。
