# Motion Graph Lab · 导出 JSON 兼容性验证报告

- Task ID：`MG-BACKEND`
- Assigned Model：MiMo（ARCANA 六席 · 席位 4 后端系统工程师 陆溯源）
- 真源契约：`docs/motion-graph-lab/CONTRACT.md` §3 / §4 / §6 / §8（v1，含 17:52 架构决策与规则 10/11/12）
- 验证范围：`POST /dsh-l2d/nodegraphs/import` 的实际校验链 `saveNodegraph → validateNodegraph → validateGraph / validateActionSequence`
- 执行口径：**全部本地**。无 SSH、无部署、未连接任何远程服务器；`saveNodegraph` 的 `homeDir` 一律指向 `os.tmpdir()` 下临时目录，`DSH_HOME` 环境变量实测为 `undefined`，未写真实 `~/.dsh`；本地 HTTP 验证仅监听 `127.0.0.1`。
- 结论：**PASS**（兼容性主线全绿；契约规则 3/6/7/9/12 的措辞与职责边界差异已由主理人裁定关闭并同步至本报告，后端校验器零改动；18:09 两张真实 HTML 落盘后两服务 200 + `cmp` 字节一致终验已闭环）。

---

## 1. §4 十二条硬性规则逐条对照（含实际校验行为与 文件:行号）

链路入口：`packages/dsh-l2d-plugin/lib/index.js:1166-1195`（`POST /dsh-l2d/nodegraphs/import`）→ `:1186 saveNodegraph(doc)` → `lib/nodegraph.mjs:515-527` → `:429-505 validateNodegraph` → `validateGraph`（`:166-305`）与 `packages/dsh-l2d-mcp/src/action-sequence.mjs:9-31 validateActionSequence` → `lib/choreography.mjs:452-533 validateStep`。

| # | 契约规则 | 实际校验行为（证据） | 差异 / 补充 |
|---|---|---|---|
| 1 | 顶层只许 7 字段；`meta` 透传 | `nodegraph.mjs:434-438` 遍历 `Object.keys(doc)`，非白名单报 `未知顶层字段 X`；`:439-441` `schemaVersion===1`；`:442-444` `kind==='dsh-l2d-nodegraph'`；`:445` `name` 为非空字符串（`:498` 落盘时 `.trim()`）；`:502` `meta` 只要是 plain object 就**整对象原样透传**，非对象则 `{}`，内部无字段白名单 | 一致。`meta` 不受约束也意味着运行时派生字段会被原样写入（见规则 12） |
| 2 | `graph.nodes[].type` 只许 5 类 | `nodegraph.mjs:39 NODE_TYPES = ['expression','motion','pose','look','delay']`；`:199-202` 不匹配报 `type 不受支持：X`。Trigger / Condition 等设计层节点进 `graph.nodes` 必被拒 | 一致，但**补充**：`segments[].chain[].kind` 只许 4 类 `STEP_KINDS`（`choreography.mjs:46`），`delay` **不是 step**，只编译成 `delayMs`；`trigger` 连 segments 也进不去（`action-sequence.mjs:23`） |
| 3 | 节点字段白名单；`x/y` 是 look 视线坐标，画布坐标只能进 `meta.editor.nodes[].pos`（契约 §4 规则 3 已修订） | `nodegraph.mjs:159-161 NODE_ALLOWED_KEYS = id,type,name,clear,closeMotion,closeAfterMs,delayMs,pose,x,y,next`；`:203-205` 白名单外报 `未知字段 X` | **已与契约对齐**：`x`/`y` 在白名单内，语义是 `look` 节点的视线坐标。实测画布坐标误写进 `x/y` → `ok:true` 且会被编译成错误的 look step（不报错但语义污染）；只有 `pos` / `position` / `canvasX` 之类非白名单键会被拒（实测 `graph.nodes[0] 未知字段 pos`）。画布坐标一律存 `meta.editor.nodes[].pos` |
| 4 | 必填：expression/motion 需 name；look 需 x/y 数字；pose 值 ∈ POSE_VALUES；delay 0<delayMs≤5000；普通节点 0~5000 | `nodegraph.mjs:206-211` name 非空字符串；`:212-222` pose 至少 right/left 一侧且 ∈ `POSE_VALUES`（`choreography.mjs:93`）；`:223-225` look `Number.isFinite(Number(x/y))`；`:226-230` delay `0<d<=5000`；`:231-236` 普通节点 `0<=d<=5000` | 一致（graph 侧）。**segments 侧更严**：`choreography.mjs:472-474` expression.name 必须 ∈ `MODEL_EXPRESSIONS`（21 项，`:49-71`）；`:478-490` motion.name 必须 ∈ `MODEL_MOTION_GROUPS`（6 项，`:77-84`）且 closeMotion 与 `PAIRED_CLOSES`（`:87-91`）配对；`:511-512` look.x/y ∈ **-1~1**；`:496-507` pose 同样受 POSE_VALUES 约束 |
| 5 | roots 非空且引用存在；next 无悬空；无环；roots 可达全部节点；≤120 | `nodegraph.mjs:171-175` roots/nodes 非空；`:176-178` ≤ `MAX_GRAPH_NODES = 15×8 = 120`（`:44`）；`:179-181` graph 只许 roots/nodes 两个键；`:191-198` id 非空字符串且唯一；`:237-239` next 必须是数组；`:245-252` 悬空 next / roots 引用；`:255-281` 三色 DFS 环检测；`:283-304` BFS roots 可达性 | 一致。额外约束：id 唯一、graph 键白名单，契约未列 |
| 6 | segments 为执行真源；每段 ≤8 步、≤15 段、priority 三值、bubble ≤40、**逐段**链估算时长 ≤ `DEFAULT_GATE.maxLifeMs`（契约 §4 规则 6 已修订） | `nodegraph.mjs:461-463` graph/segments 至少其一；`:472-476` 有 segments 就过 `validateActionSequence`；`:479-484` 两者并存时 `normalizedSegments = segments`、`normalizedGraph = segmentsToGraph(segments)`。`action-sequence.mjs:12` 非空；`:13` ≤15 段；`:17` 段键只许 chain/priority/bubble；`:18` priority ∈ BACKGROUND/NORMAL/FORCE（默认 NORMAL）；`:19` bubble ≤40；`:20-21` chain 非空且 ≤8 步；`:27-28` `estimateLifeMs(segment.chain) > DEFAULT_GATE.maxLifeMs` 报错 | **已与契约对齐**：上限是**逐段**链估算（`choreography.mjs:323-336`），`maxLifeMs=10000`（`:126`），**没有全局累计总时长校验**。原「总时长」措辞已修订 |
| 7 | DFS 前序编译；**后端编译器只跳过 `delay` 节点**；设计层辅助节点由编辑器导出时不写入 `graph.nodes`、只存 `meta.editor`（契约 §4 规则 7 已修订） | `nodegraph.mjs:315-384`：`327-334` 从 roots DFS 前序（共享后继只编译一次）；`:336-343` delay 累加到 `pendingDelay`；`:362-364` 并入下一动作节点的 `delayMs`；`:367-370` 末端无动作则丢弃；`:372-374` 每 8 步切一段；`:375-382` >15 段拒绝；只有 graph 时 `:486-493` 会编译并再过一次 F2 校验 | **已与契约对齐**：后端不存在 Trigger / Condition Gate / Workspace State / Condition 这些 type（`NODE_TYPES` 只有 5 类），写入即被拒；编译层不感知其存在，被跳过的只有 `delay`。分支按 `next` 数组顺序 DFS 线性化，不是「跳过」。实测见 §3 [7] |
| 8 | bindingMode 默认 any；strict 至少给 modelId/modelHash | `nodegraph.mjs:447-450` modelBinding 三键白名单；`:451-454` 默认 any、只许 strict/any；`:455-459` strict 时 modelId 或 modelHash 至少一个非空；`:499` 归一化落盘 | 一致 |
| 9 | **后端只做 `meta` 字节级透传**；画布还原、缓存状态剥离与绑定重验全部是编辑器导入器职责（契约 §4 规则 9 已改写） | `nodegraph.mjs:502` 只做整对象透传；导入路由 `lib/index.js:1166-1195` 除 `saveNodegraph` 外**没有任何画布还原逻辑**；`loadNodegraph`（`nodegraph.mjs:573-585`）只返回原文字符串 | **已与契约对齐（主理人 18:xx 裁定）**：`meta` 字节级透传是**正确设计**，目的是分享文件格式不失真，不是缺陷；后端不承担还原/净化职责。编辑器优先读 `meta.editor` 还原画布，无 `meta.editor` 时用 graph/segments 反推线性视图 |
| 10 | segments 侧隐性约束（新增） | `choreography.mjs:452-533 validateStep`；`:458-460` `STEP_KEYS`（`:95-105`：kind/name/clear/closeMotion/closeAfterMs/delayMs/pose/x/y/group/mode/timeoutMs）；`:461-463` kind 四类；`:465-467` delayMs 0~5000；`:517-529` group/mode/timeoutMs 规则；`:531` name 必须是字符串。`action-sequence.mjs:22-26` 逐步调用并以 `segments[i]: ` 前缀包装错误 | 已实测 4 条反例全部被拒，见 §3 [5] |
| 11 | graph+segments 并存时 normalized.graph 被覆盖，只有 meta.editor 保留 | `nodegraph.mjs:481-484`；`segmentsToGraph`（`:391-419`）按 segments 线性重造 `s1…sN` 节点 | 已实测：输入 `n1` → 落盘 `s1`，见 §3 [1]。画布还原只能依赖 `meta.editor` |
| 12 | 导入不信任文件内缓存状态：`cacheStatus`/`lastValidatedAt`/`resolvedBinding` 一律丢弃并重验（**前端约束**） | `nodegraph.mjs:502` 对 `meta` 整对象透传，**不解析、不剥离任何字段**；`:495-503` normalized 直接带上；`:525` 原子写盘 | **缺口已关闭（主理人裁定：职责边界而非缺陷）**：实测三个派生字段放进 `meta.editor` 后 `validate ok=true` 且落盘仍全部存在——这是「分享文件不失真」的正确设计。剥离与绑定重验由**编辑器导入器**实现（前端席已实现），规则 12 保留为前端约束；`nodegraph.mjs` 不改 |

---

## 2. 最小合法示例 JSON（可直接被 import 吃下）

以下为实测 `validateNodegraph ok:true`、`saveNodegraph ok:true`、落盘回读再校验 `ok:true` 的最小模板。前端导出器可据此裁剪；`meta.editor` 为完整画布状态的唯一可信载体。

```json
{
  "schemaVersion": 1,
  "kind": "dsh-l2d-nodegraph",
  "name": "MG-LAB 最小合法示例",
  "modelBinding": { "modelId": "大肥鱼", "modelHash": "", "bindingMode": "any" },
  "graph": {
    "roots": ["n1"],
    "nodes": [{ "id": "n1", "type": "expression", "name": "兔牙", "next": [] }]
  },
  "segments": [
    { "priority": "NORMAL", "chain": [{ "kind": "expression", "name": "兔牙" }] }
  ],
  "meta": {
    "dshVersion": "0.5.0",
    "editor": {
      "version": 1,
      "nodes": [{ "id": "n1", "pos": { "x": 120, "y": 160 } }],
      "edges": [],
      "viewport": {}
    }
  }
}
```

要点：末端节点必须 `next: []`（悬空引用会直接拒绝）；`expression.name` 用白名单里的「兔牙」；画布坐标只出现在 `meta.editor.nodes[].pos`，不进 `graph.nodes`。

> 契约 §4 修订后的示例（补了 `n2` look 节点）我也复跑过：`ok = true / errors = []`，`normalized.graph` 为 `s1(expression 兔牙) → s2(look 0,0.05)`，修正有效。修订前那版 `next:["n2"]` 无 n2，实测 `ok=false / ["节点 n1 的 next 引用不存在：n2"]`。

---

## 3. 实跑验证记录（`node --input-type=module -e`，临时 homeDir）

命令形态：`node --input-type=module -e "$(cat <系统临时目录>/mg-compat-verify.mjs)"`（脚本不落在仓库内）。关键真实输出：

```
=== [0] 环境 ===
DSH_HOME env = undefined
临时 homeDir = C:\Users\User\AppData\Local\Temp\mg-compat-mmhHeU

=== [1] 最小合法示例 validateNodegraph ===
ok = true
errors = []
normalized.graph = {"roots":["s1"],"nodes":[{"id":"s1","type":"expression","name":"兔牙","next":[]}]}
normalized.segments = [{"priority":"NORMAL","chain":[{"kind":"expression","name":"兔牙"}]}]
normalized.meta = {"dshVersion":"0.5.0","editor":{...,"nodes":[{"id":"n1","pos":{"x":120,"y":160}}]...}}

=== [2] saveNodegraph（等价 POST /dsh-l2d/nodegraphs/import 的落盘动作）===
save.ok = true ; file = ...\l2d-nodegraphs\MG-LAB 最小合法示例.json
roundtrip validateNodegraph(JSON.parse(file)) ok = true
listNodegraphs = [{"name":"MG-LAB 最小合法示例","modelId":"大肥鱼","bindingMode":"any","valid":true}]
loadNodegraph(name) bytes = 784

=== [3] 三个反例（必须全部 ok:false）===
N1 顶层多字段 extra
  validate.ok = false ; errors = ["未知顶层字段 extra"]
  save.ok = false ; errors = ["未知顶层字段 extra"]
N2 graph.nodes 含画布坐标 pos
  validate.ok = false ; errors = ["graph.nodes[0] 未知字段 pos"]
  save.ok = false ; errors = ["graph.nodes[0] 未知字段 pos"]
N3 graph.nodes[].type = trigger
  validate.ok = false ; errors = ["graph.nodes[0] type 不受支持：trigger"]
  save.ok = false ; errors = ["graph.nodes[0] type 不受支持：trigger"]
校验失败后目录内文件 = ["MG-LAB 最小合法示例.json"]   ← 反例未产生任何新文件（原文件零触碰）

=== [5] 隐性约束实证 ===
expression name 不在 MODEL_EXPRESSIONS 白名单 -> ok = false ; errors = ["segments[0]: chain[0] 表情名不存在：自定义表情"]
motion name 不在 MODEL_MOTION_GROUPS 白名单 -> ok = false ; errors = ["segments[0]: chain[0] 动作组不存在或不允许手动播：挥手"]
look x 超出 -1~1 -> ok = false ; errors = ["segments[0]: chain[0] look.x 必须是 -1~1 的数字","segments[0]: chain[0] look.y 必须是 -1~1 的数字"]
segments 含 trigger kind -> ok = false ; errors = ["segments[0].chain[0] kind 不受支持"]

=== [6] 画布坐标写进 x/y 的边界观察 ===
expression 节点带 x/y -> ok = true ; errors = []   ← 不报错，但语义污染（规则 3 差异）

=== [7] 只有 graph 时的编译路径（规则 7）===
graph-only ok = true ; compiled segments = [{"priority":"NORMAL","chain":[{"kind":"expression","name":"兔牙","delayMs":300}]}]
delay 节点 300ms 并入下一动作，末端丢弃

=== [8] run 通道前提：mode 互斥 ===
未写 mode 文件 -> {"ok":false,"status":409,"reason":"mode-blocked","message":"纯 LLM 模式下节点图不执行，请先切换到节点图模式"}
writeMotionMode(nodegraph) 后 -> ok = true status = completed completedSegments = 1

=== [9] 清理临时目录 ===
removed = true
EXIT=0
```

补充实测（规则 12）：

```
validate ok = true
saved.meta = {"editor":{...,"cacheStatus":"VALID","lastValidatedAt":"2026-11-08T00:00:00Z","resolvedBinding":{"modelId":"旧模型"}}}
缓存派生字段是否在落盘后仍存在 = true
```

**「导入即可 run」的前置条件**：导入只落盘，不切换动作模式。`runNodegraph`（`nodegraph.mjs:680-713`，`:685-693`）在 mode≠nodegraph 时返回 409 `mode-blocked`；需先经 `PUT /dsh-l2d/motion-mode` 切换。切换后我用注入式假 executor 实跑得到 `status='completed' / completedSegments=1`。

---

## 4. 静态服务映射核实与路由补齐（任务 A）

| 服务 | 核实结果 |
|---|---|
| `docs/studio-ui/preview-server.mjs` | `:54-63` 通用映射 `/dsh-l2d/<file> → assets/<file>`，`readSafe`（`:29-33`）带目录越界防护；新 HTML 自动可达，**未改动** |
| `tools/dev-server/index.mjs` | 原为显式路由白名单（`/settings`→settings.html、`/ui-tokens.css`、`/overlay.css`、`/overlay.js`、`/model/`），末尾 `:670` 直接 404，**缺**任意 `.html` 映射 → 已补齐 |
| `packages/dsh-l2d-plugin/lib/index.js`（真机宿主） | `route()` 为 `kind:'exact'` 显式注册（`:929-936`），同样**缺**映射 → 已补齐 |

按主理人裁定选 (2)，各补**严格两条显式白名单**，禁止 `*.html` 通配：

- `tools/dev-server/index.mjs:45-53`：`STUDIO_HTML_ROUTES` Map 仅 2 项，value 为模块加载期拼好的绝对路径，`req.url` 只作 Map 查找键，**不参与 `path.join`**；`:372-380` 命中后复用 `readIfExists` + `MIME['.html']`，未命中仍走末尾 404。前缀剥离在 `:242-244`，故 `/dsh-l2d/motion-graph.html` → `/motion-graph.html`。
- `packages/dsh-l2d-plugin/lib/index.js:85-87` 两个路径常量；`:1472-1484` 用现有 `route()` 注册两条 exact 路由，复用 `isCrossSite`（`:193-206`）同源门禁 + `readIfExists` + `sendBuffer`，末尾 404 兜底不变。

**curl 实测**（`curl --noproxy '*'`，本地 127.0.0.1，两张 HTML 尚未由前端席落盘，故用 `--import` 的临时 fs 夹具返回标记内容，仓库内不创建任何文件；夹具仅作用于 `/assets/motion-graph.html` 与 `/assets/control-studio.html`）：

```
# dev-server (5399)
motion-graph.html   HTTP=200 type=text/html; charset=utf-8 bytes=68
control-studio.html HTTP=200 type=text/html; charset=utf-8 bytes=68
任意 evil.html       HTTP=404 bytes=14   ← 404 /evil.html，无通配
settings            HTTP=200

# 真机宿主 apply() 路由挂载夹具 (5398)
registered exact routes = 36
route /dsh-l2d/motion-graph.html   = REGISTERED
route /dsh-l2d/control-studio.html = REGISTERED
route /dsh-l2d/settings            = REGISTERED
host motion-graph.html   HTTP=200 type=text/html; charset=utf-8 bytes=68
host control-studio.html HTTP=200 type=text/html; charset=utf-8 bytes=68
host 任意 evil.html       HTTP=404 bytes=22   ← 404 /dsh-l2d/evil.html

# 安全回归
host 跨站 Origin: http://evil.example → HTTP=403 forbidden
host Sec-Fetch-Site: cross-site       → HTTP=403 forbidden
host /dsh-l2d/../package.json         → HTTP=404
dev  /dsh-l2d/%2e%2e/package.json    → HTTP=404
```

`node --check` 两个文件均通过；两个本地服务验证完已停止。

**真实文件终验（18:09，两张 HTML 均已落盘）** —— 不加任何 fs 夹具，直接启动两个服务后 curl：

```
# dev-server 5399 / 真机宿主 apply() 挂载 5398，均无 fs 夹具
port 5398 motion-graph.html   HTTP=200 text/html; charset=utf-8 bytes=124102
port 5398 control-studio.html HTTP=200 text/html; charset=utf-8 bytes=24656
port 5399 motion-graph.html   HTTP=200 text/html; charset=utf-8 bytes=124102
port 5399 control-studio.html HTTP=200 text/html; charset=utf-8 bytes=24656
cmp 响应体 vs 源文件：四组全部字节一致 ✓
registered exact routes = 36 ; 两条新路由均 REGISTERED

# 跨站门禁（Origin: http://evil.example）
host 5398 : /settings /motion-graph.html /control-studio.html 全部 HTTP=403 forbidden
dev  5399 : 三者全部 HTTP=200 —— 属 dev-server 既有设计（其静态 GET 一律
           send(..., cors=true) 且无 isCrossSite；/dsh-l2d/settings 同样 200），
           非本轮新增路由引入，与宿主语义差异如实记录于 §7。

# 无通配兜底
host /dsh-l2d/evil.html HTTP=404 ; dev /dsh-l2d/evil.html HTTP=404
```

**Remaining Risk 已闭环**：两张真实 HTML 在两个服务上均 200、响应体与源文件逐字节一致、非白名单 404；宿主跨站 403。两个本地服务用完即停。

> **版本记录（主理人要求的 sha256 口径）**：主理人 18:09 报的 sha256（124102 bytes）对应的是前端席当时的版本；前端席随后落盘了 WCAG 修订版。**终验以当前落盘版为准**：
> - `motion-graph.html` = 126536 bytes / sha256 `6c517a8c10c597442579c70af8bafd94aac9935bc37b3054636351fbc22d4195`（18:40）
> - `control-studio.html` = 24656 bytes / sha256 `4686f973f46e0a91685c2cff4ff51a73858245304ef51cc78e7f42d4a8923b41`（18:06）
> 对该版本复跑结果：两服务 4 组响应体 `cmp` 字节一致 ✓、宿主跨站 `403`、dev-server 跨站 `200`（既有 cors 设计）、`evil.html` 两服务均 `404`（无通配）。若前端席继续增量修改，需按新 sha 重跑本节口径。

---

## 5. 回归基线（任务 D / E）

改动前基线：`consistency.test.mjs` → `SUMMARY: 9 PASS / 1 WARN / 0 FAIL`；`pnpm test:core` → `EXIT=0`。

按主理人裁定执行三步（**未跳过第 ① 步**）：

**① 严格增量比对（只读脚本，base vs cur，五字段 ids/hrefs/dataAttrs/events/texts）**

```
files: base=26 cur=26 union=26
files added=0 removed=0
五字段合计: removed=0 changed=0 added=2
--- 逐条明细 ---
ADDED   packages/dsh-l2d-plugin/assets/settings.html.hrefs "motion-graph.html" (cur count 1)
ADDED   packages/dsh-l2d-plugin/assets/settings.html.texts "打开 Motion Graph Lab" (cur count 1)
--- 判定 ---
VERDICT: PASS —— 纯新增（removed=0 && changed=0），允许刷新基线
EXIT=0
```

**② `node docs/studio-ui/fingerprint.mjs --write`** → `BASELINE WRITTEN: docs\studio-ui\baseline\functional-fingerprint.json`，`WRITE_EXIT=0`；settings.html 由 `hrefs=1 / texts=31` 变为 `hrefs=2 / texts=32`，与 ① 的 2 条 ADDED 精确对应。

**③ `node docs/studio-ui/consistency.test.mjs`**

```
PASS [2 功能指纹零漂移] 26 个文件 × 5 字段与基线完全一致
PASS [3 快照一致] 忽略 CR；扣除主文件 8 行退役注释头；主 2662 行 / 快照 2654 行 / 比对 2654 行 → 逐行一致，0 差异
PASS [4 禁改项零改动] git diff --name-only 共 8 个 tracked 改动，7 条禁用路径零命中
WARN [4 禁改项零改动] 改动文件不在本轮允许清单：tests/breakpoint-lab/reports/acceptance-report.json, tools/capability-scan/profile.大肥鱼.dsl2d.2048.json
SUMMARY: 9 PASS / 1 WARN / 0 FAIL
CONSISTENCY_EXIT=0
```

> 该 1 WARN 来自**其他所有者的既有/并行改动**（基线刷新前就已有 1 WARN），非本轮新增；组 2/3/4/5 全 PASS。

**`pnpm test:core`（改动后）**：`EXIT=0`，输出中 `# fail 0` 为 TAP 正常摘要，无任何失败用例（改动前后均为 EXIT=0）。

> **18:12 时点补充（如实记录，不伪报）**：上表 ③ 的 `9 PASS / 1 WARN / 0 FAIL` 是本轮基线刷新完成当时的实测结果。此后其他所有者落地了 6 个 `packages/dsh-l2d-db/**` / `packages/dsh-l2d-mcp/**` / `packages/mcp-bridge/**` 文件（+231/-47 行），命中 `consistency.test.mjs:165-173` 的 FORBIDDEN 清单，当前全套断言变为 `8 PASS / 1 WARN / 1 FAIL`（组 4「禁改项零改动」），组 1/2/3/5 仍全 PASS、指纹与快照零漂移。这**不是本轮 MG-BACKEND 的改动引入**（我的 5 个 tracked 文件 numstat 未变、组 2/3 仍 PASS），属并行修复与旧轮次禁改清单的策略冲突，已上报主理人裁定；我未自行改基线、未改测试、未动他人文件。

**快照口径**：主文件 CRLF（2661 处 CRLF / 0 处裸 LF），快照 LF（2653 处裸 LF）；扣除首个「退役过渡」注释块 8 行后，独立脚本逐行比对 `diffLines=0`。两侧均只新增 1 行，既有 id / 文案 / 交互 / 脚本逻辑零改动。

---

## 6. 与 Bridge Cache 的关系（契约 §8 架构决策）

用户 17:52 架构决策已纳入本报告的边界声明：

- **GPL-3.0 红线**：本轮所有实现均为「思想借鉴 + 独立实现」，未复制、改写或嵌入任何 ComfyUI 前后端源码；本报告新增的两条静态路由与兼容性校验均为仓库既有模式的复用，无第三方代码片段。
- **保留自有 Runtime**：不引入 ComfyUI 执行器；动作执行仍走现有 `executeActionSequence` → FIFO 队列 → 优先级 → Host Guard 链路（`action-sequence.mjs:66-115`）。图只决定提交顺序，`compileGraphToSegments` 产出的 `segments` 是唯一执行真源。
- **四类缓存铁律**：`Resolution Cache`（动作/模型匹配）、`Capability Cache`（模型可用参数）、`Execution State`（播放中/完成）与 `Graph Cache`（**只缓存编译结果，绝不缓存动作执行结果**）必须严格区分。**缓存命中不得跳过实际动作播放**——本轮导出/导入链路没有引入任何缓存命中短路，每次 `run` 都重新走 `executeActionSequence` 下发。
- **本轮不改现有 action-cache**：`packages/dsh-l2d-db/**` 与现有动作缓存一行未动。契约 §8.2 的 `BindingCacheKey{nodeType, actionId, modelFingerprint, modelResourceVersion, bindingVersion, inputSignature}` / `BindingCacheEntry{status: VALID|STALE|INVALID, resolvedBinding, lastValidatedAt}` **标注为后续增强缺口**，本轮仅做设计层记录，不落地、不假装已实现。
- **与规则 12 的衔接**：正因为后端 `meta` 整对象透传（§1 规则 12 实测），`cacheStatus` / `lastValidatedAt` / `resolvedBinding` 这类派生字段目前会随 JSON 一起落盘。若后续落地输入签名缓存，必须在**编辑器导入侧**先剥离并重验绑定，不能信任文件里的缓存状态；后端是否增加净化需主理人另行裁定。
- **`modelFingerprint` / `bindingVersion` 缺口**：现有 `modelBinding` 只有 `modelId/modelHash/bindingMode`（`nodegraph.mjs:447-459`），没有模型资源版本或绑定版本，无法构造输入签名；这是 Bridge Cache First 落地前的最小数据缺口，建议后续演进时在 `schemaVersion` 升版中补齐，不要塞进 `meta` 绕过校验。

---

## 7. Known Issues / Remaining Risks / 未覆盖范围

| 项 | 性质 | 说明与建议 |
|---|---|---|
| 规则 12 后端无剥离逻辑 | **已裁定关闭（职责边界）** | 主理人裁定：`meta` 字节级透传是分享文件不失真的正确设计，不是缺陷；剥离 cacheStatus/lastValidatedAt/resolvedBinding 与绑定重验是编辑器导入器职责，前端席已实现。契约 §4 规则 9 已改写、规则 12 保留为前端约束，`nodegraph.mjs` 不改 |
| 规则 3 / 6 / 7 / 9 措辞 | **已裁定关闭（文档已同步）** | 主理人已修订 CONTRACT.md §4：规则 3 明确 `x/y` 是 look 视线坐标、画布坐标只进 `meta.editor.nodes[].pos`；规则 6 明确逐段链估算时长；规则 7 明确编译器只跳 delay、辅助节点由导出时不写入 graph.nodes；规则 9 明确后端只透传。本报告 §1 对应四行已同步，文档与实现不一致消除 |
| 两张 HTML 落盘后真实文件复跑 | **已闭环（18:09）** | 两个服务对 `motion-graph.html`(124102) / `control-studio.html`(24656) 均 HTTP=200，`cmp` 四组全部字节一致，宿主跨站 403，非白名单 404。见 §4 终验 |
| `file://` 相对链接 | **未覆盖（浏览器实测）** | `href="motion-graph.html"` 相对路径在 file:// 下同目录解析，逻辑上可达；本轮未做浏览器双击实测，属前端席截图验收范围 |
| 真机宿主全链路 | **未覆盖** | 宿主路由用 mock `ctx` 捕获 `apply()` 注册项 + 本地 http.Server 分发验证；未启动真实 DSH Harness Desktop（硬约束禁止连接/部署服务器） |
| dev-server 与宿主跨站语义差异 | **既有设计，非本轮引入** | 宿主所有静态页均有 `isCrossSite` → 跨站 403；dev-server 静态 GET 一律 `send(..., cors=true)` 且无 `isCrossSite` → 跨站 200（实测 `/dsh-l2d/settings` 同样 200）。本轮新路由沿用各自既有语义，未扩大攻击面；若需统一应由主理人另行裁定 |
| `run` 需先切模式 | **使用约束** | 导入不等于可 run，须先 `PUT /dsh-l2d/motion-mode` 切 nodegraph，否则 409。前端「导入即用」文案需注明 |
| 1 WARN | **非本轮引入** | 来自其他所有者并行改动；刷新基线前后 WARN 数保持 1 |
| 并发写入 | **未覆盖** | 未测多进程同时 POST import 同名文件；`atomicWriteJson`（`nodegraph.mjs:63-78`）为 tmp+rename 原子覆盖，理论无半文件，但未做并发压测 |
| 浏览器 JSON 导入往返 | **未覆盖** | 后端侧只验证到 `saveNodegraph` 落盘 + 回读再校验；「导出→清空→导入→画布 diff=0」属前端席验收项，依赖 `meta.editor` |

---

## 8. Acceptance Status

| 任务 | 状态 |
|---|---|
| A 静态服务映射核实 + 两条白名单路由补齐（含 curl 200 / 403 / 404 / 穿越） | PASS |
| B COMPAT-REPORT.md 十二条逐条对照 + 最小合法示例 | PASS |
| C 兼容性实跑：合法示例 ok:true + save 成功 + 3 反例全拒 | PASS |
| D `pnpm test:core` EXIT=0；基线三步（严格比对→授权刷新→一致性回归） | PASS |
| E 快照同步 + 一致性断言 `9 PASS / 1 WARN / 0 FAIL` | PASS |
| 契约规则 12 / 措辞差异 | PASS（主理人裁定关闭，文档已同步） |
| 两张 HTML 落盘后真实文件复跑 | PASS（18:09 已闭环） |

**Acceptance Status：`PASS`**（契约措辞/职责边界差异已由主理人裁定关闭并同步文档，真实 HTML 终验已闭环；§7 剩余项均为「本轮未覆盖」而非缺陷）

> 范围声明：此处 PASS 指 **MG-BACKEND 本席任务**。项目级 `consistency.test.mjs` 门禁在 18:12 因其他所有者的 6 个禁改清单文件落地而暂为 `8 PASS / 1 WARN / 1 FAIL`，详见 §5 补充，需主理人裁定，不计入本席验收结论。

未 commit；未执行任何 SSH / 部署 / 远程连接；未修改任何非授权文件。

### Modified Files

1. `packages/dsh-l2d-plugin/assets/settings.html` —— 06 卡片 `dev-actions` 内新增 1 行入口链接（CRLF 保持）
2. `tools/acceptance/snapshots/settings.html` —— 同步快照（LF，扣除 8 行退役注释后逐行一致）
3. `docs/motion-graph-lab/COMPAT-REPORT.md` —— 新建，本报告
4. `docs/studio-ui/baseline/functional-fingerprint.json` —— 主理人授权刷新（`--write`）
5. `tools/dev-server/index.mjs` —— 主理人扩权，新增 2 条严格白名单静态路由
6. `packages/dsh-l2d-plugin/lib/index.js` —— 主理人扩权，新增 2 条 exact 静态路由

`package.json` 未改动（无需挂测试脚本）。
