# DSH-L2D Skill 框架与三工作区引导 · Phase 0 审计与技术差距报告

> 阶段：Phase 0（只审计、不实施）。
> 日期：2026-11-04。总控：DSV4.1f。主导者绑定（本次会话确认）：前端 GLM / 后端 MiMo / 模型调试 GLM / 验收 DSV4.1f。
> 方法：只读本地仓库与远端 GitHub，不靠记忆、不猜接口。所有结论附证据位置。

## 0. 结论摘要（五句话）

1. **远端 Skill 提交已核验为真**：commit `3d273cb`（`feat(skills): add Live2D model intelligence skill`，SKILL.md v2.1.0）确实存在于 GitHub `main`（2026-11-04T03:50:15Z，父提交 `3163252`）。本地 fetch 因 Windows schannel TLS 吊销检查失败（`CRYPT_E_NO_REVOCATION_CHECK`）拿不到它，需先修 fetch 通道再同步。
2. **三工作区所需宿主能力全部已有真机验证过的实现**：`workspaceRegistry.create` / `sessionController.create({agentPreset})` / `controller.prompt` / AGENTS.md 提示词注入 / preset 级 MCP 绑定 / manifest 持久化 + 按 ID 恢复。**不需要发明任何新 DSH API**，框架应在现有 `workspace-agent.mjs` 模式上泛化。
3. **"启动门禁"必须与已评审的《启动优先级与Live2D延迟加载方案》(#13) 调和**：Skill / 工作区 / 工具链检查属 P1（后台、不阻塞注册），门禁只拦 P2（模型加载）。若把门禁做成阻塞 P0，会重新引入该文档明确禁止的"启动卡死"问题。
4. **Skill 的"被 Agent 实际执行"状态不可直接观测**：宿主没有 skill-load 概念，Skill 是提示词层资产。"已加载"只能验证到：文件有效 → 已注册 → 已注入对应工作区 AGENTS.md → MCP 工具可调用；"实际执行"只能靠回执/日志间接佐证。原任务书里的"第四态"须降级为间接验证并如实报告。
5. **仓库当前没有任何 SQLite / 模型注册表**：model-intelligence Skill 的 Phase 6（SQLite 注册）无现有库可复用，需新建带迁移的版本化 schema——这是工作量最大的新增项之一。

## 1. Git 与远端状态

| 项 | 现状 | 证据 |
|---|---|---|
| 本地分支 | `feat/m1-d2-gesture-wiring`（M1 手臂物理工作线） | `git rev-parse --abbrev-ref HEAD` |
| 本地 skills/ 目录 | **不存在** | `ls skills` → No such file |
| 远端 main HEAD（本地缓存） | `3163252 docs(startup): define non-blocking plugin bootstrap and lazy Live2D loading (#13)` | `git log origin/main` |
| 目标 Skill 提交 | `3d273cb` 存在于远端 main，**晚于本地缓存的 main 一个提交** | GitHub API `commits/3d273cb`：files=1（`skills/dsh-l2d-model-intelligence/SKILL.md`），message 与任务书一致 |
| fetch 阻塞 | `schannel: CRYPT_E_NO_REVOCATION_CHECK`（证书吊销检查失败，非鉴权问题） | `git fetch origin main` stderr |
| 未跟踪文件 | `docs/DSH-L2D-攻坚组团队章程.md`（团队章程，待入库） | `git status --short` |

**处置建议（D1）**：仓库级设置 `git config http.schannelCheckRevoke false`（仅影响本仓库 TLS 吊销检查，属网络环境修正而非安全降级到禁验），随后 `git fetch origin main` 同步；或继续用 GitHub API 核验。同步前不得开工任何分支，避免在过期 main 上分叉。

**远端 SKILL.md frontmatter 已核验**（GitHub raw 抓取原文）：`name: dsh-l2d-model-intelligence`、`version: 2.1.0`、description 完整；正文含 Mission / 原则 / Phase 0-7 / MCP 工具清单 / 错误恢复 / DoD，章节完整度高于任务书最低要求，可作为后续三份 SKILL.md 的契约样板。

## 2. 宿主能力对照表（三工作区框架视角）

| 任务书需求 | 宿主能力 | 现有实现证据 | 差距 |
|---|---|---|---|
| 自动创建工作区对话 | ✅ `ctx.workspaceRegistry.create(directory, title)` | `workspace-agent.mjs` L402：`registry.create(directory, 'Live2D Agent')` | 无；泛化为多工作区即可 |
| 创建会话并绑定专属预设 | ✅ `sessionController.create({ workspaceId, agentPreset })` | L415：预设 `dsh-l2d`（`cordis.patch.yml` 中 `preset-dsh-l2d`），失败回退普通会话 | 需为三个角色各定义 preset 或复用 |
| 系统提示词注入 | ✅ 工作区目录写 `AGENTS.md` + `@deepseek-ai/dsh-agent-instructions`（maxBytes 65536） | L401 `ensureInstructions`；patch.yml `agent-instructions` 插件 | 大提示词需控制在 64KB 内并做版本戳 |
| 按 ID 恢复、不靠标题搜索 | ✅ manifest 持久化 `~/.dsh/l2d-workspace-agent.json`（workspaceId/sessionId + archived 过滤） | L403-409 | 需泛化为 `config/workspaces.json` 多条目 |
| 向会话发 prompt | ✅ `controller.prompt({mode:'queue'}, signal)` | L286-291 | 无 |
| Skill/MCP 工具挂载 | ✅ preset 级 `@deepseek-ai/dsh-mcp-client`（stdio，`failOnStartupError: true`） | `cordis.patch.yml`：`serverName: dsh_l2d` → `packages/dsh-l2d-mcp/src/server.mjs` | 每个 preset 只挂自己的 MCP；健康检查需新增 |
| 工作区互通观察 | ✅ 只读快照 `getWorkspaceAgentStates(registry)` + agent.md 脱敏快照 | `workspace-snapshot.mjs`、L1671-1685 桥接 | 需扩展为任务协议（现只有状态快照） |
| 通用"tab/会话标题改写" API | ❌ 不存在（Host API 审计 §0：无 tab 级 API，界面扩展靠命名 slot） | `docs/Host-API-Audit.md` | 会话"自动标题"用 `workspaceRegistry.create` 的 title 参数近似，不伪造改名 API |

## 3. 启动生命周期现状与门禁落点

- 入口：`packages/dsh-l2d-plugin/lib/index.js` `apply(root, config)`（L818）→ `root.on('webserver/index-inject')` 注册注入行 → `root.inject(['webServer','credentials'], …)` 挂路由 → `root.inject(['workspaceRegistry','sessionController','agentPresets'], …)` 启动桌宠桥（L1671）。
- 已评审文档 `docs/启动优先级与Live2D延迟加载方案.md`（PR #13）：P0 注册不 await 重活；P1 后台准备；P2 按需加载模型；状态机 `plugin/runtime/avatar` 三态分离；`bootstrap.mjs / startup-coordinator.mjs` 等模块**仅是建议命名，代码尚未存在**（文档 §1 自述"不代表代码已完成"）。
- **门禁设计裁决（需确认）**：Readiness Gate 实现为 P1 末尾的后台阶段产物，状态（READY / DEGRADED / BLOCKED / RECOVERING / NEEDS_AUTHORIZATION）挂在 P2 的入口条件上——用户请求加载模型时若 gate≠READY/DEGRADED，则拒绝加载并报告，**绝不阻塞 P0 插件注册**。这与任务书"Skill first, model second"语义一致，且不违反 #13。

## 4. 现有资产盘点（复用优先）

| 资产 | 位置 | 对本任务的用途 |
|---|---|---|
| 工作区桥模式（创建/恢复/注入/轮询） | `packages/dsh-l2d-plugin/lib/workspace-agent.mjs`（479 行，有单测） | 三工作区管理器的直接蓝本 |
| 人设/环境/快照上下文块 | `persona.mjs`、`env-state.mjs`、`workspace-snapshot.mjs` | Orchestrator 汇总与提示词组装复用 |
| 事件门控（优先级/去重/冷却） | `choreography.mjs` `decide()` | 任务通知节流复用 |
| MCP Server（14 个 `registerTool`，`l2d_choreograph` 等） | `packages/dsh-l2d-mcp/src/server.mjs`（460 行） | 模型智能 MCP 工具按同约定扩展 |
| 验收/契约工具 | `tools/acceptance`、`tools/renderer-contract`、`tools/capability-scan`、`dev-server` | gate 健康检查与集成测试底座 |
| 测试约定 | `package.json` `test:core`（node 直跑 *.test.mjs / *.ts） | 新测试必须进这条链 |
| Host API 审计 | `docs/Host-API-Audit.md` | 禁止伪造 API 的边界清单 |
| Cubism SDK | `vendor/cubism` | 运行时依赖已就位 |

## 5. 技术差距清单（D1-D10）

| # | 差距 | 落点 | 复用基础 | 风险/备注 |
|---|---|---|---|---|
| D1 | 本地 main 落后 1 提交且 fetch 被 TLS 吊销检查阻断 | 仓库 git config | — | 未同步前禁止开分支 |
| D2 | Skill Registry 与 discover/validate/register/health-check 工具链不存在 | `tools/skill-manager/*` + `config/skill-registry.json` | 远端 SKILL.md 契约样例 | 状态机 7 态可落实，但 `loaded` 只能验到"已注入 AGENTS.md" |
| D3 | 三工作区（Orchestrator / Model Inspector / Behavior Engineer）不存在，现仅桌宠 1 个 | 泛化 `workspace-agent` → `workspace-manager/`；`config/workspaces.json` | `ensure()` 的 manifest+ID 恢复模式 | 需确认 3 个新 preset 的 MCP 挂载策略 |
| D4 | 提示词注入容量与版本治理 | 各工作区 AGENTS.md + `system_prompt_version` 字段 | `agent-instructions` maxBytes 65536 | 三份大提示词须预留字节预算并做超限裁剪 |
| D5 | 启动 Readiness Gate 不存在 | `lib/startup-gate.mjs`（P1 后台 → P2 入口条件） | #13 状态机设计 | 不得阻塞 P0；需防与 #13 后续实现重复造轮子（先扩展其建议模块名） |
| D6 | Toolchain 管理器（环境/依赖/MCP 健康/恢复）不存在 | `tools/toolchain-manager/*` | `tools/capability-scan`、`host-guard.mjs` 的校验风格 | MCP 健康检查需真实调用探针，非仅进程存活 |
| D7 | 无任何 SQLite/模型库 | `data/bootstrap-state.sqlite` + 迁移 | — | 新增依赖（如 better-sqlite3）需锁定版本+烟测；model-intelligence Phase 6 已预留此情形 |
| D8 | 跨工作区任务协议（task_id/归属/evidence…）不存在 | registry + Orchestrator skill | `session-events/session-log` | 写入须带事务与任务归属（任务书 §六） |
| D9 | 12 项启动/Skill 测试全缺 | 各 manager `*.test.mjs` + `test:core` | 现有测试风格 | 集成测试须证明真实启动顺序，不允许仅静态声明 |
| D10 | 三份新 SKILL.md 与工作区提示词未写 | `skills/*`（独立 PR） | 远端 model-intelligence 样板 | 不得改动已审核的 2.1.0 文件 |

## 6. 实施计划（待批准后执行）

1. **Phase 1（前置）**：修 fetch（D1）→ 同步 main → 基于 main 开 `feat/skill-framework`。
2. **PR-A**：skill-manager（discover/validate/register/health-check）+ `config/skill-registry.json` + D9 中 1-4 号测试。
3. **PR-B**：workspace-manager 三工作区 + 三份提示词 + workspaces.json + D9 中 5-7 号测试。
4. **PR-C**：startup-gate + toolchain-manager + Bootstrap Report + D9 中 8-12 号测试与启动顺序集成测试。
5. **PR-D/E/F**：`dsh-l2d-orchestrator` / `dsh-l2d-structure-inspector` / `dsh-l2d-behavior-engineer` 三份 SKILL.md（各一 PR，逐个审核）。
6. **PR-G（可选，单独评审）**：SQLite 模型注册表（D7）——建议独立立项，不混入框架 PR。

每个 PR 附：修改文件、测试证据、回滚方式；三份 Skill 的接口与提示词契约以 `dsh-l2d-model-intelligence@2.1.0` 为基准。

## 7. 需要用户裁决的三个问题

1. **门禁语义**：同意"gate 只拦模型加载（P2），不阻塞插件注册（P0）"？（推荐：是，否则与 #13 冲突且会拖死 DSH 启动）
2. **Skill 第四态验证口径**：接受"`loaded` = 已注入工作区 AGENTS.md + MCP 工具可调用；实际执行经回执/日志间接佐证"的降级定义？（推荐：是；宿主无更强接口，伪造观测反而违反审计纪律）
3. **SQLite 立项时机**：D7 随框架一起做，还是独立 PR 后置？（推荐：后置，先让三工作区与门禁跑通结构事实链路）

## 8. 遗留问题登记

- 本地未跟踪文件 `docs/DSH-L2D-攻坚组团队章程.md` 待入库。
- `last-run.json` 在仓库根目录，归属未在 .gitignore 明示。
- Windows fetch 的 TLS 吊销检查问题同样会影响 CI 与其他协作者，建议在 README 维护指南补一条说明。
