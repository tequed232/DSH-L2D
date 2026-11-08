# DSH-L2D Control Studio 界面样式适配 · 设计规格与协作契约

> 版本：v1 / 2026-11-08 13:10 / 主理人定契约，成员并行实现
> 本文件是**唯一规格真源**。所有子代理开工前必读，完工后向 `context-keeper` 回写状态。

## 1. 需求与范围

用户要求：**同步重新调整现有界面实现，使其完整适配全新的编辑器样式**——统一布局、配色、字体、间距、控件状态与交互反馈，覆盖工具栏、侧边栏、内容区、面板、菜单、弹窗等相关区域；**保持原有功能入口、操作流程与业务逻辑不变**；新样式下视觉层级清晰、状态一致、不同窗口尺寸下仍可正常使用。

用户同时要求：指派子代理分别完成作业；**固定一个子代理负责管理上下文**；**下午 17:00 验收**。

本轮是**纯视觉/样式适配**，不实现 Motion Graph / Control Studio 的节点编辑、LLM Copilot、Bridge Cache 等功能（那些是两份设计文档的后续产品规划）。样式语言取自该规划，功能一律不动。

## 2. 规格来源与已知偏差（必读）

- 用户随消息附带两份原型包 `dsh-l2d-motion-graph-demo.zip`、`dsh-l2d-control-studio-demo.zip`，标记路径 `D:/Temp/Cache/oPlusConnect/TempFiles/`。**实测：两个 ZIP 在该路径及常见附件缓存均不存在**（会话切换后临时文件被清理），`Read` 返回 File does not exist。
- 已收到的两份设计文档正文完整，包含：三栏结构（Node Library / Graph Canvas / Inspector）、统一控制台（左导航 + 中央内容 + 右 Inspector + 底部 Bridge/Cache/Queue/LLM 状态条）、节点分类与语义色、ComfyUI / Foundry 风格参考、控件状态与响应式要求。规格据此 + 项目现有 `--dsh-*` 令牌推导。
- **偏差处理**：所有设计值集中在 `docs/studio-ui/studio-tokens.css` 单一真源。若后续补上传原型，只需替换该文件的取值并运行 `node docs/studio-ui/sync-tokens.mjs`，即可全量对齐，无需改任何页面代码。
- 该偏差必须在最终报告中如实标注，不得声称"已与原型像素级一致"。

## 3. 设计语言（v1）

- **基调**：深色专业节点工作台，基底沿用项目现有 `#101114` 系并向编辑器化收敛（`#0d0f13` / `#141821` / `#1c2230`）；强调色沿用 `#9dc1ff`。浅色主题完整对应。
- **布局**：顶部工具栏 48px、左侧导航轨 232px、右侧 Inspector 300px、底部状态条 34px、内容区 16px gutter。现有页面不强改 DOM，用 CSS 建立同节奏的层级与栅格。
- **语义色**：Trigger 青 `#5ad1c8`、Logic 紫 `#b79cff`、Action 琥珀 `#ffb86b`、Bridge 蓝 `#7aa8ff`、LLM 粉 `#f09ad2`；状态 ok/warn/danger/info 齐备。
- **字体**：UI 沿用 `--dsh-font-sans`，数值/序号/状态条用 `--dsh-font-mono`；`--studio-text-*` 六级字阶。
- **控件状态（统一语义，所有控件一致）**：`idle / hover / active / focus-visible / selected / disabled / loading / error / success`。用 `[data-state="..."]` + 原生伪类双通道；focus 双环 `var(--studio-focus-ring)`；disabled 统一 `--studio-state-disabled-opacity`；过渡统一 `--studio-transition`。
- **交互反馈**：hover 提亮、active 1px 下沉、selected 左侧 2px 强调条、loading 不可重入、error/success 描边变色。全部遵守 `prefers-reduced-motion`。
- **响应式断点**：`>=1440` 全展开；`1024–1439` Inspector 收窄；`720–1023` 导航轨压成 64px 图标条、Inspector 变抽屉；`<720` 单栏 + 导航抽屉 + 工具栏紧凑 + 状态条横向滚动。

## 4. 单一真源与分发

| 角色 | 文件 | 所有权 |
|---|---|---|
| 真源 | `docs/studio-ui/studio-tokens.css` | 主理人独占 |
| 同步脚本 | `docs/studio-ui/sync-tokens.mjs` | 主理人独占 |
| 分发副本 1 | `packages/dsh-l2d-plugin/assets/ui-tokens.css`（已有路由 `/dsh-l2d/ui-tokens.css`，overlay.js 注入时读取） | 主理人已同步，其他席禁改 |
| 分发副本 2 | `apps/stage-web/src/styles/ui-tokens.css` | 主理人已同步，其他席禁改 |
| 内联副本 | `packages/dsh-l2d-plugin/assets/settings.html` 及其快照 | settings-restyler 同步内联，逐字一致 |

分发块用 `/* ===== BEGIN STUDIO TOKENS v1 =====` / `/* ===== END STUDIO TOKENS v1 ===== */` 标记，禁止手工改动标记块内部。`node docs/studio-ui/sync-tokens.mjs` 可幂等重放。

## 5. 文件所有权矩阵（严禁交叉）

| 子代理 | 独占文件 | 禁止触碰 |
|---|---|---|
| `context-keeper`（固定，全程） | `docs/studio-ui/CONTEXT.md`、`docs/studio-ui/DECISIONS.md` | 任何代码 / 样式文件 |
| `settings-restyler` | `packages/dsh-l2d-plugin/assets/settings.html`、`tools/acceptance/snapshots/settings.html`、`apps/stage-web/src/components/*.vue`（SettingsPanel / CompanionPanel / M3* / Dsh* 等）、`apps/stage-web/src/styles/base.css` | `assets/*`、`lib/*`、后端、db |
| `overlay-restyler` | `packages/dsh-l2d-plugin/lib/settings-entry.js`、`packages/dsh-l2d-plugin/assets/overlay.css`、`packages/dsh-l2d-plugin/lib/overlay.js`（**仅 STYLE_TEXT / 样式字符串**）、`packages/dsh-l2d-plugin/assets/test.html` | `settings.html`、快照、`apps/**`、`assets/ui-tokens.css` |
| `regression-guard` | `docs/studio-ui/consistency.test.mjs`（新建）、`docs/studio-ui/ACCEPTANCE.md`（新建） | 任何现有源码 |
| `visual-qa` | `docs/studio-ui/visual/*.png`（新建截图）、`docs/studio-ui/VISUAL-REPORT.md`（新建） | 任何源码 |

**绝对禁改（全席）**：`packages/dsh-l2d-plugin/assets/renderer.js`（350KB 压缩产物）、`lib/index.js`、`packages/dsh-l2d-db/**`、`packages/mcp-bridge/**`、`packages/dsh-l2d-mcp/**`、`data/**`、`tools/w3-registry/**`、`assets/ui-tokens.css` 与 `apps/stage-web/src/styles/ui-tokens.css`（主理人已同步）。

## 6. 硬约束（回归基线）

1. **零功能改动**：所有带 `id` / `href` / 事件绑定 / 表单 `name` 的元素，其标签名、id、class 中的既有部分、属性、DOM 顺序、可见文案、事件绑定一律不变。允许：追加新 class、追加包裹容器、改写 CSS 规则、追加 `<style>`/`<link>`。
2. **零 JS 逻辑改动**：业务脚本（fetch / 轮询 / 状态机 / 定时器 / 字幕准入 / 快捷对话 / 调试日志）一字不改。唯一例外是 `overlay.js` 的 `STYLE_TEXT` 样式字符串与 `settings-entry.js` 的 `STYLE` 数组。
3. **保留未提交成果**：`lib/overlay.js` 当前含阶段 2 未提交的「右键快捷对话 + 调试日志窗口」实现，`debug-log.test.mjs` 为新增单测——必须原样保留，不得回退或覆盖。
4. **快照同步**：`settings.html` 与其验收快照逐行一致（主文件 CRLF / 快照 LF 各自保持，忽略 CR 后内容相同）。
5. **令牌一致**：三处（真源 + 两分发副本）+ settings.html 内联块的标记块逐字一致，由 `consistency.test.mjs` 断言。
6. **主题兼容**：深/浅两套主题都可用，不得破坏现有 `[data-theme]` 与系统偏好逻辑。
7. **样式与逻辑隔离**：不得因样式调整引入新的 JS 依赖、网络请求或 localStorage 键。

## 7. 分区任务

- **settings-restyler**：设置页与 stage-web 全部界面 → 编辑器化样式（工具栏 / 分区侧栏 / 卡片面板 / 表单控件 / 按钮三态 / 菜单 / 弹窗 / 状态条），同步快照与内联令牌。
- **overlay-restyler**：宿主侧栏设置按钮 + 二级菜单、浮层右键菜单 / 面板 / 气泡 / 状态胶囊 / 快捷对话输入框 / 调试日志窗口、参数监视台 → 同一套视觉语言与控件状态；保持既有交互与 8k 日志行为。
- **regression-guard**：写可重复执行的一致性断言（令牌四处一致、功能入口/文案/DOM 顺序与 `git show HEAD` 基线对比、禁用项清单未改）+ 跑既有测试套件，产出 `ACCEPTANCE.md`。
- **visual-qa**：真实浏览器截图（1440×900 / 1024×768 / 720×900），覆盖工具栏、侧栏、内容区、面板、菜单、弹窗；核对无溢出/遮挡、层级清晰、状态一致、深浅主题；产出 `VISUAL-REPORT.md`。
- **context-keeper（固定）**：维护 CONTEXT.md（进度看板、契约索引、决策日志、风险清单、验收证据索引）；每收到一席回传即更新；16:30 做一次全席一致性核对并向主理人汇报。

## 8. 验收标准（17:00）

1. 既有测试全绿：`test:core` 关键单测（host-guard / caption-guard / debug-log / overlay-recovery / yandere-preempt / host-guard-act）、`test:chain15`（5 组）、`pnpm typecheck`（若可用）。
2. `consistency.test.mjs` 全绿：令牌四处一致、功能入口与文案零漂移、禁改项零改动、快照一致。
3. 视觉：三种窗口尺寸截图齐备，无横向溢出、无元素遮挡、文字对比度可读、控件状态一致、深浅主题均可。
4. 交付物：`DESIGN-SPEC.md` / `studio-tokens.css` / `sync-tokens.mjs` / `CONTEXT.md` / `DECISIONS.md` / `ACCEPTANCE.md` / `VISUAL-REPORT.md` / `visual/*.png`。
5. 分组 commit 并推送 GitHub，需求 → 改动 → commit → 报告四层可追溯。

## 9. 决策日志（主理人裁定）

| # | 决策 | 理由 |
|---|---|---|
| D1 | 不做节点编辑器 / LLM / Bridge Cache 功能，只做样式适配 | 用户明确"保持原有功能入口、操作流程与业务逻辑不变" |
| D2 | ZIP 不可读时不停工，以文档正文 + 现有令牌定规格 | 用户要求自主推进至 17:00 验收，且规格真源可后续一键替换 |
| D3 | 令牌做成单一真源 + 幂等同步脚本 | 多子代理并行改样式时保证一致性，且便于原型补齐后对齐 |
| D4 | 禁止改任何 JS 业务逻辑，只允许样式字符串 | 回归基线要求 |
| D5 | 阶段 2 后端七步重构（SQL 映射 / bridge 队列）本轮不续跑 | 上一轮被用户打断且未落盘，与本轮样式任务无文件交集，避免混入无关改动 |
| D6 | 17:00 设一次性自动化验收提醒 | 用户指定时间点 |
