# Whale Workspace · 窗口架构审计与跨窗口方案

> 交付物 1/2。范围：DSH-L2D 仓库内与「聊天窗口 / 角色窗口」相关的真实代码。
> 结论先行：**本仓没有独立 Chat 窗口**，可复用的第二个窗口只有 Electron pet 窗（同源）；
> 因此跨窗口通信以 BroadcastChannel 为默认实现，Electron IPC 作为同一接口的后续替身。

审计基线：`feat/m1-batch2 @ 3eaaa5d`，工作分支 `feat/whale-workspace`。

---

## 1. 审计范围与方法

逐文件阅读（非猜测）：

| 文件 | 角色 | 关键事实 |
| --- | --- | --- |
| `apps/stage-web/**` | Vue3 + Vite 调试壳 | 单文档单 `createApp`，无多窗口、无 IPC、无聊天后端 |
| `packages/dsh-l2d-plugin/lib/overlay.js` | 注入 DSH 宿主页的悬浮层 | 普通 `<script>` 注入，只叠角色容器；把宿主 `lastAssistantText` 读成角色气泡，不渲染消息列表 |
| `packages/dsh-l2d-plugin/lib/index.js` | 插件主进程 / 宿主 webServer 路由 | 注册 `/dsh-l2d/*` 静态与数据路由；不含聊天 UI |
| `packages/dsh-l2d-plugin/lib/pet-window.mjs` | Electron 桌宠独立窗 | 唯一 `new BrowserWindow`（`:173`），加载同源 `/dsh-l2d/pet.html`（`:234`） |
| `packages/dsh-l2d-plugin/lib/pet-preload.cjs` | pet 窗 preload | 仅 `l2d-pet:cursor / hit / drag` 三条 IPC 通道 |
| `packages/dsh-l2d-plugin/lib/session-events.mjs` | 宿主会话事件解析 | 只读解析 DSH session 事件（tool/result、turn/end…）供角色表演，**不持有对话内容** |

补充检索：`new BrowserWindow` 全仓仅 `pet-window.mjs:173` 一处；`conversationId / chatMessage` 在插件与 MCP 包中**零命中**。

---

## 2. 事实结论

### 2.1 没有独立 Chat 窗口

- DSH 宿主的聊天页不属于本仓（仓库内不存在其源码），插件通过 `overlay.js` 注入宿主页面，
  读取宿主的 agent 状态做表情/气泡，但**没有**消息列表、输入框或会话存储。
- `packages/dsh-l2d-plugin/lib/index.js` 只负责：
  - 把 `overlay.js` / `ui-tokens.css` / 模型资源挂到 `/dsh-l2d/*`；
  - `POST /dsh-l2d/ai/call` + `GET /dsh-l2d/ai/poll` 的指令队列；
  - 状态、快照、人设、音频等只读数据。
  没有 `/chat` 路由，也没有对应 UI。
- `apps/stage-web` 是 Live2D 舞台调试壳，只有单页面，不创建窗口。

### 2.2 真实存在的「第二窗口」= Electron pet 窗，且同源

```
BrowserWindow(360×460, transparent, frameless, alwaysOnTop, focusable:false)
  └─ loadURL(origin + '/dsh-l2d/pet.html')      // 与宿主页同一个 webServer origin
  └─ preload: pet-preload.cjs
       ipcRenderer: l2d-pet:cursor / l2d-pet:hit / l2d-pet:drag
```

- pet 窗与宿主页**同源**（同一 `webServer` origin），这是 BroadcastChannel 可用的前提。
- pet 窗的 IPC 只服务于光标轮询、alpha 命中、拖动；**没有任何聊天消息通道**，也没有会话 id 概念。
- pet 窗为 `focusable:false` + 初始 `setIgnoreMouseEvents(true)`，只适合承载只读/轻交互内容；
  要承载完整输入框，需要先解决焦点与命中转发的交互策略（属于 pet 窗集成阶段的事）。

### 2.3 宿主的聊天数据当前只有「只读投影」

`session-events.mjs` 明确只做「已持久化事件的分类」，`overlay.js` 只取 `agent.lastAssistantText`
做一句话气泡。二者都不构成可写的会话状态，因此本仓内没有任何地方能充当「聊天权威」。

---

## 3. 通信方案决策

### 3.1 候选与取舍

| 方案 | 同源窗口 | 跨进程（不同 partition / 独立进程） | 结论 |
| --- | --- | --- | --- |
| `BroadcastChannel` | ✅ 原生、低延迟、结构化克隆 | ❌ | **默认实现** |
| `window.postMessage` + `window.opener` | 需要窗口引用，SPA/宿主重渲染易丢 | ❌ | 不采用 |
| `localStorage` + `storage` 事件 | 可用但延迟高、写入竞争、容量受限 | 部分可用 | 不采用 |
| `SharedWorker` | 可用 | 依赖宿主支持 | 不采用（增加生命周期负担） |
| Electron IPC（`ipcMain` / `webContents.send`） | ✅ | ✅（同进程内 webContents） | **预留替身**，实现同一接口 |
| HTTP 轮询宿主 | 可用 | 可用 | 与「实时同步」目标不符，不采用 |

### 3.2 落地设计

```
CrossWindowAdapter（接口：start/stop/publish/subscribe + channelName）
  ├─ BroadcastChannelAdapter   // 同源窗口（默认，本仓真实可用）
  └─ LoopbackAdapter           // 进程内总线，用于单测 / 无 BroadcastChannel 环境
  （预留）ElectronIpcAdapter   // 复用 pet-window.mjs 的 ipcMain 通道，实现同接口即可替换
```

消息形态（`SyncMessage`，全部带 `origin` 防回声）：

| 消息 | 方向 | 说明 |
| --- | --- | --- |
| `sync/request` | 镜像 → 权威 | 新窗口加入时请求一次全量状态 |
| `nav/state` | 双向 | 导航状态 + `revision`（last-writer-wins） |
| `draft/set` | 双向 | 按 conversationId 的草稿 |
| `chat/snapshot` | 权威 → 镜像 | 会话全量快照（含 generating 标记） |
| `chat/append` / `chat/update` | 权威 → 镜像 | 消息增量与流式文本更新 |
| `chat/generation` | 权威 → 镜像 | 生成开始/结束 |
| `chat/send-request` | 镜像 → 权威 | 带 `requestId` 的发送意图，权威端去重后执行 |

### 3.3 单一权威（硬约束的落实）

- `ConversationAuthority.claim(owner)`：进程内单例 + 所有权检查，第二个「权威」声明直接抛
  `ConversationOwnershipError`；镜像窗口**没有** ConversationService，只有一个只读投影
  `MirrorChatStore`（不含 `sendMessage`）。
- 镜像窗口发送 = `chat/send-request` → 权威端 `seenRequests` 去重 → 只执行一次模型请求
  （内存服务还用 `requestId` 做幂等，重复调用返回同一个 Promise）。
- 因此「两个窗口各自维护权威消息状态」「重复发起同一模型请求」在结构上被排除，而不是靠约定。

### 3.4 与 DSH 宿主的边界

- 本应用**不读取**宿主聊天 DOM、**不注入**宿主会话存储、**不冒充**宿主 conversationId。
- 宿主若要接入，正确路径是实现一个 `ConversationService` 的宿主适配器
  （`mode: 'host-bridge'`）替换 `InMemoryConversationService`，UI 与服务层无需改动。
- 现阶段所有会话内容均来自 MOCK 内存服务，界面显示 `MOCK · memory-mock`，文档与代码注释三处一致标注。

---

## 4. 已验证 / 未验证

| 项 | 状态 | 说明 |
| --- | --- | --- |
| BroadcastChannel 同源双窗口同步 | ✅ 已验证 | node 双实例单测 + 真实浏览器双标签页截图 `07-mirror-window.png` |
| 序列化与远端状态应用 | ✅ 已验证 | 单测覆盖 `nav/state`、`draft/set`、`chat/*` |
| 重复请求去重 | ✅ 已验证 | 同一 `requestId` 投递 3 次只产生 1 条用户消息 |
| Electron pet 窗内 BroadcastChannel | ⚠️ 未实测 | 需在真实 DSH Electron 宿主内跑；同源理论可用，未验证 |
| Electron IPC 替身 | ⚠️ 未实现 | 接口已留（`CrossWindowAdapter`），待 pet 窗集成阶段 |
| 跨 partition / 独立进程 | ❌ 不适用 | BroadcastChannel 不跨 partition，需 IPC |
| 「关闭窗口后恢复会话」 | ❌ BLOCKED | 内存服务无持久化，需宿主接管；见实现文档用例 4 |

---

## 5. 给后续集成者的接口约定

1. 任何新窗口只能二选一：`authority`（唯一）或 `mirror`（只读投影）。
2. 新窗口一律先 `publish({type:'sync/request'})` 拉全量，再接收增量。
3. 不允许在 UI 层直接 `publish` 聊天内容；聊天事件只能由权威端的 `ConversationService` 事件驱动。
4. 替换传输层时只需实现 `CrossWindowAdapter` 的三个方法，`WorkspaceSync` 与 UI 不动。
