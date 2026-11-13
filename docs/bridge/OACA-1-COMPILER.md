# OACA-1 交付说明 `feat(oaca): action compilation pipeline`

- 分支：`feat/pr1-action-session`（延续 PR-1/PR-2 工作线）
- 日期：2026-11-13
- 状态：**实现完成，单测 13/13 通过，真实模型档案上跑通 dry-run；未接真 LLM（本机无 Key）**
- 架构定位：LLM 只在编译期出现一次；运行时不产生 prompt、不调 LLM

---

## 1. 变更文件清单

| 文件 | 变更 |
|---|---|
| `packages/dsh-l2d-plugin/lib/action-compiler.mjs`（新，约 410 行） | 编译流水线：能力档案 → 受约束指令 → LLM → 四层校验 → 原子发布（revision 目录 + `current.json` 指针） |
| `packages/dsh-l2d-plugin/lib/action-compiler.test.mjs`（新，13 项） | 夹具 LLM + 真实校验链；覆盖 L2 skipped 诚实性、L3 参数域、requires-own、原子发布、失败不推进 revision |
| `packages/dsh-l2d-plugin/lib/index.js` | 新增 `POST /dsh-l2d/api/actions/compile`（编译期入口）与 `GET /dsh-l2d/api/actions/bundle`（只读已发布 Manifest） |
| `package.json` | `action-compiler.test.mjs` 挂入 `test:core` |

**零触碰**：Node Editor、Nodegraph Schema v1、Engine、SQLite Actions Lib、Capability Profile、Nodegraph MCP、ModelActionQueue、HttpActionExecutor、`/ai/call`、Overlay、Cubism Renderer。

---

## 2. 设计说明

### 2.1 流水线

```
loadCapabilityProfile(modelId)        ← 真实档案 tools/capability-scan/profile.<modelId>.json
  ↓ capabilityRevision = profileRevision（真实值 r096ba86d2954）
SEED_ACTIONS（5 条，requiredControls 全取自 supported 能力）
  ↓ 每条：aiPlan({instruction})  ← 复用 nodegraph-planner 的 prompt 与 op 校验
  ↓ docFromEditorGraph（strict 绑定 modelId）
四层校验
  L1 validateNodegraph             → pass/fail
  L2 controls.status==='supported' → pass/fail/skipped
  L3 manifest 参数域 + ownership    → pass/fail；requires-own 转运行时约束
  L4 试执行                         → **skipped（deferred-to-oaca-4）**
  ↓ 全部写成功后最后切 current.json（tmp+rename）
rev-<n>/{manifest.json, validation.json, bundle.json, graphs/*.json}
```

### 2.2 三条硬纪律的落地方式

| 纪律 | 实现 |
|---|---|
| LLM 不写生产库 | LLM 只返回 ops；`publishBundle` 是唯一写入口 |
| LLM 不决定校验 | 四层校验全在本地，LLM 输出仅当候选；坏图在 `applyOps` 阶段即被拒 |
| 失败不覆盖旧版本 | 每次发布新 `rev-<n>` 目录；指针最后原子切换；旧目录永不删除（回滚=改指针） |

### 2.3 对用户方案 4 处修正的落实

- **A3 ownership**：`requires-own` 的物理输出参数不进"可写"白名单，而是在 manifest 条目里输出 `requiresOwn: [...]` + 一条 warning，提示运行时必须先 own。这样既不误判为失败，也不会被当成 direct 直接写。
- **A4 优先级**：`normalizePriority()` 把 0–100 归一到 `BACKGROUND/NORMAL/FORCE` 三档，杜绝第四套优先级体系。
- **A2 图存文件**：图仍以文件形式落在 `rev-<n>/graphs/`，manifest 里用 `graphId` + `graphHash` 关联；不搬迁、不入库（入库是 OACA-2）。
- **A1 运行时 LLM**：编译器不碰 `/ai/call`；`clickMode='api'` 与 `l2d_graph_ai_plan` 未改动，隔离属 OACA-4。

### 2.4 诚实性设计（防"假通过"）

- 无能力档案时 L2 是 `skipped` + `reason:'capability-profile-missing'`，**不是 pass**
- L4 恒为 `skipped` + `reason:'deferred-to-oaca-4'`，不谎报已试执行
- 无 LLM 通道 → 直接 `{ok:false, reason:'ai-unavailable'}`，不留半个产物（有断言）
- 全部动作失败 → `publishBundle` 拒绝，`current.json` 不前进（有断言）

---

## 3. 测试命令与真实结果

```bash
node packages/dsh-l2d-plugin/lib/action-compiler.test.mjs
```

```
OACA-1 动作编译流水线
  ✓ 种子表只用真实能力 id，且优先级是三档枚举
  ✓ normalizePriority：数值归一为三档，未知字符串回落 NORMAL
  ✓ capabilityRevisionOf：优先 profileRevision，退化时按控制项稳定哈希
  ✓ L2 诚实性：无能力档案标 skipped，绝不冒充 pass
  ✓ L3：manifest 参数域非法 → 拒绝；requires-own 只转约束不误判失败
  ✓ L2：能力不支持（status=unsupported）→ 该动作拒绝
  ✓ 无 LLM 通道：明确 ai-unavailable，不产生任何 bundle
  ✓ 合法编译：产出 manifest 条目 + 图，且图上 Schema v1 校验通过
  ✓ LLM 给出坏图：该动作 rejected，不影响其它动作，且不落盘半成品
  ✓ 原子发布：rev-1 → rev-2，旧 revision 原样保留，指针指向最新
  ✓ 全部动作失败：拒绝发布，current.json 不前进
  ✓ 动作数上限：超过 MAX_ACTIONS_PER_COMPILE 只处理前 N 个
  ✓ 真实能力档案可加载，且 revision 来自档案本身
action-compiler: 13 项全部通过
```

### 3.1 真实模型 dry-run（假 LLM，不伪造 LLM 能力）

模型 `大肥鱼.dsl2d.2048`，清单来源 `model`（21 个表情 / 7 个动作组），能力档案 `r096ba86d2954`：

```
summary: {"requested":5,"compiled":5,"rejected":0,"capabilityLayer":"evaluated","executionLayer":"skipped"}
head.nod              compiled  L1 pass / L2 pass / L3 pass / L4 skipped
head.shake            compiled  同上
head.tilt             compiled  同上
gaze.look             compiled  同上
interaction.head_poke compiled  同上
```

说明：这证明**真实档案 + 真实清单 + 真实校验链**可跑通；LLM 环节用夹具替代，因此不代表"LLM 编译质量已验证"。

---

## 4. 未完成 / 明确边界

| 项 | 状态 | 说明 |
|---|---|---|
| 真 LLM 编译（DeepSeek） | **未执行** | 本机无 Key；需你在宿主里配好 Key 后调 `POST /dsh-l2d/api/actions/compile` 验一次真产物 |
| 导入时自动触发编译 | 未接 | 当前是显式入口（用户主动编译），符合"不每次启动都调 LLM"；自动触发建议加 `compileOnImport` 开关（默认关） |
| Manifest / compiled_actions 入库 | 未做 | 属 OACA-2（schema v12）；当前是文件 revision 目录 |
| 运行时按 actionId 路由 | 未做 | 属 OACA-3（ActionRouter / TriggerRouter） |
| L4 试执行门禁 | 未做 | `skipped`，属 OACA-4 |

---

## 5. 下一步（OACA-2 预告）

1. schema v12：`action_manifests` + `compiled_actions`（`model_id, action_id` 主键、`graph_hash`、`capability_revision`、`status`）
2. 把 `rev-<n>` 目录同步索引进库，提供 `getPublishedAction(modelId, actionId)`
3. 过期识别：`capabilityRevision` 变化时把不兼容动作标 `stale`，只重编译失效项
4. 若你要导入即编译：加 `compileOnImport`（默认关）+ 导入成功后异步触发，失败不影响导入
