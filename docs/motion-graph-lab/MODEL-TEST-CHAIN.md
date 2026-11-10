# MODEL-TEST-CHAIN — 三模型节点动作链编辑器端到端实测

- 执行者:impl-chain-e2e(动作链端到端测试代理)
- 日期:2026-11-10
- 环境:dev-server `node tools/dev-server/index.mjs --port 5344`(回环 127.0.0.1)
- fixture:系统临时目录 `C:/Users/User/AppData/Local/Temp/mg-e2e-fixtures/`(graphA-miku / graphA2-miku-solo / graphB-daifeiyu / graphC-invalid / graphC2-invalid-nonloop)
- 纪律:未改任何源码;测试残留已用 remove_node 恢复;测后 dev-server 进程已杀净
- 仓库基线:8bf09c4(已合并 #52 AI 节点编辑后端)

## 1. 三模型资源事实(实测 model3.json FileReferences)

| 模型目录 | model3.json | Expressions 登记 | Motions 登记 |
|---|---|---|---|
| Temp/ngt/miku | miku.model3.json | **[](空)** | **{}(空)** |
| Temp/ngt/xiao/小祥 | 丰川祥子.model3.json | **[]** | **{}** |
| Temp/ngt/deepseek/DeepSeek | 大肥鱼.dsl2d.2048.model3.json(+.dsl2d) | 21 项(兔牙…胸口衣服) | 6 组(抚胸/竖手指/狗尾巴草各开关)+Idle |

关键事实:**deepseek 目录解压出的就是大肥鱼模型**(同款资源、同名登记);miku 虽有 9 个 .exp3.json 文件与 Scene1.motion3.json,但 model3.json **未登记**,对校验器与执行器均不可见。

## 2. 测试矩阵(import → list → run → executions 真实输出)

### 图 A(miku 资源名:表情「兔牙」+ motion「Scene1」)
| 步骤 | 结果 |
|---|---|
| POST /nodegraphs/import | **HTTP 400**,`{"ok":false,"errors":["segments[0]: chain[1] 动作组不存在或不允许手动播：Scene1"]}` |
| GET /nodegraphs | 不入库(校验拒绝不落盘,符合「先校验后原子写」) |
| run / executions | 不可达(未导入) |

边缘发现:表情「兔牙」恰好与大肥鱼白名单重合,**通过了表情白名单关**——白名单按名字符串匹配、不按模型绑定;真正被拒的是 motion「Scene1」。作为对照:
- 图 A2(miku 独有名「唱歌」+ Scene1):**HTTP 400 双拒**,`["segments[0]: chain[0] 表情名不存在：唱歌","segments[0]: chain[1] 动作组不存在或不允许手动播：Scene1"]`

### 图 B(大肥鱼合法名:兔牙 / 狗尾巴草打开-关闭配对 / grass / look / delay 500)
| 步骤 | 结果 |
|---|---|
| POST /nodegraphs/import | **HTTP 200** `{"ok":true,"name":"mg-e2e-B-daifeiyu"}` |
| GET /nodegraphs | `{"name":"mg-e2e-B-daifeiyu","modelId":"大肥鱼.dsl2d.2048","bindingMode":"any","valid":true}` |
| POST /nodegraphs/run?name= | **HTTP 200,耗时 12.012s**:`{"ok":false,"status":"stopped","reason":"timeout","receipts":[{"batch":0,"sourceSegments":[0],"attempts":1,"receipt":{"ok":false,"reason":"timeout","id":1,"events":[]}}],"completedSegments":0,"remainingSegments":1,"replanRequired":false}` |
| GET /nodegraphs/executions?id= | `{"status":"timeout","cancelRequested":false,"startedAt":1794286170713,"finishedAt":1794286182722,"result":{…同上…}}` |
| GET /nodegraphs/executions?limit=5 | 列表含该记录,status=timeout |
| run 未导入的图 | **HTTP 404** `{"reason":"nodegraph-not-found","errors":["nodegraph not found: mg-e2e-A-miku"]}` |

run 的 timeout 是**已知行为**:dev-server 无浏览器渲染桥消费 aiInbox,l2d_act 入队后(id=1)轮询到 12s 预算耗尽,回执保留 pending→timeout 语义、不误报成功;执行注册表如实记录、历史可回查、进程不挂起不崩溃。链路各环节(入队/预算/回执/落账)均正确。

### 图 C(故意非法:未知表情 + look 超域 + c1→c2→c3→c1 环)
| 步骤 | 结果 |
|---|---|
| POST /nodegraphs/import | **HTTP 400**,`{"ok":false,"errors":["graph 存在环：c3 → c1"]}` |

**校验短路发现**:环检测在 validateGraph 内先行报错并整体短路,同一份图的白名单/取值域错误未一并报出(不是漏判,是 fail-fast 顺序)。拆开复测(图 C2,无环):
| POST /nodegraphs/import | **HTTP 400**,`["segments[0]: chain[0] 表情名不存在：不存在的表情","segments[0]: chain[1] look.x 必须是 -1~1 的数字","segments[0]: chain[1] look.y 必须是 -1~1 的数字"]` |

各类非法输入均有**精确、可定位**的中文错误信息(带 step 序号);全部拒绝图均未落盘。

## 3. 白名单来源调查结论(读码确认)

**执行/导入白名单是 choreography.mjs 硬编码,不是 capability profile 驱动:**

1. 导入链:`saveNodegraph → validateNodegraph`(packages/dsh-l2d-plugin/lib/nodegraph.mjs:450-526,只有 graph 时先 `compileGraphToSegments`)→ `validateActionSequence`(packages/dsh-l2d-mcp/src/action-sequence.mjs:24 调 validateStep)→ **`validateStep` 白名单判定在 choreography.mjs:490(`MODEL_EXPRESSIONS.includes`)与 :496(`MODEL_MOTION_GROUPS.includes`)**,两份名单在 choreography.mjs:49/77 **硬编码**(21 表情 / 6 动作组)。
2. 编辑器白名单:assets/motion-graph.html:2618 `Capability.expressions/motionGroups` 硬编码,注释自述「照抄 choreography.mjs + action-sequence.mjs」;Inspector 只提供白名单下拉(:2707/:2713),`Validator.check` 按同一名单拒绝(:3240)。
3. #52 的 apply-ops 用**另一份来源**:docs/nodegraph/live2d-ids.json(仓库文件,由 Live2D 侧按大肥鱼真实配置维护;nodegraph-schema.mjs:209 解析,缺省回退 choreography 硬编码 enumFallback)。实测 set_param「唱歌」→ `unknown-live2d-id: expressions 不在 live2d-ids.json:唱歌`。
4. capability-scan profile 的 controls(ext.expression.* / motion-pair)内容与上述**一致**——四个来源(硬编码×2、live2d-ids.json、profile)目前内容相同,但**靠人工同步,无单一事实源**。新增模型时漂移风险在此。

## 4. #52 AI 节点编辑通道可用性(dev-server 实测)

dev-server **已接入全部三条路由**(tools/dev-server/index.mjs:523-568,处理器共用 lib/nodegraph-api.mjs):

| 路由 | 实测 |
|---|---|
| GET /api/nodegraph/graph?name= | 200,返回归一化 editor graph + hash(`5acc3296495b501a`)+ valid:true |
| POST /api/nodegraph/apply-ops {name,ops} | `add_node`(n9 脸红)+`connect`(b5→n9)→ ok,valid:true,**saved:true 自动写回**(hash 变为 `1c0b8f8cd8109059`);`remove_node` 恢复原状同样 saved:true |
| POST /api/nodegraph/apply-ops 白名单反例 | `set_param name=唱歌` → ok:false,valid:false,**applied:false 不写回**,`unknown-live2d-id` |
| POST /api/nodegraph/ai-edit | 无 DEEPSEEK_API_KEY → **HTTP 503** `{"reason":"ai-unavailable","message":"宿主 LLM 通道不可用…未生成任何改动"}`(如实降级,不伪造);缺 graph 字段 → 400 invalid-graph |

op 命名是下划线风格:`add_node / remove_node / set_param / connect / disconnect / move_node`(发 `addNode` 会得到明确 `unknown-op` 错误)。**结论:#52 通道在 dev-server 完全可用**,名称校验落在 live2d-ids.json,兜底为 choreography 白名单。

## 5. 编辑器 UI 链路(motion-graph.html)

- `?selftest` 无头自测入口实测(受控浏览器 tab_title 一步取证):`MG-SELFTEST validate-ok roundtrip-ok sim=3steps/1segs resizers-ok ctx-ok combo-ok panels-ok console-ok chips-ok jsonpv-ok i18n-ok fold-ok nodeui-ok aiedit-ok` —— **全绿**。其中:
  - `validate-ok`/`roundtrip-ok`:Validator.check 与 Serializer.import/export 一致性(即「导入→校验 badge→导出 roundtrip」的同一函数路径);
  - `console-ok`:ExecConsole 自测含 `window.__MG_EXEC_PUSH__` 注入假回执 → 时间线行出现的断言(源码 motion-graph.html:5668-5679);
  - `aiedit-ok`:AiEditAdapter mock 通路。
- 图 B JSON 的编辑器校验判定通过链路佐证:dev-server saveNodegraph 用同一规则族判 valid:true;编辑器 Validator 为同一规则的本地复刻(有对拍测试约束)。
- **工具限制如实记录**:受控浏览器对本页(canvas/SVG 自绘应用)的 visible-DOM 快照恒为空、截图通道超限(>10MiB),导入模态(顶栏「导入」→ textarea → 从文本导入)的人工点击路径无法以截图/DOM 取证。模态背后即 `IO.applyText → Serializer.import`,已由 roundtrip 自测覆盖;未发现编辑器侧缺陷。

## 6. 三模型编辑器链路可用性结论

| 模型 | 直接搭图执行 | 原因 |
|---|---|---|
| deepseek 目录(=大肥鱼) | **可以** | model3.json 已登记 21 表情/6+Idle 动作组,四处白名单同步覆盖 |
| miku | **不行(名字层全拒)** | model3.json Expressions=[]、Motions={};miku 独有资源名(唱歌/圈圈/比心/水印/葱/QQ人/Scene1)全不在白名单;重合名(兔牙/脸红/前倾)能过校验但执行时播的是大肥鱼语义,对 miku 无意义 |
| 小祥 | **不行(名字层全拒)** | 同 miku,资源登记空白 |

**接入新模型的前置步骤**(按现状架构):
1. 补 model3.json `FileReferences.Expressions/Motions` 登记(exp3/motion3 文件 → 组名),这是执行层(lappmodel)与扫描的共同前提;
2. 同步四处名称源:choreography.mjs `MODEL_EXPRESSIONS/MODEL_MOTION_GROUPS`(执行校验)、motion-graph.html `Capability`(编辑器)、docs/nodegraph/live2d-ids.json(#52 通道)、capability-scan profile(画像/动作库);当前无单一事实源,建议长期收敛为 capability profile 驱动(硬编码改读 profile),短期按 checklist 人工同步;
3. dev-server/宿主的 `DSH_L2D_ACTIONS_MODEL_ID` 与 capability.json 指向新 profile。

## 7. 证据文件与清理

- fixture:`C:/Users/User/AppData/Local/Temp/mg-e2e-fixtures/*.json`(5 份,保留可复跑)
- dev-server:测后 `node tools/dev-server/index.mjs --port 5344` 进程已终止,5344 端口探活失败(已杀净)
- 图 B 存储已恢复原状(n9 已 remove,motion-mode 未改动,保持 nodegraph)
- 源码零改动;本文件为唯一仓库内新增
