# Phase 2 Foundation：现状核查与剩余任务书

> 日期：2026-11-04  
> 项目：DSH-L2D  
> 状态基线：Phase 1 架构提案已完成审阅准备；本文件记录 Foundation 的真实实现状态与剩余工作。  
> 模型分工：前端/架构主导 DSV4.1f；后端 MiMo；模型调试 DSV4.1f；独立验收 GLM。

## 1. 当前实现盘点

本任务书以现有代码核查结果为准，不重复建设已经存在的能力。

| 模块 | 当前状态 | 已有能力 | 缺口 / 本轮目标 |
|---|---|---|---|
| Database Schema | 已存在 | `schema.mjs v3`；动作知识域 10 张表；迁移机制 | 本轮不重写 Schema。仅核对字段、约束、索引与 Phase 1 提案的映射；只有发现明确缺项才提交最小迁移 |
| Actions Lib Repository | 部分存在 | 底层 upsert 原语、`upsertActionChain` | 移除/封锁可覆盖历史 `chain_json` 的语义；补版本不可变、状态机、快照导出、semantic_key 幂等、拒绝留痕、唯一写入口 |
| Task Contract | 部分存在 | bootstrap 域 `tasks` 表 | 对齐任务状态枚举；定义输入/输出 payload Schema；补 workspace/task/trace 关联、错误结构、重试与状态转换规则 |
| Capability Registry | 尚未接线 | 数据源 `tools/w3-registry/registry.json` | 将现有 registry 数据源接入统一读取/校验接口；实现 fail-closed、版本与能力查询；不重复造一份 registry 数据 |
| Ingestion Pipeline G0–G4 | 缺失 | 尚无完整门禁流水线 | 实现按序短路的 G0—G4 校验、拒绝记录、状态流转与 Repository 提交闭环 |

## 2. 本轮实施原则

1. **复用优先**：已存在的 Schema v3、10 张表、迁移机制及 registry.json 均视为现有资产。先适配、再扩展，禁止另起一套平行实现。
2. **唯一事实源**：SQLite 的 `action_chains.chain_json` 是动作链唯一事实源；文件仅为可重建的派生快照。
3. **唯一写入口**：动作链创建、版本化、状态更新、拒绝留痕及快照导出均由 Actions Lib Repository 管理。其他工作区与 MCP 层不得直接写动作链表。
4. **版本不可变**：已有版本的 `chain_json` 不得被 upsert 覆盖。内容修订必须创建新版本；旧版本保留并按状态规则标记。
5. **fail-closed**：Schema、能力注册、模型适配或资源所有权信息缺失时，不得猜测支持；拒绝进入 validated。
6. **真实验收**：未执行的测试不得标记通过；部分实现不得包装成完整功能。

## 3. 剩余任务与执行顺序

### P0-A：Repository 安全与版本语义

**负责人：** MiMo  
**架构审查：** DSV4.1f

实现/修正以下能力：

- `createActionChain(input)`：创建新动作链，禁止覆盖已有版本内容。
- `getActionChain(id, version?)`：读取指定版本；省略版本时按明确、稳定的规则返回当前可用版本。
- `listActionChains(query)`：分页检索。
- `createActionChainVersion(id, input, expectedVersion)`：通过乐观并发检查创建新版本。
- `transitionActionChainStatus(id, version, nextStatus, actor, reason)`：统一状态机入口，拒绝非法转换。
- `exportActionSnapshot(id, version)`：仅允许导出符合规则的版本；写入临时文件、flush/fsync、原子 rename，并记录地址与哈希。
- `recordRejectedAction(input, gate, reason, provenance)`：持久化拒绝记录，不静默丢弃。
- `resolveSemanticKey(semanticKey, contentHash)`：实现幂等判断；同键同内容返回既有结果，同键不同内容进入明确的版本冲突/新版本策略，不得静默覆盖。
- `recordExecutionHistory(...)`：执行历史写入也必须由受控 Repository API 负责。

**必须修复的现存风险：** `upsertActionChain` 当前可覆盖 `chain_json`。不得让该接口继续作为通用更新入口。优先将其收紧为仅允许安全创建/幂等写入，或迁移调用方到明确的 create/version API；保留兼容层时必须拒绝覆盖已有版本内容。

**验收：**
- 同一版本内容不可被覆盖。
- 同 semantic_key、同 hash 的重复提交幂等。
- 同 semantic_key、不同 hash 不会静默覆盖。
- 非法状态转换被拒绝。
- 快照写入失败不会产生伪成功状态。
- 拒绝记录可查询、可追溯。

### P0-B：Task Contract 对齐

**负责人：** MiMo  
**架构审查：** DSV4.1f

复用现有 bootstrap 域 `tasks` 表；先检查其列、索引和现有调用方，再通过兼容迁移/适配层对齐，不得另建平行 tasks 表，除非有代码证据证明现表无法承载。

统一任务契约至少包含：

- `taskId`
- `workspaceId`
- `taskType`
- `traceId`
- `input`（按 taskType 对应 JSON Schema 校验）
- `output`（按 taskType 对应 JSON Schema 校验）
- `status`
- `attempt` / `maxAttempts`
- `error`（稳定的 code、message、retryable、details）
- `createdAt` / `updatedAt`

统一状态至少包含：

- `pending`
- `processing`
- `completed`
- `failed`
- `cancelled`

实施要求：

1. 明确合法状态转换与并发领取规则。
2. 输入输出必须由版本化 Schema 校验。
3. 每个任务关联 workspace、trace 和来源对象。
4. 失败重试必须有次数上限及 retryable 判断。
5. Workspace A（主对话）、B（多模态学习）、C（MCP 调用）通过契约传递业务数据，不共享动作链表写权限。
6. 对旧 tasks 状态值提供显式映射或迁移；未知状态不得静默转换。

**验收：** 三类工作区任务均可创建、领取、完成、失败、取消；非法状态转换、错误 payload、重复领取和超限重试均有测试。

### P0-C：Capability Registry 接线

**负责人：** MiMo  
**调试：** DSV4.1f

数据源使用现有 `tools/w3-registry/registry.json`。先检查其真实结构、版本字段和参数描述，再编写适配器，不得凭空假定字段。

建立稳定接口，至少支持：

- 加载与解析 registry；
- registry schema/version 校验；
- 按模型标识查询能力；
- 按 semantic_key 查询参数能力；
- 参数类型、范围、默认值与操作能力检查；
- 未注册模型/参数/能力时返回明确拒绝结果；
- registry 缺失、损坏或版本不兼容时 fail-closed。

动作链中只保存模型无关的 semantic_key，不得硬编码 `ParamAngleX` 等模型参数 ID。具体参数 ID 由 Model Adapter 在执行期映射。

**验收：**
- 有效 registry 能正确加载。
- 未注册模型和参数明确拒绝。
- registry 文件缺失、JSON 损坏、Schema 不匹配均拒绝放行。
- 参数范围与类型校验有正反例。
- 通用动作链不包含模型专属参数 ID。

### P0-D：Ingestion Pipeline G0—G4

**负责人：** MiMo  
**架构审查：** DSV4.1f  
**独立验收：** GLM

实现顺序固定，失败即短路：

- **G0 完整性与幂等**：输入结构完整、来源可追溯、哈希计算、semantic_key 去重。
- **G1 Schema**：Actions JSON 顶层结构、字段类型、必填字段及版本校验。
- **G2 语义**：步骤关系、动作语义、配对约束（包括 PAIRED_CLOSES）及时间/顺序约束。
- **G3 能力**：调用 Capability Registry 与 Model Adapter 能力描述；未知能力 fail-closed。
- **G4 所有权与资源冲突**：检查参数所有权、并发资源占用及冲突策略。

全部门禁通过后，才可经 Repository 转为 `validated`。任一门禁失败必须通过 Repository 写入拒绝记录，至少保存 gate、reason、provenance、content hash、时间和可诊断上下文。

**禁止：** Pipeline 直接写 `action_chains`；通过默认值掩盖缺失能力；失败后仍导出 validated 快照；把分析候选直接视为已验证动作链。

**验收：** G0—G4 每一门至少有一个通过案例和一个拒绝案例；G2 必须覆盖 PAIRED_CLOSES；G3 必须覆盖 registry 缺失/未知能力；G4 必须覆盖所有权冲突。

## 4. 数据一致性与崩溃恢复要求

SQLite 与文件系统不能组成天然的跨资源 ACID 事务。实现时必须明确采用可恢复提交协议，而不能笼统声称两者原子提交。

建议流程：

1. Repository 创建待提交记录/任务状态。
2. 将快照写入同目录临时文件。
3. flush 并 fsync 文件。
4. 原子 rename 到不可变版本目标路径。
5. 在 SQLite 事务内更新动作链版本、json_address、hash 与状态。
6. 重新核对数据库内容 hash 与文件 hash。
7. 失败时保留可诊断状态，由恢复任务按记录继续、补偿或标记失败。

具体顺序须结合现有 Schema v3 字段与约束确定，并补充进程中断测试。不得覆盖已存在的版本快照。

## 5. 建议执行节奏

按依赖关系推进，不再为已存在的 Schema 安排重复开发：

1. 代码核查与接口冻结：确认 Schema v3、tasks 表、registry.json 的真实字段与调用点。
2. Repository：先封堵覆盖写风险，再补版本、状态机、幂等、拒绝留痕和快照。
3. Task Contract：复用现有 tasks 表并完成兼容映射。
4. Capability Registry：接入现有 registry 数据源。
5. Ingestion Pipeline：串联 G0—G4 与 Repository。
6. 集成测试及 GLM 独立验收。

如果时间受限，优先完成 Repository 的不可变性与唯一写入口；其后依次为 Task Contract、Registry、Pipeline。不得为了完成度数字而降低门禁。

## 6. 跨模块验收清单

### Repository
- [ ] `upsertActionChain` 不再允许覆盖已存在版本的 `chain_json`。
- [ ] 版本创建使用并发保护。
- [ ] 状态机拒绝非法转换。
- [ ] semantic_key 幂等策略有测试。
- [ ] 快照路径、哈希与内容一致。
- [ ] 拒绝记录不可被静默删除。
- [ ] 所有动作链写入调用点均经过 Repository。

### Task Contract
- [ ] 复用现有 tasks 表，无重复事实表。
- [ ] 状态枚举与转换规则统一。
- [ ] input/output Schema 可执行。
- [ ] workspaceId 与 traceId 全链路关联。
- [ ] 重试策略与错误结构可测试。

### Capability Registry
- [ ] 使用现有 registry.json。
- [ ] registry 自身经过 Schema 校验。
- [ ] 未知能力 fail-closed。
- [ ] semantic_key 到模型参数的映射只发生在 Adapter 层。

### Ingestion Pipeline
- [ ] G0—G4 顺序执行且失败短路。
- [ ] PAIRED_CLOSES 配对验证生效。
- [ ] 门禁失败留痕。
- [ ] 只有全部通过才能进入 validated。
- [ ] Pipeline 不直接写动作链表。

### 工程交付
- [ ] 迁移可重复执行且不破坏已有数据。
- [ ] 类型检查/静态检查通过。
- [ ] 核心单元测试通过。
- [ ] 集成测试结果真实记录。
- [ ] GLM 独立验收结论已记录。
- [ ] 未完成项、风险和后续工作明确列出。

## 7. 本轮不在范围内

- 不重写 Schema v3 和已有 10 张动作知识域表。
- 不另建与现有 registry.json 并行的数据源。
- 不重构 Live2D 渲染器或既有动作控制器。
- 不在本轮扩展完整动作编排 UI。
- 不以修改文档代替运行时实现。
- 不直接合并未经测试的运行时代码到主分支。

## 8. 完成定义

Foundation 不以“文件已创建”或“接口名称已出现”为完成标准。

只有当 Repository、Task Contract、Capability Registry、G0—G4 Pipeline 均有真实实现、可执行测试和独立验收记录，才能声明 Phase 2 Foundation 完成。部分完成必须逐项标注，不得整体打勾。

**最终目标：** 在复用 Schema v3、既有 tasks 表与 registry.json 的基础上，建立安全、不可变、可追溯的动作链入库体系，并让三个工作区通过统一任务契约协作。
