# Phase 1 — MIGRATION-PLAN.md

> 配套：`docs/PHASE0-REPOSITORY-AUDIT.md`、`docs/architecture/ARCHITECTURE.md`
> 状态：待用户审阅。

---

## 1. 迁移总原则（任务书 §0 / §5）

1. **先审计、先方案、后改造**：本计划建立在 Phase 0 审计之上，不凭文件名推断。
2. **新旧不长期并行**：Phase 6 切换运行时入口、迁移历史数据、清除旧动作系统运行时依赖。
3. **底层保护**：Cubism Renderer / ParamInjector / Physics Output Gate / 必要安全机制不得误删（呼应 CRITICAL-1/2/3）。
4. **删除 = 删运行时依赖，非无条件删源文件**：旧实现先归档 → 迁移数据 → 确认无调用方 → 再清理。
5. **不建空壳**：Capability Registry / Model Adapter 复用现有 `tools/w3-registry` 与 `packages/core`，不从零新建。

---

## 2. 旧模块迁移表（逐模块处置）

| 旧模块 | 处置 | 说明 / 风险呼应 |
| --- | --- | --- |
| `choreography.mjs`（CHOREOGRAPHY/decide/aggregateWorkspaceState/validateStep/白名单） | **替换 + 归档** | 决策/编排/知识存储整体迁出；运行时依赖在 Phase 6 关闭；源文件先归档保留 |
| `ACT_PHASE_TEMPLATES` 模板数据 | **迁移为数据** | 转入 `action_steps`（数据驱动），`getActPhaseTemplate` 查找函数保留复用 |
| `l2d_choreograph` 工具 | **替换** | 移除固定预设；检索 + 校验 + Execution Manager |
| `executeActionSequence` 上层编排 | **替换（逻辑参考）** | 顺序段 + replanRequired 语义进新 Orchestrator |
| `workspace-agent` 决策触发 | **替换** | 新 Chat Orchestrator 意图识别；先确认 `context-analyzer` 调用方 |
| `validate.mjs` + `host-guard` 静态白名单 | **逻辑下沉 / 数据动态化** | 保留 param-guards 口型红线 + 范围检查；数据改读 registry（R1-R3） |
| `context-analyzer.mjs` | **重写/取代** | 由新意图识别取代；Phase 2 前补调用方检索 |
| `l2d_set_pose`/`l2d_gaze`/`l2d_get_state`/`l2d_posture` | **保留为原子** | 经 Model Adapter 暴露；`l2d_posture.planPostureExecution` 作范本 |
| `l2d_act` 执行通道 | **复用** | "投递链 + action-done" → `modelAdapter.runActPlan` |
| `registry.json` | **晋升为运行时数据源** | 从构建/测试期 → 运行时加载（R1/R2/R6） |
| `capability-scan` / `motion-profile` / `semantic-binding` | **接线进运行时** | 消除"数据有、决策仍硬编码"（R5） |

---

## 3. 防误删执行清单（Phase 2/6 必须核对）

- [ ] **CRITICAL-1**：替换 ParamInjector 时一并接管 `writeParam`(`index.ts:1571`) / `applyGazeBody` / `applyGazeEyes`；保留 min-max 钳制与口型红线。
- [ ] **CRITICAL-2**：保留 `physics-yield.ts` 与 `cubismphysics.ts:666-671`、`cubismphysics.ts:742-747` 两处消费点 + `motion-adapter.ts:236` 控制面。
- [ ] **CRITICAL-3**：新系统的 reset/cancel 复刻 `resetPerformance`(`index.ts:1840`) 的"纪元递增 + injector.releaseAll/clear/unlock + bridge.stop"。
- [ ] `param-ownership.ts`、`host-guard.guardAiCall`、`param-guards.mjs` 保留（纵深防御）。
- [ ] `motion-director.ts`（互斥）、`ActGate`/`canInterruptAct`（优先级）保留并重构调度规则（旧 `BACKGROUND<NORMAL<FORCE` 不作默认沿用）。

---

## 4. 分阶段执行（任务书 §11）

| Phase | 目标 | 关键交付 | 权限边界 |
| --- | --- | --- | --- |
| 0 | 只读审计 | PHASE0-REPOSITORY-AUDIT.md | 不改运行时代码 |
| 1 | 架构提案 | 本目录 6 份文档 | 待用户审阅 |
| 2 | 基础层 | Schema、Repository、Workspace Task Contract、Capability Registry 运行时加载、Execution Manager 基础接口 | 仅新增/接线，不改旧运行时入口 |
| 3 | Motion Learning | 图库导入、多模态分析、动作链生成、SQLite 存储 | 新增模块，不动旧执行链路 |
| 4 | MCP Runtime | 检索、模型校验、执行、状态反馈 | 新增工具，旧工具保留至 Phase 6 |
| 5 | Chat Orchestrator | 主对话与 W2/W3 调度集成 | 新增编排 |
| 6 | Legacy Replacement | 切换运行时入口、迁移历史数据、清除旧动作系统运行时依赖 | **用户确认后**关闭 `l2d_choreograph`/固定决策 |
| 7 | Integration & E2E | 端到端测试 + 验收报告 | 形成 5 份验收报告 |

---

## 5. 历史数据迁移

- 旧"动作知识"是硬编码常量，无历史 DB 数据可迁；迁移对象是**代码常量 → SQLite 数据**（MODEL_EXPRESSIONS/MODEL_MOTION_GROUPS 可作为初始 `model_capabilities` 基线 + fail-closed 兜底）。
- 现有 JSON 持久化（settings/persona/env-state/reverse-log）**不迁移**，保持独立。
- `registry.json` → `model_capabilities` 可一次性镜像载入。

---

## 6. 回滚方案

- 所有新模块经 feature flag 或独立分支隔离；Phase 6 前旧链路完整保留。
- Physics Gate 回滚：`embodied.m1` 置 false 即回到现行为（设计约束）。
- 参数写入回滚：保留旧 `injector.*` 调用点兼容层，新实现签名须与旧一致。
- 最终仅提交一个完整架构替换 PR，含回滚说明（任务书 §12）。
