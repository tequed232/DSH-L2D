# 三模型测试 + Issue 处理总验收报告（2026-11-10 12:36-13:10）

> 任务：拉取仓库最新 commit 后，对三份模型（miku / 小祥 / DeepSeek 皮）逐一测试体态、动作、表情，报告结果与问题并修复；动作链节点编辑器构建节点动作链测试；处理仓库 open issues。
> 执行：6 个子代理并行（结构/渲染/动作链/审计/#28 修复/#33 修复），主理人终审合并。
> 基线：main @ 8bf09c4（git pull，含 #51-53 新 PR）。

---

## 一、三模型测试矩阵总表

| 维度 | miku（VTS 导出） | 小祥（VTS 导出） | DeepSeek 皮（大肥鱼，基线） |
|------|-----------------|-----------------|--------------------------|
| moc3 v5 × Core 5-r.5 兼容 | ✅ | ✅ | ✅ |
| 浏览器真渲染显示 | ✅ drawables=440 | ✅ drawables=32（中文文件名 URL 编码全通） | ✅ 基线 |
| 纹理加载 | ✅ 6/6 | ✅ 1/1 | ✅ 5/5 |
| **表情** | ❌→✅ 已修复（登记+校验放行） | ❌→✅ 已修复（客服小祥放行） | ✅ 原生 |
| **动作** | ❌→✅ 已修复（Scene1 放行） | ⚠️ 目录无 motion3（降级非错误） | ✅ 原生（Idle 真实播放） |
| **体态（pose）** | ⚠️ 同名参数全为物理输出需 own | ❌ 无该批参数（fail-closed 正确） | ✅ |
| 动作链编辑器搭图 | ❌→✅ 已修复（校验放行） | ❌→✅ 已修复 | ✅ 全链路（导入→run→回执→Console） |

详细矩阵：MODEL-TEST-STRUCTURE.md（结构）/ MODEL-TEST-RENDER.md（渲染）/ MODEL-TEST-CHAIN.md（动作链）。

## 二、发现的问题与修复（全部已推送 main）

| # | 问题 | 修复 | Commit |
|---|------|------|--------|
| P1 | VTS 导出模型 FileReferences 空（Expressions=[] Motions={}），DSH 全链依赖它发现资源 | ① host-guard 目录扫描回退（校验层）② tools/model-resources/register.mjs 登记补丁（数据层，原子写回 model3.json） | fdc6df9 + 421baa5 |
| P2 | 动作链/序列校验白名单硬编码大肥鱼名单，新模型资源被拒 | validateStep/checkActChain/validateActChain/validateActionSequence 支持 allowed 注入（静态∪当前模型索引；口型红线保留） | c1aed2b |
| P3 | capability.json 按文件名排序取第一份画像（多模型混部拿错） | 按 modelId 精确匹配，失配 404+rescan 提示 | f486dc0 |
| P4 | bindings.mjs head.* 正则不认标准命名 ParamAngleX/Y/Z | /^(?:Param)?Angle[XYZ]$/，miku/小祥各白捡 3 个 gaze 通道 | f486dc0 |
| P5 | 白名单按名字符串匹配不绑定模型（A 模型名碰巧命中 B 白名单即放行） | 模型绑定拒绝断言（测试覆盖）；MCP 闸模型绑定生效 | f486dc0 |
| P6 | NODE-SCHEMA.json 与 buildNodeSchema() 不一致（PR 合并遗留） | 重新生成（根因 core.autocrlf 行尾，建议后续 .gitattributes 加 eol=lf） | 本地（无 diff 不需提交） |
| P7 | issue #33 PR-D 两个生产接线缺口 | aiInbox 订阅三 API（observe/peekResult/subscribeCompletion）+ executor 注入 subscribeEvents/releaseGraceMs=1000ms；修兜底定时器 unref 挂死 bug | 346c1ed |

## 三、Issue 处理状态

- **#28 模型切换一致性**：✅ 修复完成（fdc6df9/c1aed2b/421baa5/f486dc0）——加载入口/画像/校验三问题全解，三目录真实取证。**待关闭**（gh token 缺 public_repo 写权限）。
- **#33 真实动画完成事件**：✅ 完成——主体已在 main（f36feff PR #42）+ 本轮生产接线（346c1ed）+ 测试补齐（868346f）。**待关闭**（同 token 问题）。真机 runtime-probe 验证留宿主在线。
- **#36 标签审计**：📄 辅助材料完成——AUDIT36-DECISION-WORKSHEET.md（61 条全覆盖，P0 冲突 19/P1 存疑 17/P2 明确 25，AngryMove 证据清单）。**需你逐条 decide**（issue 明确禁止代批）；issue 评论因 token 受阻，全文可复制。
- **#18 Limb Allocation**：冻结不动（评审裁定）。

## 四、待你处理事项

1. **#36 逐条裁决**：填 AUDIT36-DECISION-WORKSHEET.md 的 decide 列（keep/reclassify/block）→ 我经 review.mjs decide 落库闭环。
2. **gh token**：当前 token 缺 public_repo 写权限，#28/#33 关闭与 #36 评论需手动或换 token。
3. **宿主 3080 在线时**：Live2D 真机呈现验收（UI 链路已全绿，差最后一环渲染画面）+ #33 真机 runtime-probe（diag 看 'done phase=end (runtime-event)' 标记）+ miku/小祥 登记补丁后表情/动作真机播放确认。

## 五、Acceptance Status

**PASS_WITH_WARNINGS** —— 三模型测试覆盖体态/动作/表情三方面全部完成且问题已修复（P1-P7 七项）；渲染加载三模型全绿；动作链编辑器全链路实测通过；#28/#33 修复完成待关闭（token）；#36 待人工裁决（材料就绪）。


---

# 附加轮：按单个模型编辑动作链（2026-11-10 13:50，用户方案落地）

## 交付（两代理并行 + 主理人联调）

### 后端（impl-mb-backend，7 commit 31c1f6a→2fb4085）
- getCurrentModelId() 封装；loadLive2dIdsForModel（docs/nodegraph/models/<modelId>/live2d-ids.json，回退全局+model-catalog-missing 告警，mtime 缓存）；isSafeModelId（拦 .. 与分隔符，单个点放行——大肥鱼.dsl2d.2048 带点通过）
- 校验按图绑定模型选清单（applyOps/apply-ops/ai-edit/导入/MCP 两工具，allowed 注入贯通）；strict 运行时强制 409 model-mismatch（registry.begin 之前，零动作下发，测试固化）；any 加 warning
- graph ?model= 过滤（any 图列出 matches:false）；catalog 接口；新图默认 strict 绑当前模型
- 10 组行为测试 + dev-server e2e 6/6；AI-EDIT-API.md/NODE-SCHEMA.json 更新
- 三模型目录真实生成：大肥鱼.dsl2d.2048（509 参/7 动作组/21 表情/forms[0,1,2]）、miku（141 参/Scene1/8 表情，FileReferences 空目录扫描回退）、丰川祥子（30 参/客服小祥）

### 前端（impl-mb-frontend，6ad5857）
- 顶栏模型选择器（切换=切工作区）；列表 ?model= 过滤；新建图 strict 绑定+删写死 modelId:/x27大肥鱼/x27/n- 字段下拉目录驱动（清单外标红/无清单退手动+提示）；跨模型图弹窗+切换按钮；旧图绑定按钮
- ai-edit 带 modelId + 409 双按钮处理；i18n 三语 30 键；selftest 第 15 组 modelTest（8 断言）
- build verify IDENTICAL；selftest 15 组全绿；TUTORIAL.md 新章节（全文无大肥鱼，示例 demo-model）

### 主理人联调（8b457d8）
- dev-server 接入 catalog?model=X 与 graph ?model=（handleCatalog deps.modelId 键名修正）；真实接口冒烟：无参→大肥鱼.dsl2d.2048 清单、?model=miku→8 表情+Scene1、../etc→400 拒

## 专项验收对照（用户方案六条验收标准）
1. ✅ 选中模型 A 只能看到编辑新建 A 的动作链，下拉只有 A 的资源
2. ✅ strict 绑 A 的图在 B 上运行 → 409 model-mismatch 零动作下发，前端双按钮处理
3. ✅ 模型无目录仍可用（回退全局+警告，前端退手动输入+提示）
4. ✅ AI 编辑按当前模型清单生成/校验（提示词用该模型清单）
5. ✅ 后端测试 10 组 + 前端 selftest 15 组 + build verify 全过
6. ⏳ 8 个 workshop 模型清单生成待后端代理后续轮（已解压盘点：0~415 motion 多样性压力集）

## 已知边界
- live2d-ids.json 授权处置待用户裁定（本地生成不入库，models/ 已 .gitignore）
- 编辑器内 Validator 仍静态白名单（目录驱动 UI 层），校验动态化由后端 409 兜底
- workshop 8 模型清单生成待续（工具已泛化，一条命令一个模型）
- dev-server 无当前模型概念进 strict 闸门（闸门只在宿主 run 路由）

## Acceptance Status
PASS_WITH_WARNINGS —— 方案后端+前端+联调全部落地；workshop 批量清单与 live2d-ids.json 授权处置为遗留待办。