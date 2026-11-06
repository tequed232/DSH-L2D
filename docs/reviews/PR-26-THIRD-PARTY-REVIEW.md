# PR-26 第三方验证 · 初审报告（PR-26-THIRD-PARTY-REVIEW）

> 对应 PR #26 评论区第三方验证要求（2026-11-05）。本文为开发侧对验证基线的**诚实自查**（初审），非 APPROVE。逐项终裁待独立复测。
> 配套：docs/reviews/ACCEPTANCE-MATRIX.md（六域矩阵 + 必测故障覆盖度）。

## 一、对验证原则的采纳确认
1. 完成声明不算证据 → 矩阵只引用测试命令与产物（acceptance-report.json、隔离 worktree 复跑记录、截图落盘）。
2. accepted/validated/runtime_verified 三分 → 严格区分：现有 100 连续验收属 accepted+validated 层；**runtime_verified 全线未设**（Timeline 事件层缺失，PR-D 待办）。
3. 无 UI 占位/模拟/时长估算冒充真实能力 → 已知如实项：动作完成信号为 lifeMs 时长预估（侦察实证），已标 BLOCKED 而非通过；情境预览等 UI 占位均带 TODO 标注。
4. 配饰节点不托管 → 已验证（breakpoint-lab accessory-exclusion + whitelist 端到端取证），维持 Node Ownership 白名单纪律。
5. 全部写入经 Renderer → ParamInjector → Physics Output Gate → 安全路径未新增旁路（runtime 通道为 UI 本地交互域，口型红线与物理输出保护不变）。

## 二、初审裁决摘要（详见矩阵）
| 域 | 初审 | 关键依据 / 缺口 |
|---|---|---|
| Runtime Timeline | BLOCKED | 无真实事件源（PR-D） |
| Observer + Supervisor | UNVERIFIED | P12 实施中未落库 |
| SQLite / Action Cache | VERIFIED（中断/恢复/幂等）+ PARTIAL（并发/失效接线） | breakpoint-lab 13/13 + 三套单测全绿 |
| Safety Guard / Adapter | VERIFIED | 白名单 8 ID + accessory-exclusion + 端到端取证 |
| Dependency Manager | UNVERIFIED | Phase 1 实施中 |
| UI-FLOAT | PARTIAL | 基础浮窗 17/23 实测；③④未落地 |

## 三、修复与复测计划
1. CODE-REVIEW-1 修复中：中级 4 条已修（0ca6d21），低级 13 条按文件分批（21:20 前）。
2. P12 / DEP-MGR-1 / UI-FLOAT③④ 收口后，按矩阵 UNVERIFIED 项逐条补证据。
3. PR-D（Runtime Timeline 真实事件）为解锁域 1 与端到端链路的前置，列入下一里程碑首位。
4. 每项修复：commit + 测试命令 + 原始输出 → 第三方复测 → 矩阵更新终裁状态。

## 四、需第三方明确的裁决点
1. 「Runtime 层补事件」属新开发而非缺陷修复——BLOCKED 状态是否接受以其独立里程碑推进？
2. 隔离 worktree 复跑（node --experimental-sqlite）是否满足「可复现运行记录」，还是要求 CI 化？
3. 6 项伪失败用例（Chromium 视口外鼠标丢弃）重写后是否可作为 UI-FLOAT 域 VERIFIED 依据？
