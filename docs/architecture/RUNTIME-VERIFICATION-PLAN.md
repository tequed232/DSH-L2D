# Phase 3 技术方案：Runtime Verified（真实渲染运行时探针）

- 状态：**设计稿（待评审，未实施）**
- 日期：2026-11-04
- 作者：DSV4.1f（模型调试主导者：GLM）
- 前置：Phase 2 独立验收（本分支）通过；`validated` 与 `runtime_verified` 两种状态严格分立，前者由 G0–G4 静态管道产生，后者**只能**由本方案定义的探针流程产生。

---

## 1. 目标与非目标

### 目标
1. 接入真实 Live2D 渲染运行时（`@dsh/renderer`，pixi.js 8 + Cubism Web Framework）。
2. 加载已注册模型 `大肥鱼.dsl2d`（`DeepSeek免费公皮/DeepSeek/大肥鱼.dsl2d.model3.json`，509 参数 / 147 Parts，MOC3 v5）。
3. 验证注册表 Nodes 与运行时实际暴露参数**逐一核对**（模型版本漂移检测的真实探针）。
4. 通过 Model Adapter 解析 `tail_sway`（及扩展动作）→ 得到真实参数通道 → 驱动执行。
5. 监测目标参数变化：`Param_Angle_Rotation84/85/86/87`（尾巴四段级联）、`Clothes5`、`Param52`。
6. 记录完整执行证据：参数时间序列、时间戳、帧率、执行结果 → `execution_history` + `probe_runs`。
7. 异常时中止动作（Safety Guard）并写入 `execution_history(status='interrupted'|'failed')`。
8. 全部探针通过后，才允许经**唯一入口** `upsertModel(..., status='runtime_verified', runtimeEvidence=...)` 标记模型级 runtime_verified；动作级运行时证据落 `execution_history`，**不改变** `motion_definitions.status`（动作状态机无 runtime_verified 枚举，证据在执行历史，防止 validated/runtime_verified 混淆）。

### 非目标
- 不使用模拟参数变化冒充真实运行时验证（禁止 mock probe）。
- 不在本阶段改写动作链内容或放宽 G0–G4。
- 不做大规模动作训练/学习（learning_jobs 流程不变）。

---

## 2. 架构：六个新模块（对齐用户 Phase 3 路线表）

```
┌────────────────────────────────────────────────────────────────┐
│                    runtime-probe（Node CLI， headed）            │
│                                                                │
│  RuntimeAdapter ──► ParameterProbe ──► ActionExecutor           │
│       │                  │                   │                 │
│  加载 dsl2d 模型     每帧采样参数          经 Model Adapter      │
│  Cubism Core 初始化  时间戳+帧率          解析语义→参数通道      │
│       │                  │                   │                 │
│       └────────► SafetyGuard ◄───────────────┘                 │
│                     │ 冲突检测/限幅/中止                        │
│                     ▼                                          │
│             ExecutionHistory（SQLite 唯一写入口）                │
└────────────────────────────────────────────────────────────────┘
```

| 模块 | 位置 | 职责 |
| --- | --- | --- |
| Runtime Adapter | `tools/runtime-probe/runtime-adapter.mjs` | 无头/headed 启动渲染器（Playwright 驱动 Chromium + WebGL），加载 `大肥鱼.dsl2d.model3.json`，返回受控句柄（loadModel / getParameter / setParameter / tick / dispose） |
| Parameter Probe | `tools/runtime-probe/param-probe.mjs` | 每帧采样目标参数 → `{ t, fps, values: { paramId: v } }` 时间序列；首 N 帧取基线（probe_runs.baseline） |
| Action Executor | `tools/runtime-probe/action-executor.mjs` | 读 `motion_definitions`（仅 validated）→ `resolveMotionParams`（Model Adapter，fail-closed）→ 按 steps 逐帧注入参数 |
| Safety Guard | `tools/runtime-probe/safety-guard.mjs` | 三道防线：①冲突检测（同帧多动作争抢同一参数 → 拒绝并发）②限幅（clamp 到注册表 min/max；无范围证据的参数只允许只读监测）③中止（帧率崩塌 / 参数越界 / 执行超时 → 立即停注入 + 基线恢复） |
| Execution History | 复用 `actions-repo.recordExecutionHistory` | 唯一写入口；request/result 全量留痕 |
| Runtime Verification | `tools/runtime-probe/verify.mjs` | 汇总探针 → 判据（§5）→ 全过才调 `upsertModel(runtimeEvidence)` |

**渲染宿主选择**：Playwright + Chromium（headed）承载现有 `@dsh/renderer` Vite 页面，通过 `window.__l2dProbe` 暴露受控 API。理由：复用现有渲染器全部初始化逻辑（fw/ 目录即 Cubism Web SDK 封装），不另写第二条加载路径；Cubism Core（live2dcubismcore.min.js）按 .gitignore 约定由本机提供，不入库。

---

## 3. 探针流程（单动作）

```
0. 前置检查：motion.status === 'validated'（否则拒绝执行，复用执行闸门）
   resolveMotionParams(motionId, modelId) 必须 ok:true（否则中止，不降级）
1. 启动渲染宿主 → 加载模型 → 等待 Cubism model ready
2. 一致性核对（Gates A）：
   A1 运行时参数集 vs 注册表 parameters 表：
      - 运行时有而注册表无 → 记 validation_findings(severity='warn', code='unregistered_param')
      - 注册表有而运行时无 → **fail**（版本漂移），与 Model Adapter resolveMotionParams 行为一致
3. 基线采样（Gates B）：静止渲染 60 帧，取各目标参数中位数 = baseline；写入 probe_runs.baseline
4. 执行（Gates C）：
   C1 Safety Guard 预检：通道参数须有 min/max 证据，否则该通道降为只读监测并如实记录
   C2 逐帧注入：按 action steps 的 durationMs 时间线设置参数
   C3 每帧记录 { t, fps, values }
5. 恢复验证（Gates D）：动作结束后 60 帧，参数应回归 baseline ±noise；
   未回归 → restored=0，Safety Guard 强制基线恢复后重验
6. 判据（Gates E）：§5 全过 → probe 成功
7. 落库：
   - probe_runs：每个目标参数一行（baseline / input_value / result(diff+观测) / restored）
   - execution_history：一条 { status: 'completed'|'interrupted'|'failed'|'timeout', result: { fps 统计, 参数时间序列摘要, gates 结论 } }
8. 全部探针动作通过 → verify.mjs 调 upsertModel(status='runtime_verified', runtimeEvidence={ probeRun, verifiedAt, probedBy })
```

## 4. 目标参数与三动作跨参数族测试（用户裁决：不止 tail_sway）

| 动作 | semantic_key | 语义通道（Model Adapter） | 目标参数族 | 验证点 |
| --- | --- | --- | --- | --- |
| 尾巴摆动 | `dog_tail_grass_wave`（已注册 validated） | `tail_sway` | `Param_Angle_Rotation84~87`（四段级联） | 级联传导：84→85→86→87 依次相位滞后 |
| 耳朵动作 | `ear_flick`（**待新建**，走 G0–G4，不跳闸） | `ear_move` | 需从 509 参数中定位耳族（cdi3 中文名检索"耳"，人工核对后注册桥接） | 独立参数族映射成功 = 跨族通用性证据 ① |
| 表情变化 | `expression.angry`（**待新建**） | `face_angry` | `AngryMove*`（×8）+ 配套 `*Ribbon*`/`Skirt*` 物理族只读观测 | 多参数并行映射 + 物理联动观测 = 跨族通用性证据 ② |

`Clothes5`、`Param52` 为全程只读监测项（tail_sway 执行期间观测服装物理是否联动、Param52（呆滞族）是否保持基线），它们**不是**注入目标——只读监测不要求 min/max 证据。

## 5. runtime_verified 判据（全过才算）

| # | 判据 | 阈值 |
| --- | --- | --- |
| V1 | 一致性：运行时参数集 ⊇ 注册表参数集（动作涉及通道） | 0 缺失 |
| V2 | 执行帧率 | 中位数 ≥ 30 FPS，最低 10 帧 ≥ 15 FPS |
| V3 | 目标参数响应 | 注入通道在动作窗口内偏离 baseline ≥ max(5% 满量程, 注册表 min/max 幅度 × 0.1)；无范围证据通道只记录不判 |
| V4 | 级联/联动 | Rotation85/86/87 相位滞后 84 出现（尾巴族）；物理族观测到非基线波动（表情族，只记录） |
| V5 | 基线恢复 | 动作结束 60 帧内回归 baseline ± 噪声带，restored=1 |
| V6 | 无越界 | 全程参数值 ∈ 注册表 [min, max]（有证据通道） |
| V7 | 留痕完整 | probe_runs 每目标参数 ≥1 行；execution_history 1 条 completed |

任何一条不过：execution_history 记 `failed`（含具体 V 码与证据），模型 status 保持 `analyzed`，**不得**写 runtime_verified。

## 6. 异常与中止路径

| 异常 | 检测 | 处置 | 落库 |
| --- | --- | --- | --- |
| 渲染崩溃 / WebGL 上下文丢失 | 宿主事件 | 立即终止 | `execution_history('failed')` + validation_findings |
| 帧率崩塌（< 5 FPS 持续 30 帧） | Parameter Probe | Safety Guard 中止注入 | `execution_history('timeout')` |
| 参数越界（> max 或 < min） | 每帧 | clamp + 记 warn；连续越界 → 中止 | `execution_history('interrupted')` |
| 执行超时（> steps 总时长 × 3） | Executor | 中止 + 基线恢复 | `execution_history('timeout')` |
| resolveMotionParams fail-closed | 执行前 | 拒绝执行（不降级） | `execution_history('rejected')` |

中止后**必须**尝试基线恢复并重验 V5；恢复失败在 result 中如实记录。

## 7. 状态写入纪律（回应验收任务书"三者不能互相替代"）

| 状态 | 产生者 | 存储 | 不可由何替代 |
| --- | --- | --- | --- |
| `validated` | G0–G4 管道（createActionChain） | motion_definitions.status | runtime_verified 不能自动提升它（状态机无此转换） |
| `runtime_verified`（模型级） | 仅 verify.mjs（带 runtimeEvidence） | models.status + motion_status_log 留痕 | upsertModel 已加闸门：无证据抛 RUNTIME_EVIDENCE_REQUIRED |
| `runtime_verified`（素材级） | 运行时分析流程 | motion_assets.status | 不在本阶段产生 |
| `approved` | 仅 review.mjs decide（人工） | gallery_labels.review_state | 本阶段不触碰；已裁决不可覆写（本分支已修复 repo 层绕过） |

## 8. 交付物与验收清单（Phase 3 完成定义）

- [ ] `tools/runtime-probe/`：runtime-adapter / param-probe / action-executor / safety-guard / verify + CLI
- [ ] Playwright 宿主页面（复用 @dsh/renderer，`window.__l2dProbe` 受控 API）
- [ ] `ear_flick`、`expression.angry` 两个动作经完整 G0–G4 入库（附桥接证据）
- [ ] 三动作探针运行记录（probe_runs + execution_history）
- [ ] `大肥鱼.dsl2d` 模型级 runtime_verified（三动作全过才写）
- [ ] Phase 3 验收报告（含帧率、参数时间序列图、判据逐项结论）
- [ ] 测试：Safety Guard 单元测试（越界/冲突/超时，纯逻辑无渲染）

## 9. 风险与已知限制

1. **目标注入通道全部无 min/max 注册证据（实测 2026-11-04）**：`Param_Angle_Rotation84~87`、`Clothes5`、`Param52` 在注册表中 min/max 均为 NULL（cdi3.json 为显示信息文件，不含 Min/Max；vtube.json 亦无）。
   **前置任务 P3-0（注入准入）**：用 py-moc3（读路径 verified）从 `大肥鱼.moc3` 二进制读取这 6 个参数的 Min/Max/Default（模型作者设定的一手事实，evidence_level='source_exact'，source_pointer=py-moc3 版本+偏移），人工核对后经 upsertParameter 注册。完成前这些通道只读监测、不允许注入。
   当前语义桥（bridge.mjs）中 tail_sway→Rotation84~87 仅注册了 paramId 与 weight，未声明 min/max——与注册表一致，不构成伪造；Phase 3 注入前必须补齐。
2. **Playwright + WebGL 在 CI 环境可能不可用**：探针设计为本机 headed 运行；CI 只跑 Safety Guard 纯逻辑测试。
3. **Cubism Core 授权**：live2dcubismcore 不入库，探针运行需本机已放置（与渲染器约定一致）。
4. **vbridger/AdvancedARKitSettings 可能运行时注入额外参数**：一致性核对以运行时实测为准，差异如实入 findings，不预设注册表完备。
5. 模拟器（pixi-live2d-display 的 motion 预设播放）**不算**探针：只允许通过 Model Adapter 语义→参数注入路径，禁止走模型自带 motion3 播放来"演示成功"。
