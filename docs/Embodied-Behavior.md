# Embodied Behavior 契约（M1 起生效）

> 状态：M0 评审通过，用户拍板 4 点 + M1 分工确认。本文件是**实现契约**，不是设计提案：
> 渲染层（`packages/renderer/**`）、宿主层（`packages/dsh-l2d-plugin/lib/index.js`）、
> MCP 层（`packages/dsh-l2d-mcp/**`）在 M1 及以后都必须遵守这里的语义。
>
> 基线：main `fa0f5e3`。M0 审计数据：`model-audit.json`（509 参数 / 292 物理输出 /
> 7 动作组 / 21 表情 / 131 组物理）。可执行规格：`tools/ownership-spec/`。

## 0. 范围与拍板

**范围（M1）**：参数所有权（physics / limb / pose / motion / keyframes / continuous）、
每帧写计划仲裁（唯一 winner）、ActGate 优先级、释放规则、口型与物理输出守卫、MCP/host 参数白名单。

**非目标**：不重写 `overlay.js`；不重复 L1（Persona / 环境感知 / Planner），只在「规划 → 动作」
接口处消费其输出；不改 Cubism SDK 内核。

**今天拍板的四条**（已写入契约）：

1. **Hip* 让位分两步**：M1-a 先做 20 个叶子四肢的 post 覆盖（零影响、可回滚）；
   M1-b 再做 `HipAngleX/Y/Z` 的 pre 通道 + PhysicsGate（16 个生产者设置跳过输出）。
   不接受「次级链不跟随」作为终态。
2. **守卫统一**：`l2d_set_parameters` 与 keyframes 一致——物理输出仅 `own:true` 放行；
   口型参数任何通道、任何 owner 都永不放行。保留内部诊断口（不进公开工具面）。
3. **runId 绑定 + 打断即释放**：ActGate 返回 interrupted / priority-blocked / action-done 终态时，
   立刻释放该 runId 的独占；超时只作最后保险，不作为主路径。
4. **不重复 L1**：Persona / env / Planner 的输出只作为规划上下文消费，M1 不重建。

## 1. 帧序（权威，不可变）

```
每帧（lappmodel.ts:632-690）
1. loadParameters()                    恢复上一帧 save 的基底
2. MotionManager：Idle(priority1) 自动重启 / 当前动作 updateMotion（写曲线，fade）
3. saveParameters()
4. pre 钩子（index.ts:327-335）
     applyGazeBody（AngleX/Y 直写 add；angleBus.PositionX.gaze；LeanInput 直写）
     flushAngleBus（mixAdditive：body40 > gaze35 > ambient20 > media10；cap AngleZ15/PositionX10/PositionY10）
     injector.apply('pre')             只放 add 型（Angle/Position/Lean/Movement*）
     [M1] limb-owned Hip* 的 pre 写（仅 HipAngleX/Y/Z，且生产者设置当帧让位）
5. UpdateScheduler（icubismupdater.ts:23-30）
     200 EyeBlink → 300 Expression → 400 Drag → 500 Breath
     → 600 Physics（131 settings，按依赖序 evaluate）
     → 700 LipSync（运行期未启用）→ 800 Pose
6. post 钩子（index.ts:336-345）
     kfTick（keyframes → injector.set）
     poseController.update（!poseOwnedByMotion 时）
     applyAmbientFace（CheeckPuff/Mouthpucker）
     injector.apply('post')            只放 set 型；[M1] limb-owned 叶子四肢 post 覆盖
     applyGazeEyes（ParamEyeBallX/Y 直写）
7. model.update()（deformer / 绘制）
```

**相位归属（写死）**：给物理当输入的参数必须 `pre` 写；被物理/表情/姿势覆盖的 set 型参数必须 `post` 写。
`pre` 写 set 型会被物理覆盖；`post` 写物理输入会让物理晚一帧才响应。

## 2. 术语与不变量摘要

| 术语 | 含义 |
|---|---|
| owner | 某参数当前唯一写者：`physics`/`limb`/`pose`/`motion`/`keyframes`/`continuous`/`gaze`/`ambient` |
| acquire / release | 显式取得/放弃独占；成功后 owner 从 physics 切换，释放后回 physics |
| phase | `pre`（saveParameters 后、物理前）/ `post`（Pose800 后、model.update 前） |
| intent | `{id, source, priority, phase?, params, runId?}`；写相位以 intent.phase 为准 |
| winner | `resolveWritePlan` 为某参数选出的唯一写者与值 |
| ownership 条目 | `{owner, runId?, expiresAt?, phase}`；`phase` 是参数族默认相位（叶子四肢 `post`；Hip* `pre`，M1-b），由 acquire 方写入 |
| ActGate | BACKGROUND 10 < NORMAL 50 < FORCE 90；低不打断高、同级可 |

**相位解析（ownership.phase 与 intent.phase）**：每帧有效写相位 = `WriteIntent.phase`（提供即权威）→ 否则 `ownership[id].phase`（仅独占时）→ 否则参数族默认（Hip* 与 add 型物理输入 `pre`，其余 `post`）。`ownership.phase` 只是 acquire 时按参数族写入的默认值，**不能**用来绕过参数族的相位约束（叶子四肢必须是 post，Hip* 必须是 pre）；两者冲突时按错误处理（wrong-phase）。

**核心不变量**（完整列表与用例见 `docs/Ownership-Invariants.md`）：
每参数每帧唯一 winner；口型永不可写；物理输出仅 limb-owned 可写；pre/post 相位按参数族；
同优先级按 source 秩；输出与 intent 顺序无关；空帧无副作用。

## 3. 参数所有权矩阵

| 参数族 | 默认 owner | 非默认 owner（条件 / 相位） | 写路径 | 仲裁 |
|---|---|---|---|---|
| 物理根输入：AngleX/Y/Z、PositionX/Y/Z、LeanInput、Movement1-3、Param42、ParamBreath | tracking / ambient / motion | expression（LeanInput 前倾）、motion（Movement*） | injector add（pre）；angleBus 限幅（AngleZ/PositionX/Y） | 多路加法：body40>gaze35>ambient20>media10；LeanInput 无总线限幅 → 由 Motion Mixer 统一 |
| 物理叶子输出（269 个：发/裙/胸/耳/尾/高光/眼细节…；= 292 输出 − 23 四肢，Hip 3 个已含在 23 内、不重复减） | **physics** | 无 | 只读 | Physics600 后无人覆盖 |
| 四肢骨参数（23 个：RArm/RForearm/RWrist/RHand/RHand2、LArm/LForearm/LWrist/LHand/LHand2、ShoulderY/Z、HipAngleX/X2/Y/Z、ParamHipAngleZ/Z2、LEGAngleZ2、HipZ1/Z2、HipAngleYDOWN/UP） | **physics**（待机） | **limb**：acquire 后独占 | `post`（20 个叶子）；`pre`（Hip* 3 个，+生产者让位） | 同帧唯一 winner；release 回 physics |
| 其中 HipAngleX/HipAngleY/HipAngleZ | physics | limb（pre + 生产者让位，M1-b） | pre + PhysicsGate | chained 消费者 4/1/3 个设置 |
| 姿态参数 Param36/39/40/41/42/43/59/60/61/62 | motion（曲线）/ pose | pose（post，动作终态收养）；keyframes（post） | injector set（post） | 同帧顺序 kfTick → poseController → injector.post → pose 胜 keyframes；limb 不得写 |
| 表情参数 key1-13、Clothes1-5、LeanInput | expression | — | Expression300（Add cross-fade 1s） | 共享 key3-6 / Clothes2 同帧叠加 → Timeline 替换语义 |
| 眼/眉/嘴族（ParamEyeLOpen/ROpen、ParamEyeBallX/Y、ParamBrow*、ParamMouth*、EyeSmile…） | eyeBlink200 / gaze(post 眼) / ambient | expression、Idle 曲线、keyframes | injector / writeParam | 顺序：EyeBlink200 → Expression300 → post gaze 眼 |
| 口型（LipSync group：ParamMouthOpenY） | **无 owner（禁区）** | — | 全部拒绝 | 任何通道任何 owner 永不放行 |
| 持续运动（Idle 21 参数、ambient 5 类、媒体律动） | motion / ambient | FORCE/NORMAL 动作抢占 Idle（MotionManager reserve）；stageGate 停 ambient | motion 队列 / injector add | ActGate；`choreography.decide` 抖动/冷却 |

**所有权状态机**：

```
            acquire(ids, {owner:'limb', priority, phase, runId})
physics-owned ───────────────────────────────────────────────▶ limb-owned
      ▲                                                            │
      └── release(runId) / interrupted / priority-blocked / ───────┘
          action-done / 超时（最后兜底）
```

规则 R1-R12 见 `docs/Ownership-Invariants.md` §2（不变量）与本节表格；要点（R5 的 source 秩与 INV-6 同一份：`physics < continuous/ambient < motion < keyframes < pose < gaze < limb`）：
默认 physics-owned（R1）；独占时同帧只有一条写路径（R2/R4）；叶子四肢 post、Hip* pre（R3/R6）；
ActGate 优先级（R5）；打断即释放（R7）；释放回物理（R8）；口型永拒（R9）；
物理输出默认拒、`own:true` 仅对已 acquire 放行（R10）；未索引拒绝（R11）；runId 绑定（R12）；
**`own` 仅对物理输出登记（R10b）**：`ownParameters` / `own:true` 只接受当前物理输出表内的参数 id（非物理 id 进回执 `ignored`，仍按普通写入生效）；acquire 可带 `phase`（M1-a 叶子仅 post，M1-b 的 Hip* 用 pre）；
非物理参数（Angle/Position/Lean/Movement*、姿态、表情、口型）不登记，也不得因此改写其注入语义
（尤其禁止把 add 型根输入强转 set）。被忽略的 id 必须在回执里返回 `ignored`。

## 4. 冲突清单（最终版）

| ID | 冲突 | 证据 | 处置 | 状态 |
|---|---|---|---|---|
| C1 | Idle 写 ShockR/ShockL（物理输出）→ 死曲线 | 曲线数据 + physics3 输出表 | 清理 Idle 曲线或标注 no-op | open（低优先） |
| C2 | 前倾表情 Add LeanInput=-30 与 gaze 身体直写叠加，无总线限幅 | exp3 + index.ts gaze 身体 | LeanInput 纳入 Motion Mixer 仲裁 | M1-c |
| C3 | 表情共享 key3-6 / Clothes2，1s cross-fade 内 Add 叠加 | exp3 数据 | Timeline 同参数替换语义 + 拒绝并发同参表情 | M1-c |
| C4 | 动作曲线与 pose 共写 Param36/39-43/59-62 | motion3 曲线 + pose-controller | Motion Mixer 统一（pose 优先于 motion 曲线；limb 不得写） | M1-a |
| C5 | keyframes 写任意可写参数、打穿动作；与 pose 同帧竞争 POSE_IDS | overlay/keyframes + post 顺序 | Timeline 声明 owner/priority，冲突即拒绝 | M1-c |
| C6 | HTTP `l2d_set_parameters` 可写口型/物理输出 | overlay 工具分派 + injector 黑名单仅挡输出 | 统一守卫：口型永远拒；物理输出仅 `own:true`（host+MCP 前置 + 渲染层最终裁定） | M1-d（本批已做 host/MCP 侧） |
| C7 | angleBus 不含 LeanInput | index.ts:782 | 纳入 Mixer/总线（cap ±30） | M1-c |
| C8 | 物理输出兜底正则与真实表不同源 | param-injector.ts fallback | 以运行时输出表为准；host 侧用 physics3 动态表；capabilities 暴露只读位 | M1-d |
| C9 | 四肢 chained 依赖（Hip*） | physics chained 19 参数 | M1-b：pre + 生产者让位；只做 post 时次级链不跟随 | M1-b |
| C10 | 动作/占位与 limb 交叉（limb 写 Param36 等） | 所有权矩阵 | limb 仅允许写四肢骨参数；姿态参数归 motion/pose | M1-a |
| C11 | 口型诊断口与公开工具面混淆 | 评审决定 | 诊断口不进 MCP 工具面、仅本地调试开关 | M1-d |
| C12 | `own:true` 会登记非物理参数并把 add 型根输入强转 set（3972722 现状） | `param-ownership.ts own()` 只滤口型；`param-injector.ts set()` 对 owned 强制 set | 渲染层 `own()` 增加 `isPhysicsOutput` 过滤并返回 ignored；Adapter 增加 `canOwn(ids)`；契约按 R10b | M1-d（渲染层 own 过滤可在 M1-a 顺手做） |

## 5. 确定性顺序

**帧内**：见 §1。**写计划内**（`resolveWritePlan`）：

1. 收集候选：每个 `(paramId, source)` 同帧只保留最后一条 intent（last-write-wins）。
2. 过滤：口型 → `lipsync`；未知参数 → `unknown-param`；非有限数 → `invalid-value`；
   非 owner 写物理输出/四肢 → `not-owned`；相位不匹配 → `wrong-phase`。
3. 解析相位：intent.phase → ownership.phase → 参数族默认；再按 INV-7 校验。
4. 选 winner：`priority` desc → source 秩 desc（`physics < continuous/ambient < motion < keyframes < pose < gaze < limb`）
   → 同 source 后者。
5. 钳制（可选 bounds）→ 按 id 稳定排序输出。
6. physics 值只在其参数未被 intent 覆盖且未被 limb 独占时输出（physics-owned 兜底）。

**确定性要求**：同一输入集合任意顺序 → 输出逐字节相同（CASE-22）；无隐式时间/随机依赖。

## 6. 模块接口（M1 提案，实现归渲染层）

| 模块 | 职责 | 关键 API（示意） | 状态归属 | 测试边界 |
|---|---|---|---|---|
| **Motion Mixer** | 统一 motion/pose/keyframes/limb/continuous 的 intent 与相位，产出每帧写计划 | `submit(intent)` / `tick(dt)` / `cancel(sourceId)` / `releaseOwner(owner)` | 每 source lifecycle + 引用 ownership 表 | `resolveWritePlan` 纯函数用例 |
| **Pose Composer** | 姿态语义（rest/finger/grass/chest）→ Param36/39-43/59-62 | `compose(poseSpec)` / `adoptFromModel(values)` | current/target/armed | 预设映射、缓动终点、收养后不自动回 |
| **Gesture Timeline** | keyframes 轨 + 总线路由 + 冲突拒绝 | `play(timeline,{owner,priority})` / `stop()` | active/loop | 轨道/键数/时长/口型/被占用参数拒绝 |
| **Limb Controller** | 四肢所有权与直控值（默认 physics，acquire 后独占） | `acquire(ids,{priority,runId,phase})` / `set(ids,values)` / `release(runId)` | ownership 表（physics-owned ↔ limb-owned） | 状态层 S-01~06、抢占、打断释放 |
| **Continuous Motion** | Idle/ambient/media 调度（动作队列空闲时） | `tick(dt)` / `suspend(reason)` | idle/micro/away | gate 决策、stageGate 交互 |
| **Motion Adapter** | capabilities 校验：未索引组/表情、只读参数、口型 | `capabilities()` / `canPlay(group)` / `canWrite(ids)` | 模型索引缓存 | 白名单/只读/口型拒绝 |

## 7. 写路径与守卫

- **唯一写入口**：渲染端仍只有 `ParamInjector`；M1 新增 `own` 语义：
  `injector.set(model, id, value, {own:true, owner, phase})` 跳过物理输出黑名单（仅当 ownership 表标记该 id 由 limb 持有）。
- **HTTP**（渲染层实现）：`l2d_set_parameters` 增加 `own` 布尔（默认 false）；`own:true` 仅对已 acquire 的物理输出生效；
  口型参数任何情况 400。`own:true` 只登记物理输出（R10b）：非物理 id 进 `ignored`，不得强转 set；
  `durationMs<=0` 表示长期持有（overlay 传负数），用尽后须显式 `release`。
- **Host 层（本批已实现）**：`/dsh-l2d/ai/call` 在入队前按模型索引（model3 + physics3 动态读取）校验：
  - `l2d_set_expression` → 未索引表情 400；`l2d_play_motion` → 未索引组/Idle 400；
  - `l2d_set_parameters` / `l2d_play_keyframes` → 口型参数永远 400；物理输出非 `own:true` 400
    （`checkParameterWrite`，见 `param-guards.mjs`）；模型索引读不到时 fail-open，渲染端仍校验。
- **MCP 层（本批已实现）**：`packages/dsh-l2d-mcp/src/validate.mjs` —— 表情白名单、动作组白名单
  （Idle 拒绝外部手动播）、`l2d_act` 每步用 `choreography.validateStep` 校验、口型扫描；
  `server.mjs` 在转发前拒绝。MCP 不暴露 `set_parameters` / `play_keyframes`，物理输出 `own` 规则只在 host+渲染端生效。
- **诊断**：`injector.diagnostics()` 增加 owner 写入计数（渲染层）；诊断口不进公开工具面。
- **单一事实源**：口型名单在 `packages/dsh-l2d-plugin/lib/param-guards.mjs`（与 core `LIPSYNC_PARAMS` 同名单），
  host/MCP 共用；渲染端保留自己的一份（跨 TS/JS 边界，靠测试对齐）。

## 8. M1 五段计划

| 阶段 | 内容 | 验收 | 回滚 |
|---|---|---|---|
| M1-a | LimbController 骨架 + Motion Mixer 核心；20 个叶子四肢 post 覆盖；ownership + injector own 绕过 | 待机四肢由物理驱动；acquire 后 post 胜出；release 回物理；不变量用例全绿 | feature flag 默认关 = 现行为 |
| M1-b | HipAngleX/Y/Z pre 通道 + PhysicsGate（16 个生产者设置让位） | 裙摆/腿链随 Agent 值动；release 后恢复 | flag 关回退到 a |
| M1-c | Gesture Timeline + LeanInput/表情共享仲裁 | 不变量用例；现有动作/姿势/表情回归 | 保留旧 playKeyframes 路径 |
| M1-d | Motion Adapter（capabilities 只读位 + `canOwn(ids)`）+ 三层守卫统一 | 口型任何通道 400；未索引组拒绝；物理输出未 own 拒绝；`own` 只登记物理输出（R10b，非物理 id 返回 ignored） | 各层独立开关 |
| M1-e | Continuous Motion 收敛（Idle/ambient/media 决策进 Mixer） | 待机不回归；抖动/冷却用例 | 保留旧调度 |

## 9. 测试契约

- **可执行 spec**：`tools/ownership-spec/` —— `cases.mjs`（24 用例）、`run.mjs`（跑任意实现）、
  `reference.mjs`（参考实现）、`reference.test.mjs`（进 test:core 自检 spec）。
  实现方：`node tools/ownership-spec/run.mjs packages/renderer/src/app/write-plan.ts`（加 `--experimental-strip-types`）。
- **状态层**：`docs/Ownership-Invariants.md` §4（acquire/release/抢占/打断/超时/泄漏）。
- **集成**：固定帧序列 → `readParameters()` 逐帧快照；覆盖 acquire/释放/抢占/回物理、Hip* 次级跟随、Idle 死曲线。
- **回归**：`pnpm test:core` 全绿；`tools/dev-server` overlay-test 冒烟。

## 10. 证据索引

- 帧序：`packages/renderer/src/app/lappmodel.ts:632-690`；`packages/renderer/src/fw/motion/icubismupdater.ts:23-30`
- 写入口：`packages/renderer/src/app/param-injector.ts`（set/apply/黑名单/ADDITIVE_INPUTS）
- 钩子与总线：`packages/renderer/src/index.ts:327-345`、`:782-845`、`:1245-1385`
- 姿态/导演：`packages/renderer/src/app/pose-controller.ts`、`motion-director.ts`
- 优先级：`packages/core/src/action-chain.ts:16-19`；`packages/renderer/src/app/lappdefine.ts:74-77`
- 数据：`model-audit.json`（509/292/71/21/131）；`DeepSeek免费公皮/DeepSeek/*.json`
- 守卫实现：`packages/dsh-l2d-plugin/lib/param-guards.mjs`；`packages/dsh-l2d-mcp/src/validate.mjs`；
  可执行规格：`tools/ownership-spec/`
