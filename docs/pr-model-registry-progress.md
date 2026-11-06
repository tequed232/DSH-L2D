# feat/model-registry → main 进度汇总 PR

> 性质：**滚动进度 PR**（用户授权多 PR 通报进度），非最终合并评审——最终合并顺序仍按既有裁决（node-ownership-action-cache 栈优先审查）。
> Base 上历史说明：本分支含 PR #24（DS-Bot UI/UX Modernization）之后的全部主干工作。

## 包含内容（按里程碑）

### 1. MCP Bridge 三阶段（PR-A/B/C，B01-B18 全绿）
- `329e2f0` PR-A：bridge_workspaces v7 迁移 + WorkspaceManager 幂等创建/恢复 + 双会话 + LocalMirrorChatMemorySource（含 SCHEMA_VERSION 4↔6 漂移缺陷修正）
- `5d8a7d1` PR-B：StatusReporter（30-120s 强校验/revision 去重/失败不推进）+ l2d_action_enqueue/status/cancel 三工具 + Scope 白名单隔离
- `da99605` PR-C：bridge_actions v8 + ModelActionQueue（FIFO/幂等/FAULTED/背压32/重启 interrupted 不重放）+ HttpActionExecutor（复用 ai-inbox callId 结果路径）
- 测试：32 项桥接用例 + 100/100 连续验收（峰值并发 1、零重叠）+ db 17 项回归

### 2. 基础设施
- `700f286` dev-server 监听地址可配（DSH_HOST，云部署 0.0.0.0）
- 断点实验工程（真实子进程 SIGKILL，13/13）与 Action Cache bench（前置栈，随分支合入）

### 3. 进行中（随里程碑追加）
- [ ] SUPERVISOR-P12：Workspace Observer + Local Action Matcher + v9 observer_dispatch_log
- [ ] BOOTSTRAP-PHASE0 文档套件（GAP/DATA-MODEL/TEST-PLAN）
- [ ] UI-FLOAT：响应式浮动设置窗 + 全局设置入口 + 调试窗移除
- [ ] DEP-MGR-1：Dependency Update Manager Phase 1（npm 通道）

## 设计基准文档
- docs/mcp-bridge/BRIDGE-DESIGN.md（桥接总契约）
- docs/mcp-bridge/SUPERVISOR-DECREE.md（五工作区裁决）
- docs/mcp-bridge/BOOTSTRAP-DECREE.md（Bootstrap & Semantic Action Registry 裁决）
- docs/dependency-manager/DEPENDENCY-DECREE.md
- docs/ui/RESPONSIVE-SETTINGS-WINDOW.md

## 测试命令
```
pnpm test:db && pnpm test:bridge && pnpm test:breakpoint && pnpm -F @dsh/stage-web typecheck
```

## 已知未决
- PR 创建语义：动作完成信号仍为时长预估、释放确认为 TTL 宽限（PR-D：Runtime 层真实 Timeline 事件）
- Bot_Server（121.40.125.77:5319）已部署 systemd 常驻，公网安全组已放行
