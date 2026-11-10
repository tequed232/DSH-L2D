# 节点图动作编排通道 — 实现契约 v1（NODE-GRAPH SPEC）

- 日期：2026-11-08 14:25 · 主理人定稿 · 17:00 验收
- 用户需求：①测试 LLM 通道与节点通道可用性；②每模型节点图导出为可分享 JSON、导入直接可用；③导入后回传动作给模型正确调用；④节点通道可用时不走 LLM；⑤「节点图+LLM辅助」与「纯LLM」模式互斥。
- **硬约束：所有测试与开发仅在本地机器进行。云端服务器（121.40.125.77）已按用户指令完成清理，禁止再向服务器部署或运行任何测试。**

## 1. 已核实的现场事实（直接用，不要重新调研）

| # | 事实 | 位置 |
|---|---|---|
| F1 | 动作步模型 `ActStep { kind: 'expression'\|'motion'\|'pose'\|'look', name?, clear?, closeMotion?, closeAfterMs?, delayMs?, pose?, x?, y? }` | `packages/core/src/action-chain.ts:32-43` |
| F2 | 序列校验 `validateActionSequence`：segments ≤15、每段 chain ≤8 步、bubble ≤40 字、priority ∈ BACKGROUND/NORMAL/FORCE、`estimateLifeMs ≤ DEFAULT_GATE.maxLifeMs`；步校验 `validateStep`、`STEP_KINDS`、`DEFAULT_GATE` 均从 choreography 导出 | `packages/dsh-l2d-mcp/src/action-sequence.mjs:3-31`、`packages/dsh-l2d-plugin/lib/choreography.mjs` |
| F3 | 执行器 `executeActionSequence(input, execute, options)`：FIFO + 瞬时拒绝入队重试 + 回执 receipts | `action-sequence.mjs:66-71` |
| F4 | LLM 通道白名单 19 项 `HOST_ALLOWED_TOOLS`（含 `l2d_change_form` +1 循环、FI 轮 `l2d_facial`/`l2d_facial_manual`、形态直达 `l2d_set_form`），`ALLOWED_SET`，`guardAiCall()` 对未知 name `deny('unknown-tool')`；`l2d_set_form` 的 `index` 须为 0..2 整数，否则 `deny('invalid-form-index')`；两条形态指令在节点图模式下均作单步原语放行 | `packages/dsh-l2d-plugin/lib/host-guard.mjs:43-73` |
| F5 | 状态文件先例：`$DSH_HOME/l2d-env-state.json` 原子写、白名单字段、过期失效；`envStatePath(homeDir)` 解析 | `packages/dsh-l2d-plugin/lib/env-state.mjs` |
| F6 | 本地 curl 被系统代理劫持（http_proxy=127.0.0.1:11290 产生假 502），测试本地端口必须 `curl --noproxy '*'` | 主理人实测 |
| F7 | 宿主 3080（外部 DSH 应用）当前未运行，LLM 通道端到端实测受限；本地调试台 = `pnpm dev:server`（tools/dev-server/index.mjs，5300） | 主理人实测 |

## 2. 分享 JSON Schema v1（唯一格式）

```json
{
  "schemaVersion": 1,
  "kind": "dsh-l2d-nodegraph",
  "name": "挥手打招呼",
  "modelBinding": {
    "modelId": "大肥鱼",
    "modelHash": "<models.package_hash 或空>",
    "bindingMode": "strict" | "any"
  },
  "graph": {
    "roots": ["n1"],
    "nodes": [
      { "id": "n1", "type": "expression", "name": "兔牙", "delayMs": 180, "next": ["n2"] },
      { "id": "n2", "type": "pose", "pose": { "right": "rest" }, "next": [] }
    ]
  },
  "segments": [
    { "priority": "NORMAL", "bubble": "可选，≤40字", "chain": [ { "kind": "expression", "name": "兔牙", "delayMs": 180 } ] }
  ],
  "meta": { "author": "", "exportedAt": "ISO8601", "dshVersion": "0.5.0" }
}
```

规则：
- **单一执行真源是 `segments`**（与 F2 校验器同构，导入即可跑）。`graph` 是节点图视图书写层，导出工具把图编译为 segments；导入时若二者都在则以 segments 为准并回算 graph，若只有 graph 则由编译器生成 segments。
- 节点 `type` 只允许 F1 的四类 + `delay`（纯延时节点，编译为空段或并入 delayMs）。
- 图约束：有向无环、roots 可达全部节点、`next` 引用的 id 必须存在。
- `modelBinding.bindingMode: "strict"` 时仅绑定的 modelHash/modelId 可用；`"any"` 时任意模型可用（导入即用的默认值，保证「其他用户导入直接可用」）。

## 3. 模式互斥（需求⑤）

- 状态文件：`$DSH_HOME/l2d-motion-mode.json`（仿 F5 模式：原子写、白名单字段、无过期）：
  `{ "mode": "nodegraph" | "llm", "updatedAt": "ISO8601" }`，缺省（文件不存在）= `"llm"`（现状兼容）。
- **nodegraph 模式**：节点图命中 → 编译 segments → `executeActionSequence` 直接执行（本地通道，不调 LLM，满足需求④）；节点图未命中且允许 LLM 辅助时才可走 `/ai/call`。
- **llm 模式**：现状行为，节点图不参与。
- **互斥强制点**：`guardAiCall()`（F4）在 `mode === 'nodegraph'` 且调用的是「纯 LLM 编排类整链工具」（`l2d_act` / `l2d_emote`）时返回 `deny('mode-blocked', ...)`；单步原语（set_expression/play_motion 等）不拦，作为 LLM 辅助的底层通道。UI 开关二选一，写入状态文件即切换。

## 4. 文件所有权（并行开发互不重叠）

| 成员 | 独占文件 |
|---|---|
| 后端（陆溯源） | `lib/nodegraph.mjs`（新：schema 校验+图编译+模式状态文件读写）、`lib/nodegraph.test.mjs`（新）、`lib/host-guard.mjs`（仅加 mode-blocked 门禁）、`lib/index.js`（仅加 4 条路由）、`tools/dev-server/index.mjs`（同款路由对齐，若契约路由已存在则不动） |
| 前端（苏格致） | `assets/settings.html`（05 区节点图卡片 + 模式开关 UI）、`tools/acceptance/snapshots/settings.html`（同步快照） |
| 主理人 | 契约、终审提交 |

### 插件路由契约（lib/index.js，后端实现，前端按此调 UI）

| 方法/路径 | 功能 | 响应 |
|---|---|---|
| `GET /dsh-l2d/nodegraphs` | 列出已导入节点图（名称/模型/绑定模式/状态） | `{ ok, items: [{name, modelId, bindingMode, valid}] }` |
| `POST /dsh-l2d/nodegraphs/import` | body = 分享 JSON 全文；校验（§2 全规则 + F2 编译校验）→ 存 `$DSH_HOME/l2d-nodegraphs/<name>.json`；重名覆盖前校验，失败原文件不动 | `{ ok }` 或 `{ ok:false, errors:[...] }` |
| `GET /dsh-l2d/nodegraphs/export?name=X` | 读回该 JSON（分享用） | JSON 原文 |
| `POST /dsh-l2d/nodegraphs/run?name=X` | **执行**（NG 补充，14:50 定案）：loadNodegraph → `mode==='llm'` 时返回 `{ok:false,status:409,reason:'mode-blocked'}`（互斥另一半：纯 LLM 模式下节点图不执行）；nodegraph 模式取 segments → `executeActionSequence(input, execute)`，execute 复用 lib/index.js 中 l2d_act 的既有内部下发函数（不经过 guardAiCall——互斥门禁只管 /ai/call 的 LLM 入口，不拦节点通道自身）；dev-server 无 renderer 时透传语义化错误（如 renderer-not-ready） | `{ok, status, receipts}` 或 `{ok:false, reason}` |
| `GET/POST /dsh-l2d/motion-mode` | 读/写 `l2d-motion-mode.json` | `{ ok, mode }` |

存储位置用 `$DSH_HOME`（F5 同源解析），文件名 `<name>.json`，name 做文件名安全化（去路径分隔符）。

## 5. 测试与验收（全部本地）

1. `lib/nodegraph.test.mjs`（node:assert 风格，同仓库既有测试）：schema 拒绝用例（坏 version/未知 type/环/悬空 next/segments 超 15 步超 8/超时长）、编译正确性（graph→segments 等价）、模式文件读写与缺省 llm、guardAiCall 互斥拒绝、重名导入原子性。
2. 既有回归：`pnpm test:core` 全绿（host-guard 改动不得破坏现有白名单行为；当前 19 项，新工具只允许末尾追加）。
3. 通道可用性实测（本地 dev-server 5300，`--noproxy`）：`GET/POST motion-mode`、import 一个最小合法 JSON、export 回读 diff=0、nodegraphs 列表出现；宿主 3080 不可用如实记录为限制。
4. 前端：05 区渲染「节点图」卡片（导入/导出/列表/模式开关三态复用 .dev-actions 现有机制），快照同步，1440×900 与 720×900 截图。
5. 验收裁定：主理人 17:00 汇总，PASS / PASS_WITH_WARNINGS / BLOCKED / FAILED。
