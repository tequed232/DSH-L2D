# Supervisor 测试计划（SUPERVISOR-PHASE0）

> 依据：SUPERVISOR-DECREE.md §7（四目录 + 三条负面测试）与 §8 验收标准。
> 风格对齐既有 test:bridge（node:assert、直跑、node --experimental-sqlite）；状态源用真实 session 事件 fixture，不伪造字段。

## 0. 目录与挂载

```
tests/workspace-observer/   P1（五种关键状态识别）
tests/action-retrieval/     P2（命中已有链不调 LLM）
tests/action-composer/      P4
tests/integration/          P6
```
挂 package.json 新 script `test:supervisor`；fixture：`tests/workspace-observer/fixtures/*.jsonl`（从真实 session 日志裁剪脱敏：tool/call+result、turn/end 各 reason、approval/asked、job/registered|settled、command/run|done）。

## 1. tests/workspace-observer（P1 验收=正确识别五种关键状态）

- obs.state.running：fixture 含未配对 tool/call → running，pendingTool.name 进事件。
- obs.state.error：turn/end reason=error → error；600s 老化后不再上报 error（errorHoldMs）。
- obs.state.succeeded：turn/end completed → succeeded，同 turn 二次轮询不重复（eventId 去重）。
- obs.state.waiting_input.approval：approval/asked 无 decided → waiting_input；waitingAgentId=审批 id。
- obs.state.waiting_input.answer：pendingTool 命中 ASK_USER_RE → waiting_input，**不得代答**（调度指令只允许 request_user_input）。
- obs.state.waiting_subagent.job：job/registered 未 settled → waiting_subagent，taskId=jobId。
- obs.state.waiting_subagent.command：command/run 未 done → waiting_subagent。
- obs.substate.expiry：waiting 子态 ageMs>waitingHoldMs(600s) → 回落 running/idle，不拿旧值调度。
- obs.substate.mutual-exclusion：approval pending 与 running job 并存 → waiting_input 优先（互斥裁决）。
- obs.env.overlay：env-state away → 静默；stale(>30s) → 按 unknown 不影响主状态判定。
- obs.revision.monotonic：同文件追加事件 → revision 单调不减；mtime+size 缓存失效。
- obs.dedup.dispatchOnce：同 (workspaceId,eventId) 重复投递 → 只调度一次（observer_dispatch_log 主键冲突路径）。
- obs.dedup.crash-recovery：登记后进程崩溃重放 → 不漏调度、不重复执行（Outbox 语义）。
- **obs.negative.no-cross-write（负面三）**：Observer 对其他工作区只读——断言全链路无 sessionController.prompt/registry 写调用（mock 注入计数=0），只读文件访问。
- obs.ordering.priority：error(p100) > waiting_input(p90) > waiting_subagent(p75) > succeeded(p40) 并发事件时调度顺序正确。

## 2. tests/action-retrieval（P2 验收=命中已有动作不调 LLM）

- ret.score.weights：五维权重 35/25/20/10/10 单维注入验证（各自独立 0/1 时分数正确）。
- ret.threshold.adopt：score≥0.85 → 直接采用并送 Chain Validator。
- ret.threshold.compat：0.65-0.85 → 查兼容（bindings/近族标签）再判定。
- ret.threshold.unmatched：<0.65 → `{status:'unmatched'}`。
- ret.capability.fail-closed：registry 缺失/损坏 → 全部拒绝（capability-registry fail-closed 既有纪律）。
- ret.history成功率：execution_history 聚合；样本<5 → 中性 0.5，不冒充置信度。
- ret.cache：cacheEnabled 开 → 二次同查询走缓存，命中率指标落库；关 → 直查。
- ret.emotion-routing：emotionRouting.preferTaggedActions 开 → 同分时优先有 approved 标签的动作；needs_review 行永不参与检索。
- **ret.negative.llm-zero（负面一）**：构造命中已有链的请求 → LLM/Composer 调用计数=0（注入 spy 计数器）。
- **ret.negative.no-composer（负面二）**：composition.enabled=false 且未命中 → 返回 unmatched，Composer 模块加载/调用计数=0（不偷偷兜底）。

## 3. tests/action-composer（P4）

- comp.max-nodes：>12 节点拒绝。
- comp.reuse-first：输出节点优先引用已有 Action ID（source:'action_composer'、requires_validation:true 形状断言）。
- comp.no-invented-tools：节点引用未注册 capabilityId → 拒绝（G1 schema 同口径）。
- comp.validate-each-node：每节点过权限/参数/依赖校验；写/删/网络/跨工作区节点触发权限检查分支。
- comp.temp-chain-isolation：新组合写临时 Chain，不覆盖正式 action_chains（两库行数对比断言）。
- comp.two-phase：A 静态验证失败 → 不进沙箱；B 沙箱未过 → 不进可执行集。
- comp.dag-acyclic：depends_on 成环 → 拒绝。

## 4. tests/integration（P6）

- itg.concurrent-workspaces：≥3 工作区并发事件 → 各自独立上下文、队列串行不串工作区（bridge 隔离原则）。
- itg.restart-recovery：kill 后重启 → 未完成动作 interrupted（B17 既有语义），observer_dispatch_log 重放不漏。
- itg.duplicate-events：同事件重复投递×N → 恰好一次调度（与 obs.dedup 联动）。
- itg.settings-switches：observer/composition/localRetrieval/emotionRouting 四开关独立生效（§6 三开关+情绪路由）。
- itg.metrics-persisted：缓存命中率/LLM 调用数/匹配分/Token/链耗时/成功率逐项落库且非虚构（真值来自注入时钟与 spy 计数）。

## 5. 验收判据映射

| 裁决书 §8 | 本计划用例 |
|---|---|
| P1 五种关键状态 | obs.state.*（running/error/succeeded/waiting_input×2/waiting_subagent×2） |
| P2 命中不调 LLM | ret.* + 负面一/二 |
| P3 情绪检索 | ret.emotion-routing + DATA-MODEL §3 resolveExpression 用例（expression_unresolved 降级） |
| P4 Composer | comp.* |
| P5 设置与缓存 | itg.settings-switches + ret.cache |
| P6 集成 | itg.* |
| 三条负面测试 | obs.negative.no-cross-write / ret.negative.llm-zero / ret.negative.no-composer |
