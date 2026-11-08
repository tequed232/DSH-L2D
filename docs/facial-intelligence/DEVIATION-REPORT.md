# Facial Intelligence PR-01 技术差异报告（DEVIATION-REPORT）

**时点**: 2026-11-08 19:10 · **撰写**: 齐汇川（主理人） · **依据**: 真实源码审查，非文档推测

任务书要求（Part 20.C.7 微表情 / Part 4 口参数映射）与现有架构存在三处冲突。按任务书 Part 20.H 原则「先提交技术差异报告和最小改造建议，不得直接重写核心 Renderer」，本报告记录差异与 PR-01 的裁定。

## D1 口型参数被三层防线无条件拒绝（最重要的差异）

**现状（真实代码）**：
- `packages/renderer/src/app/param-injector.ts:206-209`：`MOUTH_PARAMS.has(id)` → 不区分通道直接拒绝（注释：口型红线）
- `packages/renderer/src/app/param-host-policy.ts:72`：`MOUTH_BLOCK`（LIPSYNC_PARAMS 同源）托管白名单同样排除
- `packages/renderer/src/app/motion-adapter.ts:18-22`：动作适配层同源红线（R9）

口型参数（`LIPSYNC_PARAMS`，core 定义）的唯一合法写者是 cue-bridge（TTS 口型同步通道，`applyCueFrame` 在 post 相位最后写）。

**冲突**：任务书 Facial Intent 含 `mouth.open/smile/form` 语义，Part 4.1 默认绑定含 `ParamMouthOpenY/ParamMouthForm`。

**PR-01 裁定**：FI 全链路不产出任何嘴部写入。理由：
1. 口型红线是用户钦定的防误删边界（记忆：K1/口型红线最优先），AI 面部层无权越过
2. 表情语义的嘴部效果（微笑等）已由 Expression（`setExpression/clearExpression`）承载，任务书 Part 16.5 `l2d_preview_expression` 正是这条路径
3. 音量驱动口型属 PR-02/03 的 Dialogue/Lip Sync 阶段（任务书 Part 13），届时应扩展 cue-bridge 的输入源（音量包络），而非绕过红线

**最小改造建议（PR-03 时点）**：cue-bridge 增加面部情绪输入通道（`mouth.form` → 嘴形偏置，乘以 TTS 音量包络），保持单一写者原则。

## D2 头角参数是物理输入且属 ADDITIVE_INPUTS

**现状**：`AngleX/Y/Z` 在 `ADDITIVE_INPUTS`（param-injector.ts:46），默认注入模式是 `add`（逐帧累加）；gaze 通道写头角用 `writeParam` 直写。Angle 是物理输入（发/袖物理的上游），必须在 pre 相位、物理更新前写入。

**PR-01 裁定**：FI 头角写入显式 `mode:'set'`（复用 cue 通道同一处理），走 `injector.set` 在 pre 相位、`injector.apply(core,'pre')` 之前；动作播放期（`poseOwnedByMotion`）让位，manual 来源不让位——与 gaze 的 `motionWritesHead` 约定一致。不新建写路径。

## D3 眼部写者顺序与天然眨眼

**现状**：post 相位写序 = poseController → ambient → physicsGate.post → `injector.apply('post')` → applyGazeEyes → applyCueFrame。Cubism 框架内置 EyeBlink 在模型 update 内写眼开合。

**PR-01 裁定**：FI 眼部在 `applyCueFrame` 之后最后写（FI 持有眼参数期间是确定性的最后写者，压过注视与内置眨眼）；FI 的 BlinkController 在 FI 持有期间承担眨眼职责（`frame.eyeL = 值 × blink`），到期让位后内置眨眼自动恢复。手动眼意图活跃时 BlinkController 让位（返回 null）。

## D4 任务书 ParamMixer vs 现有 ParamInjector

**现状**：仓库没有名为 ParamMixer 的模块；统一仲裁由 param-injector（sticky + 相位重放 + ownership）+ angleBus（mixAdditive 三路限幅）+ param-host-policy（托管白名单）组合承担。

**PR-01 裁定**：不新建旁路 mixer。`packages/facial-intelligence` 的 `ParamMixer`（语义层仲裁：override/additive/weighted、expiresAt、source 超时、conflict 上报）解决「多个语义来源争一个语义目标」；其输出经 FacialBridge 转成模型域值后**仍走 injector 写入**——既有全部守卫（口型红线/物理输出只读/真实下标/min-max 钳制/Node Ownership）一字未动。这正是任务书「所有输入源必须共享同一条参数控制链路」的实现方式。

## PR-01 交付范围（对齐任务书 Part 19）

- ✅ Facial Intent Schema + Validator（含 LIMITS、禁键、clamp 规则）
- ✅ Parameter Mapping（扫描建映射 + unit/bipolar 双域映射函数）
- ✅ Facial Controller（每参平滑/限速/duration+easing 过渡/dt 安全）
- ✅ Parameter Ownership（ParamMixer 语义仲裁 + 既有 injector 硬防线复用）
- ✅ Cubism Adapter 契约 + 写失败诊断（不静默成功）
- ✅ 微表情引擎（低频呼吸式相位，禁高频抖动）+ 眨眼控制器（seedable 确定性）
- ✅ 渲染桥 facial-bridge.ts（纯逻辑，单测覆盖）+ index.ts 相位接线
- ✅ /ai/call 新工具 `l2d_facial` / `l2d_facial_manual`（host-guard 白名单 + overlay 分发，零新传输面）
- ⏸ Parameter Inspector UI（Control Studio 集成属 PR-02+；PR-01 经 /ai/call + window.DSH_L2D API 手动验收）
- ⏸ LLM Emotion Planner / System Prompt（PR-02）
- ⏸ 交互引擎 / 摄像头（PR-03/04，接口已预留：`FaceTrackingFrame` 见任务书 Part 15，mixer 已有 tracking 优先级位）

## 验收对应（任务书 Part 20.H）

- 「手动修改脸部参数，模型真实发生变化」→ `l2d_facial_manual`（MANUAL=900）→ injector set → 真实参数变化
- 「不存在参数时明确报错」→ injector.set 真实下标校验返回 false + facialBridge.recordWriteResult 诊断计数
- 「模型切换后正确重新绑定」→ mount 时 `facialBridge.configure(modelSetting.FileReferences.Parameters)` 重建
- 「原 MCP 与 Actions Lib 正常工作」→ 零改动既有工具，host-guard 只追加两个白名单名
