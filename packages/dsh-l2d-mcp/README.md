# dsh-l2d MCP

把已经在跑的 DSH-L2D 控制面交给任意 MCP 客户端。这个包不渲染、不保存密钥，只把工具调用转发到本机插件。

## 安装

在仓库根目录：

```bash
pnpm install
node packages/dsh-l2d-mcp/src/server.mjs
```

客户端一般这样写（路径改成你的检出目录）：

```json
{
  "mcpServers": {
    "dsh-l2d": {
      "command": "node",
      "args": ["/绝对路径/DSH-L2D/packages/dsh-l2d-mcp/src/server.mjs"]
    }
  }
}
```

先让角色页面活着：插件已加载的 DSH，或 `pnpm dev:server`（`127.0.0.1:5300`）。改插件路由后要重启 DSH。调试服改 overlay 后刷新即可。

## 它怎么找到端口

1. 环境变量 `DSH_L2D_URL`，例如 `http://127.0.0.1:5300`。只接受本机地址。
2. 否则扫描 `~/.dsh` 里出现过的端口，逐个请求 `/dsh-l2d/status.json`。
3. 最后试调试服 `http://127.0.0.1:5300`。

连不上时工具返回 `{ "ok": false, "reason": "plugin-offline" }`。

## 工具

| 工具 | 作用 |
|---|---|
| `l2d_emote` | 情绪词，交给 Emotion_Router |
| `l2d_set_expression` | 指定表情名 |
| `l2d_play_motion` | 动作组。`skipped` / `conflict` 是状态机的正常结果 |
| `l2d_set_pose` | 四肢姿势，会缓动，空闲后回到 rest |
| `l2d_gaze` | 看向 -1~1 的方向 |
| `l2d_say` | 气泡 |
| `l2d_act` | 一小段 expression / motion / pose / look 序列。可带 `priority` 和 `phase` |
| `l2d_get_state` | 只读快照，并附上余额查询结果 |
| `l2d_reset` | 清姿势、表情、注视 |

没有 `l2d_set_parameters`，也没有 `l2d_play_keyframes`。

这个包不会去改 `~/.dsh/l2d-settings.json`。`systemSensor` 和 `mediaSensor` 保持默认关闭，只能在角色设置面板里打开。

返回都是 JSON 文本：`{ "ok": true, ... }` 或 `{ "ok": false, "reason": "..." }`。

## `l2d_act` 的优先级

调度还是页面里的 `executePokeAction`，没有第二套调度器。`priority` 三档：

| 值 | 谁在用 | 能不能打断 |
|---|---|---|
| `BACKGROUND` | 待机时看回正前方 | 不能打断 `NORMAL` / `FORCE` |
| `NORMAL` | 省略时的默认；思考、出错这类情境反应 | 能打断 `BACKGROUND` 和另一个 `NORMAL`，不能打断 `FORCE` |
| `FORCE` | 对话演出、邪神、用户戳一戳 | 能打断任何档，包括另一个 `FORCE` |

低优先级被挡住时不会播，返回 `{ "ok": false, "accepted": false, "reason": "priority-blocked", "outcome": "rejected", "current": { "runId", "priority", "source" } }`。这是正常结果，换个时机或提高优先级，不要原样重试。

`accepted: true` 只表示这条链占上了槽。真正的过程在 `events` 里。

同级抢占会清掉还没跑的关闭定时器。补不补播，按是不是同一只手，而不是按新链里有没有 motion。抚胸手是左手，竖手指和狗尾巴草是右手（姿态骨相交就算同一只手）。新链动作和待关闭的是同一只手时不补播，交给新动作覆盖。另一只手的关闭排在新动作后面再播，避免两个动作同时进状态机、后一个被吞掉。新链没有 motion 时，挂着的关闭照常补播。

邪神是常驻模式，只能从右键菜单关掉。那 9 秒的 `FORCE` 槽只保护开场演出不被待机打断。槽被戳走，或者 9 秒到了，开场结束，暗角和黑脸都还在。只有菜单关闭才会清表情、关掉抚胸手、收起暗角。

## `action-done` 回执

浏览器把事件 POST 到现有的 `/dsh-l2d/ai/result`，和执行回执用同一个 `id`：

```json
{ "id": 12, "event": {
  "type": "action-done",
  "phase": "start",
  "runId": 4,
  "priority": "FORCE",
  "callId": 12,
  "source": "speaking",
  "steps": 3
}}
```

`phase` 只有三种：`start`（开始播）、`end`（按计划播完）、`interrupted`（被同级或更高的链打断，或邪神从菜单退出）。打断时多一个 `reason`，例如 `preempted`。

`end.reason` 只表示动作真的没播成：被状态机拒绝（`conflict`）或被正在播的动作吞掉（`start-rejected`）。`already-open`、`already-closed` 是正常跳过（手已经在那个状态），写在 `end.notes` 里，不要当成失败。连发两句 `speaking` 时第二句常常是 `notes: ["already-open"]`，手指本来就举着。

MCP 不自己判断该不该打断。它转发 `/ai/call`，再把这个 id 上的回执和事件收齐。工具返回大致是：

```json
{
  "ok": true,
  "accepted": true,
  "settled": true,
  "outcome": "completed",
  "runId": 4,
  "priority": "FORCE",
  "steps": 3,
  "events": [
    { "type": "action-done", "phase": "start", "runId": 4, "priority": "FORCE", "callId": 12, "source": "speaking", "steps": 3 },
    { "type": "action-done", "phase": "end", "runId": 4, "priority": "FORCE", "callId": 12, "source": "speaking", "steps": 3 }
  ]
}
```

`outcome` 为 `completed`、`interrupted` 或 `pending`。大约 12 秒内还没见到 `end` / `interrupted` 时，`settled` 是 false，`reason` 是 `pending`，`ok` 仍是 true：链已经在播，只是这一次调用先返回了。

## 对话四段短链

`phase` 可以代替手写 `chain`。这四段都是 2～4 步，只用表情、动作、姿势和视线。说话段也不写 `ParamMouthOpenY`。

| phase | 优先级 | 在做什么 |
|---|---|---|
| `listening` | FORCE | 看向用户，轻表情，手放下 |
| `thinking` | FORCE | `＞＜`，视线偏右上，竖一下手指 |
| `speaking` | FORCE | 兔牙，看回用户，竖手指打开并在几秒后关闭 |
| `settle` | NORMAL | 视线和手回到休息，表情收回默认。下一句 FORCE 可以把它打断，待机 BACKGROUND 不行 |

```json
{ "phase": "thinking" }
```

自己写了 `chain` 就用你写的步骤。这时不写 `priority` 就是 `NORMAL`。


## DSH Workspace Agent 联动

插件在 DSH 同时提供 `workspaceRegistry` 与 `sessionController` 时，会自动创建或复用真正的 `Live2D Agent` Workspace，并在其中建立独立 Session。目录位于 `$DSH_HOME/workspaces/live2d-agent`（默认 `~/.dsh/workspaces/live2d-agent`）。

- `AGENTS.md`：由 DSH Agent Instructions 原生机制加载，定义专属 Agent 的职责、隐私边界和 Live2D 行为。
- `agent.md`：插件定期生成的状态快照，只包含其他 Workspace 的标题、Session 状态与活动时长，不包含聊天内容、文件路径或错误详情。
- 状态变化会以队列消息通知专属 Session；其他 Session 始终只读，不会被提示、修改或停止。
- MCP 新增 `l2d_workspace_ensure` 与 `l2d_workspace_status`。前者创建/复用专属工作区，后者读取脱敏状态。
- 专属 Agent 使用 `l2d_*` 工具控制 Live2D。需将本包 MCP Server 配置到 DSH 当前使用的 MCP 工具提供端；插件不会自行启动一个未受 DSH 管理的 MCP 子进程。

如果 Workspace / Session 服务未加载，原有 Live2D 叠加层和控制工具仍可运行，但 Workspace Agent 功能会返回 `dsh-workspace-services-unavailable`。


### 在 DSH 中启用 MCP 工具

DSH 会给工具名加上 `mcp__<serverName>__` 前缀。建议在 DSH profile 的 `cordis.patch.yml` 中增加一条 MCP Client entry（先确保 profile 已安装 `@deepseek-ai/dsh-mcp-client`）：

```yaml
- insert:
    - id: dsh-l2d-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: dsh_l2d
        transport: stdio
        command: node
        cwd: '<DSH-L2D 仓库绝对路径>'
        args:
          - '<DSH-L2D 仓库绝对路径>/packages/dsh-l2d-mcp/src/server.mjs'
```

例如仓库位于 `D:/Desktop/DSH-L2D` 时，将上面的两个路径替换为该目录。重启 DSH 后，专属 Agent 可用的工具名为 `mcp__dsh_l2d__l2d_act`、`mcp__dsh_l2d__l2d_get_state`、`mcp__dsh_l2d__l2d_workspace_status` 等，而不是裸的 `l2d_act`。该 MCP Client entry 位于 profile 全局作用域，因此同一 profile 中其他 Agent 也能看到这些桌宠工具；当前实现通过 `AGENTS.md` 约束专属 Agent 的使用方式，而不是伪称工具已被 DSH 自动限定到单个 Session。

