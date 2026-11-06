# Phase 1 — ACTIONS-JSON-INGESTION-RULES.md

> 配套：`MOTION-DATA-SCHEMA.md`（表结构）、`ARCHITECTURE.md`、`WORKSPACE-RESPONSIBILITIES.md`、`MCP-API-CONTRACT.md`、任务书 §2/§3/§6
> 状态：待用户审阅。
> 职责：定义 **Actions JSON 的文件规范与入库（persist）规则**——什么样的 JSON、放哪里、谁能写、过哪些门禁、失败怎么办。表结构见 MOTION-DATA-SCHEMA，本文不重复。

---

## 1. 术语与范围

| 术语 | 含义 | 落点 |
| --- | --- | --- |
| **chain_json** | 与模型无关的语义动作链 JSON（数据列） | `action_chains.chain_json`（SQLite，**唯一事实源**） |
| **Actions JSON 文件** | chain_json 的落盘快照（可导出/可审计/可迁移） | `json_address` 指向的 `.json` 文件 |
| **入库（ingest/persist）** | 通过全部校验门禁后，把动作知识原子写入 SQLite + 落盘快照 | 仅经 Actions Lib Repository |

**规则 R0（事实源）**：SQLite 是唯一事实源；Actions JSON 文件是派生快照。两者以 `content_sha256` 互相校验。读取执行链路只信 SQLite；文件用于审计、迁移、diff 与人工审阅。

---

## 2. Actions JSON 文件规范

### 2.1 顶层结构（schema_version `1.x`）

```jsonc
{
  "schemaVersion": "1.0",
  "motionId": "uuid-v4",
  "semanticKey": "greet.wave",                  // 小写点分命名空间，见 §2.3
  "description": "挥手打招呼",
  "emotion": "happy",
  "expression": "smile",
  "gaze": "at-user",
  "bodyLanguage": "right-hand-wave",
  "confidence": 0.87,
  "status": "validated",                        // 快照导出时的状态，见 §6
  "capabilityRevision": "registry.json@<sourceCommit>",
  "actionChain": [                              // 与 §2.2 步骤规范一致
    { "index": 0, "kind": "expression", "params": { "expressionId": "smile" },
      "durationMs": 800, "admission": "keyframe" },
    { "index": 1, "kind": "pose", "params": { "rightArmAngle": 45 },
      "durationMs": 600, "admission": "step" }
  ],
  "provenance": {                               // 溯源块（R7 强制）
    "assets":    [{ "assetId": "…", "contentHash": "sha256:…" }],
    "analyses":  [{ "analysisId": "…", "modelName": "…", "analyzedAt": "…" }],
    "learningJobId": "…"
  },
  "validation": {                               // 门禁结论（R8 强制）
    "schema": "pass", "semantic": "pass",
    "capability": "pass", "conflict": "pass",
    "reportRef": "<validation_report 记录 id>"
  },
  "contentSha256": "sha256:…",                  // 本文件（不含本字段）的哈希
  "createdAt": "2026-11-04T12:00:00Z",
  "updatedAt": "2026-11-04T12:00:00Z"
}
```

### 2.2 步骤（actionChain[]）字段规范

| 字段 | 必填 | 约束 |
| --- | --- | --- |
| `index` | ✅ | 从 0 连续递增，不得跳号/重复 |
| `kind` | ✅ | 枚举：`expression / motion / pose / look / keyframes`（与 `action_steps.kind` 一致） |
| `params` | ✅ | 对象；仅含 Capability Registry 已登记的参数键；数值必须在登记的 `[min,max]` 范围内 |
| `durationMs` | ✅ | 正整数；`keyframes` 类步骤须覆盖其关键帧总时长 |
| `admission` | ✅ | `keyframe / step / gate`；决定 Execution Manager 的准入门（复用现有 keyframe-admission 语义） |
| `pairing` | ⛔ 默认无 | 开→关配对动作（如 eye-open/close，PAIRED_CLOSES 风险 R4）必须成对出现且索引连续；校验门禁 G4 检查 |

**规则 R1**：`actionChain` 禁止出现任何具体模型的参数 ID 字面量（如 `ParamAngleX`）。参数落点必须由 Model Adapter 在执行期经 `motion_model_bindings` 映射。违例 = G2 语义门禁失败。

### 2.3 semantic_key 命名规则

- 格式：`<domain>.<action>[.<qualifier>]`，全小写、点分、`[a-z0-9_]`。
- 示例：`greet.wave`、`react.shy.avert-gaze`、`idle.breathe`。
- 同名不同版：`semantic_key` 相同、内容不同 → 走版本递增（§7），**不允许**靠改 key 制造第二份。

### 2.4 json_address 落盘规则

- **规则 R2（路径约定）**：`<dataRoot>/motions/<yyyy>/<mm>/<motionId>.v<version>.json`。`dataRoot` 默认 `$DSH_HOME/actions-lib/`，可配置但禁止指向仓库源码目录或现有 JSON 持久化文件所在目录（边界见 MOTION-DATA-SCHEMA §5）。
- **规则 R3（文件不可变）**：一个版本一个文件，写入后永不修改；修订 = 新版本新文件，旧文件按 §7 处理。
- 编码 UTF-8（无 BOM）、LF 换行、格式化 2 空格缩进（保证 diff/审计友好）。
- 文件名即 `motionId.v{version}.json`，与 DB 记录可互查。

---

## 3. 唯一写入口（规则 R4）

| 主体 | 对 Actions JSON / SQLite 的权限 |
| --- | --- |
| **Actions Lib Repository** | **唯一写入者**（`createMotion / newVersion / deprecate / recordExecution`） |
| Workspace 2 Motion Learning | 只能调用 Repository API（经 Workspace Task Contract），禁止直写文件/DB |
| Workspace 3 MCP Runtime | 只读检索 + 经 Execution Manager 写 `execution_history`（唯一例外，仍走 Repository） |
| Workspace 1 Chat Orchestrator | 零写权限 |
| MCP 工具 | 零直写；`motion_learn` 只是提交学习任务 |

**规则 R4**：任何代码路径绕过 Repository 写 `chain_json`/`actions-lib.sqlite`/`motions/` 目录 = 违例，Phase 7 验收以 grep + 依赖图核实。

---

## 4. 入库门禁（五门顺序，全过才入库）

按序执行，**任一失败即终止并在 `validation_report` 留痕，不得伪造通过**：

| 门 | 名称 | 校验内容 | 失败码 |
| --- | --- | --- | --- |
| **G0** | 完整性与去重 | 溯源块完整（≥1 asset + ≥1 analysis，R7）；素材 `contentHash` 与库内一致；`semantic_key` 冲突判定（§8） | `PROVENANCE_MISSING` / `ASSET_HASH_MISMATCH` / `SEMANTIC_KEY_CONFLICT` |
| **G1** | Schema 校验 | 本文 §2 全部字段/枚举/类型；`index` 连续；未知 `kind` 拒绝；`schemaVersion` 主版本可识别 | `SCHEMA_INVALID` / `SCHEMA_VERSION_UNSUPPORTED` |
| **G2** | 语义校验 | R1：无模型参数 ID 字面量；步骤序列在时间/时序上自洽（如 look 先于 gaze 依赖）；`pairing` 成对（R4 风险） | `SEMANTIC_INVALID` / `PAIRING_BROKEN` |
| **G3** | 模型能力校验 | 经 `motion_model_bindings` + Capability Registry：每步 `params` 键已登记、值在范围内、能力未 `excluded`/`unregistered`（fail-closed，呼应 R6） | `CAPABILITY_UNREGISTERED` / `PARAM_OUT_OF_RANGE` |
| **G4** | 冲突与安全校验 | 步骤间参数所有权冲突（param-ownership）；与执行中动作的资源冲突预判；写通道唯一性（最终仍只经 ParamInjector） | `PARAM_OWNERSHIP_CONFLICT` / `RESOURCE_CONFLICT` |

**规则 R5（门禁顺序固定）**：G0→G4 必须按序短路；前门未过不得跑后门（避免无意义的多模态/能力重复推理）。

---

## 5. 入库事务与原子性（规则 R6）

一次入库 = 一次 Repository 事务，步骤固定：

1. 校验通过后，先把 Actions JSON 写临时文件 `<file>.tmp` → `fsync` → 原子 `rename` 到 `json_address`；
2. 开启 SQLite 事务（WAL）：写 `motion_definitions`（status=validated）+ `action_chains`（chain_json、validation_report）+ `action_steps` + `motion_sources` + 更新 `learning_jobs.state=persisted`；
3. 事务提交后再补写快照 `contentSha256` 一致性核对（失败 → 删除快照文件并回滚状态为 `planned`，记 `PERSIST_VERIFY_FAILED`）。

- 崩溃恢复：以 `learning_jobs.state` 为准续跑，已过 G0–G4 的中间结果（analysis/plan）一律保留，禁止重头再调多模态模型（任务书 §1 工作区 2 要求）。
- 禁止"先写 DB 后写文件"之外的其他顺序；禁止双写漂移（动作知识只进 SQLite，见 MOTION-DATA-SCHEMA §5）。

---

## 6. 状态机与快照一致性

```
draft → analyzing → planned → validated → deprecated
                      ↓ (G0–G4 任一失败)
                   rejected
```

- **规则 R7**：只有 `validated` 状态的动作允许：①被 `motion_execute` 检索命中；②导出 Actions JSON 快照。`draft/analyzing/planned/rejected` 一律不落 `json_address` 文件（避免半成品被外部消费）。
- `deprecated`：可保留快照文件供审计，检索默认过滤。
- 快照内 `status` 字段是导出时刻的记录，不参与执行判断；执行判断只看 DB。

---

## 7. 版本与不可变性（规则 R8）

- `action_chains` 行一旦写入即**不可变**（UPDATE 禁止；纠错 = 新版本）。
- 修订流程：Repository.`newVersion(motionId, chain, reason)` → 重跑 G0–G4 → `motion_definitions.version += 1` → 旧版本自动置 `deprecated`（保留供回滚）→ 新快照文件落盘。
- `execution_history` 通过 `chain_id` 精确指向执行时的版本，保证事后审计能还原"当时执行的是哪条链"。
- `schemaVersion` 主版本升级须走 `schema_migrations` 登记 + 存量快照批量迁移脚本；读取端遇未知主版本 **fail-closed**（拒绝执行，不猜测兼容）。

---

## 8. 去重与冲突规则（规则 R9）

| 场景 | 处理 |
| --- | --- |
| 同一素材重复导入（`content_hash` 相同） | 复用 `motion_assets` 记录，不重复建行；`learning_jobs` 标记 `deduplicated` |
| `semantic_key` 已存在且语义相同（分析一致、链等价） | 拒绝新建，返回已有 motion（幂等入库） |
| `semantic_key` 已存在但语义/链不同 | 走 R8 新版本流程，`validation_report` 记录差异摘要 |
| 多图库学习出同一动作 | 以 `confidence` 高者为新版本候选；低者仅在 `motion_sources` 追加素材关联，不覆盖 |

---

## 9. 拒绝与失败保留（规则 R10）

- G0–G4 的每次失败必须写 `validation_report`（结构化：门、错误码、证据、时间、capabilityRevision），关联到 `learning_jobs.error_json`。
- `rejected` 动作的 analysis/asset 记录**永不删除**（审计与二次学习需要）。
- 分析失败 ≠ 空记录：必须保留错误信息与已产生的中间产物，**不得伪造成功**（任务书 §6 硬性要求）。
- 学习侧失败不产生任何 `json_address` 快照文件。

---

## 10. 落实阶段映射

| 规则 | 实施阶段 |
| --- | --- |
| §2 文件规范、§4 G0–G2、§5 事务、§7 版本、§8 去重、§9 拒绝保留 | **Phase 3 — Motion Learning**（Repository + Learning） |
| §4 G3–G4（能力/冲突门禁） | **Phase 4 — MCP Runtime**（Capability Registry 运行时接入后闭环） |
| R4 唯一写入口核查、R7 快照可见性 | **Phase 6 — Legacy Replacement / Phase 7 E2E 验收** |

## 11. 验收核对清单（并入 ACCEPTANCE-TESTS）

- [ ] 每条 `validated` 动作：SQLite 行、action_steps、motion_sources、快照文件、`contentSha256` 五者一致。
- [ ] 注入含 `ParamAngleX` 字面量的链 → G2 拒绝且 `validation_report` 留痕。
- [ ] 注入超范围参数 → G3 拒绝，`PARAM_OUT_OF_RANGE`。
- [ ] PAIRED_CLOSES 单边链 → G2 拒绝，`PAIRING_BROKEN`。
- [ ] 重复 semantic_key 幂等返回；不同链走新版本且旧版 deprecated。
- [ ] 事务中途 kill 进程 → 重启后 `learning_jobs` 续跑、无半成品快照、无孤儿 DB 行。
- [ ] 全仓库 grep：除 Repository 与 Execution Manager（execution_history）外无任何 `actions-lib.sqlite` 写点。
