# DSH-L2D 技术栈方案 v0.2

> 基于对 `DeepSeek免费公皮`（大肥鱼 / DeepSeek-chan）模型包的实测，以及 GitHub 同类项目的横评。
> 前置文档：`DSH-L2D-技术方案-v0.1.md`（总体架构与合规框架）。本文聚焦「技术栈怎么搭、哪些轮子不用造」。
> 日期：2026-11-01。

---

## 0. 三个必须先说清楚的结论

**① 你的判断需要修正一处。** 该模型包的授权是「允许二次创作」，不等于「允许商用」。原文明确：**禁止擅自重新分发模型文件**（不得上传网盘/素材站供他人下载）、**禁止二次销售**；且「将模型作为付费商品、付费素材或其他商业产品的一部分提供」需事先联系作者确认。

这不影响你做二创（改模型、做表情包、用 PSD 练 Live2D、自制衍生模型都被允许），但**直接影响架构**：这份模型**不能打进安装包、不能进 Git 仓库、不能随产品分发**。正确做法是「模型外置 + 用户自行导入」（BYOM，Bring Your Own Model）——这本来就是 VTube Studio 的形态，技术上更干净，法律上也安全。

**② 这个包不是标准 Cubism 包，是 VTube Studio 包。** 它的情感/动作引用关系记录在 `.vtube.json` 的 Hotkeys 里，而 `model3.json` 里 **`Motions` 和 `Expressions` 都是空的**。任何非 VTS 的渲染器直接加载，结果会是「模型能显示，但一个表情、一个动作都没有」。这是整个项目第一个必须解决的工程障碍，不是配置问题。

**③ 这个模型的纹理规格会直接卡死 Android。** 5 张图集合计 **592 MB 显存**，其中一张是 **8192×8192**。手机端必须做纹理降采样管线，否则无法上线。

---

## 1. 模型包实测报告

用 `tools/vts-adapter` 实测（该工具已随本方案交付，可直接复跑）。

### 1.1 基础规格

| 项 | 实测值 | 影响 |
|---|---|---|
| 模型格式 | Cubism **5**（moc3 版本号 5） | 必须用 Cubism 5 Core，Cubism 4 核心无法加载 |
| `model3.json` | 550 字节，**无 Motions / Expressions** | 标准渲染器加载后「无表情无动作」 |
| `moc3` 体积 | 16 MB | 正常，但加载耗时需做进度反馈 |
| 参数总数 | **509** 个 | 参数极多，说明绑定精细；也意味着内存与遍历成本 |
| 纹理 | 5 张，合计 **592 MB 显存** | 移动端不可行，需降档 |
| 物理 | `physics3.json` 213 KB | 头发/裙摆依赖它，必须启用 |
| Cdi3 | 53 KB，509 参数 + Parts | 可作参数白名单来源 |

### 1.2 纹理明细（关键风险）

| 文件 | 尺寸 | 显存(RGBA) | 磁盘 | 风险 |
|---|---|---|---|---|
| texture_00.png | 4096×8192 | 128 MB | 10.0 MB | 超 4096 上限 |
| texture_01.png | 4096×8192 | 128 MB | 12.6 MB | 超 4096 上限 |
| texture_02.png | 2048×2048 | 16 MB | 2.2 MB | 安全 |
| texture_03.png | 8192×8192 | **256 MB** | 17.8 MB | **可能超设备 MAX_TEXTURE_SIZE** |
| texture_04.png | 4096×4096 | 64 MB | 1.1 MB | 边界 |

- 桌面端：单张 8192² 在主流独显/核显上可加载，但 592 MB 显存对笔记本核显偏重。
- 移动端：大量 Android 设备的 `MAX_TEXTURE_SIZE` 为 4096 或 8192，**8192×8192 极可能直接创建失败**（表现为模型不显示或白屏）。
- 结论：**必须有构建期纹理管线**——按目标平台生成 1024 / 2048 两档图集，改写 `model3.json` 的 Textures 指向。Live2D 的 UV 是归一化的，等比例缩放图集不会破坏映射，这是可行且低风险的做法。

### 1.3 表情与动作（21 + 7）

| 类别 | 数量 | 说明 |
|---|---|---|
| 表情 `.exp3.json` | **21** | 兔牙、脸红、流泪、流冷汗、黑脸、爱心眼、圈圈眼、屑屑眼、＞＜、钢盆、单片眼镜、黑框眼镜、脱鞋、尾巴开关、胸口衣服、裙长切换、前倾、加载、体型 1/2/默认 |
| 动作 `.motion3.json` | **7** | 6 组「开/关」成对动作（抚胸手、竖手指、狗尾巴草）+ 1 个 IDLE |
| 热键总数 | 28 | 21 ToggleExpression + 6 TriggerAnimation + 1 RemoveAll |

**重要**：这 6 组动作是「状态切换」而非「一次性表演」——`举手切默认手` / `默认手切举手` 成对存在，且 `Loop: true`。这意味着动作系统需要**状态机**语义（两态互斥），不能简单当成「播完就停」。直接把这套动作丢给「随机播放」逻辑会得到鬼畜效果。

### 1.4 参数绑定表（40 条，全部有效）

`.vtube.json` 的 `ParameterSettings` 是一张 **ARKit/blendshape 输入 → 模型参数** 的映射表，由建模师手工配置，**40 条全部能解析到真实参数**。这是本包最有价值的资产——等于面捕绑定表已经做好了一半。

抽查结果（注意这些非标准命名是**真实存在**的参数，不是笔误）：

| 跟踪输入 | 目标参数 | 备注 |
|---|---|---|
| FaceAngleX/Y/Z | `AngleX` / `AngleY` / `AngleZ` | **不是** `ParamAngleX`！两者都存在 |
| EyeOpenLeft / Right | `ParamEyeLOpen` / `ParamEyeROpen` | 标准命名 |
| EyeRightX / Y | `ParamEyeBallX` / `ParamEyeBallY` | 标准命名 |
| MouthOpen | `ParamMouthOpenY` | 口型同步目标 |
| MouthSmile | `EyeSmile` + `ParamMouthForm` + `MouthSmile_L/R` | **一对多扇出** |
| JawOpen | `JawOpen` | 自定义命名 |
| CheekPuff | `CheeckPuff` | 作者自定义拼写，需按实际参数名匹配 |
| Voice A/I/U/E/O | `ParamA` / `ParamI` / … | 元音级口型预留 |
| （无输入） | `ParamBreath` | 自动呼吸 |

**由此得出一个关键设计原则**：参数语义**不能靠标准命名猜测**，必须以模型自带的绑定表为权威来源。若按 `ParamAngleX` 这类标准名硬编码，这个模型的头部旋转会**完全不响应**（因为它用 `AngleX`）。这是「模型兼容性」从理论风险变成实测事实的例证。

---

## 2. 技术栈选型

### 2.1 结论

| 层 | 选型 | 理由 |
|---|---|---|
| 语言 | **TypeScript** | 双端复用、生态最全 |
| 框架 | **Vue 3 + Vite**（React 亦可） | 与 AIRI 同栈，可直接参照其 `stage-ui` 分层与状态管理；Vite 构建快；不用 Next.js（SSR 对桌面端无价值，只增加复杂度） |
| 渲染 | **PixiJS v8 + pixi-live2d-display** | Cubism 绑定是标准件，不自研 |
| Cubism 运行时 | **Cubism 5 Core**（`live2dcubismcore.min.js`） | 官方二进制，不可从 CDN 引用，需随包分发 |
| 状态管理 | Pinia | 轻量，够用 |
| 桌面壳 | **Electron** | 透明窗 + 点击穿透 + 置顶，Windows 上最成熟 |
| 移动壳 | **Capacitor** | 复用同一 Web 层；AIRI 的 `stage-pocket` 已验证此路径 |
| 通信 | **WebSocket**（本地）+ postMessage（插件） | 与 VTS 协议形态一致，便于生态迁移 |
| 面捕 | **MediaPipe FaceLandmarker**（52 blendshape） | 跨端一致、Apache-2.0、延迟低 |
| 口型 | 音频 RMS 包络 | 已有多项目验证，成本最低 |
| 构建 | pnpm workspaces + Turborepo | 多包（core / stage / shell）必需 |

### 2.2 明确不做的三件事

1. **不自研 Cubism 渲染绑定。** 网格变形、遮罩预处理、物理求值这些是 Live2D 官方 Core 的职责，重写等于重造 SDK。
2. **不用 Unity 做首发。** 插件形态无法满足（见 v0.1 §2）。
3. **不把 ASR/TTS 自己写。** 直接采用成熟引擎（见 §3 复用矩阵）。

---

## 3. GitHub 同类项目横评（AI 主播方向）

### 3.1 第一梯队：架构级参照

#### ① `moeru-ai/airi` — **首选架构蓝本**

| 项 | 内容 |
|---|---|
| 规模 | ~~4.9 万 stars，MIT |
| 定位 | 复刻 Neuro-sama 的开源 AI 虚拟主播 |
| 栈 | Vue 3 + TS + Vite + Pinia + UnoCSS；Electron（桌面）+ Capacitor（移动） |
| 模块 | `apps/stage-web` / `stage-tamagotchi`(Electron) / `stage-pocket`(Capacitor) + `packages/stage-ui`(共享) + `packages/server-runtime`(WebSocket) |
| 模型 | Live2D + VRM，PixiJS / Three.js |

**为什么值得抄**：它把「Web 舞台 + 桌面壳 + 移动壳 + 共享 UI 包」这套 monorepo 分层跑通了，正是 v0.1 里「双壳同核」的工业级实现。我们的目录结构可以直接对齐它的命名与分层，降低团队理解成本。

**不建议直接 fork 的原因**：它体量太大（游戏 Agent、Discord Bot、40+ LLM Provider 抽象），裁剪成本高于重写核心。**抄结构，不抄代码。**

#### ② `Open-LLM-VTuber` — **驱动链路参照**

| 项 | 内容 |
|---|---|
| 栈 | Python（FastAPI + WebSocket）+ Web 前端 Live2D |
| 亮点 | 情绪标签 → 表情/动作映射；`model_dict.json` 配置表情索引；TTS 与口型 20ms 分包；VAD 打断 |
| 协议 | `model_dict.json` + `characters/*.yaml` 的角色配置范式 |

**可直接借鉴**：音频按 20ms 切块算 RMS 的思路、`emotionMap` 的配置形态、「表情索引 vs 表情名」的取舍。它的前端就是 `pixi-live2d-display`，证明这条渲染路线可用。

#### ③ `Dingdang255/live2d-haxe` — **格式解析的直接印证**

它的 `L2DVTuberModel` 类做的事和我们的适配器**完全同构**：

> "VTube Studio models differ from standard Cubism models: expressions and motions are referenced from `.vtube.json` Hotkeys, NOT from `model3.json` FileReferences… Path resolution replicates VTube Studio's behavior: Hotkey File fields often contain only a bare filename, even when the actual file is in a subdirectory."

它扫描 `expressions/ expr/ motions/ motion/ animations/ animation/` 六个常见子目录来解析裸文件名——这正是我在 `tools/vts-adapter` 里实现的逻辑。

**价值**：证明这个坑是真实存在且被独立验证过的，我们不是过度设计。**语言是 Haxe，代码不能直接用，但算法可以参考。**

### 3.2 第二梯队：形态参照

| 项目 | 栈 | 可借鉴 |
|---|---|---|
| `tegnike/aituber-kit` | Next.js，VRM + Live2D(Cubism 3+) | YouTube 直播接入、多 TTS 引擎抽象；**注意其 v2.0 起为自定义许可证**，商用需逐条读 |
| `uezo/ChatdollKit` | Unity/C#，Apache-2.0 | **Tool Call 驱动表情与动画**的范式（LLM function calling → 动作） |
| `shinshin86/aituber-onair` | TS，MIT，npm 包化 | 把直播能力拆成可复用包（`@aituber-onair/core`）的粒度设计 |
| `morettt/my-neuro` | Electron + Live2D | `emotion_actions.json`：情绪 → 动作文件路径的映射配置 |
| `Rosa134/daidai-live2d-pet` | Electron + PixiJS | 桌宠落地细节：TTS + RMS 口型、随机动作抽样（避免模型动作名差异报错）、模型目录导入 |
| `oddmeta/charlotty` | Electron + PixiJS | 托盘、圆盘菜单、边缘吸附、**MCP 技能系统** |

### 3.3 复用矩阵

| 能力 | 做法 | 来源 |
|---|---|---|
| Cubism 渲染 | **直接用** pixi-live2d-display + Cubism 5 Core | 社区 |
| VTS 包解析 | **已自研**（`tools/vts-adapter`，230 行） | 本仓库 |
| 多端分层 | **抄结构** | airi |
| 口型同步 | **抄思路**（RMS 分包） | Open-LLM-VTuber / daidai |
| 情绪 → 动作映射 | **抄配置形态** | my-neuro / Open-LLM-VTuber |
| Tool Call 驱动 | **抄范式** | ChatdollKit |
| 透明窗/穿透/托盘 | **抄实现细节** | daidai / charlotty |
| 参数仲裁 ParamMixer | **必须自研**（无同类可直接复用） | — |
| 纹理降档管线 | **必须自研** | — |

**结论**：真正需要自研的只有两块——**参数仲裁器**和**纹理/资源管线**。其余都有成熟参照，这正是「避免重复造轮子」的落点。

---

## 4. 仓库结构

```
DSH-L2D/
├─ apps/
│  ├─ stage-web/            # 浏览器版（调试与插件内嵌用）
│  ├─ stage-desktop/        # Electron 壳（Windows）
│  └─ stage-pocket/         # Capacitor 壳（Android）
├─ packages/
│  ├─ core/                 # ★ 参数仲裁器 ParamMixer、通道、混合策略
│  ├─ context/              # ★ 情境感知：待机/问答/操作电脑/离席 判定（见行为系统设计）
│  ├─ behavior/             # ★ 行为调度：状态机、行为库、情绪惯性、节流
│  ├─ live2d/               # Cubism 封装、模型加载、动作/表情调度
│  ├─ vts-adapter/          # VTS 包解析（已有 POC，需 TS 化）
│  ├─ intent/               # LLM 意图协议、JSON Schema、校验、降级
│  ├─ sense/                # 面捕(MediaPipe)、麦克风 RMS、键鼠
│  └─ protocol/             # WebSocket 协议 + 类型定义（client/server 共用）
├─ tools/
│  ├─ vts-adapter/          # 现有 CLI 工具（Node，零依赖）
│  └─ texture-opt/          # 纹理降档：sharp 生成 1024/2048 档并改写 model3.json
├─ models/                  # ⚠ 不入库！仅放 .gitkeep 与 README
├─ docs/
└─ dist/                    # 生成的 capabilities / 报告
```

**`models/` 必须是 gitignore 的。** 模型由用户自行放入，这既是授权要求，也避免仓库膨胀（本包 187 MB）。

---

## 5. 已完成的验证：VTS 适配器

`tools/vts-adapter/index.mjs`（Node，零依赖，可直接运行）：

```bash
node tools/vts-adapter/index.mjs "DeepSeek免费公皮/DeepSeek" --out dist
```

实测输出：

```
【资源解析】
  热键总数        28
  表情 (exp3)     21
  动作组 (motion) 7  共 7 个文件
  未解析资源      0
【参数映射校验】0 / 40 条无效
【Groups 修复】
      ✓ LipSync 组为空 → 注入 ParamMouthOpenY
【纹理预算】合计 592 MB 显存
      8192x8192  256 MB  texture_03.png  ⚠ 超 4096
```

产出三份文件：

| 文件 | 用途 |
|---|---|
| `<模型>.dsl2d.model3.json` | 原位生成（不覆盖原文件），已挂回 21 表情 + 7 动作组，并补全 LipSync 组 |
| `dist/capabilities.json` | 能力清单：表情/动作组/语义参数绑定/纹理预算 → 供 LLM 工具定义与 UI 生成 |
| `dist/param-mapping.json` | 40 条映射的解析结果与来源标记（`vts` / `standard`） |

**这一步的意义**：把「这个模型能不能在我们自己的渲染器里跑起来」从假设变成了已验证的事实——能，而且表情动作全都在，只是引用关系需要重建。

---

## 6. 遗留问题（进入 P0 前必须处理）

| # | 问题 | 处理方式 |
|---|---|---|
| 1 | 动作是**状态切换对**（开/关），不是独立表演 | 动作用状态机建模，成对互斥；`Idle` 组独立调度 |
| 2 | 纹理 592 MB，8192² 超移动端上限 | `tools/texture-opt`：生成 2048（桌面）/1024（移动）档，改写 Textures 路径 |
| 3 | `AngleX` vs `ParamAngleX` 语义歧义 | 以 `.vtube.json` 绑定表为权威；`capabilities.json` 已带 `from` 字段标记来源 |
| 4 | `MouthSmile` 一对多扇出（4 个参数） | 通道映射数据结构改为 `string[]`，混合器支持扇出 |
| 5 | 表情名为中文且无语义标签 | 建立「角色动作词典」`mapping/expression-semantic.json`，人工/半自动标注情绪 |
| 6 | Cubism Core 二进制不可入库 | 首次构建脚本引导用户从官方 SDK 提取，加入 `.gitignore` |

---

## 7. P0 落地顺序（建议 2 周）

1. **D1–2**：仓库骨架 + pnpm workspace + Electron 空壳跑通透明窗
2. **D3–4**：Cubism 5 Core 接入，加载 `dsl2d.model3.json`，验证物理与渲染帧率
3. **D5–6**：`packages/core` ParamMixer v0.1（分层 + 权重 + 口型硬覆盖）
4. **D7–8**：口型（RMS）+ 眨眼 + 鼠标视线，跑通「说话」的最小闭环
5. **D9–10**：表情/动作调度器（含状态机建模）+ 键盘绑定
6. **D11–12**：`texture-opt` 纹理降档，验证 2048 档画质可接受
7. **D13–14**：LLM 意图协议 v0.1（JSON Schema + 校验），接入一家模型跑通「说一句话 + 一个表情」

验收：一条文本输入 → 模型开口说话 + 口型同步 + 至少 1 个表情 + 无穿模，稳定 60fps。

---

## 附：参考项目索引

| 项目 | 地址 | 许可证 |
|---|---|---|
| moeru-ai/airi | github.com/moeru-ai/airi | MIT |
| Open-LLM-VTuber | github.com/Open-LLM-VTuber/Open-LLM-VTuber | MIT |
| Dingdang255/live2d-haxe | github.com/Dingdang255/live2d-haxe | 见仓库 |
| tegnike/aituber-kit | github.com/tegnike/aituber-kit | 自定义（商用需读条款） |
| uezo/ChatdollKit | github.com/uezo/ChatdollKit | Apache-2.0 |
| shinshin86/aituber-onair | github.com/shinshin86/aituber-onair | MIT |
| morettt/my-neuro | github.com/morettt/my-neuro | 见仓库 |
| Rosa134/daidai-live2d-pet | github.com/Rosa134/daidai-live2d-pet | 见仓库 |
| oddmeta/charlotty | github.com/oddmeta/charlotty | 见仓库 |
| pixi-live2d-display | github.com/naari3/pixi-live2d-display | MIT |
| VTube Studio API | github.com/DenchiSoft/VTubeStudio | MIT |
