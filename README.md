<div align="center">

<img src="docs/assets/icon.png" width="144" alt="DSH-L2D mascot" />

# DSH-L2D

### Give your DSH workspace a little life.

**面向 DeepSeek Harness 的 Live2D 桌宠、具身行为运行时与 Agent 控制桥**

让 AI 不只通过文字回应，也能通过视线、表情、姿态和连续动作表达状态。

<p>
  <a href="https://github.com/tequed232/DSH-L2D"><img src="https://img.shields.io/badge/Platform-DeepSeek%20Harness-5865F2?style=for-the-badge" alt="Platform: DeepSeek Harness" /></a>
  <a href="https://github.com/tequed232/DSH-L2D"><img src="https://img.shields.io/badge/Renderer-Live2D%20Cubism-00A6A6?style=for-the-badge" alt="Renderer: Live2D Cubism" /></a>
  <a href="https://github.com/tequed232/DSH-L2D/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-MIT-2EA44F?style=for-the-badge" alt="MIT License" /></a>
</p>

<p>
  <a href="#-项目是什么">项目简介</a> ·
  <a href="#-能力与实现状态">能力状态</a> ·
  <a href="#-系统架构">架构</a> ·
  <a href="#-快速开始">快速开始</a> ·
  <a href="#-开发与验证">开发验证</a> ·
  <a href="docs/nodegraph/TUTORIAL.md">节点设计</a> ·
  <a href="#-文档索引">文档</a>
</p>

</div>

---

## 🐟 项目是什么

DSH-L2D 是运行在 **DeepSeek Harness（DSH）** 中的 Live2D 角色系统。它把 Live2D 渲染、模型无关的动作运行时、工作区上下文和 MCP Agent 工具连接起来，让角色能够对用户交互与 Agent 工作状态作出可观察的反馈。

项目关注的不只是“播放一个动作”，而是建立一条可检查、可仲裁、可追踪的执行链：

**工作区状态 / 用户意图 → 语义行为 → 模型能力解析 → 动作队列与轨迹 → 参数所有权仲裁 → Cubism 渲染。**

Agent 描述“看向用户”“进入思考状态”或“一段连续动作”等语义目标；本地运行时负责能力检查、动作调度和参数写入。Agent 不应直接绕过运行时操纵每一帧的 Cubism 参数。

> **状态口径：** 本仓库同时包含已实现代码、局部接线、实验性模块和后续架构计划。单元测试通过不等于真实 DSH 宿主、所有模型或所有展示容器均已验收。本文会把实现状态与验证状态分开说明。

## ✨ 能力与实现状态

<table>
<tr>
<td width="50%" valign="top">

### 🎭 Live2D 角色呈现
- Live2D Cubism / WebGL 渲染器
- 表情、动作组、姿态与视线控制
- 呼吸、眨眼和待机微动作
- 角色拖拽及展示层交互
- DSH 页面 Overlay 接入路径

</td>
<td width="50%" valign="top">

### 🧠 具身行为与动作编排
- 语义动作意图与 Cue 行为循环
- BACKGROUND / NORMAL / FORCE 优先级
- FIFO 动作队列与连续动作链
- 动作时长声明、回执与中断语义
- 模型能力画像与参数适配基础

</td>
</tr>
<tr>
<td width="50%" valign="top">

### 🔌 Agent 与 MCP Bridge
- stdio MCP Server 与本机插件桥接
- Live2D 专属 Workspace / Session 接入
- 工作区状态快照与状态报告
- 动作 enqueue / status / cancel 桥接能力
- 工具按运行时注册结果暴露

</td>
<td width="50%" valign="top">

### 🗃️ 动作知识库与模型注册
- SQLite 模型、参数和动作注册表
- Actions Lib 与 G0–G4 入库校验
- GIF 帧提取与动作时序分析
- Model Adapter 与参数边界校验
- 人工审核闸门和执行记录

</td>
</tr>
</table>

### 当前实现状态

| 子系统 | 状态 | 当前边界 |
|---|---|---|
| Live2D Renderer | **已实现，持续回归** | 模型加载、渲染、参数注入和更新调度已有实现；具体模型仍需独立验收 |
| ParamInjector / 参数仲裁 | **已实现，持续完善** | 统一写入路径、托管参数策略和所有权约束；未知或未托管参数不能被默认放行 |
| 动作链与 FIFO 调度 | **已实现** | 支持最多 15 个输入段；相邻兼容段可合批，每个 Renderer 批次最多 8 步 |
| Actions Lib / SQLite | **已实现，持续扩展** | 有动作链仓储、版本和校验管线；动作入库通过不代表已获真实模型运行时验证或人工批准 |
| MCP Server | **已实现** | stdio 服务通过本机回环接口连接插件；可用工具以当前运行时 tools/list 为准 |
| MCP Bridge / Workspace | **已接入，持续验收** | 已有 WorkspaceManager、StatusReporter、动作队列和工具注册接线；当前本地 Agent Client 是降级实现，不应描述为已接通真实 A2A 后端 |
| Overlay 展示 | **已有实现** | 页面悬浮层是当前主要接入路径；其他容器需要按 Host API 和实际宿主逐项验收 |
| Sidebar / 独立桌宠窗口 | **部分实现 / 待验收** | 有扩展点或窗口通道设计；不能据此推断所有容器已完成无缝切换 |
| 自动肢体分配 / 多肢协调 | **规划与前置验证中** | M1 语义 Cue 路径不等于自动肢体分配完成；需先完成参数域证据和真实模型 acquire/release 验证 |
| Workspace 双视图 UI | **实验性** | Whale Workspace 有双视图和会话连续性实现；当前 InMemoryConversationService 是 mock，不是生产 AI 后端 |
| One-shot 动作编译器（OACA） | **已实现，静态层已验证** | 编译期四层校验（L1–L3 已验，L4 为静态编译验证）→ 一次性发布到 SQLite 注册表（v14）；运行期确定性路由 + 派发前置闸门，`action-router` 无任何 LLM/网络 import（静态断言）；真机渲染 E2E 尚未取证 |
| 触发层 / trigger_map | **已实现（查表层）** | `emote(emotion, intensity) → programId` 确定性查表；区间重叠写入即拒；命中后 fail-closed 校验程序仍 published；未命中返回 `no_match`，绝不回退实时规划 |
| 运行时参数槽 | **解析器已实现，待接线** | `$slot` 解引用 + min/max 钳制 + 缺省 default；槽只负责取值，仍过参数所有权与能力检查；接线需编译器先生成槽语法 |

### 最近的工程进展

以下是近期代码与验证方向的摘要，详细实现以提交和专项文档为准：

- **动作链可靠性：** FIFO 队列对短暂的 conflict / priority-blocked 进行有限重试；已受理但仍为 pending 的动作不会被重复提交。动作链输入上限提升到 15 段，并对相邻兼容段进行合批。
- **动作时长契约：** Actions Lib 的每个 motion step 必须声明 duration_ms，链级总时长会汇总持久化。
- **MCP Bridge：** 插件宿主挂载 WorkspaceManager、Live2DMCPBridge 和 StatusReporter；工具在 Bridge 初始化就绪后注册，避免未就绪时伪报工具可用。
- **模型与参数写入：** Renderer 修复了 Angle 短名托管白名单和 AngleZ 总线限幅问题，并补充目标动作的有界预载等待。
- **动作知识库：** SQLite 注册表、GIF 时序分析、Model Adapter、审核流程和 E2E 管线已建立；validated、runtime_verified 与人工 approved 是不同状态，不能互相替代。
- **One-shot 动作编译（OACA）：** 架构收敛为「导入期一次 LLM 编程 + 运行期零 LLM」。编译产物经 schema/能力/安全/静态编译四层校验后原子发布到注册表（每模型仅一条 published，不可变版本 + stale 标记）；`/api/actions/dispatch` 同步执行并返回真实终态（busy 409 / 超时 504 / 失败 502），`requestId` 以 `bridge_actions` 主键做跨重启幂等；运行期指标可证（`runtimeLlmCallCount` 增量 0）。QA 独立验收 PASS_WITH_WARNINGS，唯一缺口是真机渲染 E2E。
- **触发层：** `trigger_map`（v14）让 `l2d_emote` 等语义入口退化为确定性查表——运行期可"选择"程序，不能"生成/修改"程序；程序变更（参数/触发器/图）会使旧验证结论自动失效（`program_hash`）。

相关追踪：[PR #27 · FIFO 动作链](https://github.com/tequed232/DSH-L2D/pull/27) · [PR #26 · MCP Bridge](https://github.com/tequed232/DSH-L2D/pull/26) · [PR #25 · 动作知识库](https://github.com/tequed232/DSH-L2D/pull/25) · [PR #19 · M1 行为循环](https://github.com/tequed232/DSH-L2D/pull/19)

## 🏗️ 系统架构

~~~mermaid
flowchart TB
    A["DSH Workspace / Agent"] --> B["Workspace Context & Persona"]
    B --> C["Semantic Behavior Intent"]
    C --> D["Capability Profile / Model Adapter"]
    D --> E["Action Queue / Motion Track"]
    E --> F["WriteIntent"]
    F --> G["Ownership & Priority Arbitration"]
    G --> H["ParamInjector"]
    H --> I["Cubism / Physics / WebGL Renderer"]

    J["MCP Client"] --> K["stdio MCP Server"]
    K --> L["Loopback HTTP / Host Bridge"]
    L --> C
    L --> M["Workspace / Session / Status"]

    N["DSH Plugin Host"] --> O["Presentation Adapter"]
    O --> I

    P["SQLite Registry / Actions Lib"] --> D
    P --> E

    subgraph OACA["One-shot 编译（导入期一次，运行期零 LLM）"]
        X["LLM Compiler"] --> Y["4 层校验 L1-L4"]
        Y --> P
        Y --> Z["Node Graph 产物"]
        Z --> E
    end
    T["trigger_map 查表"] --> E
~~~

> 上图是模块关系示意。不同入口和容器的接线状态并不相同；图示不代表所有宿主扩展点均已完成端到端验收。

### 模块职责

| 模块 | 路径 | 职责 |
|---|---|---|
| Core | packages/core | 语义动作、轨迹、优先级和模型无关的行为逻辑 |
| Renderer | packages/renderer | Cubism 模型生命周期、WebGL、帧调度与参数注入 |
| DSH Plugin | packages/dsh-l2d-plugin | 插件生命周期、Overlay、宿主服务和客户端接入 |
| MCP Server | packages/dsh-l2d-mcp | stdio MCP 工具、参数校验和本机调用转发 |
| MCP Bridge | packages/mcp-bridge | Workspace、状态报告、动作队列和宿主侧工具注册 |
| Database | packages/dsh-l2d-db | SQLite Schema、模型注册、Actions Lib 和审核数据 |
| Tools | tools/ | 能力扫描、GIF 分析、运行时探针、验收和开发工具 |
| Docs | docs/ | 架构决策、接口约束、审计和 Agent 使用指南 |

### 核心执行约束

1. **单一权威 Avatar Runtime：** 角色行为状态不属于某个 UI 容器。切换 Presentation 不应创建第二套权威动作状态。
2. **统一参数写入：** 动作源必须经过受控的参数写入与仲裁路径，不得创建并行 Cubism Writer。
3. **能力先于执行：** supported、approximate、unsupported 和 unknown 必须区分；未知能力不能按支持处理。
4. **优先级与所有权：** 冲突动作按优先级和参数所有权处理；被打断的动作需要明确终态并释放资源。
5. **宿主边界：** 独立 Electron WebContents 不能假设与 iframe 共享内存状态；跨窗口同步必须经过宿主侧通道。

## 🧠 动作系统与回执语义

### 动作优先级

| 优先级 | 用途 | 行为 |
|---|---|---|
| BACKGROUND | 呼吸、待机和环境微动作 | 不应抢占更高优先级动作 |
| NORMAL | 普通情绪表达和交互反馈 | 可按调度规则替换低优先级动作 |
| FORCE | 需要立即响应的交互或演出 | 可抢占较低优先级动作 |

### 连续动作链

- 输入动作链最多 15 个 segment。
- Renderer 单次批次最多 8 个 step。
- 相邻且优先级、气泡等边界兼容的 segment 可以合批，但不能跨越优先级边界。
- 遇到短暂冲突时，队头按策略有限等待；超时后应明确返回原因。
- accepted 表示请求已受理，不等于动作已经播放完成。
- pending 表示动作仍在执行或等待，不应将其重复提交。

动作完成、被打断或仍在等待，应依据实际回执和事件判断。不要仅凭工具调用成功、请求被接受或预计时长推断角色动作已完成。

### 模型能力画像

| 状态 | 含义 | 处理方式 |
|---|---|---|
| supported | 有证据确认可用 | 正常执行 |
| approximate | 可通过近似映射表达 | 降级执行并保留标记 |
| unsupported | 已确认不支持 | 跳过或返回明确原因 |
| unknown | 尚未验证 | 不得假定支持 |

## 🧩 DSH 集成与 MCP

### DSH 展示容器

当前宿主扩展点以 [Host API 审计](docs/Host-API-Audit.md) 和对应代码为准：

| 宿主位置 | 扩展点 / 入口 | 说明 |
|---|---|---|
| 页面悬浮层 | shell.overlay | 当前主要角色展示接入路径 |
| 右侧面板 | sidebar.right.pane.tab | keyed tab 扩展点；需独立完成宿主验收 |
| 设置面板 | settings.section | 设置分区，不等同于独立设置窗口 |
| 桌面独立窗口 | pet-window.mjs | 需处理独立 WebContents 和状态同步边界 |

### MCP 接入

packages/dsh-l2d-mcp 提供 stdio MCP Server；Bridge 通过本机回环 HTTP 与插件宿主通信。MCP Server 不负责渲染 Live2D，也不应把密钥或本机服务暴露到公网。

**工具清单以运行时 MCP tools/list 返回的 schema 为准。** README 中的工具名和示例只用于解释调用模式，不是永久 API 保证。可从 [MCP 包说明](packages/dsh-l2d-mcp/README.md) 查看安装方式、工具语义和回执示例。

### Workspace 与隐私边界

- 专属 Live2D Workspace / Session 与其他会话隔离。
- 工作区状态快照只提供必要的状态元数据，不应被解释为聊天正文、文件路径或详细错误信息。
- 其他 Session 应保持只读，不因 Live2D 状态通知而被提示、修改或停止。
- Bridge 当前本地降级 Agent Client 不代表真实 A2A 后端已经接入。
- 系统与媒体传感器默认关闭；启用前应由用户明确选择。
- 本机控制服务只应监听 loopback，不应直接暴露到公网。

## 🚀 快速开始

### 环境要求

- Node.js 22 或更高版本
- pnpm 12.5.1（以根目录 package.json 的 packageManager 字段为准）
- 已安装并可运行的 DeepSeek Harness 环境
- 用户自行准备的 Live2D 模型与 Cubism Core

### 1. 获取代码并安装依赖

~~~bash
git clone https://github.com/tequed232/DSH-L2D.git
cd DSH-L2D
pnpm install
~~~

### 2. 构建 Renderer

~~~bash
pnpm build:renderer
~~~

### 3. 打包 DSH 插件

~~~bash
npm pack ./packages/dsh-l2d-plugin
~~~

将生成的插件包按当前 DSH profile 的插件安装方式部署。插件注册、profile 路径和 Cordis patch 机制可能随宿主版本变化，请以当前 DSH 版本和插件包说明为准。安装或更新插件后，按宿主要求重启 DSH。

### 4. 配置 Live2D 模型与 Cubism Core

模型文件与 Cubism Core 不随仓库分发。请准备具有合法使用授权的模型资源，并按照插件设置及当前模型目录约定完成配置。

- 不要把模型文件、纹理或 Cubism Core 二进制提交到仓库。
- 不要将第三方模型资源上传到未经授权的 CDN。
- 模型加载成功不代表该模型的所有动作、参数和物理效果均已验证。

### 5. 配置 MCP（可选）

在仓库根目录安装依赖后，可按 MCP 客户端配置启动：

~~~bash
node packages/dsh-l2d-mcp/src/server.mjs
~~~

MCP 客户端配置示例（请将路径替换为本机仓库绝对路径）：

~~~json
{
  "mcpServers": {
    "dsh-l2d": {
      "command": "node",
      "args": ["/absolute/path/DSH-L2D/packages/dsh-l2d-mcp/src/server.mjs"]
    }
  }
}
~~~

先确保 DSH 插件已加载，或启动本地调试服务。MCP Server 默认只连接本机回环地址；如需指定服务地址，可参考 [MCP 包说明](packages/dsh-l2d-mcp/README.md) 中的 DSH_L2D_URL 配置。

## 🛠️ 开发与验证

### 常用命令

| 命令 | 用途 |
|---|---|
| pnpm build:renderer | 构建 Live2D Renderer |
| pnpm test:core | 运行 Core、插件、MCP 和 Renderer 聚合测试 |
| pnpm test:types | 类型 smoke 检查 |
| pnpm test:contract | Renderer 契约检查 |
| pnpm test:db | SQLite、Actions Lib、Model Adapter 等测试 |
| pnpm test:bridge | Workspace、StatusReporter、MCP Tools 和动作队列测试 |
| pnpm test:chain15 | 15 段 FIFO 动作链回归 |
| pnpm test:breakpoint | 断点与进程恢复实验 |
| pnpm scan:capability | 扫描当前模型能力 |
| pnpm gen:ai-tools | 生成 Agent 工具定义 |
| pnpm dev:server | 启动本地开发服务器 |
| pnpm accept | 执行项目验收流程 |

### 本地调试

~~~bash
pnpm build:renderer
pnpm dev:server
~~~

开发服务器默认使用本机地址。可通过调试页面检查 Overlay、动作和参数注入路径；具体地址以启动日志为准。

### 验收口径

- **单元测试：** 验证函数、状态机、数据层和局部模块行为。
- **契约 / 构建检查：** 验证包之间的接口约束和构建产物。
- **浏览器 / Renderer 验收：** 验证实际页面、模型加载、动作与参数写入。
- **真实 DSH 宿主验收：** 验证插件生命周期、Host API、MCP 和窗口边界。

以上层级不能互相替代。某个测试套件通过，不代表所有模型、GPU、Electron 窗口或真实宿主场景均已通过。

## 📁 项目结构

~~~text
DSH-L2D/
├── apps/
│   └── stage-web/              # Web 工作区 / 调试 UI
├── packages/
│   ├── core/                   # 模型无关的行为与动作核心
│   ├── renderer/               # Live2D Cubism / WebGL Renderer
│   ├── dsh-l2d-plugin/         # DSH 插件宿主与客户端
│   ├── dsh-l2d-mcp/            # stdio MCP Server
│   ├── dsh-l2d-db/             # SQLite 模型与动作知识库
│   └── mcp-bridge/             # Workspace / Status / Action Bridge
├── tools/
│   ├── acceptance/             # 项目验收
│   ├── capability-scan/        # 模型能力扫描
│   ├── motion-gif/              # GIF 帧与动作时序分析
│   ├── runtime-probe/           # Renderer 运行时探针
│   ├── dev-server/              # 本地调试服务
│   └── ...                      # 生成器、注册表和开发工具
└── docs/                       # 架构、规范、审计与 Agent 指南
~~~

## 🧾 One-shot 编译与触发层（新架构）

当前分支正在把「运行时语义决策」收敛为「导入期一次编译 + 运行期确定性执行」：

- **编译期（允许 LLM，仅一次）**：模型导入 → 能力扫描 → LLM 生成动作 → 四层校验（L1 Schema / L2 能力 / L3 安全 / L4 静态编译验证）→ 原子发布到 SQLite（`action_manifests` + `compiled_actions`，v14）。
- **运行期（禁止 LLM）**：`/api/actions/dispatch` → 三项前置闸门（程序可用性 / strict 模型绑定 / 图存在）→ 进程内执行节点图 → 真实终态回执；`l2d_emote` 等语义入口退化为 `trigger_map` 查表。
- **状态语义**：`published`（通过校验）、`runtime_verified`（真机跑过）、`approved`（人工批准）三者独立；程序变更（`program_hash` 变化）会自动失效旧验证结论。
- 详见：[方案评估](docs/architecture/ONESHOT-COMPILER-ASSESSMENT.md) · [实施记录](docs/architecture/ONESHOT-COMPILER-IMPLEMENTATION.md) · [程序规范草案](docs/architecture/ACTION-PROGRAM-SPEC-DRAFT.md) · [交付报告](docs/bridge/OACA-FULL-DELIVERY.md)

## 🗺️ 路线图

- [ ] 完成 Bridge 与真实 Workspace / Agent 后端的正式联动验收。
- [ ] 将动作生命周期的完成与中断信号统一到可观测的 Runtime Timeline。
- [ ] 完成模型能力画像的版本化、证据追踪和安全降级闭环。
- [ ] 完成自动肢体分配前置审计，以及真实模型 acquire / release 验证。
- [ ] 完成 Overlay、Sidebar 与独立桌宠窗口间的单 Runtime Presentation 切换。
- [ ] 完善真实宿主下的长时间运行、资源回收和性能回归。
- [ ] 推进动作知识库人工审核与模型级运行时验证。

路线图描述的是待完成工作，不代表对应功能已经交付。

## 📚 文档索引

| 文档 | 内容 |
|---|---|
| [README 编写规范](docs/README-STYLE-GUIDE.md) | 项目首页与文档维护标准 |
| [具身行为契约](docs/Embodied-Behavior.md) | 语义行为、动作阶段和执行边界 |
| [多模型 Motion Engine](docs/Motion-Engine-多模型架构.md) | 模型无关动作引擎架构 |
| [能力注册表](docs/W3-Motion-Capability-Registry.md) | 动作能力与模型画像 |
| [Host API 审计](docs/Host-API-Audit.md) | DSH 宿主扩展点与验证记录 |
| [参数所有权不变量](docs/Ownership-Invariants.md) | 参数冲突、所有权和写入约束 |
| [参数读写对照](docs/参数读写对照.md) | Cubism 参数读写边界 |
| [动作链编排](docs/动作链编排-v1.md) | 动作链阶段与编排规则 |
| [节点设计教程](docs/nodegraph/TUTORIAL.md) | Motion Graph 节点编辑器图文教程：每种节点的用途、端口、参数与操作演示 |
| [MCP 包说明](packages/dsh-l2d-mcp/README.md) | MCP 安装、工具和回执语义 |
| [Workspace Agent 指南](docs/agent/README.md) | 上下文边界、动作组合与结果验证 |
| [MCP Bridge 设计](docs/mcp-bridge/BRIDGE-DESIGN.md) | Workspace、状态和动作桥接设计 |

## 🔐 资源、安全与许可

本仓库根目录采用 MIT License。第三方 SDK、模型、纹理、动作素材和字体可能受各自独立许可约束。

- Live2D Cubism Core 不随本仓库分发，请从 [Live2D 官方 SDK 页面](https://www.live2d.com/sdk/download/web/) 获取并遵循其许可。
- Live2D 模型和动作素材不随仓库分发；使用前请确认作者署名、授权范围和再分发限制。
- MCP 与插件之间的本机桥接只应监听 loopback。
- API Key 等凭据不得写入 README、日志、提交记录或客户端资源。
- 工作区上下文遵循最小化采集原则；系统和媒体传感器默认关闭。
- 自动化能力扫描仅反映静态代码中的调用能力，不等同于安全审计或官方背书。

---

<div align="center">

**Made for DSH · Powered by Live2D Cubism**

如果你正在使用或改进 DSH-L2D，欢迎通过 [Issues](https://github.com/tequed232/DSH-L2D/issues) / [Pull Requests](https://github.com/tequed232/DSH-L2D/pulls) 反馈问题与改进建议。

</div>
