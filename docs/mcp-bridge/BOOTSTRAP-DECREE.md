# Bridge Bootstrap & Semantic Action Registry 设计裁决书（实施基准）

> 来源：用户裁决 2026-11-05 18:24。状态：**Phase 0 文档阶段，未实现**。与 SUPERVISOR-DECREE.md 并列为本里程碑双基准。
> 里程碑名：`Bridge Bootstrap & Semantic Action Registry`。交付顺序：数据库迁移 + Bootstrap 状态机 + 测试工程 → 再接正式 Agent 初始化链路。

## 0. 核心原则
1. Agent 不再加载模型包后直接开工：Bridge 先建**独立初始化工作区**（Workspace 06 Agent Bootstrap），专用 Action Analysis Session 逐一理解 Actions、建语义索引，完成后才开放正式会话。
2. 解决三问题：Agent 不知 Action 实际控制什么；不同模型同 ID 不同含义；每次重读动作定义浪费上下文。
3. **动作唯一定位 = model_id + model_version + action_id**（废除全局 action_id 假定）。⚠️ 本裁决修正 SUPERVISOR-PHASE0 Review 中「锚 motion_definitions.id」的裁定：情绪/检索全部模型锚定。
4. 数据原则：Actions Lib 不只是动作集合，是**带模型归属、语义、情绪、能力、版本、验证状态的本地能力注册中心**。
5. 情绪/神态必须经动作定义分析+模型映射验证，**不得凭名称猜测**；无法确定标 `unknown`/`needs_review`（延续 61 条标签人工审计纪律）。
6. 头发/裙子等配饰节点不注册为 Agent 可直控节点；但官方动作整体（内含这些节点）可作为已验证整体调用，不向 Agent 暴露内部节点（延续 Node Ownership 白名单）。

## 1. Workspace 06 — Agent Bootstrap
- 独立生命周期：每次初始化生成全新 workspace_id + session_id，**不复用上次会话**。
- 专属 Action Analysis Session 只做：分析每个 Action、理解功能与参数、标记情绪/神态/身体动作、识别模型专属 ID、写入 Actions Lib、能力注册与校验。不参与聊天、不参与其他工作区调度。
- Bootstrap READY 后才创建三个正式会话：**Chat Session / Model Control Session / Agent Bridge Session**（注意：正式会话从双会话扩为三会话，SUPERVISOR-DECREE 的双会话结构随之升级）。

## 2. 初始化流程与失败规则
流程：初始化请求 → 全新 Bootstrap Workspace → Analysis Session → 加载模型包 → 扫描 Actions → 逐个解析（功能/参数/依赖→情绪/神态→模型归属）→ 写入 Lib → 完整性+模型兼容校验 → 生成 **Model Capability Manifest** → READY → 创建三正式会话。
失败规则：未分析的 Action 不得标已注册；Model Control 不得调用未验证动作；Chat 可进只读/降级模式；**保留失败位置支持断点续跑**（逐动作独立分析记录，不整包重来）；不只查"分析完没"，还查每个 Action 的模型归属与参数兼容性。

## 3. 数据模型（裁决书 DDL 基线，落地前须与既有 schema 对账）
裁决书基线表：`live2d_models(model_id, model_version, model_name, package_hash, package_path, bootstrap_status, created_at, analyzed_at, PK(model_id,model_version))`；`actions(PK(model_id,model_version,action_id), name/description/capability/action_type/parameters_json/dependencies_json/semantic_description/analysis_status/enabled/**source_hash**)`；`action_emotions`（模型锚定 FK）；索引 idx_actions_model / idx_actions_analysis。
**对账要求（Phase 0 核心）**：本仓已有 models（package_hash=SHA-256 包哈希）、motion_definitions（version=链追加序）、motion_model_bindings（adapter_json）、parameters、capability-registry、motion_definitions.emotion/expression 单值列、61 条标签审计产物（LABEL-AUDIT-CLASSIFIED.md）。逐项映射：哪些复用、哪些加列、哪些新表，禁止重复建同义表；model_version 语义必须与既有版本语义（链追加序 vs 乐观锁计数）对齐后定稿。
标准 Action 描述 JSON：action_id / model{id,version} / semantic{name,description,capability,action_type} / emotion{primary,secondary,intensity} / expression{description,tags} / parameters{duration,loop} / compatibility{model_only,verified}。

## 4. 分析四步法（每步独立、可断点）
S1 Manifest Scanner：结构扫描（ID/位置/参数/类型/依赖/模型标识版本），**不加载整个模型资源进上下文**。
S2 Semantic Analyzer：逐 Action 分析（控制部位/效果/适合情绪/冲突/可否入链）。
S3 Capability Mapper：原始动作→统一语义（happy→expression.smile 等）。
S4 Library Registrar：写 SQLite + FTS 索引 + 模型能力清单 + 分析版本标记 + 可用性验证。
分析 Prompt 约束：单 Action 供给（原始定义+必要依赖+模型上下文）；不凭 ID 猜功能；不改原始定义；配饰节点不注册；unknown 标记；只输出规定 JSON Schema。

## 5. 与 Invocation Guard 的调和（关键架构决策）
**Invocation Guard = 所有 Agent 调用的唯一入口**（贯穿四个子系统）。Bootstrap 分析不豁免：
- 本地批处理：Bridge 本地扫描全部 Action → source_hash 比对找出已分析 → 本地规则先做结构分析 → 剩余按 **Token 预算分组**送 Analysis Session → 一次调用分析一批（不是一 Action 一调用）→ 剩余批次进持久化队列受**十分钟全局调用锁**控制 → 全部完成后终校验。
- 分析 Agent 调用失败同样遵守十分钟冷却；模型包哈希未变 → 直接复用既有分析结果不重分析；包更新 → 只重分析变化的 Action（source_hash 增量）。

## 6. 状态机与任务记录
`BootstrapStatus = creating_workspace | loading_package | scanning_actions | analyzing_actions | registering_actions | validating | ready | waiting_cooldown | failed`。
`BootstrapJob{bootstrapId, workspaceId, analysisSessionId, modelId, modelVersion, packageHash, status, totalActions, analyzedActions, failedActions, createdAt, completedAt?}` — 持久化，断点续跑按动作级记录。

## 7. 最终验收（12 条）
全新 Bootstrap Workspace 每次/专属分析会话/逐 Action 独立分析状态/每 Action 记录模型归属与版本/同包重复加载不重分析/包变更只分析差异/失败断点恢复/未完成 Bootstrap 不开放完整模型控制/完成自动创建三正式会话/Bootstrap 调用遵守十分钟全局限制/配饰节点不暴露为直控/**检索动作时优先匹配当前模型的 Actions**。

## 8. 四子系统定稿
Bootstrap Engine（初始化/扫描/语义分析）｜Workspace Supervisor（观察/调度）｜Action Retrieval Engine（SQLite 检索/情绪匹配/本地缓存）｜Action Composer（未命中编排）。贯穿规则：Invocation Guard 唯一入口。

## 9. 与在途任务的衔接（主理人裁定，随裁决即时生效）
1. **P12 修正案**：P1 Observer 不受影响照常；P2 Matcher 候选身份自即日起按 (modelId, actionId) 设计（intent 携带 modelId，"优先匹配当前模型"）；v9 迁移收窄为 observer_dispatch_log 单表——action_emotions/action_chain_tags 表形冻结，等本裁决 Phase 0 对账后随 v10 落地。
2. BOOTSTRAP-PHASE0（下一任务）：裁决书 DDL ↔ 既有 schema 全量对账（§3 对账要求）+ 修订 DATA-MODEL + Bootstrap 状态机/BootstrapJob 持久化设计 + 批处理与 Guard 调和设计 + 测试工程计划。
3. 三会话升级（+Agent Bridge Session）并入 BRIDGE-MOUNT 任务书（该任务尚未开工，正好吸收）。
4. Invocation Guard（十分钟全局锁）为新增组件，在 BOOTSTRAP-PHASE0 一并设计，落地排 P2 之后。
5. P3 情绪标记的数据填充 = 本裁决 Analysis Session 产出 + 61 条标签人工审计双源合流，等审计裁决。
