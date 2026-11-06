# M1-g 工作分解与文件域分配（PR19 落实方案）

> 依据：`docs/M1-G-LIMB-ALLOCATION-ROADMAP.md`（PR19 / 01b85e8，Astra 提案）
> 编制：Chief · 2026-11-04 07:10 · 状态：执行计划（G0 已开工，G1/G2 待门禁）

## 一、阶段依赖（不可跳）

```
G0 物理/骨架审计（只读，零运行时改动）
  └─> 【门禁 A】物理输出边界证据被 Chief 冻结为 G0 manifest（canOwn 数据源）
        └─> G1 单肢安全接管（LimbController 接线，flag 默认关，仅手动显式单肢）
              └─> 【门禁 B】真机：acquire 右臂 → 左臂/头/躯干仍物理 → release 平滑恢复
                    └─> G2 规划器/求解器（纯函数，不含运行时接线）
                          └─> G3 动作库（左右变体，需目视标定）→ G4 跨源调度 → G5 真机长期验收
```

**并行边界（路线图明确允许）**：G0 审计期间，G1 只可做**设计**（接口/接线点/测试计划），不得接线启用；G2 只可准备纯函数接口草案，不得发明模型能力。

## 二、文件域分配（互斥，违反即冲突）

| 域 | 文件 | G0 | G1 | G2 |
|---|---|---|---|---|
| 审计产物 | `docs/M1-G-PHYSICS-RIG-AUDIT.md` | **唯一写者：audit-g0** | — | — |
| core 状态机 | `packages/core/src/limb-controller.ts` + test | 只读 | **impl-g1**（必要时扩展 canOwn/generation fencing） | 只读 |
| core 规划器 | `packages/core/src/limb-plan.ts`（新建） + test | — | — | **impl-g2**（纯函数） |
| renderer 接线 | `packages/renderer/src/index.ts`、`app/motion-adapter.ts`、`app/physics-gate.ts` | 只读 | **impl-g1**（唯一写者） | 只读 |
| 词表/动作库 | `packages/core/src/gesture-vocab.ts` | 只读 | 只读 | G3 才动（需标定） |
| 决策文档 | `docs/M1-G-WORK-BREAKDOWN.md` | Chief | Chief | Chief |

规则：同一文件在相邻阶段**串行**；G1 与 G2 若需同文件（预计不需要）→ 串行。

## 三、各阶段实施要点与验收

### G0（进行中）— audit-g0
六项交付（参数清单 / physics3 输出清单 / 部位→参数域映射 / 独立可控性证据 / 写入顺序图 / 未知清单）。
**门禁 A**：Chief 审核后冻结为 manifest，特别核对：
- physics 输出 id 精确集合（G1 的 canOwn 唯一数据源）
- 共用域清单（肩/躯干），任何共用域一律标"不可独立接管"
- 每个"独立可控"结论必须给代码路径证据，无证据 = UNKNOWN（fail-closed）

### G1 — impl-g1（G0 通过后）
1. renderer 生命周期实例化 LimbController（`enabled` 取 flag，默认关）
2. `canOwn` 由 G0 manifest 生成（不硬编码）；`clamp` 接模型 min/max
3. 只让位**精确独占域**；未请求部位物理照常（禁止整体关物理）
4. acquire 后证明物理写者在该域不再获胜；release 后平滑复位（无跳变、无残留租约）
5. cancel/timeout/失败/重复 release 幂等；旧 generation 回调被 fence
6. 不绕过 Gesture Admission / Timeline / ParamInjector（写值仍走 injector）
7. **验收**：真机 acquire 右臂 → 执行一个已标定右臂动作 → 左臂/头/躯干仍物理 → release 平滑恢复；重复 5 次无泄漏
8. 前置：H1/H3 目视仍 BLOCKED 时，G1 的"物理恢复观感"只能记 NOT TESTED，不得写 PASS

### G2 — impl-g2（G1 通过后）
- 新建 `packages/core/src/limb-plan.ts`：`SideConstraint`/`BehaviorSource`/`MotionRequest`/`AllocationDecision`（按路线图契约）
- 纯函数（无 DOM/Cubism/timer/网络）；10 条规则逐条用例（路线图 §Rules）
- 红线：planner/solver 不写参数、不绕过 admission、不整体关物理

### G3-G5
- G3 动作库：左右变体 + 目视标定（每词一个参数域原则不变）
- G4 跨源调度：Agent/Interaction/Autonomous 统一入口（复用现有 EnqueueGesture）
- G5 真机长期：中断/物理隔离/重复生命周期/共用域/持续运行

## 四、与既有成果的衔接

| 既有 | 关系 |
|---|---|
| F2 Cue 闭环（`admitCue`） | G2 planner 的**下游**：planner 决策 → cue/segment → admitCue；不替换 |
| LimbController（M1-a 骨架，未接线） | G1 直接接线对象；API 已含 acquire/release/snapshot/generation |
| PhysicsGate（M1-b，Hip pre 让位） | G1 复用其让位机制，不新建第二套 |
| H1 修复（ActGate 归一化） | G1 的优先级判定依赖它；已修并真机验证 |
| d3 租约 | 与本阶段正交（消费者层）；G1 的"generation fencing"是**动作层**同型思想 |

## 五、风险与回滚

| 风险 | 处置 |
|---|---|
| 共用域（肩部同时被手臂与躯干物理使用）导致接管污染躯干 | G0 必须给出共用域清单；G1 一律拒绝接管共用域（fail-closed） |
| 物理恢复跳变（观感） | G1 验收要求"平滑"，需目视；无法目视则记 NOT TESTED |
| 整体关物理（错误实现） | 红线：只让位精确域；测试断言其他部位物理正常 |
| LimbController 接线引入帧序问题 | 复用现有帧钩子位置（post，applyCueFrame 同区），不新增帧循环 |
| **回滚** | `M1_DEFAULT_ENABLED` 单 flag 关闭即可回到现行为；G1 改动集中在 3 文件可整体 revert |

## 六、当前状态

- G0：`audit-g0` 执行中（只读）
- G1/G2：仅设计允许，未派工（等门禁 A）
- PR19 已合入 `feat/m1-d2-gesture-wiring` / `feat/m1-f2-behavior-loop`（01b85e8）
