# Phase 1 — MCP-API-CONTRACT.md

> 配套：`docs/architecture/ARCHITECTURE.md`、`docs/PHASE0-REPOSITORY-AUDIT.md` §4
> 状态：待用户审阅。

---

## 1. 工具集合（任务书 §8，至少 9 个）

| 工具 | 用途 | 权限约束 | 默认超时 |
| --- | --- | --- | --- |
| `motion_search` | 语义检索候选动作 + 置信度 + 匹配理由 | 只读 | 5000ms |
| `motion_get` | 取单条动作定义/动作链/状态 | 只读 | 3000ms |
| `motion_learn` | 提交图库学习任务（触发 W2） | 写（学习） | 异步（返回 accepted） |
| `motion_learning_status` | 查询学习任务状态 | 只读 | 3000ms |
| `motion_execute` | 检索→校验→执行（触发 Execution Manager） | 写（执行） | 异步（返回 accepted） |
| `motion_execution_status` | 查询执行任务状态 | 只读 | 3000ms |
| `motion_cancel` | 取消执行/学习任务 | 写（取消） | 3000ms |
| `model_capabilities` | 查询模型能力画像 | 只读 | 3000ms |
| `model_capability_validate` | 校验动作链与模型兼容性 | 只读 | 5000ms |

> 所有工具须有显式 input/output Schema（JSON Schema / Zod）、错误码、超时策略。命名沿用现有 `l2d_*` 风格，但**不再依赖旧固定 choreography 预设**。

---

## 2. 工具 Schema 草案

### 2.1 `motion_search`
```json
{
  "input": {
    "intent": { "semantic_key": "string", "emotion?": "string", "gaze?": "string" },
    "model_id": "string",
    "top_k?": "integer (1..10, default 3)"
  },
  "output": {
    "matches": [
      { "motion_id": "string", "confidence": "number", "reason": "string", "status": "string" }
    ]
  },
  "errors": ["MOTION_NOT_FOUND", "MODEL_UNKNOWN", "INVALID_INTENT"]
}
```

### 2.2 `motion_execute`
```json
{
  "input": {
    "motion_id": "string",
    "model_id": "string",
    "priority?": "BACKGROUND|NORMAL|FORCE"
  },
  "output": {
    "task_id": "string",
    "status": "accepted | rejected",
    "error?": { "code": "string", "message": "string", "reason": "string" }
  },
  "notes": "返回 accepted 后须轮询 motion_execution_status，禁止伪装 completed"
}
```

### 2.3 `motion_learn`
```json
{
  "input": {
    "asset_paths": ["string"],
    "model_capability_id": "string",
    "source_id": "string"
  },
  "output": { "job_id": "string", "status": "accepted | rejected" },
  "errors": ["ASSET_NOT_FOUND", "MODEL_UNKNOWN", "DUPLICATE_SOURCE"]
}
```

### 2.4 `motion_learning_status` / `motion_execution_status`
```json
{
  "input": { "task_id": "string" },
  "output": {
    "status": "queued|running|accepted|completed|rejected|interrupted|failed|timeout",
    "progress?": "number", "result?": "object", "error?": "object"
  }
}
```

### 2.5 `motion_cancel`
```json
{
  "input": { "task_id": "string" },
  "output": { "status": "interrupted|not_found" }
}
```

### 2.6 `model_capabilities` / `model_capability_validate`
```json
{ "input": { "model_id": "string" },
  "output": { "capability_json": "object", "source_revision": "string" } }

{ "input": { "motion_id": "string", "model_id": "string" },
  "output": { "valid": "boolean", "errors?": ["string"], "adapter_json?": "object" } }
```

---

## 3. 错误码约定

| 错误码 | 含义 |
| --- | --- |
| `MOTION_NOT_FOUND` | 无匹配动作链（主对话据此向用户请求参考图库） |
| `MODEL_UNKNOWN` | 模型能力未登记 |
| `INVALID_INTENT` | 意图结构非法 |
| `NOT_VALIDATED` | 动作链未通过验证，不得执行 |
| `CAPABILITY_MISMATCH` | 动作链与当前模型不兼容 |
| `ASSET_NOT_FOUND` | 学习素材缺失 |
| `DUPLICATE_SOURCE` | 重复学习源（哈希命中） |
| `TIMEOUT` | 任务超时未收敛 |

---

## 4. 与现有 MCP 的关系

- **保留转发骨架**：`packages/dsh-l2d-mcp/src/server.mjs` 的 `forward()` + `host-guard.guardAiCall` 纵深防御保留。
- **保留原子能力**：`l2d_set_pose`/`l2d_gaze`/`l2d_get_state`/`l2d_posture` 经 Model Adapter 暴露为底层执行原子，不作为决策入口。
- **移除决策入口**：`l2d_choreograph`（固定预设）与 `l2d_act` 的"决策编排"部分在 Phase 6 关闭；`l2d_act` 的"投递链 + 收 action-done"执行通道经 Model Adapter `runActPlan` 复用。
- **校验逻辑下沉**：`validate.mjs` 的白名单/口型红线/Idle 禁播**逻辑保留**，数据改读 Capability Registry（呼应 R1-R3）。
