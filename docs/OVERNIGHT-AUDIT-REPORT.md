# DSH-L2D 通宵工程审计报告（OVERNIGHT AUDIT）

- 生成：2026-11-05 01:40（autonomous mission，截止 07:00）
- 审计人：DSV4.1f 主 Agent（本报告只记载**已验证事实**，推测性结论一律标注）
- 主导者：前端 GLM / 后端 MiMo / 模型调试 GLM / 验收 DSV4.1f

## 1. 开放 PR 与依赖链（GitHub API 实查，7 个开放）

| PR | 分支 | Base | 依赖结论 |
|---|---|---|---|
| #25 | feat/model-registry | main | 本轮主战场（SQLite/审核闸门/安全边界/Runtime Probe） |
| #24 | feature/ds-bot-uiux-modernization | **feat/model-registry** | ⚠ 叠在 #25 之上：#25 未合并前 #24 无法进 main；UI 修复须基于该分支 |
| #23 | feat/apple-google-minimal-design-skill | main | 独立，无阻塞 |
| #19 | feat/m1-f2-behavior-loop | main | M1 执行基础（依赖链根） |
| #20 | feat/whale-workspace | **feat/m1-f2-behavior-loop** | 叠在 #19 分支上 |
| #21 | feat/m1-d-overnight | **feat/m1-f2-behavior-loop** | 叠在 #19 分支上 |
| #14 | docs/agent-prompt-orchestration-guide | main | 独立文档 PR |

**合并顺序约束**：#25 → #24；#19 → (#20, #21)。任何直接合并 #24/#20/#21 到 main 都会造成缺基。

## 2. 运行时条件实测（Phase 3 前置，全部实机验证）

| 条件 | 状态 | 证据 |
|---|---|---|
| Cubism Core | ✅ 在位 | `vendor/cubism/CubismSdkForWeb-5-r.5/Core/live2dcubismcore.min.js`（228KB） |
| 渲染宿主 | ✅ 复用现成 | `tools/dev-server`（/core.js /renderer.js /model 全通）+ `window.DSH_L2D` 完整 API |
| 浏览器 | ✅ Edge | `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe` |
| GPU/WebGL | ✅ 真实 GPU | ANGLE (NVIDIA RTX 5060, D3D11)；drawables 715，glErr=0 |
| Playwright | ✅ 已装 | `tools/runtime-probe` playwright-core 1.64.1（msedge channel 免下载） |
| ⚠ 虚拟显示节流 | 已克服 | 本机 GameViewer Virtual Display 使 rAF 节流至 6/s；`--disable-gpu-vsync --disable-frame-rate-limit` 后实测 58/s |

## 3. Runtime Probe 首批真实证据（probe_run 5–8，SQLite 已入库）

| 探针 | 请求 | 实际注入 | 观测 | 恢复 | 结论 |
|---|---|---|---|---|---|
| smoke | — | — | 45fps，509 参数，lastError none | — | **PASS** |
| LEar1=1 | 1 | 1（ownership 认领，物理输出） | movedBeyondNoise=true | ✅ | **PASS** |
| AngryMove=1 | 1 | 1 | movedBeyondNoise=true | ✅ | **PASS** |
| Rotation84=45 | 45 | 45（尾巴段1 满幅） | movedBeyondNoise=true | ✅ | **PASS** |
| Param39=1 | 1 | **0.322（strict clamp 至 Soft Envelope）** | movedBeyondNoise=true | ✅ | **PASS** |

Param39 案例即用户 2026-11-05 裁决的双层边界（Hard[-1,1]/Soft[0,0.322]）首次在真实渲染运行时闭环。截图证据：`data/runtime-probe/*.png`。

## 4. 写入闸门核查（安全边界）

- `packages/dsh-l2d-db/src/repo.mjs`：gallery 已裁决不可覆写（CASE 守卫）、upsertModel runtime_verified 须 runtimeEvidence——本日 P1 审查修复，测试在位。
- `safety-guard.mjs`：fail-closed / 硬违规拒 / strict clamp / 批量原子——探针已实测 strict clamp。
- `review.mjs`：61 条标签唯一决策入口，Agent 不自动批准。
- Runtime Probe 遵守唯一写路径：参数写经渲染器 `setParameters`（ParamInjector 所有权管辖，物理输出须 ownParameters 认领）；探针记录经 `insertProbeRun`（新增 Repository 助手）。

## 5. 风险与待办

1. **61 条标签人工裁决**未完成（真实人工环节，保留 needs_review）。
2. **模型级 runtime_verified 未设置**：单参基线探针 PASS 不足以标记；须完成三动作级联/组合探针 + 多模态视觉验收（GLM）后才可写入。
3. **PR #24 的 base 指向 feat/model-registry**：需用户确认是否有意（若是，#25 必须先合并）。
4. UI/M1 定向审计（ui-m1-auditor 代理）进行中，结果出来后追记本文档。
5. 渲染器失焦降载 30fps 为既有省电设计，探针期间不受影响（bringToFront+满帧交互窗口）。

## 6. 时间线纪律（07:00 截止）

- 06:00 停止新增高风险架构变更 → 全量回归
- 06:30 冻结功能范围，只修阻断验收问题
- 06:45 PR/分支/测试/证据核对
- 07:00 `docs/OVERNIGHT-DELIVERY-REPORT.md` 交付

## 7. 定向审计追记：UI/UX（PR #24）与 M1（01:50，ui-m1-auditor 代理，行号证据在案）

### UI/UX（代码在 feature/ds-bot-uiux-modernization 分支，不在当前工作区）
1. **Plugin Center 空白最大嫌疑：跨 Vite root 导入**——`PluginCenterView.vue:12` 导仓库根 `tools/w3-registry/registry.json`、`main.ts:3` 导 packages 的 ui-tokens.css；dev 默认 fs.allow 可能放行，preview/独立起服即 403/解析失败→整页空白。数据源本身 36 条 entries 无问题。
2. **主题**：`ui-tokens.css:67-98` 默认永远深色；无 `prefers-color-scheme`；`useSettings.ts:30` 默认 dark；index.html 硬编码 dark 有 FOUC；无 safe-area-inset。
3. **布局**：唯一断点 900px；≤900 时 StageArea 在 auto/1fr 滚动行内可能塌缩（无 min-height）；768~900 无中间断点。
4. **SVG**：M3Icon 内联真实进渲染树，但**当前工作区缺分支补的 6 个图标**（cherry-pick 会空白）；overlay.js:12 注释与实现不符（占位是渐变 div 非 SVG）。
5. **假数据**：`useSettings.ts:23-24 contextPreview` 为 UI 预览假状态源但无用户可见标注；StageArea 状态栏静态"帧率—/参数—"；其余占位均有 TODO/disabled 标注。

### M1（PR #19-21 相关代码，当前工作区）
1. **ActGate 完整**（action-chain.ts:259-364，runId fence 语义正确）；**generation fencing / consumer lease 未实现**（独立分支 feat/m1-d3-consumer-lease 未并）。
2. **优先级风险**：listening/thinking/speaking 全 FORCE，settle NORMAL 必被阻断；三个 AI 阶段同级互抢无保护；抢占时 motionFail 原因丢失（:316 清空不进回执）；releaseAct 无参可撤他人链（API 面未挡）。
3. **ParamInjector 唯一正门成立**（param-injector.ts:284 唯一 setParameterValueById 业务写入）；绕过点=renderer 内 writeParam（注视/眼球/Lean，物理输入）+ SDK 效果层（眨眼/呼吸/口型内嵌直写，keyframes 写眨眼参数会与 EyeBlink 冲突无仲裁）。
4. **workspace 状态机**：snapshot 纪律好（绝不伪装 idle/success）；workspace-agent 通知丢失窗口（fire 被压时纯工具回执变化被永久吞 :327-361）、prompt 失败静默但占 30s 冷却。
5. **无 mock 后端**；占位均有标注，唯 contextPreview/StageArea 缺用户可见标注。

### 修复优先级（今晚）
- P1：PR#24 跨 root 导入修复（空白根因）+ contextPreview/StageArea 用户可见"预览/骨架"标注 + 主题 prefers-color-scheme。
- P2：ActGate 抢占丢原因、releaseAct 参数防呆——记入任务清单，不在今晚动架构（06:00 后禁新架构变更）。
