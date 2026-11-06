# M1-D3 实施就绪文档（ConsumerLease 消费者租约 / epoch fencing）

> 作者：design-d3（架构/安全审查，只读审查产出）。基线：worktree `feat/m1-d-overnight` @ b5efef6。
> 本文档是 d3 的开工依据。所有行号基于该基线，实施时若代码已移动需重核。

## 0. 审计结论复核（本分支实测，全部成立）

| 审计结论 | 复核位置 | 状态 |
|---|---|---|
| poll = 整批 splice，多消费者瓜分 | `packages/dsh-l2d-plugin/lib/ai-inbox.mjs:34-36` | ✅ `queue.splice(0, queue.length)` 一次全取 |
| post 无来源校验，任意页面可用任意 id 写回执 | `ai-inbox.mjs:38-52`（只验 `id` 存在）+ `lib/index.js:1020-1052`（POST 直接 `aiInbox.post`） | ✅ fencing 要堵的口 |
| seq 单调 | `ai-inbox.mjs:28`（`id: ++seq`） | ✅ 可直接作 fencing 判序依据 |
| /ai/poll 是唯一闸门，只过 isCrossSite | `lib/index.js:1010-1016` | ✅ 无租约判定 |
| isCrossSite 轻量栅栏 | `lib/index.js:158-171` | ✅ 保留不动，fencing 叠加在其上 |
| __bootTag 可作 rendererVersion 种子，同版本双页不可区分 | `lib/overlay.js:28-34`（从 script src 的 `?v=` 提取） | ✅ 必须页面自生成 instanceId |
| 渲染端 epoch 作废模式 | `packages/renderer/src/index.ts:1294-1302`（捕获 epoch，异步完成时比对作废） | ✅ 租约过期语义复用同一思想 |
| `consumerLeaseEnabled` flag | 全仓 grep 无命中 | ✅ 全新 flag，默认关 |
| WHALEL2D 可吸收三点 | `docs/REFERENCE-WHALEL2D-ARCHITECTURE.md:125` | ✅ 单调序号（已有）/断连 TTL 清理（待加）/epoch 作废复用（待加） |

真机事故形态（验收判定已被污染）：用户 Edge 旧页面在重扫前抢夺 `/ai/poll`，整批 splice 拿走 call 后回写"profile 里没有"类污染回执。本设计直接针对该事故。

---

## 1. 接口草案（签名级）

### 1.1 落点与配置

全部租约状态收敛在 `createAiInbox` 闭包内（`ai-inbox.mjs`），**不新建模块、不持久化**——队列与租约必须同原子域，否则 poll/接管与回执校验会出现竞态窗口。

flag 从设置层按调用时读取（设置是 `volatile`，`lib/index.js:152` 同款模式），**不得在 createAiInbox 构造时烘焙**，否则切换 flag 需重启：

```js
// lib/index.js（SETTINGS_SHAPE 内新增，模式照抄 :152 reverseEnabled）
consumerLeaseEnabled: { type: 'boolean', default: false,
  description: '消费者租约：/ai/poll 单消费者接管 + /ai/result token fencing，默认关' }

// 构造处（:918）
const aiInbox = createAiInbox({
  leaseTtlMs: 15000,                                   // 租约 TTL，断连后多久允许接管
  legacyGraceMs: 30 * 60 * 1000,                       // 旧页面无 token 回执宽容期
  leaseEnabled: () => readSettings().consumerLeaseEnabled === true,  // 每次调用时判定
});
```

### 1.2 ConsumerLease 内存结构

```js
// ai-inbox.mjs 闭包内新增
let leaseSeq = 0;                 // 独立于 seq 的 epoch 计数器（单调整数，从 1 起）
let lease = null;                 // null = 从未有租约
// lease = {
//   token: string,        // 'lease-' + leaseSeq + '-' + random 后缀；每次接管轮换，旧 token 即刻作废
//   consumerId: string,   // 页面自生成（overlay 注入，见 1.5），同版本双页靠它区分
//   epoch: number,        // ++leaseSeq；供诊断与调用方展示，fencing 判定走 token
//   acquiredAt: number,   // Date.now()
//   expiresAt: number,    // acquiredAt + leaseTtlMs；持有人 poll 成功即续期
// }
const ownedCalls = new Map();     // callId -> { token, epoch, polledAt }；poll 出队时登记，回执/清理时删除
let leaseEnabledAt = 0;           // flag 首次生效时刻，宽容期计时起点
```

内存上限：`ownedCalls` 每次接管时对超时（> leaseTtlMs × 4）未回执条目做清扫；`results`/`events` 沿用现有 `trim()`（`ai-inbox.mjs:19-24`）。

### 1.3 poll —— 签名与校验规则

```js
/**
 * poll(query) → { calls, reverse, lease? }
 * query: { consumerId?: string }（新 overlay 从 URL query 带；GET /dsh-l2d/ai/poll?consumerId=...）
 * 服务端路由改动点：lib/index.js:1013 传入 consumerId，其余路由逻辑不动。
 */
poll({ consumerId = '' } = {}) {
  // flag 关：等价现行为——忽略 consumerId，整批 splice 返回（ai-inbox.mjs:34-36 原样）
  if (!opts.leaseEnabled()) return legacyPoll();

  const now = Date.now();
  if (!leaseEnabledAt) leaseEnabledAt = now;

  // R1 从未有线租约，或已过期 → 本次 poll 成为接管
  if (!lease || now >= lease.expiresAt) return takeover(consumerId, now);

  // R2 线租约属本人 → 续期并发放
  if (consumerId && consumerId === lease.consumerId) {
    lease.expiresAt = now + opts.leaseTtlMs;
    return issueCalls();                       // splice + 登记 ownedCalls
  }

  // R3 线租约属他人且未过期 → 不发放（杜绝瓜分）
  //    无 consumerId（旧版本 overlay）也落在这条：收空队列 + reverse 搭车，不 403
  return { calls: [], lease: { status: 'held', holder: maskId(lease.consumerId) } };
}

// takeover(consumerId, now)：
//   1. epoch = ++leaseSeq；token 轮换
//   2. 遍历 ownedCalls：未回执条目 → results.set(id, { ok:false, reason:'lease-taken-over' })（失联语义，§3）
//   3. 清空 ownedCalls，返回 issueCalls()
```

校验规则要点：
- **接管必须携带 consumerId**；没有 consumerId 的 poll 永远落在 R3（空队列），不可能借"无主"状态抢到调用——这是对真机事故（旧页面抢 poll）的直接封堵。
- R3 返回体保留 `reverse`（反向桥搭车，`lib/index.js:1014`），保证旧页面的 `l2d_get_state` 不残废。
- 新 overlay 本地节流：收到 `lease.status === 'held'` 时拉长下次 poll 间隔（400ms → 2s），降低无谓轮询。

### 1.4 result/post —— 签名与校验规则

```js
/**
 * post(body) → { ok: true } | { ok: false, reason }
 * body 新增字段：{ id, token?, epoch?, event?, result? }
 * 校验顺序（flag 开时）：
 *   V1 id 基本校验（现 :39-40 原样保留）
 *   V2 call 归属校验：ownedCalls.get(id) 必须存在，且 body.token === 该条目 token。
 *      —— 不只验 epoch：同一 epoch 内多次 poll 的 call 都属同一 token，但接管后 token 轮换，
 *         旧 epoch 的持有者即使报对 epoch 号，token 已对不上。
 *   V3 过期校验：results 已有该 id（含 lease-taken-over 失败回执）→ 拒收（一次执行一份回执，先到先得）
 *   V4 全部通过才写入 results/events（现 :41-51 逻辑）；返回 { ok: true }
 *   失败统一 { ok:false, reason:'fenced' }，路由层（lib/index.js:1047-1049）回 409
 *
 * 宽容期分支（V2 失败且 body.token 缺失时）：
 *   - now < leaseEnabledAt + legacyGraceMs
 *   - 且 id ≤ seq（是真发过的 call，伪造未来 id 直接拒）
 *   - 且 results 尚无该 id
 *   → 照收 + diag('ai/result legacy-grace id=' + id)（审计建议，评估见 §5.2）
 *   宽容期过后：一律 fenced，无例外。
 */
```

overlay 侧改动（`lib/overlay.js:3676-3687` 两处 POST）：body 增加 `token: __aiLeaseToken`、`epoch: __aiLeaseEpoch`——poll 响应里带出 `lease: { token, epoch }`，页面存模块级变量。回执写失败（409）仅 `console.warn`，不重试（重试必然再被 fence）。

### 1.5 consumerId 生成（overlay.js）

```js
// __bootTag（:28-34）同版本双页无法区分，仅作诊断字段
var __aiConsumerId = (function () {
  try { return 'c-' + (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).slice(2)); }
  catch (e) { return 'c-' + Date.now() + '-' + Math.random().toString(36).slice(2); }
})();
```

页面刷新/重开生成新 id → 自然走 R1 接管，无遗留状态。旧版本 overlay 无此变量 → 恒 R3。

### 1.6 legacy 行为（flag 关）等价性

| 路径 | flag 关 | flag 开 |
|---|---|---|
| `/ai/call`（index.js:964-1008） | 原样 | 原样（call 侧无任何改动） |
| `/ai/poll`（:1010-1016） | `aiInbox.poll()` 整批 splice，无 consumerId 判定 | §1.3 三分支 |
| `/ai/result` POST（:1046） | `aiInbox.post(body)` 无 token 校验 | §1.4 V1-V4 |
| `/ai/result` GET（:1029） | `aiInbox.read(id)` 原样 | 原样（lease-taken-over 只是 results 里的一条普通失败回执） |
| 旧 overlay（flag 开时） | — | 恒收空队列 + reverse 搭车，不 403，行为与"队列空闲"无法区分 |

---

## 2. 并发时序图（双消费者竞争）

```
调用方(MCP)        A 页(新版)           B 页(新版/高版本)      服务端状态（均在 ai-inbox.mjs 闭包内）
    |                  |                     |                    lease=null, ownedCalls={}, seq=0
    |                  |                     |
 T1 POST /ai/call ──────────────────────────────→  index.js:964 路由 → :991 guardAiCall → :1000
    |←{ ok,id:7 }────|                     |            aiInbox.call → ai-inbox.mjs:28 id=++seq,
    |                  |                     |            :29 queue.push
 T2 A poll(400ms, overlay.js:3659) ───────────→  index.js:1013 → poll({consumerId:ca})
    |                  |←{ calls:[#7],       |            R1 接管: epoch=1, token=Ta,
    |                  |   lease:{token:Ta}} |            splice(:35) 取走 #7, ownedCalls{7→Ta}
 T3                 B poll ─────────────────→    R3: ca ≠ lease.consumerId 且未过期
    |                  |                     |←{ calls:[], lease:{status:'held'} }
    |                  |                     |            （不瓜分——现 :34-36 缺陷被封堵）
    |          A 执行 #7 成功，POST /ai/result {id:7, token:Ta} →  index.js:1046
    |                  |                     |            V2 通过 → results.set(7,…)，ownedCalls 删 7
 T4 A 页关闭（断连）  ✗                     |            lease.expiresAt 过期，无续期
 T5                  |               B poll →           R1 过期接管: epoch=2, token=Tb,
    |                  |                     |            ownedCalls 中若有未回执 call →
    |                  |                     |            results.set(id, lease-taken-over)（§3）
 T6 旧页残留 A 复活 POST /ai/result {id:9, token:Ta} →    V2: ownedCalls.get(9).token=Tb ≠ Ta
    |                  |                     |            → { ok:false, reason:'fenced' } → 409
 T7 调用方 GET /ai/result?id=9 ───────────────→  index.js:1029 read(9)
    |←{ ready:true,   |                     |            results.get(9) = { ok:false,
    |  result:{ok:false,reason:             |            reason:'lease-taken-over' } → 明确失败，
    |  'lease-taken-over'}} ──────→         |            重发责任归调用方（§3）
```

每个 state 变更落点：队列入队 `ai-inbox.mjs:29`（现状）；splice `:35`（现状）；接管/续期/fence 判定与 ownedCalls 登记均为 ai-inbox.mjs 新增（实施时紧随现 poll/post 函数体）；路由改动仅 `lib/index.js:1013`（传 consumerId）与 `:1047-1049`（fenced → 409）两处；overlay 改动 `lib/overlay.js:3659`（带 query）、`:3676-3687`（回执带 token）。

---

## 3. 失联语义

接管时对未回执 call 的处置，**只做一件事**：

```
results.set(id, { ok:false, reason:'lease-taken-over' })
```

- 调用方随后的 `read(id)`（`lib/index.js:1029` → `ai-inbox.mjs:60-65`）拿到 `ready:true` + 明确失败原因，不会挂到超时。
- **服务端不做复活重排**：call 不重新入队。原因：指令多为状态性（设表情/动作），旧持有者可能在被接管前的毫秒级窗口已局部执行，重排会造成双执行；调用方拿到 `lease-taken-over` 语义清晰，重发与否由它决策（与 WHALEL2D"会话死亡即取消未决请求"同构，REFERENCE §ControlServer :124）。
- `lease-taken-over` 写入后按 §1.4 V3 先到先得：旧持有者若晚到回执，连 V2（token 轮换）带 V3（已有结果）双重拒绝。
- 旧 epoch 的 in-flight event（action-done start/end）同样被 fence，不产生半截事件流。

---

## 4. 测试矩阵

| # | 用例 | 前置 | 期望 | 验证点 |
|---|---|---|---|---|
| T1 | 双消费者竞争：B 在 A 租约期内 poll | flag 开，A 先 poll 拿到 call | B 收 `calls:[]` + `held`，A 队列不被瓜分 | 对照现 `:34-36` splice 行为（flag 关时 B 会分走一半） |
| T2 | A 断连后 B 接管 | A poll 后停发 ≥ leaseTtlMs | B poll 得 epoch+1、新 token，拿到后续 calls | epoch 单调；A 的 token 失效 |
| T3 | 旧 epoch 回执拒绝 | T2 后旧 A POST result（带旧 token） | 409 `fenced`，results 不写入 | V2/V3 双重拒绝；diag 记录 |
| T4 | 接管后旧任务明确失败 | A poll 拿到 #7 未回执即断连 | B 接管时 results[7] = `lease-taken-over`；调用方 read 得 ready:true + ok:false | 不复活重排；调用方不超时 |
| T5 | 回执归属校验（不只 epoch） | B 接管后持 token Tb；伪造 POST 带 epoch=1 但 token=Ta | 409 fenced | token 优先于 epoch |
| T6 | legacy flag 关 = 现行为 | flag 关，双页并发 poll + 任意 id POST result | 与基线 b5efef6 行为逐字节等价（含整批瓜分与无来源回执） | 回归对比 |
| T7 | 旧版本 overlay 降级 | flag 开，旧 overlay（无 consumerId）poll | 空队列 + reverse 搭车，HTTP 200 不 403；其无 token 回执走宽容期/拒收分支 | §1.3 R3 |
| T8 | 断连 TTL 清理 | 制造 ownedCalls 积压（不回执连续 poll） | 接管时超时条目被清写 `lease-taken-over`，Map 不无界增长 | 内存上限（REFERENCE :125 ②） |
| T9 | 同版本双页不互踩 | 同一 `?v=` 两页各生成 consumerId，先后 poll | 先者持租约期内后者恒空；先者关页后 TTL 到，后者接管成功 | instanceId 区分（__bootTag 不可区分，overlay.js:28-34） |
| T10 | 宽容期边界 | flag 首开 30min 内 / 后，分别 POST 无 token result | 期内：真 id 照收 + diag legacy-grace，未来 id 拒；期后：一律 fenced | §1.4 宽容期分支 |
| T11 | 先到先得 | 同 id 两次合法 result | 第二次 fenced | V3 |
| T12 | flag 热切换 | flag 开→关→开 | 关后立即恢复基线行为；再开重新记 grace 起点 | flag 每次调用时读取（§1.1） |

---

## 5. 风险与回滚

### 5.1 回滚开关等价性

`consumerLeaseEnabled=false` 时：poll 第一分支即返回 legacyPoll（现 `:34-36` 原路径），post 跳过 V1-V4 直走现 `:41-51`；租约结构不被读写（`leaseEnabledAt` 也不动，保证重开时 grace 从头计时）。**逐路径等价，回滚 = 设 settings 关 flag，零重启、零数据残留**。唯一新增的常开成本是 `poll()`/`post()` 各一次 `opts.leaseEnabled()` 调用（一次 settings 读取，纳秒级）。

### 5.2 宽容期建议评估（审计建议：legacy 结果照收打 diag 标记，flag 全量后再收紧）

**采纳，但收窄为三条件**（§1.4 宽容期分支）：只对"无 token + 真 id + 无既有结果"放行，且窗口固定 30 分钟。理由：

- 支持采纳：灰度瞬间可能存在升级前已被 splice 走、仍在执行中的 call，它们的回执天然无 token，一刀切拒收会让这批调用方全部超时，制造新的污染。
- 收窄理由：真机事故的污染回执恰恰是无来源 POST（审计 `:39-40`）；无条件照收等于保留事故窗口。三条件中"id ≤ seq"挡住伪造未来 id，"results 无该 id"挡住对已被正确回执 call 的覆盖——事故形态（旧页面对已消费 id 写污染结果）在宽容期内也被 V3 拦住。
- diag 标记（`legacy-grace`）是灰度观测信号：宽容期内出现该标记说明仍有旧页面存活，全量收紧（关闭宽容）应以其静默为前置条件。

### 5.3 残余风险

| 风险 | 缓解 |
|---|---|
| 恶意页面持有合法 token（先成为消费者再作恶） | 超出 d3 威胁模型：能在本机 poll 的页面已过 isCrossSite（index.js:158-171）+ 同源加载；fencing 防的是"陈旧消费者重放"，不是本机恶意代码 |
| leaseTtlMs 过短导致健康消费者被误接管（网络卡 15s） | 接管只发生在对方 poll 停续期后；误接管的后果 = 旧消费者回执被 fence + 调用方得明确失败后重发，可自愈；TTL 可后续调参 |
| 双页都想抢消费（用户开两个新 overlay） | 语义允许：TTL 过期即后来者接管，符合"最后活跃页获胜"；两页都活跃时后者恒空，无抖动 |
| MCP 调用方依赖超时而非回执 | `lease-taken-over` 让失败显式化，属改善；旧调用方不改代码也能受益 |

---

## 6. 开工就绪判定

**判定：就绪（GO），无阻塞项。**

- ✅ 审计全部结论在基线 b5efef6 复核成立，无代码漂移（§0）。
- ✅ 改动面收敛且小：ai-inbox.mjs（主体）、index.js 两处路由微调、overlay.js 三处；无生产语义变更在 flag 关时发生。
- ✅ 回滚路径明确且零成本（§5.1），灰度窗口有界（§5.2）。
- ✅ 真机事故形态（旧页抢 poll + 污染回执）被 R3 + V2/V3 双重封堵，且有对应测试（T1/T3/T6/T7）。
- 实施顺序建议：ai-inbox.mjs 租约核心 + 单测（T1-T5/T8/T11）→ 路由与 overlay 接线（T7/T9/T12）→ 真机灰度（T10 观测 legacy-grace 静默后全量）。
