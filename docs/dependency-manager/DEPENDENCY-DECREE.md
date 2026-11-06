# Dependency Update Manager 设计裁决书（实施基准）

> 来源：用户裁决 2026-11-05 18:38。状态：Phase 1 实施中。目标：统一依赖更新与同步机制，**逐包检查、逐包更新，禁全量 `npm update` 上生产分支**。

## 0. 设计目标
检查 npm Registry 最新稳定版 / GitHub Release、Tag、Commit → 兼容性与安全确认 → 事务式更新（备份→安装→测试→通过留痕/失败回滚）。支持指定包、批量、回滚；每次更新记录版本、Commit SHA、执行结果。

## 1. 本仓落点（主理人裁定，偏离裁决书处注明）
- 目录：`tools/dependency-manager/*.mjs`（裁决书为 TS + src/bridge/——本仓 tools 全为 .mjs + node:assert，保持一致，属已注明偏离；模块划分照搬：DependencyManager / NpmRegistry / GitHubRelease / GitRepository / VersionResolver / CompatibilityCheck / UpdateTransaction / RollbackManager）。
- 数据：`data/dependency-manager/dependency-cache.sqlite` + `update-history.sqlite`（node:sqlite，工具本地库，不进 @dsh/db 主库——与 actions-lib 事实源隔离，符合裁决书）。
- 配置：`data/dependency-manager/config.json`（§8 结构：updatePolicy.autoCheck=true / autoInstall=false / requireApproval=true 默认——**检查与安装分离授权**）。

## 2. npm 通道
- 逐包：`npm view <pkg>@latest version` + `npm ls <pkg> --depth=0 --json` 对比；全量扫描用 npm-check-updates 只读模式给建议，不直接 `-u`。
- `npm update` 语义注意：受 package.json 范围限制 ≠ 全部最新；Major/Minor/Patch 分级识别。
- SemVer 兼容性不得用字符串比较糊弄（区分 prerelease、范围、monorepo workspace 依赖）。

## 3. GitHub 通道
- 三场景：Release（gh release list/view/download，生产优先）＞ Tag（git ls-remote --tags / clone --depth 1 --branch）＞ 分支（仅开发用）。
- GitHub 仓库作 npm 依赖：`github:owner/repo#<commit-sha>` **优先 SHA 锁定**（禁跟随 main 导致构建不一致）。
- Token 不写入日志/SQLite 明文（用 git credential / 环境变量，审计记录只存 SHA 与结果）。

## 4. 更新事务（必须先检查再更新）
链路：请求 → Version Resolver → Compatibility & Security Check（SemVer/Node 版本/PeerDeps/许可证/安全公告，audit before update）→ **Update Transaction**（备份 package.json + lockfile → 安装指定版本）→ Verification（build → 单测 → 集成 → smoke）→ PASS 存审计 / FAIL 回滚。
- 并发约束：同一依赖不能被多个工作区同时更新（SQLite 锁或 in-process 互斥，Phase 1 用单进程互斥即可）。
- 未授权时只检查不安装（requireApproval）。

## 5. 与 Bridge 集成（Workspace 07，Phase 2）
NPM Scanner / GitHub Scanner / Compatibility Analyzer / Update Executor / Rollback Manager / Update Reporter 六模块挂 Bridge；Invocation Guard 纪律：版本检查/Git 查询/SQLite 缓存**不消耗 Agent 推理额度**；需 Agent 分析变更时过全局十分钟锁；不绕过用户权限；不改其他工作区私有文件。Dependabot/Renovate 作外部发现源接入（它们发现+建 PR，本 Manager 负责本地兼容分析/测试/审批/回滚）。

## 6. 验收标准（§9 原文）
全量扫描 npm 依赖 ✓ 拉取 npm 最新稳定版 ✓ 读 GitHub Release/Tag/Commit ✓ 安装指定 Commit ✓ 识别 Major/Minor/Patch ✓ 识别 PeerDeps 冲突 ✓ 更新前备份锁文件 ✓ 更新后自动跑测试 ✓ 失败回滚 ✓ 每次更新生成审计记录 ✓ 同依赖互斥 ✓ 未授权只查不装 ✓ Token 不落明文 ✓

## 7. Phase 1 范围（主理人裁定）
NPM 通道全量（scanner/resolver/compat/transaction/rollback/audit/config/CLI `check`+`update`+`rollback` 命令）+ 真实事务测试（临时目录 fixture 项目）；GitHub 通道与 Bridge 集成 = Phase 2。测试形态沿用 node:assert + 手工挂 scripts。
