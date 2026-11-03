# M1-F2 独立验收报告（qa-f2 / GLM 域）

- **Task ID**：F2-T01…T15 矩阵 + 对抗性检查（EmbodiedCue 闭环接线）
- **验收主导者**：qa-f2（独立验收，GLM 域）
- **被测基线**：`feat/m1-d2-gesture-wiring` @ `d0669a1`（工作区含未提交改动，见风险 R2）
- **验收时间**：2026-11-04
- **验收方式**：独立脚本直调生产模块 + 完整 `test:core` + `m1-smoke --selftest` + dev-server `5300` 真机 + `3081` 只读探测
- **生产代码改动**：**无**。本报告是本次唯一写入的文件；未执行 git commit/push。
- **总体验收状态**：**PASS_WITH_WARNINGS**（功能矩阵通过；但有 1 项 HIGH 级共享准入缺陷，**不建议在修复前把 cue/timeline 默认打开**）

> 证据强度说明：本报告不把“单测通过”当作唯一证据。T01/T02/T03/T04/T05/T08/T09/T10 由独立脚本直调生产模块复跑；T06/T07/T08/T15 在 dev-server 5300 真机复验；T11 以租约单测 + 3081 在线只读探测交叉验证；T12/T13 用 readiness 分类 + smoke 自测；T14 用 HEAD 源码/产物静态核对 + bridge 独立复跑。

---

## 一、15 项矩阵状态表

| 项 | 验收内容 | 状态 | 独立证据 |
|---|---|---|---|
| F2-T01 | 合法 cue 编译 → 有效段/写值目标 | **PASS** | 独立脚本：`tilt hold 0.5` → `segments=[cue:tilt:hold]`、`group=cue:tilt`、`params={AngleZ:7.5}`、`rejected=[]`；账本 `cueWrites` 同为 `{AngleZ:7.5}`。与 `cue-loop.ts` F2-T01 用例一致。 |
| F2-T02 | 未知语义词 → 明确拒绝零动作 | **PASS** | 独立脚本：`wink`/`nod` → `unknown-channel`；`spin` → `unknown-operation`；四产物（segments/sharedUses/stops/overlays）全空，`commitCue` 返回原 state 引用，零副作用。 |
| F2-T03 | 缺失模型参数 → 拒绝或受控降级 | **PASS_WITH_WARNINGS** | 独立脚本用自定义词表绑定 `ParamNotExistXYZ`：准入 `accepted=true`（编译层无模型清单）；每帧 `writeParam` 返回 false → `applied=[]`、`skipped=[ParamNotExistXYZ]`，不崩溃、不写值。**但回执 `writes` 仍包含该参数，调用方可能误以为已生效**（见 M2）。 |
| F2-T04 | 同通道连续动作 → 新替换旧 | **PASS** | 独立脚本：同 channel 两次 hold → 账本 1 槽、写值为后者 `AngleZ=-4.5`；真实 `enqueueGesture` 同 id 第二段替换第一段（`segments=1`，`interrupted=[cue:tilt:hold]`）。 |
| F2-T05 | 不同通道并行 → 两者共存 | **PASS** | 独立脚本：tilt+gaze+lean 三通道并存，单帧写 `AngleZ/LeanInput/ParamEyeBallX/ParamEyeBallY` 四个参数，`conflicts=[]`；真机重复 cue 测试期间 `diag.cue.channels` 同时含 `tilt`+`lean`。 |
| F2-T06 | overlay 动作 → 仅允许规则下叠加 | **PASS** | 真机 5300（真实表情名）：`兔牙` 打开 → `diag.cue.overlay.name=兔牙`；`圈圈眼` 替换为单槽；`happy` → `ok:false / unknown-overlay` 且当前表情保持 `圈圈眼`。独立脚本另验 `setExpression=false` 时拒整条、零落账。 |
| F2-T07 | Agent 打断 gesture → 停写 | **PASS_WITH_WARNINGS** | 真机 5300：cue `lean` 持有中发 `l2d_act`（NORMAL）→ 回执 accepted，随后 `diag.cue.channels=[]`，下一帧零写值；代码路径 `index.ts:619-629` 在 act 准入成功后 `cueBridge.stop()`。**但 act 运行期间的优先级门闩失效**（见 H1），与本项的“开始即打断”是两回事。 |
| F2-T08 | gesture 自然到期 → 释放 | **PASS** | 真机 U10：`tilt hold 0.5/1500ms` 持有期 `diag.cue` 含 tilt，2s 后不含；独立脚本：`1499ms` 仍写 `AngleZ=7.5`，`1500ms` 起 `writes={}`、`expiredChannels=[tilt]`，后续 tick 不复活。 |
| F2-T09 | 重复同一 cue ID → 不重复执行 | **PASS_WITH_WARNINGS** | 真机 5300：同 channel 同值连发两次 → `diag.cue.channels=["tilt"]`（单槽，不叠加）。独立脚本：时间线同 id 第二段替换第一段，写值不翻倍。**但 EmbodiedCue 本身无 cueId，重复 overlay 会再次 `setExpression`，没有基于 ID 的幂等去重**（见 L2）。 |
| F2-T10 | 释放后物理接管（静态+环境限制） | **PASS_WITH_WARNINGS** | 独立脚本用自定义词表 `arm→RArm`：准入先 `own`，`tick` 写入，到期 `release`；`injector.release` 同时清 ownership+sticky（`param-injector.ts:130-134`），下一帧物理可拿回。**种子五通道均非物理输出，该场景只能靠自定义词表触达；无 Cubism 真机物理验证**（见 L3）。 |
| F2-T11 | 消费者切换 fencing | **PASS_WITH_WARNINGS** | `ai-inbox.test.mjs` T1 双消费者竞争、T2 接管、T3 旧 epoch 回执拒绝、T4 接管后旧任务 `lease-taken-over`、T5 token 优先于 epoch、T9 双页不互踩全过；3081 在线（`/dsh-l2d/ai/poll` 200，返回活跃租约 holder）。**未在 3081 主动驱动接管**，避免影响正在消费的页面（见 R5）。 |
| F2-T12 | 模型未就绪时 smoke | **PASS** | 独立调用 `classifyReadiness`：L1 无回执→`NO-CONSUMER`、L1 通但 `ready=false`→`MODEL-LOADING`，均 exit 3 不进场；`m1-smoke --selftest` 第 7/8 组 PASS（BLOCKED/上限轮询/转正放行）。 |
| F2-T13 | 模型就绪时 smoke | **PASS** | `classifyReadiness` 三层全绿→`READY`；对 dev-server 5300 实跑 readiness：`READY · 1 轮 · 676ms`，随后 U7/U8/U9/U10/U11 全 PASS。 |
| F2-T14 | flag 关 → 零变化 | **PASS** | HEAD `d0669a1` 源码与产物均为 `embodied.timeline=false`/`embodied.cue=false`（`motion-adapter.ts:170-177`、bundle 中 `!1`）；独立复跑 bridge `enabled=false`：准入 `disabled`、不编译/不入队/不写值/不碰表情、tick 空回执。 |
| F2-T15 | flag 开 → 功能生效 | **PASS_WITH_WARNINGS** | dev-server 5300（工作区 flag-on 包）真机 U7-U11 PASS，证明开关链路有效；组合表达式 `CUE_ENABLED = cue && timeline` 正确（`index.ts:547-548`），仅一方为 true 时整体 disabled。**但该 flag-on 构建来自未提交工作区改动，HEAD 本身不可复现**（见 R2）。 |

**矩阵结论**：15/15 项没有 FAIL；13 项 PASS，4 项带警告（T03/T07/T09/T10/T11/T15 中的警告均为可解释的实现边界或环境限制，不改变功能结论）。

---

## 二、对抗性检查发现（按严重度）

### H1（HIGH，阻塞默认开启）ActGate 优先级双查在真机/生产形态下失效

**结论**：`admitCue` 确实调用了 `admitGesture`，`admitGesture` 也读取了 `currentAct()`，但 `currentAct().priority` 在生产中是**字符串** `'NORMAL'`，而 `gesture-bridge.ts` 按**数字**比较，导致该分支永远不拦截。

证据链：

1. `packages/core/src/action-chain.ts:206-212`：`ActiveAct.priority: ActPriority`（`'BACKGROUND' | 'NORMAL' | 'FORCE'`，字符串）。
2. `packages/renderer/src/app/gesture-bridge.ts:96-97`：依赖声明为 `currentAct?(): { priority: number } | null`。
3. `packages/renderer/src/index.ts:534`：`currentAct: () => actGate.current()` —— 把字符串 priority 直接塞进数字接口。
4. `packages/renderer/src/app/gesture-bridge.ts:223`：`if (cur && batchRank <= cur.priority)` —— `50 <= 'NORMAL'` 为 false，门闩不生效。
5. TypeScript 实证：`tsc` 报 `index.ts(534,3): error TS2322: Type '() => ActiveAct | null' is not assignable to type '() => { priority: number; } | null'`；但 `tools/typecheck-smoke.mjs` 只门禁 `Cannot find name`，该错误被放行。
6. 运行时实证：同一 cue 段在 `currentAct().priority='NORMAL'` 时 `admitted=true`，在 `priority=50` 时正确返回 `priority-blocked`。
7. 真机实证：dev-server 5300 上 `l2d_act` 启动后，每 150ms 发一次 `l2d_cue`（priority 50），连续 3s **全部 accepted**；同参数 `l2d_play_keyframes` 也不被 ActGate 拒绝（U8 通过的是 injector 独占屏障，不是 ActGate）。

**影响**：Agent 动作链运行期间，cue/gesture 可以继续抢占同一参数域（H1 同时影响 d2 的 gesture 准入）；`admitAct` 只在新 act 开始时清一次账本，无法阻止 act 进行中后来到达的 cue。与文档宣称的“ActGate + injector 双查”不符。种子 cue 默认 priority 50，正好等于 NORMAL。

**定级理由**：F2 代码没有引入该类型不匹配（d2 已存在），但 F2 的验收结论把“双查”当作事实，且 cue 默认开启后会放大影响。**建议默认开启前修复**：在 `index.ts:534` 传 `{ priority: ACT_PRIORITY_RANK[act.priority] }`，或让 gesture-bridge 接收 ActPriority 并自行映射；补一条字符串 priority 的回归用例。

### R2（HIGH，验收完整性/可复现性）HEAD 与真机被测构建不一致

`git status` 显示工作区未提交改动：

- `packages/renderer/src/app/motion-adapter.ts`：`embodied.timeline` / `embodied.cue` 由 `false` 改为 `true`；
- `packages/dsh-l2d-plugin/assets/renderer.js`：bundle 中两 flag 同步为 `!0`。

而 `git show HEAD` 的源码与 bundle 均为 `false`/`!1`。dev-server 5300 服务的是工作区 bundle，因此：

- U10/U11 真机 PASS **无法在干净 checkout 的 d0669a1 上复现**；
- 若该改动被误提交，生产默认行为将从“零变化”变成 cue/timeline 默认开启；
- 若被清理回 HEAD，本轮真机证据即失效（U10/U11 会走 `cue-disabled`/SKIP）。

**建议**：把“验收用 flag-on 构建”固化到独立分支/脚本（构建时注入 flag），不要留在主工作区；验收报告必须记录被测 bundle 的 hash/来源。该改动不是本 QA 引入的（进场前已存在）。

### M1（MEDIUM，契约与实现不一致）overlay 的 `sharedUses` 未接线

`compileEmbodiedCue` 为 overlay 产出 `sharedUses`（`embodied-cue.ts:244-251`），但 `cue-bridge.ts` 全文件**从未读取** `preview.compiled.sharedUses`；全仓生产代码也没有 `arbitrateShared` 调用点。当前表情互斥只靠 Cubism 单槽 `setExpression` + `knownOverlays`，没有进入共享通道仲裁。

**影响**：cue overlay 与其他表情消费者（emote、`l2d_set_expression`、动作表情）之间没有仲裁，只有“后写覆盖”；`docs/M1-F2-VOCAB-VERIFICATION.md` 与文件头注释中的 “sharedUses → arbitrateShared” 目前是未兑现的声明。

**建议**：要么接线 `arbitrateShared`，要么在 v1 文档明确“overlay 不进共享仲裁”，避免验收误判。

### M2（MEDIUM，回执语义）T03 缺失参数只在写值期 skipped，准入回执仍报成功

自定义词表绑定不存在参数时：`admitCue` 返回 `accepted=true` 且 `writes` 含该参数，只有 `tick` 的 `skipped` 反映失败。Agent 若只看 `l2d_cue` 回执会误以为已生效。

**建议**：准入期用模型参数清单做存在性校验（或把 `skipped` 提升为回执字段/状态），至少让 `l2d_cue` 回执能区分“已受理但未写入”。

### L1（LOW，升级顺序）旧 overlay 收到 `l2d_cue` 会落入 `l2d_posture` 默认分支

- 新 overlay + 旧 renderer：`overlay.js:3990` 明确返回 `not-supported`，符合预期（静态核对）。
- 旧 overlay（`f4a2f22^`）+ 新动作：旧文件没有 `l2d_cue` 分支，`default:` 与 `case 'l2d_posture'` 共用分支；若画像已加载且 `values` 为空，会返回 `{ok:true, applied:[]}`，**存在误判成功的路径**（`git show f4a2f22^:...overlay.js` 的 default 分支）。

**建议**：宿主在暴露 `l2d_cue` 前做版本探测；overlay 的 `default` 应返回 `unknown-tool`，不要落到 posture。此为存量问题，但新工具入口会放大暴露面。

### L2（LOW，幂等）没有 cueId 级去重

`EmbodiedCue` 无 `id` 字段；重复投递同一 cue 靠 channel 单槽/时间线同 id 实现“结果幂等”，但每次都会重走准入；重复 overlay 会重复调用 `setExpression`。功能上不叠加，不构成错误，但“重复同一 cue ID 不重复执行”严格说不成立（没有 ID 概念）。

### L3（LOW，覆盖缺口）物理接管仅有推导，无真机

种子五通道（AngleZ/AngleY/AngleX/LeanInput/ParamEyeBallX/Y）都不是物理输出；T10 的 own→write→release 链路只在自定义词表 + mock 下验证。另：长期持有物理 cue 的 own TTL 为 24h（`cue-bridge.ts:46`），超过 24h 后 ownership 自动过期而账本仍持有，后续写入会被 injector 以“物理输出未授权”拒绝且不会自动重新 own —— 属于未覆盖的长稳边缘。

---

## 三、对 Chief 真机结论的独立可信度评估

Chief 的结论是「dev-server 通道 U7-U11 全 PASS；T1/T2/U3/U4 为 dev-server 缺宿主路由/设置页/host-guard 的环境差异」。本 QA 的独立复核：

| Chief 结论 | 独立复核 | 评级 |
|---|---|---|
| U7/U8/U9/U10/U11 全 PASS | 在 5300 实跑同命令，5/5 PASS，回执与 diag 细节一致（U10 持有期含 tilt、2s 后释放；U11 unknown-channel/not-interruptible 零写值） | **可信（A）** |
| T1/T2 是 dev-server 缺宿主路由/设置页 | 5300 对 `/`、设置页路由返回 404；`m1-smoke` 同跑 T1/T2 FAIL，原因一致 | **可信（A）** |
| U3/U4 是 dev-server 缺 host-guard | `tools/dev-server/index.mjs` 未引入 `host-guard.mjs`；U3 口型/`l2d_play_keyframes` 与 U4 未索引组守卫在 dev-server 无宿主侧拦截，故 200 而非 400 | **可信（B+，代码证据充分，未在 3081 写入复验）** |
| “真机验证完成”的整体表述 | U7-U11 可复现；但被测 bundle 是未提交的 flag-on 构建（R2），不是 d0669a1 的干净产物 | **需限定条件（B）** |

**综合**：Chief 对“cue 链路在 dev-server 上可用”的判断**可信且可复现**；对 T1/T2/U3/U4 的“环境差异”归因**基本可信**，但严格证明需要在宿主 3081 上跑写路径用例（本轮为避免影响在线页面未执行）。**不能**据此推断“d0669a1 干净检出即默认具备 cue 能力”——默认 flag 仍为关，且 R2 的构建来源必须记录。

---

## 四、执行过的命令与关键结果

```text
# 1) 完整回归（工作区，flag-on 未提交构建）
pnpm test:core
  → exit 0；cue 相关：embodied-cue 12 / cue-loop 15 / cue-bridge 17，全绿；
    gesture-bridge 14 / gesture-vocab 7 / 其余链无回退

# 2) 类型门禁（注意：只门禁 Cannot find name）
node tools/typecheck-smoke.mjs
  → PASS（Cannot find name 违规 0；其它预存错误 651 条不计入门禁）
  → 单独 tsc 暴露 index.ts(534) TS2322（H1）

# 3) overlay 语法
node --check packages/dsh-l2d-plugin/lib/overlay.js → OK

# 4) 独立脚本（不写仓，直调生产模块）
node --experimental-strip-types D:/tmp/qa-f2-verify.mjs
  → T01/T02/T04/T05/T06/T07/T08/T12/T13/T14 PASS；
    T03/T09/T10/T15 PASS_WITH_WARNINGS；账本 100 轮压力：峰值 1、结束 0；到期后 3 次 tick 零写值

# 5) smoke 自测
node tools/acceptance/m1-smoke.mjs --selftest
  → 全部断言通过；mock flag-on 组 U10/U11 PASS；flag-off 组整组 SKIP；就绪 BLOCKED/MODEL-LOADING 路径 PASS

# 6) dev-server 真机（5300）
node tools/acceptance/m1-smoke.mjs --origin http://127.0.0.1:5300 \
  --m1-flag on --allow-write --m1-cue --m1-gesture --readiness-wait 15000
  → READY 676ms；U7/U8/U9/U10/U11 PASS；T1/T2 404、U3/U4 200（dev-server 无宿主守卫）
  → 7 PASS · 7 SKIP · 4 FAIL（FAIL 均为 dev-server 宿主差异）

# 7) 真机补充（5300，独立脚本）
- 重复 cue：diag.cue.channels=["tilt"]（单槽）
- overlay：兔牙 → 圈圈眼（单槽替换）；happy → unknown-overlay 且保留当前层
- Agent act：cue 持有中 l2d_act → diag.cue.channels=[]（开始即清）
- ActGate 对抗：act 运行中连续 3s 发 cue priority 50 → 全部 accepted（H1）

# 8) 3081 只读探测
GET /dsh-l2d/ai/result?id=0 → 200
GET /dsh-l2d/ai/poll（无 consumer）→ lease.status=held, holder=c-6ab7…（活跃消费者在线）
```

---

## 五、遗留风险与合并建议

1. **H1 必须在默认开启前修复**：否则 Agent act 运行中 cue 仍可写身体参数，和“Agent 占用时 cue 让位”的契约冲突。修复成本低（一行映射 + 一条回归用例）。
2. **R2 必须收口**：把 flag-on 验收构建的来源固定下来；主工作区不要长期保留未提交的生产 flag 改动。建议在 CI/验收脚本里显式构建 flag-on 包，并在报告中记录 bundle hash。
3. **M1 要么接线要么改宣称**：`sharedUses` 当前是死产物；如果 v1 不打算接共享仲裁，应删除相关注释/文档承诺，避免后续验收误判。
4. **M2 回执语义**：缺失模型参数应在准入期拒绝或至少在回执中标记，避免“accepted 但永远写不进”。
5. **L1 升级顺序**：先升级 overlay 再暴露 `l2d_cue`；旧 overlay 的 default 落到 posture 是存量隐患。
6. **长稳**：建议补 30min 以上持续 hold/overlay 浸泡与 1000 次 admit/expire 真机压力；当前只有 100 轮纯逻辑压力。
7. **物理通道**：种子词表没有物理输出，T10 的“物理接管”在真机上不可达；若后续词表扩展到物理参数，需单独验收 own TTL/释放时序。
8. **3081 写入验证**：本轮只做了 3081 只读探测；如要对宿主侧 U3/U4 下最终结论，需在可接受的维护窗口执行写路径用例。探测过程中曾用 `consumer=qa-f2-probe` 做了一次 poll（队列为空，随后 holder 恢复为 `c-6ab7…`），未投递接管回执测试；未观察到在途任务受影响，但应在报告中如实记录该次租约轮换。

---

## 六、最终裁定

- **F2 功能矩阵**：T01-T15 无 FAIL；核心闭环（编译→准入→账本→帧写值→到期/clear/overlay）在纯逻辑与 dev-server 真机均成立。
- **代码红线**：cue 写值已统一走 `injector.applyNow`，全仓 grep 未发现 cue 路径直接 `setParameterValueById` 的残留；口型/物理/真实下标/钳制守卫复用完整。
- **共享准入**：ActGate 双查存在 H1 级类型不匹配，实际不拦截；injector 独占屏障仍有效。
- **验收状态**：**PASS_WITH_WARNINGS**。
- **发布建议**：允许以 **flag 默认关** 的形态合并；**默认开启（flag=true）前必须修复 H1 并完成 R2 的构建来源收口**。
