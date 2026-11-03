# M1-SMOKE 就绪门禁：验收基础设施

> 实施：impl-smoke · 验证：Chief（真机双态实测）· 分支 `feat/m1-f2-behavior-loop`

## 一、要解决的问题

上一轮真机验收出现系统性假阴性：消费页 overlay 模型挂载延迟（isReady 长时间 false），
smoke 在模型未就绪时执行写路径 → U1/U7/U8/U9 报 `no-valid-tracks` / `pv null`。事后二分证明
与代码版本无关（pre-d2 基线同样复现），但**验收工具当时无法区分「代码坏」与「模型没起来」**。

结论：就绪判断必须成为验收基建的一等公民，而不是人工等待技巧。

## 二、设计：三层阶梯 + 有上限轮询

```
L0 服务连通    GET /ai/result?id=0 → 200（宿主进程在）
L1 消费者在线   l2d_get_state 限时（3.1s）内有回执（有页面在 poll）
L2 模型就绪    get_state 回执 ready===true（overlay 的 L.isReady()）
```

- 结局分类：`READY` / `MODEL-LOADING`（有回执未就绪）/ `NO-CONSUMER`（无回执）/ `BLOCKED`（L0 不通）
- `waitForReadiness(probeFn, {maxWaitMs, intervalMs})`：硬上限，越界即停，不做无限等待
- 每轮打印进度行（轮次 + 结局 + 已等/上限），收尾打印分层状态块
- **退出码语义**：READY=0，其余=**3**（BLOCKED，与 FAIL=1 区分）——CI 可据此判定"不是代码问题"

## 三、接入

```bash
# 就绪门禁 + 写路径全量
node tools/acceptance/m1-smoke.mjs --origin http://127.0.0.1:3081 \
  --m1-flag on --allow-write --m1-gesture --m1-cue --readiness-wait 30000

# 缺省（不传 --readiness-wait 或显式 0）= 与改动前逐行一致，回归安全
node tools/acceptance/m1-smoke.mjs --origin http://127.0.0.1:3081 --m1-flag off
```

门禁不通过 → 不跑用例、不写状态、exit 3，诊断信息完整输出（哪一层、等了多久、最后一轮结局）。

## 四、真机验证证据（Chief 实测）

| 场景 | 结果 |
|---|---|
| 3081 无页面（消费者不在） | L0 READY → L1 NO-CONSUMER → **BLOCKED exit 3**，54 轮/181.9s 内收敛，未死等 |
| 3081 有页面但模型延迟 | L0 READY → L1 在线 → L2 **MODEL-LOADING** 连续 16+ 轮——正确诊断而非误报 FAIL |
| dev-server 聚焦页签 | L0/L1/L2 **全 READY（318ms）** → 放行，U7-U11 全 PASS |
| 后台页签（节流） | 混合 NO-CONSUMER/ MODEL-LOADING——门禁正确拒绝进场（不再产生假阴性） |

## 五、关键工程知识（本轮沉淀）

1. **后台页签的定时器节流会让 poll 稀疏**（38 轮仅 1 次响应），验收前必须让被测页签处于前台；
   门禁会以 NO-CONSUMER 如实反映，不会假装没事。
2. HTTP 200 / admission 成功 **不等于** 模型动作执行成功——三层阶梯把这两个概念分开。
3. `--readiness-wait 0` 保持旧行为，是回滚路径；新用例（U10/U11）挂在门禁之后。

## 六、遗留

- 宿主页模型挂载延迟本身是环境问题（bot DSH 实例并存 + 多实例 WebGL 压力，二分已定案非代码回归），
  需在 bot 关闭窗口期复测归因；本门禁保证"环境未就绪"永远以 BLOCKED 呈现，不污染代码结论。
