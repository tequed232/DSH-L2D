# DSH Host API 审计（P1 前置）

> 目的：在写一行呈现层代码之前，先确认 DeepSeek Harness 到底向插件开放了哪些界面能力。
> 方法：只读本地已安装的宿主包，不靠记忆、不猜接口。
> 审计对象：`@deepseek-ai/*`（npx 缓存内的 dsh 0.2.1 安装）、`dsh-whale-widget`、`dsh-client-ui-*`。
> 审计时间：2026-11-03。

## 0. 一句话结论

**DSH 没有"注册浏览器标签页"这种 API。** 它是单页三栏框架（sidebar / main / rightbar），
插件的界面扩展点是**命名 slot**（全局共 109 个），通过客户端插件调用 `ctx.slots.register()` 挂载。
因此 P1 里"默认嵌入浏览器标签页"要落成 **右侧面板的 keyed tab**（最接近"标签页"的宿主概念），
而不是去伪造一个浏览器 tab。

## 1. 证据

| 事实 | 证据位置 |
|---|---|
| 插件可声明客户端入口 | `dsh-client-ui-deliverables/package.json` → `dsh.client = { inject: [...], platform: "web" }`，`exports["./client"]` |
| 客户端插件是普通模块 | 同包 `lib/client.js` 末尾 `exports.apply = apply; exports.inject = inject` |
| React 由宿主提供 | 同文件 `require("react")`（客户端插件不自带 React） |
| 注册接口 | `ctx.slots.register({ name, id, locale, children, inject }, Component)` |
| 条件注册 | `ctx.slots.inject("slot.name", () => ctx.slots.register({...}))` |
| slot 有 kind/scope | `rightbar: { kind: 'single', scope: 'session' }`；`shell.overlay: { kind: 'list', scope: 'root' }`；`sidebar.right.pane.tab: { kind: 'keyed', scope: 'session' }` |
| 框架三栏 | `dsh-client-ui-layout/lib/types/client/AppFrame.d.ts`：`PropsRenderSlots<'sidebar' \| 'main' \| 'rightbar' \| 'shell.bottom' \| 'shell.overlay' \| 'shell.leading'>` |
| 原生窗口能力存在 | 本仓库 `packages/dsh-l2d-plugin/lib/pet-window.mjs` 已在桌面 profile 用 Electron `BrowserWindow` 建无边框透明窗 |

## 2. 能力对照表

| P1 需求 | 宿主是否有该 API | 落地方案 | 结论 |
|---|---|---|---|
| 默认嵌入"浏览器标签页" | ❌ 无 tab 级 API | 用 `sidebar.right.pane.tab`（keyed tab，右侧面板）+ 备用 `rightbar` | **改语义**，可行 |
| 标签页右键菜单 | ⚠️ 无"任意 tab 右键"API；有 `sidebar.right.tab.menu.item` 等 slot | 在自己注册的 tab 上挂菜单项；模式切换入口放设置页 + 菜单项 | 部分可行 |
| App 内悬浮窗 | ✅ `shell.overlay`（root 级 list，覆盖在整个框架之上） | 角色 iframe 挂 overlay，`pointer-events` 只给角色本体 | **可行** |
| 独立悬浮窗 | ✅ 仅桌面 profile（主进程 Electron） | 复用现有 `pet-window.mjs` 通道 | **可行（限桌面）** |
| 独立设置标签页 | ❌ 无独立页签；✅ 有 `settings.section` / `settings.plugins.tab` | 落成设置面板里的一个分区（含 5 个子区） | **改语义**，可行 |
| 界面缩放 / 布局变化 | ❌ 无公开的 UI scale 事件 | 只能 `ResizeObserver` 观察**实际容器** + `devicePixelRatio` | **可行**（与用户建议一致） |
| 跨容器状态保持 | ✅ 客户端插件与宿主服务通信（`ctx.connection` / 本插件 webServer） | 角色 iframe 只创建一次，切换时移动 DOM 节点而非重建 | **可行** |

## 3. 尚待真机验证的三点（不要当成已知）

1. `dsh.client` 入口在 **web profile** 是否与桌面同样加载（deliverables 的 `platform: "web"` 暗示是，但那是官方包，第三方包未验证）。
2. slot 组件里放 `<iframe>` 是否被 CSP / 沙箱限制（DSH 页面有 token 门禁，iframe 同源应可行）。
3. 跨 slot **移动**同一个 iframe 节点（`appendChild` 到新容器）是否会触发重新加载——这决定"零重建"能否成立。
   若会重载，退路是：iframe 常驻一个不可见容器，切换时只改容器样式/定位（不做 DOM 迁移）。

## 4. 由此确定的实现边界

- 不做"浏览器标签页"抽象，避免为不存在的 API 写适配层。
- 呈现层分三档：`pane`（右侧面板 tab）/ `overlay`（框架之上）/ `window`（桌面原生窗）。
- **唯一 Avatar Runtime**：角色仍跑在现有 renderer 页面里，容器只决定它被放在哪。
- 设置页做成 `settings.section` 的一个分区，内部 5 个子区，不假装是独立窗口。

## 5. 真机实验记录：客户端入口（第一次尝试失败，已回滚）

**做了**：在 `package.json` 声明 `dsh.client = { platform: "web" }` + `exports["./client"]`，
新增 `lib/client.js`（`window.__ModuleLoader__.load({ id: 'dsh-l2d', factory: (require) => {...} })`），
在 `apply(ctx)` 里 `ctx.slots.register({ name: 'shell.overlay', id: 'dsh-l2d' }, Badge)`。

**现象**（两次，均为 web profile 真机）：

| 配置 | 页面表现 |
|---|---|
| `dsh.client` 无 `inject` | `Failed to load plugins — web boot: 1 entry did not activate` / `dsh-l2d: loading`（一直挂着） |
| 补 `inject: ["@deepseek-ai/dsh-client-ui-layout"]` | 同上，但状态变 `dsh-l2d: failed` |

角色浮层仍正常（它是 webServer 注入，与此无关），但**整个 DSH 界面被这条失败条目拖进错误页**。

**已确认的**：
- 客户端入口确实会被发现并进入激活流程（状态从 loading → failed 说明 `apply` 被调用了）。
- 失败原因在 `apply` 内部（注册参数或组件契约不匹配），不是加载失败。
- 模块格式是 `window.__ModuleLoader__.load({ id, factory(require) })`，`require` 由宿主注入。

**尚未确认的三点**（下次先验证，不要再盲改）：
1. `register()` 的必填字段：官方调用带了 `locale` 与 `children`，我只给了 `name`/`id`。
2. 组件是否需要宿主注入的 props（`PropsRuntime<'root'>`）才能挂载。
3. `shell.overlay` 是否要求先声明 `kind: 'list'` / `scope: 'root'`。

**流程教训**：一个失败的客户端入口会把**整个 Web UI** 打进错误页，不能直接在正在用的 profile 上试。
下次在临时 profile（复制 web profile、换端口）里验证通过，再动主环境。

## 6. 真机实验记录：客户端入口打通（第二次尝试，成功）

> 时间：2026-11-03（§5 同日的续篇）。环境：web profile（`dsh web --port 3080`）。
> 最终形态见 `packages/dsh-l2d-plugin/lib/client.js`（吞错 + window 变量上报 + get_state diag 回读）。

### 6.1 最终可用的注册调用形态

```js
// lib/client.js —— 模块格式不变：window.__ModuleLoader__.load({ id, factory(require) })
const inject = ['slots'];        // ← 服务名，不是包名！宿主按它等 slots 服务就绪
exports.inject = inject;         // ← 必须；缺了就是 §5 的 "without inject"

function apply(ctx) {
  try {
    // ctx.slots.inject(key, cb)：声明等待 API（@deepseek-ai/dsh-client-ui-renderer）。
    //   - slot 已声明 → cb 同步执行；
    //   - 未声明 → 在声明提交的那次 register() 调用栈里执行。
    // shell.overlay 由 @deepseek-ai/dsh-client-ui-layout 注册 root entry 时用
    // children: { 'shell.overlay': { kind:'list', scope:'root' }, … } 声明；
    // 我们的 apply 早于 layout 注册执行，直接 register 必抛 not declared。
    ctx.slots.inject('shell.overlay', function () {
      try {  // cb 可能跑在 layout 的 register 栈里，绝不能把异常冒进宿主 fiber
        ctx.slots.register({ name: 'shell.overlay', id: 'dsh-l2d' }, Component);
      } catch (err) { window.__L2D_CLIENT_ERROR__ = String(err && err.stack || err); }
    });
    window.__L2D_CLIENT_OK__ = true;
  } catch (err) {
    window.__L2D_CLIENT_ERROR__ = String(err && err.stack || err);
  }
}
exports.apply = apply;
```

组件本体零约束验证过的两点：不需要宿主注入 props；`register` 选项只要 `{ name, id }`
即可（`locale`/`children` 不是必填——那是「声明 slot」时的字段，不是「使用 slot」时的）。

### 6.2 错误 → 修法对照表

| # | 错误 | 根因 | 修法 |
|---|---|---|---|
| 1 | `Failed to load plugins — web boot: 1 entry did not activate`（`dsh-l2d: loading` 挂起） | `dsh.client` 声明了 client 入口但模块没返回 `{ inject, apply }` 契约 | 模块导出 `inject` 数组 + `apply`（§5） |
| 2 | `dsh-l2d: failed` | `dsh.client.inject` 填了**包名** `@deepseek-ai/dsh-client-ui-layout` | 不是包名，是**服务名**：宿主侧 `inject: ['slots']`，且模块要 `exports.inject = inject` |
| 3 | `Error: cannot get property "slots" without inject` | apply 访问了未声明的服务 | 同上：`inject = ['slots']` + `exports.inject = inject` |
| 4 | `Error: slot "shell.overlay" is not declared (a parent entry's children table must declare it)` | SlotRegistry（前端 bundle）只内置声明 `root`；其余 slot 由各 entry 的 `children` 表在 register 时声明。我们的 apply 早于 layout 的 root 注册执行 | `ctx.slots.inject('shell.overlay', cb)` 等声明就绪，register 放进 cb |
| 5 | （预防）cb 内异常会炸宿主 entry | inject 的 cb 可能在 layout 的 register 调用栈中同步执行 | cb 全体 try/catch，错误写 `window.__L2D_CLIENT_ERROR__` |

### 6.3 调试基建（后来人直接复用）

1. **绝不允许 apply 抛异常**：一次抛错会把整个 Web UI 打进错误页（§5 教训）。
   现行模式：apply 全体 try/catch → 错误写 `window.__L2D_CLIENT_ERROR__`（完整栈），
   成功写 `window.__L2D_CLIENT_OK__`。`lib/overlay.js` 的 `l2d_get_state` diag
   里 `clientEntry` 字段回读（slice 上限已提到 4000 字符）。
2. **读 get_state 回执要按 bootTag 过滤**：`diag.bootTag` = overlay.js 的 mtime 派生值，
   只有「本次改完刷新出来的页面」才算数（其他并行浏览器页面在抢同一个 `/ai/poll` 队列）。
   做法：burst ≥30 次 `POST /dsh-l2d/ai/call {name:'l2d_get_state'}` + `GET /dsh-l2d/ai/result?id=`，
   丢弃 bootTag 不等于期望值的回执。
3. **代码缓存不必重启实例**：overlay.js 注入 URL 的 `v=`（mtime 派生）与客户端聚合包
   `/plugins/??<pkg>/client.js&rev=`（mtime/ctime/size 派生，`dsh-client-modules` 内置
   HMR watch）都按文件元数据失效。改完 client.js / overlay.js **刷新页面即拿到新代码**。
4. **验证 slot 组件渲染用截图**：DOM 快照看不到 overlay 层。

### 6.4 结果

- 探针徽标（`shell.overlay` → 蓝色 fixed 顶部胶囊）真机渲染成功，`diag.clientEntry=ok`，无错误页。
- 已升级为角色容器：`shell.overlay` → 320×480 `<iframe src="/dsh-l2d/test.html">`（右下角、
  圆角、半透明边框），模型在 iframe 内渲染成功（test.html HUD + Live2D 模型均可见）。
- §5 的「尚未确认三点」全部关闭：register 无必填的 locale/children；组件不需要宿主 props；
  kind/scope 不由使用方声明（那是 layout 的 children 表的事，用 `slots.inject` 等它即可）。
