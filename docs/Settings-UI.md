# 设置页 `settings.html`

`packages/dsh-l2d-plugin/assets/settings.html` 是插件的独立设置页：单文件、零构建、零外链，离线可直接打开。
它替代 `lib/overlay.js` 里 `buildPanel()` 拼出来的那个侧边面板，但**不接管**旧面板——旧面板还在，等宿主把那边的入口摘掉再删。

## 一、约束与取舍

| 约束 | 落地方式 | 理由 |
|---|---|---|
| 单文件、零构建 | 样式与脚本内联；没有 `<link>`、`@import`、CDN、外部字体 | 离线可用；也能被宿主当静态资源直接发出去 |
| 沿用令牌语义 | 把 `ui-tokens.css` 的颜色块**复制**进来，变量名保持 `--dsh-*` | 单文件就不能再 `<link>` 令牌表；复制一份比内联整份文件更小的代价是：改令牌要同步这一处 |
| 暗/亮双模式 | 默认深色 `:root`，`@media (prefers-color-scheme: light)` 覆盖成亮色 | 旧面板固定深色；这一页是宿主里的独立页面，跟随系统更自然 |
| 720~880 宽、垂直堆叠 | `max-width: 880px`，卡片纵向排列，窄屏（<640px）自动单列 | 不做 tabs / 轮播：要能被截长图，也能被宿主塞进窄容器 |
| 无阴影、无渐变、无模糊 | 一律 1px 描边 + 表面色 | 与 `docs/界面规范.md` 的平铺风格一致；阴影在这种满屏卡片上只会显脏 |
| 图标 | 只用一个圆形状态点（CSS），其余全是文字 | 不允许外链图标；按规范也不手绘图标 SVG |
| 表单控件 | 原生 `input/select`，只改颜色与尺寸 | 键盘、读屏、输入法全部白送 |

字体走 `--dsh-font-sans`（system-ui 栈），等宽信息用 `--dsh-font-mono`。字重只有 400/500。

## 二、接口契约（照抄，不猜）

- `GET  /dsh-l2d/settings.json` → 扁平对象，16 个字段
- `POST /dsh-l2d/settings.json` → 只提交改动的字段（扁平 patch），返回同结构
- `GET  /dsh-l2d/status.json` → `version / modelDir / avatarFound / avatar / renderer / core / model / note`
- `GET  /dsh-l2d/capability.json` → `{controls:[{id,status,sourceId?,ownership?,confidence,reason?}], assets, metadata}`（允许 404）
- `POST /dsh-l2d/capability/rescan` → 重扫；未接入时 404
- `POST /dsh-l2d/ai/call` `{name:'l2d_get_state'}` → 入队，再 `GET /dsh-l2d/ai/result?id=` 取回执

`apiKey` 不读、不回显、不提交：页面根本没有这个输入框。空字符串表示「不修改」的语义只对别的客户端有意义。

## 三、五个分区

### 01 显示与布局（4 个控件）

| 控件 | 类型 | 字段 | 说明 |
|---|---|---|---|
| 呈现模式 | 三选一 | `petWindow`（部分） | 独立窗口 → `only`，其余两种 → `off` |
| 自动显隐 | 开关 | 仅本页 | 宿主无对应字段 |
| 自动隐藏阈值 | 数字，px，默认 240 | 仅本页 | 宿主无对应字段 |
| 模型缩放 | 滑杆 0.6~2.0 | `scale` | 宿主同样夹取 |

**为什么呈现模式是「半真」的**：契约里没有 presentationMode。三项里只有「独立窗口」能落到一个真实字段上（`petWindow=only` 就是宿主创建透明桌宠窗、并停用页内浮层）。「面板内嵌 / 应用内悬浮」在宿主侧是同一个 `off`，区分只存在于本页记录里，用于顶部状态条和下一次打开时的回显。「独立窗口」在非桌面 UA 下置灰并标注「仅桌面版」——`Host-API-Audit.md` 里这条能力只有桌面 profile 有。

同样的理由，自动显隐与阈值没有下发通道，写进 `localStorage`（键 `dsh-l2d.settings-ui.v1`），卡片里用一行小字明确写「只记在本页，不会下发给宿主」。宁可承认没接，也不做一个看起来生效的假开关。

### 02 角色与模型（0 个可写控件）

纯展示区，但它是用户判断「为什么没动作」的第一现场：

- 模型名（`status.model`），空着就给「未找到模型文件」
- 四枚资源标签：渲染包 / Core / 模型文件 / 立绘，就位绿点、缺失红点
- 能力画像：按 `supported / approximate / unsupported` 三组列出通道 id，组头带数量
- 不支持的通道点一下，在**芯片行下方**追加一行 `通道 id · reason`，再点收起

展开区放在芯片行下方而不是就地撑开，是为了避免点开一条原因时其余芯片被挤到另一行。`capability.json` 读不到时整块降级成一句「能力画像未接入」，不显示空分组。

### 03 情绪与行为（7 个控件）

`autoAct`、`spontaneousChat`、`clickMode`（随机动作 / DeepSeek 决定）、`memeStyle`、`memeLevel`（0~100 步长 5）、`eyeFollow`、`agentLink`。
顺序按「角色主动做什么 → 被点击时做什么 → 说话风格 → 是否读你」排列，和旧面板一样，但把「戳一戳动作」从底部提到第二项，因为它最常改。

### 04 动画与性能（8 个控件 + 读数区）

`refreshSeconds`（15~3600）、`soundEnabled`、`soundVolume`、`systemSensor`、`mediaSensor`、`reverseEnabled`、`petMode`、`petWindow`。

- **音量按百分比显示**：宿主存 0~1（`writeSettings` 会夹到 0~1），界面滑杆是 0~100，写入时除 100、读回时乘 100。显示 70% 对应文件里的 0.7。
- 读数区三项：帧率、分辨率、渲染就绪。数据来自 `status.json`，帧率与分辨率来自 `l2d_get_state` 的 `info`；`ai/call` 不通、或 8×200ms 内没有回执，就显示「—」，不编数字。每 6 秒刷一次，标签页隐藏时跳过。

### 05 开发者工具（2 个动作）

`version`、`bootTag`（取自 `l2d_get_state` 的 `diag.bootTag`）、`modelDir`、`avatar` 四项只读信息；「参数监视台」直链 `/dsh-l2d/test.html`；「能力重扫」POST `/dsh-l2d/capability/rescan`，成功后重新拉一次 `capability.json`，失败把 HTTP 码和「路由未接入时会 404」写在按钮右边。

## 四、交互模型

1. **改动即保存**：每次变更进 `pending`，300ms 防抖后按一次 POST 发出去，body 只含这一批改动字段。
2. **状态提示只有文字**：顶栏右侧依次是 `正在读取设置` → `保存中` → `已保存 · HH:MM:SS`（绿色）/ `保存失败：<原因>`（红色）。没有 toast、没有淡入淡出。
3. **失败就地可见**：失败会同时写顶栏和**出错控件所在那一行**的红色文字，带一个「重试」——重试会重新读该控件当前值再发一次。控件不会回滚成旧值，用户输入不丢。
4. **读不到设置也要能用**：`settings.json` 404 / 网络失败时顶部出现一条红框说明（含「file:// 直开请改用宿主地址」的提示），页面继续渲染，后续每次保存各自报错。
5. 呈现模式改 `petWindow` 时，错误显示在呈现模式那一行，而不是飘到第 4 区的下拉框上。

## 五、与旧面板的差异

| 维度 | 旧面板（`overlay.js` `buildPanel`） | 新设置页 |
|---|---|---|
| 形态 | 浮在角色上的侧边抽屉，深色固定 | 独立页面，跟随系统明暗 |
| 保存 | 改完点「保存」，一次性 PUT 全量 | 改一个存一个，扁平 patch |
| 失败反馈 | `say('保存失败')` 气泡，1.8 秒后消失 | 顶栏 + 所在行常驻，可重试 |
| 字段覆盖 | 14 项（含 API Key 输入） | 16 个宿主字段 + 3 项本页偏好，无 Key 输入 |
| 能力画像 | 无 | 三色分组 + 不支持通道可展开原因 |
| 实时读数 | 无 | 帧率 / 分辨率 / 就绪 |
| API Key | 有密码框 | 刻意不做（契约里空串=不修改，回显没有意义） |
| 布局 | 单列滚动，行高紧凑 | 卡片分五区，宽屏 880、窄屏单列 |

旧面板里的「强制刷新状态」按钮没有搬过来：它做的是销毁重挂渲染包，属于 overlay 内部状态，独立页面调不到 `window.__DSH_L2D_FORCE_REFRESH__`。

## 六、未接入 / 已知限制

1. `/dsh-l2d/capability.json`、`/dsh-l2d/capability/rescan` 目前**宿主没实现**（`index.js` 里没有这两条路由）。页面两种情况都处理了：读不到就降级，重扫失败就报 404。等路由接上，这块不用改页面。
2. 自动显隐 + 阈值没有宿主字段，只存本页 `localStorage`；`file://` 下 localStorage 可能不可用，此时只在内存里生效。
3. 呈现模式的「面板内嵌 / 应用内悬浮」区分是页面侧推断（是否在 iframe 里 + 上次选择），不是宿主上报的真实形态。
4. 只读读数依赖 overlay 页面在线应答 `l2d_get_state`；只开设置页时三项都是「—」。
5. `soundVolume` 的百分比换算是本页约定，宿主仍然只认 0~1。
6. 没有做 `prefers-reduced-motion` 之外的动效适配；页面本身只有开关与滑杆的 120ms 过渡。

## 七、自测记录

环境：本机 Node 起了一个 mock 主机，`/dsh-l2d/settings.json`（可回写）、`status.json`、`capability.json` 有数据，`capability/rescan` 与 `ai/call` 故意 404；另一个端口只发 HTML，所有接口全 404。

已核对：

- 无 JS 报错（页面自带的 `window.onerror` / `unhandledrejection` 会把错误贴到顶部红框，全程没出现）
- `node --check` 通过（抽出内联脚本单独校验）
- 全文无 `http(s)://`、无 `<link>`、无 `@import`、无 `@font-face`
- 改一个开关 → 服务端只收到一个字段：`PATCH {"mediaSensor":true}`
- 音量滑到 100% → `PATCH {"soundVolume":1}`（换算正确）
- 保存成功顶栏显示 `已保存 · 13:23:18`（绿色）
- 接口 404 时：顶栏 `读取失败：HTTP 404`、红框说明、模型名「—」、能力画像降级
- 在 404 环境点呈现模式：该行出现 `保存失败：HTTP 404 · not found` + 重试
- 能力重扫按钮在未接入时提示 `重扫失败：HTTP 404（路由未接入时会 404）`
- 亮色/暗色两套配色都渲染正常，开关选中态在亮色下是钢蓝底白钮
- 窄屏（<640px）行自动改为上下堆叠

截图（临时目录，非仓库文件，可复现）：

- 暗色整页：`C:\Users\User\AppData\Local\Temp\dsh-preview\dark2.png`
- 亮色整页：`C:\Users\User\AppData\Local\Temp\dsh-preview\light2.png`
- 接口全 404：`C:\Users\User\AppData\Local\Temp\dsh-preview\offline2.png`
- mock 服务脚本：`C:\Users\User\AppData\Local\Temp\dsh-preview\server.js`（7860，带数据）与 `server-broken.js`（7861，全 404）

复现方式：

```bash
node server.js          # http://127.0.0.1:7860/dsh-l2d/settings.html
node server-broken.js   # http://127.0.0.1:7861/dsh-l2d/settings.html
```

## 八、接手时要做的（2026-11-08 晚全部落地）

1. ✅ 已完成：宿主静态路由 `GET /dsh-l2d/settings` 发 `assets/settings.html`（`lib/index.js`）。
2. ✅ 已完成：`/dsh-l2d/capability.json` 与 `/dsh-l2d/capability/rescan` 路由已接入。
3. ✅ 已完成（本轮）：**新设置页覆盖旧面板**——三处旧入口（角色齿轮 ⚙ / 右键菜单「设置」/ 侧栏设置二级菜单）全部改向新设置页：
   - `settings-entry.js` 二级菜单重做为六分区直达（两行式：标题 + 分区说明），点击打开**右侧抽屉 iframe** 加载新设置页 `#sec-xxx` 锚点；URL 运行时探测（真机 `/dsh-l2d/settings`、DevServer `/settings`）。
   - 返回路径明确：抽屉标题栏「完成」按钮 / Esc；「新窗口打开」提供独立标签页出口。
   - `overlay.js` 的 `buildPanel()` 调用摘除（`DSH_L2D_UI.settings.{open,close,focus,isOpen}` 转发抽屉管理器）；旧面板机制代码保留为不可达防御壳，待下次大清理物理删除。
   - `settings.html` 增加 `#sec-xxx` 锚点直达（hashchange 滚动 + 卡片描边高亮）；DevServer 补 `/pet.html` 与 `/settings` 同语义路由。
   - 「账户与余额」不再作为独立菜单项：余额悬浮于角色（miniBadge/price），刷新间隔在「动画与性能」分区。
