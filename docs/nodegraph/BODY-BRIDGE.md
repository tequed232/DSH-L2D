# 部位联动 bridge（body bridge）

让 LLM / 节点图 / 旧接口按**身体部位**下发联动，不同部位互不干扰；同一部位谁说了算由优先级仲裁。
规则和数据各只有一份：

| 内容 | 位置 |
| --- | --- |
| 规则核心（纯函数，宿主与 overlay 共用） | `packages/dsh-l2d-plugin/lib/body-bridge.mjs` |
| 自动衔接点（兜底，运行时现算） | `packages/dsh-l2d-plugin/lib/motion-cuts.mjs` |
| 宿主静态校验与转发 | `packages/dsh-l2d-plugin/lib/body-bridge-api.mjs`、`index.js` 的 `/dsh-l2d/api/bridge/*` |
| 占用权威（运行时） | `overlay.js`（`bodyBridge*`），写入只在 preLateUpdateHook |
| MCP 工具 | `packages/dsh-l2d-mcp/src/server.mjs`、`regions-tools.mjs` |
| 分区表 | `docs/nodegraph/models/<模型>/body-regions.json`（见 `BODY-REGIONS.md`） |
| 神态部件表 | 同目录 `face-units.json`，没有则 `face-vocab.json`（大肥鱼当前是 `face-vocab.json`） |
| 动作衔接点 | 同目录 `motion-cutpoints.json` |

## 1. 模块与层

- 五个模块：`hair` 头发、`face` 神态、`hands` 手部、`torso` 腰部躯干、`legs` 腿部。每个模块有自己的动作组和可写参数（来自分区表）。
- `expression` 表情层：眼型表情（圈圈眼 / 屑 / 爱心眼 / ＞＜）互斥；三个体型表情互斥且形态层优先。
- `accessory` 饰品层：全部可同时佩戴，各自独立开关，没有同槽替换。鞋走 legs（Clothes4），裙长、胸口衣服走 torso（Clothes1 / Clothes3）；眼镜、钢盆、尾巴走表情层但直接写各自的开关参数（key12 / key11 / key10 / Clothes5），彼此不互斥；飘花、光点、话筒光、钱直接写参数。兽耳、翅膀、未确认项和体型类不开放。
- `form` 形态层：0 默认 / 1 体型1 / 2 体型2。
- 头部转动 `AngleX/Y/Z`（含低头 AngleY）属于 face；前倾 `LeanInput` 属于 torso。
- 红线：物理输出只读；口型参数（ParamMouthOpenY，以及进了 lipSync 名单的 **ParamMouthForm**）不可写。

## 2. 指令形状

```jsonc
POST /dsh-l2d/api/bridge/act
{
  "source": "llm",               // llm | user | graph | system ...
  "priority": "NORMAL",          // LOW(=BACKGROUND) < NORMAL < HIGH < FORCE
  "onBusy": "blend",             // reject | wait | blend（默认 blend）
  "cut": "next",                 // now | next | after（默认 next；没有 when 别名）
  "fadeMs": 300,                 // 200–400，默认 300
  "waitMs": 3000,                // wait 默认 3000；blend 默认 30000
  "awaitDone": false,
  "steps": [
    { "region": "hands", "motion": "竖手指打开" },
    { "region": "torso", "set": { "LeanInput": -20 }, "durationMs": 400 },
    { "region": "face", "compose": { "dimensions": { "慵懒": 0.6, "挑逗": 0.7 }, "holdMs": 4000 } },
    { "region": "face", "mood": "妩媚" },                 // 与上一行二选一（同模块一条指令只能一步）
    { "layer": "expression", "expression": "脸红", "on": true },
    { "layer": "accessory", "item": "monocle", "on": true },
    { "layer": "form", "form": 1 }
  ]
}
```

涉及的模块全部拿到才执行，否则整条拒绝，不会只做一半。旧表情「前倾」转成 torso 写 LeanInput，「脱鞋」转成 legs 写 Clothes4，「裙长切换 / 胸口衣服」转成 torso 写值。

成功回执：`{ok, commandId, accepted, preempted, cut:{mode, atMs, fadeMs, waitedMs}, gesture?, compose?, warnings}`；排队时 `{ok, queued, ticket, readyInMs, cut:{mode, regions}, superseded?}`。每个模块做完发一个 `action-done`（带 commandId、region 或 layer / item），awaitDone 时等齐再返回。

## 3. 帧相位与写入

Cubism 一帧：load → motion → save → **preLateUpdateHook** → 眨眼(200) / 表情(300) / 物理(600) / 口型(700) → post。

- bridge 的所有写入都在 preLateUpdateHook（`setPreUpdate`）里经 `setParametersRuntime`。叠加输入（AngleX/Y/Z、Position*、LeanInput、Movement*）在 pre 相位写入，物理当帧可见；其余参数按 injector 的 set 语义在 post 相位重放。
- 退出：对粘滞值写一次 weight 0（injector 里 weight 0 的 set 是 no-op），让渲染端恢复自己的值，不需要改 renderer。
- 眨眼：post 相位的写值会盖掉渲染端的 CubismEyeBlink，所以 compose 自带眨眼周期，乘在睁眼值上。

## 4. 神态组合（compose）

数据文件 `face-units.json` / `face-vocab.json`，加载函数 `pickFaceUnitsFile`：两个都有时用 face-units.json。字段：`params`、`neverWrite`、`actionUnits`、`expressionsAsAU`、`algorithm`、`recipes`、`dimensions.table`（13 个情绪维度）。

- 部件权重 = Σ 维度强度 × 该维度的部件权重；也可直接给 `units` 或 `recipes`（叠加）。
- 能量 = 维度强度加权平均（可用 `energy` 覆盖），决定摆动幅度；维度强度超过 `expressionAt` 的伴随表情（脸红等）自动经表情层打开（`autoExpressions:false` 关）。
- 参数值 = 中性值 + Σ 部件贡献，夹到范围内；对立部件相互抵消；有方向的部件统一用 `side`（`L` / `R`）；带轻微摆动；眨眼乘在睁眼值上。
- `enterMs` 默认 1000 渐入；`holdMs` 到时自动渐出（600ms），不给就保持到被释放 / 被抢。
- 参数归属按分区表：不在 face 的参数（如 LeanInput）要占对应模块；该模块被更高优先级占着时只跳过受影响部件，进 `blocked`。
- 回执 `compose.written:[{param, value, meaning, contributions:[{unit, amount}]}]`、`compose.blocked:[{param|unit, reason}]`。
- `GET /face/describe`：读当前参数，非负最小二乘反推各部件强度（两侧都试）。
- mood-presets.json 已删除，`mood` 步骤即按名字取 `recipes`。

## 5. 动作衔接（onBusy:'blend'）

数据文件 `motion-cutpoints.json`（秒）：每个动作 `durationSec / loop / fadeInSec / fadeOutSec / curves / switches / cutWindowsSec / switchAtSec / abortBeforeSec / chainFromSec / anytime`，以及 `handStates.states / edges`、`interruptRules`。segment 字段（windup / hold / recover）可选。没有标注的动作才用 `motion-cuts.mjs` 从许可模型目录现算的自动衔接点兜底（不落盘、不入库）。

判定（`blendDecision`，按模块）：

1. 低优先级不能 now / next 打断高优先级，一律按 after（等播完，超过 waitMs 判 region-busy）。
2. 神态 / set / 表情 / 饰品是持续写值，不排队，直接渐变到新目标；Idle 等 `anytime` 动作随时可切。
3. `cut:after`：等当前动作播完。`cut:now`：立刻切。
4. `cut:next`（默认）：
   - 在 abortBefore 之前：立即中止，手势不变；
   - abortBefore 与 chainFrom 之间：HIGH / FORCE 立即切，手势按已切换算；NORMAL / LOW 等到 chainFrom；
   - 到 chainFrom：立即交叉淡变；
   - **手部等待上限 600ms**（所有手部动作），超时按高优先级处理：立即切，手势按已切换算，先补对应关闭；
   - 没有标注的动作：HIGH / FORCE 抢更低优先级立即切，否则按自动衔接点，最长 600ms。
5. 同一模块只保留最新一条待执行指令，旧的返回 `superseded`（wait 路径同样）。

手势路径：两个非默认手势之间**禁止直接交叉淡变**，`cut:now` 也一样。切换前先按当前时刻落定手势（过了姿势开关点算已切换），再按 `handStates.edges` 取路径：先播当前手势的关闭，在它的 chainFrom 接下一个打开；只有从默认手势才能直接开。例：抚胸 → 竖手指 = `[抚胸手关闭 @0ms, 竖手指打开 @550ms]`。表里没有直达边时拼「当前→默认」+「默认→目标」。overlay 按 offset 依次 `playMotionAsync(..., {interrupt:true})`，executionId 与看门狗只挂最后一段。

`fadeMs` 只是回报：实际淡变时长由动作文件的 FadeInTime 决定（renderer 的 playMotionAsync 没有 fade 参数）。

状态：`GET /state` 每模块带 `remainingMs`、`nextCutInMs`、`pending`、`playing`，顶层带 `gesture:{current, settled}`、`accessories`、`compose`。

## 6. 入口

HTTP（宿主先静态校验，再经 aiInbox 交给 overlay 仲裁）：

| 路由 | 说明 |
| --- | --- |
| `GET /dsh-l2d/api/bridge/table` | 分区表 + 神态部件表 + 衔接点 + 自动衔接点 + 能力摘要 |
| `GET /dsh-l2d/api/bridge/state` | 占用、排队、手势、饰品、compose |
| `POST /dsh-l2d/api/bridge/act` | 下发指令 |
| `POST /dsh-l2d/api/bridge/release` | `{commandId}` 或 `{region}` |
| `GET /dsh-l2d/api/bridge/face/vocab` | 神态部件表原文 |
| `POST /dsh-l2d/api/bridge/face/compose` | `{compose | mood, ...}` → 一条只有 face 步的 act |
| `GET /dsh-l2d/api/bridge/face/describe` | 反推当前部件强度 |

MCP：`l2d_regions_get / act / release`、`l2d_accessory_set`、`l2d_face_vocab`、`l2d_face_compose`、`l2d_face_describe`。LLM 侧默认 `onBusy:'blend'`、`cut:'next'`；工具说明里用中文写清三个 cut 的用途（now 情绪突变、next 说话停顿处换动作、after 不想打断）。

派发：bridge 指令与其它 AI 指令一样经 aiInbox 的 `/ai/poll` 下发，只发给持有**指令派发租约**的那个 overlay（宿主默认开，设置 `consumerLeaseEnabled:false` 关）：页面带实例 id 和是否前台（`fg=1` 即 `document.visibilityState==='visible'`）去申请 / 续期；同一时刻只有一个持有者，前台页面可抢占后台页面；约 3 秒没续期就过期，交给下一个页面。未持有租约的 poll 返回空 `calls` 并带 `reason:'no-lease'`。租约转移时，已领出未回执的指令写明确失败 `{ok:false, reason:'lease-taken-over'}`（不重发：指令可能已在旧页执行到一半）。

旧接口：`l2d_play_motion` 走 blend，回执形状不变（排队时等出队后再返回；被顶掉返回 `{ok:false, reason:'superseded', status:'conflict', group}`）；`l2d_set_expression` 保持占用即拒（`onBusy:'reject'`），回执 `{ok}` / `{ok:false, error}` 不变。

## 7. 失败原因码

`invalid-command`、`empty-steps`、`invalid-step`、`invalid-priority`、`invalid-source`、`unknown-region`、`unknown-layer`、`duplicate-region`、`unknown-motion`、`motion-not-in-region`、`param-not-writable`、`lipsync-redline`、`invalid-value`、`unknown-expression`、`unknown-accessory`、`unknown-mood`、`unknown-face-unit`、`unknown-dimension`、`unknown-recipe`、`face-units-unavailable`、`expression-conflict`、`invalid-form`、`region-busy`、`wait-timeout`、`superseded`、`table-unavailable`、`not-found`。

region-busy / expression-conflict / superseded 是正常仲裁结果：换时机或提高优先级，不要原样重试。

## 8. 测试

`npm run test:core` 里：`body-bridge.test.mjs`（核心 72 例，含手势路径、优先级分支、superseded、600ms 强切）、`motion-cuts.test.mjs`（手写最小 motion3 样例）、`body-bridge-api.test.mjs`、`overlay-body-bridge.test.mjs`（按真实帧顺序跑 overlay 片段）、bridge 同步校验、`regions-tools.test.mjs`。测试不依赖、不提交任何模型文件。

## 9. 待真机确认

- 表情 / 饰品参数 verifySign 与实际朝向；compose 各部件幅度观感；
- weight 0 中和后渲染端是否立刻接管（眨眼、表情、物理）；
- motion-cutpoints.json 的时间点（脚本算出，需目测复核）与手势路径的接缝；
- fadeMs 与动作文件 FadeInTime 的实际观感差异；
- ParamMouthForm 被口型红线挡住后，笑 / 撇嘴部件的效果是否够用。
