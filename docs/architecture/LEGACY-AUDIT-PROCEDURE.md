# Legacy Runtime Dependency Audit 步骤（v2，用户审定版）

- 来源：用户设计反馈（2026-11-13），取代首版手工流程
- 现状：**Phase 0 的静态部分已完成**（`tools/legacy-audit/audit.mjs` + `audit.json`），
  本文件是它的**扩充规程**——补齐动态引用 grep、运行时入口追踪、数据/配置依赖与验证闸门。
- 执行原则：先断入口，跑测试，再删文件，**每批单独提交**。

## 0. 冻结基线
- 打 tag，跑一遍全量测试，记录通过数作为对照
- 当前基线：分支 `feat/pr1-action-session`，9 个测试脚本全绿（bridge/db/core/typecheck 及
  types/breakpoint/chain15/supervisor/contract/deps 均 EXIT=0）

## 1. 建立目标清单
P0/P1/P2 候选（与 `audit.json` 一致）：`planner/`、`cue-loop.ts`、`embodied-cue.ts`、
`motion-intent.ts`、`semantic-binding.ts`、`workspace-agent.mjs`、`context-analyzer.mjs`、
`choreography.mjs`、`llm-channel.mjs`、`ai-inbox.mjs`

## 2. 静态依赖图
- 已有：`tools/legacy-audit/audit.mjs`（自研 import 图解析 + 运行期入口 BFS）
- 补充（待做）：动态引用 grep——`import(`、`require(`、字符串形式的模块名、
  工具名（`l2d_emote`、`l2d_act`）
- ⚠ 教训：工具名判定必须含 `packages/dsh-l2d-plugin/lib/overlay.js`（浏览器侧消费层，
  曾因漏扫它把 `l2d_emote` 误判为死工具）

## 3. 运行时入口追踪
列出 MCP 工具（server.mjs registerTool 表）、HTTP 路由（`/ai/call`、`/api/actions/*` 等）、
事件监听，标注各自落到哪个候选模块。
注意三类直达端点不走 `/ai/call`：`/dsh-l2d/workspace/ensure`、进程内读库的
`l2d_toolchain_status`、物化图的 `/dsh-l2d/nodegraphs/run`。

## 4. 数据与配置依赖
查 SQLite 表和字段（v14 后共 49 张）、配置项、迁移脚本中引用旧概念的地方。
已确认的数据依赖：`action_chains/action_steps`（旧 Lib，可冻结写入）、
`trigger_map`（v14 新增，触发映射）。

## 5. 测试依赖
标记只服务旧行为的测试，以及间接依赖候选文件的测试。
已知：`core/test/motion-planner.ts` 独占 planner（planner 因此是 retire-with-test）。

## 6. 分类打标
- `可直接删`：无引用（当前审计结果：**0 项**）
- `需迁移`：有价值逻辑（语义映射、数学算法、安全规则）——`semantic-binding` 属此类，
  迁到导入期生成 trigger_map 映射
- `需替代入口`：仍有调用方，先提供新路径（当前 9 项 detach-first）
- `保留`：被 Renderer/Bridge 核心依赖（`llm-channel`/`ai-inbox`/`nodegraph-ai` 为
  keep-with-boundary）

## 7. 输出产物
- 文件级删除清单（路径、引用方、处置、风险、回滚方式）→ `audit.json` 已含前四列，
  回滚方式 = 分批提交逐批 revert
- 迁移清单（逻辑 → 导入期编译器或 `trigger_map`）
- 删除顺序：**先断入口（DSH_LEGACY_RUNTIME=off），观察计数归零，跑测试，再删文件**

## 8. 验证闸门
每批删除后：
- Renderer、Node Editor、MCP 测试全绿
- 抓包确认运行期无 LLM 请求（`/api/metrics` 的 `runtimeLlmCallCount` 增量 = 0，
  或 tcpdump/wireshark 过滤 DeepSeek 域名）
- `legacyDecisionCount` 与 `legacyBlockedCount` 快照前后一致
