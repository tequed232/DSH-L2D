# M1-d2 实施就绪文档（IMPLEMENTATION-READY）

> 审查代理：design-d2（只读审查 + 本文档，未改任何生产代码 / 无 git 写操作）。
> 工作区：D:\Desktop\DSH-L2D-overnight（feat/m1-d-overnight）。
> 结论先行：**审计结论全部仍然成立，无需再审计，可直接开工**（缺口仅 2 个可带缺省答案开工的决策点，见 §7）。

---

## 0. 审计结论复核（本轮逐文件核实）

| 审计结论 | 复核结果 | 证据 |
|---|---|---|
| core gesture-timeline API 就绪（enqueueGesture/resolveTimeline/stopGesture 纯函数 + flag 门控） | ✅ 成立 | packages/core/src/gesture-timeline.ts:210-330 / :336-356 / :362-380；`M1_DEFAULT_ENABLED=false`（write-plan.ts:17）；flag 关=入队全拒、resolve 恒空（GT-09 语义，:222-234） |
| shared-arbitration 就绪但 d2 **不接线**（conflicts 数据源为画像 controls，属后续批次） | ✅ 成立 | packages/core/src/shared-arbitration.ts:110-174；d2 只用 GestureSegment.params 参数域冲突（gesture-timeline.ts:168-176, 302-308） |
| 单一仲裁咽喉 = executePokeAction→L.admitAct，只覆盖 P1 l2d_act 链 | ✅ 成立 | packages/dsh-l2d-plugin/lib/overlay.js:1898（admitAct 调用点）；l2d_act 分支 overlay.js:3749-3761 |
| **P2 play_keyframes 直连是现行漏洞**：renderer 对物理输出无条件 injector.own，可踩掉 Agent 持有的手臂 | ✅ 成立 | overlay.js:3835-3843（工具直连 L.playKeyframes，不经 admitAct）；index.ts:816-827（准入只排除口型/不存在参数，物理输出照收并自动 own，`already` 只用于记账不阻止覆盖）；kfTick 续期 index.ts:879-882 |
| 接线推荐两层 = renderer 新增 admitGesture + kfTick 旁挂 resolveTimeline（只做到期/释放） | ✅ 可行，本文档给出签名级方案 | §1/§2 |
| 段执行复用现有 executor（playKeyframes/kfTick）零新写入路径 | ✅ 可行 | §2.3：Timeline 不产生写值，只做准入/到期记账；写值仍走 kfTick→injector.set |
| bundle 引入模式 = 相对路径 import core 源码（planPostureExecution 同款） | ✅ 成立 | index.ts:2162 `export { planPostureExecution } from '../../core/src/posture.ts'`；param-injector.ts:5 同款 |
| WHALEL2D 对照：词表按"每词一个参数域"填 GestureSegment.params，零机制改动 | ✅ 成立 | docs/REFERENCE-WHALEL2D-ARCHITECTURE.md §3.1（Body.cs:198 同通道替换 ←→ domainOf 参数域重叠即冲突，gesture-timeline.ts:168-176） |
| 动作语义测试并入 d2 验收 | ✅ 采纳 | §4 测试矩阵 M7 |

补充事实（审计未明说、本轮确认，影响方案）：

- `L.playKeyframes` 的全部调用方只有 3 处：overlay `l2d_play_keyframes` 工具分支（overlay.js:3838）、act 链 `kind:'keyframes'` 步骤（runActStep，overlay.js:1720，**已经过 admitAct**）、dev 测试页 tools/dev-server/public/overlay-test.html:187。**pose/ambient/眨眼/motion 均不经 playKeyframes** —— P2 收口不影响任何合法非 Agent 路径。
- renderer 侧 flag 目前是编译期常量（index.ts:66 `createPhysicsGate(DEFAULT_EMBODIED_FLAGS, …)`），无运行时开关管道；d2 沿用同一模式。
- ActGate 优先级词汇 BACKGROUND/NORMAL/FORCE → 10/50/90（action-chain.ts:291-305 `canInterruptAct`：`incoming >= active` 才占上）；GestureTimeline 冲突判定同值同语义（低不打断高、同级可打断，整批原子）。
- `admitAct` 被占槽时返回 `priority-blocked` 且**不发任何回执事件**（action-chain.ts:295-305）；被抢占旧链先发 interrupted 再发 start（:307-327）。overlay 侧回执格式见 blockedAct/acceptedAct（overlay.js:1507-1539）。

---

## 1. 接口草案（真实签名级）

### 1.1 renderer 新增具名导出 `admitGesture`

落点：packages/renderer/src/index.ts（装配处，actGate 定义旁 index.ts:506 附近）；纯逻辑抽到新文件 packages/renderer/src/app/gesture-bridge.ts（可单测，不依赖 Cubism）。

```ts
// ---- packages/renderer/src/app/gesture-bridge.ts（新增）----

/** overlay 传入的段结构：GestureSegment 的宽松输入形状（数值字段容错由校验兜底） */
export interface GestureSegmentInput {
  id: string;
  group?: string;
  delayMs?: number;
  durationMs?: number;          // 缺省长期持有；keyframes 轨道场景 = opts.duration 或 maxT
  timeoutMs?: number;
  priority?: 10 | 50 | 90;      // 缺省 50（NORMAL）
  /** 本段会写的参数 id → 值。值只进冲突域判定（keys），不产生任何写路径 */
  params?: Record<string, number>;
  source?: string;              // 缺省 'motion'
}

/** overlay 优先级词汇（与 ActGate 同词汇），映射 10/50/90 */
export type GesturePriorityLabel = 'BACKGROUND' | 'NORMAL' | 'FORCE';

export interface GestureAdmitOptions {
  priority?: GesturePriorityLabel;   // 批内档位（整批取最高，与 Timeline incomingRank 同语义）
  entryId?: string;                  // 缺省由段 id 派生（entryIdOf，可重放）
  now?: number;                      // 缺省 performance.now()
}

export interface GestureAdmission {
  /** 批内 admitted.length > 0；flag 关恒 false */
  admitted: boolean;
  entryId: string;
  admittedIds: string[];
  rejected: Array<{ id: string; reason: 'disabled' | 'invalid-segment' | 'priority-blocked'; detail?: string }>;
  /** 被本批让位的旧段（含 Agent 独占被同级/更高打断释放的参数 id） */
  interrupted: Array<{ id: string; entryId: string }>;
  /** 因本批打断而被释放的 Agent 独占参数（回执/诊断用） */
  releasedAgentParams: string[];
  /** flag 状态回显（诊断：区分"被拒"与"没开"） */
  flagEnabled: boolean;
}
```

```ts
// ---- packages/renderer/src/index.ts（新增导出 + 装配）----

/** 手势时间线状态（模块级；纯函数所有，renderer 只持有引用） */
let gestureTimeline: GestureTimelineState = emptyTimeline();
const timelineEnabled = DEFAULT_EMBODIED_FLAGS['embodied.timeline'] === true; // §2.4 flag

export function admitGesture(
  segments: GestureSegmentInput[],
  opts: GestureAdmitOptions = {},
): GestureAdmission;
```

**判定顺序（与 Timeline 注释的 1-4 对齐，前面加两道 renderer 侧双查）：**

1. **flag 查**：`timelineEnabled === false` → 直接返回 `{ admitted:false, rejected: 全部 {reason:'disabled'}, flagEnabled:false }`，状态零变化、ActGate/injector 零触碰（回滚不变式）。
2. **ActGate 双查**：`cur = actGate.current()`；若 cur 存在且批内最高档 `< cur.priority`（ActGate 同语义 `canInterruptAct`）且批内存在**非空 params** 的段 → 整批 `rejected('priority-blocked')`，不发事件、不动槽位。空域段（资产型手势，params 为空）不参与此判定（可并存）。
3. **injector 双查**：`agentHeld = 批内 domain ∩ injector.getAgentOwned()`；若 `agentHeld` 非空且批内最高档 `< cur.priority` → 同上整批拒；若批内最高档 `>= cur.priority` → `injector.release(agentHeld)`（Agent 独占被同级/更高打断释放，记入 `releasedAgentParams`）。
4. **enqueueGesture**：`enqueueGesture(gestureTimeline, segments, now, { enabled:true, entryId: opts.entryId })` → 取回 `{ state, entryId, admitted, rejected, interrupted, expired }`，把 `state` 写回 `gestureTimeline`，映射为 GestureAdmission。`interrupted` 里的段若对应正在播放的 keyframes（entryId == armedGesture.entryId）→ 连带 `stopKeyframes()`（释放 kfAutoOwned，见 §2.2）。

**与 enqueueGesture 的参数映射（overlay 侧 l2d_play_keyframes 分支）：**

| l2d_play_keyframes 入参 | GestureSegmentInput |
|---|---|
| `tracks[i].param` | `params: { [param]: 末键值 or 0 }`（值只构成冲突域，不写模型） |
| 段 id | `'kf:' + param`（确定性、可重放，天然去重同参数轨道） |
| `duration` / 轨道 maxT | `durationMs`（与 renderer playKeyframes 内部 kfDuration 同口径：`max(16, min(KF_MAX_MS, duration || maxT))`） |
| `a.priority` | `opts.priority`（缺省 NORMAL） |
| （固定） | `group: 'kf'`（同批 keyframes 同桶，整组超时/打断原子） |

l2d_act 链内 `kind:'keyframes'` 步骤同款映射（§2.1 改动点 2），priority 继承链档位。

### 1.2 其余新增导出（index.ts + api 映射表）

```ts
/** 显式释放；selector 缺省 = 全停（透传 core stopGesture 语义） */
export function stopGesture(selector?: { entryId?: string; runId?: string; id?: string; group?: string }):
  { stopped: Array<{ id: string; entryId: string }> };

/** 诊断只读面 */
export function getGestureState(): {
  enabled: boolean;
  active: Array<{ id: string; entryId: string; startAt: number; endAt: number | null; params: string[] }>;
  armedEntryId: string | null;   // 当前绑定 playKeyframes 的批次（§2.2）
};
```

api 映射表（index.ts:2164 `const api = {...}`）追加：`admitGesture, stopGesture, getGestureState`（window.DSH_L2D 随之暴露，overlay 消费）。

### 1.3 overlay l2d_act / l2d_play_keyframes 分支调用点与回执 arbitration 字段

**调用点 1 — overlay.js `l2d_play_keyframes` 分支（:3835-3843 改写）：**

```js
// flag 开：先准入再播放；flag 关：走原路径（L.admitGesture 返回 flagEnabled:false 时等价直通）
var segs = tracks.map(function (tr) {
  return { id: 'kf:' + tr.param, group: 'kf', params: (function(){ var o={}; o[tr.param]=0; return o; })(),
           durationMs: Math.max(16, Number(a.duration) || 0) /* 0 时由 renderer 按 maxT 口径补 */ };
});
var ga = L.admitGesture ? L.admitGesture(segs, { priority: a.priority }) : null;
if (ga && !ga.admitted) {
  return { ok: false, accepted: false, reason: 'gesture-priority-blocked', rejected: ga.rejected,
           arbitration: arbReceipt(ga) };
}
var n = L.playKeyframes(tracks, { duration: a.duration, loop: a.loop === true });
if (n <= 0) return { ok: false, error: 'no-valid-tracks', arbitration: ga ? arbReceipt(ga) : undefined };
var kfOwned = L.getKeyframeOwnedParameters ? L.getKeyframeOwnedParameters() : [];
return { ok: true, tracks: n, owned: kfOwned, arbitration: ga ? arbReceipt(ga) : undefined };
```

```js
/** 回执 arbitration 字段格式（l2d_act 与 l2d_play_keyframes 共用） */
function arbReceipt(ga) {
  return {
    entryId: ga.entryId,
    admitted: ga.admittedIds,          // string[]
    rejected: ga.rejected,             // [{id, reason, detail?}]
    interrupted: ga.interrupted,       // [{id, entryId}]
    releasedAgentParams: ga.releasedAgentParams,  // string[]
    flagEnabled: ga.flagEnabled,
  };
}
```

**调用点 2 — runActStep `kind:'keyframes'`（overlay.js:1720 前插入）：** 链已过 admitAct（P1），但 Timeline 需要登记段才能让 kfTick 做到期记账、并让后续手势按参数域与之冲突。步骤播放前调 `L.admitGesture(segs, { priority: chainPriority, entryId: 'act:' + runId })`；被拒 → `L.noteActMotion(runId, 'gesture-blocked:' + rejected[0].reason, 'skip')` 并跳过该步骤（进 notes，不当失败）。

**调用点 3 — `l2d_stop_keyframes`（:3844-3847）：** flag 开时追加 `L.stopGesture({ entryId: 当前 armedEntryId })`（经 getGestureState 取），保证 Timeline 与 kf 状态同步清账。

---

## 2. P2 旁路收口方案

### 2.1 改动点（共 3 处 + 1 处打断钩子）

| # | 位置 | 改动 |
|---|---|---|
| 1 | overlay.js `l2d_play_keyframes` 分支（:3835） | 如 §1.3：admitGesture 前置，被拒即短路返回，不再触达 playKeyframes。**这是收口主闸** |
| 2 | overlay.js runActStep keyframes 步骤（:1720） | admitGesture 登记（§1.3 调用点 2）。链本身已过 ActGate，此处只做 Timeline 记账 |
| 3 | renderer playKeyframes（index.ts:770-839） | **纵深防御**：flag 开时，维护模块级 `armedGesture: { entryId, params:Set<string> } \| null`（admitGesture 成功且 admittedIds 非空时武装；stopGesture/到期清理时解除）。自动 own 块（:816-827）加一道判定：轨道 param ∈ 物理输出 且 ∉ armedGesture.params 且 `!injector.isAgentOwned(param)` → 该轨道降级为"只播非物理部分"（从 accepted 剔除，走现有 `if (!accepted.length) return 0` 返回 0）。**没有 armed 批次的物理轨道写不进去 = 即使未来新增直连调用方也踩不掉 Agent 持有的手臂** |
| 4 | renderer admitAct 导出（index.ts:508） | **Agent 打断手势**：flag 开且 `actGate.admit` accepted 时 → `stopGesture()`（全清）+ 若 `armedGesture` 非空 → `stopKeyframes()`（清 kfAutoOwned，旧手势逐帧写值停止）。FORCE 戳一戳同样能打断手势（语义正确：Agent/交互动作占用身体时手势让位） |

### 2.2 armedGesture 生命周期

```
admitGesture 成功(admittedIds 非空) ──→ armed = { entryId, params: ∪admitted.params }
playKeyframes 实际接受轨道          ──→（不改 armed；entryId 已在 admit 时绑定）
kfTick 旁挂 resolveTimeline 到期清理 ──→ 若 armed.entryId 全部段被清 → armed = null（并 releaseKfOwnership 兜底）
stopGesture(selector) 命中 armed    ──→ armed = null + stopKeyframes()
admitAct accepted（Agent 打断）     ──→ armed = null + stopKeyframes()（§2.1 #4）
flag 关                             ──→ armed 恒 null，#3 判定整体跳过
```

### 2.3 合法非 Agent 路径保留论证（判定条件）

P2 收口的判定条件收敛为一句话：**只有"写物理输出的 keyframes 轨道"需要 armed 批次**。逐一核对现行写入方：

| 路径 | 经 playKeyframes？ | 经 armed 检查？ | 受影响？ |
|---|---|---|---|
| pose / ambient / 眨眼（PoseUpdater/applyAmbientFace） | 否（injector 独立路径） | 否 | 不受影响 |
| motion 播放（playMotionAsync） | 否 | 否 | 不受影响 |
| l2d_set_parameters（own 显式认领） | 否 | 否 | 不受影响 |
| l2d_posture（planPostureExecution + ownParameters） | 否 | 否 | 不受影响 |
| l2d_act 链 keyframes 步骤 | 是 | 是（改动点 2 登记，链档位 ≥ 自身即过） | 通过 |
| l2d_play_keyframes 工具 | 是 | 是（改动点 1） | 通过 |
| dev 测试页 overlay-test.html | 是 | 是（页面先调 admitGesture 或改测 flag 关基线） | 文档注明 |
| **未知的未来直连调用方** | 是 | **否 → 拒** | 这就是要堵的洞 |

flag 关时 armed 恒 null、#3 判定整体不编译进判断路径（`timelineEnabled` 常量折叠），playKeyframes 逐行为等价基线。

### 2.4 flag 定义

沿用 EmbodiedFlags 模式（motion-adapter.ts:147-160）：`EmbodiedFlags` 增加 `'embodied.timeline'?: boolean`，`DEFAULT_EMBODIED_FLAGS` 增加 `'embodied.timeline': false`。本批次所有新行为（admitGesture 双查、armed 检查、kfTick 旁挂、admitAct 打断钩子）都以同一常量为唯一开关，默认关 = 现行为逐字节不变（与 M1-a/M1-b 回滚不变式同款）。

---

## 3. 文件分工与预估规模

**串行约束：overlay.js 是互斥资源（d1/d3 各占其区域），d2 只动 §1.3/§2.1 列出的 4 个离散区段（:1720 前、:3835-3847、:3844），不触碰 3700-3900 区其余部分与 d1（Hip）/d3（会话）区域。**

| 文件 | 动作 | 规模预估 | 区域/备注 |
|---|---|---|---|
| packages/core/src/gesture-timeline.ts | **零改动** | 0 | API 已就绪 |
| packages/core/src/gesture-vocab.ts | 新增（词表数据 + 校验纯函数，WHALEL2D §3.1 每词一个参数域） | ~100-150 行 | 每词：id / params 域 / durationMs / priority / 语义标签；校验器：params 非空且键合法、首尾归零键帧约束（Move 类词）、时长单调 |
| packages/core/test/gesture-vocab.test.ts | 新增（动作语义测试 M7） | ~120 行 | 挂既有 core/test 模式（gesture-timeline.ts 测试同款） |
| packages/renderer/src/app/gesture-bridge.ts | 新增（admitGesture 纯逻辑：双查 + enqueue 映射） | ~150 行 | 不依赖 Cubism，node 单测可跑 |
| packages/renderer/src/app/gesture-bridge.test.mjs | 新增 | ~150 行 | §4 M1-M6 |
| packages/renderer/src/index.ts | 修改（导出 admitGesture/stopGesture/getGestureState、kfTick 旁挂、playKeyframes armed 检查、admitAct 打断钩子、api 映射 3 项、import core 源码同 planPostureExecution 模式） | ~80-120 行净增 | 装配点全部在既定行号附近；kfTick 旁挂 = :358 `kfTick(performance.now())` 前一行插 `gestureTimeline = resolveTimeline(...).state`（仅 flag 开） |
| packages/renderer/src/app/motion-adapter.ts | 修改（EmbodiedFlags + DEFAULT 加一项） | ~6 行 | — |
| packages/dsh-l2d-plugin/lib/overlay.js | 修改（§1.3 三个调用点 + arbReceipt 工具函数） | ~50-60 行 | **与 d1/d3 串行**；只动上述区段 |
| tools/acceptance/m1-smoke.mjs | 追加 d2 冒烟用例（flag 关回归 + flag 开正负例） | ~60 行 | 沿用 U 系列编号延续 |

总计：新增 ~600 行（含测试），修改 ~120 行。core 侧除词表外零改动。

---

## 4. 测试矩阵

| # | 类别 | 用例 | 断言 |
|---|---|---|---|
| M1 | 正向 | flag 开、无占用，admitGesture(NORMAL, params={Param36:0}) 后 playKeyframes 同参数 | admitted=true；armed 建立且 armedEntryId 非空；轨道接受数>0；kfTick 到期后 state 清空、armed 解除、ownership 释放（injector.isAgentOwned=false） |
| M2 | 负向 | Agent 经 l2d_set_parameters own Param36（FORCE 档语义），再 admitGesture(NORMAL, params={Param36:0}) | rejected=[{id,reason:'priority-blocked'}]；injector.isAgentOwned(Param36) 仍 true；playKeyframes 该参数轨道不被自动 own（armed 未建立） |
| M3 | 负向 | Agent 占用，admitGesture(FORCE, params={Param36:0}) | admitted=true；releasedAgentParams 含 Param36（同级/高打断释放）；getAgentOwned 不再含 Param36 |
| M4 | 释放 | durationMs=300 的段入队后 resolveTimeline(now+301) | expired 含该段；state 不再含；armed 解除 |
| M5 | Agent 打断 | 手势播放中 admitAct(NORMAL/FORCE) accepted | timeline 清空（stopGesture 全清）、stopKeyframes 被调（kfActive=false）、旧手势 entryId 不再出现在 getGestureState |
| M6 | 幂等 | 同一 entryId 连续 admitGesture 两次（同段同参数） | 第二次：首次段仍在持有期内 → 参数域重叠、同级 → 首批被 interrupted 替换，语义为"同通道替换"（WHALEL2D §3.1 断言同型）；不产生重复段（entryId+id 主键） |
| M7 | 动作语义 | 词表校验器：每词 params 非空、参数 id 在白名单内、Move 类键帧首尾为 0、时长随 scale 单调；给定 cue → resolveWritePlan 输出 writes 的参数 id 与**符号方向**精确断言（不锁数值） | 全绿；参照 docs/REFERENCE-WHALEL2D-ARCHITECTURE.md §5.3 |
| R1 | 回归 | flag 关（默认）：全部 d2 新导出 | admitGesture 恒 rejected('disabled') 且 ActGate/injector/timeline 零触碰；playKeyframes 行为与基线逐字节一致（armed 检查不生效）；kfTick 无 resolveTimeline 调用 |
| R2 | 回归 | flag 关：l2d_play_keyframes 现行正负例（m1-smoke U 系列口型红线 400、no-valid-tracks） | 全部保持原回执格式（arbitration 字段缺省或 flagEnabled:false，不破坏既有消费者） |
| R3 | 回归 | flag 开：pose/ambient/眨眼/motion/l2d_set_parameters/l2d_posture 全链路 | 行为不变（§2.3 表——均不经 armed 检查） |
| R4 | 回归 | l2d_act 链（expression/motion/pose/look）flag 开 | admitAct 路径 P1 行为不变；keyframes 步骤被拒时只进 notes（kind=skip），链其余步骤照常 |
| R5 | 回归 | 长播 loop keyframes 续期（kfRenewAt 路径 index.ts:879-882） | flag 开时续期仍工作（armed 存续期间不受 #3 检查影响——armed.params 覆盖自有参数） |

---

## 5. 并发时序：Agent act 与手势同帧的判定顺序

两个入口都在 JS 主线程同步执行，不存在真正同帧竞态；顺序即先后到达的两个同步调用。判定规则统一为：**先到先占（按各自档位），后到者按优先级仲裁**。

```
帧 N（post 钩子前后的调用序，T0 < T1 为同帧内两次同步调用）

情形 A：手势先到（T0 admitGesture），Agent 后到（T1 l2d_act→admitAct）
  T0 admitGesture(p=50, domain={Param36})
    ├─ ActGate 查：无 active → 过
    ├─ injector 查：Param36 未被 Agent 独占 → 过
    └─ enqueueGesture → admitted；armed = {entryId, {Param36}}
  T1 admitAct(p=50) accepted（canInterruptAct: 50>=50）
    └─ [d2 钩子] stopGesture() 全清 + stopKeyframes()
       → 手势段全停、kfAutoOwned 释放、armed=null
       → Agent 链按现有 playbackAct 执行（Param36 回到物理/由 Agent own）
  帧 N post 钩子：kfTick（kfActive=false，空转）→ 正常

情形 B：Agent 先到（T0 admitAct accepted），手势后到（T1 admitGesture）
  T0 admitAct(p=50) accepted → 槽位被 Agent 链占用
  T1 admitGesture(p=50, domain={Param36})
    ├─ ActGate 双查：cur.priority=50，incoming 50 >= 50 → 不被 ActGate 挡
    ├─ injector 双查：若 Agent 已 own Param36（链内 own 步骤已跑）且 50>=50
    │   → release(Param36)（Agent 独占被同级打断——语义与 ActGate 同级可打断一致）
    └─ enqueueGesture → admitted（同帧内 Agent 链的后续步骤若再写 Param36
        将按各自路径重新仲裁，无静默覆盖）
  ⚠ 若希望"Agent act 整链寿命内手势不可同级插入"，d2 采取收紧项：
    admitGesture 的 ActGate 双查在 cur 存在时要求 incoming > cur.priority
    （严格大于才打断，比 ActGate 的 >= 更保守）；缺省采用收紧项，
    M2/M3 用例按此断言（M3 用 FORCE 打 NORMAL 才释放）。

情形 C：同帧手势 vs 手势（两批 admitGesture）
  纯 Timeline 语义：参数域重叠 → 高/同级整批替换（interrupted），低档整批拒；
  参数域不相交 → 并存。armed 归属最后一批成功且含 keyframes 的批次。

帧内钩子顺序（不变）：
  pre 钩子：gaze → angleBus → injector.apply(pre) → physicsGate.pre
  post 钩子：[d2] resolveTimeline(到期清理) → kfTick → PoseUpdater → ambient
            → physicsGate.post → injector.apply(post) → applyGazeEyes
  d2 只在最前插一步纯函数状态清理（flag 关 = 不插），不改变任何既有相对顺序。
```

---

## 6. 风险与回滚（embodied.timeline 关闭时逐路径等价论证）

| 新增路径 | flag 关时行为 | 等价性 |
|---|---|---|
| admitGesture | 首行短路：rejected 全 'disabled'，不触碰 actGate/injector/gestureTimeline | overlay 侧 `ga.admitted===false` 时不短路（flagEnabled:false 视为直通），等价原代码路径。**注意：overlay 必须写 `if (ga && ga.admitted === false && ga.flagEnabled) → 拒`，否则老 renderer 配新 overlay 会误拒** |
| playKeyframes armed 检查 | `timelineEnabled` 为编译期常量 false，检查分支不可达（V8 常量折叠），accepted/own/kfTick 逐字节基线 | ✅ |
| kfTick 旁挂 resolveTimeline | flag 开才调用；flag 关该行不执行，kfTick 签名与内部逻辑零变化 | ✅ |
| admitAct 打断钩子 | flag 开才执行 stopGesture+stopKeyframes；flag 关 admitAct 与基线完全一致 | ✅ |
| overlay 三个调用点 | admitGesture 返回 flagEnabled:false → 全部走原分支；arbReceipt 字段缺省（undefined），回执 JSON 对既有消费者只增不改 | ✅（新增字段属向后兼容增列） |
| stopGesture/getGestureState | 纯新增导出，无人调用即无副作用 | ✅ |
| 词表 gesture-vocab.ts | 数据 + 纯函数，无运行路径接线，flag 无关 | ✅ |

**回滚操作 = 把 DEFAULT_EMBODIED_FLAGS['embodied.timeline'] 保持/改回 false**，无需回退代码；所有行为差异收敛到这一个常量。运行期不读环境变量（与 embodied.m1/m1e 同模式），彻底消除"半开"状态。

风险清单（开工时盯防）：
1. overlay 兼容矩阵（新 overlay × 老 renderer）——§6 第一行的 flagEnabled 判定必须落进验收（R2 覆盖）。
2. armed 与 kfAutoOwned 双记账的一致性——M1/M4/M5 用例覆盖三条解除路径；实现时把"armed 解除 ⇒ releaseKfOwnership"做成单一函数出口，避免漏清。
3. 收紧项（`>` vs `>=`）是行为决策，已按保守取 `>`；若 owner 想要 ActGate 完全同语义（`>=`），只改 gesture-bridge 一处比较符 + M2/M3 断言。

---

## 7. 开工就绪判定

**可以直接开工。** 理由：核心 API（gesture-timeline.ts）已就绪且纯函数带测试；P2 漏洞与收口点已定位到行号；回执格式、文件分工、串行约束、flag 模式全部有既定答案；无阻塞的未知实现细节。

仍缺 2 个决策点，均可**带缺省答案开工**（不阻塞，落地前找 owner 确认即可）：

1. **词表内容**（§3 gesture-vocab.ts 的具体词条：每词参数域/幅值/时长）——缺省方案：先落校验器 + 3-5 个种子词（gaze/tilt/wave 类，每词一个参数域，WHALEL2D §3.1 约定），词表扩充由 owner 评审后追加；种子词参数 id 从模型能力画像 safeParams 里选（overlay pokeCapabilities 已有清单）。
2. **同级打断语义**（§5 情形 B 收紧项 `>` vs ActGate 的 `>=`）——缺省取 `>`（Agent act 寿命内手势不可同级插入，更保守）；owner 若要求完全同 ActGate 语义，改一处比较符即可。

另需排程确认一项（非设计问题）：overlay.js 的 3 个区段改动须与 d1/d3 的 overlay 改动串行合并，建议 d2 的 overlay 部分最后合入或由 team-lead 统一排窗。
