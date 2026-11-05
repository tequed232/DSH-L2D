# UI/UX 组件映射表（Phase 2 实施依据）

读法：`现有资产 → 目标组件 → 接入方式`。接入方式三类：
- **直接复用**：现有文件不动（或仅改名），import 即用。
- **重构接入**：改现有文件后接入，改动点已列出。
- **移植令牌**：新写组件，样式只从 ui-tokens.css 取 `var(--dsh-…)`。

## A. 现有资产 → 目标组件

| 现有资产 | 目标组件 | 接入方式 | 备注 |
|---|---|---|---|
| `ui-tokens.css` | DshTokens（令牌层，不建组件） | 直接复用 | 仍是唯一令牌源；新档位只加在这里 |
| `M3Button.vue` | DshButton | 直接复用 | 接口不变；是否改名见待裁决项 |
| `M3Icon.vue` | DshIcon | 直接复用 | 18 图标够用；新图标在 ICONS 表内加 |
| `M3Sheet.vue` | DshSheet（底部抽屉） | 直接复用 | ESC/scrim/safe-area 已齐 |
| `M3Segmented.vue` | DshSegmented | 直接复用 | |
| `M3Slider.vue` | DshSlider | 直接复用 | |
| `M3Switch.vue` | DshSwitch | 重构接入 | 44px 轨宽、20px 位移改 `--dsh-control-sm`/`--dsh-space-*` 推导 |
| `SettingsPanel.vue` | DshSettingsPanel（唯一设置面） | 重构接入 | 吸收 settings.html 的功能项后成为单轨 |
| `StageArea.vue` | DshStage | 直接复用 | 空态/情境胶囊/状态栏照旧 |
| `useSettings.ts` | useSettings（不变） | 直接复用 | 存储键、data-theme 驱动不动 |
| `base.css` | 全局层（不变） | 直接复用 | |
| `overlay.js` STYLE_TEXT | `assets/overlay.css` | 重构接入 | CSS 字符串抽成独立文件，随 ui-tokens.css 同路由分发；overlay.js 只注入 `<link>`（替代同步 XHR） |
| `overlay.js` 内 chip/bubble/price/menu/panel DOM | DshOverlayChrome（参考实现） | 移植令牌 | 结构保留在 overlay.js（无框架环境），样式全部走 overlay.css |
| `settings.html` | DshSettingsPanel | 重构→退役 | 功能并入 SettingsPanel.vue；过渡期保留链接跳转 |
| `.l2d-yandere-fx` | 保留原样 | 豁免 | 界面规范明确不动 |
| `test.html` | 渲染自检页 | 直接复用 | 只保证令牌 link 不破 |

## B. 缺口组件（Phase 2 需新建）

| 目标组件 | 参考来源 | 接入方式 | 优先级 |
|---|---|---|---|
| DshTextInput | settings.html 原生 input 样式（overlay.js `.l2d-row input` 规则） | 移植令牌：8 圆角、sunken 底、accent 聚焦边 | P1 |
| DshSelect | 同上 select 规则 | 移植令牌 | P1 |
| DshMenu / DshMenuItem | overlay.js `.l2d-menu`（176px/min、shadow-3、hover 规则） | 移植令牌 | P2 |
| DshToast / Hint | SettingsPanel `.note` 块 | 移植令牌：raised 底、radius-lg | P2 |
| DshStatusBar | StageArea `.status` 条 | 移植令牌 | P3（先保持现状） |

## C. 表面 → 组件装配关系

| 表面 | 装配 |
|---|---|
| 舞台页 stage-web | DshTokens + base.css + DshStage + DshSheet + DshSettingsPanel + 通用控件 |
| 悬浮层 overlay | DshTokens（同步注入）+ overlay.css + 保留 DOM 结构；面板区逐步引用与 stage-web 相同的类名约定 |
| 设置页 settings.html | 过渡期：`<link>` ui-tokens.css + 功能对齐 DshSettingsPanel；退役后 302 → 舞台页设置抽屉 |
| 调试台 / test.html | `<link>` ui-tokens.css，不自持样式 |
