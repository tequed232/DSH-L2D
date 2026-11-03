# M1-d1 独立 QA 报告（qa-d1）

- 复核对象：commit `2002ba4`（feat(M1-d1): Hip 语义控制接入动作面），基线 `b5efef6`
- 复核环境：worktree `D:\Desktop\DSH-L2D-overnight`，分支 `feat/m1-d-overnight`
- 复核人：qa-d1（独立 QA，未参与实施）
- 铁律遵守：未修改任何生产代码；未弱化断言；未伪造真机结果（3081 不可达，如实记 BLOCKED）
- 存档说明：本文件为 qa-d1 唯一写入文件；未执行任何 git commit

---

## 一、复核项清单（结论 + 证据）

### 1. 门禁复跑

| 复核项 | 结论 | 证据（实际执行命令与输出摘录） |
|---|---|---|
| `pnpm test:core` | **PASS** | exit 0；`grep -cE "^\s*(ok\|✔\|✓) "` = **187**（TAP 19 + 自定义 runner 168）；`not ok` = 0；与"168 项"说法一致（自定义 runner 断言数；TAP 文件另有 19 项）。链式 40 个测试文件全绿 |
| hip 用例存在且断言实质 | **PASS** | `semantic-binding.ts:61` 「M1-d1 Hip 族：requires-own + PRE_ONLY → pre 相位」断言 `ownership='requires-own'`、`phase='pre'`、`params=[{id:'HipAngleX',value:0.5}]`、`owns=['HipAngleX','LArm']`；`semantic-binding.ts:72` 三轴全判 pre + owns 排序断言；`posture.ts:92` pre 批 `preIds=['HipAngleX','HipAngleY','HipAngleZ']`、post 批 `!p.id.startsWith('Hip')`、回执 `applied phase='pre'`；`posture.ts:118` 既有通道零漂移（direct 仍 pre / 非 Hip requires-own 仍 post）；`capability-profile.ts` controls=59 + 三通道 sourceId/ownership/status 逐项断言；`motion-contract.ts` `MOTION_CONTRACT_VERSION===4`、词表 23 |
| `pnpm test:types` | **PASS** | exit 0；`PASS（Cannot find name 违规 0；白名单命中 41 个：Live2DCubismCore）` |
| `pnpm -F @dsh/renderer build` | **PASS** | exit 0；`✓ 114 modules transformed` → `renderer.js 331.28 kB`，`✓ built in 133ms`（MIXED_EXPORTS 为预存警告，非本次引入） |
| 构建产物一致性 | **PASS** | build 后 `git diff --ignore-cr-at-eol --stat`（assets/renderer.js）为空 → 产物与提交内容一致；`getAgentOwned();for(let i of r||[])if(!n.includes(i))...`（getInfo owned-merge）确认存在于产物中 |
| m1-smoke 对 3081 | **BLOCKED** | `node tools/acceptance/m1-smoke.mjs --origin http://127.0.0.1:3081` → `FAIL T0 连通性 — fetch failed`、`0 PASS · 4 SKIP · 1 FAIL`、exit 1。netstat 无 3081 监听、`curl --noproxy '*'` 返回 000。**真机 T1=59 未复验，不作任何声称** |
| m1-smoke selftest（不碰真机） | **PASS** | `node tools/acceptance/m1-smoke.mjs --selftest` exit 0：6 组全过——判定辅助 14 项、mock 宿主真用例路径（U1..U6 全 PASS 含「U5 Hip pre 让位 PASS」）、flag off 整组 SKIP、未 allow-write 写路径保护、占位依赖 SKIP、坏画像 FAIL 路径（T1 FAIL 不被 SKIP 吞掉） |

### 2. 断言强度审计（§五 禁止弱化断言）

| 复核项 | 结论 | 证据 |
|---|---|---|
| semantic-binding 相位判定复用单一事实源 | **PASS** | `semantic-binding.ts` diff：`import { PRE_ONLY_PARAMS } from './motion-intent.ts'`；`const preOnly = ids.length>0 && ids.every(id=>PRE_ONLY_PARAMS.has(id)); const phase = ownership==='requires-own' && !preOnly ? 'post' : 'pre'`。`motion-intent.ts:36-41` 的 `PRE_ONLY_PARAMS` 含 `HipAngleX/Y/Z`，与 `tools/ownership-spec/reference.mjs` 同源。**未复制第二份名单** |
| posture pre/post 分批三面覆盖 | **PASS** | 分批改按 `write.phase`（`posture.ts:94-97`）。`posture.ts:92-116` 断言三面齐：① Hip 进 pre 批（`preIds` deepEqual 三参数）② post 批不含（`!p.id.startsWith('Hip')` 逐项 ok）③ 既有通道零漂移（独立用例 `posture.ts:118`） |
| m1-smoke U5 真用例断言链 | **PASS** | 五环全有实断言且都进入最终 verdict（`!wrongPhase && preGrew && held && released`），非仅日志：① 语义解析 `resolveControlForParam`（画像无映射 → 诚实 SKIP 非 FAIL）② `appliedOk` = 每参数 `applied.find(id && phase==='pre')` ③ `ownedOk` = owned.includes 三参数 + skipped 为空 ④ `preGrew = pw1[0] > pw0[0]`（pw pre 上涨）⑤ `held` = 独占窗口两采样 \|pv−0.5\|≤0.05；`released` = 释放后两采样 `driftedFromHold`。附 wrong-phase 字符串检查 |
| overlay.js 双相位 own 批量 + 回滚 | **PASS** | `overlay.js:3865-3881`：pre/post 各自收集后**按相位各一次批量调用** `ownParameters(pPreOwns, d, 'pre')` / `ownParameters(pPostOwns, d, 'post')`，非逐参数循环；同参数两相位冲突按 pre 优先去重（注释显式）。回滚路径保留：`if (pOwned.length && !pApplied.length && L.releaseParameters) { L.releaseParameters(pOwned); pOwned=[]; }`（overlay.js:3899） |
| selftest diff 未弱化断言 | **PASS** | selftest 改动为 mock 画像/回执与契约 59 同步 + 新增 U5/U6 断言项；check 数量只增不减；「修复基线本就红的 4 项」是修 mock 数据而非放宽 check |

### 3. 边界合规

| 复核项 | 结论 | 证据 |
|---|---|---|
| variant 参数不进 sourceId | **PASS** | `bindings.mjs`：`'torso.hip': DIRECT([/^HipAngleZ$/])` 等三条全部精确锚定规范名；`capability-profile.ts` 测试显式断言「变体参数 HipAngleX2/YUP/DOWN 等绝不进 sourceId」（sourceId 逐通道 equal） |
| 未改 PhysicsGate / injector | **PASS** | `git show 2002ba4 --stat` 无 physics-gate/injector 文件；renderer 源码仅 `index.ts` getInfo 新增**只读**观测（调用 injector 现有 API `getAgentOwned()`，未改其实现） |
| 未新增第二套写入路径 | **PASS** | overlay.js 改动仅在既有 `l2d_posture` 分支内做 own 分相位分组；写仍走 `L.setParameters` 既有 pBatch |
| contract version bump | **PASS** | `MOTION_CONTRACT_VERSION` 3→4；`run.mjs` 契约值改为 `MOTION_CONTRACT_VERSION` 引用（消除了硬编码复写隐患，正向改进） |

## 二、发现的问题（按严重度）

**BLOCKER：无。 MAJOR：无。**

MINOR：
1. **U5 画像依赖 SKIP 而非 FAIL**：真机跑 U5 时若画像未重扫到 59 通道，`resolveControlForParam` 返回 null → U5 记 SKIP（诚实降级），不会 FAIL。验收有效性依赖 T1 先 PASS；建议 overnight 执行顺序强制 T1 → U5 并在报告中同时呈现两项结论。
2. **wrong-phase 为弱断言**：`JSON.stringify(receipt).includes('wrong-phase')` 是字符串包含式检查，若宿主改用其他错误措辞则漏检。主链有 phase==='pre' 断言兜底，故降级为 MINOR。
3. **pw 上涨归因弱**：`preGrew` 只要求 pre 计数严格上涨，pw 计数器全宿主共享，环境活动（已知 Edge 旧页面干扰）理论上可贡献假阳性。U5 单项看归因不足，但与 held/released/pv* 联合判定后风险可控。
4. **assets/renderer.js 提交内 stat 为 2/2 行 EOL 归一化**：`--ignore-cr-at-eol` 下内容零差异，产物真实变更实为 rebuild 同步（owned-merge 已确认在产物中）。建议后续提交统一 .gitattributes EOL 策略，避免 stat 噪声。

NOTE：
- commit message 称「m1-smoke SKIP 模式 0 FAIL」；qa-d1 实测**无宿主**形态为 `0 PASS · 4 SKIP · 1 FAIL（T0 连通性）` exit 1——两者所指场景不同（宿主在线 flag off vs 宿主离线），不构成矛盾，记录实测形态备查。

## 三、d1 真机证据的独立可信度评级

**评级：中高（约 0.8 / B+）——足以支撑「Hip 动作面入口 + 语义链路打通」的 M1-d1 验收结论；不足以单独证明「真实物理活跃场景下 PhysicsGate 让位生效」（该结论仍以 H3 目视为准，已列需人工）。**

理由：

证据链各环有独立观测面，结构完整：
1. 回执层：`applied` 含 HipAngleX=0.9/HipAngleZ=−0.6 且 `owned` 双参数 → 宿主侧 own 登记成功；
2. 观测层：pv 读到 `HipAngleX=0.900* HipAngleZ=-0.600*`——`*` 后缀由 d1 新增 getInfo owned-merge 产生，**只有出现在 `injector.getAgentOwned()` 表中的参数才带 * 号**，归因锚点真实；
3. 值匹配层：0.9/−0.6 为本次测试专用非常规值，3 次采样与写入目标三位小数精确一致，其他来源撞值的先验概率极低；
4. 生命周期层：释放后 owned=0、pv 观测项消失，与 own 到期自动释放机制一致。

方法论漏洞（评级扣分点）：
- **pv 是 renderer 内部状态而非外部观察**：`getParameterValueById` 读的是写入后的内部参数值，「写入即读回」天然精确一致，不能单独证明物理让位生效（缺少「物理活跃基线」反事实：若模型待机时 Hip 本就静止，无让位时参数也可能保持写入值）；
- **0.9/−0.6 归因残余风险**：已知环境干扰（Edge 旧页面抢 /ai/poll）。但旧页面用重扫前画像（无 torso.hip 语义通道），经语义链写 Hip* 的路径不存在；直接裸参数写入需恰好命中同值，概率低。残余风险主要为同 renderer 多宿主连接时 own 表共享的场景，lead 记录中未见此形态；
- **pw 计数污染**：真机记录未列 pw 前后值，pre 上涨一环在真机侧归因弱（U5 脚本侧有联合判定兜底）；
- **owned=0 只证明持有解除**，不直接证明物理重新接管。

## 四、遗留风险

1. H3（裙摆/腿链随 Agent 值动）仍为需人工目视——「让位」的最终视觉证明未闭环；
2. HipAngleZ 正负的视觉方向含义未标定（lead 已注明待专项目视）；
3. Edge 旧页面 poll 抢夺污染回执是 M1-d3 范围，当前靠验收脚本重试规避，长期需修；
4. contract 56→59 后，若任何分支实例画像未重扫，T1 会 FAIL（这是设计内 fail-closed，但 overnight 多实例并行时需保证画像重扫先行）。

## 五、总体结论

**M1-d1 验收：PASS（附上述 MINOR 项与真机证据可信度附注）。**
门禁四项中三项 qa-d1 本机实测 PASS，真机 smoke 因 3081 不可达记 BLOCKED（未伪造）；断言强度、单一事实源、边界合规全部达标，未发现弱化断言或越界改动。
