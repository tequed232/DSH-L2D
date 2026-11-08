# SOURCE-MAPPING · DSH-L2D × ComfyUI 源码级对照（TASK-MAP）

- Task ID: TASK-MAP / 契约 §8.6 · 情报席 闻博证（席位 5）· 检索日期 2026-11-08
- 性质：**只读对照 + 独立设计结论**；本报告及任何 DSH-L2D 代码均**不含 ComfyUI 源码片段**
- 许可证红线（契约 §8.1 CRITICAL）：ComfyUI 后端与官方前端均 GPL-3.0，仅借鉴**算法思想**并独立实现
- 可信度口径：高 = 已打开官方原文（GitHub raw / 官方文档页）二次核实；中 = 多源一致未逐条核原文；低 = 单源线索
- 检索面：ComfyUI 官方 docs + GitHub 源码 5 处；本地现有模块 10 个；WCAG/GPL 官方原文

## 0. 结论摘要

现有架构**无需推倒**：`nodegraph.mjs` 已具备图校验/环检测/编译/序列化、FIFO 动作队列已具备优先级与排队重试、SQLite 已具备绑定哈希与不可变版本。真正缺口集中在**「输入签名级绑定缓存」**与**「七 store 概念分层的单文件落地」**，其余为增强项。ComfyUI 缓存的是**计算结果**，Live2D 动作有持续时间/互斥/运行状态，命中缓存**绝不可跳过播放**（契约 §8.3 铁律）。

## 1. ComfyUI 五处参考实现（机制要点 / URL / 可信度）

| # | 机制要点（思想，非源码） | 来源 URL | 可信度 |
|---|---|---|---|
| 1 | `caching.py`：`CacheKeySet` 分「数据键/子缓存键」；`CacheKeySetID` 按节点 ID+类型，`CacheKeySetInputSignature` 按**当前节点及全部有序祖先的即时签名**（class_type、变更指纹、排序后的输入、链接输入的祖先序号+输出插槽）生成"计算配方"键；非幂等/UNIQUE_ID 节点强制纳入 node_id；主缓存存 outputs+ui，subcaches 是层级命名空间而非缓存整张子图；HierarchicalCache 按父子路由，LRUCache 用 generation 代数淘汰，RAMPressureCache 按内存压力淘汰 | https://github.com/comfyanonymous/ComfyUI/blob/master/comfy_execution/caching.py | 高 |
| 2 | `graph.py`：`DynamicPrompt` 保留原 prompt + node_overrides + ephemeral 临时节点（不改原提交）；`TopologicalSort` 用 blockCount/blocking 做依赖阻塞计数；`ExecutionList` 是**动态**拓扑消解（节点可再次回图、加强链接、扩子图）；`get_nodes_in_cycle` 逆向剥离只留环上节点；`DependencyCycleError`/`ExecutionBlocker` 显式错误类型 | https://github.com/comfyanonymous/ComfyUI/blob/master/comfy_execution/graph.py | 高 |
| 3 | `execution.py`：`validate_prompt` → `good_outputs`；`validate_inputs` 递归 + visiting/validated 两集合检环 + 类型/范围/combo 校验；`PromptExecutor` 先 `set_prompt` 清 unused→按 ExecutionList stage 节点→**单节点先查输出缓存，命中即 emit_cached_output 并视作成功、不执行**→未命中才解析输入/懒加载/异步/子图→写回 outputs cache；`IsChangedCache` 用 V1 `IS_CHANGED` / V3 `fingerprint_inputs` 作动态指纹且只依赖常量输入 | https://github.com/comfyanonymous/ComfyUI/blob/master/execution.py | 高 |
| 4 | `executionUtil.ts` `graphToPrompt`：**一次序列化同时产出两份**——`workflow`（UI 布局，含 frontendVersion、剔除 localized_name、压缩 widget 槽）与 `output`（API prompt，仅含可执行节点）；`NEVER`/`BYPASS`/虚拟节点跳过；数组值包 `__value__` 防被误判为连线；最后删除指向已移除节点的悬空输入 | https://github.com/Comfy-Org/ComfyUI_frontend/blob/main/src/utils/executionUtil.ts | 高 |
| 5 | `stores/README.md`：Pinia 域驱动分层，单一事实源、actions 封装逻辑、getters 派生、store 可组合；列出 46 个 store 实例（execution/queue/nodeDef/model/workspace/setting/searchBox/colorPalette 等），明确反对单体 store | https://github.com/Comfy-Org/ComfyUI_frontend/blob/main/src/stores/README.md | 高 |

## 2. DSH-L2D 现有模块逐项对照

标注：**[可复用]** 直接沿用 ｜ **[需增强]** 在现文件补能力 ｜ **[需新增]** 本轮以模块对象/后续包落地

| 模块 / 文件:行号 | 裁定 | 理由（对照 §1） |
|---|---|---|
| `dsh-l2d-plugin/lib/nodegraph.mjs:166-305` `validateGraph`（白名单/悬空引用/三色 DFS 环检测/roots 可达 BFS/120 上限） | **[可复用]** | 已是 #2 拓扑+环检测的自有等价实现，且更贴合 5 类节点与 120 上限；前端席校验器应对齐此实现而非另造 |
| `nodegraph.mjs:315-384` `compileGraphToSegments`（DFS 前序线性化、共享后继只编译一次、delay 累加并入下一动作、每 8 步一段） | **[可复用]** | 即 #3「执行前编译」与 #4「布局/执行分离」中的编译器一半；已与 `validateActionSequence` 同源 |
| `nodegraph.mjs:391-419` `segmentsToGraph` / `:429-505` `validateNodegraph`（7 顶层字段白名单、schemaVersion、segments 为执行真源、meta 透传） | **[可复用]** | 对应 #4 graphToPrompt 的「双份产物」：本契约用 `graph`+`segments` 与 `meta.editor` 达成同一目的，且已有 schemaVersion |
| `nodegraph.mjs:515-527` `saveNodegraph` / `:573-585` `loadNodegraph`（先校验后原子写、tmp+rename） | **[可复用]** | 导入重验绑定、不信任缓存（契约 §8.2）已落地；`atomicWriteJson:63-78` 失败不留半文件 |
| `nodegraph.mjs:607-663` `createInboxActExecutor` / `:680-713` `runNodegraph`（复用 aiInbox l2d_act、mode 互斥 409、accepted-pending 不误报成功） | **[可复用]** | 对应 #3「执行由 Runtime 权威」：保留自有 FIFO/Host Guard，不搬执行器（契约 §8.2） |
| `dsh-l2d-plugin/lib/choreography.mjs:95-127` `STEP_KEYS`/`GROUP_ID_RE`/`DEFAULT_GATE` / `:452-533` `validateStep` / `:589-631` `validateChoreography` / `:363-449` `decide` 抖动门 | **[可复用]** | #3 `validate_inputs` 的自有等价（字段白名单/范围/模型白名单/口型禁区/时长上限）；优先级 BACKGROUND<NORMAL<FORCE |
| `dsh-l2d-plugin/lib/host-guard.mjs:139-215` `loadModelIndex`+TTL 缓存 / `:326-393` `guardAiCall`（fail-open/fail-closed 分级）/ `:341-343` mode 互斥 | **[需增强]** | #1「资源指纹」雏形：现有索引只含 expressions/motionGroups/physics，**无 modelHash/modelResourceVersion/bindingVersion**（见 §3） |
| `dsh-l2d-plugin/lib/index.js:997-999`（装配 createInboxActExecutor）/ `:1149-1290`（nodegraphs/import/export/run、motion-mode 路由、跨站+回环+256KB 栅栏） | **[可复用]** | 导入导出与 run 通道已完整（契约 §4）；零改路由，前端 HTML 放 assets/ 即达 |
| `dsh-l2d-mcp/src/action-sequence.mjs:9-31` `validateActionSequence` / `:39-57` `coalesceActionSegments` / `:66-115` `executeActionSequence`（FIFO 逐批、conflict/priority-blocked 本地排队重试、已受理 pending 绝不重放） | **[可复用]** | #3 调度权威；「已受理但终态未知不重放」正是「缓存命中不跳过播放」的执行侧保证 |
| `dsh-l2d-db/src/action-cache.mjs:20-124` `createCompiledActionCache`（LRU+inflight 合并+snapshot 一致性+失效） | **[需增强]** | #1 的**自有等价骨架**，仅缓存可再生的编译产物（禁实时状态/租约/上下文，:16），方向正确但键语义不足，见 §3 |
| `dsh-l2d-db/src/actions-repo.mjs:66-79` `canonicalChainHash` / `:135-144` `resolveSemanticKey`（R9 幂等）/ `:152-162` `resolveActionModelHash`（package_hash）/ `:391-474` `exportActionSnapshot`（R6 fsync→rename→tx→回读核对） | **[可复用]** | `package_hash` 已可作 `modelFingerprint` 来源；canonicalChainHash 的对象键排序思想是「输入签名」的现成积木 |
| `dsh-l2d-db/src/capability-registry.mjs:79-168` `loadCapabilityRegistry`（fail-closed、checkModel/checkStep、semantic_key→参数由 Model Adapter 执行期映射） | **[可复用]** | 对应 #5「Node Definition / Model Capability 分域」+ 契约 §8.3 `Capability Cache`；已按 `tools/w3-registry/registry.json` 单一数据源 |
| `core/src/chain-normalize.ts:73-94` `stepDomains` / `:118-204` `normalizeActChain`（group 时间桶、域重叠降级串行、整组超时、lifeMs） | **[可复用]** | #2「动态消解」的自有等价：并行组/冲突降级的思想可直接支撑未来 DAG 分支调度 |
| `core/src/action-chain.ts:16-20` 优先级秩 / `:287-405` `ActGate`（admit/finish/release、三态 end/interrupted/failed、closeMotionsOnPreempt） | **[可复用]** | 契约 §8.3 `Execution State` 的权威实现；明确「动作是否在播」不可被缓存替代 |
| 编辑器七 store 概念分层（Graph / Node Def / Binding / Model Capability / Runtime / Cache / Preferences） | **[需新增]** | #5 的落地形态：单文件 HTML 内用独立 JS 模块对象隔离，禁止一个巨型组件（契约 §8.2）；今无对应文件 |

## 3. 输入签名缓存缺口（本轮仅标注，不实现）

- **现有键（源码确认）**：`action-cache.mjs:74` = `` `${prefix}:${actionId}:${version}` ``，`prefix` 来自 `modelHash`，缺省退化为 `unbound`（:38-45）；`version` 由 `getVersion(actionId)` 给出；`load(actionId, version, modelHash)`；值 = `compile(load(...))` 的编译计划（:4, :93-96）。`modelHash` 由 `actions-repo.mjs:152-162` `resolveActionModelHash` 经 `motion_model_bindings` join `models.package_hash` 取得，未绑返回 null。
- **与目标差距**：`BindingCacheKey{nodeType, actionId, modelFingerprint, modelResourceVersion, bindingVersion, inputSignature}` 中，现有仅覆盖 `actionId` + 半个 `modelFingerprint`；**缺 nodeType、modelResourceVersion、bindingVersion、inputSignature**。后果正是用户点出的问题：节点 ID/动作 ID 没变但换了模型或资源版本时，`version` 未变 → 旧绑定仍被当有效。也缺 `BindingCacheEntry{status:VALID/STALE/INVALID, resolvedBinding, lastValidatedAt}` 的状态机与 `Resolution Cache` / `Capability Cache` / `Execution State` / `Graph Cache` 四类分离（契约 §8.3）。
- **最小增强路径（思想借鉴 + 独立实现，本轮不实现）**：① 扩展 key 为可哈希的六元组，`inputSignature` 复用 `canonicalChainHash`（对象键递归排序）对节点输入+绑定上下文做规范化哈希，不复制 #1 的祖先签名遍历写法；② 引入 `status` 三态 + `lastValidatedAt`，导入时按契约 §8.2 强制重验绑定、不信任缓存；③ 保留 `snapshot`/`inflight`/LRU 骨架，仅换 keyClass 与失效维度；④ 严禁缓存动作执行结果，`Graph Cache` 只存 `compileGraphToSegments` 产物。落地包：`packages/bridge-resolver/{bound-cache, capability-cache, binding-resolver, fallback-policy}`（契约 §8.5）。

## 4. 许可证风险（GPL-3.0）

- 已打开原文核实：后端 https://github.com/comfyanonymous/ComfyUI/blob/master/LICENSE 与前端 https://github.com/Comfy-Org/ComfyUI_frontend/blob/main/LICENSE 首行均为 `GNU GENERAL PUBLIC LICENSE Version 3, 29 June 2007`，**无附加例外**，纯 GPL-3.0（可信度 高）。条款原文 https://www.gnu.org/licenses/gpl-3.0.en.html （§0「modify…adapt all or part…work based on」、§5c「license the entire work, as a whole, under this License」、§5 末「aggregate」例外、§6 Corresponding Source）。
- **禁止**：复制/改写/翻译/嵌入任何 ComfyUI 源码片段进 DSH-L2D 代码或文档；把它的执行器/缓存类搬进 Live2D；把 GPL 代码与本自有许可代码编译成同一作品后闭源分发；在报告中粘贴其源码。§5c 意味着一旦构成「based on」，整个作品须以 GPL-3.0 授权。
- **允许**：阅读源码理解**思想/算法/接口语义**后**独立实现**（版权不保护思想，仅保护表达）；引用官方文档说明交互规范；仅把 ComfyUI 作为**独立外部程序**并列（aggregate，§5 末段）而不合并；在报告标注「思想借鉴 + 独立实现」并保持自有许可证。
- **执行纪律**：前端席单文件 HTML 须从零写画布/连线/端口逻辑；本报告 2 节所有「可复用」项均为 **DSH-L2D 自有文件**，不含 GPL 代码；`meta.editor`/graph/segments 格式亦为自有设计。若未来引入其前端组件（如 litegraph）须先经主理人 + 法务裁定，本轮一律不引入。

## 5. 按用户优先级的落地建议（§8.4）

| 优先级 | 建议 | 本轮是否覆盖 |
|---|---|---|
| 1 caching → Bridge Cache First | 仅完成**缺口标注 + 最小增强路径设计**（§3），不改 `action-cache.mjs`；四类缓存分离留在演进项 | **部分**（设计已覆盖，实现未覆盖，符合契约 §8.2） |
| 2 graph → 动作图依赖调度 | 直接复用 `nodegraph.mjs:166-305` 环检测/roots 可达 + `chain-normalize.ts` 桶调度；保留自有 FIFO/优先级/Host Guard | **是**（现有代码已具备，前端席校验器对齐即可） |
| 3 graphToPrompt → 导入导出与编译 | 复用 `compileGraphToSegments`/`segmentsToGraph`/`validateNodegraph` + `meta.editor`；`index.js:1169/1200/1264` 三路由已通 | **是**（契约 §4 本轮实现） |
| 4 Control Studio 整体迁移 | 本轮仅新建六卡片入口 `control-studio.html`，其余五模块链接既有页或标「规划中」，**禁止编造已实现** | **部分**（入口覆盖；整体迁移列为后续演进 §8.5） |

## 附：Known Issues / Remaining Risks / Acceptance

- Known Issues：n8n 官方课程页 `docs.n8n.io/courses/level-one/chapter-1` 已重定向至 learn.n8n.io（原文不可达，改用其镜像 n8n.nodejs.cn 作**中**可信度线索）；ComfyUI 文档自述「细节可能过时」，快捷键/画布控件页标注需前端 1.58.0/1.60.0+。
- Remaining Risks：① `BindingCacheKey` 六元组中 `modelResourceVersion`/`bindingVersion` 现无数据源，需新增或映射既有列；② 缓存键变更会影响 `action-cache.test.mjs` 既有断言，增强时须补回归；③ GPL 边界若后续引入第三方节点库需重新裁定。
- Acceptance Status：**PASS_WITH_WARNINGS**（全部关键事实已打开原文核实；仅 n8n 一条降级为中可信度线索，已在 Known Issues 披露）。
