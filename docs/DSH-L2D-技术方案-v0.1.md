# DSH-L2D 技术方案 v0.1

> 目标：在 Windows / Android 上实现类 VTube Studio 的 Live2D 模型加载与表演能力，支持「大模型驱动」与「用户（摄像头 / 键盘）」双路实时控制；交付形态为 DSH 插件或独立桌面 App。
> 状态：方案草案，待评审。作者：技术预研。日期：2026-11-01。

---

## 0. 结论摘要

1. **技术路线选「双壳同核」**：渲染与驱动逻辑用 TypeScript 单套实现，Windows 用 Electron 外壳、Android 用 Capacitor（系统 WebView）外壳。不做 Unity 首发——Unity 在双端覆盖上更整齐，但插件化嵌入、UI 定制与研发迭代速度都明显更差（见 §2 决策矩阵）。
2. **架构必须三层解耦**：意图层（LLM 只做离散语义决策）→ 混合层（参数仲裁器，核心 IP）→ 渲染层（Cubism Core）。**绝不让大模型逐帧生成参数**，这是效果崩坏与延迟失控的首要原因。
3. **首版 8～10 周可交付 Windows**：P0 阶段只做单模型、表情+动作组、口型同步、键盘控制；摄像头面捕与 Android 放 P1/P2。
4. **最大的两个风险不在技术，而在合规与端侧性能**：Live2D「可扩展性 APP」条款可能使产品**无法享受个人/小规模豁免**（§7）；低端 Android WebView 上的透明悬浮渲染是性能瓶颈（§5.2）。
5. **一个高性价比的产品设计点**：LLM 首 token 延迟 300～1200ms 无法消除，用「思考姿态（thinking pose）」把它变成表演的一部分，而不是让模型静止发呆。

---

## 1. 需求拆解与能力边界

先把「驱动 Live2D 动起来」这件事拆成物理上不同的四类信号，它们的实现手段完全不同，混在一起谈会严重低估工作量。

| 需求 | 物理本质 | 实现手段 | 可行性 |
|---|---|---|---|
| 加载并渲染模型 | Cubism 模型解析 + 网格变形 + 遮罩/物理 | Cubism Core（官方运行时） | 确定可行 |
| 面部表情（眨眼、笑、皱眉、视线） | **参数**（ParamEyeLOpen / ParamMouthForm / ParamAngleX…）的连续值 | 实时写参数，逐帧平滑 | 确定可行 |
| 口型同步 | 参数（ParamMouthOpenY / ParamMouthForm）由音频包络驱动 | RMS 包络 → 平滑 → 写参数 | 确定可行 |
| 肢体动作（挥手、点头、转身、比心） | **没有骨骼**。Live2D 的肢体是参数曲线动画，必须预先在 Cubism Editor 里做成 `motion3.json`，或用程序按参数曲线生成 | 播放动作文件（官方 Motion 系统）/ 程序化参数动画 | 可行，但有边界（见下） |

**关键认知（会影响产品承诺）**：Live2D 不是 VRM，没有骨架与 IK。所谓「让模型做出一个没预设过的动作」，在 Live2D 里等于「临时生成一条多参数关键帧曲线」。这条路技术上可行（参数白名单内插值），但生成质量高度依赖模型本身的绑定质量，不同模型差异极大。因此产品叙事应表述为：

> 「大模型可以在模型的**表达能力范围内**编排表情与既有动作的组合」，而非「大模型可以任意生成肢体动作」。

---

## 2. 运行时选型（关键决策）

Live2D Inc. 官方提供四套运行时，能力与代价差异显著。

| 维度 | A. Cubism SDK for Web + TS | B. Cubism SDK for Unity | C. Cubism Native (C++) 自研壳 | D. live2d-py (Python) |
|---|---|---|---|---|
| 语言 | TypeScript | C# | C++ | Python |
| Windows | ✅（Electron / Tauri） | ✅ | ✅ | ✅ |
| Android | ✅（WebView） | ✅ | ✅ | ❌ |
| 双端代码复用 | **~90%** | ~95%（同引擎，但平台适配代码不同） | ~80%（JNI 桥接） | 0% |
| 透明悬浮窗口 | Electron 成熟 | 可行但重 | 完全可控 | 依赖 Qt |
| 嵌入 DSH 插件 | **天然（iframe / webview）** | 困难 | 困难 | 困难 |
| 性能上限 | 中（WebGL） | 高 | 最高 | 中高 |
| 包体 | Electron ~150MB / Tauri ~15MB | ~60MB+ | ~10MB | ~80MB |
| 研发速度 | **最快** | 慢（场景/资源管线重） | 最慢 | 快（仅桌面） |
| 生态（参考实现多） | **最多** | 中 | 少 | 少 |

### 结论：选 A（双壳同核）

理由有三，按权重排序：

1. **插件形态是硬约束**。需求里明确「可以做成 DSH 插件」。只有 Web 技术栈能被 iframe / WebView 无侵入嵌入，且宿主与模型的通信可以退化为一条 WebSocket。Unity 与 Native 方案在「既是独立 App 又是插件」这个双形态要求下几乎无解。
2. **驱动逻辑才是本项目的核心资产**，渲染是标准件。渲染层用官方 Core 已经足够，把研发预算投在「参数仲裁 + 意图协议」上收益高得多。
3. 大量成熟参考实现（Open-LLM-VTuber、my-neuro、AITuberKit）都验证了 Web 路线的可行性。

**明确接受的两个代价**：

- Android 端性能天花板低于 Unity，需要在 §5.2 做针对性降级策略。
- Electron 包体大。若最终只做 Windows，可切换 Tauri v2（Rust + WebView2），核心代码零改动；但 Tauri 在 Windows 上的「透明 + 点击穿透 + 置顶」组合稳定性弱于 Electron，建议 P0 用 Electron 保交付，P2 再评估迁移。

**渲染库选择**：直接用官方 Cubism 5 SDK for Web 的 Framework，或在其上包一层 `pixi-live2d-display`（社区库，`@naari3` 分支已升级到 PixiJS v8 + Cubism 5）。建议**在官方 Framework 上做薄封装**而非重度依赖社区库——社区库的分支分裂（guansss / naari3 / jannchie / zennomi 四个版本并存）是长期维护风险，且我们需要直接访问 `CubismModel.setParameterValueById` 等底层接口来做仲裁。

---

## 3. 总体架构

```
┌──────────────────────────────────────────────────────────────┐
│  L5  集成层  DSH 插件契约 / 本地 WebSocket API / MCP Tools      │
├──────────────────────────────────────────────────────────────┤
│  L4  意图层  LLM 对话 → 结构化动作指令（JSON Schema 强约束）      │
│              流式解析 · 分句触发 · 失败降级                      │
├──────────────────────────────────────────────────────────────┤
│  L3  混合层  ★ 参数仲裁器 ParamMixer（本项目核心 IP）            │
│              通道注册 · 权重混合 · 优先级仲裁 · 冲突消解          │
├──────────────────────────────────────────────────────────────┤
│  L2  感知层  摄像头面捕 · 麦克风口型 · 键盘/手柄 · 鼠标视线        │
├──────────────────────────────────────────────────────────────┤
│  L1  渲染层  Cubism Core · 模型/物理/动作/表情 · 逐帧求值         │
├──────────────────────────────────────────────────────────────┤
│  L0  外壳层  Electron(Windows) · Capacitor(Android) · Web(插件)  │
└──────────────────────────────────────────────────────────────┘
```

**数据流（一次 AI 回复的完整链路）**：

```
用户输入 → LLM 流式输出
   ├─(文本流)→ 分句切分 → TTS 合成 → 音频包络(20ms 粒度) ─┐
   └─(动作指令)→ 校验 → 动作队列 ───────────────────────┤
                                                      ▼
                                          ParamMixer（每帧求值）
                                                      ▲
        摄像头 52 blendshape ──映射──┐                 │
        键盘/手柄事件 ────────动作组──┼─────────────────┘
        空闲呼吸/眨眼/物理 ─────────┘
```

---

## 4. 驱动引擎设计（核心）

### 4.1 参数仲裁器 ParamMixer

这是整个系统最容易做崩、也最有价值的部分。多个输入源会同时想写同一个参数（例如面捕和表情都想控制 `ParamMouthForm`），必须有明确的仲裁规则，否则表现为抖动、抽帧、表情"打架"。

**规则一：分层，不并列。** 每帧按固定顺序求值，后写覆盖前写，而非所有源平权相加：

| 序 | 通道 | 典型参数 | 混合模式 | 说明 |
|---|---|---|---|---|
| 1 | Idle / 物理 | 全身参数 | base | 呼吸、眨眼、头发物理，兜底基线 |
| 2 | 表情 Expression | 眉/眼/嘴/腮红 | soft-add，权重 0.6~1.0 | 可叠加，用于情绪底色 |
| 3 | 动作 Motion | 全部（motion3 曲线驱动） | **独占锁** | 播放期间该组参数被动作接管 |
| 4 | 面捕 Tracking | ParamAngle* / ParamEyeBall* / ParamBodyAngle* | soft-blend，权重可调 0~1 | 用户可现场调强度 |
| 5 | 口型 LipSync | ParamMouthOpenY / ParamMouthForm | **硬覆盖 hard-override** | 最高优先级，任何人不得覆盖 |
| 6 | 程序化叠加 Procedural | 任意白名单参数 | add，带时间衰减 | 说话节奏点头、语气加重等微动作 |

**规则二：动作锁（Motion Lock）。** 动作播放期间，它驱动的参数进入锁定态。此时实时通道（面捕/表情）不得 `set`，只能 `add`。这解决了"挥手动作刚播到一半被面捕写坏"的经典问题。

**规则三：软切换与时间常数。** 每次通道切换用一阶低通滤波过渡，且不同参数用不同时间常数——眼睛必须快（~30ms，否则显得迟钝），头部中速（~120ms），身体慢（~300ms，否则抽搐）。

```ts
// 每帧求值（伪代码）
function evaluate(dt: number, channels: Channel[], model: CubismModel) {
  model.loadParameters();                    // 载入 idle/物理的基线值

  for (const ch of channels.sortBy(priority)) {
    if (!ch.enabled) continue;
    for (const [paramId, target] of ch.values) {
      if (isHardLocked(paramId, ch)) continue;   // 口型锁 / 动作锁
      const prev = model.getParameterValueById(paramId);
      const blended = ch.mode === 'add'
        ? prev + target * ch.weight
        : lerp(prev, target, ch.weight);
      model.setParameterValueById(paramId, clamp(blended, min, max));
    }
  }
  model.update();                            // 触发物理 + 网格变形 + 绘制
}
```

### 4.2 LLM 意图协议

**设计原则：大模型只做离散语义决策，不做连续量控制。** 它输出「现在该用哪个表情、播哪个动作组、看向哪里」，参数插值、平滑、时序全部交给确定性代码。这样即使模型输出抖动，画面也不会抖。

**动作指令 Schema（供 tool-calling / JSON mode 强制约束）**：

```json
{
  "expression": "joy",
  "motion": { "group": "TapBody", "index": 0, "priority": 2 },
  "gaze": { "target": "user", "intensity": 0.8 },
  "beat": 2,
  "duration_ms": 1800
}
```

字段约束：

- `expression`：**枚举**，只能取当前模型 `exp3.json` 中实际存在的表情 ID（运行时从 model3.json 动态生成工具定义，做到模型无关）。
- `motion.group`：**枚举**，只能取模型 motion3.json 中已定义的动作组名。
- `gaze`：语义目标（user / away / up / down / left / right），非坐标。
- `beat`：语速节奏权重，用于程序化点头幅度。
- 所有字段均可选，缺省则沿用当前状态（避免每句都重置表情，显得机械）。

**触发时机很关键。** 不要等整段回复生成完再动——那会有 1~2 秒的"僵直期"。做法：

1. 流式接收，按标点+长度切句（首句阈值可短，如 12 字，让模型尽快"反应"）。
2. **首 token 到达立刻切 `thinking` 姿态**（歪头/托腮/抬眼），把等待时间变成表演。
3. 每句合成 TTS 时，把该句的动作指令与音频包络一起入队，由播放器在音频开始播放的瞬间触发，保证音画同步。

**失败降级**：LLM 输出不合 Schema 或引用了不存在的表情 → 丢弃该字段、保留其余、记录一次软错误；连续 3 次失败则本回合降级为「中性 + 随机 idle 微动作」。

### 4.3 口型同步

采用业界通行的音量包络方案（Live2D 官方教程同款）：

```
音频分段 20ms → 计算 RMS → 归一化到 0~1 → 指数平滑（attack 快/release 慢）
→ 写 ParamMouthOpenY（权重 0.8）→ 可选叠加高频抖动模拟元音变化
```

要点：

- **attack/release 不对称**：张嘴快（~20ms）、闭嘴慢（~80ms），否则听感"卡顿"。
- 增益自适应：对整段音频做分位数归一化（取 95 分位作 1.0），避免 TTS 音量偏小导致嘴不动。
- 局限要写进产品说明：**音量驱动无法区分元音**，"啊"和"呜"口型一样。若要更精细，需 viseme 级方案（对 TTS 输出音素时间戳，映射 A/I/U/E/O 五口型参数），成本高一个数量级，列为 P3 可选增强。

### 4.4 摄像头面捕

| 方案 | 输出 | 延迟 | 授权 | 建议 |
|---|---|---|---|---|
| MediaPipe FaceLandmarker (Tasks) | 478 关键点 + **52 blendshape（ARKit 命名）** | 8~12ms（移动端 GPU delegate） | Apache-2.0 | **首选** |
| OpenSeeFace | ~30 blendshape | 中等，CPU 重 | 开源 | 备选 |
| iPhone ARKit | 52 blendshape，质量最佳 | <30ms | 需 iPhone 硬件 | 可选外挂 |

映射链路：`blendshape → 语义层 → 归一化 → Live2D 参数`

```
eyeBlinkLeft/Right      → ParamEyeLOpen = 1 - score
jawOpen                 → ParamMouthOpenY（与口型取 max，不叠加）
browInnerUp             → ParamBrowLY / ParamBrowRY
mouthSmileLeft/Right    → ParamMouthForm
headYaw/Pitch/Roll（从变换矩阵提取）→ ParamAngleX/Y/Z（限幅 ±30）
eyeLookIn/Out/Up/Down   → ParamEyeBallX/Y
```

三个必须做的工程细节：

1. **标定**：首次使用采集 2 秒中性表情作基线，减去静态偏移，否则戴眼镜/脸型差异会导致"默认皱眉"。
2. **死区 + 限幅**：绝对值 <0.08 的变化忽略，防止静止时高频抖动。
3. **口型优先级保护**：说话时 `jawOpen` 不得覆盖 RMS 口型（走 §4.1 的硬覆盖锁）。

### 4.5 键盘 / 手柄 / 鼠标

- 键位绑定到**动作组**与**表情**，而非参数。配置文件形如 `{ "Q": { "type": "motion", "group": "TapBody", "priority": 3 }, "W": { "type": "expression", "id": "anger" } }`。
- 鼠标移动 → 视线跟随（写 `ParamEyeBallX/Y` + 小幅 `ParamAngleX/Y`），这是成本最低、体感最强的一项交互，建议 P0 就做。
- 长按/组合键支持"持续姿态"（如按住 Shift 做持续害羞表情），松开回落。

### 4.6 模型兼容性（易被低估的坑）

不同模型的参数命名与绑定完全不统一：有的叫 `ParamMouthOpenY`，有的叫 `ParamMouthOpen`；有的模型根本没绑肢体参数。必须做**运行时参数探测 + 语义绑定表**：

```
1. 加载 model3.json → 枚举全部 ParameterId
2. 按内置别名表匹配（每类语义给 3~5 个候选名 + 正则）
3. 未匹配到的语义 → 该功能自动禁用并在设置页提示（不报错、不崩）
4. 生成"能力清单"回传给 LLM，工具定义只暴露该模型真实具备的表情/动作组
```

这一步做扎实，产品才能"任意模型丢进来就能用"，这也是 VTube Studio 的 auto-setup 在做的事。

---

## 5. 跨端实现

### 5.1 Windows（Electron）

| 能力 | 实现要点 |
|---|---|
| 透明背景 | `transparent: true` + `frame: false`；务必关闭 `backgroundColor`，并启用 `backgroundThrottling: false` |
| 置顶 | `alwaysOnTop: true`，层级用 `'screen-saver'` 可盖住任务栏 |
| 点击穿透 | `setIgnoreMouseEvents(true, { forward: true })`，配合鼠标位置轮询在命中模型区域时临时恢复——否则整窗不可交互 |
| 系统托盘 | 常驻托盘 + 右键菜单（切换模型/开关面捕/退出） |
| 多显示器 | 记住 DPI 与屏幕坐标，避免拔插后模型跑到屏幕外 |
| 开机自启 | `app.setLoginItemSettings` |
| 麦克风/摄像头 | 主进程 `systemPreferences.askForMediaAccess` + 渲染进程权限白名单 |

已知坑：部分核显 + Windows 11 的透明窗口会出现黑底或撕裂，需要提供 `--disable-gpu-compositing` 降级开关与「不透明模式」兜底。

### 5.2 Android（Capacitor + 系统 WebView）

| 挑战 | 对策 |
|---|---|
| 后台保活 | 前台服务 + 常驻通知；Android 14 需声明 `foregroundServiceType` |
| 悬浮窗 | `SYSTEM_ALERT_WINDOW` 权限 + 全屏透明 Overlay（需引导用户手动授权） |
| 性能 | 纹理质量降档、关闭多余遮罩、限制 30/45fps、`willChange` 谨慎使用 |
| WebView 差异 | 国产 ROM WebView 内核版本碎片化，必须做启动自检（WebGL2 / 浮点纹理 / 最大纹理尺寸） |
| 音频回环 | 麦克风口型需 `AudioRecord` 原生插件，Web 层 `getUserMedia` 在后台会断 |
| 功耗 | 静止降帧（idle 15fps）、面捕按需启停 |

**结论**：Android 是「可用」而非「同等体验」，建议在 P2 阶段以**降低预期**的方式交付（先做前台 App，悬浮窗作为可选高级功能）。

### 5.3 DSH 插件形态

插件化是这套架构最大的红利，需要提前定义契约：

- **嵌入方式**：宿主以 iframe / WebView 加载 `avatar.html`，双方通过 `postMessage` 通信；若宿主是独立进程，则退化为本地 WebSocket（`ws://127.0.0.1:8001`）。
- **契约最小化**：宿主只需下发三类消息——`say(text|audio, envelope)`、`do(actionJSON)`、`setEmotion(id)`；模型回传两类——`ready(capabilities)`、`event(hit/motionEnd)`。
- **降级策略**：宿主不支持音频包络时，模型自行用 `AnalyserNode` 从音频流实时算 RMS，保证独立可用。
- **安全**：插件只监听 127.0.0.1，带一次性 token 握手，默认拒绝外部来源（对齐 VTube Studio 的权限模型思路）。

### 5.4 延迟预算

| 环节 | 目标 | 说明 |
|---|---|---|
| 麦克风采集 | 10~20ms | 缓冲区越小越低，但易爆音 |
| RMS 计算 + 平滑 | <2ms | 20ms 粒度足够 |
| 参数仲裁 + 写入 | <1ms | 单帧参数 <200 个，无压力 |
| 渲染 | 16.7ms @60fps | 移动端目标 30~45fps |
| **端到端（口型/面捕）** | **<50ms** | 人耳可接受阈值内 |
| LLM 首 token | 300~1200ms | **不可消除**，用 thinking pose 遮盖 |
| TTS 首包 | 200~600ms | 优先选流式 TTS |

---

## 6. 对外接口设计

三套接口，覆盖三种集成方式：

1. **本地 WebSocket JSON 协议**（主接口）——参考 VTube Studio Public API 的设计（请求/响应 + `requestID` + 权限授予），但**不要试图完全兼容 VTS 协议**：VTS 的协议是围绕它自己的场景模型设计的，硬兼容会带来不必要的耦合。保持「形似」即可，便于生态迁移。
2. **HTTP + JSON**（轻量集成）——给不方便维持长连接的宿主，`POST /action`、`GET /capabilities`。
3. **MCP Tools**（给 Agent 用）——把 `express`、`play_motion`、`look_at`、`set_parameter` 暴露成 MCP 工具，任何支持 MCP 的 Agent 都能直接驱动模型。这是「让 Claude/ChatGPT 驱动」最干净的做法，比在 prompt 里塞 JSON 约定可靠得多。

**能力自描述**是所有接口的前提：模型加载后先产出 `capabilities.json`（可用表情 / 动作组 / 参数白名单），接口与 LLM 工具定义都从它生成。

---

## 7. 合规与授权（**请务必先决策，会影响产品形态**）

Live2D 的授权不在技术侧，但它是**能否上线的一票否决项**。

| 场景 | 是否需要签约 | 费用 |
|---|---|---|
| 仅开发/试用阶段 | 否 | — |
| 个人或小规模事业者（年销售额 < 1000 万日元）发布普通作品 | **可豁免** | 0 |
| 年销售额 ≥ 1000 万日元 | 需要《出版许可协议》 | 按事业规模分级计费 |
| **可扩展性 APP（Expandable Application）** | **不适用豁免，无论规模，每个作品都需单独申请并签约** | 单独议定 |

**关键风险**：Live2D 官方对「可扩展性 APP」的定义是「拥有大幅度扩展功能的软件，其提供的服务或内容中运用了 SDK」，典型即为**允许终端用户自行加载/替换模型的 App**。DSH-L2D 的产品形态（用户导入自己的 Live2D 模型）**很可能被判定为可扩展性 APP**，从而**无法享受个人/小规模豁免，必须逐作品申请签约并获得 Live2D 事前批准**。

三条应对路径：

- **路径 A（推荐，先做）**：MVP 阶段仅内置 Live2D 官方免费样例模型与自制模型，**不开放用户导入**，把产品定位为「模型表演工具」而非「模型播放器」，沿用普通作品豁免。
- **路径 B**：若必须开放导入（这是核心卖点），立项前直接向 Live2D 提交可扩展性 APP 的出版许可申请，把审批周期（通常数周）纳入排期。
- **路径 C**：技术上支持双运行时——Live2D + VRM/3D，降低对单一授权的依赖；但工作量翻倍，不建议首版做。

**另需注意**：Cubism Core（`live2dcubismcore.min.js` / `.wasm` / `.so`）**不可从第三方 CDN 引用**，必须从官方 SDK 包内提取并随应用分发，且源码仓库不得提交（大多数开源项目用构建时下载的方式规避）。

---

## 8. 风险清单

| # | 风险 | 影响 | 概率 | 缓解 |
|---|---|---|---|---|
| R1 | 被判定为可扩展性 APP，需逐作品签约 | **致命（阻塞上线）** | 高 | 见 §7 路径 A/B，立项即启动法务沟通 |
| R2 | 低端 Android WebView 透明悬浮掉帧 | 高 | 中 | 降档策略 + 仅旗舰机型承诺悬浮窗 |
| R3 | 不同模型参数命名/绑定差异导致"某些模型不可用" | 中 | **高** | §4.6 参数探测 + 能力清单 + 优雅降级 |
| R4 | LLM 输出不合 Schema 或引用不存在表情 | 中 | 中 | 运行时生成枚举约束 + 校验 + 软失败降级 |
| R5 | 动作与实时通道冲突导致表情抽动 | 中 | **高** | §4.1 动作锁 + 分层仲裁 + 滤波时间常数 |
| R6 | 社区渲染库分支分裂，长期维护风险 | 中 | 中 | 薄封装官方 Framework，不深度绑定社区库 |
| R7 | Electron 包体与内存占用偏高 | 低 | 高 | P2 评估 Tauri 迁移（核心代码零改动） |
| R8 | 面捕在不同光照/眼镜下不稳定 | 中 | 中 | 标定流程 + 死区 + 强度滑杆 |

---

## 9. 里程碑与工作量

| 阶段 | 周期 | 交付物 | 验收 |
|---|---|---|---|
| **P0 可行性验证** | 3~4 周 | Windows Electron 透明窗；加载 1 个官方模型；idle+物理；眼睛跟随鼠标；键盘触发 3 个动作组；ParamMixer v0.1 | 稳定 60fps，内存 <400MB，切换动作无穿模 |
| **P1 AI 驱动** | 4 周 | LLM 意图协议 + Schema 校验；流式分句；TTS + RMS 口型；thinking pose；MCP/WebSocket 接口 | 音画同步偏差 <80ms；连续对话 10 分钟无状态错乱 |
| **P2 感知与多端** | 6 周 | MediaPipe 面捕（含标定）；Android Capacitor 版（前台 App）；模型导入与参数自适应 | 面捕端到端 <60ms；导入 5 个异源模型均可运行 |
| **P3 增强（可选）** | 4 周 | viseme 级口型；程序化肢体动画生成；多模型/换装；VRM 双运行时 | — |

**总计**：MVP（P0+P1）约 7~8 周，可对外演示；完整双端（P0~P2）约 13~14 周。以上为 1 名全栈 + 1 名前端/图形的人力估算。

> 注：不含 Live2D 出版许可审批周期（若走路径 B，需额外预留 2~6 周，且存在被驳回可能）。

---

## 10. 量化验收标准

| 指标 | 目标值 |
|---|---|
| 渲染帧率 | Windows ≥60fps / Android 中端 ≥30fps |
| 口型端到端延迟 | <50ms |
| 面捕端到端延迟 | <60ms |
| 音画同步偏差 | <80ms（主观不可察觉） |
| 冷启动到首帧 | Windows <2.5s / Android <4s |
| 常驻内存 | Windows <500MB |
| 模型兼容 | 官方样例 + 3 个不同作者的 Cubism 3/4/5 模型 100% 可加载 |
| 长时间稳定性 | 连续运行 2 小时无内存增长（<5%） |

---

## 11. 待确认事项

以下五点会显著改变方案细节，建议先定：

1. **DSH 宿主的技术栈与插件机制是什么？** 若宿主是 Electron/Web，走 §5.3 的 iframe 契约；若是原生或其他，接口层需重设计。
2. **是否商用发布？是否开放用户导入自有模型？** 这直接决定走 §7 的路径 A 还是 B——是所有事项里优先级最高的。
3. **首发平台**：先 Windows 单端验证（推荐），还是双端同步？后者会拉长约 4~6 周且分散精力。
4. **语音链路是否在范围内？** 本方案默认包含 TTS + 口型；若只需文字驱动，P1 可缩短约 1 周，但"不说话的角色"体验损失很大。
5. **模型来源**：已有美术资源与绑定能力，还是依赖外部采购/官方样例？这决定 §4.6 的通用性投入要下多重。

---

## 附：参考资料

- Live2D Cubism SDK 各版本比较 / 平台支持 — https://docs.live2d.com/zh-CHS/cubism-sdk-manual/cubismsdk-compare/
- Live2D SDK 发行许可与豁免条件 — https://help.live2d.com/zh-CHS/sdk/sdk_001/
- Live2D Proprietary Software License Agreement（2.2 豁免条款 / 6.3 可扩展性 APP）— https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html
- 官方口型同步教程（WAV RMS 方案）— https://docs.live2d.com/zh-CHS/cubism-sdk-tutorials/native-lipsync-from-wav-web
- pixi-live2d-display（Cubism 5 / PixiJS v8 分支）— https://github.com/naari3/pixi-live2d-display
- live2d-py（Python 原生绑定，桌面备选方案）— https://github.com/YLTai/live2d-py
- Open-LLM-VTuber（Web 路线参考架构，MIT）— https://github.com/Open-LLM-VTuber/Open-LLM-VTuber
- my-neuro（情绪标签 → 动作/表情映射参考）— https://github.com/morettt/my-neuro
- VTube Studio Public API（接口设计参考）— https://github.com/DenchiSoft/VTubeStudio
- MediaPipe FaceLandmarker（478 点 + 52 blendshapes）— https://developers.google.com/mediapipe/solutions/vision/face_landmarker
