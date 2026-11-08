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
