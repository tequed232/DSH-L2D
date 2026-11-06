# Phase 1 — ARCHITECTURE.md

> 配套：`docs/DSH-L2D-全量架构替换任务书.md`、`docs/PHASE0-REPOSITORY-AUDIT.md`
> 状态：待用户审阅。本文档确认后，方进入 Phase 2 代码。

---

## 1. 目标架构（总览）

```
┌─────────────────────────────────────────────────────────────────────┐
│  Workspace 1 — Chat Orchestrator  (主对话 / 意图识别 / 调度 / 反馈)      │
│     ├─ 意图识别 + 情绪/动作意图识别                                       │
│     ├─ 向 W2 派发学习任务；向 W3 派发执行任务                              │
│     └─ 接收子工作区结构化结果，管理任务生命周期                            │
└───────────────┬───────────────────────────┬─────────────────────────┘
                │ dispatch(task)             │ dispatch(task)
                ▼                            ▼
┌───────────────────────────┐   ┌───────────────────────────────────────┐
│  Workspace 2 — Motion      │   │  Workspace 3 — MCP Runtime             │
│  Learning                  │   │  (动作检索 / 能力校验 / 执行 / 状态)      │
│  (图库导入 / 多模态分析 /    │   │                                        │
│   动作链生成 / 写入 SQLite)  │   │                                        │
└────────────┬──────────────┘   └───────────────┬───────────────────────┘
             │ 写                                │ 读/执行
             ▼                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Shared Infrastructure（独立于三工作区）                                  │
│   Actions Lib Repository · Database Service(actions-lib.sqlite)        │
│   Capability Registry · Model Adapter · MCP Gateway                    │
│   Execution Manager · Motion Provenance · Learning Queue · Task Event Bus│
│   Live2D Renderer（Cubism Renderer → ParamInjector → Physics Output Gate）│
└─────────────────────────────────────────────────────────────────────┘
```

三个工作区均**独立 Agent / 独立进程上下文**，通过 `WorkspaceTaskContract`（§4 通信协议）结构化消息通信，不互相用自然语言转述。

---

## 2. 与现有仓库的映射（关键设计决策）

> 审计证明：新系统不是从零新建，而是**复用/迁移**现有底座。下列决策直接回应 Phase 0 发现。

| 新架构模块 | 复用/迁移自 | 决策依据 |
| --- | --- | --- |
| **Capability Registry（动态）** | `tools/w3-registry/registry.json` + `tools/w3-registry/build.mjs` + `tools/w3-registry/validate.mjs` | 已是"能力 id → 参数/冲突/前置/恢复"结构化声明，且覆盖各原子能力；直接作为数据底座，**不新建空壳** |
| **Model Adapter（语义→参数）** | `l2d_posture` 的 `planPostureExecution`（`overlay.js:4044`）+ `core/src/semantic-binding.ts` + `core/src/motion-profile.ts` | `l2d_posture` 已是"语义通道→参数 id"范本；core 已实现动态能力画像，须**接线进运行时** |
| **Execution Manager** | `act-result.mjs`（outcome 聚合）+ `action-sequence.mjs`（段执行 + replanRequired）+ `motion-director.ts`（互斥） | 复用回执聚合与段调度语义；成为唯一执行入口 |
| **唯一参数写入边界** | `param-injector.ts`（单例 `index.ts:65`）+ **`writeParam`(`index.ts:1571`)** | **必须一并接管层 B（外部指令）+ 层 C（视线直写）**，保留 min-max 钳制与口型红线（CRITICAL-1） |
| **Physics Output Gate** | `physics-yield.ts` + `cubismphysics.ts:666-671/742-747` + `motion-adapter.ts:236` | 三处**绝不可删**；新系统回滚/休眠仍受 `embodied.m1` flag 控制（CRITICAL-2） |
| **取消/中断** | `resetPerformance`(`index.ts:1840`) + `motionEpoch` + `host-guard.guardAiCall` | 新系统须复刻"纪元递增 + releaseAll + bridge.stop"（CRITICAL-3） |
| **Actions Lib（SQLite）** | 全新（仓库当前无任何 DB） | 新建 `actions-lib.sqlite`；与现有 JSON 持久化（settings/persona/env-state）边界隔离 |
| **MCP Gateway** | `packages/dsh-l2d-mcp`（转发壳）+ `host-guard` | 保留转发与纵深防御，工具集合重新设计 |

---

## 3. 三个工作区的物理落地（建议）

- **Workspace 1 — Chat Orchestrator**：新模块，承载意图识别与调度。可落在 `packages/dsh-l2d-plugin` 的 `workspace-agent` 演进方向，或独立服务；协调 W2/W3。
- **Workspace 2 — Motion Learning**：新模块（多模态分析 + 学习流程）。多模态分析调用外部多模态模型；动作链生成复用 `core/src` 的 planner 纯函数；落库走 Actions Lib Repository。
- **Workspace 3 — MCP Runtime**：演进 `packages/dsh-l2d-mcp` + `packages/dsh-l2d-plugin` 的执行编排，移除 `l2d_choreograph` 固定预设，改为检索 + 校验 + Execution Manager。
- **Shared Infra**：Repository/DB/Capability Registry/Model Adapter/Execution Manager 作为 `packages/core` 与新建 `packages/dsh-l2d-*` 的共享层；Renderer 侧（`param-injector`/`writeParam`/Physics Gate）保持不变并审计接入。

> **不长期并行两套动作执行架构**：Phase 6 切换运行时入口、迁移历史数据、清除旧动作系统运行时依赖后，旧 `l2d_choreograph`/固定 CHOREOGRAPHY 决策路径必须关闭。

---

## 4. 通信协议（Workspace Task Contract）

所有跨工作区消息统一结构（沿用任务书 §4，并修正状态枚举口径）：

```ts
type WorkspaceId = "chat" | "learning" | "runtime";
type TaskStatus =
  | "queued" | "running" | "accepted"
  | "completed" | "rejected" | "interrupted" | "failed" | "timeout";

interface WorkspaceTask<T = unknown> {
  taskId: string; correlationId: string;
  source: WorkspaceId; target: WorkspaceId;
  operation: string; payload: T;
  createdAt: number; deadline?: number;
}
interface WorkspaceResult<T = unknown> {
  taskId: string; status: TaskStatus;
  data?: T; error?: { code: string; message: string; reason?: string };
}
```

**长任务状态查询**：`accepted` 不代表完成；Chat Orchestrator 须轮询 `motion_learning_status` / `motion_execution_status`，直至 `completed`/`failed`/`timeout`，不得把 `accepted` 伪装为 `completed`。

---

## 5. 状态枚举对齐（旧 → 新）

| 旧运行时 | 新 TaskStatus | 备注 |
| --- | --- | --- |
| action-done `start`/`end`/`interrupted` | `running`/`completed`/`interrupted` | 事件相位 |
| outcome `rejected` | `rejected` | 校验失败 |
| outcome `pending`（未收敛） | `running`/`timeout` | 超时未收敛 → `timeout` |
| `accepted`（已受理未完） | `accepted` | 轮询中 |

`act-result.mjs` 的 `mergeActEvents`/`actOutcome`/`shapeActReceipt` 可直接作为 Execution Manager 的状态归并起点。

---

## 6. 风险与未决项（Phase 1 须回答）

1. **context-analyzer 调用方**：`analyzeContext`/`SITUATIONS` 运行时调用方本轮未确认，Phase 2 前补检索，确认其是否仍在运行时链路。
2. **core 接线成本**：把 `@dsh-l2d/core` 引入 plugin/renderer 的构建体积与依赖成本需评估（R5）。
3. **Capability Registry 运行时加载**：`registry.json`/`profile.*.json` 当前仅构建/测试期消费；须设计运行时加载 + fail-closed 基线（R1/R2/R6）。
4. **多模态模型不能直接生成可靠 Live2D 动作**：须经 Model Adapter 映射（任务书 §6 踩坑点 1）。
5. **图库含 GIF/视频/连续帧**：须保留时间顺序与动作阶段（任务书 §6 踩坑点 2）。
