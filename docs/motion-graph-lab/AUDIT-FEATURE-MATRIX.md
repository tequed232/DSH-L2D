# Node Editor 专项审计：功能矩阵与语义一致性核查（2026-11-09）

> 审计范围：编辑器（motion-graph.html Compiler/Validator/NodeDef/Serializer）↔ 宿主（nodegraph.mjs validateNodegraph/compileGraphToSegments/runNodegraph）↔ 执行（choreography.mjs validateStep / action-sequence.mjs executeActionSequence / ai-inbox）↔ 测试（nodegraph.test.mjs / selftest）。
> 方法：逐文件源码比对，所有结论带行号实证；回应评审提出的「哪些已完成、哪些只有 UI、哪些没真正接入 Runtime」。

---

## 一、功能矩阵

### 1.1 节点类型 × 环节（编辑器 5 类）

| 节点 | 编辑器 UI | 编辑器编译 | 宿主编译 | 宿主校验（choreography.validateStep） | Runtime 执行 | 测试覆盖 | 结论 |
|------|----------|-----------|---------|--------------------------------------|-------------|---------|------|
| expression（含 clear） | ✅ | ✅ | ✅ nodegraph.mjs:345 | ✅ 表情白名单 MODEL_EXPRESSIONS（choreography:472） | ✅ overlay 执行 | ✅ | **完成** |
| motion（closeMotion/closeAfterMs 配对） | ✅ | ✅ | ✅ :348 | ✅ 配对强制 + 300~12000ms（:481-493） | ✅ | ✅ | **完成** |
| pose（right/left） | ✅ | ✅ | ✅ :354 | ✅ POSE_VALUES 取值域（:496-508） | ✅ | ✅ | **完成** |
| look（x,y ∈ -1~1） | ✅ | ✅ | ✅ :358 | ✅（:510-513） | ✅ | 部分 | **完成** |
| delay | ✅（非 step，编译期折叠） | ✅ 累加并入下一动作节点 | ✅ 同语义（:336-344） | N/A（折叠后不存在 delay kind） | ✅ delayMs | 部分 | **完成**（注意：手写 segments 含 delay kind 会被 STEP_KINDS 拒绝 ✅ 防线有效） |

### 1.2 图结构要素

| 要素 | 编辑器 | 宿主 | 结论 |
|------|--------|------|------|
| node.next（执行链） | ✅ Compiler 从 edges 构建（active/disabled 过滤，:929-947） | ✅ 只认 node.next（compileGraphToSegments :327-334） | 完成 |
| edges 数组 | ✅ 编辑器真源 | ❌ 宿主 graph schema 无此概念；导入 normalize「graph+segments 并存以 segments 为准」→ 落盘 graph 被 segmentsToGraph **回算为线性视图**（:481-484），原 edges 仅存 meta.editor | 设计如此：graph 是视图，segments 是唯一执行真源 |
| portType（flow/signal/data 三色端口） | ✅ 纯编辑器交互引导（同色才可连） | ❌ 无运行时语义（graph schema 无此字段） | **编辑器 only**——三色是防错 UX，不是执行语义 |
| priority（BACKGROUND/NORMAL/FORCE） | ✅ 节点 props.priority → **按优先级变化分段**（Compiler :1003） | ⚠️ compileGraphToSegments **一律 NORMAL**（:373）；validateActionSequence 接受三值 | **⚠️ 两套编译器分歧（见 §2.1）** |
| modelBinding（strict/any + modelId/modelHash） | ✅ Binding.toJSON | ✅ :447-459 | 完成（bindingMode=strict 的运行时强制匹配链路未核实到执行器侧，标记待查） |
| meta.editor（布局/组合/视口） | ✅ | ✅ 原样保留（:502） | 完成；编辑器重导入优先用它还原画布 |

### 1.3 执行生命周期能力

| 能力 | 现状 | 实证 |
|------|------|------|
| FIFO 顺序执行 | ✅ executeActionSequence FIFO + coalesce 合批（action-sequence:39-57,66-114） | — |
| 瞬态拒绝排队重试 | ✅ conflict/priority-blocked 本地排队，15s 预算（:59,96-99） | — |
| 单批超时 | ✅ executor 12s（nodegraph.mjs:611）；队列等待 15s | — |
| accepted-but-pending 不误报 | ✅ pending 语义 + 保留 id（:657-661） | — |
| **失败后续节点** | ❌ **失败即停**：非 completed → stopped + remainingSegments + replanRequired（action-sequence:103-111） | 回应评审：后续节点不继续 |
| **并发 run 互斥** | ❌ **无锁**：连续两次 run → 两个 executeActionSequence 并行交错下发（ai-inbox 队列层兜住不崩，但语义交错） | 回应评审：重复点击会产生交错执行 |
| **executionId / 执行历史** | ❌ 无；receipts 只存在于 HTTP 响应一次性返回 | 回应评审：无法定位某次执行日志 |
| **取消 API** | ❌ 无 | 超时后自动停止下发，但已入队动作无法撤销 |
| 页面关闭影响 | ✅ 无（run 在宿主进程执行，与浏览器页面无关） | 回应评审 |
| 运行中重导入 | ⚠️ saveNodegraph 原子覆盖写盘；运行中的 run 已持有内存 doc（:694-706 先读后执行），**本次执行用旧版，下次 run 用新版**——不会打断旧任务，但无版本提示 | 回应评审 |

### 1.4 测试覆盖

| 层 | 覆盖 | 缺口 |
|----|------|------|
| 宿主 nodegraph.test.mjs（477 行） | schema 白名单/binding/段步上限/估时上限/文件名安全/存取原子性/motion-mode 缺省 llm/互斥 | — |
| 编辑器 selftest | validate/roundtrip/sim/resizers/ctx/combo/panels 六组 | — |
| **交叉一致性** | ❌ **零覆盖**：没有任何测试对拍「编辑器 Compiler vs 宿主 compileGraphToSegments」与「编辑器 Validator vs validateNodegraph/validateStep」 | **P0 核心缺口** |

---

## 二、P0 语义一致性：三处实证（回应评审最高关注）

双轨规则的实质风险不是「校验结果不一致」（字段级白名单目前是手工镜像且基本对齐），而是**两条编译路径会产生不同的执行文档**：

### 实证 1：优先级分段分歧
- 编辑器 Compiler（motion-graph.html:1003）：**优先级变化也起新段**，step 的 priority 取节点 props.priority（:1000）。
- 宿主 compileGraphToSegments（nodegraph.mjs:372-374）：**一律 `priority:'NORMAL'`**。
- 后果：导出文档 graph+segments 并存 → normalize 以 segments 为准（:481-484）→ 编辑器的优先级分段生效；但「只有 graph」的老 JSON 路径（:485-493）编译出的 segments 全 NORMAL——**同一 graph 两条路径 → 不同执行优先级**。BACKGROUND/FORCE 的设计意图在回算路径静默丢失。

### 实证 2：规则三处重复实现，无单一来源
- 编辑器 Validator.check（:1147-1300）、choreography.validateStep（:452-520）、编辑器 NodeDef UI min/max（:704-726）——`delayMs 0~5000`、`closeAfterMs 300~12000`、`maxLifeMs 10000`、`maxSegments 15/8 步`、表情/动作组白名单**各自硬编码**。当前值手工对齐，任何一处单边改动即产生「本地过、服务端拒」。

### 实证 3：graph 字段在导入后被回算覆盖
- 编辑器导出的 graph（多分支 next）在导入 normalize 时被 segmentsToGraph 回算成线性视图（:484）→ 落盘 graph ≠ 编辑器所见 graph。执行无影响（segments 是真源），但破坏「graph 与 segments 严格同构」的双向可读性，也意味着**宿主侧永远无法从落盘 JSON 还原编辑器分支结构**（只有 meta.editor 有）。

### 修复方向（对齐评审建议的 Canonical Validator）
1. 把 validateStep/validateActionSequence 的规则集作为唯一常量源（choreography.mjs 已具备），编辑器 build 时**直接内联复用同一份规则数据**（单文件约束下：构建期从 choreography.mjs 提取生成常量块，或运行时注入——dev-server/宿主注入 settings-entry 同款通道）。
2. compileGraphToSegments 补齐优先级分段语义（或明确裁定 graph-only 路径一律 NORMAL 并在文档标注）。
3. 交叉对拍测试：同一批 fixture JSON 分别过编辑器编译/宿主编译，断言 segments 深度相等（编辑器抽函数注入测试，参考 selftest 钩子模式）。

---

## 三、评审 Phase 0-5 的落地化验收物（按依赖重排）

| Phase | 内容 | 验收物（可判 PASS 的标准） |
|-------|------|--------------------------|
| **0 冻结基线** | 当前 main（7fe5fdb）为基线；全量回归绿归档 | REGRESSION-BASELINE 更新 + git tag |
| **1 执行契约统一** | ①规则单一来源化（§2 修复方向 1）②编译对拍测试（§2 修复方向 3）③E13 状态联动：导入成功后读 motion-mode，mode=llm 时设置页显示「Imported ✓ / Validated ✓ / **Runnable ✗（当前为纯 LLM 模式）**」三态条 ④组合实例化前按 portType+必填端口预校验（§1.2） | 对拍测试绿 + 三态条实机可见 + 实例化非法组合被拦截 |
| **2 调试器** | Execution Inspector（独立浮窗，接入 PanelLayers）：步骤级 receipts/耗时/失败原因；数据源 = executeActionSequence receipts（已含 batch/attempts/receipt/outcome，现成） | run 一次后 Inspector 能看到每批 accepted/outcome/耗时 |
| **3 执行生命周期** | executionId（run 路由生成）+ 宿主侧运行注册表（进行中 run 防重入 409 busy）+ 取消标志（下批不再下发）+ 最近 N 次执行记录查询路由 | 连点两次 run 第二次得 409；receipts 可按 executionId 回查 |
| **4 工程化拆分** | 评审给出的模块树方向正确；但遵守「先测试后迁移」——Phase 1 的对拍测试就是迁移安全网。拆分目标 TS 模块 + 构建拼接回单文件（保持零依赖 file:// 入口兼容） | 拆分后全量回归 + selftest 全绿 + 单文件入口功能不变 |
| **5 真机验收** | 宿主 3080 全链路：导入→切模式→run→Live2D 呈现→Inspector 回查 | 截图/录屏取证 |

**明确冻结**（同意评审 §四）：VTube Studio Adapter / 多 Runtime / Limb Allocation / Behavior Engine / 节点图 AI 自动生成 / Cubism 参数底层重构——全部排在执行契约稳定之后。

**版本管理**（评审 §五）：同意纳入，但注意当前 schemaVersion=1 且顶层七字段白名单在 validateNodegraph:434-438 已是「未知字段拒绝」——**加 compilerVersion/graphId 必须走 schemaVersion 升版（v2）+ 旧版迁移函数**，不能直接塞字段（会被自己的白名单拒绝）。这是评审示例 JSON 与现有协议的一个冲突点，落地时以「v2 = v1 + 两个可选 meta 外字段 + 兼容读 v1」实现。

---

## 四、结论

- **评审的进度判断成立**：五类节点全部真正接入 Runtime（无「只有 UI」的节点类型），三色端口是唯一「编辑器 only」概念；功能闭环真实存在。
- **P0 实证为编译路径分歧**（优先级分段）+ **规则三处重复**，而非校验结果已经分叉——当前版本恰好对齐，但无机制保证下次改动能对齐。这是 Phase 1 的第一优先级。
- **生命周期四缺口**（executionId/互斥/取消/历史）全部实证缺失，Phase 3 范围确认。
- 评审建议的「专项审计避免提前宣布完成」已执行完毕：**没有发现虚假完成项**，可以放心进入 Phase 0 冻结。
