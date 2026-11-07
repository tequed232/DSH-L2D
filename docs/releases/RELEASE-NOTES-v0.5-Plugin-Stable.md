# DSH-L2D Release v0.5-Plugin-Stable · 需求范围界定与验收条件

> 状态：已发布（验收结果与 commit hash 已回填）
> 日期：2026-11-07 23:50 · 编制：ARCANA 六席专家团主理人
> 版本关联原则：每个需求 → 若干逻辑变更 commit → 汇入本版本记录；commit message 首行引用需求编号，保证「需求 → 改动 → commit → 版本记录」四层可追溯。

---

## 需求一：模型形态变化接入 Actions 列表

**范围**（不改动无关模块）：

- `packages/dsh-l2d-plugin/lib/host-guard.mjs` —— `/ai/call` 白名单追加 `l2d_change_form`（末尾追加，既有 15 项零改动）。
- `packages/dsh-l2d-plugin/lib/overlay.js` —— `DSH_L2D_AI.exec` 新增 `case 'l2d_change_form'`，复用现成 `cycleBodyType()` 三档形态（默认体型 / 体型1 / 体型2），返回 `{ok, form:{index,label}}`。
- `packages/dsh-l2d-mcp/src/server.mjs` —— 注册第 17 个 MCP 工具 `l2d_change_form`，使宿主「工具 Actions」列表与插件设置页两端都出现同构可操作项。
- `packages/dsh-l2d-plugin/assets/settings.html` —— 「05 开发者工具」`.dev-actions` 操作区**末尾**追加「模型形态变化」按钮与独立状态位；触发走既有 `/ai/call → /ai/poll → /ai/result` 通道。
- `tools/acceptance/snapshots/settings.html` —— 逐行副本同步。
- `packages/dsh-l2d-plugin/lib/host-guard.test.mjs` —— 白名单与守卫断言。

**验收条件**：

1. 「参数监视台」链接、「能力重扫」按钮、`#devMsg` 三者的名称、DOM 顺序、既有交互与 `bindDev()` 函数体零改动（其余命名 / 排序 / 交互不变）。
2. 新按钮具备：明确触发入口（按钮）、状态展示（加载中 / 成功含当前形态名 / 失败含原因）、按现有三态机制处理（`btn.disabled` + `.hint` 文案 + `.hint.is-error`），运行时不可用时不伪造成功。
3. `node packages/dsh-l2d-plugin/lib/host-guard.test.mjs` 通过；MCP 工具经 `tools/list` 可见且与既有 16 个工具命名 / 排序 / 交互不冲突。
4. 无新增路由、无新增依赖、无 CSS 新体系。

## 需求二：新设置菜单加入原有信息调试入口链接

**范围**：

- `packages/dsh-l2d-plugin/lib/settings-entry.js` —— 二级菜单追加第 4 项「参数监视台」链接（`<a role="menuitem" href="/dsh-l2d/test.html" target="_blank" rel="noopener">`），前 3 项（外观 / 行为与联动 / 账户与余额）命名、顺序、点击行为零改动；键盘导航与 Esc / 外点关闭语义保持。

**验收条件**：

1. 原有信息调试入口（`/dsh-l2d/test.html`，页面标题「DSH-L2D · 渲染自检」）名称、访问路径、功能与数据展示**零改动**。
2. 链接视觉与既有菜单项一致（同字号 / 间距 / 圆角 / hover / focus），`node --check` 通过。
3. `packages/dsh-l2d-plugin/assets/test.html`、`lib/index.js:1288-1293` 路由、`assets/settings.html:687` 原链接均未被触碰。

## 附带项三：字幕正则准入（同轮更新，随本版本交付）

**范围**：`packages/dsh-l2d-plugin/lib/overlay.js` 的 `say()` 渲染出口（唯一收敛点，覆盖 AI 回复、`l2d_say`、动作气泡、`setEmotionBubble` 回调、诊断文案全部来源）+ 新增 `lib/caption-guard.test.mjs`。

**验收条件**：

1. 参数相关内容（参数名 / 参数值 / 参数占位符 / 参数赋值片段，含 `ParamAngleX`、`Clothes2=0.4`、`{ParamMouthOpenY:1}`、`{"paramId":"LEar1"}`、`${...}`、`<mood>…</mood>` 等真实形态）不出现在最终渲染字幕文本。
2. 纯文本字幕（「嘿嘿，好痒~」「操作电脑」「完成，剩 1 秒」「OK!」）原样放行，不误拦截。
3. 混合场景只剔除参数片段、保留普通文本。
4. 字幕样式（`.l2d-bubble` CSS、定时器、show 语义）与其余展示逻辑（`trimChatText`、`LABEL`/`BUBBLE`、状态胶囊、`sayHtml`）零改动；规则以「参数片段整段剔除 + 准入字符白名单」两段式纯函数实现，单测直接抽取 overlay.js 真实源码执行，无第二份副本实现。

## 版本关联与 commit 计划

| 需求 | commit（逻辑变更分组） |
| --- | --- |
| 需求一（运行时） | `feat(runtime): l2d_change_form 白名单/分发/单测 —— 模型形态变化接入 Actions（需求一）` |
| 需求一（MCP） | `feat(mcp): 注册 l2d_change_form 第 17 工具 —— 宿主工具 Actions 同步可见（需求一）` |
| 需求一+二（界面） | `feat(ui): 设置页追加模型形态变化操作项；设置菜单加参数监视台直达链接（需求一/二）` |
| 附带项三 | `feat(caption): 字幕出口正则准入 —— 参数内容不进字幕（附带项三）` |
| 版本记录 | `chore(release): v0.5-Plugin-Stable 版本号与发布记录` |

版本号：根 `package.json` 与 `packages/dsh-l2d-plugin/package.json` 同步升至 `0.5.0-Plugin-Stable`；打 tag `v0.5-Plugin-Stable`。

## 测试与验收状态（2026-11-08 00:00 回填）

| 验证项 | 结果 |
| --- | --- |
| `node packages/dsh-l2d-plugin/lib/host-guard.test.mjs` | PASS（含 l2d_change_form 三组新断言） |
| `node packages/dsh-l2d-plugin/lib/caption-guard.test.mjs` | PASS（纯文本不误拦 / 含参零残留 / 混合三类 + 静态断言） |
| `node packages/dsh-l2d-plugin/lib/host-guard-act.test.mjs` | PASS |
| `node packages/dsh-l2d-plugin/lib/overlay-recovery.test.mjs` | PASS（7 项静态钩子） |
| `node --experimental-strip-types packages/dsh-l2d-plugin/lib/yandere-preempt.test.mjs` | PASS（10 项，overlay.js 真实 DOM 执行） |
| `node --experimental-sqlite tests/chain-15/run.mjs` | PASS（5 项断言组，15/15 链零丢弃） |
| 前端自检（55 项静态断言 + 17 项 vm 运行时断言，vs `git show HEAD` 逐字节比对） | PASS |

**commit 记录**：

| commit | 内容 |
| --- | --- |
| `0e61df6` | feat(runtime): 模型形态变化接入 /ai/call 与 MCP 工具列表（需求一） |
| `d1fa07c` | feat(ui): 设置页追加模型形态变化操作项 + 设置菜单参数监视台直达链接（需求一/二） |
| `2cd24d1` | feat(caption): 字幕出口正则准入——参数内容不进最终渲染字幕（附带项三） |
| （本提交） | chore(release): v0.5-Plugin-Stable 版本号与发布记录 |

**已知事项**：体型 2 → 默认体型的循环回落被既有 `cycleBodyType` 钳制行为挡住（`form-unavailable`），新工具与既有右键「切换体型」行为保持一致，未顺手改动（遵循「现有功能行为一致」基线）；浏览器侧视觉验收随后续回归补充。
