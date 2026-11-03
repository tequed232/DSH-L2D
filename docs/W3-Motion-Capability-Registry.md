# W3 Motion Capability Registry

> 生成器：`tools/w3-registry/build.mjs`（数据来自模型文件与源码，不靠命名推断）。
> 基线 commit：`96069c926fc0db9eec9c43a83787461d17bef1f3`；模型：`大肥鱼.dsl2d`。
> 机器可读版：`tools/w3-registry/registry.json`（校验脚本 `validate.mjs`）。

## 摘要

- 登记条目 36 条：动作组 3、Idle 1、姿势 4、视线 4、身体 3、表情 21。
- 明确不登记：挥手（right_wave / left_wave）、托腮（hand_to_chin）、交叉手（arms_crossed）、双手张开（open_hands）。
- 未引用资产：motion3 1 个（脱捕.motion3.json），exp3 2 个（竖食指关.exp3.json、竖食指开.exp3.json）。

## 动作组（成对状态切换）

| ID | 打开/关闭组 | 时长 (ms) | 淡入/淡出 (ms) | 控制参数（曲线解析） | 右/左臂 | 可组合 | 冲突 |
|---|---|---|---|---|---|---|---|
| `gesture.right_finger` | 竖手指 | 1250 / 1250 | 300/300 | Movement1, Movement3, Param56, Param57, Param40, Param36, Param39, Param41, Param42, Param43 | right | gesture.chest | gesture.grass |
| `gesture.grass` | 狗尾巴草 | 1233 / 1133 | 300/300 | Movement1, Movement3, Param56, Param57, Param36, Param39, Param41, Param42, Param43 | right | gesture.chest | gesture.right_finger |
| `gesture.chest` | 抚胸手 | 1133 / 1017 | 300/300 | Movement2, Param56, Param57, Param62, Param59, Param60, Param61 | left | gesture.right_finger, gesture.grass | — |

## Idle

- `idle.background`：待机（Idle，渲染端自动续播），时长 5983ms，控制 ShockR, ShockL, Param11, SweatBurst1, SweatBurst2, SweatBurst3, SweatBurst4, Divider22, Param31, Param32, Param27, Param28, RCry, Param29, Param30, LCry, Startwinkle, Param55, Param56, Param58, Param57；自动；被动作打断后动作结束继续续播

## 姿势（l2d_set_pose 枚举）

| ID | API | 控制参数（来自 pose-controller PRESETS） | 前置 | 恢复 |
|---|---|---|---|---|
| `pose.rest` | l2d_set_pose({right:"rest",left:"rest"}) | Param36=0, Param39=0, Param40=0, Param41=0, Param42=0, Param43=0, Param59=0, Param60=0, Param61=0, Param62=0 | 动作未播放（setPose 在 motion-playing 时返回 false） | 6s 空闲自动缓回 rest；l2d_reset_pose 立即回 rest |
| `pose.finger` | l2d_set_pose({right:"finger"}) | Param36=0, Param39=0.322, Param40=1, Param41=0.702, Param42=0, Param43=0 | 动作未播放（setPose 在 motion-playing 时返回 false） | 6s 空闲自动缓回 rest；l2d_reset_pose 立即回 rest |
| `pose.grass` | l2d_set_pose({right:"grass"}) | Param36=0.04, Param39=0.2, Param41=-0.732, Param42=0, Param43=0 | 动作未播放（setPose 在 motion-playing 时返回 false） | 6s 空闲自动缓回 rest；l2d_reset_pose 立即回 rest |
| `pose.chest` | l2d_set_pose({left:"chest"}) | Param59=0.476, Param60=0.86, Param61=0.002, Param62=0.034 | 动作未播放（setPose 在 motion-playing 时返回 false） | 6s 空闲自动缓回 rest；l2d_reset_pose 立即回 rest |

## 视线 / 身体

| ID | API | 控制参数 | 冲突 | 恢复 |
|---|---|---|---|---|
| `gaze.look_up` | l2d_gaze({x:0,y:1}) | AngleX, AngleY, ParamEyeBallX, ParamEyeBallY, PositionX, LeanInput | body.lean_forward, motion.head | l2d_gaze({x:0,y:0}) 或 clearGaze() |
| `gaze.look_down` | l2d_gaze({x:0,y:-1}) | AngleX, AngleY, ParamEyeBallX, ParamEyeBallY, PositionX, LeanInput | body.lean_forward, motion.head | l2d_gaze({x:0,y:0}) 或 clearGaze() |
| `gaze.look_left` | l2d_gaze({x:-1,y:0}) | AngleX, AngleY, ParamEyeBallX, ParamEyeBallY, PositionX, LeanInput | body.lean_forward, motion.head | l2d_gaze({x:0,y:0}) 或 clearGaze() |
| `gaze.look_right` | l2d_gaze({x:1,y:0}) | AngleX, AngleY, ParamEyeBallX, ParamEyeBallY, PositionX, LeanInput | body.lean_forward, motion.head | l2d_gaze({x:0,y:0}) 或 clearGaze() |
| `body.lean_forward` | l2d_set_expression("前倾") | LeanInput | gaze.*, motion.head | clearExpression() / l2d_reset |
| `body.straighten` | l2d_reset_pose / l2d_reset | Param36, Param39, Param40, Param41, Param42, Param43, Param59, Param60, Param61, Param62, AngleX, AngleY, AngleZ, PositionX, PositionY | — | 无（本身就是恢复路径） |
| `body.relax` | l2d_set_pose({right:"rest",left:"rest"}) | Param36, Param39, Param40, Param41, Param42, Param43, Param59, Param60, Param61, Param62 | — | 6s 空闲自动缓回 rest；l2d_reset_pose 立即回 rest |

## 表情（21 个，参数取自 exp3.json）

| 表情 | 写入参数（值/Blend） | 语义标签 | 冲突 |
|---|---|---|---|
| 兔牙 | key9=1(Add) | mouth.happy | — |
| 加载 | key8=1(Add) | state.working | — |
| 单片眼镜 | key12=1(Add) | prop | — |
| 圈圈眼 | key3=1(Add), key4=0(Add), key5=0(Add), key6=0(Add) | eyes.surprised | expression.* (key3-6 eye family) |
| 屑 | key3=0(Add), key5=0(Add), key6=1(Add) | eyes.bright, emotion.tease | expression.* (key3-6 eye family) |
| 流泪 | key2=1(Add) | emotion.sad | — |
| 爱心眼 | key4=1(Add) | eyes.bright | expression.* (key3-6 eye family) |
| 脱鞋 | Clothes4=1(Add) | clothes | — |
| 脸红 | key7=1(Add) | emotion.shy | — |
| 钢盆 | key10=1(Add) | prop | — |
| 裙长切换 | Clothes1=-1(Add) | clothes | — |
| 黑框眼镜 | key11=1(Add) | prop | — |
| 黑脸 | key1=1(Add) | emotion.angry | — |
| ＞＜ | key3=0(Add), key4=0(Add), key5=1(Add), key6=0(Add) | eyes.narrowed, emotion.pain | expression.* (key3-6 eye family) |
| 体型1 | Clothes2=0.4(Add) | body-shape | — |
| 体型2 | Clothes2=1(Add) | body-shape | — |
| 默认体型 | Clothes2=0(Add) | body-shape | — |
| 前倾 | LeanInput=-30(Add) | body.lean_forward | — |
| 尾巴开关 | Clothes5=-1(Add) | clothes | — |
| 流冷汗 | key13=1(Add) | emotion.anxious | — |
| 胸口衣服 | Clothes3=1(Add) | clothes | — |

## 明确不登记

- **挥手（right_wave / left_wave）**（`gesture.wave`）：无 authored motion3 资产；现有 7 个动作组里没有挥手曲线（Animation/*.motion3.json 全部解析，无手部挥动约束）
- **托腮（hand_to_chin）**（`gesture.hand_to_chin`）：无 authored 资产；Exp3 只有嘴/眼/道具开关，无托腮表情
- **交叉手（arms_crossed）**（`gesture.arms_crossed`）：无 authored 资产，且左右臂参数由两套独立姿势层控制，交叉需要同时驱动双臂且无混合规则
- **双手张开（open_hands）**（`gesture.open_hands`）：无 authored 资产；手指无独立参数（W0 审计），无法用参数近似

## 未引用资产

- motion3：脱捕.motion3.json
- exp3：竖食指关.exp3.json、竖食指开.exp3.json

## 语义约束

- 动作组是「状态切换」而非一次性动作：打开后保持，直到对应关闭（motion-director.ts:1-15）。
- Cubism 5 Web SDK 不读 motion3 的 Meta.Loop；循环由渲染端 motionManager 对 Idle 单独处理。
- 成对动作的冲突判定只看姿态骨（poseParams），共用光效/待机参数（Param56/57、Movement*）不参与冲突。
- 表情是 Add 且持久：切换必须 clearExpression 或等 1s 交叉淡出；眼睛族 key3-6 同一时刻只允许一个表情。
