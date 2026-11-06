# Phase 2 — FOUNDATION-IMPLEMENTATION-PLAN.md

> 执行窗口：2026-11-04 12:51—14:30（北京时间）· 分工：架构/前端=DSV4.1f，后端=MiMo，模型调试=DSV4.1f，验收=GLM
> 依据：七份 Phase 1 提案（docs/architecture/*），尤其 ACTIONS-JSON-INGESTION-RULES.md（R0–R10、G0–G4）

---

## 1. 代码库核查结论（12:51—12:58）

- 分支：`feat/model-registry`（领先 origin/main 5 个提交）；未提交变更：skills-toolchain 模块 + docs（属上一任务，保持不动）。
- Node v22.22.2，`node:sqlite` 原生可用（免 better-sqlite3 原生编译）。
- **`packages/dsh-l2d-db`（@dsh/db）已存在**：
  - Schema v3 已含动作知识域全部 10 表（motion_assets / motion_analysis / motion_definitions / action_chains / action_steps / motion_sources / model_capabilities / motion_model_bindings / execution_history / learning_jobs）+ 迁移机制（withTransaction/savepoint/逐版本）。
  - repo.mjs 已有底层幂等原语（upsertMotionAsset/upsertMotionDefinition/upsertActionChain/…）。
- **结论：不新建包、不重建 Schema。在 @dsh/db 上补齐缺失的四层。**

## 2. 现有实现 ↔ 新架构映射表

| 任务书模块 | 现有实现 | 处置 |
| --- | --- | --- |
| Database Schema | `src/schema.mjs` v3 | **保留**；新增 v4 迁移（workspace_tasks 契约表） |
| Actions Lib Repository（底层原语） | `src/repo.mjs` upsert* | **保留**（bootstrap 域继续用） |
| Actions Lib Repository（语义层） | 无 | **新建** `src/actions-repo.mjs`（本任务核心） |
| Task Contract | tasks 表（bootstrap 域，状态枚举不同） | **保留不动**；新建 `src/task-contract.mjs` + v4 `workspace_tasks` 表 |
| Capability Registry | 数据源 `tools/w3-registry/registry.json`（entries[].controlledParams 含 id/min/max/end） | **新建** `src/capability-registry.mjs`（fail-closed） |
| Ingestion Pipeline G0–G4 | 无 | **新建** `src/ingestion-pipeline.mjs` |

## 3. 禁止新增/禁止修改清单

- 禁止修改：`packages/renderer`（ParamInjector/Physics Gate/keyframe-admission 全部不动）、`packages/core`（planner 纯函数不动）、`packages/dsh-l2d-plugin/lib/index.js` 运行时行为、`packages/dsh-l2d-mcp` 旧工具入口。
- 禁止修改 schema.mjs v1–v3 已发布 DDL（只追加 v4）。
- 禁止任何模块绕过 actions-repo 写 `action_chains`/`motion_definitions`/`action_steps`（验收 grep 核查）。
- 禁止模型参数 ID 字面量进入语义动作链（G2 拒绝）。

## 4. 实施顺序与交付物

| 步骤 | 模块 | 交付文件 |
| --- | --- | --- |
| 1 | Actions Lib Repository（语义层，P0 核心） | `src/actions-repo.mjs` + `test/actions-repo.test.mjs` |
| 2 | Schema v4（workspace_tasks） | `src/schema.mjs` 追加 v4 |
| 3 | Task Contract | `src/task-contract.mjs` + `test/task-contract.test.mjs` |
| 4 | Capability Registry | `src/capability-registry.mjs` + `test/capability-registry.test.mjs` |
| 5 | Ingestion Pipeline G0–G4 | `src/ingestion-pipeline.mjs` + `test/ingestion-pipeline.test.mjs` |
| 6 | 集成核查 | 扩展 `test/db.test.mjs` 覆盖 13 项核查清单；`test:db` 接入全部新测试 |
| 7 | 独立验收 | GLM 子代理按 §五 全局验收标准逐项核查 |
| 8 | 交付 | 实施记录 + CHANGELOG + 记忆更新 + PR |

## 5. 关键设计决策（依 ACTIONS-JSON-INGESTION-RULES）

1. **R8 版本不可变**：语义层 Repository 对 `action_chains` 只 INSERT；修订走 `createActionChainVersion`（新 id + version+1 + 旧版 deprecated）。底层 `upsertActionChain` 不再被语义层调用，仅保留给旧 bootstrap 调用方（实际无人调用即标注 deprecated）。
2. **R6 提交顺序**：快照 tmp → fsync → rename → DB 事务 → contentSha256 回读核对；核对失败删快照回滚状态。文件系统与 SQLite 非同一 ACID 域，以"先文件后库 + 回读核对 + learning_jobs 续跑"作为崩溃恢复策略，明确不宣称跨系统原子性。
3. **R7 快照可见性**：仅 `validated` 可导出；`json_address` 存 `motion_definitions` 侧（v3 表无此列，存于 action_chains.validation_report 附带字段 + 快照内容哈希入 chain 元数据）。**偏差记录**：不为单列做 v4 加列，json_address 记入新 v4 表 `motion_snapshots`（chain_id 唯一、content_sha256、path）——保持快照可审计且不动 v3 表。
4. **R4 唯一写入口**：MCP/Runtime 侧本轮零接线，Phase 4 再接；本轮以 grep 测试静态证明 dsh-l2d-mcp 现状无动作链表写点。
5. **Capability Registry fail-closed**：未注册参数键 → G3 拒绝；registry.json 加载失败 → Registry 进入 `unavailable`，G3 全部拒绝（不降级放行）。
6. **Task Contract**：不共用 bootstrap `tasks` 表（状态机不同）；v4 新表 `workspace_tasks`（pending/processing/completed/failed/cancelled + correlation_id + deadline + payload/trace）。payload 必须为结构化对象且通过 operation 注册表 Schema 校验，禁止自由文本承载业务数据。

## 6. 已知限制（本轮不做的）

- 不接 Live2D 运行时执行链（用户明确建议）；不接 MCP 工具改造；多模态分析为外部注入（pipeline 只消费分析结果）。
- `packages/dsh-l2d-plugin` 前端零改动。
