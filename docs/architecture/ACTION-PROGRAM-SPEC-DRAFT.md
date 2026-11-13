# Action Program 规范草案 v1（触发层 + 运行时参数槽 + 触发映射）

- 来源：用户设计反馈（2026-11-13），针对 One-shot Compiler 方案的三个实质缺口
- 性质：**规范草案**，尚未全部实现；与现有实现的对接关系见文末 §4
- 配套：`LEGACY-AUDIT-PROCEDURE.md`（审计步骤）、`ONESHOT-COMPILER-ASSESSMENT.md`（评估）、
  `ONESHOT-COMPILER-IMPLEMENTATION.md`（已实施记录）

---

## 0. 三个实质缺口（本草案要解决的）

1. **触发层缺失**：方案只说动作程序怎么执行，没说谁决定何时执行哪个程序。
   如果仍由宿主 LLM 通过 MCP 选 `programId`，运行期其实还有 LLM 参与，只是不再生成动作。
   这个折中合理，但必须明确写出：**运行期可以"选择"程序，但不能"生成"或"修改"程序**。
2. **静态程序表达力不足**：视线跟随、情绪强度、口型同步这类需要运行时输入的行为，
   纯静态程序覆盖不了。程序支持少量运行时参数槽，由调用方传入，而不是让 LLM 重新生成。
3. **LLM 错误会被永久固化**：LLM 输出默认不可信。未经 `runtime_verified` 加人工审核
   （`approved`）的程序不得进入运行期，且要有回滚到旧版本的机制。

---

## 1. 触发层：谁决定播放哪个程序

原则：运行期可以**选择**程序，但不能**生成**或**修改**程序。三种触发源，全部走确定性路由：

1. **显式调用**：宿主 LLM 通过 MCP 调 `l2d_play(programId, args)`。LLM 只从目录里挑，不写动作。
2. **语义查表**：`l2d_emote(emotion, intensity)` 保留为入口，但内部只做查表：
   `(emotion, intensity区间) → programId`。映射表在导入期由 LLM 生成，存进 SQLite。
3. **系统触发**：待机、超时、进入/退出会话等，由 Bridge 内置规则直接指向固定程序。

**程序目录**：每个程序带 `tags`、`emotion`、`intensityRange`、`priority`、`interruptible`，
供查表和 LLM 选择用。

**兜底规则**：查不到匹配时，返回明确回执 `no_match`（或播放指定的默认程序），
**不回退到实时规划**。

---

## 2. 运行时参数槽

程序步骤里的值可以是常量，也可以是槽引用：

```json
{
  "id": "look",
  "kind": "look",
  "params": {
    "x": { "$slot": "gazeX" },
    "y": { "$slot": "gazeY" }
  }
}
```

```json
"slots": {
  "gazeX": { "type": "number", "min": -1, "max": 1, "default": 0 },
  "gazeY": { "type": "number", "min": -1, "max": 1, "default": 0.3 }
}
```

**规则**
- 槽类型仅限 number / enum / bool，不允许表达式或代码，保证执行可复现。
- 加载时校验槽定义，调用时按 min/max 钳制，缺省用 default。
- 槽值来源有两种：调用参数（`args`），或命名输入通道（如视线、情绪强度）。
- 最终参数仍要过参数所有权和模型能力范围检查，**槽不能绕过安全层**。

**持续型行为不做成程序。** 口型同步、视线跟随这类逐帧信号，应作为确定性控制器
（现有 `facial-intelligence` 可承担）。程序只负责声明"此段交给 lipsync 控制器"，
并在结束时归还参数所有权。

---

## 3. JSON Schema 草案（程序 + 槽 + 触发映射）

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "dsh-l2d/action-program/v1",
  "type": "object",
  "required": ["schemaVersion","programId","modelId","version","entry","steps","meta"],
  "additionalProperties": false,
  "properties": {
    "schemaVersion": { "const": 1 },
    "programId": { "type": "string", "pattern": "^[a-z0-9._-]+$" },
    "modelId": { "type": "string" },
    "version": { "type": "integer", "minimum": 1 },
    "entry": { "type": "string" },
    "slots": {
      "type": "object",
      "additionalProperties": { "$ref": "#/$defs/slot" }
    },
    "steps": {
      "type": "array", "minItems": 1, "maxItems": 64,
      "items": { "$ref": "#/$defs/step" }
    },
    "meta": { "$ref": "#/$defs/meta" }
  },
  "$defs": {
    "slot": {
      "oneOf": [
        { "type": "object", "required": ["type","min","max","default"],
          "properties": { "type": {"const":"number"}, "min":{"type":"number"},
            "max":{"type":"number"}, "default":{"type":"number"} } },
        { "type": "object", "required": ["type","values","default"],
          "properties": { "type": {"const":"enum"},
            "values":{"type":"array","items":{"type":"string"},"minItems":1},
            "default":{"type":"string"} } },
        { "type": "object", "required": ["type","default"],
          "properties": { "type": {"const":"bool"}, "default":{"type":"boolean"} } }
      ]
    },
    "value": {
      "oneOf": [
        { "type": ["number","string","boolean"] },
        { "type": "object", "required": ["$slot"], "additionalProperties": false,
          "properties": { "$slot": {"type":"string"} } }
      ]
    },
    "step": {
      "type": "object",
      "required": ["id","kind","durationMs","next"],
      "properties": {
        "id": {"type":"string"},
        "kind": {"enum":["expression","motion","look","param","controller","wait"]},
        "params": { "type":"object", "additionalProperties": {"$ref":"#/$defs/value"} },
        "durationMs": {"type":"integer","minimum":0,"maximum":60000},
        "timeoutMs": {"type":"integer","minimum":1},
        "next": {"type":["string","null"]}
      }
    },
    "meta": {
      "type": "object",
      "required": ["sourceHash","compilerVersion","modelCapabilityVersion","status"],
      "properties": {
        "sourceHash": {"type":"string"},
        "compilerVersion": {"type":"string"},
        "modelCapabilityVersion": {"type":"string"},
        "status": {
          "type":"object",
          "required":["validated","runtimeVerified","approved"],
          "properties": {
            "validated":{"type":"boolean"},
            "runtimeVerified":{"type":"boolean"},
            "approved":{"type":"boolean"}
          }
        },
        "tags": {"type":"array","items":{"type":"string"}},
        "emotion": {"type":"string"},
        "intensityRange": {"type":"array","items":{"type":"number"},"minItems":2,"maxItems":2},
        "priority": {"type":"integer"},
        "interruptible": {"type":"boolean"}
      }
    }
  }
}
```

**触发映射（`trigger_map`）**

```json
{
  "modelId": "dafeiyu",
  "version": 1,
  "rules": [
    { "emotion": "happy", "intensity": [0, 0.5], "programId": "happy.light.v1" },
    { "emotion": "happy", "intensity": [0.5, 1], "programId": "happy.strong.v1" }
  ],
  "fallback": { "mode": "no_match" },
  "system": { "idle": "idle.loop.v1", "sessionStart": "greeting.v1" }
}
```

**加载期必须额外校验**（Schema 表达不了的）：
- `entry` 和所有 `next` 指向存在的步骤，且无环
- 所有 `$slot` 引用已在 `slots` 声明
- 参数落在模型能力范围内
- `controller` 步骤结束时归还参数所有权
- 映射的区间不重叠，`programId` 存在且 `approved`

---

## 4. 与现有实现的对接关系（主理人注，防"第三套真源"）

| 草案概念 | 现有实现 | 对接决定 |
|---|---|---|
| `meta.status.{validated,runtimeVerified,approved}` | v13 `compiled_actions.status` + `runtime_verified` + `approved` | **复用现有列**，不再建新字段 |
| `programId` | `compiled_actions.(model_id, action_id)` 主键 + `action_manifests.revision` | programId 即 `actionId`；版本沿用 manifest revision，**不另设 version 字段** |
| `sourceHash` / `modelCapabilityVersion` | `compiled_actions.graph_hash` / `capability_revision` | 同义复用；`program_hash` 已承担"程序变了验证章失效"的职责 |
| `trigger_map` | **尚不存在** → 本轮以 schema v14 落地 | 新表，唯一新增 |
| 槽（`$slot`） | `compiled_actions.parameters_json` 已有 min/max/default | 槽解析器做成纯函数模块（`mcp-bridge/program-slots.mjs`），本轮先落实现+测试，接线到派发属下一轮 |
| `l2d_emote(emotion, intensity)` 查表 | overlay 现走 `emotionSignal`（情绪通道） | 查表命中 → 走确定性派发；未命中 → **保持现有情绪通道行为**，返回 `no_match` 不算错误 |
| Model Adapter | 现仅 Cubism | 采纳"先只做 Cubism 一个 Provider，不提前设计通用层" |
