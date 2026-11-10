# 部位参数分区表 · 大肥鱼.dsl2d.2048

给「头发 / 神态 / 手部 / 腰部躯干 / 腿部」五个独立模块做联动不冲突的依据。节点编辑器和 LLM 都走 bridge 按模块下指令，冲突按本表判断。

机器可读副本：`docs/nodegraph/models/大肥鱼.dsl2d.2048/body-regions.json`。校验：`node tools/live2d-catalog/check-body-regions.mjs`。

本表根据参数 id、cdi3 中文名、入库 motion3 / exp3 实际写入的参数、physics3 的输入输出，以及 `motionsShareArm` 成对规则写成。判定不了的参数放在 unassigned，并写明原因。没有做新的渲染探针，不把未经证实的视觉效果写成事实。

模型文件是授权素材，仅供本地测试，未复制、未提交。

## 纪律（先读）

- **每个参数必须且只能出现在一个位置**：某个 region、shared、unassigned、expressionLayer，或 accessories。
- **表情是单独一层，不占神态模块。** `key1`–`key13` 只归表情层。神态模块只管脸、眼、嘴和头转向，不管表情开关。
- **物理输出只读，bridge 不可写。** 292 个物理输出由对应物理组每帧写入。bridge / 节点 / LLM 只写该组的**输入**，让物理去驱动输出。历史上若要以 `own` 强写输出，不在本表允许范围内。
- **口型红线**：`ParamMouthOpenY` 归神态，但行为、节点、bridge 都不得写（目录 `engineGroups.LipSync`）。`ParamMouthOpen` 在 LIPSYNC 名单里，但本模型 moc3 中不存在。
- 分隔符（`Divider*`、`Paramshuiyin*`）一律 unassigned，不参与模块控制。
- **饰品按槽位分类。** 同一 `exclusive` 槽只能戴一件，不同槽可以一起戴。切换走 expression 层或 accessories 层，组内互斥由 bridge 按槽位判断。开关键仍可留在表情层，衣物/鞋的 `Clothes1/3/4` 仍留在躯干或腿部。
- 未入库资产（`脱捕.motion3.json`、`竖食指开.exp3.json`、`竖食指关.exp3.json`）不当作可用能力，本表不把它们算进 7 个动作 / 21 个表情。

## 分区规则

| 模块 | JSON 键 | 判定依据 | 典型内容 |
|---|---|---|---|
| 头发 | `hair` | cdi3 分组「前发/侧发/后发物理」；中文名「炸毛」「炸毛移动」 | 发丝物理输出，以及 3 个非物理的发丝参数、炸毛开关 |
| 神态 | `face` | cdi3 分组「眼睛/嘴/VB/五官物理/眼睛动画」；头转向控制器 `AngleX/Y/Z` 及其物理拷贝；待机动画里有中文名或 Idle 曲线证据的脸部部件（呆滞、汗、泪、怒、爱心、蚊香眼等） | 眼、眉、嘴、头转向、口型、脸部特效。**不含** `key1`–`key13` |
| 手部 | `hands` | cdi3 分组「手臂」；`Movement1/2/3`；motion-director 的姿态骨；狗尾草道具（动作组写入、物理组「狗尾巴物理」以 `Param42` 为输入） | 左右臂姿态骨、袖/带、手部开关、狗尾草放大与草物理 |
| 腰部躯干 | `torso` | 身体根控制器 `PositionX/Y/Z`、`LeanInput`、`ParamBreath`；身体轴里的胸腔/盆骨/肩；cdi3 分组「胸/裙子/上衣」；`Clothes1`（裙长）、`Clothes3`（胸口衣服） | 呼吸、前倾、体位移、胸腔与盆骨物理、裙子与上衣物理 |
| 腿部 | `legs` | 中文名「双腿 Z」「并腿」；`Clothes4`（鞋子，表情「脱鞋」写入） | 仅 3 个参数。能力画像已说明这是半身模型，没有膝、没有腿部内收语义通道 |
| 表情层 | `expressionLayer` | 入库 exp3 的开关键 | `key1`–`key13`。表情写入的其他模块参数仍留在原模块，由表情层记录写入方式 |
| 共享 | `shared` | 多个模块都会用到、需要统一仲裁的参数 | 形态 `Clothes2` 及其大小变位置 / 透明 |
| 饰品 | `accessories` | 入库表情写入的开关、cdi3 分组和中文名；两件饰品写同一参数或视觉上占同一位置则进同一互斥槽 | 眼镜、头饰/钢盆、兽耳、尾巴、鞋、裙长、胸口衣服、翅膀、飘花、逸散光点等。不能确定开关或归属的进 `uncertain` |
| 未分区 | `unassigned` | 仍无法判定，或只是分隔符 | 分隔符、含混动画开关、Idle 与手部动作都在写的光效 `Param55`–`58` |

跨模块**读取**（例如头发物理读取 `AngleX`）不构成共享写入，参数仍归写入方。只有多方都可能合法写入时才进 shared。

## 各区数量

目录共 509 个参数，其中物理输出 292 个。分配之和为 509，无遗漏、无重复。

| 位置 | 参数 | 其中物理输出（只读） | 可写 | 占用的入库动作 | 写入本区参数的表情 |
|---|---:|---:|---:|---|---|
| 头发 hair | 58 | 53 | 5 | （无） | （无） |
| 神态 face | 139 | 59 | 80 | Idle | （无，表情不占本区） |
| 手部 hands | 62 | 38 | 24 | 抚胸手打开/关闭、竖手指打开/关闭、狗尾巴草打开/关闭 | （无） |
| 腰部躯干 torso | 82 | 68 | 14 | （无） | 裙长切换、前倾、胸口衣服 |
| 腿部 legs | 3 | 2 | 1 | （无） | 脱鞋 |
| 表情层 | 13 | 0 | 13 | — | 见下文「表情层」 |
| 共享 shared | 3 | 1 | 2 | — | 体型1、体型2、默认体型（写 `Clothes2`） |
| 饰品 accessories | 109 | 71 | 38 | （无） | 钢盆、单片/黑框眼镜（开关键在表情层）；尾巴开关（`Clothes5` 已改归本层）；裙长/胸口衣服/脱鞋的参数仍在躯干或腿部 |
| 未分区 unassigned | 40 | 0 | 40 | Idle 还写入其中的 `Param55/56/57/58` 与 `Divider22`；6 个手部动作还写入 `Param56/57` | （无） |
| **合计** | **509** | **292** | **217** | | |

头发可写参数只有 `FrontHairZ`、`LateSideHairXBS`、`LateSideHairYbs`、`Param137`（炸毛）、`Param139`（炸毛移动）。其余 53 个都是物理输出，bridge 不要写。

腿部可写参数只有 `Clothes4`（鞋子）。`LEGAngleZ2`、`Param33` 是物理输出，输入来自躯干的盆骨，不由腿部模块直写。

## 共享参数及仲裁

| 参数 | 中文名 | 所属/影响 | 仲裁者 | 叠加还是覆盖 | 说明 |
|---|---|---|---|---|---|
| `Clothes2` | 2. 大小变 | hair、torso、legs、hands、face（形态会影响全身，并作为多条头发/帽子/尾巴物理的输入） | `form`（`l2d_set_form` / `l2d_change_form`） | **覆盖** | 三个「体型」表情也用 Add 写它。形态指令优先于表情层；三个体型表情必须互斥，不要同时生效 |
| `Param` | 大小变位置 | hair、torso、legs | `form` | **覆盖** | 与 `Clothes2` 成对，未见动作/表情曲线写入，跟随形态一起覆盖 |
| `Param34` | 大小变透明参数 | hair、torso、legs | `physics` | 由物理写，**只读** | 物理组「大小变透明参数」的输出，输入只有 `Clothes2`。bridge 不可写 |

其他跨层冲突（参数本身仍归单一模块，不算 shared）：

- `LeanInput` 归躯干，但表情「前倾」对它做 Add -30。躯干模块优先，把「前倾」当作躯干指令，不要与 LeanInput 直写叠加。
- `Param56` / `Param57`（以及 Idle 还写的 `Param55` / `Param58`）未分区，见「主要冲突点」。

## 物理输出与物理组输入

物理输出一律只读，bridge 不可写。要驱动某个部位的摆动，去写该物理组的输入（输入所属模块见下表）。131 组的逐条输入、权重、输出列表在 JSON 的 `physicsGroups`，此处按输出所在区汇总。

### 头发物理（13 组，53 个输出）

输入**不在头发模块**：主要来自神态的头角度，以及躯干的呼吸、前倾和形态。

| 物理组 | 输出概要 | 输入来自 |
|---|---|---|
| 前发X、侧发X、后发X、后发 Z、短后发X | 各段发丝 X/Z | **神态**（`ParamAngleX/Z` 或 `AngleX/Z`） |
| 前发Y、侧发Y、后发Y | 各段发丝 Y | **神态** `ParamAngleY` / `AngleY`，**躯干** `LeanInput`、`ParamBreath`，**共享** `Clothes2` |
| 短后发Y | 短马尾 Y | **神态** `AngleY`，**躯干** `Clothes1`、`ParamBreath`（裙长会进短马尾 Y，只是读取，不把 `Clothes1` 改判给头发） |
| 侧发R、后侧发R、后侧发L | 侧/后侧发 | **神态** `AngleX/Y/Z`，**躯干** `ParamBreath` |
| 侧发L | 左侧发 | **躯干** `ParamBodyAngleRX`、`ParamBreath` |

因此：转头（写神态的 `AngleX/Y/Z`）、呼吸和前倾（写躯干）、改形态（写 `Clothes2`）都会带动头发。不要去写 `FrontHairX1` 这类输出。

### 神态物理（42 组，59 个输出）

输入几乎都在神态内部（眼开合、眉、嘴、头角度）。例外：物理组「情绪联动」除了双眉，还把分隔符 `Paramshuiyin7` 列为输入——这很可疑，bridge 不要去写这个分隔符。

`ShockR` / `ShockL` 是物理组「Shock R/L」的输出，但这两条输出的 Weight=0（见 `docs/M1-G-PHYSICS-RIG-AUDIT.md`），物理等于没写。Idle 曲线仍在写它们，这是 Idle 能改到这两个参数的原因，不代表 bridge 可以写其他物理输出。

### 腰部躯干物理（32 组，68 个输出）

输入全部来自躯干：`PositionX/Y/Z`、`LeanInput`、`ParamBreath`，以及已经由上游物理写出的胸腔/盆骨角（组间级联）。裙子 Y 还读取 `Clothes1`。要摆躯干，写这些输入，不要写 `ParamBodyAngleX`、`HipAngleZ`、`SkirtX1` 等输出。

### 手部物理（14 组，38 个输出）

绝大多数手臂/袖/带/手物理的输入来自**躯干**（胸腔角、呼吸、位置）。真正属于手部模块的输入只有：

- 「手臂开关物理」← `Movement1/2/3`（手部）→ 输出 `Param35`
- 「狗尾巴物理」← `Param42`（手部，R 手腕 Z）+ 躯干胸腔角 → 输出 `Param45`–`Param49`

也就是说，默认的手臂摆动是跟着身体走的；预制手势不要去抢 `LArm` / `RArm` 这些物理输出，应写姿态骨 `Param36` 等（它们不是物理输出）。狗尾草道具的摆动跟右腕。

### 腿部物理（2 组，2 个输出）

| 物理组 | 输出 | 输入来自 |
|---|---|---|
| 双腿 Z | `LEGAngleZ2` | **躯干** `HipAngleX`、`PositionZ` |
| 并腿 | `Param33` | **躯干** `HipAngleX` |

腿部没有自己的可写姿态骨。要影响双腿，只能写躯干盆骨相关输入，或写 `Clothes4` 切换鞋子。

### 共享（1 组，1 个输出）

「大小变透明参数」：输入 `Clothes2`，输出 `Param34`。只读。

### 饰品层输出（27 组，71 个输出）

兽耳、尾巴、头配饰、帽子、耳环、头缎带、闪光、宝石。输入主要来自神态头角度和躯干呼吸/胸腔/前倾，尾巴还读 `Clothes2`。这些输出已改归 `accessories`，同样只读，不要经 bridge 强写。没有显隐开关的头配饰/宝石物理见「饰品槽位」里的 uncertain。

## 七组动作各占哪些区

曲线来自入库 motion3（不是文件名，播放用组名）。

| 动作组 | 主要所占区 | 写入的本区参数 | 另外写入（未分区） |
|---|---|---|---|
| 抚胸手打开 / 抚胸手关闭 | **手部**（左臂） | `Movement2`，`Param62/59/60/61` | `Param56`、`Param57` |
| 竖手指打开 / 竖手指关闭 | **手部**（右臂） | `Movement1`（仅打开）、`Movement3`，`Param40/36/39/41/42/43` | `Param56`、`Param57` |
| 狗尾巴草打开 / 狗尾巴草关闭 | **手部**（右臂 + 狗尾草） | `Movement1`，`Movement3`（仅打开），`Param36/39/41/42/43` | `Param56`、`Param57` |
| Idle | **神态** | `ShockR/L`、`Param11`、冒汗、泪、高光闪、`Startwinkle` 等 | `Param55/56/57/58`，以及分隔符 `Divider22` |

没有动作写入头发、躯干或腿部的分区参数。

### 动作之间的手臂冲突（`motionsShareArm`）

依据 `packages/renderer/src/app/motion-director.ts`。只比较姿态骨，**不把** `Param56/57` 这类共用光效算进冲突。

- **竖手指** 与 **狗尾巴草** 共用右臂姿态骨 `Param36`、`Param39`、`Param41`、`Param42`、`Param43`（竖手指另外还有 `Param40`）。不可同时打开。要预览或让 LLM 切到另一个，先走对应的关闭动作做手臂收尾，不要清空全身（以免把表情和体型一起冲掉）。
- **抚胸手** 用左臂 `Param59/60/61/62`，与右臂不相交，可以和竖手指或狗尾巴草同时开。
- 成对动作是状态切换：已经打开时再播打开应幂等忽略；要先关再开另一个共用手臂的动作。

## 表情层（单独一层，不占神态）

21 个入库 exp3 **全部显式声明 `Blend: Add`**，没有 Multiply，也没有 Overwrite。目录 JSON 原先没收录 Blend 字段，以本地授权模型的 exp3 为准。

Cubism 表达式（本仓库 `cubismexpressionmotion.ts`）：

- **Add**：`当前值 + value × 淡入权重`
- **Multiply**：按倍率乘
- **Overwrite**：把当前值插值到目标值

因为全是 Add，下面「值为 0」的项在单独生效时几乎没有贡献，不能靠它清掉另一个表情已经加上的值。

| 表情 | 写入 | 方式 | 落到哪个模块 |
|---|---|---|---|
| 兔牙 | `key9`=1 | Add | 表情层 |
| 加载 | `key8`=1 | Add | 表情层 |
| 单片眼镜 | `key12`=1 | Add | 表情层（亦入饰品槽「眼镜」，与黑框眼镜互斥） |
| 圈圈眼 | `key3`=1，`key4`=0，`key5`=0，`key6`=0 | Add | 表情层 |
| 屑 | `key3`=0，`key5`=0，`key6`=1（**不写 key4**） | Add | 表情层 |
| 流泪 | `key2`=1 | Add | 表情层 |
| 爱心眼 | `key4`=1（**不把 key3/5/6 归零**） | Add | 表情层 |
| 脸红 | `key7`=1 | Add | 表情层 |
| 钢盆 | `key10`=1 | Add | 表情层（亦入饰品槽「头饰」） |
| 黑框眼镜 | `key11`=1 | Add | 表情层（亦入饰品槽「眼镜」，与单片眼镜互斥） |
| 黑脸 | `key1`=1 | Add | 表情层 |
| ＞＜ | `key3`=0，`key4`=0，`key5`=1，`key6`=0 | Add | 表情层 |
| 流冷汗 | `key13`=1 | Add | 表情层 |
| 脱鞋 | `Clothes4`=1 | Add | **腿部**（亦入饰品槽「鞋」） |
| 裙长切换 | `Clothes1`=-1（超出 moc3 的 0..1） | Add | **躯干**（亦入饰品槽「裙长」，与胸口衣服分槽、可同时穿） |
| 胸口衣服 | `Clothes3`=1 | Add | **躯干**（亦入饰品槽「胸口衣服」） |
| 体型1 | `Clothes2`=0.4 | Add | **共享**（形态） |
| 体型2 | `Clothes2`=1 | Add | **共享**（形态） |
| 默认体型 | `Clothes2`=0 | Add | **共享**（形态） |
| 前倾 | `LeanInput`=-30 | Add | **躯干** |
| 尾巴开关 | `Clothes5`=-1（超出 moc3 的 0..1） | Add | **饰品层**（槽「尾巴」，`Clothes5` 已从 unassigned 改归） |

### 哪些表情会因写同一参数而冲突

1. **圈圈眼、屑、爱心眼、＞＜** 共用 `key3`–`key6`。屑不写 `key4`，爱心眼只加 `key4=1`。若运行时允许多个表情叠加，会同时点亮多种眼型；即使单表情切换，Add 在旧表情淡出未完成时也会短暂叠值。这四者必须互斥，切换时先淡出旧的。
2. **体型1、体型2、默认体型** 都写 `Clothes2`。默认体型 Add 0 本身没有贡献，要靠旧表情淡出才能回到默认。与 `l2d_set_form` 同时用会叠偏。形态指令优先，三个体型表情互斥。
3. **前倾** 写躯干的 `LeanInput`（Add -30）。若当前 LeanInput 已经不是 0，会叠出范围或叠偏。不要和躯干模块的 LeanInput 直写同时生效。
4. 其余开关类表情（兔牙、脸红、眼镜、黑脸等）写不同的 `key*`，彼此不抢同一参数，可以和互斥眼型之外的表情按产品需要叠加。
5. 「裙长切换」「尾巴开关」把 -1 以 Add 打在默认值为 1 的衣服参数上，在默认态结果是 0；若当前值已经不是 1，结果会越界。这两条不要当成可反复叠加的开关。

## Cubism 中的叠加方式

依据本仓库 `packages/renderer/src/app/lappmodel.ts` 的 `update()`，以及 `icubismupdater.ts` 的 `CubismUpdateOrder`。建议 bridge 按这个顺序理解，不要另搞一套。

帧内实际顺序：

1. **`loadParameters`**：载入上一帧在动作之后保存的值。
2. **动作（Motion）**：`_motionManager.updateMotion`。按动作淡入/淡出权重覆盖（或按动作自身曲线插值）所写参数。管理器按优先级抢占；Idle 优先级最低。同一只手臂的成对动作不要并行，见 `motionsShareArm`。
3. **`saveParameters`**：把「动作后」的状态存下来，供下一帧 load。
4. **`preLateUpdateHook`（建议：bridge 写物理输入、神态控制器、形态）**：必须在 save 之后、调度器之前。这样不会被下一帧的 loadParameters 抹掉，且当帧物理就能读到 `Angle*` / `Position*` / `LeanInput` / `Clothes2` 等输入。
5. **调度器 `onLateUpdate`**，按 execution order：
   - 200 眨眼（可接管 `ParamEyeLOpen` / `ParamEyeROpen`）
   - 300 **表情**（Add / Multiply / Overwrite，本模型全是 Add，带淡入淡出权重）
   - 400 视线拖拽（Look / Drag）
   - 500 呼吸（若启用引擎呼吸，会动 `ParamBreath`）
   - 600 **物理**（覆盖 292 个输出；bridge 禁止写这些输出）
   - 700 **口型**（`ParamMouthOpenY`，红线，后于物理）
   - 800 Pose（本模型没有 pose3）
6. **`postLateUpdateHook`**：给必须在表情/物理之后才站得住的「覆盖型」姿态使用。本表不建议用它去写物理输出。手部姿态骨本身不是物理输出，若不用预制动作、而由 bridge 直写，可以考虑这一相位，以免被表情或其它后处理改回去。
7. **`model.update()`**：应用到网格。

### 三类写入的优先级建议

| 优先级（高 → 低） | 写入者 | 适用参数 | 备注 |
|---|---|---|---|
| 最高，且不可争 | 物理 | 292 个物理输出 | bridge 不可写；只改输入 |
| 最高，且不可争 | 口型引擎 | `ParamMouthOpenY` | 红线，谁都不要写 |
| 高 | 形态指令 | `Clothes2`（及跟随的 `Param`） | 覆盖；优先于「体型*」表情 |
| 高 | 成对动作的姿态骨 | 左右臂 `Param36` 等、`Param59` 等 | 同一只手互斥，先收尾再切换；左右手可叠加 |
| 中 | 表情层 Add / 饰品槽 | `key*`、衣服/鞋/尾巴开关，以及飘花等参数开关 | 饰品按槽位互斥，见「饰品槽位」；不要用 Add 去「清零」 |
| 中 | bridge / 节点直写输入 | 各模块的可写非物理参数 | 物理输入走 pre 钩子；不要写输出 |
| 低 | Idle | 神态待机曲线 + 共用光效 | 让位于手部动作和表情 |

共享参数冲突时：

- `Clothes2`：形态指令覆盖，表情让位。
- `LeanInput`：躯干模块（bridge / 节点）覆盖，表情「前倾」让位或改走躯干指令。
- 竖手指 vs 狗尾巴草：先关后开，不并行。
- 手部动作 vs Idle：动作优先；`Param56/57` 在动作播放期间由动作说了算。
- 神态可写参数（眼、眉、嘴）上，动作（仅 Idle 会碰到其中一部分）先写，表情再 Add；bridge 若要在当帧生效且让物理看到，走 pre 钩子，但不要写口型和物理输出。
- 不要为了「预览干净」就整模型清零：那会把表情、形态、另一只手的姿态一起冲掉。只重置冲突的那一只手臂。

## 饰品槽位

给右键菜单「物品 → 饰品」和设置页按分类展示用。完整机器可读数据在 JSON 的 `accessories`。

规则：

- **同一 slot 且 `exclusive: true`：同时只能戴一件**（例如两副眼镜）。切换时由 **bridge 按槽位判冲突**，先卸下槽内已戴的那件，再戴新的。不要靠「再 Add 一次」去关。
- **不同 slot 可以一起戴**（眼镜 + 钢盆 + 尾巴 + 裙长 + 飘花，可以同时开）。
- `exclusive: false` 的槽（飘花、逸散光点、翅膀）表示组内各项按现有证据可以同时开；若以后探针证明会互相挡住，再改成互斥。
- **切换走 expression 层或 accessories 层**：有入库表情的饰品（眼镜、钢盆、尾巴、脱鞋、裙长、胸口衣服）走表情层（本模型全是 Add），bridge 负责槽内互斥；只有参数开关、没有表情的（飘花显隐、光点、话筒光、钱）走 accessories 层，直写对应参数的 on/off。
- 表情开关键 `key*` 仍留在表情层；`Clothes1` / `Clothes3` 仍归躯干，`Clothes4` 仍归腿部。只有原先在 unassigned、现在能定归属的参数才改归 accessories（本表共 109 个，其中物理输出 71 个，只读）。

| 槽位 id | 名字 | 互斥 | 件数 | 可切换项 | 从 unassigned 改归的参数 | 和别的槽一起戴 |
|---|---|---|---:|---|---|---|
| `glasses` | 眼镜 | 是 | 2 | 单片眼镜（表情→`key12`），黑框眼镜（表情→`key11`） | 无（开关键在表情层） | 可以 |
| `headwear` | 头饰 | 是 | 1 | 钢盆（表情→`key10`） | 无（开关键在表情层） | 可以 |
| `ears` | 兽耳 | 是 | 0 | 无。全是物理输出，没有显隐开关，菜单可展示分类但不能切换 | 12（`LEar*`/`REar*`/`LControl`/`RControl`/Flip 系列，只读） | — |
| `tail` | 尾巴 | 是 | 1 | 尾巴。on=`Clothes5=1`（默认可见），off=应用表情「尾巴开关」（Add -1） | 8（`Clothes5` 及尾巴物理 `Param52`、`Param_Angle_Rotation84`–`89`） | 可以 |
| `shoes` | 鞋 | 是 | 1 | 脱鞋（表情→`Clothes4`，参数仍归腿部） | 无 | 可以 |
| `skirt` | 裙长 | 是 | 1 | 裙长切换（表情→`Clothes1`，参数仍归躯干）。不能从数值判断哪端是长裙还是短裙 | 无 | 可以（与胸口衣服分槽，正是为了能一起穿） |
| `chest-clothes` | 胸口衣服 | 是 | 1 | 胸口衣服（表情→`Clothes3`，参数仍归躯干） | 无 | 可以 |
| `wings` | 翅膀 | 否 | 0 | 无。两组开合/舒展/旋转/羽毛参数量程多为 -1..1，不能当成 0/1 开关；两组是左右一对还是两套翅膀未经确认 | 10 | — |
| `flowers` | 飘花 | 否 | 3 | 小花1/2/3（参数 `LittleFlower2/4/6` 显隐，on=1 / off=0，按量程推断） | 11 | 可以；组内三朵默认也可同时开 |
| `glints` | 逸散光点 | 否 | 4 | 光点1–4（参数 `Colorflicker5/6/7/8`，同样按量程推断） | 8 | 可以；组内默认也可同时开 |
| `mic-glow` | 话筒光 | 是 | 1 | 话筒光（参数 `MicroGlows`，按量程推断） | 1 | 可以 |
| `money` | 钱币特效 | 是 | 1 | 钱（参数 `Param136`，按量程推断） | 1 | 可以 |

bridge 建议：

- 设置页和右键菜单按上表的槽位分组，不要把可同时穿戴的饰品放进同一个互斥列表。
- 戴上某件 exclusive 槽里的饰品前，先卸下该槽当前项（表情则淡出旧表情；参数则写 off）。不要清空其它槽，也不要全身重置。
- 「裙长切换」「尾巴开关」的 on 值超出 moc3 的 0..1，只切换一次，不要反复 Add。
- 兽耳、翅膀没有可切换项：不要编造开关。物理输出只读。
- 体型（`Clothes2`）不是饰品，走形态指令，不要放进饰品菜单。

### 不能确定的饰品相关参数（uncertain，5 组，58 个参数）

这些参数已从 unassigned 改归 accessories，但不进入可切换菜单，以免编造开关或互斥关系。

| 组 | 参数数 | 原因 |
|---|---:|---|
| `head-accessories-physics` 头配饰物理（帽/发饰/耳环/头缎带/头部闪光） | 45 | 全是物理输出，没有开关；与钢盆是否同一件、彼此会不会占同一位置，都未经探针，故不并入头饰槽、也不拆成多件饰品 |
| `gem-kira-physics` 宝石反光与 Kira 闪光 | 7 | 全是物理输出，没有开关；与 Shine*、`Param141/142` 是否同一套特效未经确认 |
| `shine-anim-keys` `Param141` / `Param142` | 2 | 中文名「闪光 1/2」，但不能当成上述物理件的总开关 |
| `flower-anime-keys` `F1/F2/F3Anikey` | 3 | 名称是花动画开关，但 cdi3 分隔在「逸散的光点」段，飘花段才是 LittleFlower*，不能确定进哪一个槽 |
| `loading-part` `Param140` | 1 | 中文名「加载」，但表情「加载」写的是 `key8`。更像状态动画，不能确定是可并排穿戴的饰品 |

## 未能判定的参数（40）

完整 id、中文名和理由见 JSON `unassigned`。饰品相关参数已改归 `accessories`（含 uncertain），这里只剩仍无法判定的项。本批已无物理输出。

### 分隔符（27）

`Paramshuiyin7`，`Paramshuiyin8`，`Divider1`，`Divider3`，`Divider4`，`Divider5`，`Divider6`，`Divider7`，`Divider8`，`Divider9`，`Divider10`，`Divider11`，`Divider12`，`Divider13`，`Divider14`，`Divider15`，`Divider16`，`Divider18`，`Divider19`，`Divider20`，`Divider22`，`Divider23`，`Divider24`，`Divider25`，`Divider28`，`Divider31`，`Divider33`。

说明：`Paramshuiyin7` 被物理组「情绪联动」列为输入，仍然按分隔符处理，bridge 不要写。Idle 曲线写入了 `Divider22`，原因不明，也不把它升格成神态参数。

### 仍无法判定的开关与参考值（13）

- `Param2`（辅助参数）、`Param37`（动画开关）、`Ani1`、`Ani2`、`SWITCHA`、`IDLE`：名称过泛，未见入库动作/表情写入。
- `AngleXbs2`、`AngleXbs3`、`AngleYbs2`：未见写入，也不是物理输入或输出，疑似烘焙参考。
- `Param55`、`Param56`、`Param57`、`Param58`（光 1–4）：cdi3 分在「尾巴」组，但 Idle 与手部动作都会写入（见「主要冲突点」第 2 条），不能算作尾巴饰品，也不进 accessories。

## 主要冲突点

1. **竖手指 与 狗尾巴草抢右臂**（已有代码仲裁）。预览或 LLM 联动时，只用 `motionsShareArm` 判断，先关闭再打开；抚胸手可与它们并存。不要全身重置。
2. **Idle 与全部 6 个手部动作都写 `Param56`/`Param57`**（Idle 还写 `Param55`/`Param58`）。这些参数 cdi3 分在「尾巴」组、中文名是「光 1–4」，motion-director 已把它们排除在手臂冲突之外。未经探针无法判定视觉归属，故放 unassigned。建议：手部动作播放期间由动作覆盖，Idle 只在没有手部动作时写。
3. **眼型表情互斥**（圈圈眼 / 屑 / 爱心眼 / ＞＜），全是 Add，且爱心眼、屑没有把其它键写全。见表情层冲突第 1 条。
4. **形态 vs 体型表情 vs 物理**：`Clothes2` 是共享参数，形态指令覆盖；`Param34` 只读。三个体型表情互斥。
5. **「前倾」表情 vs 躯干 LeanInput**：同一参数，Add -30 不能和直写叠加。
6. **表情写衣服越界**：`裙长切换` 写 `Clothes1=-1`，`尾巴开关` 写 `Clothes5=-1`，都超出 moc3 的 0..1。不要反复 Add。
7. **手部预制动作 vs 手臂物理输出是两套参数**。竖手指 / 狗尾草 / 抚胸写的是姿态骨（非物理输出）；`LArm` / `RArm` 等是躯干驱动的物理输出。不要用直写物理输出去「补」手势。狗尾草的草物理读取 `Param42`，所以右臂姿态会带动道具，这是预期中的跨组读取，不是参数归属冲突。
8. **半身模型几乎没有腿部可写语义**。并腿、双腿 Z 都是躯干盆骨的物理输出；行为模板里的腿部内收 / 屈膝必须降级，不要硬凑。
9. **饰品槽内互斥**：单片眼镜与黑框眼镜占同一位置，必须互斥；裙长与胸口衣服已分槽，可以一起穿。切换由 bridge 按槽位判断，见「饰品槽位」。

## 资料来源

- `docs/nodegraph/live2d-ids.json`、`live2d-catalog.json`、`LIVE2D-CATALOG.md`
- `docs/LABEL-AUDIT-CLASSIFIED.md`
- `docs/Capability-Profile-大肥鱼.dsl2d.2048.md`
- `docs/M1-G-PHYSICS-RIG-AUDIT.md`（Shock 输出 Weight=0 等）
- `tools/w3-registry/registry.json`
- `packages/renderer/src/app/motion-director.ts`（`motionsShareArm`）
- `packages/renderer/src/app/lappmodel.ts`、`packages/renderer/src/fw/motion/icubismupdater.ts`、`cubismexpressionmotion.ts`
- 本地授权模型的 `physics3` / `exp3` / `motion3`（只读，未入库）
