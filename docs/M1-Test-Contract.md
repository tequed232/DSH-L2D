# M1 测试契约对照表（Embodied-Behavior §9 落地清单）

> 目的：把 `docs/Embodied-Behavior.md` §9 的每条测试契约映射到**三层验收载体**——
> ① 自动化测试（单测/spec，进 `pnpm test:core` 门禁）；② 真机脚本用例（`tools/acceptance/m1-smoke.mjs`）；
> ③ 人工项。每行可勾选，集成日逐项打勾。
>
> 状态图例：✅ 已有（本 worktree 可跑）· 🔶 待交付（m1 各代理交付后接入）· ⬜ 待执行（集成日/真机）
> 真机脚本用例编号 T/U/H 见 `tools/acceptance/m1-smoke.mjs` 头注释。

## 1. 可执行 spec：`tools/ownership-spec/`

| §9 契约 | 载体 | 状态 | 勾选 |
|---|---|---|---|
| 24 用例可执行规格 | `tools/ownership-spec/cases.mjs` + `run.mjs`（可对任意实现跑） | ✅ 已有 | ☐ |
| 参考实现自检（进 test:core 门禁） | `tools/ownership-spec/reference.test.mjs` | ✅ 已有 | ☐ |
| CASE-01..25 × 实现逐条跨验 | `packages/core/test/ownership-invariants.ts` 「A/CASE-01..25 × spec 用例逐条跨验」 | ✅ 已有 | ☐ |

## 2. 写计划不变量（INV-01..12）

| §9 契约 | 自动化测试（packages/core/test/ownership-invariants.ts） | 真机脚本用例 | 状态 | 勾选 |
|---|---|---|---|---|
| INV-1 唯一 winner | 「INV-01 唯一 winner…」 | —（纯函数层） | ✅ | ☐ |
| INV-2 口型禁区 | 「INV-02 口型禁区…」 | U3 口型红线（任何通道 400） | ✅ + ⬜ | ☐ |
| INV-3 物理输出仅 limb-owned 可写 | 「INV-03 物理输出仅 limb-owned…」 | U1（own 路径）/ 守卫 `物理输出未 own 不可写`（guards.mjs） | ✅ + ⬜ | ☐ |
| INV-4 独占期 physics 不写、owner 胜出 | 「INV-04 独占期间 physics 不产生写入…」 | U1 acquire→post 覆盖 | ✅ + ⬜ | ☐ |
| INV-5 expiresAt 超时兜底 | 「INV-05 expiresAt <= now…」 | U2 release 回物理（durationMs 到期路径） | ✅ + ⬜ | ☐ |
| INV-6 优先级/source 秩/last-write-wins | 「INV-6 同参多 intent…」 | —（纯函数层；真机由 U6 间接覆盖） | ✅ | ☐ |
| INV-7 相位规则（Hip* pre / 叶子 post） | 「INV-7 相位规则…」 | U5 Hip pre 让位（wrong-phase 必须不出现） | ✅ + ⬜ | ☐ |
| INV-8 输出顺序无关 | 「INV-8 输出与 intents 顺序无关…」 | —（纯函数层） | ✅ | ☐ |
| INV-9 数值有限 + bounds 钳制 | 「INV-9 数值必须有限…」 | —（渲染端钳制，人工项 H1 目视） | ✅ | ☐ |
| INV-10 knownParams 白名单 | 「INV-10 knownParams 提供时…」 | U4 未索引组拒绝（同语义的组级白名单） | ✅ + ⬜ | ☐ |
| INV-11 空帧无副作用 | 「INV-11 空帧无副作用…」 | —（纯函数层） | ✅ | ☐ |
| INV-12 limb flag 关 = 现行为 | 「INV-12 limb 功能关闭…」+「feature flag：M1_DEFAULT_ENABLED=false…」 | m1-smoke 开关组：`--m1-flag off` 时 M1 组整组 SKIP、基线与 run.mjs 一致 | ✅ + ⬜ | ☐ |

## 3. 状态层（LimbController，Ownership-Invariants §4）

| §9 契约 | 自动化测试（packages/core/test/ownership-invariants.ts） | 真机脚本用例 | 状态 | 勾选 |
|---|---|---|---|---|
| S-01 acquire → release → 物理恢复 | 「S-01 acquire → 同一 runId release…」 | U1 + U2（acquire 覆盖 → 释放回物理） | ✅ + ⬜ | ☐ |
| S-02/S-03 ActGate 终态即释放 | 「S-02/S-03 ActGate 终态（interrupted / action-done）…」 | 🔶 待真机打断用例（依赖 m1-gesture 的仲裁回执，接 U6 后补） | ✅ + 🔶 | ☐ |
| S-04 FORCE 抢占 NORMAL | 「S-04 FORCE 抢占 NORMAL…」 | 🔶 集成日人工验证（FORCE 动作抢占 limb 独占） | ✅ + ⬜ | ☐ |
| S-05 超时兜底 | 「S-05 超时兜底…」 | U2（durationMs 到期自动释放） | ✅ + ⬜ | ☐ |
| S-06 acquire/release 1000 次无泄漏 | 「S-06 反复 acquire/release 1000 次无泄漏…」 | —（纯逻辑层） | ✅ | ☐ |
| LimbControlLike 形状对齐 | 「形状对齐：LimbController 结构化满足渲染侧 LimbControlLike…」 | —（类型层） | ✅ | ☐ |
| R10b own 只登记物理输出 | core「R10b：isOwnable 谓词过滤…」+ `host-guard.test.mjs`（own-ignored）+ `param-guards-core-sync.test.mjs` | 真机回执 `ignored`/`own-ignored-non-physical` 可见（集成日人工确认） | ✅ + ⬜ | ☐ |
| 联调（controller → resolveWritePlan） | 「联调：controller ownershipSnapshot + limb intent…」 | U1 | ✅ + ⬜ | ☐ |

## 4. 三层守卫统一（WS-3 / M1-d）

| §9 契约 | 自动化测试 | 真机脚本用例 | 状态 | 勾选 |
|---|---|---|---|---|
| 口型任何通道 400 | `param-guards.test.mjs` + `host-guard.test.mjs` + `validate.test.mjs`（MCP）+ `host-guard-act.test.mjs` | U3（set_parameters / keyframes 双通道）+ guards.mjs「口型红线」两条 | ✅ + ⬜ | ☐ |
| 未索引表情 400 | `host-guard.test.mjs`（unknown-expression） | guards.mjs「未索引表情被拒」 | ✅ + ⬜ | ☐ |
| 未索引动作组 400 | `host-guard.test.mjs`（unknown-motion-group / idle-not-playable） | U4 + guards.mjs「Idle 不允许手动播」 | ✅ + ⬜ | ☐ |
| 物理输出未 own 400 | `param-guards.test.mjs` + `host-guard.test.mjs` | guards.mjs「物理输出未 own 不可写」 | ✅ + ⬜ | ☐ |
| 未知工具/缺 name/跨站 Origin | `host-guard.test.mjs` | guards.mjs 后三条 | ✅ + ⬜ | ☐ |
| l2d_act 链静态校验（口型/结构） | `host-guard-act.test.mjs` | 🔶 真机 Invalid-chain 探测（集成日补） | ✅ + 🔶 | ☐ |

## 5. 集成快照（固定帧序列，Ownership-Invariants §5）

| §9 契约 | 载体 | 状态 | 勾选 |
|---|---|---|---|
| 0-10 帧无 acquire：四肢物理驱动（基线轨迹） | 🔶 渲染层集成快照测试（WS-2 交付后接 `readParameters` 快照） | 🔶 待交付 | ☐ |
| 第 11 帧 acquire → RArm 恒 0.8 ×5 帧 | 同上 | 🔶 待交付 | ☐ |
| 第 16 帧 release → 回物理轨迹（与基线同相位） | 同上 | 🔶 待交付 | ☐ |
| 第 20 帧 FORCE 抢占 → limb 释放、动作曲线生效 | 同上 | 🔶 待交付 | ☐ |
| HipAngleX 场景：裙摆参数随 Agent 值变化（M1-b） | 🔶 m1-hip 交付后接快照 + 真机 U5 | 🔶 待交付 | ☐ |
| 对照：口型参数任何帧不出现在快照变化里 | 同上（快照断言） + U3 | 🔶 待交付 | ☐ |

## 6. 回归门禁

| §9 契约 | 载体 | 状态 | 勾选 |
|---|---|---|---|
| `pnpm test:core` 全绿 | package.json `test:core`（含 §1-§4 全部测试文件） | ✅ 已有 | ☐ |
| `tools/dev-server` overlay-test 冒烟 | `tools/dev-server/`（人工起服目视） | ⬜ 需人工 | ☐ |
| 真机验收 run.mjs 9 项 + guards.mjs 9 项 | `tools/acceptance/run.mjs` / `guards.mjs`（F 项已同步 56） | ⬜ 集成日执行 | ☐ |
| m1-smoke 基线（flag off = 回滚验收） | `tools/acceptance/m1-smoke.mjs` T0-T3 + 开关组 | ✅ 脚本已交付 · ⬜ 真机执行 | ☐ |
| m1-smoke M1 组（flag on + allow-write） | U1-U4（自动化）· U5（--m1-hip）· U6（--m1-gesture） | 🔶 占位待交付 · ⬜ 集成日执行 | ☐ |

## 7. 人工项（m1-smoke H 系列，永远列出不拉低 verdict）

| 编号 | 内容 | 触发时机 | 勾选 |
|---|---|---|---|
| H1 | 待机四肢由物理驱动（呼吸/物理摆动目视，RArm/LArm 数值漂移） | 任何批次合入后 | ☐ |
| H2 | 现有动作/姿势/表情回归目视（M1-c 仲裁合入后的既有行为） | M1-c 合入后 | ☐ |
| H3 | 裙摆/腿链随 Agent 值动（M1-b Hip* pre 让位后次级链跟随） | M1-b 合入后 | ☐ |
| H4 | 写路径真用例（U1/U2/U5 + guards 全量）由 team-lead 在合并后代码上执行 | 集成日 | ☐ |

## 8. 覆盖统计（截至本文档创建）

- **§9 契约条目 → 映射覆盖**：INV-01..12 全部 12 条有自动化测试；其中 6 条另有真机脚本用例（U1-U5 + 开关组）。
- **状态层 S-01..06**：6/6 有自动化测试；2 条（S-02/S-03 真机打断、S-04 真机抢占）待集成日真机补验。
- **守卫红线**：口型 / 未索引 / 物理 own / 工具面 4 类均有单测 + 真机用例（U3/U4 + guards.mjs）。
- **集成快照 §5 的 6 个场景**：0/6 已自动化（🔶 待 WS-2/m1-hip 交付后接 `readParameters` 快照测试），真机侧由 U1/U2/U5 部分代理。
- **人工项**：H1-H4 四项，均已在 m1-smoke 输出中常驻可见。
- **m1-smoke 用例清单**：基线 T0-T4（GET 只读）· M1 组 U1-U6（写路径，`--allow-write` 门控）· 人工 H1-H3。
  脚本质量：mock 自测全路径（PASS/SKIP/FAIL）+ `node --check` 通过；无真机时 `--selftest` exit 0。
