# UI/UX 现代化 — Phase 1 审计报告

范围：用户可见界面（舞台页 / 悬浮层 / 设置面 / 调试台）。不含 Live2D 模型动作与参数动画。
规范基线：`docs/界面规范.md`；令牌源：`packages/dsh-l2d-plugin/assets/ui-tokens.css`。

## 1. 现状总览

| 表面 | 入口 | 令牌接入 | 状态 |
|---|---|---|---|
| 舞台页 | `apps/stage-web`（Vue 3 + Vite） | `main.ts` 引入 ui-tokens.css | 健康，组件化完整 |
| 悬浮层 | `packages/dsh-l2d-plugin/lib/overlay.js`（3898 行） | 注入时同步 XHR 读 ui-tokens.css | 结构与令牌分离，但样式以 JS 字符串内联 |
| 独立设置页 | `assets/settings.html`（1640 行） | `<link>` 引入 | 与 SettingsPanel.vue 双轨维护 |
| 渲染自检 | `assets/test.html` | `<link>` 引入 | 健康 |

## 2. 约束条款 Top 10（现代化必须遵守）

1. **令牌单源**：全仓库只有 `ui-tokens.css` 一份令牌；新界面只写 `var(--dsh-…)`，禁止写死颜色/字号/圆角/阴影/时长。
2. **字号档位**：12/13/14/16/20/26（`--dsh-text-xs…2xl`），标签用 `--dsh-text-label`，不得新增散档。
3. **间距 4 的倍数**：`--dsh-space-1…8`（4/8/12/16/24/32/40/48）。
4. **圆角**：4/8/12/16 + `--dsh-radius-full`；full 只用于状态胶囊与小圆钮；按钮/输入框用 8 或 12，禁大圆角胶囊。
5. **阴影三档定岗**：shadow-1 轻抬、shadow-2 气泡/菜单、shadow-3 面板/抽屉，不得混用。
6. **动效**：一条缓动 `--dsh-ease`（缓出不回弹），时长仅 120/200/320ms；`prefers-reduced-motion` 时归零。
7. **色彩纪律**：中性灰底 + 单一强调色（钢蓝）；涨跌/成功/警告/危险是语义色，不是第二品牌色；正文与强调色 WCAG AA。
8. **主题机制**：`<html data-theme="dark|light">`；悬浮层不跟宿主主题（深色令牌固定写在 `#dsh-l2d-root/.l2d-menu/.l2d-panel`）；气泡永远浅底深字。
9. **层级**：舞台 10/40/50；悬浮层 `--dsh-z-overlay/menu/panel`（2147483xxx）只为盖住宿主页面。
10. **豁免区**：邪神模式 `.l2d-yandere-fx` 的颜色与 0.7s 过渡保持原样；占位剪影圆角是身体轮廓，不算界面圆角；`M3*` 只是历史文件名，视觉已不跟 Material 3 走。

## 3. 资产盘点表（可复用结论）

| # | 资产 | 位置 | 行数 | 结论 | 说明 |
|---|---|---|---|---|---|
| 1 | ui-tokens.css | plugin/assets | 138 | **Keep** | 唯一令牌源，五处表面共用，现代化只在此扩档 |
| 2 | M3Button.vue | stage-web/components | 111 | **Keep** | 4 变体×2 尺寸×icon-only，令牌覆盖完整 |
| 3 | M3Icon.vue | stage-web/components | ~70 | **Keep** | 18 个内联线性图标，无 CDN 依赖（离线可用） |
| 4 | M3Sheet.vue | stage-web/components | 121 | **Keep** | 底部抽屉：Teleport+scrim+ESC+safe-area，可直接复用 |
| 5 | M3Segmented.vue | stage-web/components | 87 | **Keep** | role=tablist 分段选择器 |
| 6 | M3Slider.vue | stage-web/components | 115 | **Keep** | webkit/moz 双引擎填充轨道 |
| 7 | M3Switch.vue | stage-web/components | 76 | **Refactor** | 硬编码 44px/20px 位移，需令牌化后保留 |
| 8 | SettingsPanel.vue | stage-web/components | 278 | **Keep** | group/row/text/note/about 分组结构可推广 |
| 9 | StageArea.vue | stage-web/components | 213 | **Keep** | 舞台+空态+情境胶囊+状态栏 |
| 10 | useSettings.ts | stage-web/composables | 75 | **Keep** | localStorage 持久化 + data-theme 驱动 |
| 11 | base.css | stage-web/styles | 61 | **Keep** | reset/focus/scrollbar/reduced-motion 全局层 |
| 12 | overlay.js STYLE_TEXT | plugin/lib | ~100 行 CSS 段 | **Refactor** | 样式内联在 JS 字符串里，应抽成 overlay.css |
| 13 | settings.html | plugin/assets | 1640 | **Refactor→Deprecate** | 与 SettingsPanel.vue 双轨；对齐后退役 |
| 14 | test.html | plugin/assets | 118 | **Keep** | 渲染自检页 |
| 15 | renderer.js | plugin/assets | 676 | N/A | 渲染包，非 UI |

**计数：Keep 11 / Refactor 3（其中 1 个最终 Deprecate）/ Deprecate 1**

## 4. 主要差距

1. overlay.js 单文件 3898 行，UI 样式（约 100 行 CSS 字符串）与拖拽物理/动作状态机/余额轮询混在一起，改样式必然碰逻辑。
2. 设置面双轨：`settings.html`（原生控件+内联样式）与 `SettingsPanel.vue`（组件化）重复实现，样式不一致。
3. 控件缺口：TextInput、Select、Menu（悬浮层已有但为裸 DOM）、Toast/提示条均无组件化版本。
4. M3Switch、部分悬浮层样式存在硬编码尺寸（44px/20px/304px 面板宽等）。
