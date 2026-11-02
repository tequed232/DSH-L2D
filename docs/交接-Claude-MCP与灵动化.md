# DSH-L2D 交接文稿（致 Claude）：MCP 接入与"灵动化"

> 交接日期：2026-11-02。仓库：https://github.com/tequed232/DSH-L2D
> 你的任务：**把 DSH-L2D 的控制面暴露为 MCP Server，让任意 Agent（包括你自己）能驱动 Live2D 角色；并在此基础上让角色的动作更"灵动"**。
> 交接人已验证文中所有"已验证"标注的能力，浏览器端到端跑通。

---

## 0. 一句话现状

DSH-L2D 是一个跑在 DeepSeek Harness（DSH）界面之上的 Live2D 桌宠插件：
官方 Cubism 5 Web SDK 渲染 + AI 工具调用桥 + Emotion_Router 情绪路由 + 工作区会话联动。
**渲染、控制链、情绪路由都已打通并实测**；缺的是把控制面标准化成 MCP，以及更细颗粒的拟人微动作。

## 1. 仓库结构（只列你会碰的）

```
packages/
  renderer/               # 渲染包（TS → IIFE，挂 window.DSH_L2D）
    src/index.ts          # 对外 API 全在这里（gaze/emotionSignal/playMotionAsync...）
    src/app/emotion-router.ts   # Emotion_Router（纯逻辑，信号→意图→仲裁）
    src/app/param-injector.ts   # 参数注入器（双相位 sticky 重放，见 §5 坑1）
    src/app/pose-controller.ts  # 四肢姿势（rest/finger/grass/chest）
    src/app/motion-director.ts  # 成对动作状态机（打开/关闭互斥）
  dsh-l2d-plugin/         # DSH 插件（cordis 模块）
    lib/index.js          # 宿主：HTTP 路由 + 设置持久化 + 会话解析
    lib/overlay.js        # 前端：UI/拖拽/传感器/右键菜单/戳一戳
tools/dev-server/         # 本地验证服（pnpm dev:server → 127.0.0.1:5300）
tools/gen-ai-tools/       # 从 capabilities 生成 AI 工具定义 dist/ai-tools.json
docs/AI-模型控制提示词.md  # 给 LLM 的动作使用规范（成对动作等）
```

## 2. 已验证能力（不要重做）

| 能力 | 入口 | 状态 |
|---|---|---|
| 参数注入（唯一正确帧相位） | `LAppModel` pre/post hook + ParamInjector | ✅ 实测 |
| 表情（21 个）/ 动作组（6+Idle）/ 四肢姿势 | `setExpression / playMotionAsync / setPose` | ✅ |
| 眼神+躯体跟随鼠标 | `gaze(x,y)`（眼球 post 相位全权，AngleX×14/AngleY×16 pre 相位） | ✅ |
| 待机视线漂移（走神） | 渲染包 idleDrift，每 2.5~4.5s 换随机点 | ✅ |
| Emotion_Router | `emotionSignal({type,data})`；规则表/词典/仲裁 | ✅ mood标签/连点/断网 |
| 戳一戳动作链（kind 化 chain） | overlay `executePokeAction`。`priority` 为 BACKGROUND / NORMAL / FORCE：低的不能打断高的，同级可以 | ✅ |
| 成对动作状态机 | `motion-director.ts`，重复打开幂等、右臂冲突拒绝 | ✅ |
| 系统传感器（CPU/内存/电量/断网） | 设置面板开关，默认**关**；`/dsh-l2d/sys-metrics.json` | ✅ |
| 媒体律动（页面内媒体播放→轻摆） | 设置开关，默认**关**；`setMediaSway(on)` | ✅（系统级媒体需原生模块，未做） |
| 右键菜单：模型外观子菜单/邪神彩蛋/设置 | overlay `buildMenu` | ✅ |
| 余额+峰谷价（DeepSeek API） | `/dsh-l2d/balance.json` | ✅ |
| AI HTTP 通道 | `POST /dsh-l2d/ai/call` + `/ai/poll`，白名单见下 | ✅ |

**现有 AI 工具白名单**（宿主 index.js `ALLOWED` + dev-server 同步一份）：
`l2d_set_expression, l2d_play_motion, l2d_set_pose, l2d_look_at, l2d_set_parameters, l2d_play_keyframes, l2d_stop_keyframes, l2d_reset_pose`。
执行端在 overlay `case 'l2d_*'` 分支。**MCP 工具就是在这套之上加壳。**

## 3. 对外 API 速查（window.DSH_L2D，MCP 工具的落点）

```ts
// 控制
setExpression(name): boolean          // 21 个实测名见 dist/capabilities.json
clearExpression(): boolean            // 脸回默认
playMotionAsync(group, opts?): Promise<{status:'ok'|'skipped'|'conflict'|'failed', reason?}>
setPose({right?, left?}): {ok, reason?}   // right/left: rest|finger|grass|chest
lookAt(x, y)                          // AngleX/AngleY 物理输入，±30°
gaze(x, y) / clearGaze()              // 眼神+躯体注视（带平滑），x,y∈[-1,1]
setParameters(values, weight): {ok[], failed[]}   // 物理输出参数会被拒绝
playKeyframes(tracks, opts): number   // 有轨道数/时长/值域硬护栏
setMediaSway(on) / setZoom(z) / layout(w,h,zoom)
// 情绪
emotionSignal(signal)                 // {type:'mood'|'system'|'mouse'|'media'|'state'|'chat', data}
getEmotionState() / injectEmotionIntent(intent)   // 彩蛋/显式触发用
// 信息
getCapabilities() / getInfo() / isReady() / readParameters(ids)
```

## 4. 你要做的第一件事：MCP Server

### 4.1 架构选型（推荐 A）

**A（推荐）：薄壳 stdio MCP 包，HTTP 转发。**
新建 `packages/dsh-l2d-mcp/`：一个独立 npm 包（`@modelcontextprotocol/sdk`，stdio transport），
把 MCP tool call 转发到本机 DSH 的 `http://127.0.0.1:<port>/dsh-l2d/ai/call`。
- 端口发现问题：DSH 端口不固定 → 依次探测 `~/.dsh/` 下的端口记录，或配置项 `DSH_L2D_URL`。
- 优点：不侵入 DSH 宿主进程、不碰 cordis 生命周期、Claude/Cursor 等任何 MCP 客户端即插即用。
- 参考实现：`vtube-studio-plugin-mcp-server`（同样的"控制面包壳"思路）、`prometheus-avatar`（17 工具的 MCP 设计）。

**B（备选）：宿主进程内起 MCP。** 在 dsh-l2d-plugin 的 apply() 里起 stdio server。
缺点：DSH 宿主 stdout 可能被占用、生命周期耦合。不推荐。

### 4.2 工具清单（MCP → 现有通道）

| MCP 工具 | 参数 | 落到哪 |
|---|---|---|
| `l2d_emote` | `mood: string`（开心/害羞/生气/惊讶/思考…） | emotionSignal mood → 词典映射表情（**高层语义优先，最"灵动"**） |
| `l2d_set_expression` | `name` | setExpression |
| `l2d_play_motion` | `group`, `awaitFinish?` | playMotionAsync（返回 skipped/conflict 要透传） |
| `l2d_set_pose` | `right?`, `left?` | setPose |
| `l2d_gaze` | `x, y` | gaze（注视，比 lookAt 更活） |
| `l2d_say` | `text`, `holdMs?` | 新增：气泡通道（复用 setEmotionBubble 的回调注册表） |
| `l2d_act` | `chain: [{kind, ...}]` | executePokeAction 同款（expression/motion/pose/look/look，带 delayMs） |
| `l2d_get_state` | - | getInfo + getEmotionState + getPose + 余额（聚合一个只读快照） |
| `l2d_reset` | - | resetPose + clearExpression + clearGaze |

`l2d_say` 与 `l2d_act` 需要在宿主/overlay 各加一条路由与执行分支（照抄现有 case 写法即可）。
低层 `l2d_set_parameters / l2d_play_keyframes` **不要**暴露进 MCP（护栏在外层，见 §5 坑2）。

### 4.3 返回格式约定

工具一律返回结构化 JSON：`{ ok: true, ... }` 或 `{ ok: false, reason: 'conflict'|'skipped'|'unknown-motion-group: xxx' }`。
动作的 `skipped/conflict` 是**特性不是错误**（状态机幂等/互斥），提示词里要让 Agent 学会读它换动作，而不是重试。

### 4.4 配置与安全

- MCP 包零密钥；余额查询继续走插件设置里用户自填的 Key。
- `~/.dsh/l2d-settings.json` 有 `systemSensor/mediaSensor`（默认 false），MCP 不要绕过开关。
- **测试 Key 一律不入库**（历史教训：用户给过临时 Key，全部走环境变量且用完即弃）。

## 5. 必须知道的坑（每条都有过血泪，别踩）

1. **帧相位是生死线**。Cubism 每帧：`loadParameters → motion → saveParameters → onLateUpdate(物理/表情/眨眼) → model.update`。
   外部写参数只有两个合法窗口：**pre**（saveParameters 后、物理前 → 物理输入 add 型）
   和 **post**（onLateUpdate 后 → 姿势/眼球 set 型）。ParamInjector 已实现双相位 sticky 重放；
   任何新写入都走 `injector.set(core, id, value, weight)` 或 gaze 那样的 hook，**别在 rAF 里直接写 core**。
2. **物理输入 vs 物理输出**。`AngleX/Y/Z、PositionX/Y` 是输入（写了有效）；
   `ParamAngleX/Y/Z、ParamBodyAngle*、HipAngle*、ShoulderY` 等是输出（每帧被覆盖，写了=没写）。
   注入器会按 physics3.json 输出表拒绝无效写。**`ParamMouthOpenY` 是禁区**（留给未来口型通道）。
3. **屏幕 y 要取反**。Cubism `AngleY/ParamEyeBallY` 正值=抬头；屏幕坐标 y 向下。driveGaze 里已取反，别"修复"它。
4. **弹簧闭式解别动**。临界阻尼解析解是 `x_new = x - d + (d + b*dt)*e`——曾经漏了 `- d`，误差每帧 ×1.6 指数发散，角色"飞走"（用户炸过两次）。用户明确：**拖拽不允许甩出/回摆，只允许临界阻尼收敛**。
5. **Loop 动作没有结束回调**。这模型 6 个动作组全是 `Loop:true`：靠动作时长定时器主动 stop + 收养实测终态（`terminalPoseForMotion`）；`stopMotions()` 必须同时清 `_currentPriority/_reservePriority`，否则后续 setPose 永远被拒。
6. **眼神/头部已由 gaze 统一管**。physicsTick 不再写 AngleX/Y（会双写叠加）；新增头部行为走 gaze/injector，别再加一路。
7. **自动化测试的坑**：工具调用之间页面会 blur（→菜单自动关），菜单操作要放在同一批动作里；截图可能是旧合成帧（frames=3 时），验证 DOM 状态用 `dom_cua_get_visible_dom`；数值验证优先用 `readParameters` 探针。
8. **README 用户会自己在 GitHub 网页改**，push 前先 `pull --rebase`，冲突保留双方内容。
9. **验证一律走 `pnpm dev:server`（5300）**。DSH 的 4310 端口是 catch-all 假服务，不能用来判断插件活着。
10. **插件改动要重启 DSH** 才生效（注入行/路由表启动时收集一次）。

## 6. "灵动化"待办（你的主战场，按性价比排序）

1. **SoulLink 式参数管线**（参考 `nanlingyin/SoulLink_Live2D`）：
   姿势/参数切换统一"钳位 → easeInOutCubic 过渡 → 空闲自动回归 rest"。
   现状 pose-controller 是简单 lerp；给它加 easing 曲线与"最后使用 N 秒后自动回位"，观感会细腻一截。
2. **高层语义工具优先**：MCP 暴露 `l2d_emote(mood)` / `l2d_act(chain)`，让 Agent 用意图说话；
   低层参数工具不暴露（参照 §4.2）。
3. **微动作库**（参考 `ikaikaihub/VTS-AI-Plugin` 的随机微动作）：
   在 idleDrift 基础上加"歪头（AngleZ ±3° 缓动）/耸肩/重心转移（PositionX ±5）"，
   走 Emotion_Router 的 ambient 优先级 20，冷却 20~40s，禁止与拖拽/动作并发。
4. **情绪惯性接聊天**：attention 回流的文本除了 chatActionForReply 的关键词映射，
   再喂 `emotionSignal({type:'mood', ...})`（LLM 有 `<mood>` 标签就用标签，没有就关键词）。
5. **MCP 驱动的连续演出**：`l2d_act` 支持 delayMs 序列，并用 `priority` 挡住「低打断高」。
   `phase` 可直接用 listening / thinking / speaking / settle 四段短链（不写 `ParamMouthOpenY`）。
   `accepted` 只表示占上槽，播完或被打断看 `/ai/result` 上的 `action-done`。
6. （远期）B 站弹幕接入（AILiveVTuber-Stage）、系统级媒体侦测（原生模块）、口型同步（TTS RMS → ParamMouthOpenY，需先拆掉表情对嘴型的占用）。

## 7. 构建 / 验证命令

```bash
pnpm -F @dsh/renderer build      # 渲染包（产物直接落到 dsh-l2d-plugin/assets/renderer.js）
pnpm dev:server                  # 127.0.0.1:5300；overlay.js 是 no-store，改完刷新即生效
node --check packages/dsh-l2d-plugin/lib/overlay.js   # overlay 是纯 JS
# 浏览器验收（noauto=1 关闭后台自主动作，避免污染断言）
#   ?emo=1  情绪路由：mood标签/连点/断网
#   ?gaze=1 注视探针：上/下/漂移参数数值
#   ?s2=1   动作链回归   ?s4=1  四肢姿势回归
npm pack --pack-destination dist ./packages/dsh-l2d-plugin   # 插件 tgz
```

## 8. 参考仓库 → 已吸收/待吸收映射

| 仓库 | 已吸收 | 待吸收 |
|---|---|---|
| FULASKA/-live2d- | kind 化动作链 + runId 打断 | - |
| HoppoChan0721/dsh-desktop-petbox | 自发聊天/频控/回流 | - |
| morettt/my-neuro | `<mood>` 标签→词典 | 标签体系扩展 |
| nanlingyin/SoulLink_Live2D | - | easeInOutCubic+自动重置管线 |
| ikaikahub/VTS-AI-Plugin | 待机视线漂移 | 随机微动作库 |
| myths-labs/prometheus-avatar | -（TS/PIXI 同构） | **MCP Server 工具面设计（本次主任务）** |
| hkopenai/vtube-studio-plugin-mcp-server | - | **MCP 包壳范本（本次主任务）** |
| Open-LLM-VTuber / KKLL2025/AILiveVTuber-Stage | 情绪映射思路 | B 站联动 |

---

**最后一句**：这套代码里所有"看起来应该可以"的直觉都可能被 Cubism 的帧相位打脸——改参数写入前先读 §5 坑 1/2；改拖拽前先读坑 4；怀疑"没生效"时先用 `readParameters` 探针拿数值，再下结论。
