# OACA 落地评估 —— 离线动作编译架构（替代双 Session 运行时协作）

- 日期：2026-11-13
- 触发：用户提出 OACA 方案，明确"LLM 是编译器，不是 Runtime"，放弃常驻 Action Agent
- 结论：**采纳**。与仓库现状高度吻合，且不必推翻已交付工作；但方案中 4 处假设与真实代码不符，需按本文修正
- 状态：评估完成，未开始 OACA 代码实施

---

## 1. 采纳判定

| 方案要点 | 判定 | 依据（真实代码） |
|---|---|---|
| 运行时不再调用 LLM | **采纳，且已有基础** | `runNodegraph` → `createInboxActExecutor` → `aiInbox.l2d_act` → `/ai/call` → overlay，全程无 LLM |
| 动作执行是确定性的 | **已成立** | `compileGraphToSegments` 纯函数编译；`action-plan.mjs` 纯函数出关键帧轨道 |
| Action Session 改成一次性编译任务 | **采纳** | 与已交付 PR-1 的 `action_session_id` 天然相容，改为"编译任务会话"即可 |
| 新增 Action Manifest | **采纳，确实是最大缺口** | 全仓 `manifest` 仅出现在 workspace-agent（无关）；无动作注册/触发语义层 |
| 编译期四层校验 | **采纳，三层已有、第四层半有** | L1 `validateNodegraph`；L2 `allowedFromLive2dIds` + Capability Profile；L3 `safety-guard.checkInjectionBatch`；L4 仅 `tools/runtime-probe` 手工执行，未接自动化发布门禁 |
| 运行时动作仲裁（Scheduler/Conflict/Mixer） | **部分已有，需归口** | 已有 `param-ownership` / `param-host-policy` / `keyframe-admission` / `shared-arbitration` / `facial ParamMixer`，但分散在 renderer/core，无统一 Action Scheduler |
| 不重建 Actions Lib | **同意** | `action_chains`/`action_steps` 已存在，新增表须 additive |
| requestId 去重不能只靠内存 | **同意** | `bridge_actions.request_id` 已是主键（v8），重启 `recoverFromRestart` 写 interrupted，可直接复用 |

---

## 2. 与真实代码不符的 4 处（必须修正后再施工）

| # | 方案假设 | 真实情况 | 处置 |
|---|---|---|---|
| A1 | "`/ai/call` 内部可能转发给 LLM，需审计" | **审计完毕：不转发**。`/dsh-l2d/ai/call` 只是 Runtime 动作入口（`index.js:1080`），入 `aiInbox` 后由 overlay 执行。真正的运行时 LLM 在 `POST /dsh-l2d/ai-action.json`（点击 `clickMode='api'`，`overlay.js:2898`）与 MCP 工具 `l2d_graph_ai_plan`（`nodegraph-planner.mjs`） | 把 `clickMode='api'` 标为**运行时 LLM 例外**，OACA 下默认禁用或明确 opt-in；`l2d_graph_ai_plan` 归入"编译期/用户主动重编译"，不计入运行时 |
| A2 | 动作图存 SQLite（`compiled_actions.graph_hash`） | 节点图目前**存文件** `$DSH_HOME/l2d-nodegraphs/*.json`；SQLite 只有 `action_chains`（另一套动作链语义） | 新增 `compiled_actions` 表时，`graph_id` 指向文件名 + `graph_hash` 做内容指纹；**不搬迁**节点图存法（搬迁属受保护范围） |
| A3 | Capability Profile 每模型一份、含 writable 位 | 已有 `capability_profiles` 表 + `tools/capability-scan/profile.<modelId>.json`；`ownership: direct/requires-own/unsupported` 比 `writable` 更细（物理输出必须 own） | Manifest 的 `parameters` 校验必须走 `ownership`，不能只看 `writable`，否则物理参数会被误判可写 |
| A4 | 动作优先级 0–100、interruptible 布尔 | 节点图已有 `NODE_PRIORITIES = BACKGROUND/NORMAL/FORCE`（`nodegraph.mjs:42`） | Manifest 的 `priority` 映射到三档枚举，不新造第四套数值优先级 |

---

## 3. 目标架构（贴合现有模块）

```
阶段 A · 编译（LLM 唯一出现的地方，一次性）
  模型导入 (model-import.mjs)
    → capability-scan / Capability Profile          [已有]
    → nodegraph-planner.buildAiPlanPrompt + llm     [已有：进程内 LLM 通道]
    → 四层校验
        L1 validateNodegraph                        [已有]
        L2 allowedFromLive2dIds + ownership         [已有]
        L3 safety-guard.checkInjectionBatch         [已有]
        L4 nodegraph 试执行 + runtime-probe         [半有：需接成发布门禁]
    → 原子发布：graph 文件 + action_manifests + compiled_actions（v12）  [新增]

阶段 B · 运行（0 LLM）
  事件（click / pointer / 定时 / 快捷指令）
    → TriggerRouter：event.type → actionId（读 Manifest）      [新增]
    → ActionRouter：getPublishedAction(modelId, actionId)
                     → capabilityRevision 比对
                     → 参数按 Manifest schema 校验
                     → enqueue(requestId)                      [新增]
    → ModelActionQueue（去重/超时/取消/重启恢复）               [已有]
    → HttpActionExecutor → /ai/call → aiInbox                   [已有]
    → runNodegraph → compileGraphToSegments → 关键帧            [已有]
    → overlay → Cubism Renderer                                 [已有]
```

**边界一句话**：编译期允许 LLM；运行期任何路径都不得产生 prompt 或 LLM 调用。

---

## 4. PR 计划（对齐用户四阶段，落到真实文件）

| PR | 名称 | 真实交付 | 依赖 |
|---|---|---|---|
| **OACA-1** | Action Compilation Pipeline | `action-compiler.mjs`（新）：capability→prompt→LLM→四层校验→原子发布；L4 接 `tools/runtime-probe` 做发布门禁；失败不覆盖旧版本（`status=superseded` 语义） | 无（复用 nodegraph-planner / validateNodegraph / safety-guard） |
| **OACA-2** | Action Manifest & Registry | v12 迁移：`action_manifests`、`compiled_actions`；`action-manifest-repo.mjs`（新）；`graph_id`↔文件、`graph_hash` 指纹、`capability_revision` 可追踪；重复导入幂等、过期动作可识别 | OACA-1 |
| **OACA-3** | Deterministic Bridge Router | `action-router.mjs` / `trigger-router.mjs`（新）：动作 ID 查找、参数校验、复用 `bridge_actions` 主键去重；**不依赖 Chat/Action Session**；离线可执行已编译动作 | OACA-2 |
| **OACA-4** | Runtime Arbitration & Isolation | 归口 `action-scheduler.mjs` / `conflict-resolver.mjs`（新，薄封装既有 ownership/keyframe-admission/arbitration）；LLM 隔离审计（关 `clickMode='api'` 默认路径）；真机 E2E + 0 推理断言 | OACA-3 |

每个 PR 独立分支、独立验收，不自动 merge。

---

## 5. 已交付工作如何处置

| 交付物 | 处置 | 理由 |
|---|---|---|
| PR-1 `feat/pr1-action-session`（`dd3cd59`，schema v11 + `action_session_id` + CAS 并发） | **保留** | 纯加列、无行为变更；`action_session_id` 直接作为"一次性编译任务会话"标识复用；并发 CAS 与孤儿上报对编译任务同样必要 |
| `control_session_id` | 保持只读兼容 | 与 OACA 无冲突 |
| PR-2（消除隐式 Agent 推理） | **保留且升级为核心前提** | OACA 的"0 运行时 prompt"指标直接依赖它；已实现默认关 + opt-in + status 不触发 |
| 双会话架构（Chat + 常驻 Action Session） | **放弃** | 用户明确改判；`sessionKind='logical'` 的事实记录保留，避免误读为已实现 |

> 注：PR-1 的 README/JSDoc 中"两个活动会话"表述需在 OACA-1 落地时改为"Chat 会话 + 编译任务会话（按需一次性）"，避免文档与架构再次漂移。

---

## 6. 验收指标（可测、可反驳）

| 指标 | 测法 |
|---|---|
| 运行时 LLM 调用 = 0 | 在 `llm-channel` 与 `/ai-action.json` 埋调用计数；跑 30 分钟真实交互（点击/节点图执行/状态变化），断言计数为 0（`clickMode='api'` 除外且须显式开启并单独计数） |
| 运行时 Agent Prompt = 0 | PR-2 已实现：注入计数 controller，断言 `promptCount === bootstrapCount` |
| 动作 100% 经本地校验 | 发布门禁断言：`compiled_actions.status='published'` 的行必须带四层校验结果；运行期 `getPublishedAction` 拒收非 published |
| 离线可执行 | 断网 / 关掉 LLM 凭据后跑已编译动作，E2E 通过（真机 overlay 截图取证） |
| 编译失败不破坏旧版本 | 构造非法 bundle：断言旧 revision 仍 `published`，新 revision 未落库或 `status='rejected'` |
| 模型升级选择性重编译 | 改 capability revision 后，断言兼容动作沿用、失效动作标记 `stale`、仅新增/失效项重编译 |

---

## 7. 风险

| 编号 | 级别 | 风险 | 处置 |
|---|---|---|---|
| O1 | HIGH | 语义模板升级会覆盖用户手改（`templateVersion` 机制，既有行为） | 编译产物与手改图分目录/分 status；重建时保留 `user_modified=true` 的图 |
| O2 | HIGH | `clickMode='api'`、`l2d_graph_ai_plan` 是现存的运行时 LLM 入口，不处理则"0 LLM"指标假通过 | OACA-4 显式隔离并单独计数，验收口径写明"排除项及理由" |
| O3 | MEDIUM | 节点图在文件、Manifest 在库，二者可能不一致（手删文件） | `compiled_actions` 发布时写 `graph_hash`；加载时校验文件存在与 hash 匹配，失配标 `stale` 而非静默执行 |
| O4 | MEDIUM | L4 试执行会真的驱动模型，可能打断用户当前动作 | 发布门禁在独立模型实例/离屏执行，或限定 idle 窗口 + 低优先级 |
| O5 | LOW | 一次编译生成多图，LLM 输出体积与超时 | 复用 `MAX_OPS_PER_CALL` 与现有预算；分批编译、单动作失败不影响整模型（用户已要求） |

---

## 8. 测试前置：清理旧插件构建（用户 2026-11-13 要求）

E2E / 真机验收前必须先下线 DSH 侧的旧插件构建，否则会出现"改了代码但行为没变"的假阴性。

```bash
npm run clean:plugin         # 只列出候选（DRY-RUN，不动文件）
npm run clean:plugin:apply   # 移到 <DSH_HOME>/plugins/.trash-<时间戳>/，可恢复
```

- 工具：`tools/dev/clean-plugin-build.mjs`
- 扫描范围：`<DSH_HOME>/plugins/dsh-l2d*`（含 `.uninstalled-bak`）与 `<repo>/dist/dsh-l2d-*`
- 白名单根目录 + 真实路径校验（防符号链接逃逸）；dev link 符号链接一律跳过
- **不碰**：`*.sqlite` / `l2d-nodegraphs` / `l2d-*.json` / 日志 / 设置（用户数据与工作区绑定）
- 跨盘（D: → C:）自动退化为 copy + unlink，不因 EXDEV 失败

首次执行结果（2026-11-13 19:51）：已下线 `dsh-l2d@0.1.0-preview` 插件备份（997 KB）与旧打包 `dsh-l2d-0.1.0-preview.tgz`（110 KB），两者均保留在回收目录可撤回。

---

## 9. 建议的下一步

**先 OACA-1**（编译流水线），因为它能立刻产出可验证的价值：一次真实的"模型导入 → LLM 编译 → 四层校验 → 原子发布"闭环，且不触碰 Runtime。

开工前需用户确认 2 件事：

1. **L4 试执行的宿主环境**：允许在真实模型上跑（有打断风险），还是先只做离屏/空跑校验、L4 标 `skipped`？（我建议后者：先打通链路，L4 在 OACA-4 接真机）
2. **动作清单来源**：`requestedActions` 用固定清单（head.nod / eye.blink / interaction.head_poke…），还是从 Capability Profile 自动推导？后者更通用但要先定义"能力→动作"映射表。
