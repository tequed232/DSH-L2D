# Phase 0 — Repository Audit（只读审计）

> 配套任务书：`docs/DSH-L2D-全量架构替换任务书.md`
> 性质：只读审计，未修改任何运行时代码。
> 结论来源：5 个并行只读审计子代理，全部基于实际文件路径与行号；无任何臆测。

---

## 0. 一句话结论

旧动作系统**不是**一套"数据库 + 语义检索"的架构，而是一套**硬编码常量 + 固定预设表 + 薄壳 MCP 转发**的架构。其"动作知识库"就是 `choreography.mjs` 里的数组常量，其"检索"只是 `CHOREOGRAPHY[state]` 查表 + 白名单校验。新系统的 SQLite / Actions Lib / 语义检索**确实是全新建设**；但**动态能力画像与仲裁底座已经存在**（`tools/w3-registry` + `packages/core` 的数据驱动仲裁），应迁移复用而非从零新建，以遵守任务书"禁止空壳模块"的要求。

---

## 1. 运行时包拓扑（先建立心智模型）

| 包 | 角色 | 关键事实 |
| --- | --- | --- |
| `packages/renderer` | 浏览器内 Live2D 渲染内核（`window.DSH_L2D`） | Cubism 5 Web SDK 的 vendored 实现（`fw/`）+ 应用层参数守卫；经 `vite build` 产出 `assets/renderer.js`，由插件静态托管 |
| `packages/dsh-l2d-plugin` | DSH 宿主插件（Node 侧） | 注入叠加层 `overlay.js`；挂载 `/dsh-l2d/*` HTTP 路由；AI 指令队列 `ai-inbox`；模型索引缓存与入参守卫 `host-guard`；戳一戳编排 `choreography`；工作区/会话感知 |
| `packages/dsh-l2d-mcp` | stdio MCP 薄壳 | 把 MCP 工具调用转发到本机 `http://127.0.0.1:<port>/dsh-l2d/ai/call`，再轮询 `/ai/result` |
| `packages/core` | 纯 TS 逻辑内核 | **无 `package.json`，不被 pnpm 视为独立包**，被 renderer/测试按源码路径直接 import；含所有权仲裁、共享通道仲裁、motion 契约/画像/意图、连续动作 Mixer、手势时间线、Embodied Cue |
| `apps/stage-web` | 独立"角色舞台"前端 | Vue 3 + Vite，**仅开发/预览用**，不是生产叠加路径 |

**关键链路**：`MCP 工具 → plugin /ai/call（host-guard 守卫）→ ai-inbox 队列 → overlay.exec(name,args) → window.DSH_L2D.* 渲染 API`。真实能力面在 `overlay.js` 的 `exec()` 及各 `L.*` 渲染方法。

---

## 2. 旧系统依赖图（动作编排链路）

```
链路 A — l2d_choreograph 预设触发（MCP → 宿主 → 渲染）
  server.mjs:l2d_choreograph(277-326)
    ├─ CHOREOGRAPHY[presetState]            ← choreography.mjs:133（知识 + 决策）
    ├─ validateActionSequence               ← action-sequence.mjs:6（复用 validateStep/estimateLifeMs）
    └─ executeActionSequence(plan, forward('l2d_act'))
          └─ forward → /dsh-l2d/ai/call → host-guard.guardAiCall/checkActChain
                └─ overlay.executePokeAction(1949)
                      ├─ resolveActChain → L.actPhaseTemplate  ← action-chain.ts:178（phase 知识）
                      └─ L.admitAct → renderer.admitAct(619) → actGate.admit ← action-chain.ts:291（状态机）
                            └─ playMotionAsync(1380) → motionDirector.decide/commit ← motion-director.ts（互斥状态机）

链路 B — workspace-agent 决策触发（插件 → 专属 Agent → MCP）
  index.js:1672 createWorkspaceAgentBridge → workspace-agent.mjs decideNotification(186)
    ├─ aggregateWorkspaceState              ← choreography.mjs:293（决策/聚合）
    └─ decide                               ← choreography.mjs:363（决策核心：抖动/冷却/频次）
          └─ 若 fire → 提示 Agent 调 mcp__dsh_l2d__l2d_choreograph → 链路 A
```

---

## 3. 模块清单：替换 vs 复用（对应任务书 §3.1 / §3.2）

### 3.1 ❌ 必须整体替换（决策 / 编排 / 知识存储）

| 模块 | 位置 | 在旧系统职责 | 替换去向 |
| --- | --- | --- | --- |
| `choreography.mjs` 全文件 | plugin/lib | CHOREOGRAPHY 预设、decide、aggregateWorkspaceState、validateStep、MODEL_EXPRESSIONS/MODEL_MOTION_GROUPS/PAIRED_CLOSES/USER_DIRECT_PHASES/DEFAULT_GATE | Actions Lib + 动态决策/编排 + Capability Registry |
| `ACT_PHASE_TEMPLATES` 模板数据 | core/src/action-chain.ts:49 | 固定四段短链（聆听/思考/说话/收尾） | 数据驱动的 Action Steps |
| `l2d_choreograph` 工具 | mcp/src/server.mjs:277 | 固定"状态→预设链"硬编码 | 新决策/编排服务 |
| `executeActionSequence` 上层编排 | mcp/src/action-sequence.mjs:30 | 顺序段执行 + replanRequired | 新 Orchestrator（逻辑参考，可复用） |
| `workspace-agent` 决策触发 | plugin/lib/workspace-agent.mjs | decideNotification + bridge | 新 Chat Orchestrator 意图识别 |
| `validate.mjs` + `host-guard` 静态白名单校验 | mcp/src/validate.mjs, plugin/lib/host-guard.mjs | 静态表情/动作组白名单、validateStep | 逻辑下沉、数据改动态（**保留 param-guards 口型红线 + 范围检查**） |
| `context-analyzer.mjs` 情境判定 | plugin/lib | 14 种 SITUATION 推断（决策输入） | 新意图识别（**其运行时调用方本轮未确认，Phase 1 前需补检索**） |
| 旧 MCP 动作工具集合 | mcp/src/server.mjs | l2d_choreograph/l2d_act 等 | 重新设计（见 §4 映射） |

### 3.2 ✅ 保留并复用（底层能力，不得误删）

| 模块 | 位置 | 新系统角色 |
| --- | --- | --- |
| `motion-director.ts` | renderer/src/app | 成对动作状态机 / 手臂冲突仲裁 → 保留（动作互斥管理） |
| `ActGate` / `canInterruptAct` | core/src/action-chain.ts:120/108 | 单槽优先级门闩 → 保留并重新定义调度规则 |
| `act-result.mjs` | mcp/src | action-done → outcome 回执聚合 → 进新 Execution Manager |
| `chain-normalize.ts` | core/src | 并行组归一化（纯函数）→ 复用 |
| `write-plan` / `limb-controller` / `shared-arbitration` / `continuous-action` / `gesture-timeline` | core/src | 参数所有权/共享通道/连续动作/手势 → 保留并审计 |
| `semantic-binding` / `motion-profile` / `motion-contract` / `motion-intent` | core/src | **动态能力画像与契约底座** → 迁移为新 Capability Registry / Model Adapter（不要从零新建） |
| `overlay.executePokeAction` / `playbackAct` | plugin/lib/overlay.js | 宿主执行驱动 → 复用为底层执行 |
| `param-injector.ts` + `index.ts:65` 单例 | renderer/src/app | **唯一外部指令写入通道** → 保留（见 §5 防误删警示） |
| `physics-yield.ts` + `cubismphysics.ts:666-671/742-747` | renderer/src/fw/physics | **物理输出让位门数据面 + 消费点** → 保留（默认休眠，但绝不能删） |
| `host-guard.guardAiCall` + `param-guards.mjs` | plugin/lib | 入队前纵深防御（口型红线、物理输出需 own）→ 保留 |
| `resetPerformance`（`index.ts:1840`） | renderer/src/app | 取消彻底性（纪元递增 + releaseAll）→ 新系统须复刻 |

---

## 4. 旧 MCP 工具 → 新系统设计 映射

| 旧工具 | 分类 | 新系统设计 |
| --- | --- | --- |
| `l2d_set_pose` | 底层原子 | `modelAdapter.setPose()` |
| `l2d_gaze` | 底层原子 | `modelAdapter.setGaze()` |
| `l2d_get_state` | 底层只读原子 | `modelAdapter.getState()` |
| `l2d_posture` | 底层原子（含语义→参数映射） | `modelAdapter.setPosture(values)` —— **其 `planPostureExecution` 是新 Model Adapter 的标准范本** |
| `l2d_act` | 决策/编排入口 | 其"按 chain 投递 + 收 action-done"通道 → `modelAdapter.runActPlan(chain,{priority,phase})`；决策部分替换 |
| `l2d_choreograph` | 决策/编排入口 | 上移到新决策/编排服务，不再作为 MCP 硬编码 |
| `executeActionSequence` | 编排执行器 | 顺序段 + replanRequired 逻辑 → 新编排器参考实现 |
| `validate.mjs`（MCP） | 静态校验 | 校验*逻辑*保留（白名单/口型红线/Idle 禁播），*数据*改读 `registry.json`/`capability.json` |
| `registry.json` | 能力数据源 | **直接作为新动态 Capability Registry 数据底座** |
| `validate.mjs`（w3） | 注册表校验器 | 作为新系统 CI 守门人（保证"声明=模型事实"） |

---

## 5. 防误删关键边界（最高优先级）

1. **CRITICAL-1 — ParamInjector 并非绝对唯一写入通道**：它对"外部/AI 指令（层 B）"是唯一的，但 (a) Cubism SDK 原生逐帧写入（motion/expression/breath/physics）本就不经它（设计如此，位于应用边界之下）；(b) **视线子系统 `writeParam`（`index.ts:1571`）直接 `core.setParameterValueById`**，不经 ParamInjector 的口型红线/min-max 钳制，只写 AngleX/Y/LeanInput/ParamEyeBallX/Y。替换 ParamInjector 时必须**同时接管 `writeParam`/`applyGazeBody`/`applyGazeEyes`**，否则头部/眼球/身体倾斜注视失效且失去钳制保护。
2. **CRITICAL-2 — Physics Output Gate 活性在 SDK 内部**：冲突防护真正生效点在 `cubismphysics.ts:666-671` 与 `:742-747` 对 `physicsYield.ids` 的跳过。`physics-yield.ts` 与这两处消费点**绝不可删**——它们是 Agent 占用物理输出时"不被物理覆盖"的硬保证。整个门受 `embodied.m1` flag 控制（默认 false=空操作），回滚置 false 即可。
3. **CRITICAL-3 — 取消彻底性依赖 motionEpoch + releaseAll**：任何新动作系统的 reset/cancel 必须复刻 `resetPerformance`（`index.ts:1840`）的"递增纪元 + injector.releaseAll/clear/unlock + 各 bridge.stop"组合，否则会出现真机已记载的"reset 后竖手指残留"缺陷（`index.ts:1833-1839`）。

---

## 6. 数据迁移风险清单（迁移到动态能力画像）

- **R1（高）静态基线 fallback 缺失**：`host-guard.expressionSet/motionGroupSet` 保证"model3 索引读不到时静态名单仍生效"。动态迁移后须保留一份冻结基线作 fail-closed 兜底。
- **R2（高）数据源收敛**：同一表情/动作组名单有**三处内存副本**（`choreography.MODEL_EXPRESSIONS`、`validate.ALLOWED_EXPRESSIONS`、`host-guard.STATIC_EXPRESSIONS`）+ 测试硬编码 `length===21/6`。须收敛为单一加载源并同步更新断言。
- **R3（高）安全红线不可动态化**：口型 `LIPSYNC_PARAMS` 注释明确 fail-closed、不依赖模型文件，迁移时须作为"始终生效的静态硬约束"。
- **R4（中）开→关配对语义**：`PAIRED_CLOSES` 表达成对动作的关闭关系，registry 现有条目仅用 `composable`/`conflicts` 描述互斥，不含显式 open→close 映射，迁移需补齐或保留派生逻辑。
- **R5（中）core 未接线**：`@dsh-l2d/core` 的 `shared-arbitration`/`semantic-binding` 已实现"零通道名、全数据驱动"仲裁，但运行时三包均不依赖它。若只替换白名单而不接线，会留下"数据有了、决策仍硬编码"的半迁移状态。
- **R6（中）Idle 与未登记资产**：registry 的 `excluded`/`unregisteredAssets` 明确"存在但未登记=不可用"，须运行时 fail-closed 消费。
- **R7（低）schemaVersion 演进**：registry `schemaVersion:1`，动态加载器须做版本协商。
- **R8（低）性能/缓存**：动态 profile 加载需缓存与失效策略。
- **R9（低）测试覆盖锁定**：`validate.test.mjs`/`host-guard-act.test.mjs` 对静态行为有大量断言，迁移后应改为"基于加载的 profile 断言行为等价"。

---

## 7. 测试缺口（动作系统相关，目前缺测试）

| 缺口 | 位置 | 风险 |
| --- | --- | --- |
| `param-injector.ts` 无独立测试 | renderer/src/app | 参数写入中央守卫，最接近生产故障面 |
| `pose-controller.ts` 无专门测试 | renderer/src/app | 四肢姿势控制 |
| `motion-director.ts` 仅部分覆盖 | renderer/src/app | 成对动作状态机决策矩阵 |
| `index.ts` 运行期编排无集成测试 | renderer/src/app | `playKeyframes`/`resetPerformance`/`admitAct` 最复杂路径 |
| 宿主 HTTP 路由无直接测试 | plugin/lib/index.js | cross-site/loopback 栅栏、body 限流、sanitize |
| `reverse-log.mjs` 无测试 | plugin/lib | 事件环形缓冲/原子落盘 |
| settings 一次性迁移无测试 | plugin/lib/index.js | `eyeFollow`/`apiKey` 脏值归一化 |
| `emotion-router.ts` 仅测 error 回归 | renderer/src/app | 完整路由规则未覆盖 |

> 已有强覆盖：core 纯逻辑（action-chain/chain-normalize/gesture-timeline/continuous-action/embodied-cue/cue-loop/shared-arbitration/ownership-invariants）、各守卫（param-guards/host-guard/keyframe-admission/physics-gate/validate）、编排预设（choreography）、MCP 序列（action-sequence/act-result）。

---

## 8. 给 Phase 1 的关键决策输入

1. **Capability Registry 不新建空壳**：直接采用 `tools/w3-registry/registry.json` 作为数据底座，把 `core` 的数据驱动仲裁**接线进运行时**，替代 `MODEL_EXPRESSIONS`/`MODEL_MOTION_GROUPS` 静态常量（收敛单一数据源 + fail-closed 基线）。
2. **ParamInjector 与 writeParam 一并接管**：新参数写入边界须覆盖层 B（外部指令）+ 层 C（视线直写），并保留 min-max 钳制与口型红线。
3. **Physics Output Gate 三处不可删**：`physics-yield.ts` + `cubismphysics.ts` 两处消费 + `motion-adapter.ts` 控制面。
4. **状态枚举不对齐**：旧 `action-done` 三相位 + `outcome(completed/interrupted/rejected/pending)` 与任务书 `TaskStatus` 口径不同；新 Execution Manager 需做映射，`act-result.mjs` 可作起点。
5. **context-analyzer 调用方待确认**：Phase 1 前补一次 `analyzeContext`/`SITUATIONS` 调用方检索。
6. **SQLite 是全新层**：仓库当前无任何 SQLite/DB，仅有 JSON 文件持久化（settings/persona/env-state/reverse-log）；新建 `actions-lib.sqlite` 不冲突，但须设计好与现有 JSON 持久化的边界。
