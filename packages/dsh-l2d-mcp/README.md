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
| `l2d_act` | 一小段 expression / motion / pose / look 序列 |
| `l2d_get_state` | 只读快照，并附上余额查询结果 |
| `l2d_reset` | 清姿势、表情、注视 |

没有 `l2d_set_parameters`，也没有 `l2d_play_keyframes`。

这个包不会去改 `~/.dsh/l2d-settings.json`。`systemSensor` 和 `mediaSensor` 保持默认关闭，只能在角色设置面板里打开。

返回都是 JSON 文本：`{ "ok": true, ... }` 或 `{ "ok": false, "reason": "..." }`。
