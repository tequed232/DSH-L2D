# Responsive Settings Window 设计裁决书（含 Global Settings Entry）

> 来源：用户裁决 2026-11-05 18:35 ×2。状态：实施中（UI-FLOAT 升级案）。原文以会话记录为准。
> 交付单元：独立功能模块 `Responsive Settings Window`（含全局入口），不破坏现有设置页业务逻辑。

## 0. 总原则
1. 桌面端自由浮动窗口、手机端全屏工作区、内部响应式布局——**禁止用整体 scale() 缩放模拟适配**。
2. 复用优先：本仓 overlay.js 为原生 JS 无框架——react-rnd 仅作行为规格参考，用原生 Pointer Events + ResizeObserver + matchMedia + CSS Container Queries 实现，不引入框架/依赖。
3. 统一窗口管理：`SettingsWindowManager` 单实例语义（open/close/focus），已打开再点只聚焦不重复创建；DSHBot 模式与普通模式共用同一窗口实例。

## 1. 窗口行为（桌面浮动窗口）
- 拖拽：按住标题栏；缩放：**N/S/E/W + 四角八方向**（悬停切换方向光标，触屏加大热区）。
- 最大化/还原：双击标题栏或按钮；最大化保存 previousGeometry，铺满浏览器可用区域，锁拖拽隐藏手柄；还原时按当前视口重新 clamp（不得把旧坐标直接还原进已缩小视口）。
- 边缘吸附：靠近左右边缘吸附半屏、顶部最大化；吸附前显示半透明预览区。
- 边界约束：不能完全拖出可视区域。
- 尺寸：默认 860×620；最小 480×360；最大=当前可用宽高；初始居中。

## 2. 响应式断点（按浏览器可用宽度）
| 宽度 | 模式 |
|---|---|
| ≥1200px | 桌面浮动窗口 |
| 768–1199px | 紧凑浮动窗口（限制最小宽度，侧栏可折叠） |
| 480–767px | 平板/窄窗口 |
| 320–479px | **移动端全屏窗口**（拖拽改顶部拖动或关闭，去小窗口形态） |
- 横竖屏切换：重算可用空间，不丢设置内容；浏览器缩放：按实际容器尺寸重排（ResizeObserver + 容器查询，不依赖固定分辨率）。
- 内部布局：`container-type: inline-size`；@container ≤600px 侧栏隐藏、单列。

## 3. 状态持久化
`{ maximized, geometry:{x,y,w,h}, previousGeometry }` 存 localStorage（防抖）；恢复时 clamp；最大化前几何必须独立保存。

## 4. UX 与兼容
平滑过渡、resize 光标反馈、触屏友好、键盘可达（Esc 关闭、焦点管理）、prefers-reduced-motion；保留既有 Settings 组件与路由/状态管理；避免全局 CSS 冲突；无固定视口假设。

## 5. Global Settings Entry（全局入口）
- 位置：**DeepSeek Harness 侧边栏底部、账户信息上方**，圆角矩形按钮（宽 100%、高 40-44px、圆角 10-12px、Settings 图标+文字），普通模式与 DSHBot 模式都必须存在。
- 结构：`.sidebar`（flex column）= `.sidebar-main`（flex:1 可滚动导航）+ `.sidebar-footer`（shrink-0：Settings 按钮 + AccountInformation）。**用 Flex 真实布局占位，禁 absolute/fixed 遮挡**。
- 侧边栏高度不足：优先压缩导航可视区，不遮挡底部按钮；侧栏折叠时保留图标入口 + Tooltip。
- 点击 → `SettingsWindowManager.open()`（已开则聚焦）；切换 DSHBot 模式时窗口状态不丢失。
- 最大化/还原/拖拽/缩放行为与浮动窗口完全一致（同一实例）。
- 实施原则：只新增全局入口，不重构账户组件，不改 DSHBot 原有业务逻辑。

## 6. 本仓落点（主理人裁定）
- 注入点：插件 lib/index.js:838 一带已有 webserver/index-inject 注入表——侧边栏按钮经此注入宿主页（先侦察 harness 侧边栏 DOM 是否与 overlay 同页可达；不可达才走 index-inject）。
- 文件所有权（UI-FLOAT 升级）：苏格致 = overlay.js / test.html / 新文件 `lib/settings-entry.js`（按钮+窗口管理器+注入脚本，自包含不依赖构建）+ **index.js 仅限 inject 注册一行（本席特批例外，标注清楚）**；陆溯源的 index.js 其他区域不动。
- 验收用例： decree §六清单 6 组测试全跑（拖拽/缩放边界、最大化还原、浏览器 resize、移动端横竖屏、状态持久化），playwright 实测截图落盘。

## 7. 测试清单（验收要求原文摘要）
Window Management（拖拽/八向缩放/最大化还原/双击/吸附/边界）；Responsive Layout（四断点/横竖屏/浏览器 resize/zoom）；State Persistence（几何/最大化态/恢复/clamp）；UX（过渡/光标/触控/键盘/减少动效）；Compatibility（既有组件/路由/无全局冲突/无固定视口）；Tests（六组）。
