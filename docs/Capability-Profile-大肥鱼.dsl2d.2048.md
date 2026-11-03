# 模型能力画像 · 大肥鱼.dsl2d.2048

> 扫描器：`tools/capability-scan/scan.mjs`（数据全部来自模型文件，不靠命名推断）
> 输入：`大肥鱼.dsl2d.2048.model3.json`、`大肥鱼.cdi3.json`
> 契约版本：v3 · profileRevision：`r88b84822fb2e`

## 摘要

- 参数 509 个，其中物理输出 292 个（物理持有，直写需 own）
- 表情 21 个、动作文件 7 个（动作组 7 个）
- 语义通道 20 个：supported 12 · approximate 4 · unsupported 4
- 眨眼组 2 个参数；口型组 1 个参数（口型是红线，任何通道不得写）

## 语义通道

| 通道 | 状态 | 真实参数 | 写入方式 | 置信度 | 说明 |
|---|---|---|---|---|---|
| `head.yaw` | supported | AngleX | 直写 | 0.95 |  |
| `head.pitch` | supported | AngleY | 直写 | 0.95 |  |
| `head.roll` | supported | AngleZ | 直写 | 0.95 |  |
| `torso.lean` | supported | LeanInput | 直写 | 0.95 |  |
| `torso.sway` | supported | ParamBodyAngleX | 需 own | 0.8 | 该参数是物理输出，必须 own 后才能写 |
| `torso.contraction` | approximate | ShoulderX+ShoulderZ | 需 own | 0.6 | 靠双肩内收近似「缩肩」，无独立躯干收缩参数 |
| `gaze.x` | supported | ParamEyeBallX | 直写 | 0.95 |  |
| `gaze.y` | supported | ParamEyeBallY | 直写 | 0.95 |  |
| `arm.left.raise` | supported | LArm | 需 own | 0.8 | 该参数是物理输出，必须 own 后才能写 |
| `arm.left.extend` | supported | LForearm | 需 own | 0.8 | 该参数是物理输出，必须 own 后才能写 |
| `arm.left.inward` | approximate | LForearm+LWrist | 需 own | 0.6 | 靠前臂+腕部组合近似「手臂内收」，无独立内收轴 |
| `arm.right.raise` | supported | RArm | 需 own | 0.8 | 该参数是物理输出，必须 own 后才能写 |
| `arm.right.extend` | supported | RForearm | 需 own | 0.8 | 该参数是物理输出，必须 own 后才能写 |
| `arm.right.inward` | approximate | RForearm+RWrist | 需 own | 0.6 | 同上（右侧） |
| `leg.left.inward` | unsupported | — | — | 0 | 模型无腿部内收参数（半身模型常见） |
| `leg.left.bend` | unsupported | — | — | 0 | 模型无膝关节参数 |
| `leg.right.inward` | unsupported | — | — | 0 | 模型无腿部内收参数（半身模型常见） |
| `leg.right.bend` | unsupported | — | — | 0 | 模型无膝关节参数 |
| `face.blink` | approximate | ParamEyeLOpen | 直写 | 0.7 | 引擎眨眼组自动接管，外部写只在 own 期间有效 |
| `body.breathing` | supported | ParamBreath | 直写 | 0.95 |  |

## 不支持 / 未知（必须降级，不得硬凑）

- `leg.left.inward`（unsupported）：模型无腿部内收参数（半身模型常见）
- `leg.left.bend`（unsupported）：模型无膝关节参数
- `leg.right.inward`（unsupported）：模型无腿部内收参数（半身模型常见）
- `leg.right.bend`（unsupported）：模型无膝关节参数

## 物理冲突面

这些通道落到物理输出上，写入前必须 `own:true`，否则会被 physics 覆盖：

- `torso.sway` → ParamBodyAngleX
- `torso.contraction` → ShoulderZ
- `arm.left.raise` → LArm
- `arm.left.extend` → LForearm
- `arm.left.inward` → LForearm, LWrist
- `arm.right.raise` → RArm
- `arm.right.extend` → RForearm
- `arm.right.inward` → RForearm, RWrist

## 资产

- 动作：7 个（含循环 0 个）
- 表情：21 个

## 已知边界

- **腿部**：本模型只有 1 个腿部相关参数，且是物理输出，无法表达「并拢/膝内收」这类语义——行为模板必须显式降级。
- **手指**：0 个手指参数，抓握类动作只能靠预制 Motion。
- **参数范围**：cdi3 不含 Min/Max/Default，静态扫描不编造；运行时可从 Cubism 查询（`getParameterMinimumValue`）。
