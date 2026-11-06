# DSH ↔ Models MCP Bridge — 设计契约（主理人定稿 v1）

依据：用户设计裁决书（data/bridge-requirement-20261105.txt）+ 后端席窄域侦察事实。
三原则不可妥协：工作区隔离 / 状态解耦 / 执行串行。

## 0. 侦察事实修正设计假设

1. **无原生 WorkspaceRegistry/SessionController**：workspace-agent.mjs 的
   acquireWorkspaceAgent 提供 WorkBuddy A2A HTTP 客户端（baseUrl 127.0.0.1:8317/sdk/v0/a2a，
   createSession / message / waitForAgentEvent / pollAgentTask），但**没有** findByPlugin、
   ensureSession 唯一键、历史读取。→ Registry/SessionController 自建薄层，A2A 做底层通道。
2. **A2A 会话历史不可读** → ChatMemorySource 的 summary/recentMessages 用
   **本地 bounded 镜像**（由 session-event-bus 的 chat_message 事件驱动 + 宿主显式 appendChatTurn），
   不伪造宿主读接口。getSummary=滚动摘要（上限 2KB），recentMessages≤10。
3. **动画完成信号已存在**：overlay playKeyframesPromise（L3190）在全部 element.animate
   finished 后 resolve——waitForCompletion 用它，不预估时长。
4. **ownership 释放无事件** → v1 不改 renderer：overlay 执行器在 releaseOwnParameters
   同步完成后才返回 HTTP 回执，回执即释放确认。renderer onRelease 事件留待需要时再加。
5. **ai-inbox 现状**：内存队列、无 FIFO 保证、无持久化、并发消费 → 动作类指令
   **不走 ai-inbox**，走新的独立 action 通道（见 §3）。
6. **插件 import 无现成钩子** → onPluginImport/onPluginDispose 自建，挂 dev-server
   宿主接口与 overlay bootstrap 尾部两处（真机宿主按同一签名接入）。

## 1. 运行时布局

```
packages/mcp-bridge/          Node 侧（.mjs，与 dsh-l2d-plugin/lib 同风格）
  contracts.mjs               全部数据契约（照裁决书 §三，原样落 TypeScript 类型注释）
  workspace-manager.mjs       Live2DWorkspaceManager + WorkBuddyRegistry/SessionController
  session-memory.mjs          SessionMemoryInjector + 本地镜像 ChatMemorySource
  status-reporter.mjs         StatusReporter（30-120s 强校验、revision 去重、失败不推进）
  action-queue.mjs            ModelActionQueue（FIFO/幂等/FAULTED 状态机/背压/dispose）
  action-executor.mjs         HttpActionExecutor（HTTP → overlay 执行端点）
  mcp-tools.mjs               l2d_action_enqueue / l2d_action_status / l2d_action_cancel
  index.mjs                   Live2DMCPBridge 总装 + onPluginImport/onPluginDispose
  tests/                      B01-B18 分组（node:assert，挂 test:bridge）
packages/dsh-l2d-plugin/lib/  浏览器侧
  action-endpoint.mjs（新）   overlay 内动作执行端点逻辑（admit→playKeyframesPromise→
                              release 确认→回执），独立于 ai-inbox 轮询
tools/dev-server/index.mjs    挂 POST /dsh-l2d/action/execute + bridge 初始化调用点
```

## 2. 持久化（@dsh/db schema 下一版本追加两表，走既有 migrations 数组）

- `bridge_workspaces`：plugin_id TEXT PRIMARY KEY / workspace_id / chat_session_id /
  control_session_id / created_at。findByPlugin=SELECT；并发导入防重=PRIMARY KEY 冲突复用。
- `bridge_actions`：照裁决书 §十 原样（request_id PRIMARY KEY，state 含 interrupted）。
- 状态同步/记忆镜像 v1 不落盘（有界、可重建）；bridge_actions 是唯一桥持久化事实源。

## 3. 动作执行通道（与 ai-inbox 完全分离）

```
MCP l2d_action_enqueue → Bridge(Node) 幂等检查+入队+落库(queued)
  → ModelActionQueue 单 worker 取头(dequeued→running)
  → HTTP POST /dsh-l2d/action/execute {requestId, action, args}
  → overlay action-endpoint：ActGate admit → playKeyframesPromise（真实 anim.finished）
    → ownership release 同步确认 → HTTP 回执 {ok, executionId, timings}
  → Bridge 落库回执 → 下一条
超时：Node 侧 withTimeout 触发 → POST /dsh-l2d/action/cancel → 确认释放 → 记 failed → 下一条
释放失败/取消失败：队列 FAULTED（阻断全部），仅 manual recovery 可解锁
```

- FIFO 严格（裁决书：不按 priority 重排序；priority 仅记录）。
- requestId 幂等：PRIMARY KEY + 重复请求返回既有回执，不重复执行（B15）。
- 背压：maxQueue=32，满则 QUEUE_FULL（裁决书 §十）。
- 重启恢复：启动时 SELECT state IN (queued,running) → 全部置 interrupted，
  不重放（B17）；Runtime 未就绪拒绝执行不伪报（B18）。
- 动作合法性：action 必须命中 Capability Registry 注册语义（复用 actions-repo 解析），
  拒绝任意 Cubism 参数 ID。

## 4. 状态通道（与动作通道零共享可变状态）

- StatusSource = session-event-bus.latest()（seq 即 revision）+ execution verdict 合成；
  crashed/success/waiting 可上报，running 附带，idle 不重发（B08/B09）。
- Sink = A2A message 到 control session（Chat 会话零写入）。
- 上报失败不影响队列；队列故障不影响上报（独立 timer、独立 try/catch）。
- 进程级崩溃由宿主生命周期观察器负责（裁决书 §六），桥只报进程内可观测状态。

## 5. MCP Scope 隔离

Model Control 会话只允许 `l2d_action_*` + `l2d_get_status` 类工具（名称前缀白名单过滤），
不开放 DSH 工作区任意工具。Chat 会话不获得任何 l2d 控制工具。

## 6. 实施切分（对应用户裁决书三 PR）

- **PR-A**（B01-B04）：workspace-manager + session-memory + 两张表 + dev-server 挂载点。
- **PR-B**（B05-B09）：status-reporter + mcp-tools + scope 过滤。
- **PR-C**（B10-B18 + 连续 100 次）：action-queue + action-executor + action-endpoint + 恢复。

## 7. 已知遗留（不阻塞 PR-A/B）

- waitForAgentEvent 通知丢失窗口：桥发状态前先注册 listener（发送顺序规避），根治留待宿主。
- 换装/配饰开关真机验证（overlay 设置面板）待实机环境。
- param-ownership onRelease 事件化（v2 可选，当前回执语义已闭环）。
