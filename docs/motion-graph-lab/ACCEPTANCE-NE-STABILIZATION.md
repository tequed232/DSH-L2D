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
| ④ | docs/motion-graph-lab/NE-STABILIZATION-PLAN.md、docs/motion-graph-lab/ACCEPTANCE-NE-STABILIZATION.md | docs |

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

## Acceptance Status

**PASS_WITH_WARNINGS** —— NE-01/02/03 核心目标全部达成且证据完备；K1（批间取消粒度）为已知语义边界；NE-04 全量拆分如实推迟至下一窗口（安全网已就位）。
