# Node Editor Stabilization 验收报告（NE-01~NE-03 + NE-04 部分）

> 生成：2026-11-09 14:10（17:00 验收窗口前）
> 依据：docs/motion-graph-lab/NE-STABILIZATION-PLAN.md（裁剪版方案）+ AUDIT-FEATURE-MATRIX.md（0c72bb4 审计实证）
> 执行方式：主理人制定方案与文件所有权矩阵，4 个实现子代理并行/串行交付，主理人终审合并。

---

## 一、交付概览（四代理产出）

### NE-01 执行契约统一（impl-contract）✅

| 项 | 实现 |
|----|------|
| priority 语义统一 | graph 节点新增可选 `priority` 字段（BACKGROUND/NORMAL/FORCE，validateGraph 校验取值域）；宿主 compileGraphToSegments 改为「每 8 步一段 **或** 优先级变化起新段」（nodegraph.mjs:389-400），与编辑器 Compiler :1003 完全同构 |
| 向后兼容 | 无 priority 字段的旧图全 NORMAL，编译输出与改动前**逐字节一致**（nodegraph.test.mjs 硬编码断言保证） |
| 规则单源化第一步 | choreography.mjs 新增导出 `STEP_FIELD_KEYS` / `STEP_FIELD_RANGES`（delayMs [0,5000]、closeAfterMs [300,12000]、timeoutMs、x/y 取值域），纯新增不改既有行为 |
| 对拍测试（P0 修复核心） | nodegraph.test.mjs §4b：多分支 + delay 折叠 + 三优先级 + 段边界 + 8 步满段×优先级交互 + graph-only 导入路径同构 + 向后兼容，全绿 |
| E13 消息增强 | runNodegraph 409 mode-blocked message 追加「导入新图后需在设置页切换动作模式」 |

### NE-01 E13 三态条（impl-settings）✅

- settings.html sec-nodegraph 卡片新增 **Imported / Validated / Runnable** 三态条（`ngTri-state`，role=status aria-live），Runnable ✗ 时附「切换到节点图模式」一键修复按钮（复用 saveMode）。
- 四处刷新时机（loadMode/saveMode/renderList/导入回调）统一经 updateTriState() 计算。
- E13 联动提示：导入成功但 mode=llm → 明示「节点图不会执行」+ 修复入口。
- STUDIO TOKENS v1 块零改动（写进既有 NODEGRAPH UI v1 块）；快照按组 3 口径重新生成，逐行一致。

### NE-01 E8 组合实例化预校验（impl-editor）✅

- 每条边建边前比对两端 `portType`（与连线交互同规则），异色跳过并 toast「N 条连线因端口类型不匹配被跳过」；连线数改为实际建边数。
- 实例化完成后自动 `Validator.check`，有错误 toast 错误数 + status 条显示首条错误。

### NE-02 执行生命周期（impl-runtime）✅

| 能力 | 实现 |
|------|------|
| executionId | run 路由生成 `crypto.randomUUID()`，响应 JSON 追加返回 |
| 同图重入防护 | 执行注册表（新文件 nodegraph-runs.mjs，内存 LRU 20 条）begin 撞同名 running → **409 busy** + 既有 executionId |
| **取消传播** | cancellableExecutor 每批下发前读 cancelRequested → 已请求则不下发该批（`reason:'cancelled'` 不在 QUEUEABLE_REJECTIONS → action-sequence 立即 stopped 停止后续批次），registry 终态 cancelled |
| 历史回查 | `GET /dsh-l2d/nodegraphs/executions?id=X`（完整）/ `?limit=N`（摘要）；`POST /dsh-l2d/nodegraphs/cancel?id=X`；均带 loopback+跨站双防护 |
| 真实执行冒烟 4/4 | completed ✅ / busy 409 ✅ / mid-run cancel → stopped+cancelled ✅ / executions list ✅ |

**粒度裁定**：互斥按「同一张图同时一个 run，跨图允许并行」——aiInbox 下发链自带 FIFO/优先级仲裁，跨图并行不绕过模型侧互斥；全局单槽会让长图阻塞全部图的执行与取消。

### NE-03 Execution Console（impl-editor）✅

- 第四监看浮窗接入既有 PanelLayers（可拖拽/收起/置顶/调序/持久化，零新 API）。
- `window.__MG_EXEC_PUSH__(record)` 数据钩子 → 批次时间线（outcome 徽标 completed 绿/rejected 红/stopped 黄/pending 灰、attempts、sourceSegments、耗时或 reason），最新在上，20 行上限。
- 顶栏「执行」按钮；数据源为真实 run 回执（经 runtime 层 receipts），非模拟进度。

### NE-04 工程化（部分交付）

- ✅ 规则常量导出（单源化第一步）+ 文档（本计划 + 本报告）+ v1 现状回归即历史兼容证明。
- ⏸ **全量模块拆分明确推迟**：本轮对拍测试已建立迁移安全网，拆分按「先测试后迁移、构建期拼接回单文件保持零依赖入口」原则在下一窗口执行。如实标注为推迟而非完成。

## 二、变更清单（git 分组提交）

| 提交 | 文件 | 批次 |
|------|------|------|
| ① | lib/nodegraph.mjs、lib/choreography.mjs、lib/nodegraph.test.mjs | NE-01 contract |
| ② | assets/motion-graph.html、assets/settings.html、tools/acceptance/snapshots/settings.html、docs/studio-ui/baseline/functional-fingerprint.json | NE-01 editor+settings、NE-03 UI |
| ③ | lib/index.js、lib/nodegraph-runs.mjs、lib/nodegraph-runs.test.mjs | NE-02 runtime |
| ④ | docs/motion-graph-lab/NE-STABILIZATION-PLAN.md、ACCEPTANCE-NE-STABILIZATION.md | docs |
| ⑤ | assets/motion-graph.html（BUILD:SPLIT 标记）、editor-src/**（template+modules+README）、tools/motion-graph-build.mjs | NE-04 拆分基线 |

## 三、测试执行（终审复跑真实输出）

| 套件 | 结果 |
|------|------|
| nodegraph.test.mjs（含 §4b 对拍） | `nodegraph ok` Exit 0 |
| nodegraph-runs.test.mjs（新，8 组断言） | all assertions passed |
| pnpm run test:core | Exit 0（终审复跑 CORE_EXIT=0） |
| test:bridge | forward ok（7 用例） |
| test:contract | PASS（69 具名导出 / 64 api 键） |
| test:chain15 | 全部通过（5 项断言组） |
| test:breakpoint | 13/13（689ms） |
| test:deps | 17 passed, 0 failed |
| typecheck（vue-tsc --noEmit） | PASS |
| consistency | **9 PASS / 0 FAIL**（指纹基线已重算：settings.html +ngTri-state、motion-graph.html +exec-console/btn-exec） |
| 编辑器 selftest（真实浏览器取证） | `MG-SELFTEST validate-ok roundtrip-ok sim=3steps/1segs resizers-ok ctx-ok combo-ok panels-ok console-ok`（**八项全绿**） |

## 四、已知问题汇总

| # | 级别 | 内容 |
|---|------|------|
| K1 | 中 | 取消为**批间粒度**：已入队批次会播完（最大取消延迟 ≈ 单批 timeoutMs 12s）；已入队动作本身不可中断（ai-inbox 语义）。已入队任务的取消完整方案需 NE-02 后续窗口与 ai-inbox 协同扩展 |
| K2 | 低 | 取消对已终态记录返回 404（非幂等 200）——前端如需竞态重试需区分 missing/terminal |
| K3 | 低 | 注册表不持久化：宿主重启后 executionId 失效（与执行中状态生命周期一致，设计取舍） |
| K4 | 低 | LRU 并发 running 超 maxRecords 淘汰最旧 running（默认 20 难触发） |
| K5 | 低 | Execution Console 耗时字段依赖 receipt.at 时间戳，宿主回执缺时间戳时降级显示 reason |
| K6 | 低 | 空图组合实例化后 Validator 报「不能为空」属按规格的字面行为，偏严格 |
| K7 | 提示 | HTTP 层未做离线端到端冒烟（route/sendBuffer 依赖宿主 webServer 与 aiInbox），路由防护以代码走查 + nodegraph-runs 单测 + 真实执行冒烟（进程内复刻链路）覆盖；真机 3080 全链路验收属 Phase 5 |

## 五、验收门槛对照（方案 §验收门槛）

1. ✅ 同一 JSON 前后端校验一致（对拍测试绿）
2. ✅ 编译可重复（priority 分段对齐 + 旧图逐字节兼容）
3. ✅ E13 三态条（Imported/Validated/Runnable + 一键切换）
4. ✅ 组合实例化非法组合被拦截
5. ✅ 重复 run 第二次 409 busy + executionId 回查
6. ✅ 取消标志传播（后续批次不下发，实测 stopped+cancelled）
7. ✅ Execution Console 真实 receipts
8. ✅ 全量回归绿 + selftest 八项全绿

## 七、Phase 5 UI 链路实测（2026-11-09 14:40，computer-use 端到端）

宿主 3080 离线（用户外出），改走 dev-server 全链路实测（dev-server 已同步 NE-02 全部路由，445c2df）：

| # | 步骤 | 结果 |
|---|------|------|
| 1 | POST /nodegraphs/import fixture | ✅ {ok:true,name:端到端实测图} |
| 2 | GET /nodegraphs | ✅ valid:true |
| 3 | 真实执行 run（无模型） | ✅ 12s timeout → stopped，executionId 附于响应，批 0 receipts 完整 |
| 4 | GET /nodegraphs/executions?limit | ✅ 历史含 startedAt/finishedAt/status:timeout |
| 5 | GET /executions?id=X | ✅ 完整记录含 result 全文 |
| 6 | 切 llm 后 run | ✅ 409 mode-blocked（增强 message + executionId） |
| 7 | UI：锚点 #sec-nodegraph 直达 | ✅ DOM 快照渲染正常 |
| 8 | UI：点击 llm radio | ✅ POST 生效（mode:llm） |
| 9 | UI：三态条 Runnable ✗ → 「切换到节点图模式」按钮自动出现 | ✅ DOM 取证 node_id=11 |
| 10 | UI：点击切换按钮 | ✅ mode 恢复 nodegraph，闭环 |

宿主 3080 真机 Live2D 呈现验收留待宿主在线（UI 之外的最后一环）。

## Acceptance Status

**PASS_WITH_WARNINGS** —— NE-01/02/03 核心目标全部达成且证据完备；K1（批间取消粒度）为已知语义边界；NE-04 全量拆分如实推迟至下一窗口（安全网已就位）。


---

# 附加轮：设置三页重构 + 编辑器五项交互改造（2026-11-09 18:40）

## 交付（两代理并行，a4f1a24 + d9619f3）

### 设置三页重构（impl-setrefactor）
- 菜单六分区→三项：常规设置 / 节点编辑器 / 性能监控台；sec-dev 移除（诊断/重扫/监视台归性能监控台，实时读数自动画性能移入）
- 形态下拉选择器：根治 form-unavailable——运行时形态通道单向递增 0→1→2（cycleBodyType 钳制），下拉直达目标（≤2 次逐调用+回执校准），2→0 如实报无切回指令，不假成功
- run.mjs E 项断言授权更新为六分区新标题

### 编辑器五项改造（impl-editor2）
1. #canvas-hint z 4→1 + 可收起 chip（持久化）
2. 三栏可收起小悬浮 chip（56×26 可拖动持久化，画布自动占满，两态不遮挡核心区——DOM 断言）
3. 左键空白拖拽=框选、中键=平移、右键/滚轮零改动
4. 预设库 PRESETS 分组（Slots 按 modelId：载入/存当前/删除）
5. selftest 第九组 chips 断言

## 终审
- build verify IDENTICAL（192442B，模板同步后）
- consistency 9P/0F、test:core/contract/typecheck 绿
- selftest 九组全绿：validate-ok roundtrip-ok sim resizers-ok ctx-ok combo-ok panels-ok console-ok chips-ok

## Acceptance Status
PASS_WITH_WARNINGS —— ~~形态切回低形态需 overlay 轮次新增 l2d_set_form 直达 case（当前通道单向递增，UI 已如实提示）~~（✅ 已于 2026-11-10 形态直达轮解决，见下节）；预设载入无确认模态（toast 提示替代）；JSON 预览仅 selftest 模式存在（调查结论）；宿主 3080 真机 Live2D 呈现留待宿主在线。

---

# 附加轮：形态直达 l2d_set_form（2026-11-10，分支 cursor/set-form-direct）

## 交付
- [x] overlay.js 新增 `case 'l2d_set_form'`：参数 `{index}`（0..2 整数），复用 `setBodyType` 直达目标，**支持从高形态切回低形态**（2→0 / 2→1 / 1→0）
  - 非法 index（缺失 / 非整数 / 越界 / 字符串数字）→ `{ok:false,reason:'invalid-form-index'}`，不钳制
  - 缺 `L.setParameter` → `form-unavailable`；已是目标形态 → `{ok:true,form,notes:['already-current']}`，不写参数、不弹气泡
  - 成功后以 `prefs.bodyType` 复核，回执 `{ok:true,form:{index,label}}`（label 取自 BODY_TYPES）
  - `l2d_change_form` 零改动（仍为 +1 单向循环）
- [x] host-guard 白名单末尾追加 `l2d_set_form`（19 项），`guardAiCall` 静态校验 index，非法即 400 `invalid-form-index`
- [x] MCP 注册 `l2d_set_form` 工具（index: int 0..2，中文描述）
- [x] settings.html `bindFormChange`：先发一次 `l2d_set_form` 直达；宿主报 unknown tool 或老 overlay 回执缺 form 时回退到原 `l2d_change_form` 逐步逼近，「暂无切回低形态」提示只留在回退路径；快照同步（扣除 8 行退役注释头后逐行一致）
- [x] 新增 `lib/overlay-set-form.test.mjs`：从 overlay.js 原样抽取 BODY_TYPES / setBodyType / 分支在沙箱执行，7 用例覆盖回退、互切、already-current、非法 index、不可用、异常

## 待审
- 形态语义（三档标签 / Clothes2 取值 / already-current 不弹气泡）请 Live2D 席审阅
- settings.html 前端改动请前端席（Grok Bot）过目

---

# 附加轮：编辑器三项前端收尾（2026-11-10）

## 交付
1. **载入预设确认模态**（替换原「直接载入 + toast」）：非空画布单击预设先弹确认，列出当前画布与预设的节点/连线规模；按钮「取消 / 备份当前后载入 / 替换并载入」。备份写入槽位「载入前自动备份」。空画布直接载入不打扰。
2. **JSON 预览正常模式可用**：顶栏新增「JSON」按钮与菜单「JSON 预览」，打开只读浮窗 `#json-preview`（内容与导出同源 `Serializer.exportText()`，随 `UI.refreshAll` 实时刷新，可复制），接入 PanelLayers（拖动/收起/图层/持久化）。`#mg-export` 仍只服务 selftest 取证。
3. **NE-04 继续拆分**：新抽取 `hint-bar.js`、`rail-chips.js`（共 4 个模块）。迁移前快照与 extract→build 产物 `cmp` 一致，verify IDENTICAL（201288B）。

## 测试
- selftest 十组全绿：`validate-ok roundtrip-ok sim=3steps/1segs resizers-ok ctx-ok combo-ok panels-ok console-ok chips-ok jsonpv-ok`（chips 组的预设断言改为经确认模态：取消不改画布、确认才替换）
- 新增第十组 jsonpv：可见、与导出同源、加节点后实时刷新、已注册图层、可关闭
- 整页内联脚本与 4 个模块 `node --check`（.cjs Script 目标）通过
- consistency：本轮未新增 FAIL（组 2 指纹漂移为 Linux LF 检出与 Windows CRLF 基线的既有差异，main 上同样存在）

## Acceptance Status
PASS_WITH_WARNINGS —— 宿主 3080 真机未验；浮窗沿用编辑器既有投影样式以与其余监看浮窗一致。
