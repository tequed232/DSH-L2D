# 模型能力画像 · 大肥鱼.dsl2d.2048

> 扫描器：`tools/capability-scan/scan.mjs`（数据全部来自模型文件，不靠命名推断）
> 输入：`大肥鱼.dsl2d.2048.model3.json`、`大肥鱼.cdi3.json`
> 契约版本：v3 · profileRevision：`r096ba86d2954`

## 摘要

- 参数 509 个，其中物理输出 292 个（物理持有，直写需 own）
- 表情 21 个、动作文件 7 个（动作组 7 个）
- 语义通道 56 个：supported 48 · approximate 4 · unsupported 4
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
| `ext.gesture.right_finger` | supported | Movement1+Movement3+Param56+Param57+Param40+Param36+Param39+Param41+Param42+Param43 | 直写 | 0.9 |  |
| `ext.gesture.grass` | supported | Movement1+Movement3+Param56+Param57+Param36+Param39+Param41+Param42+Param43 | 直写 | 0.9 |  |
| `ext.gesture.chest` | supported | Movement2+Param56+Param57+Param62+Param59+Param60+Param61 | 直写 | 0.9 |  |
| `ext.idle.background` | supported | ShockR+ShockL+Param11+SweatBurst1+SweatBurst2+SweatBurst3+SweatBurst4+Divider22+Param31+Param32+Param27+Param28+RCry+Param29+Param30+LCry+Startwinkle+Param55+Param56+Param58+Param57 | 需 own | 0.8 | 含物理输出参数，写入前必须 own |
| `ext.pose.rest` | supported | Param36+Param39+Param40+Param41+Param42+Param43+Param59+Param60+Param61+Param62 | 直写 | 0.9 |  |
| `ext.pose.finger` | supported | Param36+Param39+Param40+Param41+Param42+Param43 | 直写 | 0.9 |  |
| `ext.pose.grass` | supported | Param36+Param39+Param41+Param42+Param43 | 直写 | 0.9 |  |
| `ext.pose.chest` | supported | Param59+Param60+Param61+Param62 | 直写 | 0.9 |  |
| `ext.gaze.look_up` | supported | AngleX+AngleY+ParamEyeBallX+ParamEyeBallY+PositionX+LeanInput | 直写 | 0.9 |  |
| `ext.gaze.look_down` | supported | AngleX+AngleY+ParamEyeBallX+ParamEyeBallY+PositionX+LeanInput | 直写 | 0.9 |  |
| `ext.gaze.look_left` | supported | AngleX+AngleY+ParamEyeBallX+ParamEyeBallY+PositionX+LeanInput | 直写 | 0.9 |  |
| `ext.gaze.look_right` | supported | AngleX+AngleY+ParamEyeBallX+ParamEyeBallY+PositionX+LeanInput | 直写 | 0.9 |  |
| `ext.body.lean_forward` | supported | LeanInput | 直写 | 0.9 |  |
| `ext.body.straighten` | supported | Param36+Param39+Param40+Param41+Param42+Param43+Param59+Param60+Param61+Param62+AngleX+AngleY+AngleZ+PositionX+PositionY | 直写 | 0.9 |  |
| `ext.body.relax` | supported | Param36+Param39+Param40+Param41+Param42+Param43+Param59+Param60+Param61+Param62 | 直写 | 0.9 |  |
| `ext.expression.兔牙` | supported | key9 | 直写 | 0.9 |  |
| `ext.expression.加载` | supported | key8 | 直写 | 0.9 |  |
| `ext.expression.单片眼镜` | supported | key12 | 直写 | 0.9 |  |
| `ext.expression.圈圈眼` | supported | key3+key4+key5+key6 | 直写 | 0.9 |  |
| `ext.expression.屑` | supported | key3+key5+key6 | 直写 | 0.9 |  |
| `ext.expression.流泪` | supported | key2 | 直写 | 0.9 |  |
| `ext.expression.爱心眼` | supported | key4 | 直写 | 0.9 |  |
| `ext.expression.脱鞋` | supported | Clothes4 | 直写 | 0.9 |  |
| `ext.expression.脸红` | supported | key7 | 直写 | 0.9 |  |
| `ext.expression.钢盆` | supported | key10 | 直写 | 0.9 |  |
| `ext.expression.裙长切换` | supported | Clothes1 | 直写 | 0.9 |  |
| `ext.expression.黑框眼镜` | supported | key11 | 直写 | 0.9 |  |
| `ext.expression.黑脸` | supported | key1 | 直写 | 0.9 |  |
| `ext.expression.＞＜` | supported | key3+key4+key5+key6 | 直写 | 0.9 |  |
| `ext.expression.体型1` | supported | Clothes2 | 直写 | 0.9 |  |
| `ext.expression.体型2` | supported | Clothes2 | 直写 | 0.9 |  |
| `ext.expression.默认体型` | supported | Clothes2 | 直写 | 0.9 |  |
| `ext.expression.前倾` | supported | LeanInput | 直写 | 0.9 |  |
| `ext.expression.尾巴开关` | supported | Clothes5 | 直写 | 0.9 |  |
| `ext.expression.流冷汗` | supported | key13 | 直写 | 0.9 |  |
| `ext.expression.胸口衣服` | supported | Clothes3 | 直写 | 0.9 |  |

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
- `ext.idle.background` → ShockR, ShockL

## 明确不登记（W3 排除表）

- `gesture.wave`（挥手（right_wave / left_wave））：无 authored motion3 资产；现有 7 个动作组里没有挥手曲线（Animation/*.motion3.json 全部解析，无手部挥动约束）
- `gesture.hand_to_chin`（托腮（hand_to_chin））：无 authored 资产；Exp3 只有嘴/眼/道具开关，无托腮表情
- `gesture.arms_crossed`（交叉手（arms_crossed））：无 authored 资产，且左右臂参数由两套独立姿势层控制，交叉需要同时驱动双臂且无混合规则
- `gesture.open_hands`（双手张开（open_hands））：无 authored 资产；手指无独立参数（W0 审计），无法用参数近似

## 未引用资产（不允许被当作可用能力）

- model/Animation/脱捕.motion3.json
- model/Exp3/竖食指关.exp3.json
- model/Exp3/竖食指开.exp3.json

## 资产

- 动作：7 个（含循环 0 个）
- 表情：21 个

## 已知边界

- **腿部**：本模型只有 1 个腿部相关参数，且是物理输出，无法表达「并拢/膝内收」这类语义——行为模板必须显式降级。
- **手指**：0 个手指参数，抓握类动作只能靠预制 Motion。
- **参数范围**：cdi3 不含 Min/Max/Default，静态扫描不编造；运行时可从 Cubism 查询（`getParameterMinimumValue`）。
