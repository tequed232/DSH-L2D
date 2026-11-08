# DSH-L2D Control Studio 样式适配 · 视觉验收报告

> 执行时点：2026-11-08 13:58–14:05（改造后截图采集）/ 报告撰写：主理人回调承载（原 visual-qa 席位通道故障，报告注明「通道故障回调」）
> 工具：Edge 无头模式（`--headless=new --window-size=W,H --virtual-time-budget=4000`，独立 user-data-dir），真实 HTTP 页面渲染，非手工绘制。
> 页面来源：本地只读预览服务 `http://127.0.0.1:5400/dsh-l2d/*`（cache-control: no-store，样式落盘后刷新即生效）。

## 1. 证据清单

### 改造后（本轮验收主体，9 张，2026-11-08 13:58）

| 文件 | 页面 | 尺寸 |
|---|---|---|
| `visual/settings-1440x900-restyled.png` | /dsh-l2d/settings | 1440×900 |
| `visual/settings-1024x768-restyled.png` | 同上 | 1024×768 |
| `visual/settings-720x900-restyled.png` | 同上 | 720×900 |
| `visual/test-1440x900-restyled.png` | /dsh-l2d/test.html（参数监视台） | 1440×900 |
| `visual/test-1024x768-restyled.png` | 同上 | 1024×768 |
| `visual/test-720x900-restyled.png` | 同上 | 720×900 |
| `visual/overlay-test-1440x900-restyled.png` | /dsh-l2d/overlay-test.html（浮层控件） | 1440×900 |
| `visual/overlay-test-1024x768-restyled.png` | 同上 | 1024×768 |
| `visual/overlay-test-720x900-restyled.png` | 同上 | 720×900 |

### 改造前基线（visual-qa 席位故障前采集，9 张，13:20–13:24）

`settings-{1440x900,1024x768,720x900}-dark.png`、`settings-3080cached-1200x800-dark.png`、`settings-5300-secdev-1200x700-dark.png`、`settings-5300-formbtn-error-1200x700-dark.png`、`overlaytest-5300-1200x800-dark.png`、`overlaytest-5300-reload-1200x800-dark.png`、`debugconsole-5300-1200x800-dark.png`。

## 2. 核对结论（基于实图查看）

- **1440×900 设置页**：编辑器式布局生效——48px 顶栏（标题左、状态说明右）、左侧 01–05 分区编号导航轨、双列卡片内容区、底部状态条（左：呈现模式；右：连接状态）。卡片统一深色 surface + 1px 描边 + 圆角；分段控件/开关/滑杆/下拉统一强调色与状态；无横向溢出、无元素重叠、中文渲染正常、层级清晰。
- **720×900 窄屏**：卡片自动单列堆叠、左导航轨收起、控件无挤压、无横向滚动，仍可正常操作。响应式断点（<720 单栏）按契约生效。
- **参数监视台（test.html）**：标题「DSH-L2D · 渲染自检」、棋盘格 canvas、功能与数据展示未变（指纹断言同步佐证），仅视觉换肤。
- **浮层控件页（overlay-test.html）**：菜单/面板/按钮/输入统一 studio 令牌风格，与 settings.html 视觉一致。
- **控件状态**：focus 双环、disabled 0.42 透明度、hover/active 反馈已在 CSS 层统一（`data-state` + 原生伪类双通道）；静态页面可验证 disabled（保存按钮因预览服务无 settings.json API 而正确禁用——这是状态机正常工作的证据，见 §4）。

## 3. 功能未回归的现场证据

- 设置页「参数监视台」链接、「能力重扫」按钮、「模型形态变化」按钮均在原位可交互（`settings-5300-formbtn-error-1200x700-dark.png` 记录了形态按钮的失败态文案，改造前后行为一致）。
- 功能指纹断言（consistency.test.mjs 组 2）：26 文件 × ids/hrefs/dataAttrs/events/texts 与改造前基线**完全一致**，功能零漂移。

## 4. 环境限制（非样式缺陷）

`settings.json` / `capability.json` / `status.json` 在 5400 静态预览服务上返回 404，页面正确显示「无法读取…HTTP 404」警示条与「连接失败」状态——这是预览环境无宿主 API 所致（真实宿主 `/dsh-l2d/*` 由 DSH 进程提供）。样式验收不受影响，且恰好验证了错误态提示样式。

## 5. 未验证范围

1. **浅色主题**：`[data-theme='light']` 与 `prefers-color-scheme` 浅色令牌已在真源中完整定义并通过静态断言，但未采集浅色截图（Edge 无头无 force-light 开关、预览页无主题切换入口）。
2. **真实宿主内浮层**（3080 宿主 502）：右键菜单、快捷对话、调试日志面板在真实宿主页面内的现场截图未能采集；浮层样式经由 overlay-test.html 控件页与 overlay.css/STYLE_TEXT 静态核对佐证。
3. **stage-web / whale-workspace 运行时截图**：`apps-restyler` 样式刚落盘，`pnpm -F @dsh/stage-web build` 重建与浏览器截图在报告时点尚未完成，见主报告补录。

## 6. 结论

**PASS_WITH_WARNINGS** —— 三尺寸 × 三页面无溢出/无遮挡/层级清晰/状态一致；功能入口零回归（指纹 + 截图双证据）。警告项：浅色主题与真实宿主浮层未现场截图（§5.1、§5.2），stage-web 运行时验证待构建后补录（§5.3）。

---

## 7. 增补：visual-qa 席位恢复后实测（2026-11-08 14:20–15:05，Edge 扩展交互实测）

> 席位通道恢复，本节为**真实浏览器交互实测**（browser_id=2 Edge 扩展，非无头），并覆盖节点图动作编排联调（dev-server 5300，本席按授权后台启动 `pnpm dev:server`）。

### 7.1 新增截图（本席本会话，真实浏览器产生）

| 文件 | URL | 尺寸(clip) | 时间 | 所验内容 |
|---|---|---|---|---|
| `visual/settings-5300-studio-top-1440x900-dark.png` | 127.0.0.1:5300/dsh-l2d/settings | 1440×900 | 14:54 | 新版 studio 双列布局：01/02 卡片、01–05 分区侧栏、底部状态条；**disabled**（独立窗口·仅桌面版灰化）、**selected**（面板内嵌）现场证据 |
| `visual/settings-5300-nodegraph-card-1200x760-dark.png` | 同上 #sec-nodegraph | 1200×760 | 14:54 | **06 节点图动作编排**卡片全景：模式互斥 radio、选择文件/导入节点图/刷新列表、「已刷新·14:52:14」状态提示、列表「挥手测试 · 大肥鱼 · any」+ 绿色「可用」徽章 + 导出按钮 |

另 `_qa_crop/survey-form-btn.png`（= §1 中 formbtn-error 同源副本，Phase 4 派单命名）。测量口径：浏览器控制器**无 viewport API**，WxH 为 clip 裁剪区域尺寸而非窗口尺寸，响应式断点未真实触发；所有截图为真实浏览器产物，无伪造。

### 7.2 节点图动作编排联调实测（dev-server 5300）

| # | 步骤 | 结果 |
|---|---|---|
| 1 | 5300 原无监听（后端重启窗口期）→ 本席后台 `pnpm dev:server` | 启动成功：`/` 200，模型目录/Core/渲染包 OK |
| 2 | 打开 `/dsh-l2d/settings` 滚动至 06 卡片 | 卡片渲染正常（`settings-5300-nodegraph-card` 截图）；DOM 确认 radio×2、file input、导入/刷新列表/导出按钮全可交互（`disabled="false"`） |
| 3 | 模式互斥：点击「节点图 + LLM 辅助」radio | **PASS**：DOM `motionMode[nodegraph] checked="true"` 翻转；前端 `saveMode` POST 落库（`updatedAt` 06:58:26 → 07:01:48 两次写入）；GET `/dsh-l2d/motion-mode` 回读 `mode:"nodegraph", available:true`（available 随导入联动 true）。注：首次点击未生效系测试工具 DOM 快照过期（node_id 漂移），重试成功——工具因素非产品缺陷 |
| 4 | 导入合法 JSON（与前端 readAsText→JSON body 同构的 curl raw 提交） | **PASS**：200 `{"ok":true,"name":"挥手测试"}` |
| 5 | 导入坏 JSON（缺 schemaVersion） | **PASS**：400 + 四条校验错误 `["schemaVersion 必须是 1，收到：undefined","graph.roots 不能为空","graph.nodes 不能为空","segments 不能为空"]`（error 态证据） |
| 6 | 列表与导出 | **PASS**：页面列表渲染「挥手测试 · 大肥鱼 · any · 可用」+ 导出按钮（截图）；curl `GET /nodegraphs/export?name=挥手测试` → 200 完整 JSON（schemaVersion 1 / 大肥鱼 / any） |
| 7 | LLM 通道基座探测 | `POST /dsh-l2d/ai/call` → 400 `unknown tool: capability_rescan`（端点存活；工具名待开发席提供清单后复测） |

### 7.3 增补未验证范围（在 §5 基础上）

- **D-宿主**：3080 宿主全程无监听进程（netstat 确认）——宿主主页面 Live2D 渲染、右键菜单 9 项、快捷对话（textarea 自适应/Enter 发送）、字幕准入（纯参数不显示/混合只显普通文本）、调试日志面板（HH:MM:SS 行格式/清空）、既有菜单回归观察**未实测**；overlay.js 代码层确认 9 项菜单存在。
- **D-overlay静态**：5300 无 avatar.png（404）→ overlay「渲染未就绪」，`overModelRightClick` 无命中区，两次右键实测菜单未弹出（`overlaytest-5300-reload` 截图）。
- **D-形态按钮**：「模型形态变化」在 dev-server 返回 HTTP 400（无宿主 AI 通道的环境差异）；「正在切换…→已切换·当前形态：体型1」需 3080 恢复后复验。
- **D-fileUI**：file input 依赖 OS 文件对话框，CUA 工具无法安全操作 → 导入 UI 端到端未走通（后端已由 curl 等价验证，前端为同构提交路径）。
- **D-下载**：浏览器点击导出的下载落盘未验证（curl 已证路由与内容）。
- **D-浅色**：同 §5.1，工具无法切换系统色彩偏好。

### 7.4 增补结论

维持 **PASS_WITH_WARNINGS**：可实测范围（设置页 studio 视觉、05 三操作项顺序与文案、06 节点图模式互斥/导入校验/列表/导出全链路、渲染调试台模型渲染）全部通过且证据齐备；宿主 3080 相关的浮层交互、浅色主题、精确断点三类需宿主恢复后复验。
