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
告警（不阻断）：`live2d-id-not-in-model`（代码里引用但模型不存在的参数 ID，如 `ParamMouthOpen`）、
`model-catalog-missing`（该模型没有自己的清单，已回退全局清单）。

## 3. Live2D ID 目录（按模型选清单）

**每条动作链属于一个模型**（2026-11-10 统一约定）：编辑、校验、AI 编辑、运行都按该模型自己的清单来。

- `modelId` = 模型文件名去 `.model3.json`（如 `大肥鱼.dsl2d.2048`，**单个点放行**；路径安全只拦
  `..` 与 `/` `\`）。
- 按模型清单：`docs/nodegraph/models/<modelId>/live2d-ids.json`（由
  `tools/live2d-catalog/build-live2d-catalog.mjs` 生成，`DSH_L2D_MODEL_DIR` 指向模型目录）。
- modelId 决定顺序：**显式传（请求体 `modelId` 字段）> 图绑定 modelId > 当前模型**；都没有 → 全局清单
  `docs/nodegraph/live2d-ids.json`（旧行为）。
- 模型缺清单 → 回退全局清单并在回执带 `warning: model-catalog-missing`；全局也没有 → 只做类型校验。
- 存在清单时，表情名 / 动作组按它校验（未知 → `unknown-live2d-id`），提示词也带上合法 ID；
  整图校验的白名单按「choreography 静态名单 ∪ 该模型清单」放行（`allowed` 注入）。
- 只校验节点 op 写入的值，不校验模型自带 exp3 表情文件内部的参数值。动作组 `Idle` 一律不允许写进节点。
- 大肥鱼模型没有 HitAreas、没有 pose3：`pose` 节点只是手臂姿势预设。

## 4. HTTP

| 方法 / 路径 | 请求 | 响应 |
|---|---|---|
| `POST /dsh-l2d/api/nodegraph/apply-ops` | `{graph, ops, baseHash?, modelId?}` 纯预演，不写文件；或 `{name, ops, baseHash?, modelId?}` 改已导入图，整体合法才写回 | 200 `{ok, graph, valid, applied, errors, warnings, hash, live2dIds, modelId, live2dIdsSource?, catalogWarning?}`（name 模式另带 `name, saved`）；409 `stale-graph`；400 守卫拒绝 |
| `POST /dsh-l2d/api/nodegraph/ai-edit` | `{graph, instruction, lang, modelId?}`（`zh-CN`/`en`/`ja`） | 200 `{ok, ops, explanation, warnings, baseHash, valid, previewHash, modelId, catalogWarning?}`；503 `ai-unavailable`；502 `ai-failed` / `ai-bad-response`；不修改任何文件或状态 |
| `GET /dsh-l2d/api/nodegraph/graph?name=X` | — | 200 `{ok, name, graph, hash, valid, errors, modelId, live2dIds, live2dIdsSource?, catalogWarning?}`；400 `name-required`（附 `names`）；404 |
| `GET /dsh-l2d/api/nodegraph/graph?model=X`（不带 name） | — | 200 `{ok, model, items:[{name, modelId, bindingMode, valid, matches}]}`：只列 strict 绑定该模型的图（`matches:true`）+ any 图（`matches:false` 标记）；绑定其它模型的 strict 图不列 |
| `GET /dsh-l2d/api/nodegraph/catalog?model=X` | — | 200 `{ok, modelId, source:'model'\|'global'\|'none', catalog:{params, motions, expressions, forms}, warning?}`（model 缺省用当前模型）；400 `invalid-model-id`（`..` 或路径分隔符）；404 `no-model` |

`live2dIds`：`loaded`（命中清单）/ `missing`；`live2dIdsSource`：`model`（模型自己的清单）/
`global`（回退全局）；`catalogWarning`：`model-catalog-missing`。

### 运行时模型绑定（run 通道）

- `POST /dsh-l2d/nodegraphs/run?name=X`：在 `nodegraphRunRegistry.begin` **之前**按图绑定裁决——
  `bindingMode:'strict'` 且绑定 `modelId` ≠ 当前模型 → 409 `{ok:false, reason:'model-mismatch',
  expected, actual}`，**一个动作都不发**，注册表零 running 记录。
- `bindingMode:'any'` 照旧执行；绑定 `modelId` 与当前模型不一致时执行结果附
  `warning: {reason:'model-mismatch', expected, actual}`。
- 新建图（导入时无 `modelBinding` 字段）默认 strict 绑定当前模型；旧图显式 `any` 不自动迁移。

dev-server（5300）同路径（`/dsh-l2d` 前缀可省；dev-server 无模型目录概念，走全局清单）。

## 5. MCP

- `l2d_graph_get {name}` → 已导入图的设计层 + `hash`（回执带 `modelId` / `live2dIdsSource`）。
- `l2d_graph_apply_ops {name, ops, baseHash, modelId?}` → 整批原子应用，合法才写回
  `$DSH_HOME/l2d-nodegraphs/<name>.json`；校验按图绑定模型（`modelId` 可显式覆盖）。

两个工具直连宿主路由，入口过 `host-guard.guardGraphCall`（白名单 `HOST_GRAPH_TOOLS`，与 `/ai/call`
的白名单分开），按图绑定模型的行为与 HTTP 完全一致。
