# M1-b Hip\* 让位点清单（16 个生产者）

> 依据：Embodied-Behavior 拍板 1（Hip\* 让位分两步）、冲突 C9（chained 依赖）、§3 所有权矩阵。
> 数据源：`DeepSeek免费公皮/DeepSeek/大肥鱼.physics3.json`（131 settings / 292 输出，与 model-audit.json 一致）。
> 实现：`packages/renderer/src/fw/physics/physics-yield.ts`（让位登记表）+
> `cubismphysics.ts` evaluate/interpolate 两处跳过 + `app/motion-adapter.ts createPhysicsGate`。
> flag：`embodied.m1`（默认 false = 全部让位点不生效，现行为逐字节不变）。

## 1. 生产者（16 个物理设置，输出 23 个四肢骨参数）

「让位」语义：flag 开且该输出参数正被 Agent 以 pre 相位独占时，`CubismPhysics.evaluate`
跳过该输出的 `_parameterCaches` 回写、`interpolate` 跳过 `parameterValues` 落写；
振子状态（`_currentRigOutputs`）照常推进（保温），release 后下一帧物理平滑接管（R8）。

| # | setting（0 基下标） | 名称 | 输出（四肢骨参数） | M1-b 处置 |
|---|---|---|---|---|
| 1 | 9 | PhysicsSetting10 | ShoulderY | 不让位：叶子四肢 post 覆盖已胜出（M1-a） |
| 2 | 10 | PhysicsSetting11 | ShoulderZ | 不让位：同上 |
| 3 | 11 | **PhysicsSetting12** | **HipAngleX** | **让位（pre 通道）**：Agent pre 值存活，chained 4 设置随动 |
| 4 | 12 | PhysicsSetting13 | HipAngleX2 | 不让位：非 pre 族（write-plan PRE_ONLY 只有 HipAngleX/Y/Z），post 覆盖 |
| 5 | 13 | **PhysicsSetting14** | **HipAngleY** | **让位（pre 通道）**：chained 1 设置随动 |
| 6 | 14 | **PhysicsSetting15** | **HipAngleZ** | **让位（pre 通道）**：chained 3 设置随动 |
| 7 | 15 | PhysicsSetting16 | ParamHipAngleZ2 | 不让位：同 #4 |
| 8 | 16 | PhysicsSetting17 | LEGAngleZ2 | 不让位：同 #4（但它**消费** HipAngleX，见 §2） |
| 9 | 17 | PhysicsSetting18 | ParamHipAngleZ | 不让位：同 #4（但它**消费** HipAngleZ，见 §2） |
| 10 | 18 | PhysicsSetting19 | HipZ1 | 不让位：同 #4 |
| 11 | 19 | PhysicsSetting20 | HipZ2 | 不让位：同 #4 |
| 12 | 21 | PhysicsSetting22 | HipAngleYDOWN, HipAngleYUP | 不让位：同 #4 |
| 13 | 71 | PhysicsSetting72 | LArm, LForearm, LWrist | 不让位：叶子 post（M1-a） |
| 14 | 72 | PhysicsSetting73 | RArm, RForearm, RWrist | 不让位：同上 |
| 15 | 73 | PhysicsSetting74 | LHand, LHand2 | 不让位：同上 |
| 16 | 74 | PhysicsSetting75 | RHand, RHand2 | 不让位：同上 |

要点：让位只发生在 **pre 相位独占** 的 3 个参数（HipAngleX/Y/Z，write-plan `PRE_ONLY_PARAMS`
与 INV-7 的参数族约束）；其余 13 个生产者的输出参数族默认 post，物理照写、Agent post 后写胜出
（M1-a 语义），无需让位。运行时让位集合由 `injector.getPreOwnedIds()` 现算（ownership 驱动，
零硬编码参数名），因此换模型 / 输出表变化自动适配。

## 2. chained 消费者（读 Hip\* 的 8 个设置，4/1/3）

让位的**目的**：这些设置的 Input 读到 Agent pre 值（evaluate 起点缓存向 parameterValues 收敛），
次级链随动 —— 裙摆/腿链跟着 Agent 的 Hip 值动（拍板 1：不接受「次级链不跟随」作为终态）。
它们自己不是让位点（输出照常写）。

| 消费设置 | 读 | 输出（随动链） |
|---|---|---|
| PhysicsSetting17（#16） | HipAngleX(w23), PositionZ | LEGAngleZ2（腿链） |
| PhysicsSetting67（#66） | HipAngleX(w50), ParamBodyAngleZ | SkirtX1…X4, SkirtSpecial, SkirtSpecial2（裙摆） |
| PhysicsSetting70（#69） | HipAngleZ(w0), HipAngleX(w50) | SkirtLayerX1…X6（裙摆） |
| PhysicsSetting126（#125） | HipAngleX(w100) | Param33 |
| PhysicsSetting71（#70） | HipAngleY(w100) | SkirtLayerY1…Y5（裙摆纵向） |
| PhysicsSetting18（#17） | PositionX, PositionY, HipAngleZ(w47), LeanInput | ParamHipAngleZ |
| PhysicsSetting19（#18） | HipAngleZ(w100) | HipZ1 |

（HipAngleZ 的第 3 个消费点是 PhysicsSetting70，上表已含；weight 0 的输入不产生实际位移，
仍在清单中列出以对齐「chained 4/1/3」口径。）

## 3. 渲染层写 Hip\*/相关骨参数的路径审计（均无需新增让位）

| 路径 | 写的参数 | 结论 |
|---|---|---|
| pose-controller（setPose/adopt） | Param36/39-43/59-62 | 不写 Hip\*；ownership 矩阵内 posture 族，与让位无关 |
| 拖拽/注视（lookAt/gaze/angleBus） | AngleX/Y/Z、PositionX/Y、LeanInput | 物理根输入（add，pre），是 Hip\* 生产者的**上游**，非让位点 |
| keyframes（playKeyframes） | 任意可写参数（物理输出需自动 own） | 经 injector；写 HipAngleX/Y/Z 时 own 相位由调用方给 pre 即与让位路径汇合（M1-c Timeline 再统一） |
| setParameters（own:true） | 物理 23 骨参数 | 独占后 per-frame set；pre 相位经 injector.apply('pre') 落值 = 让位路径的 Agent 值来源 |
| 动作曲线（MotionManager） | 曲线参数（含手臂姿态） | post 钩子前的动作相位，独占期间由 ActGate/poseOwnedByMotion 仲裁，M1-b 不动 |

## 4. 验证与回滚

- 单测：`packages/renderer/src/app/physics-gate.test.mjs`（已入 `pnpm test:core` 链）——
  flag 关=基线逐字节、flag 开让位+裙摆链随动（mock 帧序对齐 §1/§5）、release 回物理、
  limb post 覆盖/空帧无副作用、让位表幂等/整体替换。
- fw 层（cubismphysics.ts）两处跳过由 `pnpm -F @dsh/renderer build` 门禁 + 集成日真机
  （m1-smoke U5 + H3 目视：裙摆随 Agent 值动）覆盖；node 无法直跑 fw 的 SDK 依赖链。
- 回滚：`embodied.m1` flag 置 false（默认即 false）——gate.pre/post/dispose 全部空操作，
  让位表永不被触碰，帧循环与 main 逐字节一致；无需改任何生产者代码。

## 5. M1-d1：Hip\* 的动作面入口（语义通道打通，本批）

M1-b 交付时 Hip\* 让位**只有渲染层 API 入口**（`ownParameters(ids, d, 'pre')`），
Agent 动作面（l2d_posture）够不着 pre 相位——画像里没有任何语义通道映射 Hip\*。
M1-d1 补上这条入口链，各层职责不变：

| 层 | 变更 | 文件 |
|---|---|---|
| 画像绑定 | 新增 3 条 direct 规则：`torso.hip`→HipAngleZ（左右倾）、`torso.hip.forward`→HipAngleY（前后）、`torso.hip.twist`→HipAngleX（水平扭转）。三条都是物理输出 → requires-own；**sourceId 只含规范名**，变体参数（HipAngleX2/ParamHipAngleZ/HipAngleZ2/HipAngleYUP/DOWN/HipZ1/Z2/Xq）绝不进 sourceId | `tools/capability-scan/bindings.mjs` |
| 语义契约 | 标准通道 20→23（v4），contractVersion 3→4 | `packages/core/src/motion-contract.ts` |
| 相位判定 | 从「纯 ownership」改为「ownership + PRE_ONLY_PARAMS 参数族」：requires-own 且参数 ∈ pre-only 族 → **pre**（PhysicsGate 让位）；direct → pre、requires-own 非 Hip → post（既有通道零漂移）。参数族复用 `motion-intent.ts` 的 `PRE_ONLY_PARAMS`，不维护第二份名单 | `packages/core/src/semantic-binding.ts` |
| 执行分批 | pre/post 批跟随 write.phase（Hip 进 pre 批）；回执 applied 仍带 phase 字段 | `packages/core/src/posture.ts` |
| overlay | own 按相位分组两次**批量**调用：`ownParameters(preIds, d, 'pre')` + `ownParameters(postIds, d, 'post')`（不逐参数循环） | `packages/dsh-l2d-plugin/lib/overlay.js` l2d_posture 分支 |

- 契约数字：controls 56→**59**（标准 23 + W3 36），`run.mjs` F 项 / `m1-smoke.mjs` T1 同步；
  画像已重扫（`profile.大肥鱼.dsl2d.2048.json`，contractVersion 4）。
- U5 已从占位升级为真用例：torso.hip 三通道 → 断言回执 applied 含 HipAngleX/Y/Z 且
  phase='pre'、owned 含三参数、无 wrong-phase、pw=pre 计数上涨、独占窗口锁 Agent 值、
  释放后回物理。
- **flag 关行为（embodied.m1 = false，默认）**：torso.hip 通道声明性可用（画像 supported、
  规划层能产出 phase='pre' 的写入计划），但 PhysicsGate 不让位——pre 写入不会胜过物理，
  表现为「写了没效果」。这是文档化的预期行为，不算 bug；flag 开后同一条路径立即生效。
- **方向标定待办（集成日）**：轴向惯例只是初始映射（Z=左右倾 / Y=前后 / X=水平扭转）。
  真机目视方向相反或幅度不合适时，**只调 binding 层符号**（scale/-1 或取负），不改 core
  语义与参数族判定；标定结果回写本表。
