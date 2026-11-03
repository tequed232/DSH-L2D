# Motion Engine：多模型通用运动架构

## 目标与边界

Motion Engine 使用统一的语义运动空间，不让行为规划器依赖某个模型的参数 ID、motion3 文件名或渲染引擎。当前实现以 Cubism Web 为首个 Adapter；未来可增加其他 Live2D 模型配置，以及 VRM/3D、Spine 等不同运行时 Adapter，而不改变上层行为语义。

“多模型”分为两层：
- 同一引擎的多个模型：每次加载模型都重新生成独立 Capability Profile。
- 不同渲染/骨骼引擎：新增 Adapter，实现相同的 MotionAdapter 契约。

本阶段只建立通用契约和纯函数，不宣称已经接通 VRM/Spine 或完成 Cubism 参数映射。

## 分层

1. Behavior Planner：输出 head.yaw、arm.right.raise 等语义目标，不输出参数名。
2. Semantic Motion Space：统一归一化控制量，默认范围 [-1, 1]。
3. Capability Profile：描述当前模型实际支持、近似支持和不支持的控制及动作资产。
4. Motion Adapter：负责读取模型能力、读写模型状态、播放原生动作资产。
5. Core Motion Runtime：轨迹采样、参数混合、优先级与资源冲突处理。
6. Renderer Backend：Cubism、VRM 或其他运行时的具体执行。

## Capability Profile

Profile 必须按模型实例生成，不能只按模型品牌或模型文件名猜测。至少包含 contractVersion、modelId、adapterId、profileRevision；semantic controls 的状态、范围、中性值、置信度；Adapter 私有 sourceId；资源组；原生资产的资源占用、可中断性和循环能力。

unsupported 必须 fail-closed。approximate 允许降级，但上层必须能知道它是近似动作。模型切换时丢弃旧 profile、轨迹和参数缓存，重新 inspect；不能把模型 A 的参数映射复用给模型 B。

## 混合控制

- Procedural：本地轨迹生成连续参数。
- Native asset：调用模型自带 motion3 或其他引擎原生动画。
- 两者通过资源占用表仲裁。资源冲突时拒绝或显式降级，不允许静默并行覆盖。
- 现有 ParamMixer 是参数仲裁的唯一核心；后续 Adapter 接线应扩展它，而不是新建第二套 Mixer。
- 只有 Adapter 能把语义控制映射为原生参数 ID。

## 安全与更新顺序

Cubism Adapter 必须基于当前模型的参数表、physics 输出、参数范围和更新调度器生成 profile。Physics 输出、只读参数、嘴部口型禁区和动作资产的资源占用必须保留。Cubism 的参数覆盖/加算及 updater 顺序影响最终结果，必须遵循官方 SDK 的真实更新顺序。

## 当前代码状态

- packages/core/src/motion-contract.ts：模型无关契约。
- packages/core/src/motion-profile.ts：Profile 校验、能力查找、Adapter 选择、语义值限幅。
- packages/core/src/motion-trajectory.ts：确定性轨迹验证与采样。
- packages/core/src/mixer.ts：现有参数仲裁器，继续作为唯一 Mixer。
- packages/renderer：后续 Cubism Adapter 接线位置。

## 分阶段实施

- G1（本 PR）：通用契约、Profile 校验、轨迹纯函数和单测。
- G2：Cubism Adapter，从每个已加载模型提取参数范围、physics 输出、motion groups、expressions、pose 与资源冲突。
- G3：将语义轨迹接入现有 ParamInjector / ParamMixer 和 CubismUpdateScheduler。
- G4：实现 Gesture Composer、Body State、动作中断恢复。
- G5：增加第二种模型/运行时 Adapter，并用相同语义用例做兼容性测试。

验收不得只依赖 DOM stub；G2 以后必须用至少两个结构不同的模型验证。模型资源未获许可不得提交仓库。


## 契约 v2：与既有 intent 契约的关系（PR #10 review fix）

`packages/core/src/motion-intent.ts` 负责把语义帧降级成**既有** `WriteIntent`，语义层不直接写模型参数：

- 形状与 `docs/Embodied-Behavior.md` 一致：`{ id, source, priority(10/50/90), phase(pre|post), params, runId? }`
- `priority` 与 `core/src/action-chain.ts` 的 `ACT_PRIORITY_RANK` 同值；`source` 与 INV-6 的 source 秩同一份；
- INV-7 保护：物理根输入（AngleX/PositionX/LeanInput/HipAngleX 等）写成 `post` 会被直接拒绝（`pre-only-param`）；
- `blend`（override/add）暂不进 intent 契约，等 M1-c 的 Mixer 接线；
- 契约版本 `MOTION_CONTRACT_VERSION = 2`：新增 `unknown` 能力状态、`face.blink`/`body.breathing`
  语义控制、帧级 `priority/phase/blend/owner`；v1 profile 与 v2 不互通。

### 已实现 / 未实现

- 已实现：`motion-contract.ts`（契约与常量）、`motion-profile.ts`（校验/能力解析/Adapter 选择）、
  `motion-trajectory.ts`（编译一次 + 采样）、`motion-intent.ts`（语义帧 → intent）、
  `packages/core/src/index.ts` 入口导出、`test:core` 接线。
- 未实现（G2）：Cubism Adapter、能力清单生成、`SemanticMotionPlan` planner 层、blend 的 Mixer 消费。
