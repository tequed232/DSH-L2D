# 节点图动作编排通道 — 验收报告（NG 轮）

- 日期：2026-11-08 · 主理人终审 · 完成时间 15:25（验收时限 17:00，提前 1 小时 35 分）
- **总验收状态：PASS_WITH_WARNINGS**（0 FAIL；全部 WARN 如实登记，见 §5）

## 1. 用户需求 → 交付映射

| # | 用户需求 | 交付 | 证据 |
|---|---|---|---|
| 1 | 测试 LLM 通道与节点通道可用性 | LLM 通道：guardAiCall 白名单守门实测（unknown tool 正确 400 拒绝，端点存活）；节点通道：run 执行链路 dev-server 实测 10/10 | 实测席 §一.5、后端席 dev-server 报告 |
| 2 | 每模型节点图分别存 JSON 分享转让、导入直接可用 | Schema v1（`bindingMode:"any"` 默认任意模型可用）；import/export 路由 + UI；重名校验失败原文件不动 | 实测导入 200 `{"ok":true,"name":"挥手测试"}`，export 回读 diff=0 |
| 3 | 导入后回传动作给模型正确调用 | `POST /nodegraphs/run`：segments → executeActionSequence（FIFO+队列+回执）→ aiInbox l2d_act 既有下发链路（零新链路） | 10 组单测 + dev-server 实测（含无 renderer 12s 明确超时语义） |
| 4 | 可行时不调用 LLM 通道 | nodegraph 模式下节点图命中直接执行，不经 /ai/call | 单测「409 时 execute 零调用」+ run 直连下发 |
| 5 | 「节点图+LLM辅助」与「纯LLM」互斥 | 双向门禁：nodegraph 模式下 l2d_act/l2d_emote 被 `deny('mode-blocked')`；llm 模式下 run 返回 409；模式持久化 `$DSH_HOME/l2d-motion-mode.json` | 实测切换持久化 PASS（两次写入落库）+ 双向 409/deny 单测 |

## 2. 提交记录（已推送 `fbb2331..acde906`）

| Hash | 内容 |
|---|---|
| `e165379` | fix(renderer): 具名导出 modelName/model 修复预存 contract 失败（抓虫） |
| `2de555e` | feat(nodegraph): 执行通道与互斥（schema/编译/存储/门禁/5 路由/单测挂链，+1501） |
| `7eb3633` | feat(nodegraph): 设置页 06 卡片 UI（+682 含快照） |
| `acde906` | docs(nodegraph): 契约/截图/看板/授权清单/基线刷新 |

## 3. 测试结果（全部本地实跑，主理人独立复验）

- `pnpm test:core` **EXIT=0**（含新挂入的 nodegraph 10 组断言；contract 门禁 FAIL→PASS）
- `consistency.test.mjs` **9 PASS / 1 WARN / 0 FAIL**（快照 0 差异、指纹零漂移、禁改零命中）
- 功能指纹严格验证 **removed=0 / changed=0**（纯新增）后才刷新基线
- 联调实测（dev-server 5300，--noproxy）：模式互斥持久化 ✅、合法导入 ✅、坏 JSON 400 四条校验 ✅、列表/导出 ✅、卡片渲染 ✅（双尺寸截图）
- 抓虫记录：①34495b1 埋的 overlay→renderer 具名导出缺失（e165379 修复）；②consistency 轮次语义 2 FAIL（基线刷新+授权清单归零）；③context-keeper 快照口径误报（D12 定案排除）

## 4. 团队执行纪要

六席协作：情报席（链路定位 + 交叉验证 + context-keeper 看板）、实测席（勘查 + 联调实测 PASS_WITH_WARNINGS）、后端席（NG-BACKEND + NG-RUN + contract 修复，三连 PASS）、前端席（NG-FRONTEND + NG-RUN-UI，双 PASS）、主理人（契约 SPEC.md、集成、抓虫、终审提交）。全程本地开发，无服务器部署。

## 5. WARN 与未验证范围（如实登记）

1. **宿主 3080 未运行**（外部 DSH 应用，本机无监听）：宿主内浮层交互、`/ai/call` 端到端（含渲染端消费 l2d_act 回执闭环）未真机实测——代码层确认存在，待宿主可用后复验。已由后端单测 + dev-server 语义实测最大程度覆盖。
2. **file input 的 OS 对话框**无法由无头浏览器安全操作：导入走 UI 文件选择的端到端未走通（curl 与前端 FileReader 同构性已验证，风险极低）。
3. **浏览器下载落盘**（导出按钮的 a[download]）未验证。
4. **浅色主题**截图未覆盖（本轮截图全深色）。
5. `profile.大肥鱼.dsl2d.2048.json` 运行时产物（+1/-1 时间戳）持续不提交。
6. 服务器清理后 **5319 云端测试台已下线**；本地 5300/5400 调试服终审后已停（零监听确认）。

## 6. 结论

用户五项需求全部交付且有自动化断言或实测证据支撑；两条互斥门禁对称闭环；分享 JSON「导入即用」默认口径落地。已知限制集中于宿主 3080 不可用导致的真机复验项，均已标注复验路径。
