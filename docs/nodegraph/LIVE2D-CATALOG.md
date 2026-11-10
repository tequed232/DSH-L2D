# Live2D 目录 · 大肥鱼.dsl2d.2048（给 AI / 校验用）

## 用途与纪律

- AI 编辑节点图时，**只能使用本目录列出的 ID**（参数 / 动作组 / 表情 / 形态 / 指令名）。
- **ID、指令名、reason 代码永不翻译**；界面显示名可按语言表翻译。
- 节点图 JSON **只存 ID**（及数值），不存显示名，避免换语言后对不上模型。
- 本文件由 `tools/live2d-catalog/build-live2d-catalog.mjs` 从真实模型与代码生成；**禁止手改 ID 列表**。
- 机器可读副本：`live2d-catalog.json`（完整）、`live2d-ids.json`（后端校验精简）。

## 模型来源

| 项 | 值 |
|---|---|
| modelId | `大肥鱼.dsl2d.2048` |
| model3 | `大肥鱼.dsl2d.2048.model3.json` |
| moc3 | `大肥鱼.moc3` |
| cdi3 | `大肥鱼.cdi3.json` |
| physics3 | `大肥鱼.physics3.json` |
| pose3 | `未在模型目录中找到` |
| 量程来源 | cubism-core-6.0.1 (csmGetParameterMinimum/Maximum/DefaultValues) |
| 参数数 | 509 |
| 物理输出数 | 292 |
| 动作组数 | 7 |
| 表情数 | 21 |
| HitAreas | （空，model3 未声明） |

## 形态（forms）

来源：`packages/dsh-l2d-plugin/lib/overlay.js` 的 `BODY_TYPES`；切换写参数 `Clothes2`。

| index | label（显示名，可译） | Clothes2 取值 | 视觉系数 factor |
|---|---|---|---|
| 0 | 默认体型 | 0 | 1 |
| 1 | 体型1 | 0.4 | 1.08 |
| 2 | 体型2 | 1 | 0.95 |

- 直达切换：指令 `l2d_set_form`，`index` ∈ {0,1,2}（不钳制、不猜测）。
- 循环 +1：指令 `l2d_change_form`（只能往上切，不能回退）。

## 动作组（motions）

来源：model3 `FileReferences.Motions`。播放用组名（不是文件名）。

| 组名（ID） | 文件 | 成对槽（motion-director） |
|---|---|---|
| `抚胸手打开` | `Animation/默认手切举手.motion3.json` | 抚胸手 |
| `抚胸手关闭` | `Animation/举手切默认手.motion3.json` | 抚胸手 |
| `竖手指打开` | `Animation/竖手指切出来动画.motion3.json` | 竖手指 |
| `竖手指关闭` | `Animation/竖手指切回默认.motion3.json` | 竖手指 |
| `狗尾巴草打开` | `Animation/狗尾草切换出来.motion3.json` | 狗尾巴草 |
| `狗尾巴草关闭` | `Animation/狗尾草切回默认手.motion3.json` | 狗尾巴草 |
| `Idle` | `Animation/IDLE.motion3.json` | — |

成对规则（`packages/renderer/src/app/motion-director.ts`）：
- **抚胸手**：打开 `抚胸手打开` / 关闭 `抚胸手关闭`；姿态骨 `Param59`, `Param60`, `Param61`, `Param62`
- **竖手指**：打开 `竖手指打开` / 关闭 `竖手指关闭`；姿态骨 `Param36`, `Param39`, `Param40`, `Param41`, `Param42`, `Param43`
- **狗尾巴草**：打开 `狗尾巴草打开` / 关闭 `狗尾巴草关闭`；姿态骨 `Param36`, `Param39`, `Param41`, `Param42`, `Param43`
- `竖手指` 与 `狗尾巴草` 共用右臂姿态骨，不可同时打开；`抚胸手` 用左臂，可与右臂共存。

## 表情（expressions）

来源：model3 `FileReferences.Expressions`（Name 为 ID）。

| 表情名（ID） | 文件 | 写入参数（来自 exp3） |
|---|---|---|
| `兔牙` | `Exp3/兔牙.exp3.json` | `key9`=1 |
| `加载` | `Exp3/加载.exp3.json` | `key8`=1 |
| `单片眼镜` | `Exp3/单片眼镜.exp3.json` | `key12`=1 |
| `圈圈眼` | `Exp3/圈圈眼.exp3.json` | `key3`=1, `key4`=0, `key5`=0, `key6`=0 |
| `屑` | `Exp3/屑屑眼.exp3.json` | `key3`=0, `key5`=0, `key6`=1 |
| `流泪` | `Exp3/流泪.exp3.json` | `key2`=1 |
| `爱心眼` | `Exp3/爱心眼.exp3.json` | `key4`=1 |
| `脱鞋` | `Exp3/脱鞋.exp3.json` | `Clothes4`=1 |
| `脸红` | `Exp3/脸红.exp3.json` | `key7`=1 |
| `钢盆` | `Exp3/钢盆.exp3.json` | `key10`=1 |
| `裙长切换` | `Exp3/裙子切换.exp3.json` | `Clothes1`=-1 |
| `黑框眼镜` | `Exp3/黑框眼镜.exp3.json` | `key11`=1 |
| `黑脸` | `Exp3/黑脸.exp3.json` | `key1`=1 |
| `＞＜` | `Exp3/＞＜.exp3.json` | `key3`=0, `key4`=0, `key5`=1, `key6`=0 |
| `体型1` | `Exp3/体型1.exp3.json` | `Clothes2`=0.4000000059604645 |
| `体型2` | `Exp3/体型2.exp3.json` | `Clothes2`=1 |
| `默认体型` | `Exp3/默认体型.exp3.json` | `Clothes2`=0 |
| `前倾` | `Exp3/前倾.exp3.json` | `LeanInput`=-30 |
| `尾巴开关` | `Exp3/尾巴开关.exp3.json` | `Clothes5`=-1 |
| `流冷汗` | `Exp3/流冷汗.exp3.json` | `key13`=1 |
| `胸口衣服` | `Exp3/胸口衣服.exp3.json` | `Clothes3`=1 |

## 指令名（overlay / host-guard）

### overlay.js `case` 列表

- `l2d_set_expression`
- `l2d_play_motion`
- `l2d_emote`
- `l2d_facial`
- `l2d_facial_manual`
- `l2d_gaze`
- `l2d_say`
- `l2d_act`
- `l2d_get_state`
- `l2d_reset`
- `l2d_set_pose`
- `l2d_look_at`
- `l2d_set_parameters`
- `l2d_play_keyframes`
- `l2d_cue`
- `l2d_cue_stop`
- `l2d_stop_keyframes`
- `l2d_reset_pose`
- `l2d_change_form`
- `l2d_set_form`
- `l2d_posture`

### host-guard `HOST_ALLOWED_TOOLS`（LLM 白名单）

- `l2d_set_expression`
- `l2d_play_motion`
- `l2d_look_at`
- `l2d_set_parameters`
- `l2d_reset_pose`
- `l2d_play_keyframes`
- `l2d_stop_keyframes`
- `l2d_set_pose`
- `l2d_emote`
- `l2d_gaze`
- `l2d_say`
- `l2d_act`
- `l2d_posture`
- `l2d_get_state`
- `l2d_reset`
- `l2d_change_form`
- `l2d_facial`
- `l2d_facial_manual`
- `l2d_set_form`

仅在 overlay 出现、未进 HOST 白名单的：
- `l2d_cue`
- `l2d_cue_stop`

## 参数分组（cdi3 ParameterGroups）

| GroupId | 显示名 | 参数数 |
|---|---|---|
| `ParamGroup3` | 开关 | 25 |
| `ParamGroup8` | 身体轴 | 40 |
| `ParamGroup24` | 控制器 | 10 |
| `ParamGroup` | 眼睛 | 30 |
| `ParamGroup6` | 嘴 | 5 |
| `ParamGroup22` | VB | 24 |
| `ParamGroup13` | 五官物理 | 34 |
| `ParamGroup4` | 前发物理 | 10 |
| `ParamGroup2` | 侧发物理 | 16 |
| `ParamGroup5` | 后发物理 | 31 |
| `ParamGroup14` | 手臂 | 44 |
| `ParamGroup18` | 胸 | 9 |
| `ParamGroup23` | 头配饰 | 47 |
| `ParamGroup21` | 裙子 | 29 |
| `ParamGroup20` | 上衣 | 13 |
| `ParamGroup10` | 兽耳 | 13 |
| `ParamGroup17` | 待机动画 | 76 |
| `ParamGroup11` | 眼睛动画 | 16 |
| `ParamGroup27` | 尾巴 | 11 |
| `ParamGroup26` | 动画参数 | 18 |
| `ParamGroup15` | 闪光 | 7 |

## 参数全表

量程 / 默认：Cubism Core 读 moc3。显示名 / 分组：cdi3（cdi3 **不含** min/max/default）。
`physicsOutput=是` 时，直写需 `own:true`（见 host-guard / param-guards）。

| Id | 显示名 | 分组 | min | max | default | 物理输出 |
|---|---|---|---|---|---|---|
| `Paramshuiyin7` | -----下面是按键----- | 开关 | -1 | 1 | 0 | 否 |
| `key1` | 1. 黑脸 | 开关 | 0 | 1 | 0 | 否 |
| `key2` | 2. 落泪 | 开关 | 0 | 1 | 0 | 否 |
| `key3` | 3. 圈圈眼 | 开关 | 0 | 1 | 0 | 否 |
| `key4` | 4. 爱心眼 | 开关 | 0 | 1 | 0 | 否 |
| `key5` | 5. > <眼 | 开关 | 0 | 1 | 0 | 否 |
| `key6` | 6. 屑屑眼 | 开关 | 0 | 1 | 0 | 否 |
| `key7` | 7. 脸红 | 开关 | 0 | 1 | 0 | 否 |
| `key8` | 8. 加载 | 开关 | 0 | 1 | 0 | 否 |
| `key9` | 9. 大牙 | 开关 | 0 | 1 | 0 | 否 |
| `key10` | 10. 大钢盆 | 开关 | 0 | 1 | 0 | 否 |
| `key11` | 11. 黑框眼镜 | 开关 | 0 | 1 | 0 | 否 |
| `key12` | 12. 单片眼镜 | 开关 | 0 | 1 | 0 | 否 |
| `key13` | 13. 流冷汗 | 开关 | 0 | 1 | 0 | 否 |
| `Divider1` | ■■■■■■■■■■■■■ | 开关 | 0 | 1 | 0 | 否 |
| `Movement1` | 1. 狗尾草 | 开关 | 0 | 1 | 0 | 否 |
| `Movement2` | 2. 抚胸 | 开关 | 0 | 1 | 0 | 否 |
| `Movement3` | 3. 竖食指 | 开关 | 0 | 1 | 0 | 否 |
| `Divider3` | ■■■■■■■■■■■■■ | 开关 | 0 | 1 | 0 | 否 |
| `Clothes1` | 1. 长短裙切换 | 开关 | 0 | 1 | 1 | 否 |
| `Clothes2` | 2. 大小变 | 开关 | 0 | 1 | 0 | 否 |
| `Clothes3` | 3. 胸口衣服 | 开关 | 0 | 1 | 0 | 否 |
| `Clothes4` | 4. 鞋子 | 开关 | 0 | 1 | 0 | 否 |
| `Clothes5` | 5. 尾巴 | 开关 | 0 | 1 | 1 | 否 |
| `Paramshuiyin8` | -----按键到此结束----- | 开关 | -1 | 1 | 0 | 否 |
| `Param2` | 辅助参数 | 身体轴 | -1 | 1 | 0 | 否 |
| `Param34` | 大小变透明参数 | 身体轴 | 0 | 1 | 0 | 是 |
| `Param` | 大小变位置 | 身体轴 | 0 | 1 | 1 | 否 |
| `ParamAngleX` | AngleX | 身体轴 | -30 | 30 | 0 | 是 |
| `ParamAngleY` | AngleY | 身体轴 | -30 | 30 | 0 | 是 |
| `ParamAngleZ` | AngleZ | 身体轴 | -30 | 30 | 0 | 是 |
| `AngleXbs` | 角度 Xbs | 身体轴 | -30 | 30 | 0 | 是 |
| `AngleYbs` | 角度 Ybs | 身体轴 | -30 | 30 | 0 | 是 |
| `AngleXbs3` | 角度 Xbs +15 | 身体轴 | -30 | 30 | 30 | 否 |
| `AngleXbs2` | 角度 Xbs -15 | 身体轴 | -30 | 30 | -30 | 否 |
| `AngleYbs2` | 角度 Ybs | 身体轴 | -30 | 30 | 0 | 否 |
| `ParamBodyAngleX` | 胸腔　X | 身体轴 | -30 | 30 | 0 | 是 |
| `ParamBodyAngleY` | 胸腔　Y | 身体轴 | -30 | 30 | 0 | 是 |
| `Param50` | Lean Y | 身体轴 | 0 | 1 | 0 | 是 |
| `Param53` | Lean Y 2 | 身体轴 | 0 | 1 | 0 | 是 |
| `Param54` | Lean Y 3 | 身体轴 | 0 | 1 | 0 | 是 |
| `ParamBodyAngleZ` | 胸腔　Z | 身体轴 | -30 | 30 | 0 | 是 |
| `HipAngleZ` | 盆骨Z | 身体轴 | -30 | 30 | 0 | 是 |
| `LEGAngleZ2` | 双腿 Z | 身体轴 | -30 | 30 | 0 | 是 |
| `HipAngleX` | 盆骨X | 身体轴 | -30 | 30 | 0 | 是 |
| `HipAngleY` | 盆骨Y | 身体轴 | -30 | 30 | 0 | 是 |
| `ShoulderY` | 肩膀Y | 身体轴 | -30 | 30 | 0 | 是 |
| `ShoulderZ` | 肩膀Z | 身体轴 | -30 | 30 | 0 | 是 |
| `ShoulderX` | 肩膀X | 身体轴 | -30 | 30 | 0 | 否 |
| `ShoulderYy` | 肩头Y | 身体轴 | -30 | 30 | 0 | 否 |
| `Divider19` | ■■■■■身体物理■■■■ | 身体轴 | -1 | 1 | 0 | 否 |
| `HipZ1` | 盆骨 Z1 | 身体轴 | -1 | 1 | 0 | 是 |
| `HipZ2` | 盆骨 Z2 | 身体轴 | -1 | 1 | 0 | 是 |
| `ParamBodyAngleX2` | □胸腔　X | 身体轴 | -30 | 30 | 0 | 是 |
| `ParamBodyAngleY2` | □胸腔　Y | 身体轴 | -30 | 30 | 0 | 是 |
| `HipAngleX2` | □盆骨  X | 身体轴 | -30 | 30 | 0 | 是 |
| `ParamHipAngleZ` | □ 盆骨  Z | 身体轴 | -30 | 30 | 0 | 是 |
| `ParamHipAngleZ2` | □ 盆骨  Z 2 | 身体轴 | -30 | 30 | 0 | 是 |
| `HipAngleYUP` | □盆骨Yup | 身体轴 | -30 | 30 | 0 | 是 |
| `HipAngleYDOWN` | □盆骨Ydown | 身体轴 | -30 | 30 | 0 | 是 |
| `HipAngleXq` | 盆骨Xq | 身体轴 | -30 | 30 | 0 | 否 |
| `Param33` | 并腿 | 身体轴 | -1 | 1 | 0 | 是 |
| `ParamBodyAngleRX` | 身体位移RX | 身体轴 | -30 | 30 | 0 | 是 |
| `ParamBodyAngleRY` | 身体位移RY | 身体轴 | -30 | 30 | 0 | 否 |
| `ParamBodyAngleRZ` | 身体位移RZ | 身体轴 | -30 | 30 | 0 | 否 |
| `AngleX` | OX | 控制器 | -30 | 30 | 0 | 否 |
| `AngleY` | OY | 控制器 | -30 | 30 | 0 | 否 |
| `AngleZ` | OZ | 控制器 | -30 | 30 | 0 | 否 |
| `PositionX` | OPX | 控制器 | -30 | 30 | 0 | 否 |
| `PositionY` | OPY | 控制器 | -30 | 30 | 0 | 否 |
| `PositionZ` | OPYZ | 控制器 | -30 | 30 | 0 | 否 |
| `LeanInput` | Lean Input | 控制器 | -30 | 30 | 0 | 否 |
| `Emotion` | Emotion | 控制器 | -1 | 1 | 0 | 是 |
| `Emotion2` | Emotion 过渡 | 控制器 | -1 | 1 | 0 | 是 |
| `IDLE` | IDLE | 控制器 | 0 | 1 | 0 | 否 |
| `EyeSmile` | 微笑 | 眼睛 | -1 | 1 | 0 | 否 |
| `ParamEyeBallX` | 眼珠 X | 眼睛 | -1 | 1 | 0 | 否 |
| `ParamEyeBallY` | 眼珠 Y | 眼睛 | -1 | 1 | 0 | 否 |
| `PupilX` | 瞳孔透视X | 眼睛 | -1 | 1 | 0 | 是 |
| `PupilY` | 瞳孔透视Y | 眼睛 | -1 | 1 | 0 | 是 |
| `BrowInnerUp` | BrowInnerUp | 眼睛 | 0 | 1 | 0 | 否 |
| `Divider4` | ■■■■■■■■右眼■■■■■■ | 眼睛 | -1 | 1 | 0 | 否 |
| `RParamGlowA` | <光效A | 眼睛 | 0 | 1 | 0 | 是 |
| `RParamGlowB` | <光效B | 眼睛 | -1 | 1 | 0 | 是 |
| `RParamGlowC` | <光效C | 眼睛 | -1 | 1 | 0 | 是 |
| `ParamEyeROpen` | 右眼  开闭 | 眼睛 | 0 | 1.5 | 1 | 否 |
| `ParamBrowRY` | 右眉上下 | 眼睛 | -1 | 1 | 0 | 否 |
| `ParamBrowRAngleSmoothing` | 右眉 角度 过渡 | 眼睛 | -1 | 1 | 0 | 是 |
| `ParamBrowRAngle` | 右眉　角度 | 眼睛 | -1 | 1 | 0 | 是 |
| `ParamBrowRY2` | 右眉上下缓动 | 眼睛 | -1 | 1 | 0 | 是 |
| `ParamBrowRY3` | 右眉联动 x | 眼睛 | -1 | 1 | 0 | 是 |
| `ShockR` | Shock R | 眼睛 | -1 | 1 | 0 | 是 |
| `REyeSquint` | R-Eye Squint | 眼睛 | 0 | 1 | 0 | 否 |
| `Divider5` | ■■■■■■■■左眼■■■■■■ | 眼睛 | -1 | 1 | 0 | 否 |
| `LParamGlowA` | >光效A | 眼睛 | 0 | 1 | 0 | 是 |
| `LParamGlowB` | >光效B | 眼睛 | -1 | 1 | 0 | 是 |
| `LParamGlowC` | >光效C | 眼睛 | -1 | 1 | 0 | 否 |
| `ParamEyeLOpen` | 左眼　开闭 | 眼睛 | 0 | 1.5 | 1 | 否 |
| `ParamBrowLY` | 左眉上下 | 眼睛 | -1 | 1 | 0 | 否 |
| `ParamBrowLAngleSmoothing` | 左眉 角度 过渡 | 眼睛 | -1 | 1 | 0 | 是 |
| `ParamBrowLAngle` | 左眉　角度 | 眼睛 | -1 | 1 | 0 | 是 |
| `ParamBrowLY2` | 左眉上下缓动 | 眼睛 | -1 | 1 | 0 | 是 |
| `ParamBrowLY3` | 左眉联动 x | 眼睛 | -1 | 1 | 0 | 是 |
| `ShockL` | Shock L | 眼睛 | -1 | 1 | 0 | 是 |
| `LEyeSquint` | L-Eye Squint | 眼睛 | 0 | 1 | 0 | 否 |
| `Divider8` | ■■■■■■■■嘴■■■■■■ | 嘴 | -1 | 1 | 0 | 否 |
| `ParamMouthForm` | 嘴　变形 | 嘴 | -1 | 1 | 0 | 否 |
| `ParamMouthOpenY` | 嘴　张开和闭合 | 嘴 | 0 | 1 | 0 | 否 |
| `JawOpen` | 下巴开闭 | 嘴 | 0 | 1 | 0 | 否 |
| `TongueOut` | 伸舌头 | 嘴 | 0 | 1 | 0 | 否 |
| `Divider31` | ■■■■■■■■VB■■■■ | VB | -1 | 1 | 0 | 否 |
| `MouthX` | MouthX | VB | -1 | 1 | 0 | 否 |
| `MouthSmile_L` | MouthSmile_L | VB | 0 | 1 | 0 | 否 |
| `MouthSmile_R` | MouthSmile_R | VB | 0 | 1 | 0 | 否 |
| `Press` | 用力 | VB | 0 | 1 | 0 | 是 |
| `Mouthpucker` | 撅嘴 | VB | 0 | 1 | 0 | 否 |
| `MouthFunnel` | 漏斗嘴 | VB | 0 | 1 | 0 | 否 |
| `MouthPuckerWiden` | 嘴宽窄 | VB | -1 | 1 | 0 | 否 |
| `CheeckPuff` | 鼓脸 | VB | 0 | 1 | 0 | 否 |
| `CheeckPuff2` | 鼓脸-变化 | VB | 0 | 1 | 0 | 是 |
| `CheeckPuffR` | < 鼓脸 | VB | 0 | 1 | 0 | 是 |
| `CheeckPuffL` | > 鼓脸 | VB | 0 | 1 | 0 | 是 |
| `MouthPressLipOpen` | MouthPressLipOpen | VB | -1 | 1 | 0 | 否 |
| `MouthRollUpper` | MouthRollUpper | VB | 0 | 1 | 0 | 否 |
| `MouthRollLower` | MouthRollLower | VB | 0 | 1 | 0 | 否 |
| `NoseNeer` | NosePositionY | VB | 0 | 1 | 0 | 否 |
| `PoutOffsetXL` | 努嘴位移 X>> | VB | 0 | 30 | 0 | 是 |
| `PoutOffsetXR` | 努嘴位移 X<< | VB | 0 | 30 | 0 | 是 |
| `ParamSilence` | ParamSilence | VB | 0 | 1 | 1 | 否 |
| `ParamA` | A | VB | 0 | 1 | 0 | 否 |
| `ParamI` | I | VB | 0 | 1 | 0 | 否 |
| `ParamU` | U | VB | 0 | 1 | 0 | 否 |
| `ParamE` | E | VB | 0 | 1 | 0 | 否 |
| `ParamO` | O | VB | 0 | 1 | 0 | 否 |
| `Divider6` | <<<<<<物理■■■■■■ | 五官物理 | -1 | 1 | 0 | 否 |
| `RShiftbuffer` | <变化缓冲 | 五官物理 | 0 | 1 | 0 | 否 |
| `RColorshift` | <眼睛颜色 | 五官物理 | 0 | 1 | 0 | 否 |
| `REyeball1` | <眼珠 1 | 五官物理 | -1 | 1 | 0 | 是 |
| `REyeball2` | <眼珠 2 | 五官物理 | -1 | 1 | 0 | 是 |
| `REyeball3` | <眼珠 3 | 五官物理 | -1 | 1 | 0 | 是 |
| `REyeLashX1` | 右眼睫毛X1 | 五官物理 | -1 | 1 | 0 | 是 |
| `REyeLashX2` | 右眼睫毛X2 | 五官物理 | -1 | 1 | 0 | 是 |
| `REyes1` | 眼眶1 | 五官物理 | -1 | 1 | 0 | 是 |
| `REyes2` | 眼眶2 | 五官物理 | -1 | 1 | 0 | 是 |
| `RHighLight1` | 右眼高光1 | 五官物理 | -1 | 1 | 0 | 是 |
| `RHighLight2` | 右眼高光2 | 五官物理 | -1 | 1 | 0 | 是 |
| `RHighLight3` | 右眼高光3 | 五官物理 | -1 | 1 | 0 | 是 |
| `Divider7` | ■■■■■■物理>>>>>> | 五官物理 | -1 | 1 | 0 | 否 |
| `LEyeball1` | >眼珠 1 | 五官物理 | -1 | 1 | 0 | 是 |
| `LEyeball2` | >眼珠 2 | 五官物理 | -1 | 1 | 0 | 是 |
| `LEyeball3` | >眼珠 3 | 五官物理 | -1 | 1 | 0 | 是 |
| `LEyes1` | 眼眶1 | 五官物理 | -1 | 1 | 0 | 是 |
| `LEyes2` | 眼眶2 | 五官物理 | -1 | 1 | 0 | 是 |
| `LEyeLashX1` | 左眼睫毛X1 | 五官物理 | -1 | 1 | 0 | 是 |
| `LEyeLashX2` | 左眼睫毛X2 | 五官物理 | -1 | 1 | 0 | 是 |
| `LHighLight1` | 左眼高光1 | 五官物理 | -1 | 1 | 0 | 是 |
| `LHighLight2` | 左眼高光2 | 五官物理 | -1 | 1 | 0 | 是 |
| `LHighLight3` | 左眼高光3 | 五官物理 | -1 | 1 | 0 | 是 |
| `Divider15` | ■■■ 口物理 ■■■ | 五官物理 | -1 | 1 | 0 | 否 |
| `CheeksWiggleX` | 脸盘抖动X | 五官物理 | -1 | 1 | 0 | 是 |
| `CheeksWiggleXR` | 脸盘抖动X< | 五官物理 | -1 | 1 | 0 | 是 |
| `CheeksWiggleXL` | 脸盘抖动X> | 五官物理 | -1 | 1 | 0 | 是 |
| `CheeksWiggleY` | 脸盘抖动Y | 五官物理 | -1 | 1 | 0 | 是 |
| `LipPhysics1` | 嘴唇物理1 | 五官物理 | -1 | 1 | 0 | 是 |
| `LipPhysics2` | 嘴唇物理2 | 五官物理 | -1 | 1 | 0 | 是 |
| `LipPhysics3` | 嘴唇物理3 | 五官物理 | -1 | 1 | 0 | 是 |
| `ParamTongueUpDown` | 舌头上下 | 五官物理 | -1 | 1 | 0 | 是 |
| `ParamTongueWidth` | 舌头宽窄 | 五官物理 | -1 | 1 | 0 | 是 |
| `Divider11` | ■■■■■■■■头发物理■■■ | 前发物理 | -1 | 1 | 0 | 否 |
| `FrontHairZ` | 前发Z | 前发物理 | -1 | 1 | 0 | 否 |
| `FrontHairX1` | 前发X1 | 前发物理 | -1 | 1 | 0 | 是 |
| `FrontHairX2` | 前发X2 | 前发物理 | -1 | 1 | 0 | 是 |
| `FrontHairX3` | 前发X3 | 前发物理 | -1 | 1 | 0 | 是 |
| `FrontHairX4` | 前发X4 | 前发物理 | -1 | 1 | 0 | 是 |
| `FrontHairY1` | 前发Y1 | 前发物理 | -1 | 1 | 0 | 是 |
| `FrontHairY2` | 前发Y2 | 前发物理 | -1 | 1 | 0 | 是 |
| `FrontHairY3` | 前发Y3 | 前发物理 | -1 | 1 | 0 | 是 |
| `FrontHairY4` | 前发Y4 | 前发物理 | -1 | 1 | 0 | 是 |
| `SideHairX1` | 侧发X1 | 侧发物理 | -1 | 1 | 0 | 是 |
| `SideHairX2` | 侧发X2 | 侧发物理 | -1 | 1 | 0 | 是 |
| `SideHairX3` | 侧发X3 | 侧发物理 | -1 | 1 | 0 | 是 |
| `SideHairX4` | 侧发X4 | 侧发物理 | -1 | 1 | 0 | 是 |
| `SideHairY1` | 侧发Y1 | 侧发物理 | -1 | 1 | 0 | 是 |
| `SideHairY2` | 侧发Y2 | 侧发物理 | -1 | 1 | 0 | 是 |
| `SideHairY3` | 侧发Y3 | 侧发物理 | -1 | 1 | 0 | 是 |
| `SideHairY4` | 侧发Y4 | 侧发物理 | -1 | 1 | 0 | 是 |
| `SideHairLX1` | 侧发LX1 | 侧发物理 | -1 | 1 | 0 | 是 |
| `SideHairRX1` | 侧发RX1 | 侧发物理 | -1 | 1 | 0 | 是 |
| `SideHairRX2` | 侧发RX2 | 侧发物理 | -1 | 1 | 0 | 是 |
| `SideHairRX3` | 侧发RX3 | 侧发物理 | -1 | 1 | 0 | 是 |
| `SideHairRBS` | 侧发RBS | 侧发物理 | -1 | 1 | 0 | 是 |
| `SideHairLX2` | 侧发LX2 | 侧发物理 | -1 | 1 | 0 | 是 |
| `SideHairLX3` | 侧发LX3 | 侧发物理 | -1 | 1 | 0 | 是 |
| `SideHairLBS` | 侧发LBS | 侧发物理 | -1 | 1 | 0 | 是 |
| `LateSideHairX1` | 后侧发X1 | 后发物理 | -1 | 1 | 0 | 是 |
| `LateSideHairX2` | 后侧发X2 | 后发物理 | -1 | 1 | 0 | 是 |
| `LateSideHairX3` | 后侧发X3 | 后发物理 | -1 | 1 | 0 | 是 |
| `LateSideHairX4` | 后侧发X4 | 后发物理 | -1 | 1 | 0 | 是 |
| `LateSideHairX5` | 后侧发X5 | 后发物理 | -1 | 1 | 0 | 是 |
| `LateSideHairXBS` | 后侧发XBS | 后发物理 | -1 | 1 | 0 | 否 |
| `LateSideHairY1` | 后侧发Y1 | 后发物理 | -1 | 1 | 0 | 是 |
| `LateSideHairY2` | 后侧发Y2 | 后发物理 | -1 | 1 | 0 | 是 |
| `LateSideHairY3` | 后侧发Y3 | 后发物理 | -1 | 1 | 0 | 是 |
| `LateSideHairY4` | 后侧发Y4 | 后发物理 | -1 | 1 | 0 | 是 |
| `LateSideHairY5` | 后侧发Y5 | 后发物理 | -1 | 1 | 0 | 是 |
| `LateSideHairYbs` | 后侧发Ybs | 后发物理 | -1 | 1 | 0 | 否 |
| `LateHairZ` | 后发 Z | 后发物理 | -30 | 30 | 0 | 是 |
| `LateHairX1` | 后发X1 | 后发物理 | -1 | 1 | 0 | 是 |
| `LateHairX2` | 后发X2 | 后发物理 | -1 | 1 | 0 | 是 |
| `LateHairX3` | 后发X3 | 后发物理 | -1 | 1 | 0 | 是 |
| `LateHairX4` | 后发X4 | 后发物理 | -1 | 1 | 0 | 是 |
| `LateHairX5` | 后发X5 | 后发物理 | -1 | 1 | 0 | 是 |
| `LateHairY1` | 后发Y1 | 后发物理 | -1 | 1 | 0 | 是 |
| `LateHairY2` | 后发Y2 | 后发物理 | -1 | 1 | 0 | 是 |
| `LateHairY3` | 后发Y3 | 后发物理 | -1 | 1 | 0 | 是 |
| `LateHairY4` | 后发Y4 | 后发物理 | -1 | 1 | 0 | 是 |
| `LateHairY5` | 后发Y5 | 后发物理 | -1 | 1 | 0 | 是 |
| `ShortPonytailX1` | 短马尾X1 | 后发物理 | -1 | 1 | 0 | 是 |
| `ShortPonytailX2` | 短马尾X2 | 后发物理 | -1 | 1 | 0 | 是 |
| `ShortPonytailXBS` | 短马尾XBS | 后发物理 | -1 | 1 | 0 | 是 |
| `ShortPonytailXBS2` | 短马尾XBS2 | 后发物理 | -1 | 1 | 0 | 是 |
| `ShortPonytailY` | 短马尾Y | 后发物理 | -1 | 1 | 0 | 是 |
| `ShortPonytailY2` | 短马尾Y2 | 后发物理 | -1 | 1 | 0 | 是 |
| `ShortPonytailYBS` | 短马尾YBS | 后发物理 | -1 | 1 | 0 | 是 |
| `ShortPonytailYBS2` | 短马尾YBS2 | 后发物理 | -1 | 1 | 0 | 是 |
| `Divider9` | ■■■■■■■■左手臂■■■■ | 手臂 | -1 | 1 | 0 | 否 |
| `Param35` | 手臂开关物理 | 手臂 | -1 | 1 | 0 | 是 |
| `Param44` | 左臂Z | 手臂 | -1 | 1 | 0 | 是 |
| `LArm` | 左大臂 | 手臂 | -1 | 1 | 0 | 是 |
| `LForearm` | 左小臂 | 手臂 | -1 | 1 | 0 | 是 |
| `LWrist` | 左手腕 | 手臂 | -1 | 1 | 0 | 是 |
| `LHand` | 左手指 | 手臂 | -1 | 1 | 0 | 是 |
| `LHand2` | 左手指 | 手臂 | -1 | 1 | 0 | 是 |
| `LSleeveX1` | 左袖子X1 | 手臂 | -1 | 1 | 0 | 是 |
| `LSleeveX2` | 左袖子X2 | 手臂 | -1 | 1 | 0 | 是 |
| `LSleeveX3` | 左袖子X3 | 手臂 | -1 | 1 | 0 | 是 |
| `LSleeveY` | 左袖子Y1 | 手臂 | -1 | 1 | 0 | 是 |
| `LSleeveY2` | 左袖子Y2 | 手臂 | -1 | 1 | 0 | 是 |
| `LSleeveY3` | 左袖子Y3 | 手臂 | -1 | 1 | 0 | 是 |
| `LRibbonX1` | 左飘带X1 | 手臂 | -1 | 1 | 0 | 是 |
| `LRibbonX2` | 左飘带X2 | 手臂 | -1 | 1 | 0 | 是 |
| `LRibbonX3` | 左飘带X3 | 手臂 | -1 | 1 | 0 | 是 |
| `LRibbonX4` | 左飘带X4 | 手臂 | -1 | 1 | 0 | 是 |
| `LRibbonY1` | 左飘带Y1 | 手臂 | -1 | 1 | 0 | 否 |
| `LRibbonY2` | 左飘带Y2 | 手臂 | -1 | 1 | 0 | 否 |
| `LRibbonY3` | 左飘带Y3 | 手臂 | -1 | 1 | 0 | 否 |
| `LRibbonY4` | 左飘带Y4 | 手臂 | -1 | 1 | 0 | 否 |
| `Divider10` | ■■■■■■■■右手臂■■■■ | 手臂 | -1 | 1 | 0 | 否 |
| `Param25` | 右手Z | 手臂 | -1 | 1 | 0 | 是 |
| `RArm` | 右大臂 | 手臂 | -1 | 1 | 0 | 是 |
| `RForearm` | 右小臂 | 手臂 | -1 | 1 | 0 | 是 |
| `RWrist` | 右手腕 | 手臂 | -1 | 1 | 0 | 是 |
| `RHand` | 右手指 | 手臂 | -1 | 1 | 0 | 是 |
| `RHand2` | 右手指 | 手臂 | -1 | 1 | 0 | 是 |
| `RSleeveX1` | 右袖子X1 | 手臂 | -1 | 1 | 0 | 是 |
| `RSleeveX2` | 右袖子X2 | 手臂 | -1 | 1 | 0 | 是 |
| `RSleeveX3` | 右袖子X3 | 手臂 | -1 | 1 | 0 | 是 |
| `RSleeveX4` | 右袖子X4 | 手臂 | -1 | 1 | 0 | 否 |
| `RSleeveY1` | 右袖子Y1 | 手臂 | -1 | 1 | 0 | 是 |
| `RSleeveY2` | 右袖子Y2 | 手臂 | -1 | 1 | 0 | 是 |
| `RSleeveY3` | 右袖子Y3 | 手臂 | -1 | 1 | 0 | 是 |
| `RRibbonX1` | 右飘带X1 | 手臂 | -1 | 1 | 0 | 是 |
| `RRibbonX2` | 右飘带X2 | 手臂 | -1 | 1 | 0 | 是 |
| `RRibbonX3` | 右飘带X3 | 手臂 | -1 | 1 | 0 | 是 |
| `RRibbonX4` | 右飘带X4 | 手臂 | -1 | 1 | 0 | 是 |
| `RRibbonY1` | 右飘带Y1 | 手臂 | -1 | 1 | 0 | 否 |
| `RRibbonY2` | 右飘带Y2 | 手臂 | -1 | 1 | 0 | 否 |
| `RRibbonY3` | 右飘带Y3 | 手臂 | -1 | 1 | 0 | 否 |
| `RRibbonY4` | 右飘带Y4 | 手臂 | -1 | 1 | 0 | 否 |
| `Divider18` | ■■■■■■■■胸■■■■ | 胸 | -1 | 1 | 0 | 否 |
| `ChestX1` | 胸X1 | 胸 | -1 | 1 | 0 | 是 |
| `ChestX2` | 胸X2 | 胸 | -1 | 1 | 0 | 是 |
| `ChestX3` | 胸X3 | 胸 | -1 | 1 | 0 | 是 |
| `ChestXBS` | 胸XBS | 胸 | -1 | 1 | 0 | 是 |
| `ChestY1` | 胸Y1 | 胸 | -1 | 1 | 0 | 是 |
| `ChestY2` | 胸Y2 | 胸 | -1 | 1 | 0 | 是 |
| `ChestY3` | 胸Y3 | 胸 | -1 | 1 | 0 | 是 |
| `ChestY4` | 胸↓ | 胸 | -1 | 1 | 0 | 是 |
| `Divider12` | ■■■■■■■■头配饰■■■■ | 头配饰 | -1 | 1 | 0 | 否 |
| `Shine` | 闪光 | 头配饰 | -1 | 1 | -1 | 是 |
| `ShineX` | 闪光旋转 | 头配饰 | -1 | 1 | 0 | 是 |
| `ShineBIG` | 闪光大小 | 头配饰 | -1 | 1 | 0 | 是 |
| `Hat_XA` | 帽子 XA | 头配饰 | -1 | 1 | 0 | 是 |
| `Hat_XB` | 帽子 XB | 头配饰 | -1 | 1 | 0 | 是 |
| `Hat_XC` | 帽子 XC | 头配饰 | -1 | 1 | 0 | 是 |
| `Hat_YA` | 帽子 YA | 头配饰 | -1 | 1 | 0 | 是 |
| `Hat_YB` | 帽子 YB | 头配饰 | -1 | 1 | 0 | 是 |
| `Hat_YC` | 帽子 YC | 头配饰 | -1 | 1 | 0 | 是 |
| `RBowX8` | <-配饰X1 | 头配饰 | -1 | 1 | 0 | 是 |
| `RBowX5` | <-配饰X2 | 头配饰 | -1 | 1 | 0 | 是 |
| `RBowX6` | <-配饰X3 | 头配饰 | -1 | 1 | 0 | 是 |
| `RBowX7` | <-配饰X4 | 头配饰 | -1 | 1 | 0 | 是 |
| `RBowX1` | <-配饰X1 | 头配饰 | -1 | 1 | 0 | 是 |
| `RBowX2` | <-配饰X2 | 头配饰 | -1 | 1 | 0 | 是 |
| `RBowX3` | <-配饰X3 | 头配饰 | -1 | 1 | 0 | 是 |
| `RBowX4` | <-配饰X4 | 头配饰 | -1 | 1 | 0 | 是 |
| `LBowX1` | >-配饰X1 | 头配饰 | -1 | 1 | 0 | 是 |
| `LowX2` | >-配饰X2 | 头配饰 | -1 | 1 | 0 | 是 |
| `LBowX3` | >-配饰X3 | 头配饰 | -1 | 1 | 0 | 是 |
| `LBowX4` | >-配饰X4 | 头配饰 | -1 | 1 | 0 | 是 |
| `RJewelry1` | < 耳环 A | 头配饰 | -1 | 1 | 0 | 是 |
| `RJewelry2` | < 耳环 B | 头配饰 | -1 | 1 | 0 | 是 |
| `RJewelry3` | < 耳环 C | 头配饰 | -1 | 1 | 0 | 是 |
| `LJewelry1` | > 耳环 A | 头配饰 | -1 | 1 | 0 | 是 |
| `LJewelry2` | > 耳环 B | 头配饰 | -1 | 1 | 0 | 是 |
| `LJewelry3` | > 耳环 C | 头配饰 | -1 | 1 | 0 | 是 |
| `Divider23` | ■■■■■■■■■■■■ | 头配饰 | -1 | 1 | 0 | 否 |
| `ribbonX1` | 缎带X1 | 头配饰 | -1 | 1 | 0 | 是 |
| `ribbonX2` | 缎带X2 | 头配饰 | -1 | 1 | 0 | 是 |
| `ribbonX3` | 缎带X3 | 头配饰 | -1 | 1 | 0 | 是 |
| `ribbonX4` | 缎带X4 | 头配饰 | -1 | 1 | 0 | 是 |
| `ribbonY1` | 缎带Y1 | 头配饰 | -1 | 1 | 0 | 是 |
| `ribbonY2` | 缎带Y2 | 头配饰 | -1 | 1 | 0 | 是 |
| `ribbonY3` | 缎带Y3 | 头配饰 | -1 | 1 | 0 | 是 |
| `ribbonY4` | 缎带Y4 | 头配饰 | -1 | 1 | 0 | 是 |
| `ribbonX5` | 缎带X1 | 头配饰 | -1 | 1 | 0 | 是 |
| `ribbonX7` | 缎带X2 | 头配饰 | -1 | 1 | 0 | 是 |
| `ribbonX6` | 缎带X3 | 头配饰 | -1 | 1 | 0 | 是 |
| `ribbonY5` | 缎带Y1 | 头配饰 | -1 | 1 | 0 | 是 |
| `ribbonY6` | 缎带Y2 | 头配饰 | -1 | 1 | 0 | 是 |
| `ribbonY7` | 缎带Y3 | 头配饰 | -1 | 1 | 0 | 是 |
| `Hat2pha` | 帽子尖 PHA | 头配饰 | -1 | 1 | 0 | 是 |
| `Hat2phB` | 帽子尖 PHB | 头配饰 | -1 | 1 | 0 | 是 |
| `Hat2phC` | 帽子尖 PHC | 头配饰 | -1 | 1 | 0 | 是 |
| `Hat2phD` | 帽子尖 PHD | 头配饰 | -1 | 1 | 0 | 是 |
| `Divider20` | ■■■■■■■■裙子■■■■ | 裙子 | -1 | 1 | 0 | 否 |
| `SkirtX1` | 裙X1 | 裙子 | -1 | 1 | 0 | 是 |
| `SkirtX2` | 裙X2 | 裙子 | -1 | 1 | 0 | 是 |
| `SkirtX3` | 裙X3 | 裙子 | -1 | 1 | 0 | 是 |
| `SkirtX4` | 裙X4 | 裙子 | -1 | 1 | 0 | 是 |
| `SkirtSpecial` | 裙X特殊 | 裙子 | -1 | 1 | 0 | 是 |
| `SkirtSpecial2` | 裙X特殊2 | 裙子 | -1 | 1 | 0 | 是 |
| `SkirtY` | 裙Y | 裙子 | -1 | 1 | 0 | 是 |
| `SkirtY2` | 裙Y2 | 裙子 | -1 | 1 | 0 | 是 |
| `SkirtY3` | 裙Y3 | 裙子 | -1 | 1 | 0 | 是 |
| `SkirtY4` | 裙Y4 | 裙子 | -1 | 1 | 0 | 是 |
| `SkirtY5` | 裙Y5 | 裙子 | -1 | 1 | 0 | 是 |
| `SkirtYBS` | 裙YBS | 裙子 | -1 | 1 | 0 | 是 |
| `SkirtY6` | 裙Y | 裙子 | -1 | 1 | 0 | 是 |
| `SkirtY7` | 裙Y2 | 裙子 | -1 | 1 | 0 | 是 |
| `SkirtY9` | 裙Y3 | 裙子 | -1 | 1 | 0 | 是 |
| `SkirtY8` | 裙Y4 | 裙子 | -1 | 1 | 0 | 是 |
| `SkirtLayerX1` | 裙子层级X1 | 裙子 | -1 | 1 | 0 | 是 |
| `SkirtLayerX2` | 裙子层级X2 | 裙子 | -1 | 1 | 0 | 是 |
| `SkirtLayerX3` | 裙子层级X3 | 裙子 | -1 | 1 | 0 | 是 |
| `SkirtLayerX4` | 裙子层级X4 | 裙子 | -1 | 1 | 0 | 是 |
| `SkirtLayerX5` | 裙子层级X5 | 裙子 | -1 | 1 | 0 | 是 |
| `SkirtLayerX6` | 裙子层级X6 | 裙子 | -1 | 1 | 0 | 是 |
| `SkirtLayerY1` | 裙子层级Y1 | 裙子 | -1 | 1 | 0 | 是 |
| `SkirtLayerY2` | 裙子层级Y2 | 裙子 | -1 | 1 | 0 | 是 |
| `SkirtLayerY3` | 裙子层级Y3 | 裙子 | -1 | 1 | 0 | 是 |
| `SkirtLayerY4` | 裙子层级Y4 | 裙子 | -1 | 1 | 0 | 是 |
| `SkirtLayerY5` | 裙子层级Y5 | 裙子 | -1 | 1 | 0 | 是 |
| `SkirtLayerY6` | 裙子层级Y6 | 裙子 | -1 | 1 | 0 | 否 |
| `Divider14` | ■■■■■■■■上衣■■■■ | 上衣 | -1 | 1 | 0 | 否 |
| `LaceRX` | < 花边X1 | 上衣 | -1 | 1 | 0 | 是 |
| `LaceRX2` | < 花边X2 | 上衣 | -1 | 1 | 0 | 是 |
| `LaceRX3` | < 花边X3 | 上衣 | -1 | 1 | 0 | 是 |
| `LaceLX1` | > 花边X1 | 上衣 | -1 | 1 | 0 | 是 |
| `LaceLX2` | > 花边LX2 | 上衣 | -1 | 1 | 0 | 是 |
| `LaceLX3` | > 花边LX3 | 上衣 | -1 | 1 | 0 | 是 |
| `LaceX1` | 缎带X1 | 上衣 | -1 | 1 | 0 | 是 |
| `LaceX2` | 缎带X2 | 上衣 | -1 | 1 | 0 | 是 |
| `LaceX3` | 缎带X3 | 上衣 | -1 | 1 | 0 | 是 |
| `LaceY1` | 缎带Y1 | 上衣 | -1 | 1 | 0 | 是 |
| `LaceY2` | 缎带Y2 | 上衣 | -1 | 1 | 0 | 是 |
| `LaceY3` | 缎带Y3 | 上衣 | -1 | 1 | 0 | 是 |
| `Divider13` | ■■■■■■■■兽耳■■■■ | 兽耳 | -1 | 1 | 0 | 否 |
| `LControl` | < Control | 兽耳 | -1 | 1 | 0 | 是 |
| `RFlip` | < Flip x | 兽耳 | -1 | 1 | 0 | 是 |
| `RFlip2` | < Flip y | 兽耳 | -1 | 1 | 0 | 是 |
| `LEar1` | <兽耳PHA | 兽耳 | -1 | 1 | 0 | 是 |
| `LEar2` | <兽耳PHB | 兽耳 | -1 | 1 | 0 | 是 |
| `LEar3` | <兽耳PHC | 兽耳 | -1 | 1 | 0 | 是 |
| `RControl` | > Control | 兽耳 | -1 | 1 | 0 | 是 |
| `LFlip` | > Flip x | 兽耳 | -1 | 1 | 0 | 是 |
| `LFlip2` | > Flip y | 兽耳 | -1 | 1 | 0 | 是 |
| `REar1` | >兽耳PHA | 兽耳 | -1 | 1 | 0 | 是 |
| `REar2` | >兽耳PHB | 兽耳 | -1 | 1 | 0 | 是 |
| `REar3` | >兽耳PHC | 兽耳 | -1 | 1 | 0 | 是 |
| `Divider33` | ■■■■■■■■动画■■■■ | 待机动画 | -1 | 1 | 0 | 否 |
| `Param11` | 呆滞 | 待机动画 | 0 | 8 | 0 | 否 |
| `MicroGlows` | 话筒光 | 待机动画 | 0 | 1 | 0 | 否 |
| `SweatBurst1` | 冒汗1 | 待机动画 | 0 | 1 | 0 | 否 |
| `SweatBurst2` | 冒汗1 开关 | 待机动画 | 0 | 1 | 0 | 否 |
| `SweatBurst3` | 冒汗2 | 待机动画 | 0 | 1 | 0 | 否 |
| `SweatBurst4` | 冒汗2 开关 | 待机动画 | 0 | 1 | 0 | 否 |
| `SweatBurst5` | 冒汗3 | 待机动画 | 0 | 1 | 0 | 否 |
| `SweatBurst6` | 冒汗3 开关 | 待机动画 | 0 | 1 | 0 | 否 |
| `Sweat1` | 流汗1 | 待机动画 | 0 | 1 | 0 | 否 |
| `Sweat2` | 流汗2 | 待机动画 | 0 | 1 | 0 | 否 |
| `WingOpenClose` | 翅膀开合 | 待机动画 | -1 | 1 | 0 | 否 |
| `WingSpread` | 翅膀舒展 | 待机动画 | -1 | 1 | 0 | 否 |
| `FeatherPhysics1` | 羽毛物理1 | 待机动画 | -1 | 1 | 0 | 否 |
| `FeatherPhysics2` | 羽毛物理2 | 待机动画 | -1 | 1 | 0 | 否 |
| `WingRotation` | 翅膀旋转 | 待机动画 | -1 | 1 | 0 | 否 |
| `WingOpenClose2` | 翅膀开合 | 待机动画 | -1 | 1 | 0 | 否 |
| `WingSpread2` | 翅膀舒展 | 待机动画 | -1 | 1 | 0 | 否 |
| `FeatherPhysics3` | 羽毛物理1 | 待机动画 | -1 | 1 | 0 | 否 |
| `FeatherPhysics4` | 羽毛物理2 | 待机动画 | -1 | 1 | 0 | 否 |
| `WingRotation2` | 翅膀旋转 | 待机动画 | -1 | 1 | 0 | 否 |
| `Param140` | 加载 | 待机动画 | 0 | 1 | 0 | 否 |
| `Param137` | 炸毛 | 待机动画 | 0 | 1 | 0 | 否 |
| `Param139` | 炸毛移动 | 待机动画 | 0 | 1 | 0 | 否 |
| `Param138` | 身体抖动 | 待机动画 | -1 | 1 | 0 | 否 |
| `SHOCKEYE` | SHOCK EYE | 待机动画 | -1 | 1 | 0 | 否 |
| `Param135` | 爱心UD | 待机动画 | -1 | 1 | 0 | 否 |
| `Param6` | 爱心弹1 | 待机动画 | -1 | 1 | 0 | 否 |
| `Param7` | 爱心弹2 | 待机动画 | -1 | 1 | 0 | 否 |
| `Param132` | 泪花 A | 待机动画 | -1 | 1 | 0 | 否 |
| `Param133` | 泪花 B | 待机动画 | -1 | 1 | 0 | 否 |
| `Angry` | 生气 | 待机动画 | 0 | 1 | 0 | 否 |
| `Param136` | 钱 | 待机动画 | 0 | 1 | 0 | 否 |
| `Angry2` | 生气 | 待机动画 | 0 | 1 | 0 | 否 |
| `Angry3` | 生气 | 待机动画 | 0 | 1 | 0 | 否 |
| `AniEyerolling` | 蚊香眼 | 待机动画 | 0 | 30 | 0 | 否 |
| `Ani1` | 动画1 | 待机动画 | -1 | 1 | -1 | 否 |
| `SWITCHA` | 开关A | 待机动画 | 0 | 1 | 0 | 否 |
| `Ani2` | 动画2 | 待机动画 | -1 | 1 | 0 | 否 |
| `Param141` | 闪光 1 | 待机动画 | 0 | 1 | 0 | 否 |
| `Param142` | 闪光 2 | 待机动画 | 0 | 1 | 0 | 否 |
| `Divider24` | ■■■■■■逸散的光点■■■■ | 待机动画 | -1 | 1 | 0 | 否 |
| `F1Anikey` | 花1动画开关 | 待机动画 | 0 | 1 | 0 | 否 |
| `F2Anikey` | 花2动画开关 | 待机动画 | 0 | 1 | 0 | 否 |
| `F3Anikey` | 花3动画开关 | 待机动画 | 0 | 1 | 0 | 否 |
| `Colorflicker5` | 1眼光显隐 | 待机动画 | 0 | 1 | 0 | 否 |
| `Glintshift5` | 1眼光移动 | 待机动画 | 0 | 1 | 0 | 否 |
| `Colorflicker6` | 2眼光显隐 | 待机动画 | 0 | 1 | 0 | 否 |
| `Glintshift6` | 2眼光移动 | 待机动画 | 0 | 1 | 0 | 否 |
| `Colorflicker7` | 3眼光显隐 | 待机动画 | 0 | 1 | 0 | 否 |
| `Glintshift8` | 3眼光移动 | 待机动画 | 0 | 1 | 0 | 否 |
| `Colorflicker8` | 4眼光显隐 | 待机动画 | 0 | 1 | 0 | 否 |
| `Glintshift7` | 4眼光移动 | 待机动画 | 0 | 1 | 0 | 否 |
| `Divider25` | ■■■■■■飘花特效■■■■ | 待机动画 | -1 | 1 | 0 | 否 |
| `LittleFlower1` | 小花飘落1 | 待机动画 | 0 | 1 | 0 | 否 |
| `LittleFlower2` | 小花显隐1 | 待机动画 | 0 | 1 | 0 | 否 |
| `LittleFlower9` | 小花左右 | 待机动画 | -1 | 1 | 0 | 否 |
| `LittleFlower3` | 小花飘落2 | 待机动画 | 0 | 1 | 0 | 否 |
| `LittleFlower4` | 小花显隐2 | 待机动画 | 0 | 1 | 0 | 否 |
| `LittleFlower10` | 小花左右 | 待机动画 | -1 | 1 | 0 | 否 |
| `LittleFlower5` | 小花飘落3 | 待机动画 | 0 | 1 | 0 | 否 |
| `LittleFlower6` | 小花显隐3 | 待机动画 | 0 | 1 | 0 | 否 |
| `LittleFlower11` | 花形变 | 待机动画 | 0 | 1 | 0 | 否 |
| `LittleFlower13` | 花旋转 | 待机动画 | -1 | 1 | 0 | 否 |
| `LittleFlower12` | 花左右 | 待机动画 | -1 | 1 | 0 | 否 |
| `Divider28` | ■■■■■■生气■■■■ | 待机动画 | -1 | 1 | 0 | 否 |
| `Param12` | 生气1 | 待机动画 | 0 | 1 | 0 | 否 |
| `Param13` | 生气2 | 待机动画 | 0 | 1 | 0 | 否 |
| `AngryMove` | 生气移动 | 待机动画 | 0 | 1 | 0 | 否 |
| `AngryMove3` | 生气显隐 | 待机动画 | 0 | 1 | 0 | 否 |
| `AngryMove2` | 生气伸缩 | 待机动画 | -1 | 1 | 0 | 否 |
| `AngryMove4` | 生气伸缩2 | 待机动画 | -1 | 1 | 0 | 否 |
| `AngryMove5` | 生气移动 | 待机动画 | 0 | 1 | 0 | 否 |
| `AngryMove8` | 生气显隐 | 待机动画 | 0 | 1 | 0 | 否 |
| `AngryMove6` | 生气伸缩 | 待机动画 | -1 | 1 | 0 | 否 |
| `AngryMove7` | 生气伸缩2 | 待机动画 | -1 | 1 | 0 | 否 |
| `Divider16` | ■■■■■■■■眼睛动画■■■■■■ | 眼睛动画 | -1 | 1 | 0 | 否 |
| `Divider22` | ■■■■■■■■动画■■■■ | 眼睛动画 | -1 | 1 | 0 | 否 |
| `Param31` | 泪花闪烁 | 眼睛动画 | -1 | 1 | 0 | 否 |
| `Param32` | 高光闪烁 | 眼睛动画 | -1 | 1 | 0 | 否 |
| `Param27` | < 流泪-膨胀 | 眼睛动画 | -1 | 1 | 0 | 否 |
| `Param28` | < 流泪-滴下1 | 眼睛动画 | 0 | 1 | 0 | 否 |
| `RCry` | <落泪 | 眼睛动画 | 0 | 1 | 0 | 否 |
| `RCryKey` | <落泪开关 | 眼睛动画 | 0 | 1 | 0 | 否 |
| `RCry2` | <落泪 涌出 | 眼睛动画 | 0 | 1 | 0 | 否 |
| `Param29` | > 流泪-膨胀 | 眼睛动画 | -1 | 1 | 0 | 否 |
| `Param30` | > 流泪-滴下1 | 眼睛动画 | 0 | 1 | 0 | 否 |
| `LCry` | >落泪 | 眼睛动画 | 0 | 1 | 0 | 否 |
| `LCryKey` | >落泪开关 | 眼睛动画 | 0 | 1 | 1 | 否 |
| `LCry3` | >落泪 涌出 | 眼睛动画 | 0 | 1 | 0 | 否 |
| `Startwinkle` | 星星闪烁 | 眼睛动画 | -1 | 1 | 0 | 否 |
| `Startwinkle2` | 星星闪烁2 | 眼睛动画 | -1 | 1 | 0 | 否 |
| `Param55` | 光1 | 尾巴 | 0 | 1 | 0 | 否 |
| `Param56` | 光2 | 尾巴 | 0 | 1 | 0 | 否 |
| `Param58` | 光3 | 尾巴 | 0 | 1 | 0 | 否 |
| `Param57` | 光4 | 尾巴 | 0 | 1 | 0 | 否 |
| `Param52` | 尾巴翻面 | 尾巴 | -1 | 1 | 0 | 是 |
| `Param_Angle_Rotation84` | [0]尾巴 | 尾巴 | -45 | 45 | 0 | 是 |
| `Param_Angle_Rotation85` | [1]尾巴 | 尾巴 | -45 | 45 | 0 | 是 |
| `Param_Angle_Rotation86` | [2]尾巴 | 尾巴 | -45 | 45 | 0 | 是 |
| `Param_Angle_Rotation87` | [3]尾巴 | 尾巴 | -45 | 45 | 0 | 是 |
| `Param_Angle_Rotation88` | [4]尾巴 | 尾巴 | -45 | 45 | 0 | 是 |
| `Param_Angle_Rotation89` | [5]尾巴 | 尾巴 | -45 | 45 | 0 | 是 |
| `Param51` | 草放大 | 动画参数 | -1 | 1 | 0 | 否 |
| `Param45` | 草物理1 | 动画参数 | -1 | 1 | 0 | 是 |
| `Param46` | 草物理2 | 动画参数 | -1 | 1 | 0 | 是 |
| `Param47` | 草物理3 | 动画参数 | -1 | 1 | 0 | 是 |
| `Param48` | 草物理4 | 动画参数 | -1 | 1 | 0 | 是 |
| `Param49` | 草物理5 | 动画参数 | -1 | 1 | 0 | 是 |
| `Param37` | 动画开关 | 动画参数 | 0 | 1 | 0 | 否 |
| `Param38` | 动画 双手开关 | 动画参数 | 0 | 1 | 0 | 否 |
| `Param40` | 竖手指 大臂无缝用 | 动画参数 | 0 | 1 | 0 | 否 |
| `Param36` | R大臂z | 动画参数 | -1 | 1 | 0 | 否 |
| `Param39` | 大臂透视 | 动画参数 | -1 | 1 | 0 | 否 |
| `Param41` | R小臂 Z | 动画参数 | -1 | 1 | 0 | 否 |
| `Param42` | R手腕 Z | 动画参数 | -1 | 1 | 0 | 否 |
| `Param43` | R 食指 | 动画参数 | -1 | 1 | 0 | 否 |
| `Param62` | L 大臂z | 动画参数 | -1 | 1 | 0 | 否 |
| `Param59` | 大臂透视 | 动画参数 | -1 | 1 | 0 | 否 |
| `Param60` | L小臂 Z | 动画参数 | -1 | 1 | 0 | 否 |
| `Param61` | L手腕 Z | 动画参数 | -1 | 1 | 0 | 否 |
| `GemReflection` | 宝石反光 | 闪光 | -1 | 1 | 0 | 是 |
| `GemHighlightx` | 宝石高光 x | 闪光 | -1 | 1 | 0 | 是 |
| `GemHighlighty` | 宝石高光 y | 闪光 | -1 | 1 | 0 | 是 |
| `KiraA` | 闪光 A | 闪光 | -1 | 1 | 0 | 是 |
| `KiraB` | 闪光 B | 闪光 | -1 | 1 | 0 | 是 |
| `KiraC` | 闪光 C | 闪光 | -1 | 1 | 0 | 是 |
| `KiraD` | 闪光 D | 闪光 | -1 | 1 | 0 | 是 |
| `ParamBreath` | 呼吸 |  | 0 | 1 | 0 | 否 |

## 口型禁区 / 引擎组

来源：model3 `Groups` + `packages/dsh-l2d-plugin/lib/param-guards.mjs`。

| 组 | 参数 | 说明 |
|---|---|---|
| EyeBlink | `ParamEyeROpen`, `ParamEyeLOpen` | 眨眼组，引擎可接管 |
| LipSync | `ParamMouthOpenY` | 口型红线，行为/节点不得写 |

代码口型禁区 `LIPSYNC_PARAMS`：
- `ParamMouthOpenY`
- `ParamMouthOpen`（**未在 moc3/cdi3 中找到**；仍作保留名拦截）
- `ParamMouthForm`

## 节点图引用方式

来源：`packages/dsh-l2d-plugin/lib/nodegraph.mjs`、`docs/nodegraph/SPEC.md`。

- 节点类型：`expression` / `motion` / `pose` / `look` / `delay`（及文档中的动作链 step kind）。
- `expression.name`、`motion` 组名必须是本目录 ID。
- 参数直写（`l2d_set_parameters` / keyframes / posture）的键必须是本目录参数 Id，且值 ∈ [min, max]。
- 形态用 `l2d_set_form` 的 index，不要把 `Clothes2` 当「形态枚举名」写进节点显示字段。

## 校验规则建议

来源于当前代码现状，供 `ai-edit` / `apply-ops` / MCP 共用：

1. **参数 Id** 必须存在于本目录；值必须在 `min..max` 内（闭区间）。
2. **口型禁区**（`ParamMouthOpenY` / `ParamMouthOpen` / `ParamMouthForm`）任何通道拒绝写入；四子阶段模板（thinking/working/attention/idle 等 choreography）不得出现这些 Id。
3. **物理输出**参数直写必须带 `own:true`，否则 reason `physics-unowned`（以 host-guard 为准）。
4. **动作组**必须存在于本目录；成对动作遵守 motion-director 冲突/幂等（already-open / conflict）。
5. **表情名**必须存在于本目录。
6. **形态**只用 `l2d_set_form`，`index` 为整数 0..2；非法 → `invalid-form-index`。不可用的渲染器 → `form-unavailable`。
7. **reason 代码保持英文**（如 `invalid-form-index`、`form-unavailable`、`reserved-param`）；前端按语言表翻译提示文案。
8. 节点图 JSON **只存 ID**，不存显示名；三种语言导出应逐字节一致。
9. 已知：部分 exp3（`裙子切换`/`尾巴开关`）把 `Clothes1`/`Clothes5` 写成 `-1`，**超出 moc3 量程 0..1**；校验仍以 moc3 为准，播放表情由运行时钳制。

## 未找到 / 推断说明

- 参数量程全部来自 Cubism Core 读取 `大肥鱼.moc3`，不是命名推断。
- cdi3 只有 Id/GroupId/Name，**不含** min/max/default。
- pose3：未在模型目录中找到。
- HitAreas：model3 声明为 []。
- moc3 与 cdi3 参数 Id 集合一致（0 差异）。
- exp3 `裙长切换` 写 Clothes1=-1（moc3 量程 0..1）；exp3 `尾巴开关` 写 Clothes5=-1（moc3 量程 0..1）；超出 moc3 量程，目录仍以 moc3 为准（播放由运行时钳制）。
- `ParamMouthOpen` 在 LIPSYNC_PARAMS 中但未出现在本模型 moc3/cdi3（保留名拦截）。
- 成对动作槽 poseParams 来自 motion-director.ts，不是 moc3 字段（仅当动作组存在时列出）。
- forms 来自宿主 overlay 的 BODY_TYPES（大肥鱼专用）；本模型没有该表时 forms 为空。
- HOST_ALLOWED_TOOLS 与 overlay case 列表是宿主代码事实，与模型无关。

