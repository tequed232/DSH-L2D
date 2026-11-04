# Whale Workspace · 实现说明与验收对照

> 交付物 2/2。应用目录：`apps/whale-workspace`（Vue 3 + TypeScript + Vite）。
> ⚠️ 先读这里：会话能力为 **MOCK（memory-mock）**，本仓没有接入任何真实模型后端。

---

## 1. 运行方式

```bash
pnpm --filter whale-workspace dev        # http://127.0.0.1:5281/
pnpm --filter whale-workspace build      # 产物 apps/whale-workspace/dist
pnpm --filter whale-workspace preview    # http://127.0.0.1:5281/
pnpm --filter whale-workspace typecheck  # vue-tsc --noEmit
pnpm --filter whale-workspace test       # 服务层单测（37 条）
```

镜像窗口（同源第二窗口，只读投影）：

```
http://127.0.0.1:5281/?role=mirror
```

工作区工具栏的「镜像窗口」按钮会 `window.open` 同地址并带 `role=mirror`；
无头浏览器会拦截非用户手势的弹窗，自动化验证时直接访问上述 URL。

技术栈与 `apps/stage-web` 对齐；样式只复用 `packages/dsh-l2d-plugin/assets/ui-tokens.css`
的令牌，未引入任何 UI 库。包名刻意使用未加 scope 的 `whale-workspace`，
以便门禁命令 `pnpm --filter whale-workspace build` 精确命中。

---

## 2. 目录与职责

```
apps/whale-workspace/
  src/
    App.vue                       # 双模式切换（workspace / capsule）
    main.ts
    styles/app.css                # 令牌之上的鲸鱼娘蓝紫外观
    app/session.ts                # WorkspaceApp 装配（authority / mirror 两种角色）
    services/
      types.ts                    # 领域类型
      navigation.ts               # WorkspaceNavigationService（唯一导航状态）
      drafts.ts                   # ChatDraftStore（按 conversationId）
      conversation.ts             # ConversationService 接口 + MOCK 声明
      inMemoryConversation.ts     # InMemoryConversationService + ConversationAuthority
      session.ts                  # ChatSessionController（导航/草稿/会话粘合）
      crossWindowAdapter.ts       # CrossWindowAdapter + BroadcastChannel / Loopback
      sync.ts                     # WorkspaceSync + MirrorChatStore
    components/
      WorkspaceShell.vue          # 双栏：左 Agent 占位 + 会话列表；右聊天
      CapsuleShell.vue            # 角色旁的迷你聊天窗 + 收起入口
      ChatThread.vue / ChatComposer.vue
      ConversationList.vue / AgentTaskPanel.vue / CharacterStage.vue
    test/
      harness.ts / run.ts
      navigation.test.ts / draft.test.ts / continuity.test.ts / cross-window.test.ts
```

**状态唯一性**：`conversationId` 只存在于 `WorkspaceNavigationService` 一份；
`ChatCapsule`/`Workspace` 都是它的渲染视图，不存在各自维护的会话 id。

---

## 3. 双向切换状态机

| 动作 | view | capsuleVisible | conversationId | 会话/生成 |
| --- | --- | --- | --- | --- |
| `openWorkspace(convId?)` | workspace | false | 当前或指定 | 不变 |
| `openCapsule(convId?)` | capsule | true | 当前或指定 | 不变 |
| `hideCapsule()` | 不变（保持 capsule） | false | 不变 | 不变 |
| `switchConversation(id)` | 不变 | 不变 | 目标 | 不变（不重建） |
| 其余会话助手消息落地 | — | — | — | 仅在「该会话不可见」时未读 +1 |
| 打开/切到某会话 | — | — | — | 该会话未读清零 |

可见性定义：`view === 'workspace'`，或 `view === 'capsule' && capsuleVisible`，且
`conversationId === 目标会话`。未读只统计助手消息，在 `message-settled` 时计算。

草稿规则：键为 `conversationId`；发送时先捕获「发送那一刻的会话 id」再 `clear(convId)`，
因此发送过程中切会话不会清错草稿；发送失败会把原文还给原会话。

---

## 4. 跨窗口

- 默认 `BroadcastChannelAdapter('dsh-l2d:whale-workspace')`；无 `BroadcastChannel` 的环境
  自动退回 `LoopbackAdapter`（进程内总线，语义对齐：异步投递、不回声）。
- 权威端：`ConversationService` + `WorkspaceSync(authority)`；镜像端：`MirrorChatStore` +
  `WorkspaceSync(mirror)`，**没有** ConversationService，也没有 `sendMessage`。
- 新窗口 `sync/request` 拉全量 → 权威端回 `nav/state` + `chat/snapshot` + 所有草稿。
- 发送幂等：`chat/send-request.requestId` 在权威端 `seenRequests` 去重；内存服务内部
  再用 `requestId` 幂等，重复调用返回同一个 Promise。
- 导航冲突：`revision` 严格递增；并发产生相同 revision 时，按 `origin` 字典序裁决
  （较大者胜），两侧计算出同一个赢家，避免永久分叉（单测覆盖）。
- 权威唯一性：`ConversationAuthority.claim(owner)` 第二个声明抛 `ConversationOwnershipError`（单测覆盖）。

---

## 5. 验收用例 1–10 对照

> 状态口径：PASS = 有单测或真实截图证据；BLOCKED = 受本仓边界限制；NOT TESTED = 未实测。

| # | 用例 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 胶囊最大化 → 打开工作区并定位当前会话 | PASS | `navigation.test.ts`「胶囊最大化 → openWorkspace 定位当前会话并隐藏胶囊」；截图 `05` → `06` |
| 2 | 工作区 → 工具栏「迷你聊天」呼出胶囊 | PASS | `navigation.test.ts`「工作区 → openCapsule 呼出胶囊」；截图 `02` → `03` |
| 3 | 胶囊关闭 = 只隐藏、不删会话 | PASS | `navigation.test.ts`「hideCapsule 只隐藏，不换会话」；`draft.test.ts`「关闭胶囊不删除草稿」；截图 `04` |
| 4 | 工作区关闭 = 保留会话与生成状态 | **PASS（切换语义）/ BLOCKED（真关窗）** | 切走视图时生成继续：`continuity.test.ts`「流式生成中切换视图」；真正的浏览器窗口关闭会随进程销毁内存态，需宿主/持久化接管（未实现） |
| 5 | 切换视图不取消生成 | PASS（MOCK 流式） | `continuity.test.ts` 同上；截图 `02`（工作区生成中）→ `03`（胶囊生成中）→ `04`（收起后完成并出现未读） |
| 6 | 切换保留草稿；切会话恢复各自草稿 | PASS | `draft.test.ts`「切换工作区/胶囊保留草稿」「按会话隔离」 |
| 7 | 发送成功清草稿；发送中切会话不串稿 | PASS | `draft.test.ts`「发送成功只清除发送会话的草稿」「发送中途切换会话」 |
| 8 | 新建会话两个界面同步 | PASS | `navigation.test.ts`「新建会话在两个界面同步」；UI 中工作区「＋ 新会话」与胶囊「＋」共用同一 `nav.switchConversation` |
| 9 | 胶囊：生成中指示、未读提示、与工作区共享消息状态 | PASS（MOCK） | 截图 `03`（正在生成 + 流式文本）、`04`（未读 1）、`05`（同一 3 条消息）；`continuity.test.ts`「同一 conversationId：两视图同一份消息」「未读」 |
| 10 | 跨窗口：同源双窗口同步、单一权威、不重复请求 | PASS（BroadcastChannel 实测） | `cross-window.test.ts` 9 条；真实浏览器双标签页截图 `07`（镜像端 3 条消息与主窗口一致） |

MOCK 声明：

- 用例 5/9/10 的「生成」全部由 `InMemoryConversationService` 以固定模板分片输出，
  **不联网、不调模型**；界面顶部/底部常驻 `MOCK · memory-mock` 徽章。
- 用例 4 的「真关窗恢复」未实现，不当作已具备能力。

---

## 6. 测试清单（37 条，全部通过）

```
导航 13 · 草稿 8 · 连续性 7 · 跨窗口 9
```

运行：`node --experimental-strip-types apps/whale-workspace/src/test/run.ts`
（已追加到根 `test:core` 链末尾，既有用例顺序与结果不变）

覆盖点：双向状态机、revision 合并与并发同 revision 的 origin 仲裁、未读边界、hideCapsule 不删会话、草稿隔离与发送竞态、
流式中切换不中断、消息 id 序列稳定、BroadcastChannel 双实例、Loopback 双实例、
requestId 去重、镜像不可自建权威、镜像不可直接发送。

---

## 7. 截图索引（真实构建产物，1440×900）

| 文件 | 内容 |
| --- | --- |
| `01-workspace.png` | 工作区初始态：工具栏 + Agent 占位 + 会话列表 + 聊天面板 |
| `02-workspace-streaming.png` | 工作区生成中：右上「正在生成」、气泡流式输出、会话列表「生成中」 |
| `03-capsule-switch-streaming.png` | 生成过程中点「迷你聊天」：胶囊里继续流式，未中断 |
| `04-capsule-collapsed-unread.png` | 胶囊收起：角色旁入口 + 未读角标 1（生成在收起后完成） |
| `05-capsule.png` | 重新展开：与工作区完全相同的 3 条消息 |
| `06-workspace-continuity.png` | 点「展开到工作区」：同一会话完整保留 |
| `07-mirror-window.png` | 同源镜像窗口：`?role=mirror`，只读投影同步到 3 条消息 |

复现：`pnpm --filter whale-workspace build && pnpm --filter whale-workspace preview`，
用本机浏览器按上表顺序操作，或用 CDP 驱动无头 Edge 复跑（脚本为一次性验证工具，未入库）。

---

## 8. 与需求书的差异（有意为之）

1. **React → Vue 3**：需求书示例是 JSX，本仓统一 Vue 3 SFC，按仓内栈实现。
2. **没有独立 Chat 窗口**：以「同源镜像窗口」验证跨窗口能力，Electron pet 窗集成留接口（见 AUDIT §4）。
3. **角色立绘为内置 SVG 占位**：Live2D 渲染属 `packages/renderer` 域，本应用不重复引入；
   截图里已标注「角色站位为内置 SVG 占位；Live2D 渲染管线不在本应用内」。
4. **Agent 任务面板为静态占位**：无真实 Agent 事件源，明确标注「占位」。

---

## 9. 已知限制与风险

| 风险 | 影响 | 处置 |
| --- | --- | --- |
| 会话仅内存 | 刷新/关窗即丢 | 文档与 UI 标注 MOCK；接真实后端时替换 `ConversationService` |
| BroadcastChannel 不跨 process/partition | pet 窗若独立 partition 会收不到 | 预留 `CrossWindowAdapter`，换 Electron IPC 实现即可 |
| 镜像端未读依赖权威端可见性 | 两窗口可见性不同时，未读以权威端为准 | 单一口径，避免双份计数；文档写明 |
| `?role=mirror` 可被手动打开多个 | 多镜像窗口只读，不会造成双权威 | `ConversationAuthority` 所有权检查兜底 |
| 流式模拟固定 40ms/3 字 | 只是节奏参数，不代表真实模型延迟 | 仅用于交互验证 |

---

## 10. 回滚

- 删除 `apps/whale-workspace/`；
- 从根 `package.json` 的 `test:core` 末尾移除
  `&& node --experimental-strip-types apps/whale-workspace/src/test/run.ts`；
- 回滚 `pnpm-lock.yaml` 中新增的 workspace importer；
- 删除 `docs/WHALE-WORKSPACE-*.md` 与 `docs/assets/whale-workspace/`。

不触碰 `packages/core`、`packages/renderer`、`lib/`、`tools/acceptance/`，回滚无跨域影响。
