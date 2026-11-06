# DSH-L2D 通宵工程总报告（09:00 前终版）

> 时间窗：2026-11-04 02:52 → 07:50 · 编排：dsh-l2d-team（前端 DSV4.1f / 后端 MiMo / 模型调试 GLM / 验收 GLM）
> 本轮性质：M1-d1 复核 → F2 闭环 → Whale Workspace → M1-g（G0/G1/G2）

## 一、交付总表

| 批次 | 分支 | HEAD | 状态 |
|---|---|---|---|
| M1-d1 Hip 语义 + PRE 相位 | `feat/m1-batch2` | 2002ba4 | PASS（QA 独立复核 + 真机证据链） |
| M1-d2 Gesture 接线 + P2 收口 | `feat/m1-d2-gesture-wiring` | 87b748f / 38052bc / 05f5bc2 | 门禁绿；真页面 U7-U9 PASS |
| M1-d3 消费者租约 + fencing | `feat/m1-d3-consumer-lease` | 484f480 | PASS（真机双消费者 6 项实测全过） |
| M1-f 第一批 Cue 编译层 | `feat/m1-f-cue-compiler` | ea18423 | PASS |
| **M1-f 第二批 Cue 闭环** | `feat/m1-f2-behavior-loop` | **d71a431**（含 H1 修复 + PR19 + G0） | **PASS**：275 断言、真机 U7-U11 全过 |
| README 双语化 | `feat/m1-batch2` | 3eaaa5d | 完成（默认中文，锚点切换） |
| Whale Workspace 双向切换 | `feat/whale-workspace` | 0153135 | 9 PASS + 1 部分 BLOCKED（MOCK 边界显式） |
| M1-g G0 物理/骨架审计 | `feat/m1-d2-gesture-wiring` | d71a431 | PASS（685 行，Chief 独立复核数字） |
| M1-g G1 单肢安全接管 | `feat/m1-g1-limb-ownership` | 275d1e0 | 数值 PASS / **视觉 BLOCKED** |
| M1-g G2 部位规划器 | `feat/m1-g2-limb-planner` | 见推送 | PASS（20 用例，纯函数，红线自检 0） |

## 二、本轮最重要的三个技术结论

### 1. Cue 闭环成立，但必须经 injector（H1 教训）
`EmbodiedCue → compile(fail-closed) → cueBridge.admit（口型/物理双前置）→ enqueueGesture（唯一冲突闸）→ injector.applyNow(set) → Cubism`。
初版曾直接写 Cubism 被 Chief 拦截（第二套写入机制）；修复后真机 U10/U11 全过。
**另一个真实缺陷（QA 发现）**：ActGate 的 `ActiveAct.priority` 是枚举名，`50 <= 'NORMAL'` 恒 false → 双查静默失效（d2 起就存在）。已修 + 真机复验（act 运行中同级 cue 被 priority-blocked）。

### 2. 手臂是两条互不相交的通道（G1 判定实验，改变 G2 设计）
| 通道 | 参数 | 可 own | 谁在写 |
|---|---|---|---|
| 姿态层 | 右 Param36/39/40/41/43 · 左 Param59/60/61/62 | ❌（非物理输出） | 真实动作写这里 |
| 物理输出层 | RArm 族 15×2 | ✅ | 物理每帧写 |

真机数据：写整套姿态 → RArm 落回基线噪声（0.06~0.09）；own 后 → RArm 钉死 0.6000（极差 0）。
**⇒「让手臂动」= 写姿态层（不需要 own）；「防抢」= 仅直写输出时 own。G2 planner 因此以姿态域为主战场。**

### 3. 头/躯干只能走根输入
Drag 400 写 `ParamAngle*` 随即被物理 600 整值覆盖——拖拽对头/躯干实际无效；头只能 `AngleX/Y/Z`，躯干只能 `PositionX/Y/Z + LeanInput`。任何"独占头部"的实现会撕裂 52 个下游输出。

## 三、验收状态（严格口径）

| 项 | 状态 | 证据 |
|---|---|---|
| 单元/契约测试 | **PASS** | test:core 295 断言（F2 275 + G2 20）· types PASS · build PASS · selftest 53 |
| 真机（dev-server 通道，真模型） | **PASS** | U7/U8/U9（gesture）+ U10/U11（cue）+ G1 pv 表（own→0.6000/极差 0；release→回物理） |
| 真机（宿主页 3081 写路径） | **BLOCKED** | 模型挂载超时；二分证明非代码回归（pre-d2 同样）；readiness 门禁已固化，不再产生假 FAIL |
| **G1 视觉验收（手臂是否可见地动）** | **BLOCKED** | 无可用渲染面：5300 overlay 渲染碎片、宿主页模型超时 → 需用户侧正常页面 |
| M1-g G2 | PASS（纯函数） | 20 用例 + 红线扫描（无参数名/无 DOM/无直写） |
| Whale 真窗口恢复（用例 4 后半） | BLOCKED | 内存服务无持久化，需宿主持久层 |

## 四、分支依赖与合并顺序

```
feat/m1-batch2 (3eaaa5d, d1+README)
 ├─ feat/m1-d2-gesture-wiring (d71a431 = d2 + H1 + PR19 + G0 审计)
 │   ├─ feat/m1-d3-consumer-lease (484f480)
 │   ├─ feat/m1-f2-behavior-loop (d71a431, = d2 线 + F2)
 │   ├─ feat/m1-g1-limb-ownership (275d1e0)
 │   └─ feat/m1-g2-limb-planner (G1 + G2)
 └─ feat/whale-workspace (0153135, 独立)
```
合并顺序：d2 → batch2 → d3 → F2 → G1 → G2；Whale 独立 PR。
**未执行自动合并**（按任务书 §六：先准备、待审查）。冲突面已知：package.json test:core 链（并集）、lib/index.js 与 overlay.js（若并入 bot 团队的 `feat/workspace-action-protocol`，3 处冲突已定位）。

## 五、遗留与下一步

| 优先 | 事项 | 说明 |
|---|---|---|
| P0 | G1 视觉验收 | 需一个能正常渲染的页面；验收命令 `build-flagon --limb --keep` + `limb-channel-probe.mjs` |
| P0 | 宿主页模型挂载延迟归因 | 与 bot DSH 并存相关；建议在其关闭窗口期复测 |
| P1 | G3 动作库左右变体 | 需目视标定方向（tilt/pitch/yaw 符号 + 手臂姿态） |
| P1 | M1/M2（QA MEDIUM） | compile 的 sharedUses 未被 cue-bridge 消费；缺失参数时回执 writes 仍含该参数 |
| P2 | G4 跨源调度 | G2 已指出关键前提：租约与时间线两账本的权威归属（action receipt 为唯一终点，timeline endAt 兜底） |
| P2 | Whale 接真实后端 | ConversationService 适配器；Electron IPC 替身 |

## 六、工程基建沉淀

- `tools/acceptance/readiness.mjs`：三层就绪门禁（L0 连通/L1 消费者/L2 模型），BLOCKED=exit 3
- `tools/acceptance/build-flagon.mjs`：可复现 flag-on 构建（`--limb` 只翻 limb），打印 bundle sha256
- `tools/gen-body-manifest.mjs`：physics3 → manifest 生成 + 漂移守卫（`--check`）
- `tools/acceptance/limb-channel-probe.mjs`：G1 通道判定实验可复跑脚本
- 经验：后台页签会节流 poll（38 轮 1 次响应）→ 验收前必须前台化
