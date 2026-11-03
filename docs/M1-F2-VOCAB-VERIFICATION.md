# M1-F2 Cue 行为闭环：词表实证复核 + 接线与覆盖对照

> 生成：2026-11-04 · 分支 `feat/m1-f2-behavior-loop`（worktree `D:\Desktop\DSH-L2D-f2`）
> 范围：M1-f 第二批 F2-1/2/3/4（core + renderer 域）。不含 `lib/ai-inbox.mjs`、`lib/index.js`、`tools/acceptance/`（impl-smoke 域）。

## 一、F2-2 词表五通道实证复核

### 1.1 复核方法（可复跑）

1. **模型参数存在性**：直接读模型 cdi3 参数表（同 `getCapabilities` 的数据源）：
   `node -e "const j=require('./DeepSeek免费公皮/DeepSeek/大肥鱼.cdi3.json'); ..."` → 509 个参数，逐名核对。
2. **renderer 真实写值路径**：在 `packages/renderer/src/index.ts` 找每个参数的唯一写入点，
   核对「谁写、写多少、加还是设、是否 clamp」。
3. **能力画像绑定**：`tools/capability-scan/bindings.mjs` 的语义通道 → 参数正则。
4. **回归锁定**：`packages/core/test/cue-loop.ts` 的 `F2-T01` 把「通道 → 参数 / 符号 / 量程」
   写成断言（词表漂移会直接红）。

### 1.2 逐通道结论

| cue channel | 原生参数 | 模型存在（cdi3，509 参数） | renderer 写值路径 | scale / bounds（词表） | 依据 |
|---|---|---|---|---|---|
| `tilt` | `AngleZ` | ✅ | `ANGLE_BUS_CAP = { AngleZ: 15 }`（index.ts:1022）→ `flushAngleBus` 限幅写入（:1051-1060） | ×15，[-15, 15] | 本仓模型无 `FaceAngleZ`（WHALE/VTS 侧名）；画像 `head.roll → /^AngleZ$/`（bindings.mjs:29） |
| `pitch` | `AngleY` | ✅ | `applyGazeBody`：`writeParam(core,'AngleY', gy * 20, true)`（index.ts:1654） | ×20，[-30, 30] | 注释「20°/g 换算，VTS 设计满量程 ±30」（:1651）；画像 `head.pitch`（bindings.mjs:28） |
| `yaw` | `AngleX` | ✅ | `applyGazeBody`：`writeParam(core,'AngleX', gx * 20, true)`（index.ts:1653） | ×20，[-30, 30] | 同上；画像 `head.yaw`（bindings.mjs:27） |
| `lean` | `LeanInput` | ✅ | `writeParam(core,'LeanInput', clamp(...,-30,30))`（index.ts:1635） | ×30，[-30, 30] | 画像 `torso.lean → /^LeanInput$/`（bindings.mjs:31）；renderer 自身 clamp ±30 |
| `gaze` | `ParamEyeBallX` / `ParamEyeBallY` | ✅ | `applyGazeEyes`：`writeParam(core,'ParamEyeBallX/Y', gazeState.cur)`（index.ts:1689） | ×1，[-1, 1] | 画像 `gaze.x/y`（bindings.mjs:42-43）；注视状态本身 ±1 归一化 |

补充：
- 五通道参数域互不相交（`F2-T01` / EC-12 断言），这是「跨通道并存」的数据前提。
- `pitch`/`yaw`/`lean` 共用 renderer 的 gaze/拖拽管线（`writeParam(..., add=true)` 或 clamp 直写），
  本身是**头/身体输入参数**，不是物理输出，无需 ownership 登记。
- `gaze` 通道写 `ParamEyeBallX/Y`，与 `applyGazeEyes` 同一参数——这是接线必须晚于
  `applyGazeEyes` 的原因（见 §2.3）。

### 1.3 与 WHALE 词表的差异（不复用其数值/参数名）

| WHALE（Body.cs） | 本仓模型 | 处理 |
|---|---|---|
| `FaceAngleZ`（歪头） | 不存在；等价输入是 `AngleZ` | 种子词表用 `AngleZ`（首批已更正） |
| `FaceAngleX/Y`（转头/点头） | 不存在；`AngleX/Y` 是头输入 | 用 `AngleX/AngleY` |
| `ParamEyeBallX/FaceAngleX`（眼神） | `ParamEyeBallX/Y` 存在 | 用 `ParamEyeBallX/Y` |
| 跨通道**求和**合成 | 不移植（与 INV-1 唯一 winner 冲突） | 跨通道并存、同参数唯一 winner，绝不叠加 |

## 二、F2-1 接线（admitCue 闭环）

### 2.1 分层

```text
admitCue(cue)                       packages/renderer/src/index.ts
  └─ cueBridge.admit                packages/renderer/src/app/cue-bridge.ts
       ├─ compileEmbodiedCue        packages/core/src/embodied-cue.ts（首批，fail-closed 校验）
       ├─ commitCue                 packages/core/src/cue-loop.ts（账本：同通道替换/跨通道并存/clear）
       ├─ admitGesture(segments)    packages/renderer/src/app/gesture-bridge.ts
       │    └─ enqueueGesture       packages/core/src/gesture-timeline.ts（唯一准入/冲突闸）
       ├─ setExpression(name)       renderer 表情开关（overlay）
       ├─ stopGesture({group})      clear / 到期 / stop 的租约释放
       └─ clearExpression()         到期/clear 的表情关闭
每帧 post 钩子末尾：
  cueBridge.tick(now) → writeParam(id,value) → injector.applyNow(core, …, {mode:'set'})
                                                       （晚于 applyGazeEyes，见 2.3）
```

### 2.2 判定顺序（fail-closed）

1. `embodied.cue && embodied.timeline` 均开？否则整条 `disabled`（零副作用）；
2. `compileEmbodiedCue`：未知 channel/operation、非有限值、`interruptible:false`、
   `durationMs<=0`、transition 缺 duration → rejected，四产物全空；
3. 口型红线：segments 参数域命中 `LIPSYNC_PARAMS` → `mouth-param`（injector.set 仍兜底）；
4. 物理输出参数：先 `injector.own(ids, ttl, 'post')`，own 不足 → `physics-output-not-owned`
   拒整条（未授权物理写在 injector.set 层再拒一次）；
5. overlay 目标在 `modelSetting.FileReferences.Expressions` 内？否则 `unknown-overlay`；
6. 有 segments（hold/transition）→ `admitGesture`：低不打断高、同域同级替换、
   Agent act / Agent 独占双查；**拒绝 → 账本不落账**（无半产出）；
7. 落账后执行 clear 的 stopGesture / 表情开关；`tick` 每帧先到期清理（含释放物理认领）
   再产写值。

### 2.3 帧写值为什么走 `injector.applyNow`（且必须晚于 applyGazeEyes）

- `gaze` 通道写 `ParamEyeBallX/Y`，而 `applyGazeEyes` 在同一 post 钩子里、`injector.apply`
  之后写眼珠；cue 写值必须排在它之后，否则每帧被注视收招覆盖。
- **不引入第二套写通道**：`injector.applyNow(model, entries, {mode:'set'})` 是 ParamInjector
  的新薄封装——先调 `set()`（口型红线 / 物理输出未授权 / 真实下标 / min-max 钳制 /
  locked 全部复用），再由 `applyStickyEntry()` 立即写并移除 sticky。
- 为什么不能 `set + apply`：`ADDITIVE_INPUTS` 的 `add` 语义会在二次 apply 时重复累加；
  `applyNow` 用与 `set()` 同一份守卫、显式 `mode:'set'`、只写本批条目，不重放其他 sticky。
- 物理输出通道（未来扩展）：bridge 在准入时 `own(ids, ttl, 'post')`，clear/到期/stop 时
  `release`；未 own 时 `injector.set` 仍会拒绝（双保险）。
- 代价：cue 持有期间这些通道的常规合成（注视跟随/拖拽 angleBus）被覆盖；clear/到期后
  下一帧立即交还。v1 不做平滑过渡（见 §四风险 1）。

### 2.4 flag 与回滚

- 新 flag：`embodied.cue`（`DEFAULT_EMBODIED_FLAGS`，默认 `false`）。
- 复合开关：`CUE_ENABLED = embodied.cue && embodied.timeline`。
- 回滚：任一 flag 置 `false` → `admitCue` 恒 `disabled`、`tick` 零写值、表情零触碰，
  现行为逐字节不变（R1 断言）。

## 三、测试矩阵覆盖对照（本域）

### 3.1 core：`packages/core/test/cue-loop.ts`（15 例）

| 用例 | 覆盖点 | 对应 |
|---|---|---|
| F2-T01 | 五通道参数名/符号/量程 clamp；参数集 ⊂ 模型实证表；跨通道域不相交 | F2-2 |
| F2-T02 | 同通道后到替换（单槽、刷新 startedAt） | F2-3 |
| F2-T03 | 跨通道并存（一次 tick 输出全部通道写值、键排序） | F2-3 |
| F2-T04 | 长期持有（endsAt=null，任意时刻不释放；显式 clear 才停） | F2-4 |
| F2-T05 | 有限时长到期（`endAt <= now`，INV-5/S-05 同型） | F2-4 |
| F2-T06 | clear 按 channel 收窄；stops 的 group 与停范围一致 | F2-3/4 |
| F2-T07 | clear 带 target：只关同名表情层；channel 照常释放 | F2-3/4 |
| F2-T08 | overlay 单槽替换 + 到期关闭 | F2-3/4 |
| F2-T09 | transition：缺 duration 拒绝；有 duration 只占域零写值 + 到期 | F2-3/4 |
| F2-T10 | fail-closed：未知 channel/op、NaN、interruptible:false、非法 duration → 同一状态引用 | F2-1 |
| F2-T11 | 表情清单校验（knownOverlays）→ unknown-overlay 零副作用 | F2-1 |
| F2-T12 | 同参数多通道（词表错误）→ priority desc → channel 升序唯一 winner，不求和 | F2-3（INV-1） |
| F2-T13 | runId 透传；按 runId 收窄释放；陈旧批次不误清 | F2-4 |
| F2-T14 | 纯函数/确定性：深冻结入参零修改、重复调用深相等、键排序 | F2-3/4 |
| F2-T15 | 与 gesture-timeline 端到端：同通道替换/跨通道并存/clear→stopGesture/到期同一时刻 | F2-1/3/4 |

### 3.2 renderer：`packages/renderer/src/app/cue-bridge.test.mjs`（17 例）

| 用例 | 覆盖点 |
|---|---|
| R1 | flag 关：全拒 + 零触碰（不编译/不入队/不写值/不碰表情） |
| R2 | 正向 hold：段形状（group=`cue:<channel>`、params、priority、entryId）+ 每帧续写 |
| R3 | 时间线拒绝（priority-blocked）→ 账本不落账、零写值 |
| R4 | 缺 admitGesture 依赖 → `timeline-unavailable` |
| R5 | clear 按 channel：stopGesture(group) + 跨通道写值保留 |
| R6 | overlay 打开/关闭：target 匹配才关当前层 |
| R7 | 未知表情（setExpression=false）→ 拒整条、零落账 |
| R8 | overlay 到期：clearExpression + expiredOverlay |
| R9 | hold 到期：到期帧起不写值 + 停租约 |
| R10 | 同通道替换：账本单槽、写值为后来者、runId 透传 |
| R11 | stop(selector)：按 channel 收窄释放 + 停对应租约 |
| R12 | 被拒批次不污染后续（第二次合法 cue 正常落账） |
| R13 | 口型红线：channel→ParamMouthOpenY → 准入期 `mouth-param`，不入队不写值 |
| R14 | 物理输出未授权：own 返回不足 → `physics-output-not-owned`，拒整条 |
| R15 | 物理输出先 own 再写；clear 释放认领 |
| R16 | 注入端口拒绝 → `skipped` 语义（不静默当成功） |
| R17 | 到期释放物理认领（tick 到期路径） |

### 3.3 门禁

| 门禁 | 结果 |
|---|---|
| `pnpm test:core`（链尾追加 cue-loop + cue-bridge） | exit 0（15 + 17 新例 + 既有全量无回退） |
| `pnpm test:types` | PASS（Cannot find name 违规 0） |
| `pnpm -F @dsh/renderer build` | PASS（含 admitCue/stopCue/getCueState 导出） |
| `node tools/acceptance/m1-smoke.mjs --selftest` | PASS（exit 0） |

## 四、验收入口（overlay `l2d_cue`）与真机命令

- `l2d_cue { cue:{channel,operation,target?,value?,durationMs?,priority?,interruptible?}, runId? }`
  → renderer `admitCue`，回执 `{ok, cue, admission, arbitration:{admitted,rejected,entryId,cueId}}`；
  renderer 缺 `admitCue` → `{ok:false, reason:'not-supported'}`；flag 关 → `{ok:false, reason:'cue-disabled'}`。
- `l2d_cue_stop { selector?:{channel?,target?,all?} }` → `stopCue`（target→overlay），回执 `stopped`。
- `l2d_get_state` 的 `diag.cue` = `getCueState()`（enabled/channels/overlay），与 `diag.gesture` 并列。

真机执行（前置：被测 renderer 构建中 `embodied.timeline` 与 `embodied.cue` 均开；否则 U10/U11 记 SKIP）：

```bash
node tools/acceptance/m1-smoke.mjs --origin http://127.0.0.1:3081 \
  --m1-flag on --allow-write --m1-cue --m1-gesture \
  --readiness-wait 30000
```

- U10 正例：tilt hold 0.5/1500ms → `admission.accepted` + `diag.cue.channels` 含 tilt；2s 后不含（到期释放）。
- U11 负例：未知 channel → `unknown-channel`；`interruptible:false` → `not-interruptible`，零写值。

## 五、风险与已知限制

1. **不做平滑过渡**：cue 持有期间通道值覆盖常规合成（注视/拖拽），clear 后下一帧
   立即交还，没有 weight 渐入渐出（REFERENCE §3.2 所述可选优化，v1 不做）。
2. **overlay 单槽**：Cubism `setExpression` 同一时刻只有一层，多 cue 表情是「后来者替换」，
   不叠加；clear target 只关闭同名层（target 不匹配时保留当前层）。
3. **transition 只占域**：v1 cue 无曲线引用，`transition` 校验时长后只登记冲突域，
   不产生写值（曲线播放仍走 keyframes 资产）；首批注释同口径。
4. **overlay/clear 的 channel 仍须是已注册通道**：编译层对 channel 统一查绑定表（域名锚点），
   因此 overlay 也要带一个词表 channel（如 `gaze`），这是 v1 契约而非缺陷。
5. **plugin 工具面未开**：本批不碰 `lib/index.js`（禁令域），`admitCue` 只到 renderer 导出
   （`window.DSH_L2D.admitCue`）；HTTP/工具接入留给后续 host 批次。
6. **runId 不是 fencing**：仅透传/按 runId 收窄释放；渲染端 epoch fencing 仍是既有
   `motionEpoch`（d3 的消费者租约在服务端），本批不新增第二套 fencing。
7. **真机未验**：本批交付为纯函数单测 + 类型 + 构建 + smoke selftest；真机观感
   （倾斜/眼神/表情切换）需在集成日按 m1-smoke 通道复核（H4 人工项）。
