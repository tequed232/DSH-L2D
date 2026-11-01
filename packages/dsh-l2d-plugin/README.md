# dsh-l2d — DSH 插件

在 DeepSeek Harness 界面之上叠加一层透明 Live2D 角色。**真实 Cubism 5 渲染**（官方 Web SDK 5-r.5），
支持表情/动作/四肢姿势、AI 工具调用、余额查询与峰谷价提示、戳一戳动作链、大小调节、自发聊天和工作区会话状态联动。

> 拖拽惯性物理已按用户要求移除：当前拖拽是最稳定的 1:1 跟手，不会飞走。

## 交互

| 操作 | 行为 |
|---|---|
| 单击角色 | 戳一戳动作：随机动作链，或让 DeepSeek 决定表情/动作/姿势/视线（设置里选） |
| 悬停角色 | 显示余额 + 当前 DeepSeek API 峰/谷计费（红绿标识） |
| 拖动角色 | 1:1 跟手搬位置 |
| 底部小徽标 | 切换待机/对话/工作状态 |

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

- 容器用 `transform: translate3d()` 定位 —— 只改合成层，不触发布局重排
- 样式写入合并到每帧一次
- 惯性/弹簧/甩出回摆已移除，避免“一点/一拖就飞走”

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
l2d_set_expression   l2d_play_motion     l2d_look_at
l2d_set_parameters   l2d_play_keyframes  l2d_stop_keyframes   l2d_reset_pose
```

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
