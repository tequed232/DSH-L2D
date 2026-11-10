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
