# 本地自主反应器（动态动作规划）

## 定位

本模块是 **本地自主反应器**：由插件事件（工作区会话状态变化、autoAct 空闲脉冲）触发，
用自己的 DeepSeek API Key 规划一段低风险的高层动作，经严格校验后通过既有 `l2d_act`
队列执行，并根据执行回执决定是否续规划。

边界（有意为之）：

- **不读 DSH 会话内容**：不上传用户/助手文本、工具名、错误详情，也不推断对话意图。
- **不承担人设/编剧职责**：语气、人设、剧情由更上层（L1 人设层）负责；更高层动作编排
  走 PR #8 的 `l2d_choreograph`，本模块只做"本地即时反应"。
- **不写底层参数**：只允许 expression / motion / pose / look 四种高层动作，禁止 keyframes
  与任何 Cubism 参数名。

## 运行流程

1. Overlay 轮询 `/dsh-l2d/agent-state.json`，仅在状态变化时触发规划；空闲自动动作沿用
   `autoAct` 开关，且离席（away）期间不触发。
2. Overlay 读取当前模型能力白名单（表情、动作组），把**工作区状态 + 上一段执行回执**
   提交到 `/dsh-l2d/agent-plan.json`（不含任何会话文本）。
3. Host 使用用户配置的 DeepSeek API Key 请求动作计划。
4. `action-planner.mjs` 严格校验：最多 6 步、估算时长不超过 10 秒、只允许四种高层动作，
   表情/动作必须存在于当前模型能力表；未知或部分非法一律 fail-closed。
5. Host 用 `aiInbox.call('l2d_act', ...)` 入队；Overlay 走与 MCP 相同的
   `DSH_L2D_AI.exec('l2d_act')` 执行路径。
6. `continue=true` 时，运行时等待该链终态回执（end/interrupted），把 outcome/reason/notes
   作为下一次规划的回执上下文；最多连续 3 段。
7. admission 阶段的 `conflict` 可触发下一段重规划；`priority-blocked`、渲染未就绪、
   API 错误和非法计划不会无限重试。

## 安全边界

- 只接受 expression / motion / pose / look；keyframes、参数名、口型参数全拒。
- 不存在于当前模型能力表的表情/动作组直接拒绝，不会自动替换成默认动作。
- 未知步骤、部分非法步骤、超过 6 步、超过 10 秒均 fail-closed。
- 动作优先级由程序决定：attention/error 为 NORMAL，其余 BACKGROUND；模型不能自行提升。
- 连续规划最多 3 段；单次计划生成有并发门与 900ms 冷却。
- 发给模型的只有：工作区状态（idle/thinking/working/attention/error）、segment、
  上一段 rationale 与执行回执（outcome/reason/notes）。不含会话正文。
- 关闭 `agentLink` 或 `autoAct` 后停止新的自主计划；环境感知层进入 away 时不触发。

## 测试

```bash
node packages/dsh-l2d-plugin/lib/action-planner.test.mjs
pnpm test:core
```

Overlay/Host 端到端验证需要启动 DSH、打开可见 Live2D 页面并配置 DeepSeek Key：

- 触发 thinking / working / attention / error，确认自动请求并执行动态链。
- 看 `/ai/result` 的 start/end/interrupted 回执，确认 continue=true 时最多续规划两次。
- 人为制造右臂动作冲突，确认收到 conflict 后重规划；priority-blocked 不循环重试。
- 关闭 `autoAct` / `agentLink`，或进入 away，确认不再请求模型/入队动作。
- 确认请求体里没有 lastUserText / lastAssistantText / lastTool / lastError 等会话字段。
