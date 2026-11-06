# 动作库全量入队尝试（BRIDGE-MOUNT v2）— 2026-11-05 23:41

脚本：`tools/bridge-mount/enqueue-all.mjs`（复用 ModelActionQueue + bridge-actions-repo + HttpActionExecutor，
execute 按 `request.args.tool` 分发：act 走事件通道，keyframes 走结果通道）

## 结果：30 个请求 → completed 3 / failed 21 / precheck 拒 3 / 卡 running 6

| 批次 | 请求数 | 结果 |
|---|---|---|
| 动作组开/关（抚胸手、竖手指、狗尾巴草） | 6 | 仅抚胸手打开跑完（EMPTY_CHAIN，1.77s），其余 priority-blocked |
| 表情（21） | 21 | **全部 `priority-blocked`** |
| 动作库语义链 | 3 | **precheck 拒**：轨道名不在 capability controls |

## 失败归因（实测，不是猜测）

1. **`priority-blocked`**：`mapPriority(45)` → `NORMAL`，而当前 act 槽被一条 **FORCE** 占着；
   ActGate 语义是「低优先级不能打断高优先级」，所以 21 个表情全被顶回。链路本身是通的（同等
   FORCE 的 v1/v2/v3 都跑完了）。
2. **`EMPTY_CHAIN`**：渲染端把「动作组已处于目标状态」判为无需动作（抚胸手开的时候再开）。
3. **动作库 3 条链**：轨道 `tailSway / hairSway / earLeft / earRight / angryFlash` 不在本模型的
   capability controls（本模型只有 head/torso/gaze/arm/body 12 个 supported + 4 approximate），
   语义表情 `smile_open_mouth` 无本模型映射。**拒入队是正确的**——硬塞会变成「没有证据的伪动作」。
4. **6 条卡 running**：JSON-RPC 侧对 `l2d_act` 只回 accepted、不带终态；桥的 execute 在等
   action-done 事件，但本批的 `silent:true` 链在多条排队时事件轮询超时，队列按 timeout 处理前
   进程被 SIGTERM 打断，留下 running 行（重启恢复会转 interrupted，不重放）。

## 结论

「把所有动作塞进队列」在**数据层成立**（30 条全部落库 bridge_actions，状态可查），但在**执行层
受两个物理上限约束**：

- 同时只能有一条 act 在槽位；低优先级批量排入会被高优先级占槽顶回——批量须串行等待而不是并发。
- 动作库的 3 条语义链需要先做 Model Adapter 映射（轨道名 → 本模型真实参数）才能入队。

## 下一步（需用户拍板）

- 方案 1：把批量执行改成**低优先级 + 等槽**模式（每次先查当前 act 是否空闲，空闲再入队）。
- 方案 2：先补 Model Adapter，把 3 条语义链映射到 `head/torso/arm` 等真实控制上。
- 方案 3：只保留「入队不执行」——先把 30 条排进队列表作为动作登记，执行交给调用方。
