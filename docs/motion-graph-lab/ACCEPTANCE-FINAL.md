# Motion Graph Lab + 查虫轮 最终验收报告

**时点**: 2026-11-08 18:52（早于 21:00 验收窗口）
**验收人**: 齐汇川（主理人，GLM5.3Flash，额度回调代行全部故障席位）
**提交**: `f46bb32`（查虫修复批次）+ `63e33f2`（MG-LAB 批次），已推送 `75596c0..63e33f2`

## 1. 事件通报（如实）

- **9 席子代理通道全灭**：两轮 PacRpcClient 5000ms timeout → IPC 管道 ENOENT。产出按落盘实况核验，未采信任何未验证自述。
- **修复半成品补救**：fix-p1 死于 ai-inbox 编辑中途（只加了 `answeredTokens` 声明），主理人坐实缺陷完整形态后补完修复 + 4 个回归用例。
- **QA 缺口补齐**：QA 席死亡留下的六功能实测由主理人真实浏览器（WorkBuddy Browser）代行，全部有截图/标题/DOM 取证。

## 2. 修复批次内容（f46bb32，11 文件 +407/-81）

| 缺陷 | 级别 | 修复 |
|---|---|---|
| `ai-inbox.mjs` ownedCalls 过早删除（event-only post 销毁归属 → 后续 result 被 stale-token fence；result 受理后晚到 end/interrupted event 被拒，与注释承诺矛盾） | CRITICAL | event-only 不销毁归属；result 受理记 `answeredTokens`，晚到 event 凭 token 放行；takeover 同步清空。TL1-TL4 用例 |
| `action-executor.mjs:154` for(;;) 无退出 + `action-queue.mjs:119` Promise.race 假超时 | CRITICAL | 已落盘修复（P2 席），bridge×3 全绿 |
| `ingestion-pipeline.mjs:296-301` 快照失败永久无法补导 | HIGH | 已落盘修复（P4 席） |
| `repo.mjs:497-516` R8 覆盖写封堵绕过 | HIGH | 已落盘修复（P4 席） |
| `act-result/forward` 空 catch 放大 + 测试脚手架残留连接（test:bridge 预存 flaky 根因） | HIGH | 修复 + AbortController 三时序用例，12 连跑全绿 |

## 3. MG-LAB 批次内容（63e33f2，16 文件 +3901/-53）

- **motion-graph.html**：三栏可视化节点编辑器（Node Library / Graph Canvas / Inspector / 小地图），拖入、连线、Inspector、校验、模拟触发、导出导入、localStorage 按 modelId 分槽；`?selftest` 自检钩子（QA 增强：结果面板揭示 + title 摘要，参数门控不影响生产）。
- **control-studio.html**：六模块统一入口。
- **路由**：`lib/index.js` + `dev-server` 严格白名单两条 STUDIO_HTML_ROUTES（禁通配防目录穿越）；写方法跨站 403 守卫实测有效（evil Origin POST → 403）。
- **契约文档**：CONTRACT（12 条导出规则）/ SOURCE-MAPPING（ComfyUI 四机制零源码借鉴，GPL 红线）/ COMPAT-REPORT / REGRESSION-BASELINE（含 D 时点实测）/ sample-export.json。
- **consistency.test.mjs**：查虫轮授权清单（裁定 4 FAIL → 0）。

## 4. 测试执行与结果（全部实际运行）

| 套件 | 结果 |
|---|---|
| test:core（全量，含 ai-inbox TL1-TL4） | ✅ 全绿 |
| test:db | ✅ 全绿（gif-analyzer 8 tests） |
| test:bridge ×3 连跑 | ✅ 全绿 |
| test:contract | ✅ PASS（64 具名导出） |
| test:chain15 | ✅ 5 项断言组 |
| test:breakpoint | ✅ 13/13 |
| typecheck（vue-tsc） | ✅ 无错 |
| consistency | ✅ **10 PASS / 0 WARN / 0 FAIL** |
| MG-LAB 六功能浏览器实测 | ✅ 全 PASS（见 REGRESSION-BASELINE.md §8） |
| 编辑器导出 → validateNodegraph 交叉验证 | ✅ ok:true, errors:[]，segments 重建图同构，meta.editor 字节级透传 |
| 导入往返 | ✅ roundtrip-ok diff=0（title 取证） |

## 5. Known Issues

1. **`accept` 需宿主 3080**：三时点稳定复现的环境项，非本轮引入，不阻塞。
2. **settings.html 不在 dev-server 白名单**：属真机宿主路径语义，非缺陷。

## 6. Remaining Risks

1. `renderer/index.ts:2023` resetPerformance finishResolve 泄漏（P3 报 CRITICAL）**未修复**——renderer/index.ts 无落盘改动，需下一轮单独修复 + 截图回归验证。
2. 未跟踪散件（`_qa_crop/`、`tools/runtime-probe/`、若干报告 md）非本轮范围，保持未跟踪。
3. 席位通道故障根因（IPC ENOENT）未查，后续大编排前需确认平台恢复。

## 7. Acceptance Status

**PASS_WITH_WARNINGS**

（唯一 CRITICAL 遗留：renderer resetPerformance 泄漏；其余全闭环。）

## 8. 后续排序（按用户指令）

1. 继续查 bug（含 renderer 泄漏修复），直到查不到
2. 最后才推进资料库归档内容（node_id `3Ae9ZRCzTaVb29EYGt29yy`）
