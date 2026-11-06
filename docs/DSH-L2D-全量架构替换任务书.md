# DSH-L2D 全量架构替换任务书
## 三工作区动作智能系统（Three-Workspace Motion Intelligence System）

> 目标仓库：`https://github.com/tequed232/DSH-L2D`
> 文档性质：架构替换总指令与 Agent 派发依据
> 配套 Skill：`dsh-l2d-team`（多智能体编排章程与启动协议）
> 状态：Phase 0 / Phase 1 进行中，代码改造前须用户确认架构方案

---

## 0. 核心原则（不可妥协）

本任务**不是**在原有动作链上增加三个工作区，而是用**三个工作区组成的新动作智能系统，整体替换**旧的动作链、训练链路和 MCP 动作工具。

- 旧动作链运行架构 → 整体替换，不长期并行两套动作执行架构。
- **底层 Cubism Renderer、ParamInjector、物理模拟（Physics Output Gate）和必要的安全机制，不得因替换动作系统被误删。**
- 唯一参数写入边界：`Cubism Renderer → ParamInjector → Physics Output Gate`。三个工作区都**不能绕过**它。
- 不允许使用未经验证的动作链；所有动作必须具备原始素材来源与版本追溯。
- 未经用户批准，不得提交 PR、合并分支或执行破坏性清理。

---

## 1. 目标架构：三个工作区 + 一个公共基础层

### 1.1 架构总览

```
Workspace 1 — Chat Orchestrator      主对话 / 场景理解 / 意图识别 / 任务调度 / 用户交互
Workspace 2 — Motion Learning         图库导入 / 多模态分析 / 动作学习 / Actions Lib 写入
Workspace 3 — MCP Runtime             动作检索 / 能力校验 / MCP 调用 / 执行状态反馈

Shared Infrastructure（公共基础层，独立于三个工作区）
  - SQLite / Actions Lib
  - Capability Registry
  - MCP Gateway
  - Execution Manager
  - Live2D Renderer（Cubism Renderer → ParamInjector → Physics Output Gate）
```

**三个工作区均为独立 Agent**，而非一个 Agent 临时切换角色——以便分别配置模型、上下文、工具权限与工作状态。

### 1.2 三个工作区的代码职责

| 工作区 | 输入 | 输出 | 禁止事项 |
| --- | --- | --- | --- |
| Chat Orchestrator | 用户消息、会话状态 | 学习任务、执行任务、回复 | 直接操作 Renderer |
| Motion Learning | 图片、压缩包、模型能力清单 | Motion JSON、动作链、学习报告 | 直接执行动作 |
| MCP Runtime | 动作意图、模型 ID | 执行任务、执行状态 | 自行生成未经验证的动作链 |

三个 Agent 之间通过**结构化消息**通信，不依靠自然语言互相转述任务。

### 1.3 代码接口示例（实现时以仓库现有语言/模块系统/依赖为准）

**① 工作区通信协议**

```ts
export type WorkspaceId = "chat" | "learning" | "runtime";

export type TaskStatus =
  | "queued" | "running" | "accepted"
  | "completed" | "rejected" | "interrupted" | "failed";

export interface WorkspaceTask<T = unknown> {
  taskId: string;
  workspace: WorkspaceId;
  operation: string;
  payload: T;
  createdAt: number;
  correlationId: string;
}

export interface WorkspaceResult<T = unknown> {
  taskId: string;
  status: TaskStatus;
  data?: T;
  error?: { code: string; message: string };
}
```

**② 主对话工作区任务路由**

```ts
async function handleUserMessage(message: string) {
  const intent = await understandIntent(message);
  if (!intent.requiresMotion) return chatResponse(message);

  const result = await runtimeWorkspace.dispatch({
    taskId: crypto.randomUUID(),
    workspace: "runtime",
    operation: "search_and_execute",
    payload: {
      intent: intent.motionIntent,
      modelId: getCurrentModelId(),
      requireValidated: true
    },
    createdAt: Date.now(),
    correlationId: crypto.randomUUID()
  });

  if (result.status === "completed") return respondWithMotionResult(result);
  if (result.error?.code === "MOTION_NOT_FOUND") return askUserForMotionReference();
  return respondWithExecutionStatus(result);
}
```

> 细节：`result.status === "accepted"` 时，主对话应**继续轮询任务状态**，不得直接告知用户动作完成。

**③ 多模态学习工作区**

```ts
interface MotionLearningInput {
  assetPaths: string[];
  modelCapabilityId: string;
  sourceId: string;
}
interface MotionAnalysis {
  action: string; emotion: string; expression: string;
  gaze: string; bodyLanguage: string;
  confidence: number; evidence: string[];
}
async function learnMotion(input: MotionLearningInput) {
  const assets = await extractAndIndexAssets(input.assetPaths);
  const analysis = await multimodalAgent.analyze({ assets, task: "analyze_motion_and_expression" });
  const motion = validateMotionAnalysis(analysis);
  const chain = await buildActionChain({ motion, capabilityId: input.modelCapabilityId });
  const validation = await validateAgainstModel(chain, input.modelCapabilityId);
  if (!validation.valid) return { status: "rejected", errors: validation.errors };
  return actionsRepository.createMotion({
    sourceId: input.sourceId, analysis: motion, chain, status: "validated"
  });
}
```

> 建议将学习过程拆成可恢复状态：`uploaded → extracted → analyzed → planned → validated → persisted`；失败时保留中间分析结果，避免重复调用多模态模型。

**④ MCP Runtime 工作区**

```ts
async function executeMotion(intent: MotionIntent, modelId: string) {
  const matches = await actionsRepository.search({ intent, modelId });
  const motion = selectBestMatch(matches);
  if (!motion) return { status: "rejected", error: { code: "MOTION_NOT_FOUND", message: "No matching motion chain" } };
  if (motion.status !== "validated") throw new Error("Motion is not validated");
  const capability = await capabilityService.get(modelId);
  const validation = await validateActionChain(motion.actionChain, capability);
  if (!validation.valid) throw new Error("Model capability validation failed");
  return executionManager.execute({ motionId: motion.id, modelId, actionChain: motion.actionChain });
}
```

> `executionManager` 必须是**唯一动作执行入口**；MCP 工具不能直接操作 Cubism 参数。

---

## 2. Actions Lib：SQLite 数据结构

动作知识与原始素材、模型能力、执行历史分开管理。

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE motion_assets (
    id TEXT PRIMARY KEY,
    source_type TEXT NOT NULL,
    original_path TEXT NOT NULL,
    archive_path TEXT,
    content_hash TEXT NOT NULL,
    imported_at TEXT NOT NULL,
    metadata_json TEXT
);

CREATE TABLE motion_analysis (
    id TEXT PRIMARY KEY,
    asset_id TEXT NOT NULL,
    model_name TEXT NOT NULL,
    analysis_json TEXT NOT NULL,
    confidence REAL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(asset_id) REFERENCES motion_assets(id)
);

CREATE TABLE motion_definitions (
    id TEXT PRIMARY KEY,
    semantic_key TEXT NOT NULL,
    description TEXT NOT NULL,
    emotion TEXT, expression TEXT, gaze TEXT, body_language TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE action_chains (
    id TEXT PRIMARY KEY,
    motion_id TEXT NOT NULL,
    chain_json TEXT NOT NULL,
    schema_version TEXT NOT NULL,
    validation_report TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY(motion_id) REFERENCES motion_definitions(id)
);

CREATE TABLE motion_sources (
    motion_id TEXT NOT NULL, asset_id TEXT NOT NULL, analysis_id TEXT,
    PRIMARY KEY(motion_id, asset_id),
    FOREIGN KEY(motion_id) REFERENCES motion_definitions(id),
    FOREIGN KEY(asset_id) REFERENCES motion_assets(id),
    FOREIGN KEY(analysis_id) REFERENCES motion_analysis(id)
);

CREATE TABLE model_capabilities (
    id TEXT PRIMARY KEY,
    model_id TEXT NOT NULL,
    capability_json TEXT NOT NULL,
    source_revision TEXT NOT NULL,
    verified_at TEXT NOT NULL
);

CREATE TABLE execution_history (
    id TEXT PRIMARY KEY,
    motion_id TEXT NOT NULL, motion_id TEXT NOT NULL,
    model_id TEXT NOT NULL, status TEXT NOT NULL,
    request_json TEXT, result_json TEXT,
    started_at TEXT NOT NULL, finished_at TEXT,
    FOREIGN KEY(motion_id) REFERENCES motion_definitions(id)
);

CREATE INDEX idx_motion_semantic ON motion_definitions(semantic_key);
CREATE INDEX idx_motion_status ON motion_definitions(status);
CREATE INDEX idx_execution_motion ON execution_history(motion_id);
```

**建议新增表**：`learning_jobs`、`action_steps`、`motion_model_bindings`、`schema_migrations`。动作版本、模型适配关系、任务恢复与数据库升级均需明确记录。

**硬性要求**：不能只把分析结果写成一段 JSON。每条动作必须有素材来源、分析记录、动作链版本、验证报告与可追溯关系。

---

## 3. 旧系统替换清单

> 必须由 Agent **先全仓库搜索实际实现**，再决定删除/重写/迁移/保留，**不能仅凭文件名判断**。

### 3.1 必须整体替换（Replace）

| 旧系统模块 | 处理方式 | 新系统对应 |
| --- | --- | --- |
| 旧固定动作链模板 | 删除旧执行依赖 | Actions Lib |
| 旧 CHOREOGRAPHY 预设 | 完全替换 | 动态 Actions Chain |
| 旧 phase 模板 | 完全替换 | 数据驱动的 Action Steps |
| 旧动作训练链路 | 完全替换 | Motion Learning Workspace |
| 旧动作知识存储 | 迁移或重建 | SQLite Actions Lib |
| 旧 l2d_choreograph 逻辑 | 重写 | 新 MCP Runtime |
| 旧 executeActionSequence 编排依赖 | 替换上层编排 | Execution Manager |
| 旧静态动作白名单 | 完全替换 | Capability Registry |
| 旧 MODEL_EXPRESSIONS 静态配置 | 移除运行时硬依赖 | 动态模型能力查询 |
| 旧 MODEL_MOTION_GROUPS 静态配置 | 移除运行时硬依赖 | 模型能力画像 |
| 旧 validateStep 静态动作校验 | 重写 | 动态 Action Chain Validator |
| 旧 MCP 动作工具集合 | 重新设计 | 新 MCP Tool API |
| 旧动作检索逻辑 | 替换 | 语义检索 + 模型兼容性过滤 |

"删除"指删除旧系统对运行时的依赖，而非无条件删源文件；旧实现应先归档 → 迁移数据 → 确认无调用方 → 再清理。

### 3.2 需要保留并重新接入（Preserve & Refactor）

| 现有模块 | 处理方式 | 原因 |
| --- | --- | --- |
| Cubism Renderer | 保留 | 底层 Live2D 渲染 |
| ParamInjector | 保留并强化 | 唯一参数写入通道 |
| Physics Output Gate | 保留并审计 | 防止物理模拟输出冲突 |
| Cubism SDK 集成 | 保留 | 模型解析与渲染基础 |
| 模型参数读取能力 | 保留 | 构建动态能力画像 |
| 参数范围检查 | 保留并扩展 | 防止非法参数输入 |
| 动作互斥管理 | 重构 | 新动作链之间的资源冲突 |
| 动作优先级机制 | 重新定义 | 新执行任务调度 |
| 中断与取消机制 | 保留并扩展 | 管理长时间动作 |
| 模型资产解析基础 | 保留并扩展 | 新 Asset Intelligence |

> 旧的 `BACKGROUND < NORMAL < FORCE` 优先级可作参考，**不能默认原样沿用**；新系统须基于资源占用、可中断性、持续时间与冲突关系重新设计调度规则。

### 3.3 需要新增的模块（New Modules）

| 新模块 | 主要职责 |
| --- | --- |
| Workspace Orchestrator | 三工作区任务调度 |
| Motion Learning Agent | 多模态图库分析 |
| Motion Runtime Agent | MCP 动作检索与执行 |
| Asset Intelligence | 压缩包拆解与模型结构解析 |
| Motion Description Engine | 视觉分析结果标准化 |
| Action Chain Planner | 据语义与模型能力生成动作链 |
| Actions Lib Repository | SQLite 数据访问 |
| Capability Registry | 动态模型能力登记 |
| Model Adapter | 语义动作 → 模型参数映射 |
| MCP Gateway | MCP 工具统一注册与调用 |
| Execution Manager | 执行状态、取消、超时、冲突 |
| Learning Queue | 待学习动作任务 |
| Motion Provenance | 原始素材与分析过程追溯 |

### 3.4 旧 MCP 工具迁移表

| 旧工具/实现 | 新处理方案 |
| --- | --- |
| l2d_act | 重新设计为经动作库检索的执行入口 |
| l2d_choreograph | 替换，不再使用固定 choreography |
| l2d_posture | 转为 Model Adapter 底层原子能力 |
| l2d_gaze | 转为 Model Adapter 底层原子能力 |
| l2d_set_pose | 重新审计参数写入边界后接入 |
| l2d_get_state | 保留为状态查询能力 |
| executeActionSequence | 替换旧编排依赖，底层执行机制可拆分复用 |
| validate.mjs | 重写动作链验证逻辑 |
| registry.json | 评估迁移为动态 Capability Registry 数据源 |

> 不要简单删除 `l2d_posture`、`l2d_gaze` 等底层能力——它们可能是新 Model Adapter 需调用的原子操作。真正被替换的是旧动作系统的**决策与编排方式**，不是所有底层控制能力。

---

## 4. 主 Agent 总指令（完整提示词框架）

> 本框架作为总架构 Agent 的总指令。要求 Agent 先调查、设计，再分阶段实施，避免直接大规模删改旧代码。

### 0. 总体指令
你是本项目的总架构 Agent（Principal Software Architect），协调前端、后端、多模态、MCP、模型资产解析与测试 Agent，完成代码库审计、架构重构、接口设计、实施与验收。本任务是在旧动作链上**建立新动作智能系统、整体替换旧运行架构**，不是添加功能。
原则：① 先审计，不凭文件名推断；② 先制定迁移方案再改造；③ 新旧不长期并行；④ 不绕过 Cubism/ParamInjector；⑤ 不用未验证动作链；⑥ 所有动作可追溯；⑦ 不经批准不提交/合并/破坏性清理；⑧ 无法确认的能力须用代码/测试/运行时证据验证。

### 1. 新系统总体架构
三个独立工作区（职责与禁止事项见 §1.2）：
- **Chat Orchestrator**：主对话、意图识别、场景理解、情绪/动作意图识别、向 W2/W3 分配任务、接收结果、反馈进度/状态、管理任务生命周期。禁止直接写 Cubism 参数、直接改动作库、自行生成未验证动作链。
- **Motion Learning**：接收图库/压缩包、解包索引、多模态分析、生成标准 Motion Description、据模型能力生成 Actions Chain、写 SQLite、记录来源/版本/验证、支持失败恢复与重复检测。禁止直接控制 Renderer、绕过能力校验、将未验证动作标为可执行。
- **MCP Runtime**：提供 MCP 工具、查 Actions Lib、语义检索、返回置信度与理由、查模型能力、校验兼容性、调用统一 Execution Manager、管理状态/超时/取消/冲突、写 execution_history。禁止自行生成未验证动作链、绕过 ParamInjector、将 accepted 伪装为 completed。

### 2. 公共基础设施
独立于三工作区的服务层：Actions Lib Repository、Database Service、Capability Registry、Model Adapter、MCP Gateway、Execution Manager、Motion Provenance、Learning Queue、Task Event Bus。
SQLite 为**统一数据源**，禁止三工作区各自维护独立副本。建议文件名：`actions-lib.sqlite`，使用事务、外键、WAL、版本迁移与一致性检查。

### 3. Motion 数据标准
每动作须含：`motion_id / semantic_key / description / emotion / facial_expression / gaze / body_language / source_asset / analysis_report / actions_chain / json_address / model_compatibility / capability_revision / schema_version / confidence / validation_report / status / created_at / updated_at`。
动作链不与单一模型参数 ID 强绑定；须经 Model Adapter 将通用语义映射到具体模型能力。
状态至少：`draft / analyzing / planned / validated / rejected / deprecated`；仅 `validated` 可进入正常执行。

### 4. 工作区通信协议
统一 Workspace Task Contract，每任务含：`task_id / correlation_id / source_workspace / target_workspace / operation / payload / created_at / deadline / status`。状态区分：`queued / running / accepted / completed / rejected / interrupted / failed / timeout`。建立可追踪任务 ID、日志与错误码；长任务须支持状态查询，不得阻塞主对话。

### 5. 旧系统全量替换
审计所有旧动作模块与调用关系（见 §3）。承担旧动作链决策/知识存储/编排职责的部分须被替代；不能因名称相似直接删整文件；底层可复用代码先确认调用关系与安全边界再拆分迁移。必须保留并审计：Cubism Renderer、ParamInjector、Physics Output Gate、Cubism SDK 集成、模型参数读取、参数范围检查、资源冲突管理、动作取消/中断机制。任何动作执行最终只能经统一参数写入边界。

### 6. 多模态学习工作流
上传图库/压缩包 → Asset Intelligence 解包索引 → 计算哈希识别重复 → 多模态分析 → Motion Description → Action Chain Planner 生成步骤 → Model Adapter 映射 → Capability Validator 校验 → 写 Actions Lib → 返回学习与可追溯记录。须保存原始路径/哈希/分析模型/时间/报告；分析失败/不支持/冲突须保留错误信息，不得伪造成功。

### 7. 动作执行工作流
W1 收意图 → W3 查 Actions Lib → 返回候选/置信度/理由 → 检查版本与模型兼容性 → 检查 validated → 检查资源与冲突 → Execution Manager 建任务 → Renderer 经 ParamInjector 执行 → 返回真实状态 → 写 execution_history。无动作返回 `MOTION_NOT_FOUND`，主对话向用户请求参考图库。未经素材与学习验证的动作不允许自动伪造为已学习。

### 8. MCP 工具设计
至少提供：`motion_search / motion_get / motion_learn / motion_learning_status / motion_execute / motion_execution_status / motion_cancel / model_capabilities / model_capability_validate`。须有明确输入/输出 Schema、错误码、权限约束与超时策略；不继续依赖旧固定 choreography 预设。

### 9. 多 Agent 分工
- 总架构 Agent：审计、定契约、分派、审集成、保替换完整性。
- 多模态 Agent：分析图库、研究 Live2D/Cubism 资产、输出结构化动作知识。
- 后端 Agent：SQLite、Repository、Schema Migration、动作检索、版本与来源追溯。
- MCP Agent：MCP Server、工具 Schema、Gateway、执行状态管理。
- 前端 Agent：三工作区界面、素材上传、学习任务状态、缺失动作提示、执行状态展示。
- 测试 Agent：单元/集成/MCP 契约/模型兼容性/端到端测试。
- 共享统一接口文档，禁止各自设计互不兼容格式。

### 10. 强制验收标准
- **架构**：三工作区职责明确、可独立配模型、主对话可调度学习与执行、子任务可状态追踪、SQLite 为统一数据源。
- **学习**：可导入图库压缩包、可多模态分析、能生成 Motion Description 与 Actions Chain、每条可追溯、未验证不可执行。
- **执行**：可语义检索、可模型能力验证、可正确处理缺失动作、可取消/中断、可返回真实状态、无第二套参数写入器。
- **迁移**：不再依赖旧 choreography/phase/静态白名单；旧 MCP 接口已替换或迁移；旧训练链路已被取代；无未经审计的旧执行入口。
- **质量**：单元/集成/MCP 契约/数据库迁移/端到端测试通过，无未解释安全回归。

### 11. 实施阶段与权限边界
- **Phase 0 — Repository Audit**（只读）：旧系统依赖图、模块清单、可复用底层清单、新旧接口映射、数据迁移风险、测试缺口。不得删改运行时代码。
- **Phase 1 — Architecture Proposal**：ARCHITECTURE.md、WORKSPACE-RESPONSIBILITIES.md、MOTION-DATA-SCHEMA.md、MCP-API-CONTRACT.md、MIGRATION-PLAN.md、ACCEPTANCE-TESTS.md。等待用户审阅。
- **Phase 2 — Foundation**（确认后）：Schema、Repository、Workspace Task Contract、Capability Registry、Execution Manager 基础接口。
- **Phase 3 — Motion Learning**：图库导入、多模态分析、动作链生成、SQLite 存储。
- **Phase 4 — MCP Runtime**：检索、模型校验、执行、状态反馈。
- **Phase 5 — Chat Orchestrator**：主对话与两子工作区调度集成。
- **Phase 6 — Legacy Replacement**：切换运行时入口、迁移历史数据、清除旧动作系统运行时依赖。
- **Phase 7 — Integration & E2E**：完整端到端测试与验收报告。

### 12. GitHub 操作约束
确认架构方案前：不创建正式实施 PR、不合并、不删旧模块、不执行不可逆迁移、不修改生产运行时入口、不擅自关闭用户 PR。确认后建统一实施分支，最终仅提交一个完整架构替换 PR（新系统+迁移+DB+MCP+测试+文档+迁移说明+回滚方案），须说明旧模块如何被替代、哪些底层被保留。

**最终目标**：将 DSH-L2D 从依赖固定动作模板的 Live2D 控制系统，升级为由主对话调度、多模态学习、MCP Runtime 检索执行、Actions Lib 持久化的模型适配型动作智能系统；具备持续学习、可追溯、模型无关、动态能力校验、可靠执行与可恢复任务管理。**不要制造空壳模块**，所有模块须有明确输入/输出/调用关系与测试证据；以实际仓库代码为准，不允许用文档代替实现。

---

## 5. Agent 派发顺序（建议）

不要一开始就让所有 Agent 同时改代码；按序派发：

| 顺序 | Agent | 首要任务 | 交付物 |
| --- | --- | --- | --- |
| 1 | 总架构 Agent | 全仓库审计 | 旧系统依赖图、迁移报告 |
| 2 | 多模态 Agent | 研究图库与 Cubism SDK | 资产解析方案、动作分析 Schema |
| 3 | 后端 Agent | 设计 SQLite | ER 图、SQL Schema、Repository |
| 4 | MCP Agent | 设计工具接口 | MCP API Contract |
| 5 | 前端 Agent | 设计三个工作区 | UI 原型与交互流程 |
| 6 | 测试 Agent | 审查方案 | 测试矩阵、验收标准 |

总架构 Agent 负责统一接口，其他 Agent 不得自行改变公共 Schema。

---

## 6. 容易踩坑的地方

1. **多模态模型不能直接生成可靠 Live2D 动作**：它理解图片中的动作，但仍需 Model Adapter 将语义转为当前模型真正支持的参数变化。
2. **图库分析不能只分析静态图片**：若含 GIF/视频/连续帧，须保留时间顺序与动作阶段信息，否则无法可靠还原动作过程。
3. **MCP 不应直接成为动作播放器**：MCP 负责工具调用与协议，真正的执行生命周期、参数冲突与中断控制由 Execution Manager 管理。

---

## 7. 最终验收须提交的五份报告

- `LEGACY-REPLACEMENT-REPORT.md`：旧系统到底替换了哪些东西。
- `WORKSPACE-INTEGRATION-REPORT.md`：三个工作区是否真正打通。
- `MOTION-LEARNING-REPORT.md`：图库能否学习并写入 SQLite。
- `MCP-E2E-REPORT.md`：能否从主对话一路调用到 Renderer。
- `REGRESSION-REPORT.md`：旧功能与底层安全机制是否回归。

---

## 8. 本次执行约定（本会话）

- 严格按 §4 的 Phase 0 → Phase 1 顺序，**先交出现状/替换清单/接口契约，用户确认后再进入 Phase 2 代码改造**。
- 所有 Agent 产出须附实际代码/测试证据，禁止以文档描述替代真实实现。
- 底层保留清单（§3.2）中的模块在 Phase 0 审计中须逐项核实调用关系与安全边界。
