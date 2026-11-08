# Motion Graph Lab 构建契约 v1（MG-LAB CONTRACT）

- 定稿：2026-11-08 17:45 · 主理人齐汇川 · 验收窗口 21:00
- 输入：用户五张截图（设计建议三栏稿 / Demo v0.1 功能清单 / Control Studio 六模块信息架构 / 节点编辑器三栏稿 / ComfyUI 风格参考实图）+ ComfyUI 官方连线规范 + n8n/React Flow DAG 设计准则检索结果
- 硬约束：**全部本地开发测试，禁止连接/部署任何服务器**（用户 14:16 裁定持续生效）；零外部依赖，HTML 双击即可打开；导出 JSON 必须能被既有 `POST /dsh-l2d/nodegraphs/import` 直接吃下并 `run`

## 1. 视觉规格（从五图提炼）

| 项 | 规格 |
|---|---|
| 主色板 | 背景 `#0b0b10` / 面板 `#15151d` / 卡片 `#1b1b26` / 文字 `#f2f2f7` / 次要 `#8b8b9e`。**WCAG 修正（情报席实测，17:52 定案）**：原 `#2b2b3a` 边框在 `#15151d` 面板上对比度仅约 **1.3:1**，低于 WCAG 2.1 SC 1.4.11 非文本对比度 ≥3:1。所有**承载信息**的结构性边框（节点描边、端口、输入框、选中态、Inspector 分隔）改用 `--mg-border-strong: #6b6b85`（≥3:1）；纯装饰分隔线可保留暗色但不得作为唯一区分手段。语义色不得作为唯一区分手段（SC 1.4.1），必须配图标/形状/文字标签。 |
| 语义色（沿用 studio-tokens 语义） | 事件/触发=橙 `#ff9a45`；逻辑/条件=紫 `#a78bfa`；动作=绿 `#3ddc97`；预览/通用=蓝 `#6aa8ff`；主强调=紫 `#7c5cff`。端口与连线按此颜色编码，**只允许同色端口相连**（类型安全）。 |
| 画布 | 点阵网格（22px dot grid）、可缩放/平移、右下角小地图、底部缩放控件（− / + / fit）；双击背景 fit-to-view。 |
| 节点 | 圆角卡片（头部色带 + 图标 + 标题 + 正文预览 + 底部动作区）；**端口常显但低对比、hover/拖线时高亮**（官方规范，非「hover 才显现」）；拖线时高亮全部可连接端口、不匹配端口变暗；选中态描边（≥3:1）；执行态发光 + 连线粒子动画；禁用节点本轮只实现 **NEVER 语义**（灰化 + 不参与编译 + 其下游连线按断开处理），**BYPASS 语义列演进项**。 |
| 连线 | **贝塞尔曲线（DSH-L2D 本轮默认实现，非「ComfyUI 默认」）**——官方提供曲线/直角/直线/隐藏四种可切换样式、无默认表述，本轮只实现贝塞尔，其余列演进项；按数据类型颜色编码、只能同色端口相连；点击选中可删；重连自动替换。 |
| 三栏 | 左 Node Library（分组：事件节点 / 逻辑节点 / 动作节点）｜中 Graph Canvas｜右 Inspector（节点属性）。 |
| 顶栏 | Logo + 标题 + 版本徽标 `Demo v0.1` + 操作区（▶ 模拟触发 / ✓ 校验 / ⇩ 导出 / ⇧ 导入 / ⋯）。 |
| 字体与可访问性 | 系统无衬线 + 等宽数字；深色主题；`focus-visible` 双环（外 `#7c5cff` + 内 `#f2f2f7`）；`@media (prefers-reduced-motion)` 下降级为静态高亮、禁用粒子动画；键盘可达（Tab 遍历节点、Delete 删除、Ctrl+C/V、Esc 取消连线）。 |

## 2. 六模块 Control Studio 统一入口（对应图3）

单一入口页 `control-studio.html`，六张卡片 2×3：Motion Graph（动作节点与逻辑编排，链接 → motion-graph.html）、LLM Copilot（自然语言编辑规则）、Bridge & Cache（绑定/缓存/命中监视）、Model Manager（模型能力与资源）、Runtime（执行队列/优先级/风控）、Preferences（外观/快捷键/系统）。统一入口，原 Live2D Runtime 仍是最终执行权威；其余五模块可链接到既有设置页/参数监视台或标注「规划中」，**禁止编造已实现功能**。

## 3. 文件所有权（并行互不重叠）

| 成员 | 独占文件 |
|---|---|
| mg-frontend | `packages/dsh-l2d-plugin/assets/motion-graph.html`（新建，单文件零依赖）、`docs/motion-graph-lab/visual/*.png`（截图） |
| cs-frontend | `packages/dsh-l2d-plugin/assets/control-studio.html`（新建，单文件零依赖） |
| mg-backend | `packages/dsh-l2d-plugin/assets/settings.html`（**仅在 06 卡片追加一个入口链接**）、`tools/acceptance/snapshots/settings.html`（同步快照）、`docs/motion-graph-lab/COMPAT-REPORT.md`、`package.json`（如需挂测试脚本，先报主理人） |
| 主理人 | 本契约、任务编排、集成终审、提交推送 |

`docs/studio-ui/preview-server.mjs` 已按 `/dsh-l2d/<file> → assets/<file>` 映射，新 HTML 放 assets/ 下自动可达，**无需改路由**；`tools/dev-server/index.mjs` 同理（后端席核实后如缺映射再补）。

## 4. 导出 JSON 契约（严格对齐 `lib/nodegraph.mjs` validateNodegraph）

```json
{
  "schemaVersion": 1,
  "kind": "dsh-l2d-nodegraph",
  "name": "挥手打招呼",
  "modelBinding": { "modelId": "大肥鱼", "modelHash": "", "bindingMode": "any" },
  "graph": {
    "roots": ["n1"],
    "nodes": [
      { "id": "n1", "type": "expression", "name": "兔牙", "next": ["n2"] },
      { "id": "n2", "type": "look", "x": 0, "y": 0.05, "next": [] }
    ]
  },
  "segments": [ { "priority": "NORMAL", "chain": [ { "kind": "expression", "name": "兔牙" }, { "kind": "look", "x": 0, "y": 0.05 } ] } ],
  "meta": { "dshVersion": "0.5.0", "editor": { "version": 1, "nodes": [], "edges": [], "viewport": {} } }
}
```

硬性规则（违反则导入必失败，前端席须逐条遵守）：
1. **顶层只允许 7 字段**：schemaVersion / kind / name / modelBinding / graph / segments / meta；`meta` 内部任意对象透传（编辑器完整视图状态存 `meta.editor`，导入时优先还原画布）。
2. `graph.nodes[].type` **只允许 5 类**：`expression | motion | pose | look | delay`。设计图里的 Trigger / Workspace State / Condition Gate / Condition 属于**设计层辅助节点**，只存 `meta.editor`，不进 `graph.nodes`。
3. `graph.nodes[]` 字段白名单：`id,type,name,clear,closeMotion,closeAfterMs,delayMs,pose,x,y,next`。**`x/y` 虽在白名单内，但语义是 `look` 节点的视线坐标**——画布坐标若误写成 `x/y`，后端校验会通过、却被编译成错误的 look step（后端席实测）。画布坐标**只能**存 `meta.editor.nodes[].pos`；任何非白名单键（如 `pos`）写在节点上会被 `未知字段` 拒绝。
4. 必填：`expression`/`motion` 需 `name`；`look` 需 `x/y` 数字；`pose` 需 `{right|left}` 至少一侧且值 ∈ POSE_VALUES（rest/finger/grass/chest）；`delay` 需 `0 < delayMs <= 5000`；普通节点 `delayMs` 0~5000。
5. `graph.roots` 非空且引用存在；`next` 无悬空；**必须无环**；roots 可达全部节点；节点 ≤120。
6. `segments` 与 `graph` 同时提供时**以 segments 为执行真源**；每段 ≤8 步、≤15 段、priority ∈ BACKGROUND/NORMAL/FORCE、bubble ≤40 字、**逐段**链估算时长 ≤ `DEFAULT_GATE.maxLifeMs`（action-sequence.mjs:28，是逐段而非总时长）。
7. 编译规则（DFS 前序，与 `compileGraphToSegments` 一致）：从 roots 出发，**后端编译器只跳过 `delay` 节点**（累加 `delayMs` 并入下一动作节点，末端丢弃），每 8 步一段。设计层辅助节点（Trigger / Condition Gate / Workspace State / Condition）由编辑器导出时**不写入 `graph.nodes`**、只存 `meta.editor`——后端不存在这些 type，写入即被拒，编译层不感知其存在。
8. `modelBinding.bindingMode` 默认 `any`（导入即用于任意模型）；`strict` 时至少给 modelId 或 modelHash。
9. 导入：**后端只做 `meta` 字节级透传**（nodegraph.mjs:502），画布还原、缓存状态剥离与绑定重验**全部是编辑器导入器职责**；编辑器优先读 `meta.editor` 还原完整画布，无 `meta.editor` 时用 `graph`/`segments` 反推线性视图。规则 12 的「导入不信任缓存状态」由前端实现，后端无剥离逻辑。
10. **segments 侧隐性约束**（`choreography.mjs:452-533` validateStep 实跑确认，后端席 17:50 发现）：`chain[].kind` 只允许 `expression|motion|pose|look` 四类（**delay 不是 step**，编译为 delayMs）；字段白名单 `STEP_KEYS`（kind/name/clear/closeMotion/closeAfterMs/delayMs/pose/x/y/group/mode/timeoutMs）；`expression.name` 必须 ∈ `MODEL_EXPRESSIONS`（兔牙/加载/…共 21 项，choreography.mjs:49-71）；`motion.name` 必须 ∈ `MODEL_MOTION_GROUPS`（6 项，:77-84）且 `closeMotion` 必须与 `PAIRED_CLOSES` 配对；`look.x/y` ∈ -1~1（`numberInRange`，:511-512）；`pose` 值 ∈ `POSE_VALUES`；`delayMs` 0~5000；`timeoutMs` 0~8000 且必须带 `group`；`mode=parallel` 必须带 `group`。
11. **graph+segments 并存时 `normalized.graph` 会被 `segmentsToGraph(segments)` 覆盖为线性视图**（nodegraph.mjs:481-484）——只有 `meta.editor` 原样保留。故编辑器画布**必须**把完整设计层状态写进 `meta.editor`，不可依赖 `graph` 回读还原布局。
12. **导入不信任文件内缓存状态**（用户架构决策 C）：`meta.editor` 中的 `cacheStatus`/`lastValidatedAt`/`resolvedBinding` 等运行时派生字段导入时一律丢弃并重新校验；编辑器布局与执行规则分离存储。

## 5. 功能清单（对应图2 Demo v0.1，逐项实测）

1. 节点拖入画布（库项 draggable + 画布 drop）+ 点击库项追加
2. 节点自由移动（pointer 拖拽，坐标写 `meta.editor`）
3. 节点属性编辑（Inspector：类型专属字段 + 通用：执行优先级/冷却时间 ms/执行状态/模型白名单；改动即时回写内存模型）
4. 基础结构校验（无环 / roots 可达 / 悬空 next / 必填字段 / 段步上限 / 顶层字段白名单）→ 通过显示「通过校验」，失败列出具体错误
5. 模拟动作触发（按 segments 顺序高亮节点 + 执行态发光 + 连线粒子动画 + 状态条推进；**纯本地，不调 LLM、不调后端**）
6. JSON 导出（下载文件 + 复制）+ JSON 导入（文件选择 + 拖拽 + 粘贴文本）+ 每模型分别保存（localStorage 按 modelId 分槽，多个 JSON 互不覆盖）
7. 附加：连线/断线、缩放平移、小地图、Ctrl+C/V、Delete 删节点/连线、禁用节点（灰化不参与编译）、自动布局

## 6. 验收标准

- 六功能逐项有浏览器实测证据（截图 + 控制台输出）
- 导出的 JSON 经 `node -e "import('./packages/dsh-l2d-plugin/lib/nodegraph.mjs').then(m=>console.log(m.validateNodegraph(JSON.parse(fs.readFileSync(...)))))"` 返回 `ok:true`
- 导入往返：导出 → 清空画布 → 导入 → 画布还原一致（节点数/连线数/位置/属性 diff=0）
- 既有回归不破：`pnpm test:core` EXIT=0、`consistency.test.mjs` 9 PASS / 1 WARN / 0 FAIL
- 1440×900 与 720×900 双尺寸截图，无溢出/遮挡
- 全部本地，服务器零触碰

## 7. 第二阶段（主线完成后）：全项目代码审查

分片并行只读审查，专找「逻辑卡死/死循环/竞态/资源泄漏/未捕获异常/超时无兜底/状态机不可达/互斥死锁」类缺陷，回传带 文件:行号 的清单 + 严重度 + 最小修复建议；主理人裁定后派最小修复 + 补回归测试。分片：
- P1 `packages/dsh-l2d-plugin/lib/**`（host-guard / overlay / ai-inbox / nodegraph / run 通道）
- P2 `packages/dsh-l2d-mcp/**` + `packages/mcp-bridge/**`（工具链 / 队列 / 超时 / 回执）
- P3 `packages/core/**` + `packages/renderer/**`（动作链 / 物理 / 参数所有权）
- P4 `packages/dsh-l2d-db/**` + `tools/**`（SQLite 门禁 / 作业脚本）

## 8. 架构决策（用户 17:52 定案，优先级高于本契约其余章节）

### 8.1 许可证红线（CRITICAL）
ComfyUI 后端与官方前端均为 **GPL-3.0**。DSH-L2D 维持自有许可证，**禁止复制、改写、嵌入其任何源码**；只允许借鉴算法思想后独立实现。所有参考实现须在报告中标注「思想借鉴 + 独立实现」，不得出现 ComfyUI 代码片段。

### 8.2 借鉴边界：保留自己的 Runtime
不照搬 ComfyUI 前端，也不把它的执行器搬进 Live2D。四个核心机制借鉴后映射到现有 MCP + SQLite Actions Lib + FIFO 动作队列架构：

| 机制 | ComfyUI 参考 | DSH-L2D 落地 | 本轮范围 |
|---|---|---|---|
| 输入签名缓存 | `comfy_execution/caching.py` CacheKeySetInputSignature | `BindingCacheKey{nodeType,actionId,modelFingerprint,modelResourceVersion,bindingVersion,inputSignature}` + `BindingCacheEntry{status:VALID/STALE/INVALID,resolvedBinding,lastValidatedAt}`；解决「节点 ID 没变但换了模型，旧绑定仍被当有效」 | **仅设计/缺口标注，不改现有 action-cache** |
| 拓扑排序与循环检测 | `comfy_execution/graph.py` ExecutionList | 保留自有 FIFO 队列、优先级、Host Guard；图只决定「何时按什么条件提交动作」，动作队列决定「如何安全执行」 | 前端席校验器已实现 DFS+环检测 |
| 工作流序列化 | `executionUtil.ts` graphToPrompt | 编辑器布局（`meta.editor`）/ 执行规则（`graph`+`segments`）分离；导出带 Schema 版本；导入重验绑定、不信任缓存 | 本轮实现（§4） |
| 节点定义与状态管理 | 前端 stores 职责拆分 | Graph / Node Definition / Binding / Model Capability / Runtime / Cache / Preferences 七 store 概念分层；单文件 HTML 内用独立 JS 模块对象隔离，禁止一个巨型组件 | 本轮以模块对象落地 |

### 8.3 缓存分类铁律（用户明确要求，禁止混淆）
ComfyUI 缓存节点**计算结果**；DSH-L2D 的 Live2D 动作有持续时间、互斥关系、运行状态，**缓存命中不得跳过实际播放**。必须区分四类：
- `Resolution Cache`：动作与模型资源的匹配结果
- `Capability Cache`：当前模型可用参数/表情/动作
- `Execution State`：动作是否正在播放、是否完成
- `Graph Cache`：**只缓存编译结果，绝不缓存动作执行结果**

### 8.4 落地优先级（用户定）
1. 参考 `caching.py` → Bridge Cache First（输入签名）
2. 参考 `graph.py` → 动作图依赖调度
3. 参考 `graphToPrompt` → 导入导出与编译
4. 最后 Control Studio 整体迁移原设置窗口

### 8.5 目标模块划分（演进方向，本轮不强制新建包）
`packages/motion-graph/{schema,editor,serializer,compiler,scheduler,validator}`、`packages/bridge-resolver/{bound-cache,capability-cache,binding-resolver,fallback-policy}`、`packages/control-studio/{panels,inspectors,stores,llm-copilot}`。本轮先以单文件 HTML 原型验证交互与序列化，模块拆分列为后续演进项，**禁止本轮推倒现有 MCP/SQLite/FIFO 架构**。

### 8.6 新增任务：源码级对照（TASK-MAP）
针对 `tequed232/DSH-L2D` 逐个检查现有模块，标注【可复用 / 需增强 / 需新增】+ ComfyUI 对应参考实现，产出 `docs/motion-graph-lab/SOURCE-MAPPING.md`。由情报席承担，只读，21:00 前回传。
