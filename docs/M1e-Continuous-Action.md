# M1-e Continuous Action Mixer（连续动作收敛）

> 状态：已实现（worktree `feat/m1-e-continuous-action`，未合入）
> 任务书：docs/Embodied-Behavior.md §6「Continuous Motion」行 / §8 M1-e 行
> 实现：`packages/core/src/continuous-action.ts`；测试：`packages/core/test/continuous-action.ts`（CA-01…16）

## 1. 目标与非目标

把 Idle / Ambient / Media 三类**连续动作**的决策统一收敛到一个 Mixer——统一优先级、
生命周期、打断与恢复。**不是新增动作系统**：旧调度（ambient.ts / MotionDirector idle 循环 /
stage 媒体律动）全部保留，M1-e 只是在它们与渲染帧之间放一个显式决策层。

非目标：Agent 动作（motion/手势/表情）的调度不变；PhysicsGate（M1-b）让位语义不变；
运行路径本轮不接线（flag 先行注册，消费方由后续批次提供）。

## 2. 五源优先级矩阵

五个来源在同一帧内对同一参数冲突时的裁决顺序（数值越大越强）：

| 来源 | 档位（ActGate） | source 秩（INV-6） | 落点 | 冲突规则 |
|---|---|---|---|---|
| **Agent motion**（动作/手势/表情落地写） | 10 / 50 / 90 | motion 2（keyframes 3 / pose 4 / gaze 5 / limb 6 更高） | WriteIntent → resolveWritePlan | 任意活跃 agent hold 压制整个连续层 |
| **Agent hold**（舞台占用快照） | 10 / 50 / 90 | ——（连续层视角） | 连续层挂起（suspend ≠ kill） | scope 内 lane 的存量条目挂起、新提交拒绝（'agent-held'） |
| **Media**（媒体律动） | 固定 BACKGROUND 10 | continuous 1 / ambient 1（降级后） | lane 秩 3 | 准入即释放 ambient 存量（基线 stopAmbient 语义）；持有期间 ambient 提交拒绝（'media-active'） |
| **Ambient**（事件驱动微动作） | 固定 BACKGROUND 10 | 同上 | lane 秩 2 | 与 idle 并存；参数域重叠处胜出（lane 秩 2 > 1） |
| **Idle**（待机漂移） | 固定 BACKGROUND 10 | 同上 | lane 秩 1 | 最低 lane 秩；重叠参数让位，非重叠参数照常输出 |
| **Physics** | —— | physics 0 | resolveWritePlan 物理兜底 | 最终兜底；limb 独占期间让位（INV-4/5，M1-b 语义不回退） |

三层裁决，从外到内：

1. **连续层内 lane 仲裁**（`resolveContinuous`）：重叠参数 lane 秩高者胜
   （media 3 > ambient 2 > idle 1）；同 lane 内按 id 升序先声明者胜（确定性，顺序无关）。
   空域（如 idle 漂移）不与任何 lane 冲突，可并存。
2. **连续层 → 写计划**：连续层只产出每 lane 每帧的「写声明」，消费方降级为
   `source: 'continuous' | 'ambient'`（INV-6 秩 1）的 WriteIntent 喂 `resolveWritePlan`。
3. **写计划仲裁**（`resolveWritePlan`）：priority desc → source 秩 desc（agent motion 2 >
   连续层 1）→ 同 source 后者；口型禁区 / 所有权 / 相位过滤照常生效。

## 3. 六条硬约束（每条有测试锁定）

| # | 约束 | 实现点 | 测试 |
|---|---|---|---|
| 1 | **不绕过 Mixer/写计划**：连续层永不直接写模型参数 | 本模块只产出写声明；写值必须经 resolveWritePlan 仲裁后落 WriteIntent | CA-12 |
| 2 | **媒体抖动幂等**：同源重复提交 = refresh（无操作刷新）/ update（原地更新），startedAt/runId 永不变 | `submitContinuous` 同源判定 | CA-08（100 连发）、CA-09、CA-10（50 轮 on/off 抖动收敛单条目） |
| 3 | **释放正确**：长期持有（endAt null）必须显式 release；到期（endAt ≤ now，INV-5/S-05 同语义）由 tick/submit 清理；释放后可配冷却窗口（readmitCooldownMs） | `releaseContinuous` / `tickContinuous` | CA-04、CA-11、CA-13 |
| 4 | **PhysicsGate 所有权不回退**：连续层不触碰让位表与 Hip* pre 通道；limb-owned Hip* 写入被拒（not-owned） | 模块零 PhysicsGate 依赖；Hip* 由 resolveWritePlan INV-3 拒绝 | CA-12（第二段） |
| 5 | **Agent 不被低优先级抢占**：连续层整体固定 BACKGROUND 10；agent hold 活跃期间 scope 内条目挂起（保留状态，恢复 ≠ 重启）、新提交拒绝；任何档位（含最低 10）hold 都压制连续层 | `setContinuousAgentHold` / `holdCovers` | CA-06、CA-06b、CA-07 |
| 6 | **待机不回归 / flag 关 = 基线**：`M1E_DEFAULT_ENABLED = false`；关闭时提交全拒（'disabled'）、resolve 恒空、tick/release 空操作、状态零变化 | 全 API `options.enabled` 门控 | CA-01、CA-02 |

## 4. 生命周期状态图

单条连续动作条目的状态机（括号内是触发事件）：

```
                 submitContinuous(id, lane, params)
                              │
              ┌── flag 关 ──→ [disabled]（rejected，零副作用）
              │
              ▼
        ┌───────────┐   hold 设置/scope 收窄   ┌───────────┐
        │  active   │ ───────────────────────→│ suspended │
        │（在场输出）│ ←───────────────────────│（保留状态）│
        └───────────┘   hold 清除/收窄/到期    └───────────┘
         │  │  │        （恢复 ≠ 重启：startedAt/runId 原样）
         │  │  │
         │  │  └─ 同 id 重复提交 ──→ refresh（同参数，只刷 refreshedAt）
         │  │                        update（不同参数，原地换 params）
         │  │                        ——均不离开 active
         │  │
         │  └─ durationMs 用尽（endAt ≤ now，tick/submit 清理）──→ released
         │
         └─ releaseContinuous(selector) ──────────────────────→ released
                                                                 │
                                    冷却窗口内同 id 重提交 ←─────┘
                                    （'cooldown' 拒绝；窗口外/未配置则放行 → active）
```

状态入 `ContinuousState.entries`（active/suspended 由 `resolveContinuous` 每帧纯读判定，
不入 state）；`released` 不是条目状态——释放即出时间线，只留 `releasedAt[id]` 冷却记账
（保留窗口 60s / 最多 32 条，防泄漏）。

Agent hold（`ContinuousAgentHold`）：`null ↔ hold` 二态；hold 带 scope（'all' 或 lane 列表，
支持媒体豁免）、priority（10/50/90）、expiresAt（null = 显式清除前一直持有，到期自动失效）。

## 5. 回滚说明

- **flag**：`embodied.m1e`（renderer `EmbodiedFlags`）+ `M1E_DEFAULT_ENABLED`（core），
  默认 false。关闭 = M1-b 集成后基线，逐行为不变：提交全拒（'disabled'）、resolve 恒空、
  tick/release 空操作、状态零变化（CA-01/02 锁定）。
- **本批零运行路径改动**：渲染帧循环、ambient.ts、MotionDirector、stage 策略全部未动；
  core 新模块只在被显式调用时才有行为。因此回滚 = 停止调用（或 flag 保持 false），无需 revert。
- **若需整体回退**：删除 `packages/core/src/continuous-action.ts`、
  `packages/core/test/continuous-action.ts`、`index.ts` 中的 M1-e 导出块、
  `motion-adapter.ts` 中 `'embodied.m1e'` 字段、`package.json` test:core 链尾追加项、
  本文档即可，无其他耦合点。
- 旧调度是唯一回退落点（任务书「保留旧调度」）：flag 关时 Idle/ambient/media 的决策权
  完全回到现有 tick 循环，本模块不截留任何事件。

## 6. 与 M1-b / M1-c 的兼容性

**M1-b（Hip pre 通道 + PhysicsGate）**：
- 连续层**不触碰** `physicsYield` 登记表与 Hip* pre 通道——模块零 PhysicsGate 依赖；
  Hip* 参数若被连续层（错误地）声明，会在 resolveWritePlan 被 INV-3 拒绝（not-owned，
  CA-12 第二段锁定），物理输出在 limb 独占期间照旧让位（INV-4/5 语义不回退）。
- 连续层写声明降级为 INV-6 秩 1 的 source，永远低于 limb（秩 6）/ Agent motion（秩 2），
  与 M1-b 的「物理让位 + Agent pre 胜出」管线正交。
- flag 组合：`embodied.m1` 与 `embodied.m1e` 独立开关，任意组合行为可预期
  （m1 关 m1e 开：连续层照常运转但不触碰让位表，Hip* 仍由物理驱动）。

**M1-c（Gesture Timeline + 共享仲裁）**：
- 生命周期语义同源：到期清理（endAt ≤ now 即已释放，INV-5/S-05）、稳定排序（INV-8 同型）、
  fail-closed 校验（INV-9 同型）与 gesture-timeline 逐行为对齐。
- 可打断规则同源：连续层固定 BACKGROUND 10，被任意 Agent 动作（NORMAL/FORCE）打断，
  打断 = 挂起（保留状态）而非 kill，与 gesture-timeline 的 ActGate 可打断规则同一份语义。
- 两者并存时仲裁收敛在 resolveWritePlan：手势 = source motion/keyframes（秩 2/3），
  连续层 = source continuous/ambient（秩 1）——同帧同参数手势胜出，无需 M1-e 侧特判。
- 手势时间线（temporal 序列）与连续动作（持续在场）互不管理对方生命周期：
  手势结束（timeline 清理）不隐式恢复连续层，恢复只由 agent hold 解除触发
  （单向控制权，与 CA-06 语义一致）。

## 7. 测试与门禁

- `packages/core/test/continuous-action.ts`：CA-01…16 共 16 用例（node --experimental-strip-types），
  已追加进 `pnpm test:core` 链尾。
- 用例编号对照（验收清单）：
  - CA-01/02 → flag 关 = 基线（回滚）
  - CA-03/03b → Idle × Ambient 仲裁（lane 秩、空域并存）
  - CA-04/05 → Media 启动/刷新/结束、媒体互斥（基线 stopAmbient 语义）
  - CA-06/06b/07 → Agent 打断/恢复、hold 期拒绝
  - CA-08/09/10/11 → 抖动幂等（refresh/update）、高频抖动收敛、冷却窗口
  - CA-12 → 与 M1-b/c 组合（秩仲裁 + Hip* 所有权不回退）
  - CA-13/14 → 到期清理与确定性、fail-closed
- 门禁：`pnpm test:core` exit 0 · `pnpm -F @dsh/renderer build` PASS · `pnpm test:types` PASS。
