# DSH-L2D 现状梳理：设置跳转 / 节点编辑器 / 全链路（2026-11-09）

> 依据：真实源码核实（settings-entry.js、overlay.js、settings.html、motion-graph.html、lib/index.js、lib/nodegraph.mjs）。标注「E-编号」的是问题或边界情况。

---

## 一、设置页面跳转逻辑

### 1.1 入口（3 处，全部统一指向新设置页）

| # | 入口 | 所在文件 | 触发条件 | 落点 |
|---|------|---------|---------|------|
| 1 | 宿主侧边栏「设置」按钮 | `lib/settings-entry.js`（SPA 注入，幂等标记 `__DSH_SETTINGS_ENTRY__`） | 点击按钮 → 弹二级菜单 → 点击分区项 | 右侧抽屉 iframe，直达分区锚点 |
| 2 | 角色齿轮 ⚙ | `lib/overlay.js`（`.l2d-gear`，hover 显现） | click → `openSettingsDrawer()` | 同一抽屉管理器 |
| 3 | 角色右键菜单「设置」 | `lib/overlay.js` `menuButton('设置')` | click → `openSettingsDrawer()` | 同一抽屉管理器 |
| 4 | API 兼容面 | `window.DSH_L2D_UI.settings.{open/close/focus/isOpen}` | 外部/自动化调用 | 转发 `window.DSH_L2D_SettingsWindowManager`（同对象） |

二级菜单结构（settings-entry.js `MENU_ITEMS`，两行式：标题 + 分区说明）：
显示与布局(sec-display) / 角色与模型(sec-model) / 情绪与行为(sec-behavior) / 动画与性能(sec-performance) / 动作编排(sec-nodegraph) / 开发者工具(sec-dev) / 参数监视台(外链 `/dsh-l2d/test.html` 新标签)。
菜单顶部注明「改动即时保存 · 关闭面板即返回宿主」。

### 1.2 路由流转

```
点击分区项
  → closeMenu()
  → SettingsWindowManager.open(sec)
      → ensureDrawer()（单实例，已存在只复用）
      → resolveUrl()：HEAD 依次探测 ['/dsh-l2d/settings'(真机), '/settings'(dev-server), '/dsh-l2d/settings.html'(独立直开)]
          → 命中即缓存 resolvedUrl；全失败 → cb(null)，抽屉打开但内容区空白
      → iframe.src = resolvedUrl + '#sec-<sec>'
          已开时改为 iframe.contentWindow.location.hash = ...（页内 hashchange，不重载）
  → settings.html: hashchange/首载 → applyHashTarget()
      → getElementById('sec-xxx').scrollIntoView(smooth) + .hash-flash 描边 1.6s
```

抽屉结构：标题「设置 · DSH-L2D」+「新窗口打开」外链 +「完成」关闭按钮 + iframe。

### 1.3 返回路径（明确三条）

1. 抽屉标题栏「完成」按钮 → 关闭抽屉回宿主。
2. Esc：全局捕获——先关二级菜单，其次关抽屉，焦点归还设置按钮。
3. 「新窗口打开」：独立标签页加载设置页（返回 = 切回宿主标签）。

### 1.4 数据流（设置值如何生效）

`settings.html` 控件改动 → pending 收集 → 300ms 防抖 → `POST /dsh-l2d/settings.json`（扁平 patch，只发改动字段）→ 顶栏状态文字（保存中/已保存·时间/失败+所在行重试）。
- `apiKey` 字段：新页刻意无输入框（契约空串=不修改）。
- 「自动显隐/阈值」无宿主字段 → 仅存本页 localStorage（键 `dsh-l2d.settings-ui.v1`，UI 明示不下发）。
- 音量：界面 0–100% ↔ 宿主 0–1，写入时除 100。

### 1.5 问题与边界

- **E1 旧面板防御壳**：overlay.js `buildPanel()/openPanel/closePanel/panelOpen` 代码保留但三处调用点已摘除、无入口可达。功能无影响，占体积，待后续大清理物理删除。
- **E2 file:// 抽屉空白**：URL 探测链在 file:// 下全部失败 → `cb(null)` 直接 return，抽屉打开但 iframe 空白，**无用户可见提示**。建议补一行降级文案（未做）。
- **E3 「账户与余额」入口收缩**：旧面板有该分组，新菜单不再单列——余额悬浮在角色上（miniBadge/price），刷新间隔在「动画与性能」分区。老用户需适应。
- **E4 跨站防护**：真机 `GET /dsh-l2d/settings` 有 `isCrossSite → 403`。iframe 同源加载不受影响；第三方页面直链会 403（预期防护）。
- **E5 sec-* id 双处耦合**：菜单项 `sec` 值与 settings.html 分区 id 需两处同步，新增分区时易漏。
- **E6 抽屉宽度**：固定 min(460px, vw-24)。settings.html 在窄容器下自动单列堆叠（已适配），但超长分区需 iframe 内滚动。

---

## 二、节点编辑器（Motion Graph Lab）整体结构与工作流程

### 2.1 文件与分层（`assets/motion-graph.html` 单文件零依赖，~2450 行）

| 层 | 模块 | 职责 |
|----|------|------|
| 数据层 | `Graph` | nodes/edges/selection/viewport/clipboard 内存真源；addNode/addEdge/removeNodes/removeEdge/uid |
| | `NodeDef` | 5 类节点 schema（expression/motion/pose/look/delay）+ 分组 + 默认 props |
| | `Combos` | 自定义组合事件（localStorage `dsh-mg-combos.v1`，file:// 降级内存） |
| | `Slots` | 按 modelId 分槽存整图（localStorage） |
| | `PanelLayers` | 三监看浮窗图层管理（localStorage `dsh-mg-panels.v1`） |
| 逻辑层 | `Compiler` | graph → segments，DFS 前序，每 8 步一段 |
| | `Validator` | 本地复刻宿主三校验器（顶层 7 字段白名单/无环/roots 可达/悬空 next/必填/上限/名称白名单/取值域/总时长） |
| | `Serializer` | build/exportText/import（优先 meta.editor 完整还原，无则反推线性视图；派生字段一律丢弃重校验） |
| | `Cache` | 编辑态缓存失效管理 |
| 表现层 | `UI` | renderNodes/renderWires/renderInspector/renderLibrary/renderCombos/菜单/模态/右键 |
| | `Layout` / `RuntimeCtl` / `IO` / `PanelLayers` | 自动布局 / 本地模拟 / 导入导出 / 浮窗图层 |
| 测试钩子 | `__MG_*` + selftest | 程序化断言写 title：`validate-ok roundtrip-ok resizers-ok ctx-ok combo-ok panels-ok` |

### 2.2 核心交互

- **节点**：库项拖入（落点实例化）/单击追加（视口网格位置）；拖拽移动；Shift+拖拽框选；Ctrl+C/V 复制粘贴；Del 删除；右键菜单（删除/复制/禁用启用/多选时「存为组合事件」/属性面板）。
- **连线**：out 端口拖拽 → in 端口；portType 不同色拒绝（flow/signal/data）；目标已有连线**重连替换**；右键删线；单击选中。
- **画布**：空白拖拽平移、滚轮缩放（指针为中心）、Ctrl+0 适配、minimap 点击跳转、拖文件导入 JSON。
- **分栏**：左栏宽/检查器宽 col-resizer（180–420 / 220–520）、JSON 停靠栏 dock-resizer 拖高，双击复位，≤1100 断点清 inline 交还响应式。
- **浮窗图层**：三监看面板（模拟/小地图/Live2D 监听）头部拖拽（clamp+持久化）、—收起、点击置顶、底部 ☰ 清单（⤒置顶/↑↓调序/●○显隐）。
- **组合事件**：多选 ≥2 → 右键/Inspector「存为组合事件」→ 命名 → 库内 COMBO 分组；单击实例化（画布中心）/拖入（落点）/×删除；实例化展开为普通节点+连线。

### 2.3 数据处理方式

- **编辑真源** = `Graph.nodes/edges`（内存）；坐标、样式、组合等编辑器辅助信息只进 `meta.editor`，不污染执行字段。
- **导出文档**：顶层严格 7 字段 `{schemaVersion, kind, name, modelBinding, graph, segments, meta}`；`segments` 为执行真源（Compiler 生成），`graph` + `meta.editor` 为还原画布所需。
- **双校验**：编辑期 Validator 实时（badge/Inspector）；导出前再跑一次（有错仍可导出但明示）。
- **导入三通道**：文件选择 / 拖文件到画布 / 粘贴文本；导入后缓存/校验派生字段一律丢弃并重新校验。

### 2.4 问题与边界

- **E7 单文件膨胀**：~2450 行、6 个 localStorage 子系统，无构建拆分——继续加功能需评估拆模块。
- **E8 组合实例化不校验端口类型**：`addEdge` 直连不查 portType 同色（正常连线交互有校验）。依赖 Validator/编译期兜底，建议实例化后自动跑一次 Validator 并提示。
- **E9 PanelLayers 无「重置布局」**：拖拽位置持久化后无恢复默认入口（分栏 resizer 有双击复位，浮窗没有）。建议图层清单加「复位」。
- **E10 窄屏 inline 定位**：≤860 断点用媒体查询固定值，用户拖过面板后 inline style 优先生效，可能与窄屏布局打架（clamp 保底不出屏）。
- **E11 localStorage 容量**：Slots 存整图 JSON，多槽大图在 5MB 配额下理论可满（现量级无虞）。

---

## 三、用户操作 → 最终效果完整链路

### 3.1 链路 A：节点图编排 → 真机动作执行（主链路）

```
[编辑] MG-LAB 画布搭图 → Validator 实时校验（badge 三态）
   ↓ 导出（下载/复制/存槽位）
[落盘] 两条通道：
   a) settings.html #sec-nodegraph 卡片：文件/拖拽/粘贴
        → POST /dsh-l2d/nodegraphs/import → validateNodegraph → saveNodegraph
          → l2d-nodegraphs/<safe-name>.json（schema v1，文件名安全化，重名覆盖）
   b) 手动放 JSON 进宿主 l2d-nodegraphs/ 目录
[模式] settings.html radio → POST /dsh-l2d/motion-mode → l2d-motion-mode.json
        nodegraph = 节点图 + LLM 辅助（拦整链类工具 l2d_act/l2d_emote）
        llm      = 纯 LLM 通道（缺省，SPEC §3 state 文件缺失时默认）
[触发] POST /dsh-l2d/nodegraphs/run?name=X
        ← 双防护：非 loopback 403 / 跨站 403（宿主 GUI 内部触发）
   → runNodegraph → loadNodegraph（读盘 + 再校验）
   → segments → nodegraphExecutor（createInboxActExecutor）
   → executeActionSequence → ai-inbox 动作队列
[呈现] overlay 逐段执行 5 类原语（expression/motion/pose/look/delay）
   → param-injector 写参数（口型红线/Node Ownership 白名单/物理让位全程守卫）
   → Live2D 模型呈现
[回执] receipts / completedSegments / remainingSegments 原样返回 200
```

### 3.2 链路 B：设置变更 → 生效

抽屉/独立页改控件 → 300ms 防抖 POST patch → `settings.json` → overlay 在下次读取/轮询时应用（scale/sound/refreshSeconds/sensor 等）；呈现类改动即刻可见。

### 3.3 链路 C：LLM 通道

`/ai/call` → host-guard 白名单（19 项，含 FI 轮 `l2d_facial`/`l2d_facial_manual`、形态直达 `l2d_set_form`）→ `guardAiCall`（nodegraph 模式拦整链编排类、放行单步原语；unknown-tool 优先）→ overlay 分发 → `window.DSH_L2D` 具名 API → FacialBridge / 动作链。

### 3.4 衔接关系总图

```
settings-entry（侧栏入口）─┐
overlay 齿轮/右键 ────────┼→ SettingsWindowManager（抽屉 iframe）
                           │      └→ settings.html（六分区 + #sec-xxx 锚点）
                           │             ├→ settings.json（16 字段 patch）
                           │             ├→ motion-mode（nodegraph/llm）
                           │             └→ sec-nodegraph 卡片 → /nodegraphs/import
MG-LAB（编辑器）──────────┘（导出 JSON 走同一 import 通道）
                                  ↓
                    l2d-nodegraphs/（落盘，schema v1）
                                  ↓ run?name=X（loopback only）
                    loadNodegraph → segments → executeActionSequence
                                  ↓ ai-inbox 队列
                    overlay 执行 → param-injector（守卫）→ Live2D 模型
```

### 3.5 问题与边界（链路级）

- **E12 run 仅 loopback**：远程触发需另配鉴权方案，当前属安全设计。
- **E13 模式缺省 llm**：只导入节点图但未切 motion-mode → run 不会生效；设置页 radio 有状态显示，但导入成功提示与模式无联动提醒（易踩坑点，建议导入成功后若 mode=llm 给出提示）。
- **E14 无 meta.editor 的老 JSON**：反推线性视图会丢失画布布局（设计如此，需用户知情）。
- **E15 探测链同源假设**：抽屉依赖宿主同源；未来宿主改跨域策略会让 HEAD 探测失败 → 抽屉空白（与 E2 同源，可合并修复）。
- **E16 口型红线三层防线**：validator 禁键 → FacialBridge 过滤 mouthOpen/mouthForm → injector 无条件拒绝——LLM/节点图均无嘴部写路径，属任务书钦定边界而非缺陷。

---

## 验收状态

PASS_WITH_WARNINGS —— 三模块现状与衔接全部按源码核实；E1/E2/E8/E9/E13 为值得排期的小改进，无阻断缺陷。
