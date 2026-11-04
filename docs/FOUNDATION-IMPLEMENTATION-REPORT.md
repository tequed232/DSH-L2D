# Phase 2 Foundation 实施报告

> 执行窗口：2026-11-04 12:51—14:30 · 分工：架构/前端=DSV4.1f，后端实现=MiMo（本会话执行），模型调试=DSV4.1f，独立验收=GLM（子代理，结论见 §F）
> 依据：`docs/architecture/PHASE-2-FOUNDATION-GAP-AND-EXECUTION-PLAN.md`（远端 f3d0965 修订版）+ 七份 Phase 1 提案

---

## A. 完成情况

| 模块 | 状态 | 说明 |
| --- | --- | --- |
| P0-A Actions Lib Repository（语义层） | ✅ **完成** | 新建 `src/actions-repo.mjs`：createActionChain / getActionChain(version) / listActionChains / createActionChainVersion（乐观并发）/ transitionActionChainStatus（状态机+审计）/ exportActionSnapshot（R6 协议）/ recordRejectedAction（R10）/ resolveSemanticKey（R9 幂等）/ recordExecutionHistory。**`upsertActionChain` 覆盖写已封堵**（同内容幂等、异内容拒绝） |
| Schema | ✅ 完成（最小 v4） | 未重写 v3；仅补明确缺项：action_chains 加 `json_address/content_sha256/chain_hash`，action_steps 加 `admission/pairing_json`，tasks 加契约 6 列，新增 `motion_status_log` 审计表 |
| P0-B Task Contract | ✅ 完成 | `src/task-contract.mjs`：**复用既有 tasks 表**（无平行事实表）；契约状态↔DB 状态显式双向映射（未知拒绝）；5 类操作注册 Schema（版本化 v1.0）；原子领取（CLAIM_CONFLICT）；retryable+maxAttempts 重试；错误结构 {code,message,retryable,details} |
| P0-C Capability Registry | ✅ 完成 | `src/capability-registry.mjs`：直读 `tools/w3-registry/registry.json`（不另建数据源）；文档 Schema 自校验；按实测兼容真实数据（min/max 数值字符串、pose 类仅 {id,end}）；checkModel/checkStep fail-closed；paramSemantics 声明即强校验范围 |
| P0-D Ingestion Pipeline | ✅ 完成 | `src/ingestion-pipeline.mjs`：G0 完整性/哈希/幂等 → G1 Schema → G2 语义（R1 参数 ID 否决 + PAIRED_CLOSES 配对）→ G3 能力（fail-closed）→ G4 排他资源占用（配对=单次占用）。按序短路；失败经 Repository 留痕；全过才 validated+快照 |

**未完成 / 明确未做（非缺陷，属 Phase 3/4 范围）**
- Model Adapter 执行期参数映射（Phase 4）——registry 的 controlledParams 已归一化待用。
- MCP 工具层接入新 Repository（Phase 4）——本轮以静态核查证明 MCP 现状无越权写点。
- 未声明 paramSemantics 的语义参数仅做类型检查，范围校验随 Model Adapter 落地（已在代码注释与 §D 声明）。
- Live2D 运行时执行链零改动（用户明确建议，防返工）。

## B. 代码变更

| 文件 | 变更 |
| --- | --- |
| `packages/dsh-l2d-db/src/schema.mjs` | SCHEMA_VERSION 3→4；追加 v4 迁移（加列+motion_status_log，无破坏性 DDL） |
| `packages/dsh-l2d-db/src/repo.mjs` | `upsertActionChain` 收紧：删除 ON CONFLICT 覆盖语义（R8 必修项） |
| `packages/dsh-l2d-db/src/actions-repo.mjs` | **新建**（~430 行）：Repository 语义层，R4/R6/R7/R8/R9/R10 全实现 |
| `packages/dsh-l2d-db/src/task-contract.mjs` | **新建**：P0-B 契约层 |
| `packages/dsh-l2d-db/src/capability-registry.mjs` | **新建**：P0-C registry 适配器 |
| `packages/dsh-l2d-db/src/ingestion-pipeline.mjs` | **新建**：P0-D 门禁流水线 |
| `packages/dsh-l2d-db/src/index.mjs` | 出口追加 Foundation 四模块 |
| `packages/dsh-l2d-db/test/db.test.mjs` | 更新 2 处断言以符合新契约（迁移数 3→4；覆盖写→拒绝） |
| `packages/dsh-l2d-db/test/{actions-repo,task-contract,capability-registry,ingestion-pipeline}.test.mjs` | **新建** 四组测试 |
| `package.json` | `test:db` 接入全部新测试 |
| `docs/FOUNDATION-IMPLEMENTATION-PLAN.md` | 核查结论与实施计划（12:58 产出） |

**关键实现说明**
- R6 提交协议：快照 tmp→fsync→rename→SQLite 事务登记→回读核对（剔除 contentSha256 字段后同口径重算）→失败补偿（删文件+清列）。明确不宣称跨系统 ACID，崩溃恢复锚点为 learning_jobs 状态机。
- R8：action_chains 行只 INSERT；版本号在 motion_definitions 上乐观递增（`WHERE version=expected`，0 行变更即 VERSION_CONFLICT）；旧版本按 (created_at,rowid) 稳定序可读。
- G2 参数 ID 否决：正则 `^(Param*|Part*|Movement\d+)$` + Cubism 标准参数黑名单，深度遍历 params 键与字符串值。

## C. 测试结果（真实执行，14:05 复跑）

| 测试文件 | 断言组 | 结果 |
| --- | --- | --- |
| test/db.test.mjs（回归） | 14 | ✅ 全部通过 |
| test/actions-repo.test.mjs | 14 | ✅ 全部通过 |
| test/task-contract.test.mjs | 11 | ✅ 全部通过 |
| test/capability-registry.test.mjs | 11 | ✅ 全部通过 |
| test/ingestion-pipeline.test.mjs | 20 | ✅ 全部通过 |
| **合计** | **70** | **0 失败** |

覆盖任务书 13 项集成核查：Schema 初始化✓ 迁移幂等✓ Repository CRUD✓ Actions JSON Schema✓ G0–G4 正反例✓ PAIRED_CLOSES（单边/重复角色/顺序颠倒/连续性）✓ 未注册参数拒绝✓ semantic_key 重复入库✓ 不可变版本✓ 文件写入异常（ENOTDIR 注入）✓ 事务回滚（savepoint 机制既有测试+冲突路径）✓ 任务契约 11 项✓ MCP 越权静态核查✓。

## D. 架构核查（自查，GLM 独立结论见 §F）

- 七份提案一致性：✅ R0–R10 逐条落地；G0–G4 顺序与 ACTIONS-JSON-INGESTION-RULES §4 完全一致。
- 已声明偏差（3 项）：①Schema 并入统一注册表库（v3 既有决策，沿用）；②快照目录默认 `data/motions/`（R2 允许配置）；③G4 排他规则 Foundation 版="同能力独立占用>1"，时间重叠精细判定随 Execution Manager（Phase 4）。
- 安全问题：无已知 P0。SQLite 为唯一事实源；唯一写入口经 grep 静态证明；未验证链不可导出快照（R7 有测试）。

## E. GitHub 交付

- 分支：`feat/model-registry`（未合并 main，遵守 §六.10）
- 提交：见 git log（本次 Foundation 实施 + 文档）
- PR：待用户确认后创建（含本报告与回滚说明）；远端 main 的 f3d0965 文档变更已同步至本地工作树

## F. GLM 独立验收结论

（验收子代理运行中，结论回填处）

## G. 后续计划

1. Phase 2 剩余：崩溃恢复注入测试（kill -9 半事务）、Execution Manager 基础接口。
2. Phase 3 前置条件：本 Foundation 验收通过 + 用户确认；图库包到达后接 Motion Learning Workspace。
3. Phase 4：Model Adapter（controlledParams 已归一化）、MCP 工具迁移接线。
