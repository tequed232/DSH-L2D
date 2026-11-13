# Legacy Runtime Dependency Audit（Phase 0 产物）

- 生成时间：2026-11-13T13:08:41.562Z
- 生成器：`tools/legacy-audit/audit.mjs`（解析真实 import 图 + 从运行期入口 BFS）
- 判定口径：`detach-first` 先关入口、`keep-import-time` 保留（编译期资产）、`delete-safe` 可删

## 1. 总表

| 目标 | 层级 | 运行期可达 | Renderer 引用 | 运行期引用数 | 导入期引用 | 测试引用 | 判定 |
|---|---|---|---|---|---|---|---|
| `core.planner` | P0 | 否 | 否 | 0 | 0 | 1 | **retire-with-test** |
| `core.cue-loop` | P0 | 是 | **是** | 3 | 0 | 1 | **detach-first** |
| `core.embodied-cue` | P0 | 是 | **是** | 4 | 0 | 3 | **detach-first** |
| `core.motion-intent` | P0 | 是 | 否 | 4 | 0 | 1 | **detach-first** |
| `core.semantic-binding` | P0 | 是 | 否 | 2 | 0 | 1 | **detach-first** |
| `plugin.workspace-agent` | P0 | 是 | 否 | 1 | 1 | 1 | **detach-first** |
| `plugin.context-analyzer` | P0 | 是 | 否 | 1 | 0 | 2 | **detach-first** |
| `plugin.choreography` | P1 | 是 | 否 | 8 | 1 | 1 | **detach-first** |
| `core.continuous-action` | P1 | 是 | 否 | 1 | 0 | 1 | **detach-first** |
| `plugin.llm-channel` | P1 | 是 | 否 | 1 | 1 | 0 | **keep-with-boundary** |
| `plugin.nodegraph-ai` | P1 | 是 | 否 | 2 | 0 | 1 | **keep-with-boundary** |
| `plugin.ai-inbox` | P1 | 是 | 否 | 1 | 1 | 1 | **keep-with-boundary** |
| `renderer.cue-bridge` | P1 | 是 | **是** | 1 | 0 | 1 | **detach-first** |

## 2. 逐项证据

### core.planner（P0）· retire-with-test

- 路径：`packages/core/src/planner`（6 个文件）
- 理由：无运行期路径，仅被 1 个测试引用：删实现时同步删/改测试
- 测试引用：`packages/core/test/motion-planner.ts`
- 依赖：`packages/core/src/motion-contract.ts`

### core.cue-loop（P0）· detach-first

- 路径：`packages/core/src/cue-loop.ts`（1 个文件）
- 理由：被 Renderer 层引用：先降级该通道（保留接口、清空决策），再谈删除
- 运行期引用：`packages/core/src/index.ts`, `packages/renderer/src/app/cue-bridge.ts`, `packages/renderer/src/index.ts`
- 测试引用：`packages/core/test/cue-loop.ts`
- 依赖：`packages/core/src/embodied-cue.ts`, `packages/core/src/motion-contract.ts`

### core.embodied-cue（P0）· detach-first

- 路径：`packages/core/src/embodied-cue.ts`（1 个文件）
- 理由：被 Renderer 层引用：先降级该通道（保留接口、清空决策），再谈删除
- 运行期引用：`packages/core/src/cue-loop.ts`, `packages/core/src/index.ts`, `packages/renderer/src/app/cue-bridge.ts`, `packages/renderer/src/index.ts`
- 测试引用：`packages/core/test/cue-loop.ts`, `packages/core/test/embodied-cue.ts`, `packages/renderer/src/app/cue-bridge.test.mjs`
- 依赖：`packages/core/src/gesture-timeline.ts`, `packages/core/src/motion-contract.ts`, `packages/core/src/shared-arbitration.ts`

### core.motion-intent（P0）· detach-first

- 路径：`packages/core/src/motion-intent.ts`（1 个文件）
- 理由：运行期可达（4 个运行入口引用）：先关调用入口、观察命中为 0，再删文件
- 运行期引用：`packages/core/src/index.ts`, `packages/core/src/limb-controller.ts`, `packages/core/src/semantic-binding.ts`, `packages/core/src/write-plan.ts`
- 测试引用：`packages/core/test/motion-contract.ts`
- 依赖：`packages/core/src/mixer.ts`, `packages/core/src/motion-contract.ts`

### core.semantic-binding（P0）· detach-first

- 路径：`packages/core/src/semantic-binding.ts`（1 个文件）
- 理由：运行期可达（2 个运行入口引用）：先关调用入口、观察命中为 0，再删文件
- 运行期引用：`packages/core/src/index.ts`, `packages/core/src/posture.ts`
- 测试引用：`packages/core/test/semantic-binding.ts`
- 依赖：`packages/core/src/motion-contract.ts`, `packages/core/src/motion-intent.ts`

### plugin.workspace-agent（P0）· detach-first

- 路径：`packages/dsh-l2d-plugin/lib/workspace-agent.mjs`（1 个文件）
- 理由：运行期可达（1 个运行入口引用）：先关调用入口、观察命中为 0，再删文件
- 运行期引用：`packages/dsh-l2d-plugin/lib/index.js`
- 导入期引用：`tools/persona-effect-demo.mjs`
- 测试引用：`packages/dsh-l2d-plugin/lib/workspace-agent.test.mjs`
- 依赖：`packages/dsh-l2d-plugin/lib/choreography.mjs`, `packages/dsh-l2d-plugin/lib/env-state.mjs`, `packages/dsh-l2d-plugin/lib/persona.mjs`, `packages/dsh-l2d-plugin/lib/workspace-snapshot.mjs`

### plugin.context-analyzer（P0）· detach-first

- 路径：`packages/dsh-l2d-plugin/lib/context-analyzer.mjs`（1 个文件）
- 理由：运行期可达（1 个运行入口引用）：先关调用入口、观察命中为 0，再删文件
- 运行期引用：`packages/dsh-l2d-plugin/lib/index.js`
- 测试引用：`packages/dsh-l2d-plugin/lib/context-analyzer.test.mjs`, `packages/dsh-l2d-plugin/lib/workspace-agent.test.mjs`
- 依赖：`packages/dsh-l2d-plugin/lib/session-events.mjs`

### plugin.choreography（P1）· detach-first

- 路径：`packages/dsh-l2d-plugin/lib/choreography.mjs`（1 个文件）
- 理由：运行期可达（8 个运行入口引用）：先关调用入口、观察命中为 0，再删文件
- 运行期引用：`packages/dsh-l2d-mcp/src/action-sequence.mjs`, `packages/dsh-l2d-mcp/src/server.mjs`, `packages/dsh-l2d-mcp/src/validate.mjs`, `packages/dsh-l2d-plugin/lib/host-guard.mjs`, `packages/dsh-l2d-plugin/lib/nodegraph-schema.mjs`, `packages/dsh-l2d-plugin/lib/nodegraph-templates.mjs`, `packages/dsh-l2d-plugin/lib/nodegraph.mjs`, `packages/dsh-l2d-plugin/lib/workspace-agent.mjs`
- 导入期引用：`tools/act-choreo/index.mjs`
- 测试引用：`packages/dsh-l2d-plugin/lib/choreography.test.mjs`
- 依赖：`packages/dsh-l2d-plugin/lib/param-guards.mjs`

### core.continuous-action（P1）· detach-first

- 路径：`packages/core/src/continuous-action.ts`（1 个文件）
- 理由：运行期可达（1 个运行入口引用）：先关调用入口、观察命中为 0，再删文件
- 运行期引用：`packages/core/src/index.ts`
- 测试引用：`packages/core/test/continuous-action.ts`

### plugin.llm-channel（P1）· keep-with-boundary

- 路径：`packages/dsh-l2d-plugin/lib/llm-channel.mjs`（1 个文件）
- 理由：运行期入口引用 1 处：保留文件，需确认它只出现在编译/执行通道、不参与行为决策
- 运行期引用：`packages/dsh-l2d-plugin/lib/index.js`
- 导入期引用：`tools/dev-server/index.mjs`

### plugin.nodegraph-ai（P1）· keep-with-boundary

- 路径：`packages/dsh-l2d-plugin/lib/nodegraph-ai.mjs`（1 个文件）
- 理由：运行期入口引用 2 处：保留文件，需确认它只出现在编译/执行通道、不参与行为决策
- 运行期引用：`packages/dsh-l2d-plugin/lib/nodegraph-api.mjs`, `packages/dsh-l2d-plugin/lib/nodegraph-planner.mjs`
- 测试引用：`packages/dsh-l2d-plugin/lib/nodegraph-ops.test.mjs`
- 依赖：`packages/dsh-l2d-plugin/lib/nodegraph-ops.mjs`, `packages/dsh-l2d-plugin/lib/nodegraph-schema.mjs`

### plugin.ai-inbox（P1）· keep-with-boundary

- 路径：`packages/dsh-l2d-plugin/lib/ai-inbox.mjs`（1 个文件）
- 理由：运行期入口引用 1 处：保留文件，需确认它只出现在编译/执行通道、不参与行为决策
- 运行期引用：`packages/dsh-l2d-plugin/lib/index.js`
- 导入期引用：`tools/dev-server/index.mjs`
- 测试引用：`packages/dsh-l2d-plugin/lib/ai-inbox.test.mjs`

### renderer.cue-bridge（P1）· detach-first

- 路径：`packages/renderer/src/app/cue-bridge.ts`（1 个文件）
- 理由：被 Renderer 层引用：先降级该通道（保留接口、清空决策），再谈删除
- 运行期引用：`packages/renderer/src/index.ts`
- 测试引用：`packages/renderer/src/app/cue-bridge.test.mjs`
- 依赖：`packages/core/src/cue-loop.ts`, `packages/core/src/embodied-cue.ts`, `packages/core/src/gesture-timeline.ts`

## 3. 按判定分组的行动项

- **retire-with-test**：core.planner
- **detach-first**：core.cue-loop, core.embodied-cue, core.motion-intent, core.semantic-binding, plugin.workspace-agent, plugin.context-analyzer, plugin.choreography, core.continuous-action, renderer.cue-bridge
- **keep-with-boundary**：plugin.llm-channel, plugin.nodegraph-ai, plugin.ai-inbox

