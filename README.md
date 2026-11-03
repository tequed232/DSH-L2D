
# DSH-L2D

<p align="center">
  <img src="docs/assets/icon.png" alt="DSH-L2D" width="144" />
</p>

<p align="center">
  <strong>面向 DeepSeek Harness 的具身 Live2D 角色插件</strong><br />
  将工作区活动、Agent 指令与模型能力映射为可仲裁、可追踪的角色动作。
</p>

DSH-L2D 是一个由 DSH 插件宿主、Live2D 渲染器、动作编排核心和 MCP 工具接口组成的角色运行时。它不只是把模型贴在窗口上：Agent 发出语义动作后，系统根据模型能力画像、动作优先级、参数所有权和 Cubism 更新阶段，将意图安全地转换成模型参数写入。

> **当前实现边界：** 仓库包含 DSH 插件路径、Cubism 渲染包、动作/参数仲裁核心、MCP Server、工作区状态桥和实验性呈现模块。不同模块成熟度不同；本文区分已存在的代码、已验证的宿主路径和仍需完成的工作，不把设计文档等同于已交付功能。

## 目录

- [项目目标](#项目目标)
- [能力与实现状态](#能力与实现状态)
- [系统架构](#系统架构)
- [核心组件](#核心组件)
- [动作执行模型](#动作执行模型)
- [DSH 集成与工作区 Agent](#dsh-集成与工作区-agent)
- [MCP 工具接口](#mcp-工具接口)
- [模型与 Cubism 资源](#模型与-cubism-资源)
- [开发环境与构建](#开发环境与构建)
- [本地验收](#本地验收)
- [安全与隐私边界](#安全与隐私边界)
- [目录结构](#目录结构)
- [路线图与已知限制](#路线图与已知限制)
- [设计文档](#设计文档)
- [许可](#许可)

## 项目目标

- **具身表达**：让角色用表情、视线、头部、躯干和四肢动作表达对话与工作状态。
- **模型无关的语义控制**：Agent 描述“看向用户”“害羞地收回手”等意图，不直接生成逐帧 Cubism 参数。
- **确定性动作执行**：本地编译轨迹、处理优先级与参数所有权，避免多个控制源互相覆盖。
- **宿主上下文联动**：将 DSH 工作区和 Session 活动状态整理为有限、脱敏的行为上下文。
- **可扩展工具边界**：通过插件 HTTP 桥和 MCP Server，让 Agent 使用受约束的动作工具。

## 能力与实现状态

| 能力 | 当前仓库情况 | 边界 / 注意事项 |
|---|---|---|
| DSH 插件宿主集成 | 有 Node 插件入口 packages/dsh-l2d-plugin/lib/index.js；有 Web 客户端入口 lib/client.js | shell.overlay slot 有审计记录；pane keyed tab 等其他呈现目标不能据此视为已完成 |
| Live2D 渲染 | packages/renderer 含 Cubism Framework、模型加载、WebGL 渲染与更新调度代码 | Cubism Core 与模型资源需用户自行提供；结果依赖本机资源和宿主环境 |
| 参数仲裁 | packages/core/src/mixer.ts 提供 ParamMixer | 与真实 Cubism 帧循环的最终接线需按当前代码和验收记录核对 |
| 动作链与优先级 | 有 ActGate、动作链归一化、阶段模板和成对动作状态管理 | 不同动作源的端到端打断/释放仍以集成测试和真机验收为准 |
| 模型能力画像 | 有 ModelMotionProfile、能力扫描工具及 W3 Registry | 画像只描述已扫描/声明的能力；未知能力不能推断为支持 |
| 参数所有权 | 有 ParamOwnership、参数守卫、写入阶段与所有权测试 | Hip* 等物理输入参数涉及 PhysicsGate 与帧序，不能按普通 post 写入处理 |
| 情境与情绪路由 | 有 context analyzer、emotion router、persona、workspace snapshot 等模块 | 规则和路由已存在不等于所有情绪动作链都达到最终表现质量 |
| 工作区 Agent | 有 Workspace Agent bridge 与状态快照 | 快照按当前实现做脱敏；不等同于读取其他工作区完整聊天内容 |
| MCP Server | packages/dsh-l2d-mcp 提供 stdio MCP 工具 | 通过本机回环 HTTP 桥调用插件；不应将服务暴露到公网 |
| 呈现自适应 | 有 presentation 类型、布局计算、可见性与过渡引擎 | 当前属于独立模块；与所有 Host 容器的生命周期接线仍需逐项验收 |
| Android / 独立移动端 | 当前主线是 DSH 插件与桌面/网页宿主集成 | 不应把 Android 原生 App 描述为当前已交付能力 |

## 系统架构

~~~text
┌──────────────────────────── DSH Host ─────────────────────────────┐
│  Plugin Host (Node)                  Client UI (Web)                │
│  ┌──────────────────────┐            ┌──────────────────────────┐  │
│  │ lib/index.js          │            │ lib/client.js            │  │
│  │ lifecycle / config    │            │ slots.inject/register    │  │
│  │ local web server      │            │ shell.overlay host       │  │
│  │ workspace bridge      │            └────────────┬─────────────┘  │
│  │ pet window bridge     │                         │ iframe         │
│  └──────────┬───────────┘                         ▼                │
│             │ HTTP / IPC                  ┌──────────────────────┐ │
│             └─────────────────────────────► Renderer (Cubism)    │ │
│                                            └──────────┬───────────┘ │
└───────────────────────────────────────────────────────┼────────────┘
                                                        │
                 ┌──────────────────────────────────────▼────────────┐
                 │ packages/core                                     │
                 │ semantic intent → profile → trajectory → writes   │
                 │ ownership / priority → Cubism parameter injection│
                 └───────────────────────────────────────────────────┘

       Agent / DSH MCP Client
                  │ stdio JSON-RPC
                  ▼
       packages/dsh-l2d-mcp
                  │ loopback HTTP
                  ▼
       POST /dsh-l2d/ai/call → Plugin Host → Renderer
~~~

架构分工：

1. **Host 层**负责 DSH 生命周期、配置、宿主事件、工作区桥、资源服务和桌面窗口通道。
2. **Renderer 层**负责 Cubism 模型、WebGL、更新调度、模型参数读写与画面输出。
3. **Core 层**负责模型无关的语义契约、动作轨迹、能力解析、参数混合和动作仲裁。
4. **MCP 层**负责把 Agent 可调用工具映射到本机插件桥，不负责自行决定动作优先级。
5. **Presentation 层**负责容器尺寸、展示比例、可见性和过渡，不应拥有动作状态或创建第二个权威 Avatar Runtime。

## 核心组件

### packages/core — 动作与参数核心

| 文件 | 职责 |
|---|---|
| mixer.ts | ParamMixer：通道优先级、override/add 混合、硬锁、数值范围与平滑 |
| action-chain.ts | ActGate：BACKGROUND / NORMAL / FORCE 优先级、打断判定、动作阶段模板 |
| chain-normalize.ts | 将外部动作链输入规范化为可执行结构 |
| motion-contract.ts | 模型能力、语义控制、动作适配器与轨迹契约 |
| motion-profile.ts | 校验模型画像、解析语义控制、选择可用 Adapter |
| motion-intent.ts | 将语义帧降低为受约束的 WriteIntent，并校验通道绑定 |
| motion-trajectory.ts | 轨迹校验、编译、缓存和采样 |
| semantic-binding.ts | 语义姿态到模型控制项的绑定 |
| posture.ts | 姿态输入规范化、执行计划与回执结构 |
| ambient.ts / angle-mix.ts | 待机微动作与角度多源混合 |

**关键原则：** LLM 输出语义意图或动作计划；轨迹采样和参数写入由本地确定性代码完成。所有写入都必须经过能力检查、参数守卫和对应的仲裁路径，不能由 Agent 直接访问 Cubism 内部对象。

### packages/renderer — Cubism 渲染运行时

- src/app/lappmodel.ts：模型资源加载、Cubism 模型初始化、更新阶段与模型更新入口。
- src/app/lappdelegate.ts / lappview.ts：渲染应用和视图生命周期。
- src/app/motion-director.ts：成对动作（如手臂打开/关闭）的幂等状态与参数冲突检查。
- src/app/param-injector.ts：受控参数注入与 pre/post 阶段写入。
- src/app/param-ownership.ts：物理输出参数的临时独占、到期与释放。
- src/app/pose-controller.ts：姿态控制。
- src/app/emotion-router.ts：情绪和输入信号到表现动作的路由。
- src/fw/motion/cubismupdatescheduler.ts：Cubism 更新阶段调度。
- src/presentation/：布局计算、可见性、自适应与过渡模块。

Cubism 的执行顺序是动作正确性的组成部分。物理输入通常需要在 Physics 前写入（pre），受物理/姿势更新影响的参数通常需要在相应阶段之后写入（post）。不能只按“哪个动作优先级更高”来决定写入时机。

### packages/dsh-l2d-plugin — DSH 插件

- lib/index.js：宿主侧插件入口；注册配置、服务路由、注入资源、工作区桥及桌面窗口。
- lib/client.js：DSH Web 客户端模块入口，声明 slots 注入依赖，并在 shell.overlay slot 可用后注册 iframe 容器。
- lib/overlay.js：浏览器侧角色交互、AI 调用桥、动作和状态控制的大型集成模块。
- lib/workspace-agent.mjs：创建/复用专属 Live2D Workspace/Session，并推送受限状态上下文。
- lib/workspace-snapshot.mjs / session-events.mjs / session-log.mjs：工作区快照、Session 事件与状态摘要。
- lib/context-analyzer.mjs / persona.mjs：情境分析与角色设定。
- lib/pet-window.mjs：桌面 Electron 独立窗口；不可用时应保留页内浮层降级路径。
- lib/host-guard.mjs / param-guards.mjs：调用校验、模型索引缓存与参数守卫。

### packages/dsh-l2d-mcp — Agent 工具服务

独立 stdio MCP Server，负责工具 schema、参数验证、动作序列和回执整理。它通过插件本机 HTTP 接口转发，不直接操作模型参数。工具集合会随版本变化；实际暴露列表以当前 Server 的 tools/list 为准。

### tools — 开发与验收工具

- tools/acceptance/：连接运行中的插件服务，检查渲染状态、帧率、动作链、设置页、能力画像和 MCP 冒烟。
- tools/capability-scan/：扫描模型参数/物理输出并生成能力画像。
- tools/w3-registry/：构建与校验动作能力注册表。
- tools/act-choreo/：动作编排相关开发工具。
- tools/renderer-contract/、tools/ownership-spec/：渲染契约与参数所有权规格检查。
- tools/dev-server/：本地开发/调试服务。
- tools/vts-adapter/：VTube Studio 模型包适配工具。

## 动作执行模型

~~~text
Agent / Persona / Workspace Context
                │
                ▼
        Semantic Behavior Intent
                │
                ▼
     Capability Profile / Adapter
                │
                ▼
       Motion Track / Trajectory
                │
                ▼
      WriteIntent (pre / post)
                │
                ▼
     Ownership + Priority Arbitration
                │
                ▼
       Cubism Parameter Injection
                │
                ▼
          Physics / Pose / Render
~~~

### 优先级与打断

- BACKGROUND：待机、环境微动作等低优先级行为。
- NORMAL：普通交互动作。
- FORCE：需要立即响应的高优先级行为。
- 低优先级动作不能打断高优先级动作；相同优先级按 ActGate 规则处理。
- 被打断的动作必须发出终态事件，并释放其持有的参数所有权。
- 对成对动作（打开/关闭）重复发起时应保持幂等；共用同一组骨骼参数的动作不能同时占用。

### 模型能力画像

能力画像是模型的“身体说明书”，不仅是参数名称清单。每项语义控制/资源能力应明确标记：

- supported：模型存在可验证的直接能力。
- approximate：只能通过近似参数或组合动作表达。
- unsupported：已确认模型不具备。
- unknown：尚未验证，不得假定支持。

模型切换后必须重新加载画像和适配器绑定。缺少手臂、腿部或视线能力时，行为计划应降级或跳过，不得伪造参数写入。

## DSH 集成与工作区 Agent

当前 DSH 宿主能力审计记录在 docs/Host-API-Audit.md。

已记录的客户端扩展点包括：

- shell.overlay：root 级 overlay slot，客户端入口可在 slot 声明就绪后注册。
- sidebar.right.pane.tab：右侧面板 keyed tab；仍需独立实现和验证。
- settings.section：设置面板分区，不是独立设置窗口。
- pet-window.mjs：桌面 Electron 独立窗通道。

当前客户端入口的实测记录主要证明 shell.overlay + iframe 的探针/角色容器可以工作。其他 slot 的生命周期、iframe 在容器间迁移，以及 Electron 独立 WebContents 的状态同步，必须分别验证。

Workspace Agent 的当前设计是在 DSH 中创建或复用专属 Live2D Workspace/Session，以状态快照和队列消息驱动角色。快照应遵循最小化原则，不将其他工作区的完整聊天内容、文件路径或敏感错误详情默认复制到角色上下文。

## MCP 工具接口

MCP Server 位于 packages/dsh-l2d-mcp，以 stdio JSON-RPC 方式运行，并通过插件本机 HTTP 桥转发调用。

配置与部署细节见 [packages/dsh-l2d-mcp/README.md](packages/dsh-l2d-mcp/README.md)。插件服务地址可通过 DSH_L2D_URL 指定；未指定时 Server 会按自身实现查找本机服务信息。默认只允许回环地址，避免将角色控制接口暴露给局域网或公网。

动作工具的受理回执不等于动作已经播放完成。对需要确认完成状态的调用，应读取对应回执和 action-done 事件；常见终态包括 completed / interrupted / pending，具体字段以当前工具 schema 为准。

## 模型与 Cubism 资源

本仓库不分发用户模型文件，也不包含 Live2D Cubism Core 二进制。

1. 从 [Live2D 官方 SDK 页面](https://www.live2d.com/sdk/download/web/) 获取适用于本机的 Cubism SDK for Web。
2. 按项目配置提供 live2dcubismcore.min.js，并设置 DSH_L2D_CORE 或使用插件当前默认路径。
3. 将已获授权的模型放在本地模型目录，并通过 DSH_L2D_MODEL_DIR 指定目录。
4. 运行时模型索引、参数扫描和能力画像应与当前模型版本一致。

模型作者、建模者及授权范围以具体模型随附的许可/授权文件为准。不要把模型、纹理、动作文件或 Cubism Core 提交到仓库、发布包或第三方 CDN，除非许可证明确允许。

## 开发环境与构建

### 环境要求

- Node.js 22 或更高版本
- pnpm 12.5.1（仓库 packageManager 声明）
- Windows 桌面 DSH 环境用于验证 Electron 独立窗口
- 本地提供模型目录与 Cubism Core（按上节说明）

### 安装依赖

~~~bash
git clone https://github.com/tequed232/DSH-L2D.git
cd DSH-L2D
pnpm install
~~~

### 常用命令

| 命令 | 用途 |
|---|---|
| pnpm build:renderer | 构建 Cubism renderer，输出到 packages/dsh-l2d-plugin/assets/renderer.js |
| pnpm test:core | 运行仓库聚合的核心、插件、MCP、所有权与契约测试 |
| pnpm test:types | 运行类型 smoke 检查 |
| pnpm test:contract | 检查 renderer 契约 |
| pnpm scan:capability | 执行模型能力扫描 |
| pnpm gen:ai-tools | 生成 Agent function-calling 工具定义 |
| pnpm dev:server | 启动本地调试服务 |
| pnpm accept -- --read-only | 对已运行的插件服务执行只读验收 |
| pnpm accept | 完整验收；其中部分用例会向角色发送动作 |

pnpm build / pnpm dev 是旧的 apps/stage-web 调试壳入口，不等同于 DSH 插件或 Cubism renderer 的构建命令。

## 本地验收

先构建 renderer：

~~~bash
pnpm build:renderer
~~~

如需使用独立调试服务：

~~~bash
pnpm dev:server
~~~

然后打开调试服务输出的本地地址。验收脚本可通过 --origin 指向正在运行的 DSH 插件服务：

~~~bash
pnpm accept -- --origin http://127.0.0.1:<port> --read-only
~~~

只读模式不会执行会驱动角色动作的测试，也会跳过能力画像重扫等写操作。完整验收中的部分动作测试会实际控制角色；不要在多人共用或正在被 Agent 操作的实例上并发运行。

测试与验收报告应区分纯函数/单元测试、构建与静态检查、连接真实 DSH 实例的集成验收，以及需要真实模型、GPU、Electron 或人工观察的真机验收。

## 安全与隐私边界

- 本机 HTTP 控制桥应仅绑定 loopback；不要通过反向代理或端口映射公开。
- DeepSeek API Key 仅在启用余额查询等明确功能时使用，不应写入日志、提交到仓库或放入模型提示词。
- 系统硬件监听、媒体监听、前台进程名采集等传感器默认关闭或由用户显式开启；启用前应阅读设置说明。
- Workspace 快照只传递角色行为所需的最小状态，不应默认复制其他工作区的聊天正文、文件路径或凭据。
- 插件入口错误不能拖垮宿主 UI；客户端 slot 注册回调应隔离异常并记录诊断信息。
- 模型与 Cubism Core 的使用和再分发必须遵守各自许可。

## 目录结构

~~~text
apps/
  stage-web/                 # 早期 Vue 调试壳
packages/
  core/                      # 语义契约、动作轨迹、仲裁和姿态
  renderer/                  # Cubism Framework、模型与 WebGL 渲染
  dsh-l2d-plugin/             # DSH Host 插件、客户端入口、overlay 与窗口
  dsh-l2d-mcp/                # stdio MCP Server
tools/
  acceptance/                # 运行时验收
  capability-scan/            # 模型能力扫描
  w3-registry/                # 动作能力注册表
  ownership-spec/             # 参数所有权规格
  renderer-contract/          # 渲染契约
  dev-server/                 # 本地调试服务
  vts-adapter/                # VTube Studio 包适配
docs/                         # 架构、行为、宿主审计与开发文档
~~~

## 路线图与已知限制

### 当前优先方向

1. **统一 Runtime 生命周期**：拆清插件注册、renderer 准备、模型加载、Runtime 激活和隐藏/降频状态；启动注册不得等待重型模型初始化。
2. **完成 Host 呈现适配**：先把已验证的 shell.overlay 做稳，再实现 sidebar keyed tab；桌面 pet window 明确独立 WebContents 边界与状态同步方式。
3. **打通动作端到端链路**：从 Agent 语义意图、模型能力画像、动作轨迹、所有权仲裁，到 Cubism 帧循环，建立可观测的单一写入路径。
4. **完善多模型能力注册**：扫描、校验、版本化画像和适配器，未知能力一律安全降级。
5. **性能与资源治理**：纹理降档、GPU/CPU 预算、隐藏状态降频、资源释放与重复初始化保护。
6. **回归与真机验收**：覆盖模型切换、动作打断、容器切换、异常卸载、窗口关闭和长时间运行。

### 已知限制

- 当前 README 与部分历史文档曾按早期独立舞台应用描述；主线已经包含 DSH 插件实现，旧文档中的完成度和验证结果可能早于当前代码。
- Host API 审计包含实机实验记录，但不同 slot、浏览器 profile 和 Electron 窗口路径的验证范围不同。
- 自适应呈现模块的类型目前仍含 uiScale 输入；Host 审计指出没有公开 UI scale 事件，实际接线应以 ResizeObserver 测得的 CSS 容器尺寸为准，不能依赖未公开事件。
- packages/dsh-l2d-plugin/lib/index.js 与 lib/overlay.js 仍承担较多集成职责；后续应逐步拆分服务生命周期、资源路由、行为编排和呈现适配，但要避免重复创建 Runtime。
- 自动化验收脚本有会实际驱动动作的测试；运行前必须确认实例空闲并选择合适模式。

## 设计文档

- [DSH-L2D 交接任务书](docs/DSH-L2D-交接任务书.md)
- [技术方案 v0.1](docs/DSH-L2D-技术方案-v0.1.md)
- [技术栈方案 v0.2](docs/DSH-L2D-技术栈方案-v0.2.md)
- [行为系统设计 v0.1](docs/DSH-L2D-行为系统设计-v0.1.md)
- [具身行为契约](docs/Embodied-Behavior.md)
- [多模型 Motion Engine](docs/Motion-Engine-多模型架构.md)
- [Motion Engine AIRI 实现指南](docs/MOTION_ENGINE_AIRI_IMPLEMENTATION_GUIDE.md)
- [模型能力注册表](docs/W3-Motion-Capability-Registry.md)
- [DSH Host API 审计](docs/Host-API-Audit.md)
- [参数所有权不变量](docs/Ownership-Invariants.md)
- [参数读写对照](docs/参数读写对照.md)
- [动作链编排](docs/动作链编排-v1.md)
- [性能与多核方案](docs/性能与多核方案.md)

## 许可

本仓库根目录采用 MIT License。第三方 SDK、模型、纹理、动作资源和其他素材可能适用独立许可；根目录 MIT 不会覆盖这些内容。使用前请分别核对其许可证与授权范围。
