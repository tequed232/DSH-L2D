# M1-g G0：物理与 Rig 审计（大肥鱼 / dsl2d.2048）

> **状态**：只读审计（G0）。本文件是唯一产物；未修改任何生产代码、未提交、未改动模型资产。
> **分支**：`feat/m1-d2-gesture-wiring`（含 PR19 路线图 `01b85e8`）
> **依据**：`docs/M1-G-LIMB-ALLOCATION-ROADMAP.md` §G0 六项交付物
>
> **证据分级**（全文统一）：
> - `FILE`：直接来自仓库文件原文（physics3.json / cdi3.json / .ts 源码），带 `文件:行号` 或 JSON key。
> - `RUNTIME`：用官方 Cubism Core 6.0.1（`vendor/cubism/CubismSdkForWeb-5-r.5/Core/live2dcubismcore.min.js`）加载 `大肥鱼.moc3`，调用 `csmGetParameterMinimum/Maximum/DefaultValues` 实测；与渲染器 `getCapabilities()`（`packages/renderer/src/index.ts:1954-1962`）同一 API。
> - `DERIVED`：对 physics3 的 Input/Output 图做推导（脚本见附录 B），非运行时观测。
> - `UNKNOWN`：仓库内无证据，**不得**按参数名/部位名推断为可用。

## 0. 结论摘要

1. **手臂物理输出是链末端**。`RArm/RForearm/RWrist/RHand/RHand2` 与左侧同名 5 个共 10 个物理输出，在 physics3 中**没有任何下游消费者**（`DERIVED`：`downstream()` 返回空集）。抑制或覆盖它们不会改变其他任何物理输出。`ShoulderY/ShoulderZ` 同理（0 下游）。
2. **"手臂姿态"不在物理输出表里**。现有真实手臂动作（竖手指 / 狗尾草 / 抚胸）写的是 `Param36/39/40/41/42/43`（右）、`Param59/60/61/62`（左）与 `Movement1/2/3`——前 10 个**都不是**物理输出（`FILE`：physics3 输出表 + `tools/w3-registry/registry.json` 的 `controlledParams`）。因此 `MotionAdapter.canOwn()`（只放行物理输出）对手臂动作返回**空集**：按现契约，"独占手臂"这件事本身不成立，它拆分成了两批互不相交的参数。
3. **真共享域只有三族**：`ParamBodyAngleX/Z`（各 20 条消费边）、`ParamAngleX/Y/Z`（17/14/15）、`HipAngleX/Y/Z`（4/1/3）；按传递可达的输出数算是 61/62 与 52/42/50 与 14/8/5。它们是"物理输出 + 物理输入"的双重身份，独占时必须让位且次级链随动。手臂叶子域不在此列。
4. **物理写入是每帧、缓冲后直写参数数组**：`evaluate()` 把结果写进 `_parameterCaches`（组间传播缓冲），`interpolate()` 再写进 `model.parameters.values`（`packages/renderer/src/fw/physics/cubismphysics.ts:775`）。292 个输出的 `VertexIndex` 全部有效（无越界死输出，逐帧都会走到写入分支），其中 `ShockR/ShockL` 因 `Weight=0`（`PhysicsSetting42/43`）写等于不写。
5. **现有让位机制只覆盖 pre 相位**。`PhysicsGate.pre` 的数据源是 `injector.getPreOwnedIds()`（`packages/renderer/src/app/motion-adapter.ts:244`、`param-injector.ts:151-156`），只有 `pre` 独占的 id 进 `physicsYield`；四肢契约相位是 `post`（`docs/Ownership-Invariants.md:65-66`），**不进让位表**——物理每帧照写 `RArm`，靠 post 后写覆盖。对手臂叶子域无害（无下游），对共享域致命。
6. **limb 通道今日未接线**：`createPhysicsGate(...)` 只注入了 `preOwnedIds` 与 `stagePostWrite`，**没有 `limb`**（`packages/renderer/src/index.ts:76-80`），`PhysicsGate.post` 在 `deps.limb` 缺省时直接 return（`motion-adapter.ts:251-252`）。`LimbController` 在生产路径中零实例。G1 要接的正是这条空管线。

---

## 1. 参数清单

### 1.1 量程的来源（必须先说清楚）

`大肥鱼.cdi3.json` 的 `Parameters[]` 元素只有三个字段：`Id` / `GroupId` / `Name`（`FILE`，例：`{"Id":"Param35","GroupId":"ParamGroup14","Name":"手臂开关物理"}`）——**cdi3 不含 min/max/default**。工作区里没有任何静态参数范围清单（`dist/capabilities.json` 的 `params` 只有 14 条语义映射，无范围）。

量程的唯一事实源是 `moc3`，由 Core 在运行时给出：`getParameterMinimumValue / getParameterMaximumValue / getParameterDefaultValue`（渲染器侧同一路径见 `packages/renderer/src/index.ts:1954-1962`）。本报告的量程列为 `RUNTIME` 实测值（附录 B 给出复现脚本），**不是**从参数名推测。

参数集一致性核对：`moc3` 509 个参数，`cdi3` 509 个参数，集合完全相同（0 差异）；physics3 引用的 323 个 id 全部存在于 moc3（`RUNTIME`，0 缺失）。

### 1.2 四肢 / 躯干 / 头 相关参数

列含义：`物理输出` = 该 id 是否出现在 `PhysicsSettings[].Output[].Destination.Id`；`写入者` = 写它的 PhysicsSetting。

| 参数 id | cdi3 名称 | cdi3 组 | min..max | 默认 | 物理输出 | 写入者 / 备注 |
|---|---|---|---|---|---|---|
| **右臂（美术输出层）** | | | | | | |
| `RArm` | 右大臂 | 手臂 | -1..1 | 0 | 是 | 物理输出：PhysicsSetting73(右臂) |
| `RForearm` | 右小臂 | 手臂 | -1..1 | 0 | 是 | 物理输出：PhysicsSetting73(右臂) |
| `RWrist` | 右手腕 | 手臂 | -1..1 | 0 | 是 | 物理输出：PhysicsSetting73(右臂) |
| `RHand` | 右手指 | 手臂 | -1..1 | 0 | 是 | 物理输出：PhysicsSetting75(右手) |
| `RHand2` | 右手指 | 手臂 | -1..1 | 0 | 是 | 物理输出：PhysicsSetting75(右手) |
| `RSleeveX1` | 右袖子X1 | 手臂 | -1..1 | 0 | 是 | 物理输出：PhysicsSetting78(右袖子 X) |
| `RSleeveX2` | 右袖子X2 | 手臂 | -1..1 | 0 | 是 | 物理输出：PhysicsSetting78(右袖子 X) |
| `RSleeveX3` | 右袖子X3 | 手臂 | -1..1 | 0 | 是 | 物理输出：PhysicsSetting78(右袖子 X) |
| `RSleeveX4` | 右袖子X4 | 手臂 | -1..1 | 0 | 否 | **非物理输出**（可普通写入） |
| `RSleeveY1` | 右袖子Y1 | 手臂 | -1..1 | 0 | 是 | 物理输出：PhysicsSetting79(右袖子 Y) |
| `RSleeveY2` | 右袖子Y2 | 手臂 | -1..1 | 0 | 是 | 物理输出：PhysicsSetting79(右袖子 Y) |
| `RSleeveY3` | 右袖子Y3 | 手臂 | -1..1 | 0 | 是 | 物理输出：PhysicsSetting79(右袖子 Y) |
| `RRibbonX1` | 右飘带X1 | 手臂 | -1..1 | 0 | 是 | 物理输出：PhysicsSetting80(右飘带) |
| `RRibbonX2` | 右飘带X2 | 手臂 | -1..1 | 0 | 是 | 物理输出：PhysicsSetting80(右飘带) |
| `RRibbonX3` | 右飘带X3 | 手臂 | -1..1 | 0 | 是 | 物理输出：PhysicsSetting80(右飘带) |
| `RRibbonX4` | 右飘带X4 | 手臂 | -1..1 | 0 | 是 | 物理输出：PhysicsSetting80(右飘带) |
| `RRibbonY1` | 右飘带Y1 | 手臂 | -1..1 | 0 | 否 | **非物理输出**（可普通写入） |
| `RRibbonY2` | 右飘带Y2 | 手臂 | -1..1 | 0 | 否 | **非物理输出**（可普通写入） |
| `RRibbonY3` | 右飘带Y3 | 手臂 | -1..1 | 0 | 否 | **非物理输出**（可普通写入） |
| `RRibbonY4` | 右飘带Y4 | 手臂 | -1..1 | 0 | 否 | **非物理输出**（可普通写入） |
| **右臂（姿态层，真实动作写这里）** | | | | | | |
| `Param36` | R大臂z | 动画参数 | -1..1 | 0 | 否 | **非物理输出**（可普通写入） |
| `Param39` | 大臂透视 | 动画参数 | -1..1 | 0 | 否 | **非物理输出**（可普通写入） |
| `Param40` | 竖手指 大臂无缝用 | 动画参数 | 0..1 | 0 | 否 | **非物理输出**（可普通写入） |
| `Param41` | R小臂 Z | 动画参数 | -1..1 | 0 | 否 | **非物理输出**（可普通写入） |
| `Param42` | R手腕 Z | 动画参数 | -1..1 | 0 | 否 | **非物理输出**（可普通写入）；喂 PhysicsSetting131（尾巴，权重 50） |
| `Param43` | R 食指 | 动画参数 | -1..1 | 0 | 否 | **非物理输出**（可普通写入） |
| `Param25` | 右手Z | 手臂 | -1..1 | 0 | 是 | 物理输出：PhysicsSetting124(动作手 Z)；右手 Z，由 setting 124 从 ParamBodyAngleZ 派生 |
| `Param35` | 手臂开关物理 | 手臂 | -1..1 | 0 | 是 | 物理输出：PhysicsSetting128(手臂开关物理)；手臂开关物理，三条 Movement* 之和 |
| **左臂（美术输出层）** | | | | | | |
| `LArm` | 左大臂 | 手臂 | -1..1 | 0 | 是 | 物理输出：PhysicsSetting72(左臂) |
| `LForearm` | 左小臂 | 手臂 | -1..1 | 0 | 是 | 物理输出：PhysicsSetting72(左臂) |
| `LWrist` | 左手腕 | 手臂 | -1..1 | 0 | 是 | 物理输出：PhysicsSetting72(左臂) |
| `LHand` | 左手指 | 手臂 | -1..1 | 0 | 是 | 物理输出：PhysicsSetting74(左手) |
| `LHand2` | 左手指 | 手臂 | -1..1 | 0 | 是 | 物理输出：PhysicsSetting74(左手) |
| `LSleeveX1` | 左袖子X1 | 手臂 | -1..1 | 0 | 是 | 物理输出：PhysicsSetting76(左袖子 X) |
| `LSleeveX2` | 左袖子X2 | 手臂 | -1..1 | 0 | 是 | 物理输出：PhysicsSetting76(左袖子 X) |
| `LSleeveX3` | 左袖子X3 | 手臂 | -1..1 | 0 | 是 | 物理输出：PhysicsSetting76(左袖子 X) |
| `LSleeveY` | 左袖子Y1 | 手臂 | -1..1 | 0 | 是 | 物理输出：PhysicsSetting77(左袖子 Y) |
| `LSleeveY2` | 左袖子Y2 | 手臂 | -1..1 | 0 | 是 | 物理输出：PhysicsSetting77(左袖子 Y) |
| `LSleeveY3` | 左袖子Y3 | 手臂 | -1..1 | 0 | 是 | 物理输出：PhysicsSetting77(左袖子 Y) |
| `LRibbonX1` | 左飘带X1 | 手臂 | -1..1 | 0 | 是 | 物理输出：PhysicsSetting81(左飘带) |
| `LRibbonX2` | 左飘带X2 | 手臂 | -1..1 | 0 | 是 | 物理输出：PhysicsSetting81(左飘带) |
| `LRibbonX3` | 左飘带X3 | 手臂 | -1..1 | 0 | 是 | 物理输出：PhysicsSetting81(左飘带) |
| `LRibbonX4` | 左飘带X4 | 手臂 | -1..1 | 0 | 是 | 物理输出：PhysicsSetting81(左飘带) |
| `LRibbonY1` | 左飘带Y1 | 手臂 | -1..1 | 0 | 否 | **非物理输出**（可普通写入） |
| `LRibbonY2` | 左飘带Y2 | 手臂 | -1..1 | 0 | 否 | **非物理输出**（可普通写入） |
| `LRibbonY3` | 左飘带Y3 | 手臂 | -1..1 | 0 | 否 | **非物理输出**（可普通写入） |
| `LRibbonY4` | 左飘带Y4 | 手臂 | -1..1 | 0 | 否 | **非物理输出**（可普通写入） |
| **左臂（姿态层）** | | | | | | |
| `Param59` | 大臂透视 | 动画参数 | -1..1 | 0 | 否 | **非物理输出**（可普通写入） |
| `Param60` | L小臂 Z | 动画参数 | -1..1 | 0 | 否 | **非物理输出**（可普通写入） |
| `Param61` | L手腕 Z | 动画参数 | -1..1 | 0 | 否 | **非物理输出**（可普通写入） |
| `Param62` | L 大臂z | 动画参数 | -1..1 | 0 | 否 | **非物理输出**（可普通写入） |
| `Param44` | 左臂Z | 手臂 | -1..1 | 0 | 是 | 物理输出：PhysicsSetting129(左臂z)；左臂 Z，由 setting 129 从 ParamBodyAngleZ 派生 |
| **躯干 / 肩膀 / 盆骨（共享枢纽）** | | | | | | |
| `ParamBodyAngleX` | 胸腔　X | 身体轴 | -30..30 | 0 | 是 | 物理输出：PhysicsSetting4(身体X) |
| `ParamBodyAngleY` | 胸腔　Y | 身体轴 | -30..30 | 0 | 是 | 物理输出：PhysicsSetting8(身体Y) |
| `ParamBodyAngleZ` | 胸腔　Z | 身体轴 | -30..30 | 0 | 是 | 物理输出：PhysicsSetting9(身体Z) |
| `ParamBodyAngleX2` | □胸腔　X | 身体轴 | -30..30 | 0 | 是 | 物理输出：PhysicsSetting21(身体X左右缓动) |
| `ParamBodyAngleY2` | □胸腔　Y | 身体轴 | -30..30 | 0 | 是 | 物理输出：PhysicsSetting23(身体Y缓动) |
| `ParamBodyAngleRX` | 身体位移RX | 身体轴 | -30..30 | 0 | 是 | 物理输出：PhysicsSetting5(Positon) |
| `ParamBodyAngleRY` | 身体位移RY | 身体轴 | -30..30 | 0 | 否 | **非物理输出**（可普通写入） |
| `ParamBodyAngleRZ` | 身体位移RZ | 身体轴 | -30..30 | 0 | 否 | **非物理输出**（可普通写入） |
| `ShoulderX` | 肩膀X | 身体轴 | -30..30 | 0 | 否 | **非物理输出**（可普通写入） |
| `ShoulderY` | 肩膀Y | 身体轴 | -30..30 | 0 | 是 | 物理输出：PhysicsSetting10(肩膀Y) |
| `ShoulderYy` | 肩头Y | 身体轴 | -30..30 | 0 | 否 | **非物理输出**（可普通写入） |
| `ShoulderZ` | 肩膀Z | 身体轴 | -30..30 | 0 | 是 | 物理输出：PhysicsSetting11(肩膀Z) |
| `HipAngleX` | 盆骨X | 身体轴 | -30..30 | 0 | 是 | 物理输出：PhysicsSetting12(盆骨X) |
| `HipAngleY` | 盆骨Y | 身体轴 | -30..30 | 0 | 是 | 物理输出：PhysicsSetting14(盆骨Y) |
| `HipAngleZ` | 盆骨Z | 身体轴 | -30..30 | 0 | 是 | 物理输出：PhysicsSetting15(盆骨Z) |
| `HipAngleX2` | □盆骨  X | 身体轴 | -30..30 | 0 | 是 | 物理输出：PhysicsSetting13(盆骨X 缓动) |
| `HipAngleXq` | 盆骨Xq | 身体轴 | -30..30 | 0 | 否 | **非物理输出**（可普通写入） |
| `ParamHipAngleZ` | □ 盆骨  Z | 身体轴 | -30..30 | 0 | 是 | 物理输出：PhysicsSetting18(盆骨Z缓动) |
| `ParamHipAngleZ2` | □ 盆骨  Z 2 | 身体轴 | -30..30 | 0 | 是 | 物理输出：PhysicsSetting16(盆骨Z(2)) |
| `HipZ1` | 盆骨 Z1 | 身体轴 | -1..1 | 0 | 是 | 物理输出：PhysicsSetting19(盆骨Z 1) |
| `HipZ2` | 盆骨 Z2 | 身体轴 | -1..1 | 0 | 是 | 物理输出：PhysicsSetting20(盆骨Z 2) |
| `HipAngleYUP` | □盆骨Yup | 身体轴 | -30..30 | 0 | 是 | 物理输出：PhysicsSetting22(身体X上下缓动) |
| `HipAngleYDOWN` | □盆骨Ydown | 身体轴 | -30..30 | 0 | 是 | 物理输出：PhysicsSetting22(身体X上下缓动) |
| `LEGAngleZ2` | 双腿 Z | 身体轴 | -30..30 | 0 | 是 | 物理输出：PhysicsSetting17(双腿 Z) |
| `Param33` | 并腿 | 身体轴 | -1..1 | 0 | 是 | 物理输出：PhysicsSetting126(并腿) |
| **头 / 物理根输入** | | | | | | |
| `ParamAngleX` | AngleX | 身体轴 | -30..30 | 0 | 是 | 物理输出：PhysicsSetting1(OX) |
| `ParamAngleY` | AngleY | 身体轴 | -30..30 | 0 | 是 | 物理输出：PhysicsSetting2(OY) |
| `ParamAngleZ` | AngleZ | 身体轴 | -30..30 | 0 | 是 | 物理输出：PhysicsSetting3(OZ) |
| `AngleX` | OX | 控制器 | -30..30 | 0 | 否 | **非物理输出**（可普通写入）；外部根输入（physics3 的 Source 侧，非 Output） |
| `AngleY` | OY | 控制器 | -30..30 | 0 | 否 | **非物理输出**（可普通写入）；外部根输入（physics3 的 Source 侧，非 Output） |
| `AngleZ` | OZ | 控制器 | -30..30 | 0 | 否 | **非物理输出**（可普通写入）；外部根输入（physics3 的 Source 侧，非 Output） |
| `PositionX` | OPX | 控制器 | -30..30 | 0 | 否 | **非物理输出**（可普通写入）；外部根输入（physics3 的 Source 侧，非 Output） |
| `PositionY` | OPY | 控制器 | -30..30 | 0 | 否 | **非物理输出**（可普通写入）；外部根输入（physics3 的 Source 侧，非 Output） |
| `PositionZ` | OPYZ | 控制器 | -30..30 | 0 | 否 | **非物理输出**（可普通写入）；外部根输入（physics3 的 Source 侧，非 Output） |
| `LeanInput` | Lean Input | 控制器 | -30..30 | 0 | 否 | **非物理输出**（可普通写入）；外部根输入（physics3 的 Source 侧，非 Output） |
| `ParamBreath` | 呼吸 |  | 0..1 | 0 | 否 | **非物理输出**（可普通写入）；外部根输入（physics3 的 Source 侧，非 Output） |
| `Clothes1` | 1. 长短裙切换 | 开关 | 0..1 | 1 | 否 | **非物理输出**（可普通写入）；外部根输入（physics3 的 Source 侧，非 Output） |
| `Clothes2` | 2. 大小变 | 开关 | 0..1 | 0 | 否 | **非物理输出**（可普通写入）；外部根输入（physics3 的 Source 侧，非 Output） |
| `Movement1` | 1. 狗尾草 | 开关 | 0..1 | 0 | 否 | **非物理输出**（可普通写入）；外部根输入（physics3 的 Source 侧，非 Output） |
| `Movement2` | 2. 抚胸 | 开关 | 0..1 | 0 | 否 | **非物理输出**（可普通写入）；外部根输入（physics3 的 Source 侧，非 Output） |
| `Movement3` | 3. 竖食指 | 开关 | 0..1 | 0 | 否 | **非物理输出**（可普通写入）；外部根输入（physics3 的 Source 侧，非 Output） |

### 1.3 从清单得到的三条事实

1. **全部手臂美术参数是 -1..1、默认 0**（`RUNTIME`）。这是归一化量纲，不是角度：任何"抬 30 度"的说法在本域不成立。
2. **躯干轴族是 -30..30**（`ParamAngleX/Y/Z`、`ParamBodyAngle*`、`HipAngle*`、`Shoulder*`）——它们既是物理输出（-30..30 的物理角）又是别处的物理输入。
3. **手臂有两层、两套 id**：姿态层 `Param36..43 / 59..62`（-1..1，非物理输出）与美术输出层 `RArm.. / LArm..`（-1..1，物理输出）。两者量纲相同但语义不同，在 moc3 里怎么叠加，仓库无证据（见 §6 UNKNOWN-1）。

---

## 2. 物理输出清单

### 2.1 元数据（`FILE`：physics3.json `Meta`）

| 项 | 值 |
|---|---|
| PhysicsSettingCount | 131 |
| TotalInputCount | 299 |
| TotalOutputCount | 292 |
| VertexCount | 431 |
| Fps | 60（固定步长 = 1/60 s，见 cubismphysics.ts:526-530） |
| 去重后的输出目标 id | **292**（本报告 §2.3 全量列出） |
| 输出目标重复写入 | 0（每个 destination 只被一条 PhysicsSetting 写） |

### 2.2 每条 PhysicsSetting 的 Input → Output 映射（131 条，全量）

`s` = `Scale`，`w` = `Weight`（`Weight<100` 表示与写前值混合，`w0` = 永不生效）。域列为本报告的分类（§3 使用）。

| # | setting | 名称 | 输入（id:权重/类型） | 输出（id ×s w） | 域 |
|---|---|---|---|---|---|
| 1 | PhysicsSetting1 | OX | AngleX(w100,Angle) | ParamAngleX ×28 w100 | 头·朝向（根） |
| 2 | PhysicsSetting2 | OY | AngleY(w100,Angle) | ParamAngleY ×32 w100 | 头·朝向（根） |
| 3 | PhysicsSetting3 | OZ | AngleZ(w100,Angle) | ParamAngleZ ×28 w100 | 头·朝向（根） |
| 4 | PhysicsSetting4 | 身体X | PositionX(w100,Angle) | ParamBodyAngleX ×30 w100 | 躯干·身体轴 |
| 5 | PhysicsSetting5 | Positon | PositionX(w47,Angle)<br>PositionZ(w24,Angle) | ParamBodyAngleRX ×30 w100 | 躯干·身体轴 |
| 6 | PhysicsSetting6 | Lean input | LeanInput(w100,Angle) | Param50 ×1 w100 | 躯干·身体轴 |
| 7 | PhysicsSetting7 | Lean input Shadow | LeanInput(w100,Angle) | Param53 ×1 w100 | 躯干·身体轴 |
| 8 | PhysicsSetting8 | 身体Y | PositionY(w30,Angle)<br>ParamBreath(w2,Angle)<br>LeanInput(w68,Angle) | ParamBodyAngleY ×35 w100 | 躯干·身体轴 |
| 9 | PhysicsSetting9 | 身体Z | PositionZ(w70,Angle)<br>PositionX(w10,X) | ParamBodyAngleZ ×30 w100 | 躯干·身体轴 |
| 10 | PhysicsSetting10 | 肩膀Y | PositionY(w64,X)<br>LeanInput(w30,X) | ShoulderY ×30 w100 | 躯干·身体轴 |
| 11 | PhysicsSetting11 | 肩膀Z | ParamBodyAngleZ(w85,Angle)<br>ParamBodyAngleX(w52,X) | ShoulderZ ×30 w100 | 躯干·身体轴 |
| 12 | PhysicsSetting12 | 盆骨X | PositionX(w100,Angle)<br>PositionZ(w26,X) | HipAngleX ×30 w100 | 盆骨/腿/裙层级 |
| 13 | PhysicsSetting13 | 盆骨X 缓动 | ParamBodyAngleX(w49,X)<br>PositionY(w10,X)<br>PositionZ(w41,X) | HipAngleX2 ×28 w100 | 盆骨/腿/裙层级 |
| 14 | PhysicsSetting14 | 盆骨Y | PositionY(w98,Angle)<br>LeanInput(w0,Angle)<br>ParamBreath(w2,Angle) | HipAngleY ×35 w100 | 盆骨/腿/裙层级 |
| 15 | PhysicsSetting15 | 盆骨Z | ParamBodyAngleX(w20,X)<br>PositionY(w20,X)<br>ParamBodyAngleZ(w100,Angle) | HipAngleZ ×30 w80 | 盆骨/腿/裙层级 |
| 16 | PhysicsSetting16 | 盆骨Z(2) | ParamBodyAngleX(w20,X)<br>PositionY(w20,X)<br>ParamBodyAngleZ(w100,Angle) | ParamHipAngleZ2 ×30 w80 | 盆骨/腿/裙层级 |
| 17 | PhysicsSetting17 | 双腿 Z | HipAngleX(w23,X)<br>PositionZ(w100,Angle) | LEGAngleZ2 ×30 w100 | 盆骨/腿/裙层级 |
| 18 | PhysicsSetting18 | 盆骨Z缓动 | PositionX(w10,X)<br>PositionY(w15,X)<br>HipAngleZ(w47,X)<br>LeanInput(w4,X) | ParamHipAngleZ ×30 w100 | 盆骨/腿/裙层级 |
| 19 | PhysicsSetting19 | 盆骨Z 1 | HipAngleZ(w100,Angle) | HipZ1 ×1 w100 | 盆骨/腿/裙层级 |
| 20 | PhysicsSetting20 | 盆骨Z 2 | ParamBodyAngleZ(w50,X)<br>ParamBodyAngleX(w50,X) | HipZ2 ×1 w100 | 盆骨/腿/裙层级 |
| 21 | PhysicsSetting21 | 身体X左右缓动 | ParamBodyAngleX(w80,X)<br>ParamBodyAngleZ(w20,X) | ParamBodyAngleX2 ×25 w100 | 躯干·身体轴 |
| 22 | PhysicsSetting22 | 身体X上下缓动 | PositionX(w70,X)<br>PositionY(w30,X) | HipAngleYDOWN ×30 w50<br>HipAngleYUP ×30 w14 | 躯干·身体轴 |
| 23 | PhysicsSetting23 | 身体Y缓动 | PositionY(w45,X)<br>PositionZ(w0,X)<br>LeanInput(w11,X) | ParamBodyAngleY2 ×30 w100 | 躯干·身体轴 |
| 24 | PhysicsSetting24 | <眼珠 | ParamEyeROpen(w100,Angle) | REyeball1 ×0.7 w100<br>REyeball2 ×0.4 w100 | 眼 |
| 25 | PhysicsSetting25 | >眼珠 | ParamEyeLOpen(w100,X) | LEyeball1 ×0.8 w100<br>LEyeball2 ×0.8 w100 | 眼 |
| 26 | PhysicsSetting26 | EYE透视Y | ParamEyeBallY(w100,Angle) | PupilY ×1 w100 | 眼 |
| 27 | PhysicsSetting27 | EYE透视X | ParamAngleX(w100,Angle) | PupilX ×1.2 w100 | 眼 |
| 28 | PhysicsSetting28 | <眼眶 | ParamEyeROpen(w50,X)<br>EyeSmile(w21,X) | REyes1 ×0.8 w100<br>REyes2 ×0.8 w100 | 眼 |
| 29 | PhysicsSetting29 | >眼眶 | ParamEyeLOpen(w50,X)<br>EyeSmile(w21,X) | LEyes1 ×0.8 w100<br>LEyes2 ×0.8 w100 | 眼 |
| 30 | PhysicsSetting30 | <睫毛 | ParamEyeROpen(w90,X)<br>EyeSmile(w10,X) | REyeLashX1 ×1 w100<br>REyeLashX2 ×1 w100 | 眼 |
| 31 | PhysicsSetting31 | >睫毛 | ParamEyeLOpen(w90,X)<br>EyeSmile(w10,X) | LEyeLashX1 ×1 w100<br>LEyeLashX2 ×1 w100 | 眼 |
| 32 | PhysicsSetting32 | > 眼球缩放 | ParamEyeLOpen(w80,Angle) | LEyeball3 ×1 w80 | 眼 |
| 33 | PhysicsSetting33 | < 眼球缩放 | ParamEyeROpen(w80,Angle) | REyeball3 ×1 w80 | 眼 |
| 34 | PhysicsSetting34 | >  眉毛上下link | ParamBrowLY(w100,Angle) | ParamBrowLY3 ×1 w100 | 眉/兽耳控制 |
| 35 | PhysicsSetting35 | <  眉毛上下link | ParamBrowRY(w100,Angle) | ParamBrowRY3 ×1 w100 | 眉/兽耳控制 |
| 36 | PhysicsSetting36 | <  眉毛上下 缓动 | ParamBrowRY(w68,X)<br>BrowInnerUp(w13,X)<br>REyeSquint(w19,X) | ParamBrowRY2 ×1 w100 | 眉/兽耳控制 |
| 37 | PhysicsSetting37 | >  眉毛上下 缓动 | ParamBrowLY(w68,X)<br>BrowInnerUp(w13,X)<br>LEyeSquint(w19,X) | ParamBrowLY2 ×1 w100 | 眉/兽耳控制 |
| 38 | PhysicsSetting38 | BrowAngle <<input | ParamBrowRY(w100,Angle)<br>ParamMouthForm(w0,Angle) | ParamBrowRAngleSmoothing ×1 w100 | 眉/兽耳控制 |
| 39 | PhysicsSetting39 | BrowAngle <<output | ParamBrowRAngleSmoothing(w100,Angle) | ParamBrowRAngle ×1 w100 | 眉/兽耳控制 |
| 40 | PhysicsSetting40 | BrowAngle >> | ParamBrowLY(w50,Angle)<br>ParamMouthForm(w50,Angle) | ParamBrowLAngleSmoothing ×1 w100 | 眉/兽耳控制 |
| 41 | PhysicsSetting41 | BrowAngle >>output | ParamBrowLAngleSmoothing(w100,Angle) | ParamBrowLAngle ×1 w100 | 眉/兽耳控制 |
| 42 | PhysicsSetting42 | <  Shock R | ParamBrowRY(w53,Angle)<br>ParamBrowRAngle(w47,Angle) | ShockR ×1 w0 | 眉/兽耳控制 |
| 43 | PhysicsSetting43 | <  Shock L | ParamBrowLY(w53,Angle)<br>ParamBrowLAngle(w47,Angle) | ShockL ×1 w0 | 眉/兽耳控制 |
| 44 | PhysicsSetting44 | L-高光特效 | ParamEyeLOpen(w100,X)<br>ShockL(w0,X) | LHighLight1 ×0.8 w100<br>LHighLight2 ×0.8 w100<br>LHighLight3 ×0.8 w100 | 眼 |
| 45 | PhysicsSetting45 | R-高光特效 | ParamEyeROpen(w87,X)<br>ShockR(w0,X) | RHighLight1 ×0.8 w100<br>RHighLight2 ×0.8 w100<br>RHighLight3 ×0.8 w100 | 眼 |
| 46 | PhysicsSetting46 | 情绪联动 | ParamBrowLY(w33,Angle)<br>ParamBrowRY(w33,Angle)<br>Paramshuiyin7(w33,Angle) | Press ×3 w100 | 脸颊/唇/舌 |
| 47 | PhysicsSetting47 | 脸颊抖动 X | ParamMouthForm(w63,X)<br>CheeckPuff(w37,X) | CheeksWiggleXL ×1.2 w100<br>CheeksWiggleXR ×1.2 w100 | 脸颊/唇/舌 |
| 48 | PhysicsSetting48 | 脸颊抖动 Y | JawOpen(w20,X)<br>Mouthpucker(w19,X)<br>ParamMouthOpenY(w56,X) | CheeksWiggleY ×0.8 w100 | 脸颊/唇/舌 |
| 49 | PhysicsSetting49 | 脸颊抖动 XX | MouthX(w50,X) | CheeksWiggleX ×1 w100 | 脸颊/唇/舌 |
| 50 | PhysicsSetting50 | 前发X | ParamAngleX(w100,X)<br>ParamAngleZ(w52,Angle) | FrontHairX1 ×1 w100<br>FrontHairX2 ×1 w100<br>FrontHairX3 ×1 w100<br>FrontHairX4 ×1 w100 | 头发 |
| 51 | PhysicsSetting51 | 前发Y | ParamBreath(w5,Angle)<br>ParamAngleY(w50,X)<br>Clothes2(w15,X)<br>LeanInput(w35,X) | FrontHairY1 ×1 w100<br>FrontHairY2 ×1 w100<br>FrontHairY3 ×1 w100<br>FrontHairY4 ×1 w100 | 头发 |
| 52 | PhysicsSetting52 | 侧发R | ParamBreath(w10,Angle)<br>AngleX(w24,X)<br>AngleY(w20,X)<br>AngleZ(w29,Angle) | SideHairRX1 ×8.509 w100<br>SideHairRX2 ×8.954 w80<br>SideHairRX3 ×8.279 w100<br>SideHairRBS ×6.918 w100 | 头发 |
| 53 | PhysicsSetting53 | 侧发L | ParamBodyAngleRX(w30,X)<br>ParamBreath(w10,Angle) | SideHairLX1 ×3.465 w100<br>SideHairLX2 ×2.201 w80<br>SideHairLX3 ×1.88 w100<br>SideHairLBS ×2.201 w100 | 头发 |
| 54 | PhysicsSetting54 | 侧发X | ParamAngleX(w100,X)<br>ParamAngleZ(w60,Angle) | SideHairX1 ×0.7 w100<br>SideHairX2 ×0.7 w100<br>SideHairX3 ×0.7 w100<br>SideHairX4 ×0.7 w100 | 头发 |
| 55 | PhysicsSetting55 | 侧发Y | ParamBreath(w40,Angle)<br>AngleY(w55,X)<br>Clothes2(w15,X)<br>LeanInput(w30,X) | SideHairY1 ×0.9 w100<br>SideHairY2 ×0.9 w100<br>SideHairY3 ×0.9 w100<br>SideHairY4 ×0.9 w100 | 头发 |
| 56 | PhysicsSetting56 | 后侧发R | ParamBreath(w6,Angle)<br>AngleX(w53,Angle)<br>AngleY(w41,Angle)<br>AngleZ(w51,X) | LateSideHairY1 ×1 w100<br>LateSideHairY2 ×1 w100<br>LateSideHairY3 ×1 w100<br>LateSideHairY4 ×0.8 w100<br>LateSideHairY5 ×0.8 w100 | 头发 |
| 57 | PhysicsSetting57 | 后侧发L | ParamBreath(w10,Angle)<br>AngleX(w50,X)<br>AngleY(w30,X)<br>AngleZ(w26,Angle) | LateSideHairX1 ×1.2 w100<br>LateSideHairX2 ×1 w100<br>LateSideHairX3 ×1 w100<br>LateSideHairX4 ×1 w100<br>LateSideHairX5 ×1 w100 | 头发 |
| 58 | PhysicsSetting58 | 后发 Z | ParamAngleZ(w100,Angle) | LateHairZ ×30 w100 | 头发 |
| 59 | PhysicsSetting59 | 后发X | ParamAngleX(w80,X)<br>ParamAngleZ(w40,Angle) | LateHairX1 ×1 w100<br>LateHairX2 ×1 w100<br>LateHairX3 ×0.8 w100<br>LateHairX4 ×0.8 w100<br>LateHairX5 ×0.8 w100 | 头发 |
| 60 | PhysicsSetting60 | 短后发X | AngleX(w100,X)<br>AngleZ(w60,Angle) | ShortPonytailX1 ×1 w100<br>ShortPonytailX2 ×1 w100<br>ShortPonytailXBS ×1 w100<br>ShortPonytailXBS2 ×1 w100 | 头发 |
| 61 | PhysicsSetting61 | 后发Y | ParamBreath(w26,Angle)<br>AngleY(w70,X)<br>Clothes2(w15,X)<br>LeanInput(w15,X) | LateHairY1 ×1 w100<br>LateHairY2 ×1 w100<br>LateHairY3 ×1 w100<br>LateHairY4 ×1 w100<br>LateHairY5 ×1 w100 | 头发 |
| 62 | PhysicsSetting62 | 短后发Y | ParamBreath(w5,Angle)<br>AngleY(w80,X)<br>Clothes1(w20,X) | ShortPonytailY ×1 w100<br>ShortPonytailY2 ×1 w100<br>ShortPonytailYBS ×1 w100<br>ShortPonytailYBS2 ×1 w100 | 头发 |
| 63 | PhysicsSetting63 | 闪光 | ParamBreath(w38,Angle) | Shine ×1.712 w100<br>ShineX ×47.049 w100<br>ShineBIG ×46.024 w100 | 闪光/宝石/透视 |
| 64 | PhysicsSetting64 | 胸X | ParamBodyAngleX(w80,X)<br>ParamBodyAngleZ(w20,X) | ChestX1 ×1 w100<br>ChestX2 ×0.9 w100<br>ChestX3 ×0.5 w100<br>ChestXBS ×0.5 w100 | 胸 |
| 65 | PhysicsSetting65 | 胸Y | ParamBreath(w10,Angle)<br>PositionY(w92,X)<br>ParamBodyAngleZ(w0,X)<br>LeanInput(w8,X) | ChestY1 ×1 w100<br>ChestY2 ×1 w100<br>ChestY3 ×1 w100 | 胸 |
| 66 | PhysicsSetting66 | 胸Y ↓ | ParamBreath(w0,Angle)<br>PositionY(w60,X)<br>LeanInput(w40,X) | ChestY4 ×1 w100 | 胸 |
| 67 | PhysicsSetting67 | 裙子X 摆动 | HipAngleX(w50,X)<br>ParamBodyAngleZ(w25,X) | SkirtX1 ×1 w100<br>SkirtX2 ×1 w100<br>SkirtX3 ×0.8 w100<br>SkirtX4 ×0.8 w100<br>SkirtSpecial ×1 w100<br>SkirtSpecial2 ×1 w100 | 裙 |
| 68 | PhysicsSetting68 | 裙子Y | PositionY(w40,X)<br>ParamBreath(w3,Angle)<br>LeanInput(w20,X)<br>Clothes1(w20,X) | SkirtY ×1 w100<br>SkirtY2 ×1 w100<br>SkirtY3 ×1 w100<br>SkirtYBS ×1 w30<br>SkirtY4 ×1 w100<br>SkirtY5 ×1 w100 | 裙 |
| 69 | PhysicsSetting69 | 裙子Y(2) | PositionY(w30,X)<br>ParamBreath(w3,Angle)<br>LeanInput(w20,X)<br>Clothes1(w21,X) | SkirtY6 ×1 w100<br>SkirtY7 ×1 w100<br>SkirtY9 ×0.6 w100<br>SkirtY8 ×0.5 w100 | 裙 |
| 70 | PhysicsSetting70 | 裙子层级 X | HipAngleZ(w0,Angle)<br>HipAngleX(w50,X) | SkirtLayerX1 ×1 w100<br>SkirtLayerX2 ×1 w100<br>SkirtLayerX3 ×1 w100<br>SkirtLayerX4 ×1 w100<br>SkirtLayerX5 ×1 w100<br>SkirtLayerX6 ×1 w100 | 裙 |
| 71 | PhysicsSetting71 | 裙子层级 Y | HipAngleY(w100,X) | SkirtLayerY1 ×1 w100<br>SkirtLayerY2 ×1 w100<br>SkirtLayerY3 ×1 w100<br>SkirtLayerY4 ×1 w100<br>SkirtLayerY5 ×1 w100 | 裙 |
| 72 | PhysicsSetting72 | 左臂 | PositionY(w48,X)<br>ParamBreath(w5,Angle)<br>ParamBodyAngleX(w52,X)<br>ParamBodyAngleZ(w10,Angle) | LArm ×1 w60<br>LForearm ×1 w100<br>LWrist ×1 w100 | 左臂（叶子） |
| 73 | PhysicsSetting73 | 右臂 | PositionY(w48,X)<br>ParamBreath(w5,Angle)<br>ParamBodyAngleX(w52,X)<br>ParamBodyAngleZ(w10,Angle) | RArm ×1 w60<br>RForearm ×1 w100<br>RWrist ×1 w100 | 右臂（叶子） |
| 74 | PhysicsSetting74 | 左手 | PositionX(w48,Angle)<br>PositionY(w37,X)<br>PositionZ(w0,Angle) | LHand ×1 w100<br>LHand2 ×1 w100 | 左臂（叶子） |
| 75 | PhysicsSetting75 | 右手 | PositionX(w48,Angle)<br>PositionY(w37,X)<br>PositionZ(w0,Angle) | RHand ×1 w100<br>RHand2 ×1 w100 | 右臂（叶子） |
| 76 | PhysicsSetting76 | 左袖子 X | ParamBreath(w5,Angle)<br>ParamBodyAngleX(w73,X)<br>ParamBodyAngleZ(w20,Angle) | LSleeveX1 ×1 w100<br>LSleeveX2 ×1 w100<br>LSleeveX3 ×1 w100 | 左臂（叶子） |
| 77 | PhysicsSetting77 | 左袖子 Y | ParamBreath(w5,Angle)<br>PositionY(w73,X) | LSleeveY ×1 w100<br>LSleeveY2 ×1 w100<br>LSleeveY3 ×1 w100 | 左臂（叶子） |
| 78 | PhysicsSetting78 | 右袖子 X | ParamBreath(w5,Angle)<br>ParamBodyAngleX(w73,X)<br>ParamBodyAngleZ(w20,Angle) | RSleeveX1 ×1 w100<br>RSleeveX2 ×1 w100<br>RSleeveX3 ×1 w100 | 右臂（叶子） |
| 79 | PhysicsSetting79 | 右袖子 Y | ParamBreath(w5,Angle)<br>ParamBodyAngleY(w73,X) | RSleeveY1 ×1 w100<br>RSleeveY2 ×1 w100<br>RSleeveY3 ×1 w100 | 右臂（叶子） |
| 80 | PhysicsSetting80 | 右飘带 | ParamBodyAngleX(w34,X)<br>PositionY(w31,X)<br>PositionZ(w22,X) | RRibbonX1 ×1 w100<br>RRibbonX2 ×1 w100<br>RRibbonX3 ×1 w100<br>RRibbonX4 ×1 w100 | 右臂（叶子） |
| 81 | PhysicsSetting81 | 左飘带 | ParamBodyAngleX(w34,X)<br>PositionY(w31,X)<br>PositionZ(w22,X) | LRibbonX1 ×1 w100<br>LRibbonX2 ×1 w100<br>LRibbonX3 ×1 w100<br>LRibbonX4 ×1 w100 | 左臂（叶子） |
| 82 | PhysicsSetting82 | <-兽耳Conrol OUT | ParamBrowRY(w100,Angle) | LControl ×1 w100 | 眉/兽耳控制 |
| 83 | PhysicsSetting83 | <-兽耳 PH | LControl(w30,X)<br>AngleX(w20,X)<br>AngleY(w15,X)<br>AngleZ(w27,Angle)<br>ParamBreath(w3,Angle)<br>ParamEyeROpen(w35,X) | LEar1 ×1 w100<br>LEar2 ×1 w100<br>LEar3 ×1 w100 | 兽耳 |
| 84 | PhysicsSetting84 | >-兽耳Conrol OUT | ParamBrowLY(w100,Angle) | RControl ×1 w100 | 眉/兽耳控制 |
| 85 | PhysicsSetting85 | >-兽耳 PH | RControl(w30,X)<br>AngleX(w20,X)<br>AngleY(w15,X)<br>AngleZ(w27,Angle)<br>ParamBreath(w3,Angle)<br>ParamEyeLOpen(w35,X) | REar1 ×1 w100<br>REar2 ×1 w100<br>REar3 ×1 w100 | 兽耳 |
| 86 | PhysicsSetting86 | < 兽耳 Flip a | LControl(w0,Angle)<br>ParamAngleX(w50,Angle) | RFlip ×2 w100 | 兽耳 |
| 87 | PhysicsSetting87 | > 兽耳 Flip a | RControl(w0,Angle)<br>ParamAngleX(w50,Angle) | LFlip ×2 w100 | 兽耳 |
| 88 | PhysicsSetting88 | < 兽耳 Flip b | ParamAngleY(w50,Angle)<br>LControl(w50,Angle) | RFlip2 ×2 w100 | 兽耳 |
| 89 | PhysicsSetting89 | > 兽耳 Flip b | ParamAngleY(w50,Angle)<br>RControl(w50,Angle) | LFlip2 ×2 w100 | 兽耳 |
| 90 | PhysicsSetting90 | Lip PH | ParamMouthForm(w60,X)<br>ParamMouthOpenY(w40,X) | LipPhysics1 ×1 w100<br>LipPhysics2 ×1 w100<br>LipPhysics3 ×1 w100 | 脸颊/唇/舌 |
| 91 | PhysicsSetting91 | 鼓脸 | CheeckPuff(w100,Angle) | CheeckPuffR ×1 w100<br>CheeckPuffL ×1 w100 | 脸颊/唇/舌 |
| 92 | PhysicsSetting92 | 鼓脸-附带效果 | CheeckPuff(w100,Angle) | CheeckPuff2 ×1 w100 | 脸颊/唇/舌 |
| 93 | PhysicsSetting93 | 花边 < | ParamBodyAngleX(w65,X)<br>PositionY(w25,X)<br>ParamBodyAngleZ(w50,Angle)<br>LeanInput(w10,X) | LaceRX ×1.2 w100<br>LaceRX2 ×1.2 w100<br>LaceRX3 ×1.2 w100 | 外套花边 |
| 94 | PhysicsSetting94 | 花边 > | ParamBodyAngleX(w65,X)<br>PositionY(w25,X)<br>ParamBodyAngleZ(w50,Angle)<br>LeanInput(w10,X) | LaceLX1 ×1 w100<br>LaceLX2 ×1 w100<br>LaceLX3 ×1 w100 | 外套花边 |
| 95 | PhysicsSetting95 | < 头配饰 | ParamBreath(w5,Angle)<br>ParamAngleX(w52,X)<br>ParamAngleY(w48,X)<br>ParamAngleZ(w40,Angle) | RBowX1 ×1.2 w100<br>RBowX2 ×1 w100<br>RBowX3 ×1 w100<br>RBowX4 ×1 w100 | 头配饰 |
| 96 | PhysicsSetting96 | < 头配饰 长 | ParamBreath(w5,Angle)<br>ParamAngleX(w52,X)<br>ParamAngleY(w48,X)<br>ParamAngleZ(w40,Angle) | RBowX8 ×1 w100<br>RBowX5 ×1 w100<br>RBowX6 ×1 w100<br>RBowX7 ×1 w100 | 头配饰 |
| 97 | PhysicsSetting97 | > 头配饰 | ParamBreath(w5,Angle)<br>ParamAngleX(w52,X)<br>ParamAngleY(w48,X)<br>ParamAngleZ(w40,Angle) | LBowX1 ×1.5 w100<br>LowX2 ×1 w100<br>LBowX3 ×1 w100<br>LBowX4 ×1 w100 | 头配饰 |
| 98 | PhysicsSetting98 | XBS | AngleX(w100,Angle) | AngleXbs ×30 w100<br>PoutOffsetXL ×30 w100<br>PoutOffsetXR ×30 w100 | 闪光/宝石/透视 |
| 99 | PhysicsSetting99 | YBS | AngleY(w100,Angle) | AngleYbs ×30 w100 | 闪光/宝石/透视 |
| 100 | PhysicsSetting100 | Emotion 过渡 | ParamBrowRY(w30,Angle)<br>ParamBrowLY(w30,Angle)<br>ParamMouthForm(w20,Angle) | Emotion2 ×1 w100 | 情绪 |
| 101 | PhysicsSetting101 | Emotion | Emotion2(w100,Angle) | Emotion ×1 w100 | 情绪 |
| 102 | PhysicsSetting102 | 光效A-眨眼 | ParamEyeROpen(w100,Angle) | RParamGlowA ×1 w100 | 眼 |
| 103 | PhysicsSetting103 | 光效A-眨眼 L | ParamEyeLOpen(w100,Angle) | LParamGlowA ×1 w100 | 眼 |
| 104 | PhysicsSetting104 | 光效B-X | AngleY(w40,Angle)<br>ParamEyeBallX(w0,Angle)<br>ParamEyeBallY(w60,Angle) | RParamGlowB ×1 w100<br>LParamGlowB ×1 w100 | 眼 |
| 105 | PhysicsSetting105 | 光效C-y | AngleY(w57,Angle)<br>ParamEyeBallY(w38,Angle) | RParamGlowC ×0.8 w100 | 眼 |
| 106 | PhysicsSetting106 | 舌头-开闭 | ParamMouthOpenY(w100,X) | ParamTongueUpDown ×1 w100 | 脸颊/唇/舌 |
| 107 | PhysicsSetting107 | 舌头-开闭(2) | ParamMouthOpenY(w68,X)<br>ParamMouthForm(w32,X) | ParamTongueWidth ×1 w100 | 脸颊/唇/舌 |
| 108 | PhysicsSetting108 | 闪光 1 | ParamBreath(w30,X)<br>ParamAngleX(w19,X)<br>ParamAngleY(w20,X)<br>ParamAngleZ(w26,X) | KiraA ×3 w100<br>KiraB ×1 w100 | 闪光/宝石/透视 |
| 109 | PhysicsSetting109 | 闪光 2 | ParamBreath(w35,X)<br>ParamAngleX(w19,X)<br>ParamAngleY(w20,X)<br>ParamAngleZ(w26,X) | KiraC ×1.5 w100<br>KiraD ×1.5 w100 | 闪光/宝石/透视 |
| 110 | PhysicsSetting110 | 耳环> | ParamAngleX(w62,X)<br>ParamAngleY(w22,X)<br>ParamAngleZ(w56,Angle) | LJewelry1 ×1 w100<br>LJewelry2 ×1 w100<br>LJewelry3 ×1 w100 | 头配饰 |
| 111 | PhysicsSetting111 | 耳环< | ParamAngleX(w62,X)<br>ParamAngleY(w22,X)<br>ParamAngleZ(w56,Angle) | RJewelry1 ×1 w100<br>RJewelry2 ×1 w100<br>RJewelry3 ×1 w100 | 头配饰 |
| 112 | PhysicsSetting112 | 宝石反光-闪烁 | ParamBodyAngleX(w45,Angle)<br>ParamBodyAngleY(w45,Angle)<br>ParamBodyAngleZ(w10,Angle) | GemReflection ×2 w100 | 闪光/宝石/透视 |
| 113 | PhysicsSetting113 | 宝石高光-追踪 X | ParamBodyAngleX(w80,Angle) | GemHighlightx ×1 w100 | 闪光/宝石/透视 |
| 114 | PhysicsSetting114 | 宝石高光-追踪 Y | ParamBodyAngleY(w80,Angle) | GemHighlighty ×1 w100 | 闪光/宝石/透视 |
| 115 | PhysicsSetting115 | 头缎带 x | ParamAngleX(w80,X)<br>ParamAngleZ(w60,Angle) | ribbonX1 ×1 w100<br>ribbonX2 ×1 w100<br>ribbonX3 ×1 w100<br>ribbonX4 ×1 w100 | 头配饰 |
| 116 | PhysicsSetting116 | 头缎带 Y | ParamAngleY(w84,X)<br>ParamBreath(w5,Angle) | ribbonY1 ×1 w100<br>ribbonY2 ×1 w100<br>ribbonY3 ×1 w100<br>ribbonY4 ×1 w100 | 头配饰 |
| 117 | PhysicsSetting117 | 帽子 X | ParamAngleX(w84,X)<br>ParamAngleZ(w31,Angle) | Hat_XA ×1 w100<br>Hat_XB ×1 w100<br>Hat_XC ×1 w100 | 头配饰 |
| 118 | PhysicsSetting118 | 帽子 Y | ParamAngleY(w70,X)<br>Clothes2(w15,X)<br>LeanInput(w15,X) | Hat_YA ×1 w100<br>Hat_YB ×1 w100<br>Hat_YC ×1 w100 | 头配饰 |
| 119 | PhysicsSetting119 | 帽子蕾丝边 X | ParamAngleX(w48,X)<br>ParamAngleZ(w18,Angle) | ribbonX5 ×1 w100<br>ribbonX7 ×1 w100<br>ribbonX6 ×1 w100 | 头配饰 |
| 120 | PhysicsSetting120 | 帽子蕾丝边 Y | ParamAngleY(w80,X) | ribbonY5 ×1 w100<br>ribbonY6 ×1 w100<br>ribbonY7 ×1 w100 | 头配饰 |
| 121 | PhysicsSetting121 | 帽子尖 ph | ParamAngleX(w45,X)<br>ParamAngleY(w45,X)<br>ParamAngleZ(w80,Angle) | Hat2pha ×1 w100<br>Hat2phB ×1 w100<br>Hat2phC ×1 w100<br>Hat2phD ×1.5 w100 | 头配饰 |
| 122 | PhysicsSetting122 | 外套花边XZ | ParamBodyAngleX(w80,X)<br>ParamBodyAngleZ(w50,Angle) | LaceX1 ×1 w100<br>LaceX2 ×1 w100<br>LaceX3 ×1 w100 | 外套花边 |
| 123 | PhysicsSetting123 | 外套花边Y | ParamBodyAngleY(w80,X) | LaceY1 ×1 w100<br>LaceY2 ×1 w100<br>LaceY3 ×1 w100 | 外套花边 |
| 124 | PhysicsSetting124 | 动作手 Z | ParamBodyAngleZ(w100,Angle) | Param25 ×1 w100 | 动作手/开关（手臂次级） |
| 125 | PhysicsSetting125 | Lean 缓动 | LeanInput(w100,Angle) | Param54 ×1 w100 | 动作手/开关（手臂次级） |
| 126 | PhysicsSetting126 | 并腿 | HipAngleX(w100,Angle) | Param33 ×1 w100 | 盆骨/腿/裙层级 |
| 127 | PhysicsSetting127 | 大小变透明参数 | Clothes2(w100,Angle) | Param34 ×500 w100 | 动作手/开关（手臂次级） |
| 128 | PhysicsSetting128 | 手臂开关物理 | Movement1(w30,X)<br>Movement2(w30,X)<br>Movement3(w30,X) | Param35 ×1 w100 | 动作手/开关（手臂次级） |
| 129 | PhysicsSetting129 | 左臂z | ParamBodyAngleZ(w100,Angle) | Param44 ×1 w100 | 动作手/开关（手臂次级） |
| 130 | PhysicsSetting130 | 尾巴 | ParamBreath(w15,Angle)<br>ParamBodyAngleX(w40,Angle)<br>ParamBodyAngleZ(w30,Angle)<br>LeanInput(w40,X)<br>Clothes2(w30,X) | Param_Angle_Rotation84 ×15 w100<br>Param_Angle_Rotation85 ×20 w100<br>Param_Angle_Rotation86 ×30 w100<br>Param_Angle_Rotation87 ×30 w100<br>Param_Angle_Rotation88 ×30 w100<br>Param52 ×1 w100<br>Param_Angle_Rotation89 ×30 w100 | 尾巴/草 |
| 131 | PhysicsSetting131 | 狗尾巴物理 | Param42(w50,X)<br>ParamBodyAngleX(w20,X)<br>ParamBodyAngleY(w20,X)<br>ParamBodyAngleZ(w10,X) | Param45 ×1 w100<br>Param46 ×1 w100<br>Param47 ×1 w100<br>Param48 ×1 w100<br>Param49 ×1 w100 | 尾巴/草 |

### 2.3 physics 输出 id 精确集合（292 个，去重）

G1 的 `canOwn` 白名单必须**恰好**是下面这个集合（按 physics3 原样，不做任何补充/推测）：

```text
AngleXbs, AngleYbs, CheeckPuff2, CheeckPuffL, CheeckPuffR, CheeksWiggleX,
CheeksWiggleXL, CheeksWiggleXR, CheeksWiggleY, ChestX1, ChestX2, ChestX3,
ChestXBS, ChestY1, ChestY2, ChestY3, ChestY4, Emotion,
Emotion2, FrontHairX1, FrontHairX2, FrontHairX3, FrontHairX4, FrontHairY1,
FrontHairY2, FrontHairY3, FrontHairY4, GemHighlightx, GemHighlighty, GemReflection,
Hat2phB, Hat2phC, Hat2phD, Hat2pha, Hat_XA, Hat_XB,
Hat_XC, Hat_YA, Hat_YB, Hat_YC, HipAngleX, HipAngleX2,
HipAngleY, HipAngleYDOWN, HipAngleYUP, HipAngleZ, HipZ1, HipZ2,
KiraA, KiraB, KiraC, KiraD, LArm, LBowX1,
LBowX3, LBowX4, LControl, LEGAngleZ2, LEar1, LEar2,
LEar3, LEyeLashX1, LEyeLashX2, LEyeball1, LEyeball2, LEyeball3,
LEyes1, LEyes2, LFlip, LFlip2, LForearm, LHand,
LHand2, LHighLight1, LHighLight2, LHighLight3, LJewelry1, LJewelry2,
LJewelry3, LParamGlowA, LParamGlowB, LRibbonX1, LRibbonX2, LRibbonX3,
LRibbonX4, LSleeveX1, LSleeveX2, LSleeveX3, LSleeveY, LSleeveY2,
LSleeveY3, LWrist, LaceLX1, LaceLX2, LaceLX3, LaceRX,
LaceRX2, LaceRX3, LaceX1, LaceX2, LaceX3, LaceY1,
LaceY2, LaceY3, LateHairX1, LateHairX2, LateHairX3, LateHairX4,
LateHairX5, LateHairY1, LateHairY2, LateHairY3, LateHairY4, LateHairY5,
LateHairZ, LateSideHairX1, LateSideHairX2, LateSideHairX3, LateSideHairX4, LateSideHairX5,
LateSideHairY1, LateSideHairY2, LateSideHairY3, LateSideHairY4, LateSideHairY5, LipPhysics1,
LipPhysics2, LipPhysics3, LowX2, Param25, Param33, Param34,
Param35, Param44, Param45, Param46, Param47, Param48,
Param49, Param50, Param52, Param53, Param54, ParamAngleX,
ParamAngleY, ParamAngleZ, ParamBodyAngleRX, ParamBodyAngleX, ParamBodyAngleX2, ParamBodyAngleY,
ParamBodyAngleY2, ParamBodyAngleZ, ParamBrowLAngle, ParamBrowLAngleSmoothing, ParamBrowLY2, ParamBrowLY3,
ParamBrowRAngle, ParamBrowRAngleSmoothing, ParamBrowRY2, ParamBrowRY3, ParamHipAngleZ, ParamHipAngleZ2,
ParamTongueUpDown, ParamTongueWidth, Param_Angle_Rotation84, Param_Angle_Rotation85, Param_Angle_Rotation86, Param_Angle_Rotation87,
Param_Angle_Rotation88, Param_Angle_Rotation89, PoutOffsetXL, PoutOffsetXR, Press, PupilX,
PupilY, RArm, RBowX1, RBowX2, RBowX3, RBowX4,
RBowX5, RBowX6, RBowX7, RBowX8, RControl, REar1,
REar2, REar3, REyeLashX1, REyeLashX2, REyeball1, REyeball2,
REyeball3, REyes1, REyes2, RFlip, RFlip2, RForearm,
RHand, RHand2, RHighLight1, RHighLight2, RHighLight3, RJewelry1,
RJewelry2, RJewelry3, RParamGlowA, RParamGlowB, RParamGlowC, RRibbonX1,
RRibbonX2, RRibbonX3, RRibbonX4, RSleeveX1, RSleeveX2, RSleeveX3,
RSleeveY1, RSleeveY2, RSleeveY3, RWrist, Shine, ShineBIG,
ShineX, ShockL, ShockR, ShortPonytailX1, ShortPonytailX2, ShortPonytailXBS,
ShortPonytailXBS2, ShortPonytailY, ShortPonytailY2, ShortPonytailYBS, ShortPonytailYBS2, ShoulderY,
ShoulderZ, SideHairLBS, SideHairLX1, SideHairLX2, SideHairLX3, SideHairRBS,
SideHairRX1, SideHairRX2, SideHairRX3, SideHairX1, SideHairX2, SideHairX3,
SideHairX4, SideHairY1, SideHairY2, SideHairY3, SideHairY4, SkirtLayerX1,
SkirtLayerX2, SkirtLayerX3, SkirtLayerX4, SkirtLayerX5, SkirtLayerX6, SkirtLayerY1,
SkirtLayerY2, SkirtLayerY3, SkirtLayerY4, SkirtLayerY5, SkirtSpecial, SkirtSpecial2,
SkirtX1, SkirtX2, SkirtX3, SkirtX4, SkirtY, SkirtY2,
SkirtY3, SkirtY4, SkirtY5, SkirtY6, SkirtY7, SkirtY8,
SkirtY9, SkirtYBS, ribbonX1, ribbonX2, ribbonX3, ribbonX4,
ribbonX5, ribbonX6, ribbonX7, ribbonY1, ribbonY2, ribbonY3,
ribbonY4, ribbonY5, ribbonY6, ribbonY7
```

### 2.4 每帧写还是初始化写？—— 每帧写，缓冲后直写

| 问题 | 答案 | 证据 |
|---|---|---|
| 输出是否每帧写 | 是。`evaluate()` 每帧调用；`deltaTime<=0` 才 return | `cubismphysics.ts:486-499` |
| 是否只初始化写一次 | 否。没有"只在 load 时写一次"的分支；每次 `interpolate()` 都覆盖 `parameterValues` | `cubismphysics.ts:714-778` |
| 直写还是缓冲 | **两级**：先写 `_parameterCaches`（组间传播缓冲，`cubismphysics.ts:683-698`），再经 `interpolate()` 写 `model.parameters.values`（`:775`） | 同上 |
| 写入是否走 `setParameterValueById` | 否。物理直接改参数数组，绕过 CubismModel 的 setter 与注入器 | `cubismphysics.ts:717,775` |
| 帧内位置 | `LAppModel.update()` → `updateScheduler.onLateUpdate()`（order 600）→ `CubismPhysicsUpdater.onLateUpdate` → `physics.evaluate` | `lappmodel.ts:668`、`cubismphysicsupdater.ts:45-51`、`icubismupdater.ts:27` |

补充事实（`FILE` / `DERIVED`）：

- **无死输出**：292 个输出的 `VertexIndex` 全部落在 `1..particleCount-1`，不会命中 `cubismphysics.ts:634-639` 的 `continue`。
- **两个永不生效的输出**：`ShockR`（`PhysicsSetting42`）、`ShockL`（`PhysicsSetting43`）的 `Weight=0`，`updateOutputParameterValue` 走 `weight<1` 分支后保留原值（`cubismphysics.ts:1290-1297`）→ 写入等于不写。它们仍在 292 集合内，`canOwn` 会放行，但独占是空操作。
- **11 个部分混合输出**（`Weight<100`）：`HipAngleZ`(80)、`ParamHipAngleZ2`(80)、`HipAngleYUP`(14)、`HipAngleYDOWN`(50)、`LEyeball3`(80)、`REyeball3`(80)、`SideHairRX2`(80)、`SideHairLX2`(80)、`SkirtYBS`(30)、**`LArm`(60)**、**`RArm`(60)**。手臂大臂只吸收物理位移的 60%，其余 40% 保留写前值——这直接决定了 §4 的"释放后恢复是否平滑"。

### 2.5 每帧时序上的实际写入点（一句话版）

`saveParameters` 之后 → pre 钩子（可改写根输入/登记让位）→ **物理 600**（读参数数组 + 缓存 → 算振子 → 写缓存 → 插值写参数数组，让位表内的 id 跳过）→ post 钩子（可覆盖）→ `model.update()` 绘制。

---

## 3. 身体部位 → 参数域映射

### 3.1 按部位拆

"根输入"是 physics3 `Input.Source.Id` 中那些**不是**物理输出的 id（可外部直写、pre 相位生效）；"本域物理输出"是本部位专属的输出 id；"下游规模"是从本域输出出发可达的其他输出数量（`DERIVED`）。

| 部位 | 根输入（可直写，pre） | 本域物理输出 | 姿态/可写参数（非物理输出） | 下游输出数 |
|---|---|---|---|---|
| **右臂** | `PositionY`(w48)、`ParamBreath`(w5)、`ParamBodyAngleX`(w52)、`ParamBodyAngleZ`(w10)（全是共享量，无手臂专属根输入） | `RArm`、`RForearm`、`RWrist`、`RHand`、`RHand2`、`RSleeveX1-3`、`RSleeveY1-3`、`RRibbonX1-4`（15 个） | `Param36`(R大臂z)、`Param39`(大臂透视)、`Param40`(竖手指无缝)、`Param41`(R小臂Z)、`Param42`(R手腕Z)、`Param43`(R食指)、`RSleeveX4`、`RRibbonY1-4`、`Param38`(双手开关) | **0**（`RArm` 族、袖子、飘带全部 0 下游） |
| **左臂** | 同上（`PositionY`/`ParamBreath`/`ParamBodyAngleX`/`ParamBodyAngleZ`，无专属根输入） | `LArm`、`LForearm`、`LWrist`、`LHand`、`LHand2`、`LSleeveX1-3`、`LSleeveY`/`LSleeveY2`/`LSleeveY3`、`LRibbonX1-4`（15 个） | `Param59`(大臂透视)、`Param60`(L小臂Z)、`Param61`(L手腕Z)、`Param62`(L大臂z)、`LRibbonY1-4` | **0** |
| **躯干（上身）** | `PositionX`、`PositionY`、`PositionZ`、`LeanInput`、`ParamBreath` | `ParamBodyAngleX/Y/Z`、`ParamBodyAngleX2/Y2`、`ParamBodyAngleRX`、`ParamBodyAngleX/Y/Z`、`ParamBodyAngleX2/Y2`、`ParamBodyAngleRX`、`ShoulderY`、`ShoulderZ`、`HipAngleYUP/DOWN`（12 个） | `ShoulderX`、`ShoulderYy`、`ParamBodyAngleRY/RZ`（非物理输出） | `ParamBodyAngleX`→61、`ParamBodyAngleZ`→62、`ParamBodyAngleY`→13；`ShoulderY/Z`→0 |
| **盆骨/腿** | 同上（无独立根输入） | `HipAngleX/Y/Z`、`HipAngleX2`、`ParamHipAngleZ`、`ParamHipAngleZ2`、`HipZ1`、`HipZ2`、`HipAngleYUP/DOWN`、`LEGAngleZ2`、`Param33`（10 个） | 无（`HipAngleXq` 既非输出也非输入） | `HipAngleX`→14、`HipAngleZ`→8、`HipAngleY`→5 |
| **头** | `AngleX`、`AngleY`、`AngleZ` | `ParamAngleX`、`ParamAngleY`、`ParamAngleZ`（3 个） | 无（头只能从根输入驱动） | `ParamAngleX`→52、`ParamAngleY`→42、`ParamAngleZ`→50 |

> 关于"下游输出数"的口径：包含**所有**传递可达的物理输出（含头发/帽子/耳环/兽耳/宝石等饰品），不是"部位内的输出"。这就是"共享域"的量化形式。

### 3.2 按域列物理输出 id（供 canOwn 按域取集）

| 域 | PhysicsSetting | 输出 id |
|---|---|---|
| 头·朝向（根） | 1、2、3 | `ParamAngleX`、`ParamAngleY`、`ParamAngleZ` |
| 躯干·身体轴 | 4、5、6、7、8、9、10、11、21、22、23 | `ParamBodyAngleX`、`ParamBodyAngleRX`、`Param50`、`Param53`、`ParamBodyAngleY`、`ParamBodyAngleZ`、`ShoulderY`、`ShoulderZ`、`ParamBodyAngleX2`、`HipAngleYDOWN`、`HipAngleYUP`、`ParamBodyAngleY2` |
| 盆骨/腿/裙层级 | 12、13、14、15、16、17、18、19、20、126 | `HipAngleX`、`HipAngleX2`、`HipAngleY`、`HipAngleZ`、`ParamHipAngleZ2`、`LEGAngleZ2`、`ParamHipAngleZ`、`HipZ1`、`HipZ2`、`Param33` |
| 眼 | 24、25、26、27、28、29、30、31、32、33、44、45、102、103、104、105 | `REyeball1`、`REyeball2`、`LEyeball1`、`LEyeball2`、`PupilY`、`PupilX`、`REyes1`、`REyes2`、`LEyes1`、`LEyes2`、`REyeLashX1`、`REyeLashX2`、`LEyeLashX1`、`LEyeLashX2`、`LEyeball3`、`REyeball3`、`LHighLight1`、`LHighLight2`、`LHighLight3`、`RHighLight1`、`RHighLight2`、`RHighLight3`、`RParamGlowA`、`LParamGlowA`、`RParamGlowB`、`LParamGlowB`、`RParamGlowC` |
| 眉/兽耳控制 | 34、35、36、37、38、39、40、41、42、43、82、84 | `ParamBrowLY3`、`ParamBrowRY3`、`ParamBrowRY2`、`ParamBrowLY2`、`ParamBrowRAngleSmoothing`、`ParamBrowRAngle`、`ParamBrowLAngleSmoothing`、`ParamBrowLAngle`、`ShockR`、`ShockL`、`LControl`、`RControl` |
| 脸颊/唇/舌 | 46、47、48、49、90、91、92、106、107 | `Press`、`CheeksWiggleXL`、`CheeksWiggleXR`、`CheeksWiggleY`、`CheeksWiggleX`、`LipPhysics1`、`LipPhysics2`、`LipPhysics3`、`CheeckPuffR`、`CheeckPuffL`、`CheeckPuff2`、`ParamTongueUpDown`、`ParamTongueWidth` |
| 头发 | 50、51、52、53、54、55、56、57、58、59、60、61、62 | `FrontHairX1`、`FrontHairX2`、`FrontHairX3`、`FrontHairX4`、`FrontHairY1`、`FrontHairY2`、`FrontHairY3`、`FrontHairY4`、`SideHairRX1`、`SideHairRX2`、`SideHairRX3`、`SideHairRBS`、`SideHairLX1`、`SideHairLX2`、`SideHairLX3`、`SideHairLBS`、`SideHairX1`、`SideHairX2`、`SideHairX3`、`SideHairX4`、`SideHairY1`、`SideHairY2`、`SideHairY3`、`SideHairY4`、`LateSideHairY1`、`LateSideHairY2`、`LateSideHairY3`、`LateSideHairY4`、`LateSideHairY5`、`LateSideHairX1`、`LateSideHairX2`、`LateSideHairX3`、`LateSideHairX4`、`LateSideHairX5`、`LateHairZ`、`LateHairX1`、`LateHairX2`、`LateHairX3`、`LateHairX4`、`LateHairX5`、`ShortPonytailX1`、`ShortPonytailX2`、`ShortPonytailXBS`、`ShortPonytailXBS2`、`LateHairY1`、`LateHairY2`、`LateHairY3`、`LateHairY4`、`LateHairY5`、`ShortPonytailY`、`ShortPonytailY2`、`ShortPonytailYBS`、`ShortPonytailYBS2` |
| 胸 | 64、65、66 | `ChestX1`、`ChestX2`、`ChestX3`、`ChestXBS`、`ChestY1`、`ChestY2`、`ChestY3`、`ChestY4` |
| 裙 | 67、68、69、70、71 | `SkirtX1`、`SkirtX2`、`SkirtX3`、`SkirtX4`、`SkirtSpecial`、`SkirtSpecial2`、`SkirtY`、`SkirtY2`、`SkirtY3`、`SkirtYBS`、`SkirtY4`、`SkirtY5`、`SkirtY6`、`SkirtY7`、`SkirtY9`、`SkirtY8`、`SkirtLayerX1`、`SkirtLayerX2`、`SkirtLayerX3`、`SkirtLayerX4`、`SkirtLayerX5`、`SkirtLayerX6`、`SkirtLayerY1`、`SkirtLayerY2`、`SkirtLayerY3`、`SkirtLayerY4`、`SkirtLayerY5` |
| 左臂（叶子） | 72、74、76、77、81 | `LArm`、`LForearm`、`LWrist`、`LHand`、`LHand2`、`LSleeveX1`、`LSleeveX2`、`LSleeveX3`、`LSleeveY`、`LSleeveY2`、`LSleeveY3`、`LRibbonX1`、`LRibbonX2`、`LRibbonX3`、`LRibbonX4` |
| 右臂（叶子） | 73、75、78、79、80 | `RArm`、`RForearm`、`RWrist`、`RHand`、`RHand2`、`RSleeveX1`、`RSleeveX2`、`RSleeveX3`、`RSleeveY1`、`RSleeveY2`、`RSleeveY3`、`RRibbonX1`、`RRibbonX2`、`RRibbonX3`、`RRibbonX4` |
| 兽耳 | 83、85、86、87、88、89 | `LEar1`、`LEar2`、`LEar3`、`REar1`、`REar2`、`REar3`、`RFlip`、`LFlip`、`RFlip2`、`LFlip2` |
| 外套花边 | 93、94、122、123 | `LaceRX`、`LaceRX2`、`LaceRX3`、`LaceLX1`、`LaceLX2`、`LaceLX3`、`LaceX1`、`LaceX2`、`LaceX3`、`LaceY1`、`LaceY2`、`LaceY3` |
| 头配饰 | 95、96、97、110、111、115、116、117、118、119、120、121 | `RBowX1`、`RBowX2`、`RBowX3`、`RBowX4`、`RBowX8`、`RBowX5`、`RBowX6`、`RBowX7`、`LBowX1`、`LowX2`、`LBowX3`、`LBowX4`、`LJewelry1`、`LJewelry2`、`LJewelry3`、`RJewelry1`、`RJewelry2`、`RJewelry3`、`ribbonX1`、`ribbonX2`、`ribbonX3`、`ribbonX4`、`ribbonY1`、`ribbonY2`、`ribbonY3`、`ribbonY4`、`Hat_XA`、`Hat_XB`、`Hat_XC`、`Hat_YA`、`Hat_YB`、`Hat_YC`、`ribbonX5`、`ribbonX7`、`ribbonX6`、`ribbonY5`、`ribbonY6`、`ribbonY7`、`Hat2pha`、`Hat2phB`、`Hat2phC`、`Hat2phD` |
| 闪光/宝石/透视 | 63、98、99、108、109、112、113、114 | `Shine`、`ShineX`、`ShineBIG`、`AngleXbs`、`PoutOffsetXL`、`PoutOffsetXR`、`AngleYbs`、`KiraA`、`KiraB`、`KiraC`、`KiraD`、`GemReflection`、`GemHighlightx`、`GemHighlighty` |
| 情绪 | 100、101 | `Emotion2`、`Emotion` |
| 动作手/开关（手臂次级） | 124、125、127、128、129 | `Param25`、`Param54`、`Param34`、`Param35`、`Param44` |
| 尾巴/草 | 130、131 | `Param_Angle_Rotation84`、`Param_Angle_Rotation85`、`Param_Angle_Rotation86`、`Param_Angle_Rotation87`、`Param_Angle_Rotation88`、`Param52`、`Param_Angle_Rotation89`、`Param45`、`Param46`、`Param47`、`Param48`、`Param49` |

### 3.3 共用域识别（这是 G0 的核心产出）

| # | 共用域 | 双重身份证据 | 消费者数 | 影响面 |
|---|---|---|---|---|
| S1 | `ParamBodyAngleX` / `ParamBodyAngleZ` | 输出：`PhysicsSetting4`（`PositionX→ParamBodyAngleX ×30`）、`PhysicsSetting9`（`PositionZ+PositionX→ParamBodyAngleZ ×30`）；输入：肩膀/盆骨/胸/臂/袖/花边/宝石/尾巴 20 条设置 | 20 / 20 | 全身。**绝不可按部位独占** |
| S2 | `ParamAngleX/Y/Z` | 输出：`PhysicsSetting1/2/3`（`AngleX→ParamAngleX ×28` 等）；输入：眼透视/前发/侧发/后发/兽耳/头配饰/耳环/缎带/帽子/闪光 | 17 / 14 / 15 | 整个头饰层 |
| S3 | `HipAngleX/Y/Z` | 输出：`PhysicsSetting12/14/15`；输入：双腿/裙/裙层级/并腿/盆骨缓动 | 4 / 1 / 3 | 下半身 + 裙 |
| S4 | `Param42`（R手腕 Z） | 姿态参数（右臂），同时是 `PhysicsSetting131`（尾巴）的输入，权重 50 | 1 | 右臂 ↔ 尾巴 |
| S5 | `Movement1/2/3` → `Param35` | 三条 `Movement*` 同权（30/30/30）汇入**同一个** `Param35`（手臂开关物理）；`Param35` 本身 0 下游 | 1 | 左右臂共用一条开关通道 |

**不是**共用域（易误判）：`ShoulderY`、`ShoulderZ` 虽是"肩膀"，但仅有出边、无入边（0 消费者），物理上不与手臂耦合；`RArm/LArm` 族同理。肩部与手臂的**视觉**耦合只能由 moc3 的 deformer 图证明，仓库内无该图（§6 UNKNOWN-1）。

### 3.4 域依赖图（文本）

```text
AngleX/Y/Z ──► [1,2,3] ──► ParamAngleX/Y/Z ──┬──► 头发(50/54/58/59) 帽子(117..121) 头饰(95..97,115,116)
                                            ├──► 兽耳(86..89) 耳环(110,111) 眼透视(27) 闪光(108,109)
                                            └── (终端饰品，无回边)

PositionX/Y/Z ─┬─► [4] ─► ParamBodyAngleX ─┬─► 肩(11) 胸(64,65) 臂(72,73) 袖(76,78) 飘带(80,81) 花边(93,94,122)
               │                          ├─► 尾巴(130,131) 宝石(112,113) 手Z(124) 左臂z(129)
               ├─► [5] ─► ParamBodyAngleRX ─► 侧发L(53)
               ├─► [9] ─► ParamBodyAngleZ ─┬─► 盆骨(15,16) 肩(11) 胸(64,65) 臂(72,73) 袖(76,78)
               │                          └─► 裙(67) 花边(93,94,122) 宝石(112) 尾巴(130,131) 手Z(124)
               └─► [12,22] ─► HipAngleX/Y ─► 双腿(17) 裙(67,70) 并腿(126) 裙层级(71)
LeanInput ──► [6,7,8,10,14,18,23,51,55,61,65,66,68,69,93,94,118,125,130]  ← 19 条设置的总闸
ParamBreath ─► 30 条设置（几乎全局）

── 手臂叶子（无出边）──
[73] ─► RArm(60%) RForearm RWrist      [74/75] ─► RHand/RHand2, LHand/LHand2
[72] ─► LArm(60%) LForearm LWrist      [78/79] ─► RSleeveX*/Y*  [76/77] ─► LSleeveX*/Y*
[80/81] ─► RRibbonX*/LRibbonX*          ★ 全部 0 下游
```

---

## 4. 独立可控性证据

### 4.1 现在到底有哪两条"接管"路径

| 路径 | 相位 | 机制 | 是否抑制物理写入 | 代码 |
|---|---|---|---|---|
| A. pre 让位 | `pre` | `injector.own(ids, d, "pre")` → `getPreOwnedIds()` → `physicsYield.replace(ids)` → `evaluate()` 跳过 `_parameterCaches` 回写、`interpolate()` 跳过落写 | **是**（该 id 本帧不写） | `param-injector.ts:151-156`、`motion-adapter.ts:240-246`、`cubismphysics.ts:662-671`、`739-747` |
| B. post 覆盖 | `post` | `injector.own(ids, d, "post")` → `injector.apply("post")` 在物理之后重放 sticky 值 | **否**（物理照写，post 后写胜出） | `param-injector.ts:115-127,261-293`、`index.ts:380-381` |

路径 A 只有在 `embodied.m1` flag 为 true 时才生效（`motion-adapter.ts:237,243`），且数据源被写死为 `pre` 相位集合；`DEFAULT_EMBODIED_FLAGS["embodied.m1"] = false`（`motion-adapter.ts:173`）。路径 B 不需要 flag，但 `injector` 只放行"被 own 的物理输出"（`param-injector.ts:186-189`）。

### 4.2 逐域判定：Agent 独占该域时，物理是否只在该域让位？

判定口径（三条必须同时成立才算 PASS）：
1. 该域输出**无下游消费者**，或下游可视作"随动且可接受"；
2. 接管不需要写入共享根输入/共享枢纽；
3. 释放后无恢复跳变（物理从保温状态接管）。

| 域 | 独占 id 集 | 让位是否只在该域 | 其他部位是否照常 | 结论 | 证据 |
|---|---|---|---|---|---|
| 右臂叶子 | `RArm RForearm RWrist RHand RHand2` (+`RSleeveX1-3 RSleeveY1-3 RRibbonX1-4`) | 是（路径 B 不抑制；路径 A 若登记也只会跳过这 15 个） | 是（0 下游） | **PASS（有边界条件，见下）** | `DERIVED`；`physics-gate.test.mjs:204-233` 已用 `RHand` 验证 post 通道 |
| 左臂叶子 | `LArm LForearm LWrist LHand LHand2` (+同构 15 个) | 是 | 是（0 下游） | **PASS（同边界）** | 同上 |
| 肩 | `ShoulderY ShoulderZ` | 是 | 是（0 下游） | PASS（物理层）；语义归属 UNKNOWN | `DERIVED` |
| 头朝向 | `ParamAngleX/Y/Z` | 是（路径 A 可证明：`physics-gate.test.mjs:127-149` 的 Hip 同构） | **否**：52/42/50 个头饰输出会随 Agent 值改变（这是"随动"，不是"照常"） | PASS（作为"根输入控制"）/ **FAIL（作为"独占"）** | `DERIVED` |
| 躯干轴 | `ParamBodyAngleX/Y/Z` | 必须让位才对 | **否**：61/62/13 个输出随动；且它是全身根枢纽 | **FAIL（不可按部位独占）** | `DERIVED` |
| 盆骨 | `HipAngleX/Y/Z` | 是（现有 pre 让位已实现并测试） | **否**：14/8/5 个下游（裙/腿/并腿）随动；这是 M1-b 的设计意图（C9） | PASS（单域让位）/ 不满足"其他部位照常" | `physics-gate.test.mjs:127-170` |
| 手臂姿态层 | `Param36/39/40/41/42/43`、`Param59/60/61/62` | **不适用**：不是物理输出，`canOwn` 一律拒绝（`selectOwnableIds` 见 `param-ownership.ts:54-63`） | 是（不需要让位，物理不写它们） | **PASS（普通写）/ 不可 own** | `FILE`：`OUT` 集合不含这些 id |

**右臂 PASS 的边界条件（必须写进 G1 验收）**

1. 独占期间物理**仍在计算** `RArm`（路径 B）。同一帧内 `RArm` 的计算值会被 post 覆盖，但 `_currentRigOutputs` 继续推进——这正是 release 后平滑的原因，也是"物理没有真的让位"的事实。
2. `RArm` 的 `Weight=60`：物理写只吸收 60%，写前值保留 40%。因此 release 当帧的接管幅度有限（不会从 0 跳到 1），但"有限"只是概率性的，G1 仍需实测 release 帧的跳变。
3. 独占集合必须**恰好**是 §2.3 里的手臂 id；多写一个 `ParamBodyAngleZ` 就把共享枢纽拖进来了。
4. 独占手臂不写 `Movement1/2/3`（共享开关）、不写 `Param42`（喂尾巴物理）时才算"只影响手臂"。

### 4.3 一条完整的代码路径（右臂叶子域，可复述给 G1）

```text
1) Agent 请求：acquire(["RArm","RForearm","RWrist","RHand","RHand2"], {phase:"post"})
   → LimbController.acquireDetailed（limb-controller.ts:137-176）
      门槛：limbIds 白名单 → isOwnable（= MotionAdapter.canOwn 的物理输出判定）
2) 每帧：PhysicsGate.post（index.ts:380, motion-adapter.ts:247-260）
   → limb.resolve(now) 拿到 {RArm: v}（limb-controller.ts:222-231，含 clamp）
   → stagePostWrite → injector.set(core, "RArm", v)（param-injector.ts:166-214）
      守卫：isPhysicsOutput && owned → 放行；sticky 记 ownedPhase="post"
3) 紧接着 injector.apply(core,"post")（index.ts:381 → param-injector.ts:261-293）
   → 用 setParameterValueById 写入，成为本帧最终值
4) 同帧物理已经先写过 RArm（cubismphysics.ts:775），被 3) 覆盖 → 视觉胜出
5) release：ownership 删除 + sticky 删除（param-injector.ts:129-134）
   → 下一帧无 post 写，物理值直接生效（0 行恢复逻辑，R8）
```

### 4.4 无法证明的部分

- **两层如何叠加**：`Param36..43`（姿态）与 `RArm..`（物理）在 moc3 里是相加、相乘还是分别驱动不同 deformer——仓库无 deformer 图，Core 也不暴露 → **UNKNOWN**。
- **衣服/袖子/飘带是否真属于"右臂"**：`RSleeveX1-3`、`RRibbonX1-4` 在 cdi3 里挂在 `ParamGroup14 手臂` 组下，但组名不是绑定关系 → 归域是**标签级**证据，非物理证据。
- **`Param38`（动画 双手开关）、`Param37`（动画开关）** 的作用面未知（不参与 physics3、不在 W3 手势的 `controlledParams` 里）。

---

## 5. 写入顺序图（含行号）

```text
LAppModel.update()                                        lappmodel.ts:632
├─ _model.loadParameters()                                 lappmodel.ts:639   ← 恢复上帧 saveParameters 的快照
├─ _motionManager.updateMotion()                           lappmodel.ts:651   ← motion3 写姿态参数
├─ _model.saveParameters()                                 lappmodel.ts:656   ← 快照点（post 钩子的写入不会进快照）
├─ _preLateUpdateHook(core)                                lappmodel.ts:659-665  == index.ts:353-365
│   ├─ applyGazeBody(core)            index.ts:358  → writeParam("AngleX"/"AngleY"/"LeanInput")（直写，绕过 injector）
│   ├─ flushAngleBus(core)            index.ts:359  → injector.set("AngleZ","PositionX","PositionY")（add 模式）
│   ├─ injector.apply(core,"pre")     index.ts:360  → 重放 pre sticky
│   └─ physicsGate.pre(core)          index.ts:364  → physicsYield.replace(injector.getPreOwnedIds())  ← 让位登记
├─ _updateScheduler.onLateUpdate()                         lappmodel.ts:668   ← 按 executionOrder 升序
│   ├─ Expression 300 → Drag 400（addParameterValueById 到 ParamAngleX/Y/Z、ParamBodyAngleX、ParamEyeBallX/Y）
│   ├─ Breath 500     → LipSync 700 → Pose 800
│   └─ Physics 600    → CubismPhysicsUpdater.onLateUpdate（cubismphysicsupdater.ts:45-51）
│        └─ physics.evaluate(model, dt)                     cubismphysics.ts:486
│             ├─ 输入插值 _parameterInputCaches ⇄ parameterValues   :554-559
│             ├─ 读输入（非参数数组，读 _parameterCaches）           :590-601
│             ├─ 算振子 → 写 _parameterCaches（让位 id 跳过）        :626-698
│             └─ interpolate() → 写 model.parameters.values        :705, 714, 742-747(跳过), 775
├─ _postLateUpdateHook(core, dt)                            lappmodel.ts:670-676  == index.ts:366-386
│   ├─ gestureBridge.resolve(now)     index.ts:371  ← 时间线段到期清理/软解除
│   ├─ kfTick(now)                    index.ts:372  → injector.set(track)（sticky，稍后重放）
│   ├─ poseController.update(...)     index.ts:374
│   ├─ applyAmbientFace(core)         index.ts:376
│   ├─ physicsGate.post(core)         index.ts:380  → limb.resolve → injector.set  ← 四肢 post 通道（当前未接线）
│   ├─ injector.apply(core,"post")    index.ts:381  ← post 写胜出（最终值）
│   ├─ applyGazeEyes(core)            index.ts:382  → writeParam("ParamEyeBallX/Y")
│   └─ applyCueFrame(core)            index.ts:385  ← cue 写值必须晚于 applyGazeEyes
└─ _model.update()                                         lappmodel.ts:678   ← 绘制（读 parameterValues）
```

三个必须记住的顺序事实：

1. **物理在 pre 之后、post 之前**。任何 pre 写入都能被物理读到；任何 post 写入都能覆盖物理。
2. **Drag 400 在物理 600 之前**，而它对 `ParamAngleX/Y/Z`、`ParamBodyAngleX` 用的是 `addParameterValueById`（`cubismlook.ts:64-69`）——这些参数随即被物理整值覆盖（`updateOutputParameterValue` weight=1 分支直接赋值，`cubismphysics.ts:1293-1295`）。所以框架拖拽对头/躯干的贡献在本模型上**实际不生效**，头/躯干只能靠根输入。这是既有行为，G1 不得依赖 Drag 通道。
3. **`saveParameters` 在 pre 之前**：post 写入的值不会进快照，下一帧 `loadParameters` 会把它冲掉——这正是"必须每帧重放 sticky"的原因（`param-injector.ts:76-80`）。

---

## 6. 不支持 / 未知清单

### 6.1 不能按部位独立接管

| # | 项 | 结论 | 原因 |
|---|---|---|---|
| N1 | 躯干（`ParamBodyAngleX/Y/Z`） | **不支持按部位独占** | S1 共享枢纽，61/62 下游；且它是"物理输出 + 物理输入"的双重身份 |
| N2 | 头朝向（`ParamAngleX/Y/Z` 输出） | 不支持作为"独占"，只支持作为"根输入控制"（写 `AngleX/Y/Z`） | S2，52/42/50 下游随动 |
| N3 | 盆骨（`HipAngleX/Y/Z`） | 支持让位，但**不满足"其他部位照常"** | S3，14/8/5 下游随动（设计意图 C9，验收口径要改） |
| N4 | 手臂开关（`Movement1/2/3` → `Param35`） | 不支持按侧独占 | S5，三条输入汇入同一 `Param35` |
| N5 | 右臂姿态（`Param36..43`） | 不支持 `canOwn`（非物理输出） | `selectOwnableIds` 只放行物理输出（`param-ownership.ts:54-63`）→ 只能走普通 `set`，不进 ownership 表 |
| N6 | `ShockR` / `ShockL` | 可 own，但**独占无效果** | `Weight=0`，物理写不改变值 |
| N7 | 腿（独立骨骼） | 不存在 | 画像已诚实报 `unsupported`（`packages/core/test/capability-profile.ts:143-146`） |

### 6.2 需真机标定 / 仓库无证据（UNKNOWN）

| # | 未知项 | 为什么不能推断 | G1 需要什么证据 |
|---|---|---|---|
| U1 | `Param36..43` 与 `RArm..` 在 moc3 中的叠加方式（相加/相乘/独立 deformer） | 参数名与分组不构成绑定关系；Core 不暴露 deformer 图 | 真机像素/包围盒观测，或美术工程文件 |
| U2 | 手臂叶子域独占后的**视觉**隔离度（左臂/头/躯干是否真的不动） | physics3 只能证明"物理数值不串"，不能证明"画面不串" | 真机逐帧截图对比（G1 验收项） |
| U3 | release 当帧的跳变幅度 | `RArm` weight=60 → 理论上有限，但未实测 | 真机 release 帧前后 3 帧采样 |
| U4 | `Param42`（R手腕）独占对尾巴观感的影响 | 只能证明"131 号设置输入变了"，幅度未标定 | 真机对比 |
| U5 | `Param35/Param25/Param44` 驱动哪些 deformer | 三者 0 下游、非根输入、无 motion 引用 | 美术工程/真机 |
| U6 | `Param37`/`Param38`（动画开关/双手开关）语义 | 不参与 physics3，不在手势受控参数表 | 动作文件与美术确认 |

### 6.3 G1 的 `canOwn` 应如何构造

**结论：不要直接用 `MotionAdapter.canOwn` 作为"部位可独占"的判据**——它回答的是"这个 id 是不是物理输出"，不是"这个部位能不能被接管"。建议按下面的三层构造：

```text
部位域定义（静态、来自本审计，不用参数名猜）：
  arm.right = {
    physicsOwned: [RArm, RForearm, RWrist, RHand, RHand2,
                   RSleeveX1..3, RSleeveY1..3, RRibbonX1..4],   // 15，canOwn 放行且需让位/覆盖
    poseWritable: [Param36, Param39, Param40, Param41, Param43], // 5，非物理输出，普通写
    crossDomain:  [Param42],   // 右臂姿态，但同时喂 PhysicsSetting131（尾巴）→ 必须声明耦合
    sharedForbidden: [Movement1, Movement3, Param35],   // 共享开关，不得纳入按侧独占
  }
  arm.left  = { physicsOwned: [LArm, LForearm, LWrist, LHand, LHand2,
                               LSleeveX1..3, LSleeveY/Y2/Y3, LRibbonX1..4], // 15
                poseWritable: [Param59, Param60, Param61, Param62] }
  head   = { rootOnly: [AngleX, AngleY, AngleZ] }        // 不 own 输出
  torso  = { rootOnly: [PositionX, PositionY, PositionZ, LeanInput] }
  hip    = { physicsOwned: [HipAngleX/Y/Z], requiresYield: true }      // 下游随动，验收口径不同

canOwn(ids) 的正确用法：
  1. 先用 physics3 输出表（index.ts:388-407 已注入的同一份）判 ownable；
  2. 对 poseWritable 的 id，不要塞进 own —— 它们本来就允许写，塞进去会被 canOwn 判 not-physics-output 而"看起来失败"；
  3. 对 sharedForbidden 的 id，直接拒（fail-closed），不要因为"调用方传了就放行"；
  4. 物理表缺失（fetch 失败）时必须 BLOCKED，**禁止**回落到 FALLBACK_PHYSICS_OUTPUT 判 canOwn：该正则只覆盖 292 个真实输出中的 30 个（10%），且含 `LEGs*AngleZ2` 这类拼写错误（`param-injector.ts:50`）。
```

### 6.4 我认为 G1 最大的物理风险点（按严重度）

1. **"lease 成功但手臂不动"的假通过（最高）**。真实手臂动作写的是 `Param36..43 / 59..62`（非物理输出），而 `canOwn` 只放行物理输出。如果 G1 的验收动作是现有 `竖手指/抚胸` motion3，acquire 会成功（因为另外 15 个 id 是可 own 的），但动作本身完全不经过 ownership 表——回执漂亮、行为无变化。验收必须同时断言 `Param36`（或 `Param62`）确实被写入且 renderer 回执 applied。
2. **post 相位不抑制物理，只是后写覆盖（高）**。对手臂叶子域无害（0 下游），但它不满足 `docs/Ownership-Invariants.md:60` INV-4 的字面要求（"physics 对该参数不产生写入"）。一旦有人把共享枢纽（`ParamBodyAngleX`）按同样方式 own，就会得到"最终值正确、但 61 个下游仍读物理值"的撕裂画面。G1 若扩展到躯干/盆骨，必须走 pre 让位（路径 A），不能复用 post。
3. **共享开关 `Movement1/2/3 → Param35`（中）**。左臂和右臂的开关汇入同一条物理参数；"独占右臂"期间如果动作链又写了 `Movement1`，两侧都会受影响。`Param35` 0 下游，物理数值上安全，但视觉耦合 UNKNOWN（U5）。
4. **`Param42` 的跨域副作用（中）**。它是右臂姿态参数，同时以权重 50 喂 `PhysicsSetting131`（尾巴 5 个输出）。独占右臂时若不接管尾巴，尾巴摆幅会随手腕变化。验收应显式排除或声明这一耦合。
5. **release 平滑性未被证明（中）**。`RArm` 的 weight=60 只能说明"不会满幅跳"，`_currentRigOutputs` 的保温状态是否与 Agent 末值一致未验证；release 帧可能出现 40% 的残留差值。
6. **FALLBACK 正则误导（低但会静默出错）**。30/292 的覆盖率差异意味着"表没加载成功"时会静默改变 canOwn 判定集合，且 `LEGs*AngleZ2` 这类拼写使 `LEG` 前缀被意外放行。

---

## 附录 A：292 个 physics 输出 id（分域）

**头·朝向（根）**（3）：`ParamAngleX`、`ParamAngleY`、`ParamAngleZ`

**躯干·身体轴**（12）：`ParamBodyAngleX`、`ParamBodyAngleRX`、`Param50`、`Param53`、`ParamBodyAngleY`、`ParamBodyAngleZ`、`ShoulderY`、`ShoulderZ`、`ParamBodyAngleX2`、`HipAngleYDOWN`、`HipAngleYUP`、`ParamBodyAngleY2`

**盆骨/腿/裙层级**（10）：`HipAngleX`、`HipAngleX2`、`HipAngleY`、`HipAngleZ`、`ParamHipAngleZ2`、`LEGAngleZ2`、`ParamHipAngleZ`、`HipZ1`、`HipZ2`、`Param33`

**眼**（27）：`REyeball1`、`REyeball2`、`LEyeball1`、`LEyeball2`、`PupilY`、`PupilX`、`REyes1`、`REyes2`、`LEyes1`、`LEyes2`、`REyeLashX1`、`REyeLashX2`、`LEyeLashX1`、`LEyeLashX2`、`LEyeball3`、`REyeball3`、`LHighLight1`、`LHighLight2`、`LHighLight3`、`RHighLight1`、`RHighLight2`、`RHighLight3`、`RParamGlowA`、`LParamGlowA`、`RParamGlowB`、`LParamGlowB`、`RParamGlowC`

**眉/兽耳控制**（12）：`ParamBrowLY3`、`ParamBrowRY3`、`ParamBrowRY2`、`ParamBrowLY2`、`ParamBrowRAngleSmoothing`、`ParamBrowRAngle`、`ParamBrowLAngleSmoothing`、`ParamBrowLAngle`、`ShockR`、`ShockL`、`LControl`、`RControl`

**脸颊/唇/舌**（13）：`Press`、`CheeksWiggleXL`、`CheeksWiggleXR`、`CheeksWiggleY`、`CheeksWiggleX`、`LipPhysics1`、`LipPhysics2`、`LipPhysics3`、`CheeckPuffR`、`CheeckPuffL`、`CheeckPuff2`、`ParamTongueUpDown`、`ParamTongueWidth`

**头发**（53）：`FrontHairX1`、`FrontHairX2`、`FrontHairX3`、`FrontHairX4`、`FrontHairY1`、`FrontHairY2`、`FrontHairY3`、`FrontHairY4`、`SideHairRX1`、`SideHairRX2`、`SideHairRX3`、`SideHairRBS`、`SideHairLX1`、`SideHairLX2`、`SideHairLX3`、`SideHairLBS`、`SideHairX1`、`SideHairX2`、`SideHairX3`、`SideHairX4`、`SideHairY1`、`SideHairY2`、`SideHairY3`、`SideHairY4`、`LateSideHairY1`、`LateSideHairY2`、`LateSideHairY3`、`LateSideHairY4`、`LateSideHairY5`、`LateSideHairX1`、`LateSideHairX2`、`LateSideHairX3`、`LateSideHairX4`、`LateSideHairX5`、`LateHairZ`、`LateHairX1`、`LateHairX2`、`LateHairX3`、`LateHairX4`、`LateHairX5`、`ShortPonytailX1`、`ShortPonytailX2`、`ShortPonytailXBS`、`ShortPonytailXBS2`、`LateHairY1`、`LateHairY2`、`LateHairY3`、`LateHairY4`、`LateHairY5`、`ShortPonytailY`、`ShortPonytailY2`、`ShortPonytailYBS`、`ShortPonytailYBS2`

**胸**（8）：`ChestX1`、`ChestX2`、`ChestX3`、`ChestXBS`、`ChestY1`、`ChestY2`、`ChestY3`、`ChestY4`

**裙**（27）：`SkirtX1`、`SkirtX2`、`SkirtX3`、`SkirtX4`、`SkirtSpecial`、`SkirtSpecial2`、`SkirtY`、`SkirtY2`、`SkirtY3`、`SkirtYBS`、`SkirtY4`、`SkirtY5`、`SkirtY6`、`SkirtY7`、`SkirtY9`、`SkirtY8`、`SkirtLayerX1`、`SkirtLayerX2`、`SkirtLayerX3`、`SkirtLayerX4`、`SkirtLayerX5`、`SkirtLayerX6`、`SkirtLayerY1`、`SkirtLayerY2`、`SkirtLayerY3`、`SkirtLayerY4`、`SkirtLayerY5`

**左臂（叶子）**（15）：`LArm`、`LForearm`、`LWrist`、`LHand`、`LHand2`、`LSleeveX1`、`LSleeveX2`、`LSleeveX3`、`LSleeveY`、`LSleeveY2`、`LSleeveY3`、`LRibbonX1`、`LRibbonX2`、`LRibbonX3`、`LRibbonX4`

**右臂（叶子）**（15）：`RArm`、`RForearm`、`RWrist`、`RHand`、`RHand2`、`RSleeveX1`、`RSleeveX2`、`RSleeveX3`、`RSleeveY1`、`RSleeveY2`、`RSleeveY3`、`RRibbonX1`、`RRibbonX2`、`RRibbonX3`、`RRibbonX4`

**兽耳**（10）：`LEar1`、`LEar2`、`LEar3`、`REar1`、`REar2`、`REar3`、`RFlip`、`LFlip`、`RFlip2`、`LFlip2`

**外套花边**（12）：`LaceRX`、`LaceRX2`、`LaceRX3`、`LaceLX1`、`LaceLX2`、`LaceLX3`、`LaceX1`、`LaceX2`、`LaceX3`、`LaceY1`、`LaceY2`、`LaceY3`

**头配饰**（42）：`RBowX1`、`RBowX2`、`RBowX3`、`RBowX4`、`RBowX8`、`RBowX5`、`RBowX6`、`RBowX7`、`LBowX1`、`LowX2`、`LBowX3`、`LBowX4`、`LJewelry1`、`LJewelry2`、`LJewelry3`、`RJewelry1`、`RJewelry2`、`RJewelry3`、`ribbonX1`、`ribbonX2`、`ribbonX3`、`ribbonX4`、`ribbonY1`、`ribbonY2`、`ribbonY3`、`ribbonY4`、`Hat_XA`、`Hat_XB`、`Hat_XC`、`Hat_YA`、`Hat_YB`、`Hat_YC`、`ribbonX5`、`ribbonX7`、`ribbonX6`、`ribbonY5`、`ribbonY6`、`ribbonY7`、`Hat2pha`、`Hat2phB`、`Hat2phC`、`Hat2phD`

**闪光/宝石/透视**（14）：`Shine`、`ShineX`、`ShineBIG`、`AngleXbs`、`PoutOffsetXL`、`PoutOffsetXR`、`AngleYbs`、`KiraA`、`KiraB`、`KiraC`、`KiraD`、`GemReflection`、`GemHighlightx`、`GemHighlighty`

**情绪**（2）：`Emotion2`、`Emotion`

**动作手/开关（手臂次级）**（5）：`Param25`、`Param54`、`Param34`、`Param35`、`Param44`

**尾巴/草**（12）：`Param_Angle_Rotation84`、`Param_Angle_Rotation85`、`Param_Angle_Rotation86`、`Param_Angle_Rotation87`、`Param_Angle_Rotation88`、`Param52`、`Param_Angle_Rotation89`、`Param45`、`Param46`、`Param47`、`Param48`、`Param49`

## 附录 B：复现方式

physics3 图推导（`DERIVED`）：`python` 读 `大肥鱼.physics3.json`，建 `param → 消费者 settings` 邻接表后求传递闭包，即本报告的"下游输出数"。

moc3 量程（`RUNTIME`）：用仓库自带 SDK 包（目录 `CubismSdkForWeb-5-r.5`，Core 运行时自报 6.0.1）在 Node 中加载（该文件为 wasm-in-JS，需等 `onRuntimeInitialized`）：

```js
// 1) 复制 Core 并在末尾暴露模块实例（只写临时目录，不动 vendor）
//    const src = fs.readFileSync(vendor/.../live2dcubismcore.min.js)
//    src.replace("_em_module())}(Live2DCubismCore", "(globalThis.__EM=_em_module()))}(Live2DCubismCore")
// 2) require 之后等 EM.onRuntimeInitialized，再：
const moc   = core.Moc.fromArrayBuffer(fs.readFileSync("大肥鱼.moc3").buffer);
const model = core.Model.fromMoc(moc);
const p     = model.parameters;   // p.ids / minimumValues / maximumValues / defaultValues
```

---

## 交付状态

| 项 | 状态 |
|---|---|
| G0-1 参数清单（id/量程/默认） | **DONE**（509 参数，四肢域全量列出） |
| G0-2 物理输出清单（131 条映射 + 292 id + 每帧语义） | **DONE** |
| G0-3 部位→参数域映射（含共用域） | **DONE**（S1–S5） |
| G0-4 独立可控性证据 | **PARTIAL**：物理数值层 PASS / 视觉层 UNKNOWN（U1/U2） |
| G0-5 写入顺序图 | **DONE** |
| G0-6 不支持/未知清单 | **DONE**（N1–N7、U1–U6） |
| 生产代码改动 | **无** |
| 真机验证 | **NOT TESTED**（G0 不要求） |
