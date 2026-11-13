# 未完成项清点与处置报告（全库扫描）

- 扫描时间：2026-11-13
- 范围：`packages/` `apps/`（源码区）`tools/` `tests/`，排除 `node_modules`、`dist`
- 扫描手段：TODO/FIXME/XXX/HACK 标记 grep、跳过测试 grep、`deferred/skipped/未实现` 标记 grep、
  全部 9 个测试脚本实跑、MCP 工具表 ↔ 渲染端实现交叉比对
- 结论：**测试层面零失败零跳过**；已修 2 处"标注未做"；剩余项全部需要你决策或环境支持（见 §3）

---

## 1. 已修复（本轮完成）

| 项 | 位置 | 修复内容 |
|---|---|---|
| L4 Execution 恒为 `skipped` | `packages/dsh-l2d-plugin/lib/action-compiler.mjs:290` | 升级为**静态编译验证**：`compileGraphToSegments` 实跑，校验段数 ≤8 / 步数 ≤64 / 步骤类型白名单；pass 时显式注明 `static-compile only`，**不冒充真机验证**（真机结论在 v13 `runtime_verified` 字段）。编译器测试 14→16 项 |
| `l2d_emote` 死工具（静默失败） | MCP `server.mjs:89` 暴露 → 宿主 `/ai/call` 放行 → **渲染端无处理分支** | 新增 `packages/mcp-bridge/unimplemented-tools.mjs` 登记表：宿主在入队前返回 **501** + 三条替代路径（actions/dispatch、l2d_graph_run、l2d_perform）；MCP 工具描述同步标【当前不可用】。测试 4 项，含"渲染端一旦实现必须同步移除登记"的反腐断言 |
| `action-manifest-repo.test.mjs` 版本断言钉死 | `:67` `:73` | 随 v13 迁移改为 `≥12` 下限断言（精确条数由 `db.test.mjs` 的 MIGRATIONS 不变式守） |

---

## 2. 扫描结果：无问题的部分

| 检查 | 结果 |
|---|---|
| 9 个测试脚本（core/types/db/breakpoint/chain15/bridge/supervisor/contract/deps） | **全部 EXIT=0**，无失败用例 |
| 跳过测试（`it.skip` / `test.skip` / `.todo()`） | **0 处** |
| 后端源码 TODO/FIXME | **0 处**（仅文档性引用） |
| `renderer/src/fw/*` 的 HACK/TODO | Cubism 官方框架自带注释（日语），**不属于本仓未完成项，不动** |
| typecheck | `vue-tsc --noEmit` 无诊断 |

---

## 3. 阻塞项（需要你决策 / 环境支持）

### B1 · Phase 4 单队列（双队列收敛）

- **现状**：两个队列并存——`packages/mcp-bridge/action-queue.mjs`（`bridge_actions`，requestId 幂等，持久化）与 `packages/dsh-l2d-plugin/lib/ai-inbox.mjs:39,231,259`（内存队列，maxQueue=32，批量下发）。
- **阻塞原因**：`ai-inbox` 的**批量下发**直接决定 overlay 演出节奏（一次 tick 吐多段）。把它降为纯执行器会让动作时序变成逐段串行，在没有宿主真机的情况下无法验证演出效果不被破坏；而"看起来成功、实际演出乱了"正是本仓最忌讳的假绿。
- **位置**：`ai-inbox.mjs:39/231/259`、`action-queue.mjs`、消费点 `packages/renderer/src/index.ts`（演出侧）。
- **可选方案**：
  - **(a) 推荐**：开独立一轮，`DSH_SINGLE_QUEUE=1` 灰度开关（默认关），dispatch 路径先切单队列，`/ai/call` 通道保留批量；真机时窗里对照两模式的演出录制。
  - (b) 接受双队列长期并存，但把文档口径改成"两类队列管辖不同层"（bridge=请求生命周期，inbox=渲染批次）——承认现状，停止收敛。
  - (c) 只把 `bridge_actions` 作为**账本**（所有通道都记账），队列语义不动——最便宜，但"单权威"目标放弃。

### B2 · `l2d_emote` 真实现（现在只是诚实失败）

- **现状**：调用返回 501 + 替代路径（不再是静默失败）。
- **阻塞原因**：真实现需要渲染端新增 `l2d_emote` 指令分支（受保护层），且情绪→表情映射需要真实模型窗口验证效果。
- **可选方案**：
  - (a) 维持 501（现状，零风险）；
  - (b) 渲染端实现"情绪→表情白名单查表"（纯映射、无 LLM），需要时窗验证表情观感；
  - (c) 走已发布动作：登记 `emote.<mood>` 触发器 → `actions/dispatch`（编译期决定情绪对应哪个程序，运行期零决策）——**与 One-shot 架构最契合**，但依赖已发布动作库。

### B3 · stage-web 前端 4 组 TODO（接口边界占位）

| 位置 | TODO 内容 | 可行性 |
|---|---|---|
| `ChatArea.vue:5,19,32,48,55`、`App.vue:21` | 对话服务未接入，消息列表占位 | **阻塞：宿主没有对话服务端点**。需要先决定对话服务归属（本仓新增，还是复用 whale-workspace 的通道） |
| `CompanionSidebar.vue:6,16,63,67` | 最近对话/账号体系占位 | 同上，依赖对话持久化服务是否立项 |
| `PluginCenterView.vue:7,80,99-100` | 插件启停/调用按钮禁用 | **可接线**：`/dsh-l2d/ai/call` 已存在；但"启停"需要宿主插件生命周期接口（`/dsh-l2d/plugins/...`），需确认宿主是否已提供 |
| `SettingsPanel.vue:69,241` | 连接项仅存 localStorage，"运行时写入通道未接通" | **半可接线**：`/dsh-l2d/settings.json` 读写路由已存在；但宿主**是否消费** `endpoint/transport` 字段未知——贸然接上会变成假"已生效"，违反本仓"不伪造可用"纪律。需先确认宿主对这两个字段的真实消费方 |

### B4 · Phase 6 真机验收（环境阻塞）

- 探针 `tools/runtime-probe/oaca-dispatch-acceptance.mjs` 就绪且经 QA mock 复算；本机 5300/5173/3000/8080/5301/5302/8888 全部 `ECONNREFUSED`。
- 需要你：启动宿主 → `clickMode=nodegraph` → 给出端口与桌面时窗（角色会真实动一次）。

### B5 · 待人工确认的两个疑似死工具（本轮不敢判死）

- `l2d_change_form` / `l2d_set_form`（MCP 暴露，渲染端源码 grep 不到同名分支）。渲染端指令分发点藏在 `packages/renderer/src/index.ts`（千行级文件，无按名 switch），无法静态确证。**验证方法**：真机跑一次这两个工具，看角色是否换装；或由熟悉渲染层的人指出消费点。

---

## 4. 建议的决策清单（勾选即可执行）

| # | 决策 | 影响 |
|---|---|---|
| 1 | Phase 4 选 (a)/(b)/(c) | (a) 需 1 轮开发 + 真机时窗；(c) 半天 |
| 2 | `l2d_emote` 选 (a)/(b)/(c) | (b)(c) 需真机时窗 |
| 3 | 对话服务归属（stage-web TODO 根因） | 决定前端 2 组 TODO 是否立项 |
| 4 | 是否授权真机时窗跑 Phase 6 | 关闭唯一硬缺口 |
| 5 | `l2d_change_form`/`l2d_set_form` 死活确认方式 | 真机实测 / 指认消费点 |
