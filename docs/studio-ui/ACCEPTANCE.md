# DSH-L2D Control Studio 样式适配 · 一致性与回归验收记录

> 执行时点：2026-11-08（本轮样式作业进行中）
> 执行者：arcana-backend-engineer（陆溯源，席位 4 / MiMo），按 team-lead 派单承担 regression-guard 断言机制
> 契约真源：`docs/studio-ui/DESIGN-SPEC.md`；唯一新增交付：`consistency.test.mjs`、`ACCEPTANCE.md`
> 复现命令：`node docs/studio-ui/consistency.test.mjs`（零依赖、只读、可重复、不写文件）

## 0. 执行环境与方法

- 工作区：`D:/Desktop/DSH-L2D`；`git diff --cached --name-only` 为空（无暂存改动），`git diff --name-only` 有 4 个 tracked 改动。
- 断言全部真实读文件 / 真实跑 `git` / 真实执行 `fingerprint.mjs`，**无 mock、无伪造结果**。
- 一致性脚本输出格式：逐组 `PASS/WARN/FAIL + 说明`，末尾 `SUMMARY`；有 FAIL 时 `process.exitCode = 1`。

`node --check docs/studio-ui/consistency.test.mjs` → `SYNTAX-OK consistency.test.mjs`（exit 0）

`node docs/studio-ui/consistency.test.mjs` 真实输出（exit 0）：

```
PASS [1 令牌四处一致] packages/dsh-l2d-plugin/assets/ui-tokens.css 标记块与真源逐字相等（忽略 CRLF/LF，16159 字符）
PASS [1 令牌四处一致] apps/stage-web/src/styles/ui-tokens.css 标记块与真源逐字相等（忽略 CRLF/LF，16159 字符）
WARN [1 令牌四处一致] packages/dsh-l2d-plugin/assets/settings.html 标记块「未落盘」（settings-restyler 尚未同步内联），本项不计 PASS
PASS [2 功能指纹零漂移] 26 个文件 × 5 字段（ids/hrefs/dataAttrs/events/texts）与基线完全一致；generatedAt 已排除
PASS [3 快照一致] 忽略 CR；扣除主文件 8 行退役注释头（保留 doctype）；主 1757 行 / 快照 1749 行 / 比对 1749 行 → 逐行一致，0 差异
    INFO 未跟踪文件 28 项（不纳入本组判定）：_qa_crop/survey-debug-1.jpg, ... docs/PR-ACDE-MERGE-REVIEW-20261106.md …
PASS [4 禁改项零改动] git diff --name-only 共 4 个 tracked 改动，7 条禁用路径零命中
WARN [4 禁改项零改动] 改动文件不在本轮允许清单（需主理人确认归属）：tools/capability-scan/profile.大肥鱼.dsl2d.2048.json
    git diff 相对 HEAD：+247 / -1 行
    分类：含中文字符串字面量 +26 行；逻辑关键字 +25 行；CSS 样式串 +21 行
PASS [5 业务脚本未被改动] settings-entry.js 当前零 diff
PASS [5 业务脚本未被改动] JS 功能要素零漂移由组 2 指纹断言覆盖（ids/hrefs/dataAttrs/events/texts 全等）
WARN [5 业务脚本未被改动] 相对 HEAD 的累计 diff 含 25 行逻辑关键字新增；… 转人工复核，不伪自动通过
SUMMARY: 7 PASS / 3 WARN / 0 FAIL
```

## 1. 断言组结果表

| # | 断言组 | 结果 | 说明与比较口径 |
|---|---|---|---|
| 1a | 令牌 · 真源 vs `assets/ui-tokens.css` | PASS | 标记块 `BEGIN…END`（含 END 标记，与 `sync-tokens.mjs` 的 `slice(a, b+end.length)` 同口径），忽略 CRLF/LF 后逐字相等，16159 字符 |
| 1b | 令牌 · 真源 vs `apps/.../ui-tokens.css` | PASS | 同上；该副本原始为 CRLF（16461 字节），规范化后与真源相等 |
| 1c | 令牌 · `settings.html` 内联块 | **WARN** | **未落盘**：全文 `indexOf(BEGIN) = -1`。按派单要求如实计 WARN，不伪 PASS。settings-restyler 落盘后重跑自动转 PASS |
| 2 | 功能指纹零漂移 | PASS | 实跑 `node docs/studio-ui/fingerprint.mjs`（无 `--write`），26 个文件 × `ids/hrefs/dataAttrs/events/texts` 与 `baseline/functional-fingerprint.json` 深度比对，`DIFFCOUNT=0`；`generatedAt` 已排除。**未出现需判定「样式误伤功能」或「指纹脚本需排除新增纯样式内容」的差异** |
| 3 | 快照一致 | PASS | 口径：忽略 CR；动态定位并扣除主文件 `<!doctype html>` 之后含「退役过渡」字样的 8 行注释头（保留 doctype）；主 1757 行 / 快照 1749 行 → 比对 1749 行，逐行 0 差异。口径随文件内容动态计算，样式落盘后仍适用 |
| 4a | 禁改项零改动 | PASS | `git -c core.quotepath=false diff --name-only` 共 4 个 tracked 改动；7 条禁用路径（renderer.js / lib/index.js / dsh-l2d-db/** / mcp-bridge/** / dsh-l2d-mcp/** / data/** / tools/w3-registry/**）零命中 |
| 4b | 改动文件归属 | **WARN** | `tools/capability-scan/profile.大肥鱼.dsl2d.2048.json` 不在本轮允许清单，需主理人确认归属（详见 §3） |
| 5a | `settings-entry.js` 零 diff | PASS | 当前 `git diff --name-only` 不含该文件 |
| 5b | JS 功能要素零漂移 | PASS | 由组 2 指纹断言自动覆盖（26 文件 × 5 字段全等） |
| 5c | 业务脚本 diff 自动判定 | **WARN** | 相对 HEAD 累计 diff 含 25 行逻辑关键字新增，单凭 diff 无法隔离本轮边界；按契约打印摘要转人工复核，结论见 §5，**不伪全自动通过** |

`SUMMARY: 7 PASS / 3 WARN / 0 FAIL`，`process.exitCode = 0`。

## 2. 既有测试套件结果表

全部实跑，命令在工作区根目录执行，输出摘要如下：

| # | 命令 | 真实输出摘要 | exit |
|---|---|---|---|
| 1 | `node packages/dsh-l2d-plugin/lib/host-guard.test.mjs` | `host-guard ok` | 0 |
| 2 | `node packages/dsh-l2d-plugin/lib/host-guard-act.test.mjs` | `host-guard-act ok` | 0 |
| 3 | `node packages/dsh-l2d-plugin/lib/caption-guard.test.mjs` | `caption-guard ok` | 0 |
| 4 | `node packages/dsh-l2d-plugin/lib/debug-log.test.mjs` | `debug-log ok` | 0 |
| 5 | `node packages/dsh-l2d-plugin/lib/overlay-recovery.test.mjs` | `overlay-recovery: 7 passed, 0 failed`（含「对话框独立挂 body 且内容走 textContent（防注入）」「initRenderer 带 generation 防旧代竞态」等） | 0 |
| 6 | `node --experimental-strip-types packages/dsh-l2d-plugin/lib/yandere-preempt.test.mjs` | `10 passed`（邪神常驻与按手收招状态机） | 0 |
| 7 | `node --experimental-sqlite tests/chain-15/run.mjs` | `结果：全部通过（5 项断言组）`；`✓ ① 库规模 15 且 15 段恰好满载` `✓ ② 15/15 全部完成、零丢弃` `✓ ③ 顺序正确` `✓ ④ 实测总时长 ≈ 链级汇总` `✓ ⑤ 每步四项计时齐备`；`声明 22320ms / 实测 22349ms`；伴随 `ExperimentalWarning: SQLite is an experimental feature`（非失败） | 0 |
| 8 | `pnpm typecheck` | `$ pnpm -F @dsh/stage-web typecheck` → `$ vue-tsc --noEmit` | 0 |

**8/8 全绿，零失败。**

## 3. 禁改项核查（详）

`git diff --name-only`（`core.quotepath=false`）实际 4 项：

| 文件 | 判定 |
|---|---|
| `apps/stage-web/src/styles/ui-tokens.css` | 允许（主理人同步的分发副本 / apps 样式） |
| `packages/dsh-l2d-plugin/assets/ui-tokens.css` | 允许（主理人同步的分发副本） |
| `packages/dsh-l2d-plugin/lib/overlay.js` | 允许（overlay-restyler 独占；当前内容为 DESIGN-SPEC §6.3 要求原样保留的阶段 2 成果） |
| `tools/capability-scan/profile.大肥鱼.dsl2d.2048.json` | **未归类 WARN**：既非 7 条禁用路径，也不在本轮允许清单；为本轮之前遗留改动，建议主理人确认归属或单独提交 |

补充：`git ls-files --others --exclude-standard` 有 **28 项未跟踪文件**（`_qa_crop/*`、`docs/studio-ui/`、`docs/PR-ACDE-MERGE-REVIEW-20261106.md`、`overview.md`、`packages/dsh-l2d-plugin/lib/debug-log.test.mjs`、`tools/runtime-probe/*` 等）。按派单要求，禁改核查口径基于 `git diff --name-only`（tracked 改动），未跟踪文件不纳入 PASS/WARN 判定，此处仅登记。其中 `docs/studio-ui/` 为本轮主理人新建的契约目录，`debug-log.test.mjs` 为 DESIGN-SPEC §6.3 要求保留的阶段 2 单测。

## 4. 偏差与未验证范围

1. **原型 ZIP 缺失**：DESIGN-SPEC §2 记载两份原型包实测不存在，本轮按文档正文 + 现有 `--dsh-*` 令牌推导，**未做像素级一致性比对**，不得声称与原型一致。
2. **样式作业尚未全量落盘**：当前 `settings.html` / 快照 / `settings-entry.js` / `overlay.css` / `test.html` / `apps/**` 组件均无 tracked diff；本记录是「断言机制建立 + 当前时点基线快照」。样式完成后**必须重跑** `consistency.test.mjs`，届时 WARN-1c 应自动转 PASS；若出现 FAIL 即视为样式误伤功能。
3. **未做真实浏览器视觉验收**：三种窗口尺寸截图、深浅主题、溢出/遮挡/对比度由 `visual-qa` 席负责，本记录不覆盖。
4. **禁改核查范围**：仅 `git diff --name-only`（工作区 vs HEAD，tracked）；不含 staged（已确认为空）、未推送提交、未跟踪文件。
5. **指纹覆盖边界**：`fingerprint.mjs` 明确排除 `<style>` / `<script>` 块与 CSS 特征串，抽取 id / href / data-* / 事件绑定名 / 中文可见文案 / 中文字符串字面量；不覆盖纯 CSS 视觉属性与 DOM 顺序，后者依赖视觉验收。
6. **未修改任何现有源码**：本轮仅新建 `consistency.test.mjs` 与 `ACCEPTANCE.md`；未执行 `--write` 刷新基线，未运行 `sync-tokens.mjs`，未 commit。

## 5. 组 5 人工复核结论（按要求不伪全自动通过）

自动分类：`overlay.js` 相对 HEAD `+247 / -1` 行，其中含中文字符串字面量 +26 行、逻辑关键字 +25 行、CSS 样式串 +21 行。

人工取证：

- 9 个 hunk 中 **8 个为纯新增**（`@@ -X,0 +Y,N @@`）；唯一 `-1/+1` 位于 `@@ -1111 +1217 @@`，是菜单标题三元表达式**追加分支**：
  `- title.textContent = menuView === 'root' ? 'DSH-L2D' : menuView === 'appearance' ? '模型外观' : '面部';`
  `+ title.textContent = menuView === 'root' ? 'DSH-L2D' : menuView === 'quickchat' ? '快捷对话' : menuView === 'appearance' ? '模型外观' : '面部';`
- 新增逻辑为 `pruneL2dLog / pushL2dLog / renderL2dLog`、`.l2d-qc-*` 与 `.l2d-logpanel-*` 样式串、`menuButton('快捷对话')` / `menuButton('调试日志')` 等，均属 DESIGN-SPEC §6.3 明确要求「原样保留、不得回退或覆盖」的阶段 2「右键快捷对话 + 调试日志窗口」成果。
- **时间证据**：`overlay.js` mtime = `2026-11-08 07:04:03 +0800`；`baseline/functional-fingerprint.json` mtime = `2026-11-08 13:14:27 +0800`（`generatedAt=2026-11-08T05:14:27.266Z`）。改动早于基线生成约 6 小时，基线指纹已包含这些要素，与当前比对 `DIFFCOUNT=0` 相互印证。

**复核结论：这些逻辑关键字新增不是本轮样式适配引入的功能改动，而是基线前既存成果；本轮 JS 功能要素零漂移由组 2 指纹断言自动证明（26 文件 × 5 字段全等）。** 由于缺少「基线时刻的完整源码快照」，`git diff`（相对 HEAD）无法单独隔离本轮边界，故该项保持 WARN 并转人工结论，符合派单「不要伪全自动通过」的要求。建议后续若需全自动隔离，在基线目录增存一份源码快照（需主理人授权，本轮未做）。

## 6. 结论

**PASS_WITH_WARNINGS**

- 0 FAIL，一致性机制可用且可重复；8/8 既有测试与 `pnpm typecheck` 全绿；功能指纹零漂移、快照一致、禁改项零命中。
- 3 项 WARN 均为**如实登记、非伪通过**：(1) settings.html 内联令牌块待 settings-restyler 落盘；(2) 1 个历史遗留文件改动需主理人确认归属；(3) 业务脚本 diff 边界需人工复核（结论已给出，指向阶段 2 成果）。
- 本轮交付为「断言机制 + 当前时点验收记录」；样式全量落盘后须重跑本脚本，以 WARN-1c 转 PASS 且无 FAIL 作为最终放行条件。

---

## 7. 终审重跑记录（2026-11-08 14:05，主理人执行）

样式全量落盘并完成分组提交（`165edcb` / `a3b3f07` / `304ae76`）后重跑：

| 组 | 结果 | 说明 |
|---|---|---|
| 1 令牌四处一致 | 3 PASS | 真源 + 两份 ui-tokens.css + settings.html 内联块逐字相等（16159 字符） |
| 2 功能指纹零漂移 | PASS | 26 文件 × 5 字段与基线全等 |
| 3 快照一致 | PASS | 0 差异 |
| 4 禁改项零改动 | PASS + 1 WARN | 7 条禁用路径零命中；唯一 WARN 为 `profile.大肥鱼.dsl2d.2048.json`（+0/-0 行，历史遗留运行时产物，不提交） |
| 5 业务脚本零改动 | 3 PASS | settings-entry.js 已提交后 **零 diff**，原 §5 WARN-3 自然消除 |

**终审结果：9 PASS / 1 WARN / 0 FAIL，较首轮（7 PASS / 3 WARN / 0 FAIL）收敛。** 唯一剩余 WARN 为运行时产物文件，已显式排除提交白名单。最终放行条件达成。
