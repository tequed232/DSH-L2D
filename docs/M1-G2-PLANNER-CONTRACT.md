# M1-g / G2：部位规划器与分配求解器——契约冻结稿

> **状态**：G2 纯函数层已完成（**未接线**）。本文件冻结 `packages/core/src/limb-plan.ts` 的类型与语义，
> 供 G3（动作库）/ G4（跨源调度）/ G5（真机验收）作为唯一契约依据。
> **不声称**自动分配已生效：`M1G2_DEFAULT_ENABLED = false`，生产路径零引用。
> **分支**：`feat/m1-g2-limb-planner`（基于 `feat/m1-g1-limb-ownership`）
> **依据**：`docs/M1-G-LIMB-ALLOCATION-ROADMAP.md` §G2 / `docs/M1-G-PHYSICS-RIG-AUDIT.md` §3 §6 /
> `docs/M1-G-WORK-BREAKDOWN.md` §三 G2

---

## 0. 一句话结论

手臂的"分配"在**姿态参数域**上完成，不在物理输出域上完成。
规划器因此把每个选中的部位同时表达为 `poseDomain`（主战场，普通写）与可选 `physicsDomain`
（仅"直写输出"兜底）；两者语义不混同、参数集不相交（`CROSS_DOMAIN` 单列声明）。

## 1. 为什么主战场是姿态域（不是设计偏好，是 G1 判定实验的事实）

| 事实 | 证据 | 对规划器的后果 |
|---|---|---|
| 真实手臂动作写的是姿态层（右 5 个 / 左 4 个参数），**不是**物理输出 | `docs/M1-G-PHYSICS-RIG-AUDIT.md` §1.2、§0 结论 2 | 若只按物理输出分配，`canOwn` 对手臂动作返回**空集**，"独占手臂"本身不成立 |
| 手臂物理输出 15×2 个，可 own，但**链末端（0 下游）** | 审计 §0 结论 1、§3.1「下游输出数 = 0」 | 物理 own 只影响自己，**不会**污染其他部位（可安全作为兜底通道） |
| 手臂物理输出**静息增益≈0**：物理写只吸收一部分权重，静息时视觉几乎不动 | 审计 §4.2 边界条件 1–2、U3 | 单独 own 物理输出"回执漂亮、行为无变化"——即 G1 最大风险点（审计 §6.4-1） |
| 姿态层与物理输出的叠加方式（相加/相乘/独立 deformer）**未标定** | 审计 §4.4 / §6.2 U1 | 规划器**不得**假设两者等价：必须分开表达、分别预留 |
| `Param42` 型参数跨域（姿态 + 喂另一部位物理，权重 50） | 审计 §3.3 S4、§6.4-4 | 必须显式 ack 才可占用，且单独进 `crossDomain`，不混进 `poseDomain` |

因此：**规划器的产出单位是"参数域租约"，不是"部位标签"**。部位标签只是域的容器；
同一个部位标签下的两条通道必须能在决策里被区分，下游（G4/渲染层）才知道该走普通写还是 own。

## 2. 类型契约

```ts
type SideConstraint = 'left' | 'right' | 'both' | 'auto';
type BehaviorSource = 'agent' | 'interaction' | 'autonomous';

interface MotionRequest {
  executionId: string;
  generation: number;
  source: BehaviorSource;
  motionId: string;
  side: SideConstraint;
  priority: number;         // ActGate 惯例 10/50/90；同源内比较
  durationMs: number;       // > 0；到期只是兜底，主路径是显式 settle
  directOutput?: boolean;   // 缺省取能力条 directOutput，再缺省 false（= 只占姿态域）
  crossDomainAck?: boolean; // 跨域参数必须显式承认，否则 fail-closed
}
```

### 2.1 对路线图契约的两处扩展（均为例行化，不是发明能力）

1. `AllocationDecision.selectedParts` 由 `string[]` 扩展为 `SelectedPart[]`：

```ts
interface SelectedPart {
  partId: string;
  side?: 'left' | 'right';
  via: 'explicit' | 'auto-calibrated' | 'both';
  poseDomain: readonly string[];     // 姿态层（主战场，非物理输出，普通写）
  physicsDomain: readonly string[];  // 物理输出（仅直写输出时非空，可 own）
  crossDomain: readonly string[];    // 跨域耦合（已显式 ack）
}
```

`decision.selectedPartIds` 保留 `string[]` 视图，兼容路线图字段名与既有对账脚本。

2. `AllocationDecision` 增加 `outcome: 'accepted' | 'rejected' | 'blocked'`、`phase: 'admitted' | 'none'`、
   `preempted: string[]`。`accepted` 保留为 `outcome === 'accepted'` 的便捷视图。
   `blocked` 与 `rejected` **必须分开**：路线图 Required tests 要求"model-not-ready is BLOCKED, never PASS"，
   把阻塞写成拒绝会让上层误以为"请求不合法"。

### 2.2 数据来源（零参数名铁律）

规划器**不认识任何参数名**，全部来自调用方：

```ts
interface LimbManifest {                 // G1 生成物（body-manifest.ts）的装配视图
  modelFingerprint?: string;
  parts: LimbManifestPart[];             // 每项含 side / family / poseDomain / physicsDomain /
}                                        // crossDomain / sharedForbidden / calibrated
interface LimbMotionCapability {         // G3 动作库的接口面（G2 只消费数据）
  motionId: string;
  family?: string;
  variants: Record<string, LimbMotionVariant>;  // partId → 变体；缺失的侧 = 无动作（不回退）
  directOutput?: boolean;
}
```

`packages/core` **不** import `packages/renderer`（分层）。G4 接线时把
`ARM_RIGHT_POSE / ARM_RIGHT_PHYSICS / CROSS_DOMAIN / SHARED_FORBIDDEN / ROOT_ONLY` 装配成
`LimbManifest` 传入即可，无需改动本文件。

## 3. 10 条规则 → 实现点 → 用例

| # | 规则（路线图） | 实现点（`limb-plan.ts`） | 用例 |
|---|---|---|---|
| 1 | 显式 left/right/both 不可静默改侧 | `partOfSide` 只匹配 `part.side === request.side`；缺变体 → `side-unavailable`，无回退分支 | LP-01、LP-03 |
| 2 | Agent 显式动作压过普通自主待机 | `LIMB_SOURCE_RANK`（agent 3 > interaction 2 > autonomous 1）；`evaluateConflict` 跨源按主序 | LP-06 |
| 3 | Interaction 仅在显式中断策略下抢占 Agent | `options.allowInteractionPreemptAgent`（缺省 false）→ `interaction-preempt-denied` | LP-06、LP-07 |
| 4 | 自主永不抢占忙部位 | `evaluateConflict` 首判 `source === 'autonomous'` → `autonomous-no-preempt`（忽略 priority） | LP-06 |
| 5 | 未请求部位保持原控制源 | 决策只描述被选部位；状态里其他持有原样保留（LP-08 逐字段比对） | LP-04、LP-08 |
| 6 | 未知 / 不支持能力 fail-closed | 无能力条 / 空 manifest / 空变体 / 部位不在 manifest / 参数不在已声明域 → 全拒 | LP-11 |
| 7 | 共享参数域原子保留 | 冲突域 = `pose ∪ physics ∪ cross` 参数集；任一条冲突不允许 → **整单拒绝**（无半批准）；`sharedForbidden` 静态禁占 | LP-03、LP-05、LP-09 |
| 8 | cancel / timeout / error 幂等释放 | `settleLimbHold`（四种终态同一出口）+ `tickLimbPlan`（INV-5 到期）；重复调用 `released: []` | LP-07、LP-10、LP-18 |
| 9 | 旧代次回调被 fence | 同 `executionId` 有更大 `generation` → 请求 `stale-generation`；`settle` 带旧代次 → `fenced: true` 且状态零变化 | LP-07、LP-15 |
| 10 | 准入成功 ≠ 动作完成 | `decision.phase` 恒为 `'admitted'`；持有到期由 `durationMs` 兜底、终态只由 `settle` 产生；动作回执才是权威 | LP-10 |

补充约束（本仓扩展，均有用例）：

| 约束 | 实现 | 用例 |
|---|---|---|
| `auto` 只在**有校准证据**的侧选边 | `part.calibrated === true` 是唯一依据；零候选 → `no-calibration`；多候选按"负载 → manifest 声明序"确定性选边 | LP-02 |
| 跨域参数不默认占用 | 变体写入 `crossDomain` 参数且 `crossDomainAck !== true` → `cross-domain-unacknowledged` | LP-14 |
| 姿态域 / 物理域分离 | 非直写请求 `physicsDomain` 恒空；直写时两域不相交 | LP-13 |
| 确定性（INV-8 型） | 无 `Date.now` / 随机 / 全局计数器；`now` 注入；所有输出域 `sortedUnique`；持有按 `startAt → executionId → generation` 排序 | LP-16 |
| 零运行时 | `M1G2_DEFAULT_ENABLED = false`；源码扫描无 `setParameterValueById` / `Date.now` / `Math.random` / `document` / `window` / `setTimeout` / `fetch` / 参数名 | LP-17、LP-19 |

## 4. 与既有执行链的衔接（不新增写入路径）

```text
MotionRequest ──► planMotionAllocation ──► AllocationDecision
                                              │
                     ┌────────────────────────┴───────────────────────┐
                     ▼                                                ▼
        selectedParts[].poseDomain                        selectedParts[].physicsDomain
        （主战场，普通参数域）                              （仅直写输出时非空）
                     │                                                │
                     ▼                                                ▼
   GestureSegment.params（冲突域声明）              LimbController.acquire(ids,{phase:'post'})
        │                                                │
        ▼                                                ▼
   enqueueGesture → resolveTimeline → resolveWritePlan → ParamInjector（唯一写入口）
```

关键不变量：

- 规划器**不**产生写值，只产生"域租约"；写值仍由 Gesture Timeline / Cue 编译器提供；
- 决策的 `parameterDomains` 可直接作为 `GestureSegment.params` 的键集合（值由 cue 编译器给），
  于是规划层与时间线层的冲突判定**用同一套参数域语义**（`gesture-timeline.ts` `domainsOverlap`），
  不会出现"规划器认为不冲突、时间线认为冲突"的双口径；
- 物理直写通道复用 G1 已接线的 `LimbController`（`acquireDetailed` 的 `not-ownable` 语义天然容纳
  "姿态参数不在物理输出表"这一事实）；规划器不新增第二个 Cubism 写入者；
- `phase: 'admitted'` 意味着后续必须由 action receipt（`action-chain.ts`）或 `settleLimbHold` 收尾，
  禁止把 `accepted` 当作完成信号。

### 4.1 与 cue 编译器的具体衔接（G4 预演）

```ts
const decision = planMotionAllocation(state, request, manifest, catalog, now, { enabled: true });
if (!decision.accepted) return;                       // rejected / blocked 分流由调用方处理
const segment: GestureSegment = {
  id: request.executionId,
  params: Object.fromEntries(decision.parameterDomains.map((id) => [id, 0])), // 值由 cue 编译器提供
  durationMs: request.durationMs,
  priority: request.priority as SemanticPriority,
  runId: request.executionId,
};
enqueueGesture(timeline, [segment], now, { enabled: true, entryId: request.executionId });
```

> `params` 里的 `0` 只是冲突域占位（与 `embodied-cue.ts` transition 操作同款约定）；
> 真实写值必须来自编译后的 cue，不得由规划器编造。

## 5. G3 / G4 后续接口预期

| 阶段 | 需要的输入 | 本文件已提供的接口面 | 未提供（需 G3/G4 补） |
|---|---|---|---|
| G3 动作库 | 每动作的左右变体、每变体实际写哪些姿态参数、校准证据 | `LimbMotionCapability` / `LimbMotionVariant` | 变体数据本身（真机目视标定后才可填 `calibrated: true`） |
| G4 跨源调度 | Agent / Interaction / Autonomous 统一入口、抢占策略 | `planMotionAllocation` + `settleLimbHold` + `tickLimbPlan` + `LimbPlanState` | 调度循环、与 ActGate 的连接、`options` 的策略来源（配置/画像） |
| G5 真机验收 | 视觉隔离度、release 跳变、跨域观感 | 决策里的域明细（可逐参数比对） | 逐帧采样工具 |

G4 接线时必须做的三件事：

1. `enabled: true` 只在一个 flag 后（回滚口径：单一开关回到现行为）；
2. `modelReady` 来自渲染器真实能力读取（Core 加载 + 物理表就绪），**不得**缺省为 true 后在未就绪时放行；
3. `settleLimbHold` 必须由 action receipt / timeout 驱动，禁止用"看下一帧有没有写入"推断完成。

## 6. 已知限制（诚实清单）

| # | 限制 | 依据 | 状态 |
|---|---|---|---|
| L1 | 姿态层与物理输出在 moc3 的叠加方式未标定 | 审计 §4.4 / U1 | UNKNOWN，故两域分离表达 |
| L2 | `auto` 的"校准证据"目前只能由 G3 真机标定提供；G2 测试里的 `calibrated` 是夹具 | 本文件 §2.2 | NOT TESTED（真机） |
| L3 | 规划器无法判断"动作做完没有"，只能靠 `durationMs` 与回执 | 规则 10 | 设计约束，非缺陷 |
| L4 | 冲突判定是"参数域重叠"；物理输出**间接**耦合（A 写共享根输入 → B 输出变化）不在本层可见 | 审计 §3.3 S1–S3 | G4 需在共享域层面二次仲裁（`shared-arbitration.ts` 已有该能力） |
| L5 | 未接线：`M1G2_DEFAULT_ENABLED = false`，生产路径零引用 | 本文件 §0 | BLOCKED（等 G4） |

## 7. 复现

```bash
node --experimental-strip-types packages/core/test/limb-plan.ts   # 20 例
pnpm test:core                                                    # 全量链（含本用例）
pnpm test:types                                                   # 类型窄门禁
```
