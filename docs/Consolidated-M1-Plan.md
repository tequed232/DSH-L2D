# M1 具身行为统一实施计划（合并文档汇总版）

> 本文将四份已合并的规划文档收敛为一份可执行计划。
> 来源：`docs/Embodied-Behavior.md`（M1 五段计划）、`docs/Ownership-Invariants.md`（resolveWritePlan 测试规格）、
> `docs/W3-Motion-Capability-Registry.md`（能力登记与语义约束）、`docs/MOTION_ENGINE_AIRI_IMPLEMENTATION_GUIDE.md`（多模型架构与实施阶段）。
> 分支：`feat/m1-consolidated`（基于 origin/main 3163252）。

## 0. 目标与非目标

目标：落地 Embodied-Behavior §8 的 M1 五段中的 **a/d 两段核心 + 支撑设施**，四条并行工作流互不阻塞；
验收全部以测试契约（Embodied-Behavior §9）与 Ownership-Invariants 用例清单为准。

非目标：M1-b 的 HipAngleX pre 通道（依赖 a 合入）、M1-c 手势时间线、M1-e 连续动作收敛（后续批次）。

## 1. 四条并行工作流（文件所有权互斥）

### WS-1 · 核心写计划与四肢控制器（packages/core/**）
- `resolveWritePlan` 纯函数：按 Ownership-Invariants §2 的 INV 不变量实现写计划解析。
- `LimbController` 骨架：20 个叶子四肢参数（对照 W3 注册表「姿势」枚举）post 覆盖；
  acquire → post 胜出，release → 回物理驱动。
- 覆盖 Ownership-Invariants §3 用例清单**逐条**实现为单测。
- 验收：全部 INV 用例绿；feature flag 默认关 = 现行为（M1-a 回滚要求）。

### WS-2 · 渲染层 Motion Adapter 与合成点（packages/renderer/**）
- Motion Adapter：capabilities 只读位 + `canOwn(ids)`（AIRI §Phase B / Embodied-Behavior §6）。
- PhysicsGate 挂接点（M1-b 的 pre 通道接口预留，不启用）。
- 帧更新管线合成顺序对齐 AIRI §4.6：物理 → pre(Agent) → 模型更新 → post(Controller) → 混合。
- 验收：acquire 后 post 胜出、release 回物理（配合 WS-1 的联调用例）；渲染契约测试不回归。

### WS-3 · 三层守卫统一（packages/dsh-l2d-plugin/lib/**）
- 口型任何通道 → 400（现有守卫扩展到 posture 路径）。
- 未索引表情/动作组 → 拒绝；物理输出未 own → 拒绝（现状保持）。
- `own: true` 只登记物理输出（R10b）：非物理 id 返回 `ignored`，不算错误。
- 验收：host-guard/param-guards 测试契约全绿 + 新增 R10b 用例。

### WS-4 · W3 能力注册表与语义通道扩充（tools/capability-scan/** + core 通道映射）
- 按 W3 文档补齐：动作组（成对状态切换）、Idle、姿势枚举、视线/身体、表情 21 个（参数取自 exp3.json）。
- 「明确不登记」条目落进扫描器排除表；语义约束（§语义约束）进 semantic-binding 的 canExpress。
- 验收：画像重扫后 controls 数量与 W3 清单一致；canExpress 对未登记通道返回 false。

## 2. 全局约束（所有工作流）

1. 参数名只能出现在 fixture/画像中，禁止硬编码进逻辑（能力驱动铁律）。
2. 物理输出（ShoulderZ 等）必须 own 后才能 post 写；口型参数永久保留给 lipsync。
3. 所有新纯函数进 `packages/core/src/`，测试进 `packages/core/test/`，接入 `test:core` 门禁。
4. feature flag：`embodied.m1`（默认 false = 现行为），任何渲染层行为变化都在 flag 后面。
5. 禁止 revert 他人的并行改动；工作区共享，改前先读最新。

## 3. 集成与验收顺序

1. WS-1/WS-3/WS-4 先行（互不依赖），WS-2 依赖 WS-1 的类型签名（可先按接口开发）。
2. 集成日：四流合入后跑 `pnpm test:core && pnpm test:types && 真机验收（run.mjs + guards.mjs）`。
3. 真机冒烟：待机四肢由物理驱动、Agent acquire 后覆盖、release 回落、口型红线不破。

## 4. 执行记录

| 工作流 | 代理 | 状态 | 交付要点 |
|---|---|---|---|
| WS-1 | core-mixer | ✅ 完成 | resolveWritePlan（官方 spec 跨验 25/25）+ LimbController（20 叶子 id 注入式）+ INV-01…12/S-01…06 全绿 |
| WS-2 | renderer-adapter | ✅ 完成 | MotionAdapter（canOwn 对齐 R10b）+ PhysicsGate 预留 + 帧序审计（与 §1 无顺序性差异）；flag 关 = 行为与 main 一致 |
| WS-3 | guards-unify | ✅ 完成 | 口型红线扩到 posture 路径（真机 400）、R10b ignored（真机 warning 可见）、物理输出未 own 400（真机） |
| WS-4 | capability-registry | ✅ 完成 | 画像 20→56 通道（W3 36 条 + 排除 4 条带原因）、canExpress 语义约束数据化；真机重扫/settings 兼容 |
| M1-b | m1-hip | 🔄 进行中 | HipAngleX/Y/Z pre 通道 + PhysicsGate（16 生产者让位）；提交号待补 |
| M1-c | m1-gesture | 🔄 进行中 | Gesture Timeline + LeanInput/表情共享仲裁；提交号待补 |
| 验收基建 | m1-acceptance | 🔄 进行中 | tools/acceptance/m1-smoke.mjs（T/U/H 三组用例 + embodied.m1 开关组 + mock 自测）+ docs/M1-Test-Contract.md（§9 契约对照表）；提交号待补 |

终验：test:core exit 0（120+ 断言）· test:types PASS · 真机验收 9/9 · 守卫 9/9。
集成修复：acceptance F 项契约同步 20→56；失败原因透出（failed[0]）；
跨流对齐：renderer 的 LimbControlLike 三方法签名即 WS-1 LimbController 的公开接口。
