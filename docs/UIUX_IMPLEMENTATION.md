# UI/UX 现代化 — 实施方案

依据：`docs/UIUX_AUDIT.md`（差距）、`docs/UIUX_COMPONENT_MAPPING.md`（映射）。
原则：令牌单源不动摇；组件接口不破坏；悬浮层豁免区不碰。

## Phase 2 — 第一批（并行开工就绪）

### W1. overlay 样式外置（P0，解锁其余并行）
- 把 `overlay.js` 的 `STYLE_TEXT` 抽成 `packages/dsh-l2d-plugin/assets/overlay.css`。
- `readTokenCss()` 的同步 XHR 改为注入 `<link rel="stylesheet">`（ui-tokens.css + overlay.css 两条）。
- 插件与调试服各加一条只读路由发送 overlay.css（对齐 ui-tokens.css 现有做法）。
- 验收：注入后首帧无裸样式；`v=` 版本参数对 overlay.css 同样生效；邪神模式特效不变。

### W2. 令牌化清理（P0）
- `M3Switch.vue`：44px/20px 硬编码改为由 `--dsh-control-sm`、`--dsh-space-*` 推导，外观不变。
- `overlay.js`/`overlay.css`：面板宽 304px、max-height 760px 等收进令牌或注释说明豁免理由。
- 验收：`grep -nE "[0-9]+px" apps/stage-web/src/components/*.vue` 仅剩豁免项。

### W3. 设置面单轨化（P1）
- 对照 `settings.html` 功能清单，补齐 `SettingsPanel.vue` 缺失项。
- 新建 DshTextInput / DshSelect（映射表 B 节），替换 settings.html 的原生控件样式。
- settings.html 过渡期保留；UI 顶部加"已迁移"提示，两个版本后删除（**需用户确认退役时点**）。

## Phase 2 — 第二批
- DshMenu / DshToast（P2）：悬浮层菜单与提示组件化，供宿主侧复用。
- 状态栏数据接入：StageArea 状态条帧率/参数/通道接真实数据（现全是占位"—"）。
- M3Icon 补充图标：按 DshMenu/DshToast 需要加。

## Phase 3（远景，不在本任务书内展开）
- 舞台页与悬浮层共享一套 Vue 组件（悬浮层引轻量运行时或 Web Components）。
- 情境四态视觉差异化增强（依赖行为系统输出真实 context）。

## 并行分工建议（供总控派发）
| 工作包 | 文件 | 依赖 |
|---|---|---|
| A：W1 overlay.css | overlay.js、plugin/assets、路由 | 无，可立即开工 |
| B：W2 令牌化 | M3Switch.vue、ui-tokens.css | 无 |
| C：W3 设置单轨 | SettingsPanel.vue、settings.html、新控件 | 依赖 B 的新控件令牌（可同分支先后合） |

## 回归清单
1. 舞台页：主题切换、设置抽屉开合、滑杆/开关/分段交互。
2. 悬浮层：注入首帧无裸样式、拖拽物理、右键菜单、气泡、余额条、邪神模式开关。
3. `prefers-reduced-motion` 下所有过渡归零。
4. 深浅两主题下 WCAG AA 抽查（正文/强调色）。
