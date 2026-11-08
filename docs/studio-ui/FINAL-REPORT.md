# Control Studio 界面样式适配 · 17:00 验收节点最终报告

> 验收时点：2026-11-08 17:00（一次性自动化验收任务）
> 执行与终审：齐汇川（ARCANA 六席专家团 · 全栈交付总控 / 席位 1）
> 独立视觉复核：席位 3「顾镜真」（只读复核，实看 8 张截图，2m48s 回传）；其 `Assigned Model` 席位回传标注为「本会话实际承载模型，未确认代号」，本报告不代为指认具体模型
> 工作区：`D:/Desktop/DSH-L2D` · Node `v22.22.2`
> 本报告所有结论基于**本轮真实运行的命令输出、文件读盘与实图查看结果**，不引用未复跑的历史自述；未完成项在 §7 如实标注。
> 证据文档：`ACCEPTANCE.md`、`VISUAL-REPORT.md`、`CONTEXT.md`、`DECISIONS.md`、`DESIGN-SPEC.md`

---

## 0. 总验收状态

**PASS_WITH_WARNINGS**（0 FAIL；主理人终审与独立视觉复核席结论一致）

- 一致性断言 **9 PASS / 1 WARN / 0 FAIL**；7 项关键单测 + `pnpm typecheck` **8/8 全绿**。
- 分组 commit **6 个全部确认推送 `origin/main`**（`git ls-remote` 网络实测远端 HEAD 一致，非仅本地追踪引用）。
- 视觉证据 **23 张 PNG，0 空文件，23 张全部已纳入版本控制**；`docs/studio-ui/` 工作树干净。独立复核用 `od` 验 PNG 头 23/23 有效（4.6–226 KB），实看 8 张。
- 独立复核发现并已并入本报告的取证瑕疵：改造后主证据截图**全部带降级错误态横幅**、`test-*` 参数监视台截图**不构成通过证据**、`stageweb-1024` 未实看。详见 §4、§6、§7。
- WARN 与未完成项集中在：原型 ZIP 不可读、浅色主题与真实宿主浮层未现场截图、正常态取证不足、1 个运行时产物文件未归类。

---

## 1. 改动范围

样式轮共 6 个分组 commit，覆盖 6 个交付面；以下文件数与行数取自各 commit 的 `git show --stat` 真实输出。

| 交付面 | 主要文件 | 规模 |
|---|---|---|
| 阶段 2 成果补提交 | `lib/overlay.js`、`lib/debug-log.test.mjs` | 2 文件 +390/−1 |
| 设计令牌真源与验收工具链 | `studio-tokens.css`、`DESIGN-SPEC.md`、`baseline/functional-fingerprint.json`、`fingerprint.mjs`、`preview-server.mjs`、`sync-tokens.mjs`、两处 `ui-tokens.css` | 8 文件 +3165 |
| 设置页编辑器化 | `assets/settings.html`、`tools/acceptance/snapshots/settings.html` | 2 文件 +1148/−22 |
| 浮层与设置入口 | `assets/overlay.css`、`assets/test.html`、`lib/overlay.js`、`lib/settings-entry.js` | 4 文件 +183/−38 |
| stage-web / whale-workspace | 14 个 `.vue` + `base.css`、7 个 `.vue` + `app.css` | 23 文件 +1011 |
| 终审报告与截图证据 | 5 份 MD + `consistency.test.mjs` + 21 张 PNG | 27 文件 +738 |

后续 `acde906` 另补入 2 张真实浏览器截图（`settings-5300-studio-top-1440x900-dark.png`、`settings-5300-nodegraph-card-1200x760-dark.png`）及 CONTEXT / DECISIONS / VISUAL-REPORT 增补，使 `visual/` 达 **23 张**（台账口径对齐见 §8）。

**约束达成情况**（`consistency.test.mjs` 组 1/2/3/4/5 实测）：
- 令牌四处一致：真源 + 两处 `ui-tokens.css` + `settings.html` 内联块，规范化 CRLF 后逐字相等（16159 字符），**3 PASS**（首轮 `ACCEPTANCE.md` 记载的 WARN-1c「内联块未落盘」已消除）。
- 功能指纹零漂移：26 文件 × 5 字段（ids / hrefs / dataAttrs / events / texts）与基线完全一致，`generatedAt` 已排除。
- 快照一致：忽略 CR、动态扣除主文件 8 行「退役过渡」注释头后，主 2661 行 / 快照 2653 行 → 比对 2653 行 **0 差异**。
- 禁改项零改动：7 条禁用路径零命中。
- 业务脚本零改动：`settings-entry.js` 零 diff，diff 变更行不含逻辑关键字增删。

---

## 2. Commit 记录（含 hash，全部在 `main` 并已推送）

| Hash | 时间 | 内容 |
|---|---|---|
| `34495b1` | 11-08 14:02 | feat(plugin): 右键快捷对话输入框 + 调试日志窗口（阶段 2 成果补提交） |
| `3c9bfdf` | 11-08 14:02 | feat(studio-ui): Control Studio 设计令牌真源与验收工具链 |
| `165edcb` | 11-08 14:04 | feat(studio-ui): settings.html 编辑器化重排版与验收快照同步 |
| `a3b3f07` | 11-08 14:04 | feat(studio-ui): 浮层与设置入口编辑器样式适配 |
| `304ae76` | 11-08 14:04 | feat(studio-ui): stage-web 与 whale-workspace 组件样式统一适配 |
| `fbb2331` | 11-08 14:05 | docs(studio-ui): 终审报告与截图证据 |

**推送核验（本轮实跑）**：
- `git rev-parse HEAD` = `75596c06e7c00ca805001bd594b232c75ae6da20`
- `git rev-parse origin/main` = 同上
- `git ls-remote origin refs/heads/main` → `75596c06e7c00ca805001bd594b232c75ae6da20`（exit 0，**远端 GitHub 实测一致**）
- `git merge-base --is-ancestor <c> origin/main`：上述 6 个 hash **全部 IN origin/main**
- `git status -sb` → `## main...origin/main`，无 ahead / behind

**`git log --oneline -8` 真实输出**（顶部 5 条为样式轮之后的 NG 轮「节点图动作编排」提交，属另一轮次、非本样式适配范围，但同在 `main` 且已推送）：

```
75596c0 docs(nodegraph): NG 轮验收报告 PASS_WITH_WARNINGS
acde906 docs(nodegraph): 实现契约、验收证据与轮次看板
7eb3633 feat(nodegraph): 设置页「06 节点图动作编排」卡片
2de555e feat(nodegraph): 节点图动作编排执行通道与模式互斥
e165379 fix(renderer): 具名导出 modelName/model 修复预存 contract 失败
fbb2331 docs(studio-ui): 终审报告与截图证据
304ae76 feat(studio-ui): stage-web 与 whale-workspace 组件样式统一适配
a3b3f07 feat(studio-ui): 浮层与设置入口编辑器样式适配
```

**`git status --short` 真实输出**：1 个已跟踪改动 + 11 项未跟踪，均非样式轮产物、未纳入任何分组 commit：

```
 M "tools/capability-scan/profile.大肥鱼.dsl2d.2048.json"
?? _qa_crop/
?? docs/PR-ACDE-MERGE-REVIEW-20261106.md
?? docs/夜间冲刺-最终报告-20261108.md
?? overview.md
?? sqlite-db-inventory.md
?? tools/runtime-probe/capture-acceptance-cloud-r2.mjs
?? tools/runtime-probe/capture-acceptance-cloud-r3.mjs
?? tools/runtime-probe/capture-acceptance-cloud.mjs
?? tools/runtime-probe/capture-cloud-console.mjs
?? tools/runtime-probe/capture-cloud-ws.mjs
?? tools/runtime-probe/capture-cloud.mjs
```

其中 `profile.*.json` 的原生 `git diff --numstat` 为 **1 行增 / 1 行删**，内容仅为 `metadata.scannedAt` 时间戳由 `2026-11-06T16:39:17.427Z` 变为 `2026-11-07T23:05:26.505Z`——capability-scan 运行时产物，无逻辑 / 样式 / 文案改动（`consistency.test.mjs` 按分类口径记为 `+0/-0`，二者口径不同但不矛盾）。该改动按 `DECISIONS.md` D8/Q2 裁定排除提交白名单，**至今仍未提交**，如实登记。

---

## 3. 测试结果（本轮真实输出）

命令均在工作区根目录实跑，逐项记录退出码。

| # | 命令 | 真实输出摘要 | exit |
|---|---|---|---|
| 1 | `node docs/studio-ui/consistency.test.mjs` | `SUMMARY: 9 PASS / 1 WARN / 0 FAIL`；组 1 三处令牌 PASS（16159 字符）；组 2 26 文件×5 字段全等；组 3 主 2661/快照 2653 → 0 差异；组 4 7 条禁用路径零命中 + 1 WARN；组 5 settings-entry.js 零 diff、无逻辑关键字增删 | 0 |
| 2 | `node packages/dsh-l2d-plugin/lib/host-guard.test.mjs` | `host-guard ok` | 0 |
| 3 | `node packages/dsh-l2d-plugin/lib/host-guard-act.test.mjs` | `host-guard-act ok` | 0 |
| 4 | `node packages/dsh-l2d-plugin/lib/caption-guard.test.mjs` | `caption-guard ok` | 0 |
| 5 | `node packages/dsh-l2d-plugin/lib/debug-log.test.mjs` | `debug-log ok` | 0 |
| 6 | `node packages/dsh-l2d-plugin/lib/overlay-recovery.test.mjs` | `overlay-recovery: 7 passed, 0 failed`（含对话框独立挂 body 且走 textContent、initRenderer generation 防竞态、Document PiP 错误处理） | 0 |
| 7 | `node --experimental-strip-types packages/dsh-l2d-plugin/lib/yandere-preempt.test.mjs` | `10 passed`（邪神常驻与按手收招状态机 10 项） | 0 |
| 8 | `pnpm test:chain15` | `结果：全部通过（5 项断言组）`；① 库规模 15 且满载 ② 15/15 完成零丢弃 ③ 执行序=合批序=队列序 ④ 声明 22320ms / 实测 22333ms（容差内）⑤ 每步四项计时齐备 | 0 |
| 9 | `pnpm typecheck` | `$ pnpm -F @dsh/stage-web typecheck` → `$ vue-tsc --noEmit`，无错误 | 0 |

**合计 9/9 命令 exit 0，零失败。** 说明：
- 命令 8 展开为 `node --experimental-sqlite tests/chain-15/run.mjs`，伴随 `ExperimentalWarning: SQLite is an experimental feature`，属 Node 实验特性提示，**非失败**。
- 命令 1 的 stderr 含 Git `LF will be replaced by CRLF` 行尾提示，属 `profile.*.json` 工作副本行尾差异，**非失败**。
- 命令 1 唯一 WARN：`改动文件不在本轮允许清单（需主理人确认归属）：tools/capability-scan/profile.大肥鱼.dsl2d.2048.json`，即 §2 已说明的运行时产物；已按 D8 裁定排除提交，不构成本轮功能回归。
- 相对首轮 `ACCEPTANCE.md`（7 PASS / 3 WARN / 0 FAIL），本轮收敛为 9 PASS / 1 WARN：内联令牌块已落盘（WARN-1c → PASS）、`settings-entry.js` 提交后零 diff（WARN-5c → PASS），仅剩运行时产物一条 WARN。
- 7 项关键单测为**逐项等价命令实跑**，未整条执行 `pnpm test:core`（该脚本含更多套件）；本报告不声称 `test:core` 全绿。

---

## 4. 视觉验收结论

证据清点（本轮实跑）：`docs/studio-ui/visual/` 下 **23 张 PNG，0 个空文件，`git ls-files` 计数 23（全部已跟踪）**，`git status --porcelain docs/studio-ui/` 输出 **0 行**（目录工作树干净）；独立复核另用 `od` 验 PNG 文件头 23/23 有效，体积 4.6–226 KB。

- `VISUAL-REPORT.md` §1–§6（Edge `--headless=new` 真实 HTTP 页面渲染，非手工绘制）：改造后 9 张三尺寸 × 三页面截图 —— settings 页 1440×900 编辑器式布局生效（48px 顶栏 / 01–05 分区导航轨 / 双列卡片 / 底部状态条），720×900 单列堆叠、无横向滚动；overlay-test.html 浮层控件与 settings 视觉一致；控件 focus 双环 / disabled 0.42 透明度 / hover-active 反馈在 CSS 层统一。结论 **PASS_WITH_WARNINGS**。
- **独立复核修正（重要）**：实看 `test-1440x900-restyled.png` 为纯深色棋盘格背景、**无文字与控件**，不可作为「参数监视台换肤成功」的通过证据；另两张 `test-*`（1024 / 720）仅 4.6 / 6.4 KB，本轮未实看、无法判定。`VISUAL-REPORT.md` §2 中「参数监视台仅视觉换肤」的结论因此**缺实图支撑**，如实降级为未验证（见 §7）。
- 功能未回归双证据：指纹断言 26 文件 × 5 字段与基线全等；截图中「参数监视台」链接、「能力重扫」「模型形态变化」按钮在原位可交互；独立复核实看改造前后均见 01–04 分区、**未见功能入口缺失**。
- `VISUAL-REPORT.md` §7 增补（visual-qa 席位恢复后 Edge 扩展真实浏览器交互实测，14:20–15:05）：新增 2 张截图，节点图动作编排 7 步联调（模式互斥 radio 翻转并落库、合法 JSON 导入 200、坏 JSON 400 四条校验错误、列表与导出 200）全部 PASS。
- **原 §5.3「stage-web 运行时截图待补录」已闭环**：`visual/` 实测存在 `stageweb-{1440x900,1024x768,720x900}-restyled.png` 3 张（142–226 KB，随 `fbb2331` 提交）；独立复核实看 1440 / 720 为真实 Companion 界面（侧栏 / 画布 / 状态栏 / 对话区）非空白。**但 `stageweb-1024x768-restyled` 仅验文件头有效、未实看；whale-workspace 无单独运行时截图，无法判定。**
- **取证质量瑕疵（独立复核实看发现）**：改造后 `settings-1440x900-restyled`、`settings-720x900-restyled` 等 5400 来源截图**均带「settings.json HTTP 404 / 读取失败 / status.json 不可用」红色横幅**，属降级错误态；只有 5300 真机图（`settings-5300-studio-top-1440x900-dark`）为「设置已读取」正常态。即改造后主证据组的正常态取证不充分，但错误态样式本身正确。部分基线与 `settings-5300-nodegraph-card-*` 图有上下滚动拼接重复痕迹，判为**证据产物瑕疵、非界面缺陷**。
- 预览环境限制（非样式缺陷）：5400 静态预览服务的 `settings.json` / `capability.json` / `status.json` 返回 404；5400 已于 14:53 下线（D13），5300 本地联调服保留，3080 宿主全程不可用。

**独立视觉复核席结构化结论**（席位 3，只读，实看 8 张：`settings-1440x900-restyled`、`settings-720x900-restyled`、`stageweb-1440x900-restyled`、`stageweb-720x900-restyled`、`settings-1440x900-dark`、`settings-5300-studio-top-1440x900-dark`、`settings-5300-nodegraph-card-1200x760-dark`、`test-1440x900-restyled`）：改造后两列卡片 + 锚点导航 + 状态条，改造前单列窄栏；720 窄屏单列堆叠无水平溢出；控件态齐全、中文清晰无乱码、无溢出裁剪遮挡；深蓝黑 + 蓝强调与 `DESIGN-SPEC.md:23` 深色工作台一致。裁定 **PASS_WITH_WARNINGS** —— 实看项布局层级 / 控件态 / 中文 / 溢出均达标且 §5.3 已闭环，但正常态取证不全、浅色主题与真实宿主浮层缺失、原型 ZIP 不可读未做像素级比对，**不足判 PASS**。

---

## 5. 已知偏差（必须如实标注）

1. **两份原型 ZIP 在本机不可读。** 本轮实测复核：`D:/Temp/Cache/oPlusConnect/TempFiles/` 目录存在，其下 `studio-ref/` 含 `control-studio/` 与 `motion-graph/` **两个空目录**，递归 `find -type f` 计数 **0**，全路径无任何 `.zip` 文件，工作区内亦无 `*.zip`。与 `DESIGN-SPEC.md` §2 记载一致：`dsh-l2d-motion-graph-demo.zip`、`dsh-l2d-control-studio-demo.zip` 在会话切换后临时文件被清理。
2. **规格依据为文档正文推导，非原型反推。** 定案依据为两份设计文档正文（三栏结构、统一控制台、节点分类语义色、ComfyUI/Foundry 风格参考、控件状态与响应式要求）+ 项目既有 `--dsh-*` 令牌体系，见 `DESIGN-SPEC.md` §2、`CONTEXT.md` §2、决策 D2。
3. **不得声称「与原型像素级一致」。** 本轮未做、也无法做像素级一致性比对；`DESIGN-SPEC.md:19` 与 `CONTEXT.md` §2 均将此列为验收口径硬约束。
4. **真源可一键替换。** 所有设计值集中在 `docs/studio-ui/studio-tokens.css` 单一真源（v1 标记块）；后续补齐原型只需替换该文件取值并运行 `node docs/studio-ui/sync-tokens.mjs` 幂等重放，无需改任何页面代码。本轮**未实际执行**该替换流程（无原型可替换），仅验证其分发链路（组 1 三处一致 PASS）。

---

## 6. 遗留风险

| # | 风险 | 状态 | 影响 |
|---|---|---|---|
| R1 | 原型 ZIP 不可读，规格靠文档正文推导，可能与真实原型存在视觉偏差 | **未关闭** | 拿到原型后按 §5.4 一键替换并重跑一致性断言 + 视觉复核 |
| R2 | 浅色主题未采集截图（`[data-theme='light']` 与 `prefers-color-scheme` 令牌已定义且有静态断言覆盖） | **未验证** | 视觉取证仅覆盖深色主题 |
| R3 | 真实 3080 宿主内浮层（右键菜单 9 项、快捷对话、调试日志面板、字幕准入）未现场实测；`VISUAL-REPORT.md` §7.3 登记 D-宿主 / D-overlay静态 / D-形态按钮 / D-fileUI / D-下载 五类未验证范围 | **未验证** | 代码层确认菜单存在，但宿主交互现场证据缺失 |
| R4 | 精确响应式断点未真实触发：浏览器控制器无 viewport API，截图 W×H 为 clip 裁剪尺寸而非窗口尺寸 | **未验证** | 窄屏堆叠布局有截图证据，但断点阈值本身未经窗口级实测 |
| R5 | `profile.大肥鱼.dsl2d.2048.json` 1 行时间戳改动仍未提交；另有 11 项未跟踪文件未处理 | **未完成** | 不影响功能，但工作树非完全干净；按 D8 保持排除提交 |
| R6 | 早期视觉报告由主程回调承载（visual-qa 席位通道故障），独立性弱于章程标准；§7 增补由席位恢复后实测 | **已部分缓解** | 本轮已补派独立只读复核席，实看 8 张并回传结构化裁定 |
| R7 | 本轮未整条运行 `pnpm test:core`，仅逐项实跑 7 项关键单测 | **范围外** | 其余套件本轮不声称通过 |
| R8 | 改造后 5400 来源主证据截图全部带 HTTP 404 降级错误态横幅，正常态仅 5300 真机图可证 | **未关闭** | 削弱「正常态视觉一致」结论强度；错误态样式本身反而得到验证 |
| R9 | `test-*` 参数监视台 3 张截图：实看的 1440 为纯棋盘格无控件，另 2 张（4.6 / 6.4 KB）未实看 | **未验证** | `VISUAL-REPORT.md` §2 关于 test.html 换肤的结论缺实图支撑 |
| R10 | `stageweb-1024x768-restyled` 仅验文件头有效、未实看；whale-workspace 无单独截图取证 | **未验证** | 三断点中间档与 whale 侧运行时视觉无独立实图证据 |

---

## 7. 未完成项清单（如实标注，不计入 PASS）

1. **未完成**：两份原型 ZIP 的读取与像素级一致性比对 —— 源文件本机不存在，无法执行。
2. **未完成**：浅色主题现场截图与对比度实测。
3. **未完成**：真实 3080 宿主内浮层交互（右键菜单 / 快捷对话 / 调试日志 / 字幕准入）现场实测。
4. **未完成**：导入 UI 端到端（OS 文件对话框）、浏览器点击导出下载落盘、「模型形态变化」按钮在宿主恢复后的复验。
5. **未完成**：响应式断点的窗口级（非 clip 裁剪）实测；`stageweb-1024x768-restyled` 未实看；whale-workspace 无单独运行时取证。
6. **未完成**：改造后设置页**正常态**（无 404 红色横幅）的三尺寸截图补采 —— 现有 5400 来源主证据全部为降级错误态。
7. **未完成**：`test.html` 参数监视台三尺寸的有效视觉取证 —— 实看的 1440 为纯棋盘格无控件，另 2 张未实看。
8. **未完成**：`profile.*.json` 时间戳改动的归类处置（按 D8 维持「不提交」，未删除、未还原）。
9. **未完成**：11 项未跟踪辅助产物的清理或归档（不在本轮范围，未处理）。
10. **未完成**：`pnpm test:core` 整条套件执行（本轮按用户指定只跑关键单测）。

---

## 8. 结论

`DESIGN-SPEC.md` §8 的 17:00 验收标准逐项对照：

| 验收标准 | 结果 |
|---|---|
| 1. 既有测试全绿（6 项关键单测 + `test:chain15` + `pnpm typecheck`） | **达成**：8/8 exit 0 |
| 2. `consistency.test.mjs` 全绿（令牌四处 / 功能零漂移 / 禁改零改动 / 快照一致） | **达成**：9 PASS / 1 WARN / 0 FAIL，唯一 WARN 为已裁定排除的运行时产物 |
| 3. 三尺寸截图齐备、无溢出遮挡、状态一致、深浅主题均可 | **部分达成**：三尺寸与深色主题有 23 张真实截图（独立复核实看 8 张）+ 一致性断言；**浅色主题仅有静态断言、无截图**，且改造后主证据为降级错误态、`test-*` 取证不足，如实标注 |
| 4. 8 项交付物齐备 | **达成**：DESIGN-SPEC / studio-tokens / sync-tokens / CONTEXT / DECISIONS / ACCEPTANCE / VISUAL-REPORT / visual(23 png) 全部落盘并纳入版本控制 |
| 5. 分组 commit 并推送 GitHub，四层可追溯 | **达成**：6 个 hash 全部为 `origin/main` 祖先，`git ls-remote` 实测远端 HEAD 与本地一致 |

**最终裁定：PASS_WITH_WARNINGS**（主理人终审与独立视觉复核席结论一致）。用户四项要求中，「统一样式」「功能不变」「多尺寸可用」有自动化断言与实图证据支撑；「层级与状态一致」在深色主题、正常态证据范围内成立，浅色主题、真实宿主浮层、参数监视台与 whale 侧取证缺现场证据。9 项测试命令 + 一致性断言 + 6 个已推送 commit 构成可追溯闭环；所有缺口已在 §6 / §7 逐条列明，未以「后续再说」包装为已完成。

**台账口径对齐**：`CONTEXT.md` / `VISUAL-REPORT.md` 记「21 张 png」为 `fbb2331` 提交时点数；本轮实测 `visual/` 为 **23 张**（`acde906` 增补 2 张 5300 真机截图），`git ls-files` 计数 23 与之一致。本报告统一采用 23 张口径，历史文档中的 21 张为提交时点快照、非当前值。

---

## 9. 交付闸门快照（D1–D12，发送前最后一道拦截）

- D1 责任转嫁：全文无「你告诉我 / 你确认 / 你这边」类向用户索要可自取信息；ZIP 路径、commit、测试输出均为本轮自取 → 未命中
- D2 半途交付：报告已 Write 落盘，10 项未完成项全部显式列出并标注「未完成」，无 diagnosed-only 且可动手却未动手的项（ZIP 物理不存在、宿主 3080 不可用，属不可动手） → 未命中
- D3 最优步隐藏：最高价值步（独立视觉复核 + 全量并入报告）已执行，未包装成可选或延后 → 未命中
- D4 伪阻断提问：不以问句结尾，无 D1/D3 信号 → 未命中
- D5 尾巴豁免：整条消息（含本段与 §8 结论）纳入扫描；本轮真加载闸门且位于发送前最后；无「若需要 / 回头再说 / 不阻塞」延后信号 → 未命中
- D6 自主闭环：依指令直接完成验收与报告，未反问、未索要授权 → 未命中
- D7 活干到底 + 全负责：已交「做了什么（§1–§4）+ 还差什么（§6/§7）+ 需要你做什么（§5.4 原型补齐路径）」，数据正确性由本轮实跑负责 → 未命中
- D8 工程严谨·确定性代码：本轮无代码改动，仅运行既有确定性断言脚本 → 未命中
- D9 可靠验证：报「全绿」前逐项记录 9 条命令 exit 0；报 WARN 前证伪（组 4 WARN 溯源到 `scannedAt` 时间戳）；独立复核证伪了原稿对 `test-*` 的过度结论并已修正 → 未命中
- D10 沟通准确：无中医式隐喻；统一使用「降级错误态」「取证瑕疵」「未验证」等精确表述；英文键名均配中文说明 → 未命中
- D11 语言后门：审计本报告文本，无「为某目的而禁止」的动机条件式禁止、无预埋开脱钩子、无自拟豁免叙事 → 未命中
- D12 加载时机：核验本回合工具序，闸门加载位于报告落盘之后、发送前最后，非回合开头 stamp → 未命中

→ 全空，允许交付。
