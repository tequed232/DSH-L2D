# Agent 自主动作链（动态规划）

## 目标

让 DSH-L2D 根据最近的工作区事件和有限的对话上下文动态生成动作链，由插件运行时自动调用既有的 `l2d_act`，并根据动作执行回执决定是否继续规划下一段。

这不是把 LLM 变成 Live2D 参数写入器。模型只输出高层动作意图，程序负责校验、入队、执行仲裁和终止。

## 运行流程

1. Overlay 轮询 `/dsh-l2d/agent-state.json`，仅在状态变化时触发规划；空闲自动动作沿用 `autoAct` 开关。
2. Overlay 读取当前模型能力白名单（表情、动作组），将状态、最近用户/助手文本（各最多 500 字）、工具名、错误摘要和可选执行回执提交到 `/dsh-l2d/agent-plan.json`。
3. Host 使用用户配置的 DeepSeek API Key 请求动作计划。
4. `action-planner.mjs` 严格校验计划：最多 6 步、估算时长不超过 10 秒，只允许 expression / motion / pose / look，表情和动作必须存在于当前模型能力表。
5. Host 将已校验的计划通过 `aiInbox.call('l2d_act', ...)` 入队；Overlay 的现有 AI poll 消费队列，调用与 MCP 相同的 `DSH_L2D_AI.exec('l2d_act')` 执行路径。
6. 如果模型将 `continue` 设为 true，运行时等待该动作链的终态回执，再把 outcome/reason/notes 作为下一次规划上下文。最多连续 3 段。
7. admission 阶段的 `conflict` 可触发下一段重新规划；`priority-blocked`、渲染未就绪、API 错误和非法计划不会无限重试。

## 安全边界

- 不允许模型输出 Cubism 参数、关键帧轨道或口型参数；自主计划只接受四种高层动作。
- 不存在于当前模型能力表的表情/动作组直接拒绝，不会自动替换成默认动作。
- 未知步骤、部分非法步骤、超过 6 步和超过 10 秒的计划均 fail-closed。
- 动作优先级由程序按状态决定：attention/error 为 NORMAL，其余为 BACKGROUND；模型不能自行提升优先级。
- 连续规划最多 3 段；单次计划生成有并发门和冷却。
- 发送给 DeepSeek 的是当前状态及最近两条文本摘要，不上传完整 session 文件或历史对话。
- 关闭 `agentLink` 或 `autoAct` 后，新的自主计划停止。

## 测试

```bash
node packages/dsh-l2d-plugin/lib/action-planner.test.mjs
pnpm test:core
```

Overlay/Host 的端到端验证还需要启动 DSH、打开可见 Live2D 页面并配置 DeepSeek Key。GitHub 远端提交本身无法证明桌面运行时的动作回执闭环；需要在本机完成下面的人工验收：

- 触发 thinking / working / attention / error 状态，确认自动请求并执行动态链。
- 观察 `/ai/result` 的 start/end/interrupted 回执，确认 continue=true 时最多续规划两次。
- 人为制造右臂动作冲突，确认收到 conflict 后重新规划；priority-blocked 不应循环重试。
- 关闭 `autoAct` 或 `agentLink`，确认不会继续请求模型或入队动作。
