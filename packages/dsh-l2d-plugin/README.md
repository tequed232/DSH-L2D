# dsh-l2d — DSH 插件

在 DeepSeek Harness 界面之上叠加一层透明 Live2D 角色。**真实 Cubism 5 渲染**（官方 Web SDK 5-r.5），
支持表情/动作/四肢姿势、API 关键帧动作链、分区互动、余额峰谷价、体型校正、右键菜单、自发聊天和工作区会话状态联动。

> 拖拽惯性已恢复为“安全惯性”：临界阻尼弹簧收敛到松手点，不追加甩出初速度，不会飞走。

## 交互

| 操作 | 行为 |
|---|---|
| 单击头部 | 亲和反应（兔牙 / 爱心眼 + 视线） |
| 单击胸部 | 害羞反应（脸红 / ＞＜） |
| 上/下拖拽裙摆 | 连续调整裙摆形态（Clothes1） |
| 单击足部 | 穿/脱鞋切换（Clothes4） |
| 单击其他身体区域 | 戳一戳动作链（随机或 DeepSeek 决定） |
| 右键角色 | 菜单：设置 / 对话 / 随机动作 / 切换体型 / 余额价格 |
| 悬停角色 | 底部价格条更新；不占用对话气泡 |
| 拖动角色 | 带安全惯性，位置持久化 |

## 体型与缩放

- 基础画布从 240×300 提升到 320×400，整体视觉更大。
- 缩放范围 `0.6 ~ 2.0`。
- 体型切换使用 `Clothes2`：
  - 默认体型：0
  - 体型1：0.4
  - 体型2：1.0
- 三个体型有统一视觉校正系数，避免换体型后看起来忽大忽小。

## API 关键帧动作链

除了预设动作组，DeepSeek 可以返回 `keyframes` 步骤，直接编排眼、嘴、头、身体的微动作：

```json
{
  "chain": [
    { "kind": "expression", "name": "兔牙" },
    {
      "kind": "keyframes",
      "duration": 1600,
      "tracks": [
        { "param": "ParamEyeLOpen", "keys": [[0, 1], [140, 0.25], [360, 1]] },
        { "param": "AngleZ", "keys": [[0, 0], [220, 7], [620, -4], [1000, 0]] }
      ]
    }
  ],
  "bubble": "看我一下"
}
```

安全限制：

- 参数只能来自前端上报的 `safeParams`
- 最多 5 条轨道、每轨 2~10 个关键帧、总时长 0.5~8 秒
- 物理输出参数仍被注入层拒绝
- 开启 `API 自主动作` 后，空闲状态会定期让 API 编排一次小动作

动作链字段：

```json
{
  "chain": [
    { "kind": "expression", "name": "兔牙", "delayMs": 0 },
    { "kind": "motion", "name": "竖手指打开", "closeMotion": "竖手指关闭", "closeAfterMs": 6000 },
    { "kind": "pose", "pose": { "right": "grass", "left": "chest" } },
    { "kind": "look", "x": 0.2, "y": 0.1 }
  ],
  "bubble": "来啦，别戳啦"
}
```

后一次戳会生成新 `runId`，打断上一次动作链的延时步骤。

## 峰谷价

按 DeepSeek 公告规则：

- 工作日 `09:00-12:00`、`14:00-18:00` 为峰价
- 其余工作日时段与周末全天为谷价
- 气泡用红色显示峰价、绿色显示谷价
- 展示 V4-Pro / V4-Flash 的输入/输出与缓存命中价

## UI

- 设置面板独立于角色主体，挂在屏幕右上侧，不遮住模型预览
- 状态徽标与设置齿轮移到角色外侧
- 价格条显示在角色下方，不占用对话气泡
- 右键菜单提供设置、对话、随机动作、切换体型、余额价格

## 自发聊天

- 可开关；开启后：
  - 工作区回到 `attention` 时，把最新助手回复截短后回流成气泡
  - 长时间 `idle` 时按 8~18 秒随机间隔说一句短台词
  - 有 8 秒最小间隔，避免刷屏

## 组成

| 文件 | 作用 |
|---|---|
| `lib/index.js` | 宿主侧：注入行、13 条路由、设置持久化、AI 指令队列 |
| `lib/overlay.js` | 浏览器侧：透明叠加层、拖拽物理、设置面板、AI 执行桥 |
| `assets/renderer.js` | 渲染内核（由 `packages/renderer` 构建，含 Cubism Framework + 内联 shader） |
| `cordis.patch.yml` | bundle patch，把本插件作为 loader entry 插入 profile |

## 安装

```
# 1) 目录链接到 profile（Windows 用 Junction，避免 mklink 权限问题）
#    链接目标：D:\Desktop\DSH-L2D\packages\dsh-l2d-plugin
#    链接位置：%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-l2d

# 2) profile 的 package.json 增加依赖与 bundle
"dsh-l2d": "link:D:/Desktop/DSH-L2D/packages/dsh-l2d-plugin"     // dependencies
"dsh-l2d"                                                         // dsh.profile.bundles

# 3) profile 的 cordis.patch.yml 追加
- insert:
    - id: dsh-l2d
      name: dsh-l2d
      config: {}
```

改完**重启 DSH**（注入表在宿主启动时收集一次，热加载收不到）。

`schemastery` 通过 `node_modules/@deepseek-ai/schemastery` 目录链接复用 profile 共享依赖。

## 路由

| 路径 | 说明 |
|---|---|
| `/dsh-l2d/core.js` | Cubism Core |
| `/dsh-l2d/renderer.js` | 渲染内核 |
| `/dsh-l2d/overlay.js` | 叠加层脚本 |
| `/dsh-l2d/model/*` | 模型静态资源（扩展名白名单 + 防穿越） |
| `/dsh-l2d/settings.json` | GET 读取 / PUT 保存（仅回环可写） |
| `/dsh-l2d/config.json` | 前端所需的非敏感配置（不含 apiKey） |
| `/dsh-l2d/balance.json` | 余额查询（用户自填 Key） |
| `/dsh-l2d/ai-action.json` | 戳一戳 API 动作链（用户自填 Key） |
| `/dsh-l2d/agent-state.json` | 读取最新 DSH 会话状态并聚合成 thinking/working/attention/error/idle |
| `/dsh-l2d/audio/*` | 自定义音效 |
| `/dsh-l2d/ai/call` | POST 下发 AI 指令 |
| `/dsh-l2d/ai/poll` | GET 取走待执行队列 |
| `/dsh-l2d/status.json` | 健康检查 |

## 拖拽

- 容器用 `transform: translate3d()` 定位，逻辑位置与渲染位置分离
- 拖拽目标 1:1 跟手，渲染位置用临界阻尼弹簧收敛
- 松手不追加甩出初速度，因此有惯性滞后但不会飞走

> 参数写入走 `setPreUpdate` 钩子；实际执行点在 Cubism 的
> `saveParameters` 之后、`onLateUpdate` 之前，这是外部参数唯一不会被覆盖的正确窗口。

## AI 工具

宿主侧收到 `POST /dsh-l2d/ai/call` 后入队，浏览器侧 400ms 轮询执行。

```bash
curl -X POST http://127.0.0.1:<port>/dsh-l2d/ai/call \
  -H "Content-Type: application/json" \
  -d '{"name":"l2d_set_expression","args":{"name":"兔牙"}}'
```

可用工具（白名单，其余一律拒绝）：

```
l2d_set_expression   l2d_play_motion     l2d_look_at          l2d_set_pose
l2d_set_parameters   l2d_play_keyframes  l2d_stop_keyframes   l2d_reset_pose
l2d_emote            l2d_gaze            l2d_say              l2d_act
l2d_get_state        l2d_reset
```

MCP 只转发高层那一组（`l2d_emote` / `l2d_gaze` / `l2d_say` / `l2d_act` / `l2d_get_state` / `l2d_reset`，外加表情、动作、姿势），不转发 `l2d_set_parameters` 和 `l2d_play_keyframes`。
动作返回 `skipped` 或 `conflict` 时不要当故障重试。

`l2d_act` 走原来的 `executePokeAction`。`priority` 为 `BACKGROUND` | `NORMAL` | `FORCE`：低优先级不能打断高优先级，同级可以。对话演出和邪神是 `FORCE`，待机视线是 `BACKGROUND`。`POST /ai/result` 的 `result` 只表示受理；`event` 才是 `action-done`（`phase` 为 `start`、`end` 或 `interrupted`）。被挡住时 `reason` 是 `priority-blocked`。

工具定义见仓库 `dist/ai-tools.json`，提示词见 `docs/AI-模型控制提示词.md`。

## 性能

- 目标 30fps（静止 6 秒降 15fps，20 秒降 10fps）
- 窗口失焦 10fps，页面隐藏完全暂停
- 拖拽走合成层，不触发重排
- 静止时不写任何参数、不调 lookAt

## 调试

不启动 DSH 也能测：

```bash
pnpm dev:server          # 127.0.0.1:5300
```

- `/` 渲染调试台（模型/画布/XY 轴眼神控制/能力清单）
- `/overlay-test.html` 原样加载 `lib/overlay.js`，验证拖拽、物理、设置面板

本地服务器会把 `/dsh-l2d/*` 前缀剥离后复用同一套路由，等于复刻了插件环境。


## DSH Workspace Agent

当 DSH profile 同时加载 Workspace Registry 和 Session Controller 时，插件会创建或复用独立的 `Live2D Agent` 工作区：

- 默认目录：`$DSH_HOME/workspaces/live2d-agent`。
- `AGENTS.md`：由 DSH Agent Instructions 加载，定义桌宠 Agent 的职责、MCP 使用方式和只读边界。
- `agent.md`：由插件定期更新的状态快照，只包含其他工作区标题、会话状态与活动时长，不包含聊天文本、文件路径或错误详情。
- 专属 Session 通过 DSH 原生 `sessionController.create({ workspaceId })` 创建，并通过 `sessionController.prompt()` 启动初始化对话。
- 状态变化通过队列消息通知专属 Session；其他工作区不会被写入或控制。
- 新增路由：`POST /dsh-l2d/workspace/ensure`、`GET /dsh-l2d/workspace/status.json`。

MCP Server 新增 `l2d_workspace_ensure` 和 `l2d_workspace_status`。要让专属 Agent 自己调用 Live2D 控制工具，需要按下方配置 DSH MCP Client；本插件不会擅自启动独立 MCP 子进程。

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

