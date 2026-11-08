# Facial Intelligence PR-01 验收报告（Facial Control Core）

> 生成：2026-11-08（22:00 验收窗口前）
> 依据：DSH-L2D Facial Intelligence 实施包任务书（资料库 node_id `3Ae9ZRCzTaVb29EYGt29yy`）
> 范围声明：本报告仅覆盖 **PR-01 Facial Control Core**。摄像头视觉追踪（PR-02）、完整 LLM 意图管线（PR-03）、Inspector UI（PR-02+）不在本轮范围。

---

## 1. 交付概览

### 新增包 `packages/facial-intelligence`（纯逻辑，零 Cubism 运行时依赖）

| 模块 | 职责 |
|------|------|
| `src/schema/facial-intent.ts` | FacialIntent/FacialPlan 语义域类型（Emotion/Easing/Head/Gaze/Eyes/Brows/Mouth） |
| `src/schema/validator.ts` | `validateFacialPlan`：白名单键、数值越界 clamp+warnings、NaN/Infinity/字符串注入/禁键（parameterId/script/tool_calls）拒绝；LIMITS：duration 80–5000ms、priority ≤700 |
| `src/schema/defaults.ts` | 情绪模板基线 + `getTemplateIntensity` |
| `src/controller/parameter-mapping.ts` | 11 个 FacialSemantic → Cubism 参数绑定；`mapBipolarRange`（-1..1 角度域）/`mapUnitRange`（0..1 开合域）双域映射 |
| `src/controller/facial-controller.ts` | 每参平滑、角度限速 120°/s、FACE_PARAMETER_BOUNDS 钳制、duration+easing 过渡、hardReset |
| `src/controller/arbitration.ts` | ParamMixer：升序优先级仲裁、source 超时（500ms）、`expiresAt` 提前释放、skippedWrites 诊断计数 |
| `src/animation/micro-expression.ts` | 情绪驱动微表情模板（绝对目标值输出，口型参数由桥侧红线拦截） |
| `src/animation/blink-controller.ts` | mulberry32 确定性眨眼 + 手动 hold + 情绪调制乘数 |
| `src/adapter/cubism-adapter.ts` | 契约层：`createBindingFromScan` 模型参数扫描建映射（fail-closed，模型未就绪拒绝） |

### 渲染集成

- **`packages/renderer/src/app/facial-bridge.ts`**：纯逻辑桥（不 import Cubism），validate→意图登记→每 tick 重提交→mixer.step→ FacialController 过渡→眨眼乘数→组帧。9 项单测全绿。
- **`packages/renderer/src/index.ts`**：pre 相位写头角（`AngleX/Y/Z` 显式 `mode:'set'`，动作占用期让位）；post 相位写眼部（`ParamEyeLOpen/ROpen/EyeBallX/Y` mode:'set'）。全部经既有 param-injector 守卫（口型红线 / Node Ownership 白名单 / 物理让位）。
- **传输面**：`/ai/call` 白名单追加 `l2d_facial` / `l2d_facial_manual`，overlay 分发透传，**零新增路由**。

### 附带修复（查虫轮遗留 CRITICAL）

`resetPerformance` 后 `await finished` 永久挂起：`pendingFinishResolvers` 集合统一 settle + 清空；reset 同时 `facialBridge.reset()`。

## 2. 差异裁定（详见 `DEVIATION-REPORT.md`）

| # | 任务书原案 | 实际裁定 |
|---|-----------|---------|
| D1 | 摄像头 / ParamMixer 拒绝嘴部写 | PR-01 **无嘴部写路径**（injector 口型红线不区分通道无条件拒绝，PR-03 建议 cue-bridge 加情绪输入通道） |
| D2 | 直接写头角 | `AngleX/Y/Z` 属 ADDITIVE_INPUTS 默认 add 语义 → pre 相位显式 `mode:'set'` + 动作期让位（manual 例外） |
| D3 | 外部追踪接管眼部 | 眼部最后写者 + FI 自管眨眼，追踪接口留 PR-02 |
| D4 | 任务书 ParamMixer 全量仲裁 | FI 语义层仲裁 + 输出仍走既有 injector，**不建旁路**（复用 Node Ownership / 口型红线全部防线） |

## 3. 测试执行（全绿）

| 套件 | 结果 |
|------|------|
| `packages/facial-intelligence/tests/schema.test.ts` | 18 tests PASS |
| `controller` / `mapping` / `arbitration` 测试 | PASS（含 skippedWrites 计数修复、expiresAt 与 source timeout 隔离） |
| `packages/renderer/src/app/facial-bridge.test.mjs` | 9/9 PASS（含口型红线、手动压 LLM、hold 到期让位、收敛精度） |
| `host-guard.test.mjs` + `nodegraph.test.mjs` | 白名单 18 项断言更新后 PASS |
| `pnpm run test:core` 全量 | PASS |
| test:db / test:bridge / test:supervisor | PASS |
| test:contract（69 具名导出 / 64 api 键 / overlay 依赖全覆盖） | PASS |
| test:chain15（5 断言组，实测 22342ms vs 声明 22320ms） | PASS |
| test:breakpoint（13/13，SIGKILL 真实子进程） | PASS |
| test:deps / test:types / typecheck（vue-tsc --noEmit） | PASS |
| consistency.test.mjs | **9 PASS / 0 FAIL** / 1 WARN（WARN 为本轮授权文件归属确认，见 §5） |

## 4. 验收标准对照（任务书 Part 18 / 20.H）

| 验收项 | 状态 | 证据 |
|--------|------|------|
| LLM → FacialIntent 语义域 → 校验 → 平滑 → 仲裁 → Cubism 契约 | ✅ | 桥 9 用例 + schema 18 tests |
| 手动修改脸部参数，模型真实变化 | ⚠️ 见 Known Issues K2 | 逻辑层证明：manual 优先级 900 > llm ≤700，桥测试覆盖「手动压过 LLM + release 恢复」；宿主端实测待 K2 环境 |
| 优先级表对齐（SAFETY=1000 … LLM≤700） | ✅ | 桥测试「优先级常量对齐」用例 |
| 双域映射不串域 | ✅ | mapping 测试（bipolar/unit 错域用例） |
| 口型红线（LLM 永不写嘴） | ✅ | 三层：validator 禁键 → 桥过滤 mouthOpen/mouthForm → injector 无条件拒绝；bridge 测试「surprised 模板含嘴部波形但桥零产出」 |
| 非法意图零产出 | ✅ | 桥测试「非法意图拒绝零产出」 |

## 5. Known Issues / Remaining Risks

- **K1（范围内）**：Inspector UI / 参数面板属 PR-02+，本轮仅提供 `getFacialState` / `setManualFacialParam` / `previewFacialEmotion` 等 API 面（window.DSH_L2D）。
- **K2（环境依赖）**：「宿主 3080 环境 + 真实模型加载后手动调参可视化验证」需宿主服务在线；本轮以逻辑层等价用例（桥 9 用例）替代，建议下一窗口在宿主实测一遍 `DSH_L2D.applyFacialIntent`。
- **K3**：mixer source timeout 500ms 语义下，静止贡献（manual/intent）每 tick 重提交——已实现并测试，但宿主若以低频调用 API（>500ms 间隔）需知悉该语义。
- **K4**：dev-server 跨站 GET/POST 200 为既有 cors 设计（writeGuard 仅护写路由），本轮实测 `POST /settings.json` evil Origin→403 确认防护有效，非新引入。

## 6. 协作记录

- 后端席（MiMo）交出 FI 核心包（schema/controller/mixer/micro/blink/adapter）后通道中断；主理人额度回调代行桥、测试与接线。裁定**包归属后端席版本**（更完整：共享 FacialSemantic / BindingScanResult / fail-closed），主理人适配桥 API 并修复其 arbitration skippedWrites 死逻辑（升序求值下该分支永假）。
- 团队章程 / 一致性测试 FORBIDDEN-ALLOW 清单按 FI 轮授权注释更新。

## Acceptance Status

**PASS_WITH_WARNINGS** —— 功能与测试全部达成；宿主端真实模型可视化验证（K2）留待下一窗口，Inspector UI 属后续 PR 范围。
