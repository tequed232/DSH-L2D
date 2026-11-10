# AI 节点编辑接口（后端契约 v1）

给 AI 和人共同阅读。节点类型、端口、参数范围、连线规则、op 格式的**机器可读版本**见
[`NODE-SCHEMA.json`](./NODE-SCHEMA.json)（由 `node tools/nodegraph-schema/gen.mjs` 从
`packages/dsh-l2d-plugin/lib/nodegraph-schema.mjs` 生成，ai-edit 提示词用的是同一份数据）。

## 1. 图格式（设计层）

与编辑器导出的 `meta.editor` 同形：

```json
{
  "nodes": [
    { "id": "e", "type": "expression", "label": "Expression", "pos": { "x": 260, "y": 0 },
      "props": { "priority": "NORMAL", "cooldownMs": 0, "execState": "idle", "modelWhitelist": "",
                 "portType": "flow", "disabled": false, "name": "脸红", "clear": false, "stepDelayMs": 0 },
      "disabled": false }
  ],
  "edges": [ { "id": "e1", "from": "t", "to": "e" } ],
  "viewport": { "x": 30, "y": 80, "k": 0.85 }
}
```

- `graphHash(graph)`：`nodes` + `edges` 稳定序列化（键排序）后 sha256 前 16 位；`viewport` 不参与。
- 应用后整体校验：设计层按编辑器同语义编译为执行图（辅助节点 / disabled 节点穿透），再交
  `nodegraph.mjs` 的 `validateNodegraph`（DAG、可达、表情/动作组白名单、段数与时长上限）。

## 2. op 格式

| op | 字段 | 说明 |
|---|---|---|
| `add_node` | `type`，可选 `id` `label` `pos{x,y}` `props` | `id` 缺省自动分配 `ai_<n>` |
| `remove_node` | `id` | 连带删除相关连线 |
| `set_param` | `id` `key` `value` | `key` 可为 `label`；`motion.name` 会联动只读 `closeMotion` |
| `connect` | `from` `to`，可选 `fromPort='out'` `toPort='in'` `replace` | 同色端口；禁自连 / 成环 / 重复；目标已有输入需 `replace:true` |
| `disconnect` | `edgeId` 或 `from`+`to` | |
| `move_node` | `id` `x` `y` | 绝对值 ≤ 100000 |

错误 `{ opIndex, op, reason, message }`，`reason` 是英文 code（不翻译），完整列表见 `NODE-SCHEMA.json#reasonCodes`。
告警（不阻断）：`live2d-id-not-in-model`（代码里引用但模型不存在的参数 ID，如 `ParamMouthOpen`）。

## 3. Live2D ID 目录（可选）

`docs/nodegraph/live2d-ids.json` 存在时，表情名 / 动作组按它校验（未知 → `unknown-live2d-id`），
提示词也带上合法 ID；不存在时只做类型校验（执行侧整体校验仍以 choreography 白名单兜底）。
只校验节点 op 写入的值，不校验模型自带 exp3 表情文件内部的参数值。动作组 `Idle` 一律不允许写进节点。
大肥鱼模型没有 HitAreas、没有 pose3：`pose` 节点只是手臂姿势预设。

## 4. HTTP

| 方法 / 路径 | 请求 | 响应 |
|---|---|---|
| `POST /dsh-l2d/api/nodegraph/apply-ops` | `{graph, ops, baseHash?}` 纯预演，不写文件；或 `{name, ops, baseHash?}` 改已导入图，整体合法才写回 | 200 `{ok, graph, valid, applied, errors, warnings, hash, live2dIds}`（name 模式另带 `name, saved`）；409 `stale-graph`；400 守卫拒绝 |
| `POST /dsh-l2d/api/nodegraph/ai-edit` | `{graph, instruction, lang}`（`zh-CN`/`en`/`ja`） | 200 `{ok, ops, explanation, warnings, baseHash, valid, previewHash}`；503 `ai-unavailable`；502 `ai-failed` / `ai-bad-response`；不修改任何文件或状态 |
| `GET /dsh-l2d/api/nodegraph/graph?name=X` | — | 200 `{ok, name, graph, hash, valid, errors}`；400 `name-required`（附 `names`）；404 |

dev-server（5300）同路径（`/dsh-l2d` 前缀可省）。

## 5. MCP

- `l2d_graph_get {name}` → 已导入图的设计层 + `hash`。
- `l2d_graph_apply_ops {name, ops, baseHash}` → 整批原子应用，合法才写回 `$DSH_HOME/l2d-nodegraphs/<name>.json`。

两个工具直连宿主路由，入口过 `host-guard.guardGraphCall`（白名单 `HOST_GRAPH_TOOLS`，与 `/ai/call` 的 19 项白名单分开）。
