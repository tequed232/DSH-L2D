# Ownership Invariants — `resolveWritePlan` 测试规格

> 给渲染层实现者（L2D调试员）用；契约见 `docs/Embodied-Behavior.md`。
> 目标：把「每参数每帧唯一 winner」做成**纯函数**，先用单测锁死语义，再接进渲染循环。
> 实现语言/位置建议：`packages/renderer/src/app/write-plan.ts`（纯 TS，无 Cubism 依赖，可 node 直跑）。

## 1. 契约

```ts
type WriteSource =
  | 'physics' | 'motion' | 'keyframes' | 'pose' | 'gaze' | 'limb'
  | 'ambient' | 'continuous';

interface WriteIntent {
  id: string;                 // 稳定标识（同 source 内去重用）
  source: WriteSource;
  priority: 10 | 50 | 90;     // ActGate：BACKGROUND/NORMAL/FORCE
  phase?: 'pre' | 'post';     // 提供即权威；缺省用 ownership.phase → 参数族默认
  params: Record<string, number>;
  runId?: string;             // 动作链 runId（limb/动作类）
}

interface ResolveInput {
  now: number;
  intents: WriteIntent[];
  ownership: Record<string, { owner: WriteSource; runId?: string; expiresAt?: number; phase?: 'pre' | 'post' }>;
  physics: Record<string, number>;          // 本帧物理输出（仅 physics-owned 参数采信）
  bounds?: Record<string, { min: number; max: number }>; // 可选：模型参数范围
  knownParams?: string[];                   // 可选：不存在则视为未知参数
}

interface WriteEntry {
  id: string;
  value: number;
  source: WriteSource;
  phase: 'pre' | 'post';
}

interface ResolveResult {
  writes: WriteEntry[];        // 每个 id 最多一条
  rejected: Array<{ id: string; source: WriteSource; reason: RejectReason }>;
}

type RejectReason =
  | 'lipsync'          // 口型禁区：永不放行
  | 'not-owned'        // 非 owner 写他人参数
  | 'wrong-phase'      // 相位与参数族不匹配
  | 'invalid-value'    // 非有限数
  | 'unknown-param'
  | 'lower-priority';  // 同参数被更高优先级/更高 source 抢占
```

## 2. 不变量（INV）

- **INV-1**：`writes` 中每个 `id` 至多一条（唯一 winner）。
- **INV-2**：口型参数（`ParamMouthOpenY/ParamMouthOpen/ParamMouthForm`）永不出现在 `writes`，
  出现在任何 intent 里都进 `rejected(lipsync)`。
- **INV-3**：参数属于物理输出时，只有 `ownership[id].owner === 'limb'` 才允许非 physics 写；
  否则 winner 只能是 physics（或无人写）。
- **INV-4**：`ownership[id]` 存在且未过期时，physics 对该参数不产生写入；
  `ownership[id].owner` 的 intent 为 winner。
- **INV-5**：`ownership[id].expiresAt <= now` 视为已释放（超时兜底），physics 恢复。
- **INV-6**：同参数多 intent：`priority` 高者胜；同优先级按 source 秩（`physics<continuous<ambient<motion<keyframes<pose<gaze<limb`）高者胜；
  同 source 同参数多条 → 后者覆盖前者（同帧 last-write-wins，仍只输出一条）。
- **INV-7**：相位规则：`HipAngleX/Y/Z` 与全部 add 型物理输入（Angle/Position/Lean/Movement*）只允许 `pre`；
  其余 set 型参数只允许 `post`；违反者进 `rejected(wrong-phase)`。
  有效相位 = `intent.phase`（提供即权威）→ `ownership[id].phase`（仅独占时）→ 参数族默认；
  `ownership.phase` 只是 acquire 方按参数族写入的默认值，**不得**绕过族约束（叶子 post / Hip pre）。
- **INV-8**：输出与 `intents` 数组顺序无关（按 id 稳定排序输出），保证可重放。
- **INV-9**：数值必须有限；提供 `bounds` 时钳制到 `[min,max]`，否则原值输出。
- **INV-10**：`knownParams` 提供时，不在名单的参数进 `rejected(unknown-param)`。
- **INV-11**：无 intent 且无 physics 值 → 无写入（空帧不得产生副作用）。
- **INV-12**：limb 功能关闭（配置/flag）时，所有 limb intent 进 `rejected(not-owned)`，physics 恢复。

## 3. 用例清单（实现时必须逐条覆盖）

约定：除非特别说明，`priority=NORMAL(50)`、`knownParams` 未提供、`bounds` 未提供；
`physics` 中给出该参数值即视为“物理输出参数”。

| # | 输入 | 期望 | 覆盖 INV |
|---|---|---|---|
| CASE-01 | 仅 limb intent `{RArm:1}`（post，已 acquire RArm） | writes=[RArm=1, source=limb]；physics 中 RArm 值被忽略 | 1,3,4 |
| CASE-02 | 同上但未 acquire | writes=[]；rejected=[RArm not-owned]；physics 值若存在则 winner=physics | 3 |
| CASE-03 | limb `{RArm:1}` + keyframes `{RArm:2}`，均已 acquire、priority 同 50 | winner=limb（source 秩 limb>keyframes） | 6 |
| CASE-04 | limb `{Param36:1}`（Param36 是姿态参数，非四肢白名单） | rejected(not-owned)；pose/motion 的 Param36 值不被 limb 覆盖 | 3 |
| CASE-05 | HipAngleX 已 acquire，limb pre=`{HipAngleX:5}`，physics 给 HipAngleX=1 | winner=limb=5（pre）；physics 值不出现在 writes | 3,4,7 |
| CASE-06 | HipAngleX 未 acquire，limb pre=`{HipAngleX:5}` | rejected(not-owned)；winner=physics | 3 |
| CASE-07 | HipAngleX 已 acquire 但 limb 用 post 相位 | rejected(wrong-phase)；winner=physics（或空） | 7 |
| CASE-08 | 叶子四肢 RArm 已 acquire 但用 pre 相位 | rejected(wrong-phase) | 7 |
| CASE-09 | acquire 后 `now > expiresAt` | ownership 视为空 → winner=physics；limb intent rejected(not-owned) | 5 |
| CASE-10 | `runId` 不匹配的 release 已生效（ownership 空） | physics 恢复（同 CASE-02 期望） | 4,5 |
| CASE-11 | 口型 `{ParamMouthOpenY:1}`（任意 source/owner，包括 limb） | rejected(lipsync)；无写入 | 2 |
| CASE-12 | 非物理输出参数 Param36 的 pose intent（post） | winner=pose | 1,3 |
| CASE-13 | Param36 同时 pose + keyframes（post，同 priority） | winner=pose（秩 pose>keyframes） | 6 |
| CASE-14 | Param36同时 pose + motion（motion 是曲线，写在 motion 相位之前） | winner=pose（post 覆盖；秩 pose>motion） | 6,7 |
| CASE-15 | FORCE(90) gaze `{AngleX:1}` vs NORMAL(50) ambient `{AngleX:0.5}`（AngleX 为根输入） | winner=gaze（优先级） | 6 |
| CASE-16 | BACKGROUND(10) motion vs NORMAL(50) pose 同参 | winner=pose | 6 |
| CASE-17 | 同 source 两个 intent 同参数（`{id:a}` 后 `{id:b}`） | 只输出一条，取后者；`a` 不出现 | 1,6 |
| CASE-18 | intent 值 NaN/Infinity | rejected(invalid-value)；无写入 | 9 |
| CASE-19 | 提供 bounds `{Param36:{min:-1,max:1}}`，intent 值 5 | writes 值=1（钳制） | 9 |
| CASE-20 | 提供 `knownParams`，intent 含 `NoSuchParam` | rejected(unknown-param) | 10 |
| CASE-21 | 空 intents + 空 physics | writes=[]、rejected=[] | 11 |
| CASE-22 | 打乱 intents 顺序两次执行 | 两次 writes 完全相同（按 id 排序） | 8 |
| CASE-23 | limb flag off，acquire 仍存在但 limb intent 出现 | rejected(not-owned)；physics 恢复 | 12 |
| CASE-24 | 同一参数两个 limb intent 不同 runId（旧 runId 未释放） | 仅当前 runId 的 intent 为 winner；旧 runId 进 rejected(not-owned) | 4,6,12 |
| CASE-25 | HipAngleX 已 acquire（ownership.phase=pre），intent 不带 phase | winner 相位=pre（用 ownership.phase）；intent 带 phase 时以 intent 为准 | 7,4 |

## 4. 状态层用例（不属于纯函数，放在 controller/LimbController 单测）

- S-01 acquire → 同一 runId release → 再 resolve：物理恢复。
- S-02 ActGate `interrupted` / `priority-blocked` → 触发 release（不等超时）。
- S-03 action-done 终态 → release。
- S-04 FORCE 抢占 NORMAL 的 limb 独占：低优先级 hold 被释放（高者可 acquire）。
- S-05 超时兜底：expiresAt 到点自动释放（仅作保险，不作为主路径）。
- S-06 反复 acquire/release 1000 次无泄漏（ownership 表大小回到 0）。

## 5. 集成快照（渲染层实现后）

固定帧序列（每帧 16ms）喂给 Mixer，记录 `readParameters([...])` 快照，与期望表比对：

1. 0-10 帧：无 acquire，四肢由物理驱动（记录基线轨迹）。
2. 第 11 帧：acquire(RArm)，limb post 写 0.8 → 之后 5 帧 RArm 恒 0.8。
3. 第 16 帧：release → 下一帧起 RArm 回到物理轨迹（与基线同相位对比）。
4. 第 20 帧：FORCE 动作抢占 → limb 被释放、动作曲线生效；结束后回物理。
5. HipAngleX 场景重复 2-3，断言裙摆参数（SkirtX1/SkirtY…）随 Agent 值变化（M1-b 验收）。
6. 对照：口型参数在任何帧都不出现在快照变化里。

诊断辅助：`injector.diagnostics()` 的 owner 写入计数、`readParameters` 快照、`l2d_get_state` 的 `info.inj`。
