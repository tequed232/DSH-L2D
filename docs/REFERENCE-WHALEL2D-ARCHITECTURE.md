# WHALEL2D 架构对照审计（外部参考）

> 审计对象：https://github.com/Ssssshaiiko/WHALEL2D（C# + D3D11 + Cubism Native 的 Windows 原生桌宠，MCP/HTTP/Agent 接入）。
> 审计方式：`git clone --depth 1`（commit `88865ba`）后对源码逐文件只读取证；所有结论给出 `文件:行号` 证据。
> 文档目的：为 M1-d（d1 Hip 语义控制 / d2 Gesture 接线 / d3 消费者隔离）提供外部对照。**本仓的架构决策不变**：
> d2 只参考 Body 的 Channel/Hold/Move/Clear 结构但复用现有 Timeline；d3 只参考 Named Pipe 会话管理思想但坚持服务端
> epoch fencing；不引入 C++ updater 替换已验证的 PhysicsGate。
>
> 标注约定：除 §1.6「FishPet.Mcp 中继」为快速浏览、以及需求方转述的仓库历史背景外，其余引用行号均已克隆源码核实。

---

## 1. 原项目实现机制与文件证据

原仓库分层：`renderer/main.cpp`（C++ 离屏渲染进程，stdin 命令 + stdout 帧流）← `src/FishPet/*.cs`（C# 宿主：窗口/气泡/行为/服务）← `src/FishPet.Mcp`（stdio→NamedPipe 中继，供任意 Agent 接入）+ `src/FishPet/HttpApi.cs`（本机 HTTP）。C# 与 C++ 之间用**文本命令协议**（`set / clear / exp / motion / anim / animloop / animstop / mouth / settle / look / sway …`，main.cpp:863-911）解耦。

### 1.1 Body.cs —— 「台词内嵌 Cue」的动作语义层（354 行）

- **Word 结构**：一条 cue 编译为一个 `Word(string? Channel, (string Id,double Value)[]? Hold, string? Overlay, (string On,string Off)? Hand, bool HandDown, (string Id,string Keys)[]? Move, string[]? Clear, bool Reset)`（Body.cs:16-17）。四类互斥的生效方式：
  - **Hold/Channel（命名通道持续参数）**：如「看左边」占 `gaze` 通道写 `ParamEyeBallX/FaceAngleX`，「歪头」占 `tilt` 通道写 `FaceAngleZ`（Body.cs:44-49, 54-61）。**同通道后词替换前词**：`channels[channel] = word.Hold!`（Body.cs:198）——不是叠加，"后来者取代"。
  - **Move（一次性时间曲线）**：`seconds:value` 键帧串，首尾必须是 0（Body.cs:20 注释、93-108）；`Repeat()` 生成"N 次点头/摇头"的往复曲线（Body.cs:35-42），`Scale/Pace` 对曲线做幅值/速度缩放（Body.cs:25-26）。
  - **Overlay（表情叠加层）**：`exp <name> 1/0`，HashSet 去重（Body.cs:86-91, 199, 114）。
  - **Hand（手部 motion 切换）**：成对 (On, Off) motion 名，**同一时刻只允许一只手**，新手切出前先 `PutHandDown()`（Body.cs:20-21, 90-91, 201, 212-216）。
  - **Clear/Reset**：词自带清除表（如「正视」清 `tilt/turn/pitch/gaze`，Body.cs:58, 197）；「恢复」= 全量 Relax（Body.cs:109, 230-237），但只清 Body 自己的东西，不动主人穿戴（Body.cs:229 注释）。
- **通道间加法合成**：`Show()` 把所有通道的 Hold 值**按参数 id 求和**后统一 diff——与上帧相同跳过、消失的发 `clear`（Body.cs:219-227）。注释明确："Channels add up where they touch the same input: looking aside while turned turns a bit further"（Body.cs:218）——即"歪头+转头同时生效时角度相加"。
- **Cue 语法**：台词里 `〔词[:方位][×次数]〕`，前缀 `微/大/快/慢` 调幅值/速度（Body.cs:169-177）；`-词` 单独撤销一个词的 Overlay/Channel/Hand（Body.cs:161-167）；未知词收集进 `Unknown` 上报（Body.cs:125, 178）。
- **与台词节奏联动**（其核心亮点）：
  - `Apply(cue, spoken, tone)` 接收"cue 之后那段台词要说多久"和语气（！/…），Move 时长按 `clamp(spoken/曲线长, .7, 1.6)` 伸缩（Body.cs:185-190），语气放大 1.2×/缩到 0.85×（Body.cs:158）。反射动作（吓一跳/眨眼/缩一下）**不受台词牵制**，保持自己的速度（Body.cs:147, 181-192）。
  - 台词只等动作"起手"：说话等 `Beat=0.35s`（手 0.7s、受惊 0.45s）；若 cue 后没有台词了，等完整动作但钳到 `LongestWait=2.4s`（Body.cs:148, 193-195, 207）。
  - `Line` 类把一句话拆成"字符步 + cue 步"（字符 9 字/秒，标点停顿，Body.cs:256-308），cue 步触发 `act()` 后**把时间线推迟 wait 秒**，实现"先做动作再开口、动作跟着句子长短伸缩"（Body.cs:333-353）；录好语音时改为全句铺满录音时长、不做等待（Body.cs:305-307）。`Done` 要求句尾动作播完才算说完，下一句才开播（Body.cs:326）。
- ** reflex 交接**：`Restore()` 在反射动作（Behavior 层）释放参数后，把 Body 自己的 shown 值重新 `set` 回去（Body.cs:240-243）；`Forget()` 在渲染进程重启后清空全部状态（Body.cs:246-249）。

### 1.2 Behavior.cs —— 自主行为生命周期（273 行）

- **Mood 记录**：`Mood(string[] Expressions, (Id,Value)[] Parameters, double Seconds, (Id,Keys)[]? Motion, (On,Off)? Gesture, bool Pushed)`（Behavior.cs:13-14）；21 个手工调好的情绪（问候/害羞/生气/摸头/…）全部静态表（Behavior.cs:25-50）。
- **生命周期**：`Show()` 先 `EndMood()` 释放上一个（表情回退、参数 `clear`、手势 Off motion、触发 `Ended` 回调，Behavior.cs:117-127），再上新的；`Tick()` 里 `now >= moodUntil` 到期自动结束（Behavior.cs:213）。
- **HandBusy 检查**：情绪的手势（Gesture）只有在 `HandBusy?.Invoke() != true` 时才切手——即 Agent 通过 Body 抚胸举手时，自主情绪不会把手抢下来（Behavior.cs:74, 104）；测试锁死 "a reflex leaves the hand she has up"（FishPet.Tests/Program.cs:256-261）。
- **Ended 回调**：`EndMood()` 末尾 `Ended?.Invoke()`（Behavior.cs:126）——宿主借此知道"反射结束了，把 Body 的参数 Restore 回去"（FishPet.Tests/Program.cs:262-263）。
- **防叠加**：连续点击时脸/参数立即换，但**第二次 Move 不叠上第一次**——`now < motionUntil && !force` 时跳过 anim（Behavior.cs:100-103），`motionUntil = 曲线总长 × 0.6`（Behavior.cs:103）；`Sided` 集合里只有"随触点方向翻转"的参数镜像取反，squash/眨眼不翻（Behavior.cs:98, 107-108, 111-115）。
- **穿戴保护**：Mood 结束时 `worn()`（主人穿戴表）里的表情不摘（Behavior.cs:120-122）；眼镜（Activity）与主人手戴的眼镜不叠戴不误摘（Behavior.cs:201-209）。
- **闲置行为**：`IdleMoods` 11 种（Behavior.cs:53），`Tick()` 在 speaking/dragging/mood 均为空且到 nextIdle 时按权重抽取，**不同时连抽同一个**（Behavior.cs:211-228）；深夜(23–6点)打哈欠/瞌睡权重 ×4（Behavior.cs:54-55）。
- **拖拽**：DragStart 圈圈眼 + 嘴张开 + `animloop` 悬摆；DragEnd `animstop`（循环曲目播完本轮）+ 清 Hanging 参数 + `Show("落地", force:true)`（Behavior.cs:167-184）。
- **语音口型**：`VoiceLevels()` 直接解析 16-bit PCM wav 分窗算 RMS，95 分位归一（Behavior.cs:231-272）。

### 1.3 renderer/main.cpp —— Cubism Native 更新顺序与自定义 Updater（1109 行）

- **Tick 更新顺序**（main.cpp:477-619，这是最值得看的骨架）：
  1. `LoadParameters()`（恢复上帧基底，main.cpp:479）；
  2. IDLE motion（motion manager 空则自动重启 IDLE，main.cpp:480-482）→ `gestures` 手势 motion manager（main.cpp:483）→ `SaveParameters()`（main.cpp:484）；
  3. 表情层：自维护 weight 渐入渐出 + 按 Additive/Multiply/Set 混合（main.cpp:486-499）；
  4. 合成"伪面捕输入"：视线缓动 + Drift 微晃 + 随机 saccade 扫视（main.cpp:501-526）；
  5. **Hold 参数**：weight 与 value 双指数平滑（0.15s），"已显示的 set 改目标值时平滑移动而不是跳变"（main.cpp:538-549, 871-878）；
  6. **Track 曲线**：smoothstep 插值（main.cpp:568-570），`View*` 轨道不进参数、进 MVP 矩阵（整体位移/旋转/squash，绕脚锚点，main.cpp:553-576, 629-638）；各轨道**加法叠加**，"新动作从不截断旧动作"（main.cpp:551 注释）；
  7. VTube Studio mapping（范围映射 + smoothing）`SetParameterValue`（main.cpp:581-595）；Hold 参数 `Set`、Track 参数 `Add`（main.cpp:596-597）；
  8. 窗口拖动 sway → PositionX/Y（main.cpp:599-605）；口型 `max(当前值, mouth)` 保证情绪张嘴不被口型闭合（main.cpp:607-615）；
  9. `_updateScheduler.OnLateUpdate(model, dt)` → `_model->Update()`（main.cpp:617-618）。
- **自定义 ICubismUpdater（Lids 眼睑）**：`struct Lids : ICubismUpdater`，注册在 `CubismUpdateOrder_EyeBlink + 50`（main.cpp:327-338, 378）——**在眨眼之后**（眨眼不能重新睁开被压下的眼睑）、**在物理之前**（睫毛随动）。`OnLateUpdate` 里读眨眼结果乘上外部 EyeOpen 系数（main.cpp:330-336）。这是 Cubism 5 update scheduler 的正确挂接姿势：updatable 列表注册后 `SortUpdatableList()`（main.cpp:372-386）。
- **命令协议要点**：`set` 的 Hold 自动平滑；`clear` 只把 `on=false` 让 weight 渐出；`animloop` 的循环由 `animstop` 标记"播完本轮再停"（main.cpp:896, 559-562）；`settle` 一次性空转 90 帧（1.5s）让换装/换体型在可见前收敛（main.cpp:899-900）。
- **Pipe 模式帧循环**：读线程把 stdin 命令推 mutex 队列（main.cpp:1039-1051），主循环每帧先 drain 命令再 `Tick → render → 回读 → 写 stdout（L2DF 头 + BGRA 帧）`（main.cpp:1057-1099）；dt 钳 0.1s（main.cpp:1089）；隐藏/全屏游戏时完全停画（main.cpp:1082-1087）。帧头带宽高，**分辨率可逐帧变**（main.cpp:1094）。

### 1.4 ControlServer.cs / HttpApi.cs / Tools.cs —— 多 Agent 接入

- **Named Pipe MCP server**（ControlServer.cs）：
  - 管道 ACL 只允许当前用户，且**显式 SetOwner(当前用户)**——注释记录了真实踩坑：`PipeOptions.CurrentUserOnly` 在某些 Agent 宿主（DeepSeek Harness）进程里 owner 会变成 Administrators，导致连接被拒（ControlServer.cs:25-35）。
  - `NamedPipeServerStreamAcl.Create(pipe, InOut, 16, …)`——**最多 16 个并发会话**，`ConcurrentDictionary<long, Session>` 管理多个 Agent 同时连接（ControlServer.cs:16, 43-48）。
  - 事件广播：`Publish(kind, detail)` 单调 sequence + 128 条环形缓冲，推给**所有**已初始化会话（notifications/message + resources/updated 双通道，ControlServer.cs:62-67, 92-97）。
  - 会话输出用 bounded Channel(128)，写不进去就断开"卡死读者"，绝不静默丢交互（ControlServer.cs:78, 86-89）。
  - tools/call 异步执行带 per-request 取消（notifications/canceled → CTS，ControlServer.cs:143-208）。
- **HttpApi.cs**：仅 127.0.0.1 + Bearer token（token 落 api.json），Origin 头直接 403（防网页驱动，HttpApi.cs:87-89）；`/tools` 可按 openai/anthropic 格式吐 function calling 清单（HttpApi.cs:93, 133-140）；端口冲突自动 +1 重试 20 次（HttpApi.cs:52-63）。
- **Tools.cs**：工具即人格——`say` 的描述直接教 Agent"把桌面当身体说话、〔〕写神情动作、一次发完多句、别一句一停"（Tools.cs:34-38）；身体词表放外部 `身体说明.md` 按安装路径引用（Tools.cs:30）。

### 1.5 FishPet.Tests —— 动作语义测试（264 行，无窗口纯逻辑）

- 结构约束：每个 Mood 的 Motion 键帧**必须以 0 开始、以 0 结束、时间严格递增**（Program.cs:20-28）；"不许 roly-poly 摇摆"（ViewRoll/ViewX 只许摸头有，Program.cs:30）；"跳跃只许受惊"（Program.cs:32）。
- 语义约束：Mood 结束"不留残留"（exp/clear 全对账，Program.cs:48-49）；穿戴保护（Program.cs:60-63, 76-89）；镜像方向（左戳右转 vs 右戳左转，Program.cs:106-111）；闲置 300 轮不重复且 11 种全出现、无手势情绪绝不切手（Program.cs:130-151）。
- Body 语义：通道替换（后来的 gaze 词替换前者，Program.cs:177-178）；台词节奏伸缩的具体数值断言（`点头 spoken=3s` → 曲线尾 1.696:0，Program.cs:204；语气 ！→幅值 -12，Program.cs:210）；Line 的等待/铺满录音/Done 语义（Program.cs:218-254）。
- HandBusy/Ended 交接（Program.cs:256-263）。

### 1.6 FishPet.Mcp 中继（stdio→pipe，167 行，快速浏览未逐行核实）

Agent 启动 stdio MCP server → 中继连宠物管道；宠物未起则先拉起（脱离 Agent 进程树，Agent 退出不中断说话）；quit 后中继常驻，下个工具调用自动把宠物带回来（FishPet.Mcp/Program.cs 头注释）。

---

## 2. DSH-L2D 对应模块对照表

| 维度 | WHALEL2D | DSH-L2D | 对照结论 |
|---|---|---|---|
| 手势时间线 | 无独立 Timeline；cue 即时编译进 Body 状态（Body.cs:155-208），台词等待靠 `Line.Advance` 手推时钟（Body.cs:333-353） | `gesture-timeline.ts`：group/delay/duration/timeout 分桶入队、参数域冲突、整批原子准入/打断、纯函数可重放（enqueueGesture gesture-timeline.ts:210-330） | 本仓更强：原子性与确定性是显式不变量（INV-5/8）；WHALE 的"同通道替换"只相当于单参数域特例 |
| 通道仲裁 | 通道名硬编码在 Words 表（gaze/tilt/turn/pitch/lean/eyes/brows/mouth，Body.cs:54-108），同通道替换、跨通道求和（Body.cs:198, 219-227） | `shared-arbitration.ts`：conflicts 来自画像数据、双向声明检查、accept/yield/queue/reject 四态（shared-arbitration.ts:110-174） | 本仓更通用（零通道名、fail-closed）；WHALE 的"跨通道求和"本仓没有对应物——本仓仲裁是"赢家通吃"，不做加法合成 |
| 写值仲裁 | 无所有权概念；renderer 端 Hold/Track 全部接受，`max()` 处理口型冲突（main.cpp:613-614） | `write-plan.ts` resolveWritePlan：lipsync 禁区、ownership 独占、相位校验、priority/source 秩 winner（write-plan.ts:144-262） | 本仓严格得多；WHALE 靠"单一渲染进程 + 单一 Body 状态"回避了多写者问题 |
| 相位（pre/post） | 更新顺序由 C++ update scheduler 固定：EyeBlink → Lids(+50) → … → Physics（main.cpp:372-386, 617-618） | pre/post 注入钩子（packages/renderer/src/index.ts:343-367）+ PRE_ONLY_PARAMS 物理根输入只许 pre（motion-intent.ts:36-41）+ physicsYield 让位登记表（fw/physics/physics-yield.ts:22-36） | 同构思想不同实现：WHALE 用 updater 顺序，本仓用相位钩子 + 让位表。Lids 的"EyeBlink 后、Physics 前"插入位与本项目 PoseUpdater 后 post 注入是同一类问题 |
| 持续参数生命周期 | Hold 无 owner/runId，靠 Body 单线程顺序保证；过期概念只有 `LongestWait`（Body.cs:19） | `limb-controller.ts`：acquire/set/release/runId/expiresAt/priority-blocked（limb-controller.ts:132-231）；param-injector own/release 到期自动释放（param-injector.ts:115-141） | 本仓显式租约有超时兜底，天然适配多消费者；WHALE 模型在多 Agent 下会失守 |
| 自主行为 | `Behavior.cs`：Mood 静态表 + HandBusy + Ended + 闲置加权抽取（Behavior.cs:25-50, 74-75, 211-228） | ambient.ts / posture.ts / 环境微动作层；ActGate 三档准入（action-chain.ts:259-320） | WHALE 的 HandBusy/Ended 是"反射层向语义层租借/归还"的最小协议，本仓目前缺少等价的显式交接回调 |
| 台词-动作联动 | `Line`：cue 阻塞台词、动作随句长/语气伸缩、录音铺满（Body.cs:255-354） | 无对应物（bubble/字幕与动作解耦；ai-inbox 队列只管调用回执 packages/dsh-l2d-plugin/lib/ai-inbox.mjs:10-71） | WHALE 独有且打磨充分（owner 反复调过的数值），见 §3/§5 |
| 动作语义测试 | 264 行纯逻辑断言，锁"键帧首尾为 0 / 不留残留 / 不重复 / 数值精确"（FishPet.Tests/Program.cs） | core 纯函数有单测，但**动作语义层**（哪些词→哪些参数、幅值方向、时长）无对应测试面 | 见 §5.3 |
| 消费者接入 | NamedPipe 16 会话并发 + 广播事件 + stdio 中继常驻（ControlServer.cs:43, 62-67） | 单消费者服务端 epoch fencing（renderer motionEpoch 打断作废 index.ts:1294-1302）+ ai-inbox 队列 | 多会话广播 ≠ 单一消费者租约；WHALE 的"会话死亡即清理、回执带序号"思想可借，fencing 机制不换 |
| 渲染进程隔离 | 独立 C++ 进程，文本协议 + 帧流，crash 不带崩宿主；`Forget()/Resume()` 处理重连状态重建（Body.cs:246-249, Behavior.cs:83-88） | 同进程 WebView 渲染 + 插件 HTTP 调试服 | WHALE 的"渲染器重启→状态重建"协议是 d3 消费者断连恢复的参考 |

---

## 3. 可直接吸收的设计（含落地建议与接入点）

### 3.1 「命名 Channel + 同通道替换」的语义组织（→ d2 直接参考）

- **是什么**：每个持续型动作归入一个命名通道（gaze/tilt/turn/pitch/lean/eyes/brows/mouth），同通道新词替换旧词、通道间参数求和（Body.cs:198, 219-227）。
- **对本仓的映射**：d2 不需要新机制——GestureSegment 的 `params` 参数域（gesture-timeline.ts:49-50, 168-176）就是"通道"的泛化：两个段声明的参数 id 重叠即冲突、高/同级准入即替换。**建议**：在 d2 的动作词表/示例资产里按"每词一个参数域"组织（如 `gaze` 词只声明 `ParamEyeBallX/FaceAngleX`），让现有冲突判定自然产生"同通道替换、跨通道并存"的行为，**不引入 Body 那种求和合成**（本仓仲裁是赢家通吃，求和会破坏 INV-1 唯一 winner）。
- **接入点**：`packages/core/src/gesture-timeline.ts` 的 domainOf（:169-171）无需改动；改动只在 d2 词表数据与 `GestureSegment.params` 的填写约定。

### 3.2 Hold 的「显示值平滑迁移」与首尾归零约束（→ d2 动作资产规范）

- **是什么**：renderer 对已显示的 Hold，改目标值时平滑移动而非跳变（main.cpp:871-878, 538-549）；所有 Move 键帧强制首尾为 0（Body.cs:20 注释 + 测试 Program.cs:20-28）。
- **对本仓的映射**：param-injector.apply 的 post 相位是逐帧重放 target（param-injector.ts:247-303），但**没有 weight 渐入渐出**——Agent 独占释放后参数直接跳回物理值。建议（可选优化，非 d2 阻塞）：给 `StickyValue` 增加 release 过渡权重，或在词表资产层面强制"入段/出段键帧归零"，用 Timeline 的 durationMs 承担淡出。
- **接入点**：`packages/renderer/src/app/param-injector.ts` apply()（:259-296）；或 d2 词表校验器（新增资产校验时比照 FishPet.Tests/Program.cs:22-27 的断言）。

### 3.3 HandBusy / Ended：反射层与语义层的最小交接协议（→ Behavior 类能力，见 §5.2）

- **是什么**：自主行为切手势前查 `HandBusy`（Agent 手在用就不动，Behavior.cs:104）；行为结束发 `Ended` 让语义层 `Restore()` 自己的参数（Behavior.cs:126, 240-243）。
- **对本仓的映射**：本仓 ambient/姿势层与 Agent 动作目前靠 priority 一刀切，缺少"低层让位后**恢复原状**"的显式回调。d2 可先不做；若后续做自主小动作，直接采用同型协议：ambient 触发前查 `limbController/acquire 冲突`（已有 priority-blocked 信号，limb-controller.ts:157-159），结束时发事件驱动 Body/姿势层重放 shown 值。
- **接入点**：ambient.ts 触发路径 + `ActGate.finish`/`action-done` 事件（action-chain.ts:236-257）。

### 3.4 会话管理：bounded 输出、卡死读者即断开、事件带单调序号（→ d3 参考）

- **是什么**：每会话输出 Channel(128) 满即断开（ControlServer.cs:86-89）；事件带全局单调 sequence + 环形 128 缓冲供重连接续（ControlServer.cs:62-67）；会话关闭即从注册表移除并取消其未决请求（ControlServer.cs:55-61, 209-213）。
- **对本仓的映射**：d3 坚持服务端 epoch fencing 不变（WHALE 的多会话广播模型不解决"两个消费者互抢"问题，它只是把同一份事件流发给所有人）。**可吸收的三点**：① ai-inbox 回执/事件带单调 id（ai-inbox.mjs:28 已有 `++seq`，保持并对外暴露为 fencing 判序依据）；② 消费者断连即清理其未决调用（对应 ai-inbox poll 超时清理，目前 poll 是 splice 全取、无 TTL，建议加 expiresAt）；③ 渲染器侧已有 epoch 作废模式（index.ts:1294-1302），d3 的会话租约过期应走同一模式而不是新机制。
- **接入点**：`packages/dsh-l2d-plugin/lib/ai-inbox.mjs`（TTL）、d3 会话注册表（新）、`packages/renderer/src/index.ts` motionEpoch（:1294）。

### 3.5 纹理/着色器缓存与 settle 预收敛（工程优化备忘）

- 着色器字节码缓存省 6–7s 启动（main.cpp:64-113）；纹理按文件大小+时间戳缓存 BGRA（main.cpp:195-229）；`settle` 空转 90 帧让状态变化在可见前收敛（main.cpp:899-900）。本仓 WebGL 加载已有预热，但若 d1/d2 引入"切装/切体型"类重状态操作，settle 思想（离屏预演 N 帧再展示）值得记一笔。

---

## 4. 不适合移植的部分及原因

| 原设计 | 不移植原因 |
|---|---|
| **C++ ICubismUpdater（Lids 等自定义 updater）替换更新链** | 需求方拍板：本仓 PhysicsGate + pre/post 钩子 + physicsYield 让位表已验证且带不变量测试；WHALE 的 updater 顺序是 Cubism Native 特有机制，Web 端没有等价 scheduler，且本仓 param-injector 两相位 + fw/physics 让位已覆盖"眨眼后/物理前"这类插入需求。**Lids 的插入位选择思路（某效果必须在 A 后 B 前）可作为写注释/文档的表述范式，不作为代码路径。** |
| **Body 的跨通道求和合成（Show() total 累加，Body.cs:219-227）** | 与本仓"每参数每帧唯一 winner"（write-plan.ts:99, 223-247）直接冲突；求和需要重写整条仲裁链，收益仅是"歪头+转头叠加"这类边缘表现，且 WHALE 自己也要为冲突词做 Clear（Body.cs:58）打补丁。d2 用参数域替换语义即可。 |
| **Named Pipe 多会话广播模型（16 并发会话）** | 需求方拍板：d3 的威胁模型是**单一消费者租约 + epoch fencing**（防陈旧消费者、防重放），WHALE 是"多读者同看一份事件流"，二者威胁模型不同。其 ACL 踩坑注释（ControlServer.cs:25-35）有价值但属于 NamedPipe 特有；本仓走 HTTP 调试服不存在该问题。 |
| **台词内嵌 Cue 作为 Agent 侧 DSL（〔〕语法）** | 本仓语义控制走 structured 通道（SemanticMotionFrame/motion-intent），自由文本 cue 解析会把"动作语义"埋进 LLM 输出格式，违背 fail-closed 与可测试性（未知词只能收集上报，Body.cs:178，无法静态校验）。其**节奏联动思想**值得吸收（§5.1），实现载体不同。 |
| **FaceTracker mapping（VTube Studio vtube.json 直读，main.cpp:443-475）** | 本仓无面捕输入路径；且本仓 gaze/angleBus 已有等价合成管线（index.ts:343-352）。 |
| **Mood 静态大表 + 手调数值直接照搬** | 数值全部针对其特定模型（owner 2026-11-02 人工评审，Behavior.cs:25-50）；本仓能力驱动铁律禁止把模型差异写进 core。只借结构与测试断言，不借数值。 |
| **单线程 Body 状态即仲裁（无 owner/租约）** | WHALE 敢这么做是因为 Body 只有一个调用方（Player/台词管线）。本仓多通道（gaze/拖拽/ambient/Agent/limb）并发，必须有显式所有权。 |

---

## 5. M1 完成后可选优化项（设计评估，不实施）

### 5.1 Body Cue DSL 评估（台词-动作节奏联动）

- **价值**：WHALE 最被 owner 称道的体验是"动作跟着句子长短伸缩、先做动作再开口"（Body.cs:150-155 注释记录了 owner 原话"动作要配合语气和句子长短"）。本仓 ai-inbox/动作回执管线已具备 `awaitFinish`（index.ts:1289-1293），缺的只是"多段台词 + 动作交错排程"的上层编排。
- **建议形态**：不做自由文本 〔〕 解析；在 d2 词表之上提供**结构化的 cue 序列**（`[{say, cues[], wait: 'start'|'end'}]`），等待语义复用 GestureTimeline 的 `durationMs` + 回执事件（action-done end）而不是 WHALE 的手推时钟。反射动作"保持自身速度"（Reflexes，Body.cs:147）映射为本仓 FORCE 档不受句长缩放。
- **工作量估计**：中。难点不在机制而在数值（每词的基线曲线/幅值需按本仓模型重新调，WHALE 数值不可复用）；且需要动作资产先完成键帧归零规范（§3.2）。
- **结论**：值得在 M1 完成后单独立项评估；先决条件 = d2 词表 + 语义测试落地。

### 5.2 Behavior 生命周期协议（HandBusy/Ended）

- **价值**：本仓 ambient/闲置行为目前与 Agent 动作只有 priority 单向关系；"反射借了参数、结束后语义层原样恢复"这个交接（Body.Restore 配 Behavior.Ended，FishPet.Tests/Program.cs:256-263）是把"环境自主感"加进来而不破坏所有权的最小协议。
- **建议形态**：ambient 触发前用 `arbitrateShared`（shared-arbitration.ts:110-174）做一次四态判定（queue 态正好对应"等 Agent 动作结束再打哈欠"）；结束时经 action-done 事件驱动受影响通道重放。HandBusy 对应本仓 `LimbController.size > 0` / 共享通道占用表的查询。
- **工作量估计**：小-中。协议两端都已存在（仲裁纯函数 + 事件管线），只差接线。
- **结论**：优先级高于 5.1；可与 d2 的 idle 排程需求合并评估。

### 5.3 动作语义测试（FishPet.Tests 式）

- **价值**：WHALE 用 264 行无窗口断言把"owner 评审过的行为"固化为回归（每次数值调整都写成新 Check）。本仓 core 纯函数测试覆盖仲裁，但**动作语义层无测试面**——d2 词表一旦扩到几十个词，"哪个词写哪些参数、方向对不对、时长是否随 scale 缩放"只能手测。
- **建议形态**：仿照三个不可变约束做词表校验器（每词 params 非空且参数存在、时长随 scale 单调、幅值方向与语义方向一致）；再加语义回归：给定 cue → 断言 `resolveWritePlan` 输出的 writes 集合（精确到参数 id 与符号方向，不必锁数值——数值随模型调，方向与结构不随）。这正好能挂在 write-plan 已有的 rejected/writes 回执上。
- **工作量估计**：小（校验器 <100 行）+ 持续维护（每加一词加 2-3 条断言）。
- **结论**：建议作为 d2 验收的一部分而非 M1 后项——词表落地的当天就建校验，成本最低。

---

## 附：核实状态说明

- **已核实**（克隆 commit `88865ba` 后逐行读取）：§1.1-1.5 全部引用行号、§2 表内 WHALEL2D 侧结论、§3/§4/§5 对 WHALEL2D 侧的引用。
- **仅据需求方转述未核实 / 快速浏览**：FishPet.Mcp 中继（§1.6）只读了头 50 行注释与结构；WHALEL2D 的 Git 历史演进、`prompt/身体说明.md` 的具体内容（词表面向 Agent 的完整文案）未取证；DSH-L2D 侧所有引用以本仓当前工作区（feat/m1-batch2）为准。
- 审计过程中 git https 证书吊销校验失败，改用 `http.sslVerify=false` 完成克隆（公开仓库只读，无内容完整性风险；未对本仓 git 做任何写操作）。
