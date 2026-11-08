# Control Studio 界面样式适配 · 上下文与进度看板

> 维护者：`context-keeper`（固定角色，全程不换岗；本轮由席位 5 `arcana-intel-researcher` 兼任）
> 建立：2026-11-08 13:16 · 最近巡检：2026-11-08 13:20（第 2 次：主理人 Q1–Q4 裁定转发触发）· 裁定登记：2026-11-08 13:20（D7–D11，见 DECISIONS.md）
> 唯一规格真源：`docs/studio-ui/DESIGN-SPEC.md` v1（2026-11-08 13:10）
> 授权：本角色**仅可写** `CONTEXT.md` 与 `DECISIONS.md`；禁止写任何代码/样式文件，禁止创建团队。
> 纪律：所有结论标注证据（文件路径 / 命令输出）；未落盘即写「未落盘」，不臆测、不虚报进度。

---

## 1. 需求摘要

用户要求：**同步重新调整现有界面实现，使其完整适配全新的编辑器样式**——统一布局、配色、字体、间距、控件状态与交互反馈，覆盖工具栏、侧边栏、内容区、面板、菜单、弹窗等区域；**保持原有功能入口、操作流程与业务逻辑不变**；新样式下视觉层级清晰、状态一致、不同窗口尺寸仍可用。指派子代理分工、**固定一个子代理管理上下文**、**下午 17:00 验收**。（证据：`DESIGN-SPEC.md:8-10`）

本轮为**纯视觉/样式适配**，不实现 Motion Graph / Control Studio 节点编辑、LLM Copilot、Bridge Cache 等功能；样式语言取自该规划，功能一律不动。（证据：`DESIGN-SPEC.md:12`）

设计语言 v1 要点：深色专业节点工作台、顶部工具栏 48px / 左导航轨 232px / 右 Inspector 300px / 底部状态条 34px / 内容 16px gutter；九态控件语义（idle/hover/active/focus-visible/selected/disabled/loading/error/success）；四档响应式断点（≥1440 / 1024–1439 / 720–1023 / <720）；深浅双主题；`prefers-reduced-motion`。（证据：`DESIGN-SPEC.md:21-29`）

## 2. 规格来源与已知偏差

| 项 | 事实 | 证据 |
|---|---|---|
| 原型附件 | 用户附两份 ZIP：`dsh-l2d-motion-graph-demo.zip`、`dsh-l2d-control-studio-demo.zip`，标记路径 `D:/Temp/Cache/oPlusConnect/TempFiles/` | `DESIGN-SPEC.md:16` |
| **已知偏差** | **两份 ZIP 在本机不可读**（会话切换后临时文件被清理，`Read` 返回 File does not exist）；本轮未重新验证附件路径，采信规格文档的实测结论 | `DESIGN-SPEC.md:16` |
| 规格依据 | 两份设计文档正文完整（三栏结构 / 统一控制台 / 节点分类语义色 / ComfyUI·Foundry 风格参考 / 控件状态与响应式要求），**据此 + 项目现有 `--dsh-*` 令牌推导** | `DESIGN-SPEC.md:17` |
| 偏差缓解 | 所有设计值集中在 `studio-tokens.css` 单一真源；后续补齐原型只需替换该文件取值并 `node docs/studio-ui/sync-tokens.mjs`，无需改页面代码 | `DESIGN-SPEC.md:18`、`sync-tokens.mjs:1-40` |
| **验收口径** | 最终报告**必须如实标注此偏差，不得声称「与原型像素级一致」** | `DESIGN-SPEC.md:19` |

## 3. 契约索引

| 文件 | 角色 | 状态（13:16 巡检） |
|---|---|---|
| `docs/studio-ui/DESIGN-SPEC.md` | **唯一规格与协作契约**（§1–9：需求/偏差/设计语言/真源分发/所有权矩阵/硬约束/分区任务/验收标准/决策日志） | 已落盘 10108 B |
| `docs/studio-ui/studio-tokens.css` | 设计令牌**唯一真源**（v1 标记块，303 行） | 已落盘 16452 B |
| `docs/studio-ui/sync-tokens.mjs` | 幂等同步脚本（真源 → 两分发副本，保持各文件 EOL） | 已落盘 1571 B |
| `docs/studio-ui/fingerprint.mjs` | 功能指纹提取器（id/href/data-*/事件/中文文案；排除 style/script/CSS 注释） | 已落盘 4678 B |
| `docs/studio-ui/baseline/functional-fingerprint.json` | **样式改动前的功能基线**（generatedAt 2026-11-08T05:14:27Z，覆盖 settings.html/test.html/pet.html/settings-entry.js/overlay.js + stage-web & whale-workspace 全部 .vue） | 已落盘 99171 B |
| `docs/studio-ui/CONTEXT.md` | 本文件（上下文 / 看板 / 风险 / 验收证据索引 / 环境） | 本次建立，13:20 已更新 |
| `docs/studio-ui/DECISIONS.md` | 决策日志（D1–D6 抄录 + D7–D11 裁定登记 + 后续决策空位） | 本次建立，13:20 已更新 |
| `docs/studio-ui/preview-server.mjs` | **只读静态预览服务**（端口 5400、零依赖、不改任何现有源码；visual-qa 主用入口，见 §9） | 已落盘 3207 B |
| `docs/studio-ui/consistency.test.mjs` | regression-guard 产出（一致性断言） | **未落盘** |
| `docs/studio-ui/ACCEPTANCE.md` | regression-guard 产出 | **未落盘** |
| `docs/studio-ui/VISUAL-REPORT.md` | visual-qa 产出 | **未落盘** |
| `docs/studio-ui/visual/*.png` | visual-qa 产出（三尺寸截图） | **未落盘（目录不存在）** |

（证据：`ls -la docs/studio-ui` 与落盘检查脚本输出，13:16 / 13:20 两次；13:20 新增：`visual/` 目录已建但为空（0 文件），截图仍未落盘）

## 4. 文件所有权矩阵（严禁交叉）

> 抄录 `DESIGN-SPEC.md:43-53`；完整约束以规格原文为准。

| 子代理 | 独占文件 | 禁止触碰 |
|---|---|---|
| `context-keeper`（固定） | `docs/studio-ui/CONTEXT.md`、`docs/studio-ui/DECISIONS.md` | 任何代码 / 样式文件 |
| `settings-restyler` | `assets/settings.html`、`tools/acceptance/snapshots/settings.html`、`apps/stage-web/src/components/*.vue`、`apps/stage-web/src/styles/base.css` | `assets/*`、`lib/*`、后端、db |
| `overlay-restyler` | `lib/settings-entry.js`、`assets/overlay.css`、`lib/overlay.js`（**仅 STYLE_TEXT / 样式字符串**）、`assets/test.html` | `settings.html`、快照、`apps/**`、`assets/ui-tokens.css` |
| `regression-guard` | `docs/studio-ui/consistency.test.mjs`（新建）、`docs/studio-ui/ACCEPTANCE.md`（新建） | 任何现有源码 |
| `visual-qa` | `docs/studio-ui/visual/*.png`（新建）、`docs/studio-ui/VISUAL-REPORT.md`（新建） | 任何源码 |
| 主理人 | `studio-tokens.css`、`sync-tokens.mjs`、两处 `ui-tokens.css` 分发副本 | — |

**绝对禁改（全席）**：`assets/renderer.js`（350KB 压缩产物）、`lib/index.js`、`packages/dsh-l2d-db/**`、`packages/mcp-bridge/**`、`packages/dsh-l2d-mcp/**`、`data/**`、`tools/w3-registry/**`、`assets/ui-tokens.css` 与 `apps/stage-web/src/styles/ui-tokens.css`。（证据：`DESIGN-SPEC.md:53`）

**硬约束摘要**（`DESIGN-SPEC.md:55-63`）：① 零功能改动（id/href/事件/表单 name/可见文案/DOM 顺序不变，仅允许追加 class、包裹容器、改 CSS、加 style/link）；② 零 JS 逻辑改动（唯一例外：`overlay.js` 的 STYLE_TEXT 与 `settings-entry.js` 的 STYLE 数组）；③ **保留未提交成果**（`overlay.js` 阶段 2「右键快捷对话 + 调试日志窗口」实现 + `debug-log.test.mjs`）；④ 快照同步（主文件 CRLF / 快照 LF，忽略 CR 后内容相同）；⑤ 令牌四处一致；⑥ 深浅主题兼容；⑦ 不引入新 JS 依赖 / 网络请求 / localStorage 键。

## 5. 任务看板

> 数据来源：`TaskList` 输出（13:20 复核）+ 落盘巡检（13:16 / 13:20）。**进度以文件系统实测为准，不以席次口头回传为准。**

| 席次 / 任务 | Task ID | 应产出 | 状态（13:20） |
|---|---|---|---|
| `context-keeper`（本席） | #17 | CONTEXT.md / DECISIONS.md 全程维护 | 进行中（两份文档已建立并完成第 2 次巡检更新） |
| `settings-restyler` | #18 | 设置页 + stage-web 编辑器化样式、快照与**内联令牌块（Q3 裁定归本席）** | in_progress；产出文件**未落盘** |
| `overlay-restyler` | #19 | 宿主侧栏菜单 + 浮层/面板/气泡/状态胶囊/快捷对话/日志窗 | in_progress；产出文件**未落盘** |
| `regression-guard` | #20 | `consistency.test.mjs`、`ACCEPTANCE.md` | in_progress（主理人已把 `arcana-backend-engineer` 改派本席）；**未落盘** |
| `visual-qa` | #21 | `visual/*.png`、`VISUAL-REPORT.md` | in_progress；`visual/` 空目录已建、截图与报告**未落盘** |
| 主理人（终审） | #22 | 终审、分组 commit 推送、最终报告 | 待办 |
| **17:00 验收节点** | — | 见 §7 验收清单 | 未到 |
| **16:30 全席一致性核对** | — | 本席向 `team-lead` 回传结构化核对报告 | 未到（强制复核项见 §7） |
| 上一阶段遗留 | #12/#13/#14 | SQL 映射 / bridge 重构 / 全链路测试 | **已冻结并标记 deleted**（Q1 裁定，13:20 `TaskList` 复核：三项均已不在列表） |

**巡检实测（13:20 复核，命令输出为证）**：
- 令牌标记块四处（Q4 定义）：①真源 / ②副本1 / ③副本2 三处 **sha256(忽略CR) = `ef2e53b01e76`、len=16159 完全一致**；③为 CRLF、①②为 LF（符合 `sync-tokens.mjs:28-37` 的 EOL 保持语义）。**④ `assets/settings.html` 内联块与快照仍「无完整标记块」**（BEGIN/END 皆未命中）→ Q3 裁定归 settings-restyler 的在途工作，按 Q4 裁定当前记 WARN，16:30 复核若仍缺则升级 FAIL。
- `git diff --cached --name-only`：**空输出**（13:20 实测）→ Q2 复核通过，`profile.大肥鱼.dsl2d.2048.json` **未被暂存**。
- `git status --short`：仍为 4 个已改文件（两处 `ui-tokens.css` 各 +304 主理人同步、`overlay.js` +248 阶段 2 未提交成果、`profile.*.json` ±2 历史遗留）+ 未跟踪目录；与 13:16 一致，无新增越界改动。
- `git diff --stat`：4 files changed, 856 insertions(+), 2 deletions(-)。
- 环境实测：5400 八条路由全 200 且 `cache-control: no-store`；5300 五条 200、`/dsh-l2d/test.html` 404；3080 实测 `curl` 返回 `000`（详见 §9）。
- `visual/` 目录已由 visual-qa 建立但为空（0 文件）；`consistency.test.mjs` / `ACCEPTANCE.md` / `VISUAL-REPORT.md` 仍**未落盘**。

## 6. 风险清单

| # | 风险 | 证据 | 建议处置 |
|---|---|---|---|
| R1 | 两份原型 ZIP 不可读，规格靠文档正文推导，存在与真实原型偏差 | `DESIGN-SPEC.md:16-19` | 最终报告如实标注；后续补齐原型只改 `studio-tokens.css` + 重跑同步 |
| R2 | `overlay.js` 含**未提交的**「右键快捷对话 + 调试日志窗口」实现（+248 行），`overlay-restyler` 仅被授权改 STYLE_TEXT，误覆盖会丢失成果且破坏 §6.3 | `git diff --stat`、`DESIGN-SPEC.md:59`、`baseline/functional-fingerprint.json` 中 overlay.js 已含 `admitCaption` / `l2d-qc` / `l2d-logpanel` 文案 | overlay-restyler 动手前先确认基线；本席巡检持续监控 `overlay.js` 的 diff 范围 |
| R3 | settings.html 与其快照**尚无内联令牌块**，而「四处一致」是验收硬约束（§6.5） | 13:16 / 13:20 两次标记块巡检（两处 BEGIN/END 均未命中） | **Q3 已裁定**：由 settings-restyler（#18）逐字复制真源标记块插入 `<style>`、保持 CRLF；`sync-tokens.mjs` targets 不扩展以避免并发竞态；快照通过「忽略 CR 后逐行一致」间接保证。**Q4 已裁定**：当前属在途工作记 WARN，**16:30 复核若仍缺则升级 FAIL 并上报** |
| R4 | `tools/capability-scan/profile.大肥鱼.dsl2d.2048.json` 出现 ±2 行改动，不在任何席所有权矩阵内 | `git status --short` 13:16 / 13:20 | **Q2 已裁定**：确认为历史遗留无关改动，不纳入本轮任何分组 commit；升级登记为 R9 |
| R5 | 任务系统 #12/#13/#14 曾与 D5「本轮不续跑」并存 | `TaskList` 13:16 / 13:20 | **Q1 已裁定并已冻结**：主理人将三项标记 deleted、本轮不续跑、无文件交集；`arcana-backend-engineer` 已改派 regression-guard 并要求放弃七步重构。**16:30 若 `packages/dsh-l2d-db/**` 或 `packages/mcp-bridge/**` 出现任何 diff，立即作为 FAIL 级风险上报** |
| R6 | 副本2 为 CRLF、其余为 LF；`consistency.test.mjs` 若按逐字比对（含 CR）会误报不一致 | 13:16 / 13:20 令牌巡检 / `DESIGN-SPEC.md:60` | **Q4 已裁定**：四处 = ①真源 ②`packages/.../assets/ui-tokens.css` ③`apps/.../styles/ui-tokens.css` ④`settings.html` 内联块；断言一律先 `.replace(/\r/g,'')` 再逐字比较；在途缺失记 WARN 不记 FAIL |
| R7 | 时间窗紧：13:16 建立上下文 → 16:30 全席一致性核对 → 17:00 验收；当前四席产出文件全部未落盘 | 落盘巡检 + `DESIGN-SPEC.md:73-79` | 按 30 分钟节奏巡检，及时暴露阻塞 |
| R8 | 功能基线含 overlay.js 的完整中文字符串字面量（含 JS 代码片段），`fingerprint.mjs` 的提取规则对内联字符串敏感；样式适配若不小心触碰 `<script>` 内容会造成指纹漂移 | `functional-fingerprint.json`（overlay.js 段）、`fingerprint.mjs:83-89` | regression-guard 断言按基线比对；本席巡检关注非样式类改动 |
| R9 | 分组 commit 若使用 `git add -A` / `git add .`，会把 `profile.*.json`（Q2 历史遗留）与 `_qa_crop/` 等无关未跟踪项混入 | 主理人 Q2 裁定（13:20）；13:20 `git status --short` 显示多项 `??` 未跟踪 | **主理人裁定**：最终提交只用「显式文件白名单 git add」，禁止 `git add -A` / `git add .`；16:30 复核 `git diff --cached --name-only` 不含该文件（13:20 已实测为空、通过） |
| R10 | 3080 宿主不可用、5300 的 `/dsh-l2d/test.html` 为 404；visual-qa 若误用旧入口会漏测「参数监视台」页面 | 13:20 curl 实测（见 §9） | visual-qa 统一以 **5400 preview-server** 为主用入口；参数监视台视觉核对必须走 5400 |

## 7. 验收证据索引

| 验收项（`DESIGN-SPEC.md:73-79`） | 证据来源 / 命令 | 当前状态 |
|---|---|---|
| 既有测试全绿（`test:core` 关键单测、`test:chain15` 5 组、`pnpm typecheck`） | `package.json` scripts；`tests/chain-15/run.mjs`；由 regression-guard 执行 | 待产出 |
| `consistency.test.mjs` 全绿（令牌四处一致、功能入口/文案零漂移、禁改项零改动、快照一致） | `docs/studio-ui/consistency.test.mjs` + `baseline/functional-fingerprint.json` + `fingerprint.mjs` | **未落盘** |
| 三尺寸截图（1440×900 / 1024×768 / 720×900）、深浅主题、无溢出遮挡 | `docs/studio-ui/visual/*.png`、`VISUAL-REPORT.md` | **未落盘** |
| 交付物齐备（8 项） | `ls docs/studio-ui` | **5/8 已落盘**：DESIGN-SPEC.md / studio-tokens.css / sync-tokens.mjs / CONTEXT.md / DECISIONS.md；待 3/8：ACCEPTANCE.md / VISUAL-REPORT.md / visual/*.png（`visual/` 空目录已建） |
| 分组 commit 并推送 GitHub，四层可追溯 | 主理人 #22 | 待办 |
| 功能零漂移基线 | `docs/studio-ui/baseline/functional-fingerprint.json`（generatedAt 2026-11-08T05:14:27Z） | 已固化 |

**验收工具清单（主理人新增并已运行，13:20 全部实测落盘）**

| 工具 | 用途 | 落盘 |
|---|---|---|
| `docs/studio-ui/sync-tokens.mjs` | 幂等同步真源标记块 → 两处 `ui-tokens.css`（targets 仅此两处，按 Q3 裁定不扩展） | 1571 B |
| `docs/studio-ui/fingerprint.mjs` | 只读输出当前功能指纹，与基线比对（不写文件） | 4678 B |
| `docs/studio-ui/preview-server.mjs` | 5400 只读静态预览服务，visual-qa 主用入口 | 3207 B |
| `docs/studio-ui/baseline/functional-fingerprint.json` | 样式改动前功能基线 | 99171 B |

**16:30 强制复核项（主理人裁定）**

1. `git diff --cached --name-only` **不含** `tools/capability-scan/profile.大肥鱼.dsl2d.2048.json`（Q2；13:20 预检已通过）。
2. `packages/dsh-l2d-db/**` 与 `packages/mcp-bridge/**` **零 diff**，出现任何 diff 即 FAIL 级上报（Q1）。
3. 令牌四处（①②③④）一致；断言先 `.replace(/\r/g,'')` 再逐字比较（Q4）。④ `settings.html` 内联块若仍缺 → 由 WARN **升级 FAIL 并上报**（Q4）。
4. `consistency.test.mjs` / `ACCEPTANCE.md` / `VISUAL-REPORT.md` / `visual/*.png` 落盘情况与内容；各席越界改动核查。

**本席可用巡检命令（只读）**：`ls -la docs/studio-ui`、`git status --short`、`git diff --stat`、标记块哈希比对脚本（见 §5）、`node docs/studio-ui/fingerprint.mjs`（输出当前指纹，与基线比对，不写文件）。

## 8. 术语表

| 术语 | 含义 |
|---|---|
| Control Studio / Motion Graph | 两份设计文档描述的「统一控制台 / 节点图编辑器」产品形态；**本轮仅借用其样式语言，不实现功能**（D1） |
| `--studio-*` / `.studio-*` | 本轮新增样式令牌与原子类前缀；不覆盖任何既有 `--dsh-*`（`studio-tokens.css:9`） |
| 标记块 | `/* ===== BEGIN STUDIO TOKENS v1 =====` 至 `/* ===== END STUDIO TOKENS v1 ===== */` 之间的内容；禁止手工改动块内部，由 `sync-tokens.mjs` 幂等重放（`DESIGN-SPEC.md:41`） |
| 真源 / 分发副本 / 内联副本 | 真源 = `studio-tokens.css`；分发副本 = 两处 `ui-tokens.css`；内联副本 = `settings.html` 及其快照内的 `<style>` 块（§4） |
| 功能指纹 | `fingerprint.mjs` 从源码提取的 id/href/data-*/事件/中文文案集合；样式适配不应改变它，是「零功能改动」的机器可验证基线 |
| 九态 | 控件统一状态语义：idle / hover / active / focus-visible / selected / disabled / loading / error / success（`DESIGN-SPEC.md:27`） |
| 四档响应式 | ≥1440 全展开；1024–1439 Inspector 收窄；720–1023 导航轨 64px 图标条 + Inspector 抽屉；<720 单栏 + 导航抽屉（`DESIGN-SPEC.md:29`） |
| 快照 | `tools/acceptance/snapshots/settings.html`，与 `assets/settings.html` 忽略 CR 后须逐行一致（§6.4） |
| context-keeper | 本角色：唯一长期持有全团上下文、仅维护 CONTEXT.md / DECISIONS.md，不替他席做技术决策 |
| D1–D6 | 主理人在 `DESIGN-SPEC.md §9` 裁定的六条决策，抄录于 `DECISIONS.md` |
| 16:30 / 17:00 | 全席一致性核对节点 / 用户指定的一次性验收节点（D6） |

## 9. 环境与预览服务（13:20 补记）

> 所有 URL 结论均来自本席 13:20 `curl` 实测（命令输出为证），非转述；服务可用性会随时间变化，每次巡检需重测。

| 服务 | 启动 / 端口 | 13:20 实测 | 结论 |
|---|---|---|---|
| 3080 宿主 | — | `curl http://127.0.0.1:3080/` 返回 `000`（连接未建立） | **不可用，不要依赖**。主理人称「仍 502」，本席实测为连接层 `000` 而非 HTTP 502——口径差异如实记录，但「不可用」结论一致 |
| 5300 本地调试服 | `node tools/dev-server/index.mjs --port 5300`（主理人已恢复） | `/`、`/dsh-l2d/settings`、`/dsh-l2d/ui-tokens.css`、`/dsh-l2d/overlay.css`、`/dsh-l2d/overlay.js` = **200**；`/dsh-l2d/test.html` = **404** | 可用但**不覆盖参数监视台** |
| 5400 预览服 | `node docs/studio-ui/preview-server.mjs --port 5400`（主理人新增） | `/`、`/dsh-l2d/settings`、`/dsh-l2d/test.html`、`/dsh-l2d/pet.html`、`/dsh-l2d/overlay-test.html`、`/dsh-l2d/ui-tokens.css`、`/dsh-l2d/overlay.css`、`/dsh-l2d/overlay.js` **八条全部 200**；`GET /dsh-l2d/settings` 响应头实测 `cache-control: no-store` | **visual-qa 主用入口**；样式落盘后刷新即生效 |

- `preview-server.mjs` 契约（原文已读）：零依赖、仅监听 `127.0.0.1`、不改动任何现有源码（`:1-8, 65-67`）；映射 `/dsh-l2d/<file>` → `assets/<file>`，找不到回退 `lib/<file>`（`:54-61`）；`overlay-test.html` 特例从 `tools/dev-server/public/` 读取（`:56-59`）；所有文件响应带 `cache-control: no-store`（`:63`）。
- **5300 与 5400 差异解释**：5400 的 `/dsh-l2d/test.html` 为 200，因 preview-server 从 `assets/` 直接读取该文件（`:60`）；5300 dev-server 未映射该路由故 404。→ 参数监视台 / 渲染自检页的视觉验收**必须走 5400**。

---

## 巡检日志

| 时间 | 触发 | 要点 | 证据 |
|---|---|---|---|
| 2026-11-08 13:16 | 首次建立 | 三处令牌块 hash 一致（`ef2e53b01e76`）；settings.html 及快照无内联块；四席产出文件全部未落盘；`overlay.js` +248 未提交成果在册；发现 R4 来源未明改动 | 本文件 §5 |
| 2026-11-08 13:20 | 主理人转发 Q1–Q4 逐项裁定 + 环境变更 | 核实 #12/#13/#14 确已 deleted、#18–#21 全部 in_progress；暂存区为空（Q2 复核通过）；四处令牌块 ①②③ 一致、④ 仍缺；`visual/` 空目录已建；5400 八路由全 200 + no-store、5300 test.html 404、3080 实测 000；登记 D7–D11 与 R9/R10、补记 §9 环境节与验收工具清单 | 本文件 §5 / §7 / §9；`DECISIONS.md` 第二、三部分 |
| _待 16:30_ | 全席一致性核对 | 按 §7「16:30 强制复核项」执行并回传结构化报告 | — |
