# Phase 2：动作知识库基座

> ⚠️ **状态声明：`runtime_verified` 尚未完成。** 本 PR 全部验证均为静态管道验证（G0–G4 + E2E 执行闸门）。真实 Live2D 渲染运行时探针属 Phase 3，技术方案已备：`docs/architecture/RUNTIME-VERIFICATION-PLAN.md`。`validated` / `runtime_verified` / `approved` 三种状态严格分立，互不替代。

## 本 PR 完成的成果（P0–P4）

### 数据库基座（@dsh/db，schema v1→v4，30 表，node:sqlite 零原生依赖）
- 统一 SQLite 注册表：bootstrap / 模型智能域（models, nodes, edges, parameters…）/ 图库语义域（v2）/ 动作知识域（v3）/ Foundation 补列（v4）
- Actions Lib Repository（`actions-repo.mjs`）：动作链唯一写入口。R4 唯一入口 / R6 快照提交协议（tmp→fsync→rename→事务→哈希回读）/ R7 仅 validated 可导出 / R8 版本不可变 / R9 semantic_key 幂等（同键异内容显式 VERSION_CONFLICT）/ R10 拒绝留痕永不删除
- G0–G4 入库管道（ingestion-pipeline）：素材→分析→定义→链→验证，直产 validated
- 状态机：draft→analyzing→planned→validated→deprecated；rejected 终态；乐观并发（版本号）
- Model Adapter（fail-closed）：`bindMotionToModel` / `resolveMotionParams`（版本漂移→STALE_BINDING→绑定置 incompatible）/ `diffModelParameterSets`；语义链禁止硬编码模型参数 ID

### 真实模型注册（大肥鱼.dsl2d）
- 509 参数 + 147 Parts 全量注册（cdi3 中文名 source_exact）；148 vs 147 Parts 差异如实入 finding
- min/max 仅注册有证据的 33 个参数，其余 NULL（不伪造）
- MOC3 工具链注册（py-moc3 v0.1.0@2fb112e，MIT，读路径 verified）+ `l2d_toolchain_status` 只读 MCP 工具

### GIF 逐帧提取与时序分析（动作知识库数据入口，非独立图片工具）
- vendor omggif 1.0.10（MIT，sha256 `bd898d5b…3b12` 锁定，`.cjs` 适配 ESM 仓库）
- disposal 0–3 按规范合成、透明保留、48×48 归一化网格 RGBA diff、自相关周期检测
- 一切结论 `needs_review`，绝不自动认定语义；产物入 motion_assets/motion_analysis 可追溯
- 批量报告：`data/gif-motion-report.json`（11/11 GIF）

### 语义标注与人工审核闸门
- 标注批次 61 条标签（batch-1 静态 8 图 52 条 + batch-2 GIF 动作线索 9 条），全部 `needs_review`
- `review.mjs`：唯一流转入口，逐条人工 decide，全决策留痕，已裁决不可覆写
- `audit-report.mjs`：只读审核报告生成器（`docs/REVIEW-AUDIT-REPORT.md`：低置信度 0 / 争议 8 组 / 待人工决策 61）

### 端到端验证
- `tools/e2e/e2e-pipeline.mjs`：13/13 环节通过（临时库 + 真实素材 hash + 真实参数 ID）：素材导入→去重→分析→标注→人工审核→Nodes→动作链 G0-G4→draft 管道→Model Adapter 映射→状态机→执行闸门（负向验证）→执行记录→探针留位（如实标注 blocked，留 Phase 3）

## 独立验收修复（本分支内完成，2026-11-04）

| 发现 | 严重度 | 修复 |
| --- | --- | --- |
| `upsertGalleryLabel/Item` UPSERT 可覆写已裁决 review_state/evidence（绕过 review.mjs 闸门） | 高 | CASE 守卫：approved/rejected 行冻结，新提交 `fc3863c` |
| `tools/motion-gif/vendor` 被 `.gitignore` 的 `vendor/` 规则误伤，omggif 未入库（克隆即坏） | 高 | gitignore 例外 + 补交 `7536628` |
| 模型 `runtime_verified` 状态可被任意调用自封（validated/runtime_verified 混淆风险） | 中 | `upsertModel` 闸门：置 runtime_verified 必须携带 `runtimeEvidence` 探针证据并留痕 `motion_status_log` |
| `upsertLearningJob` ON CONFLICT(id) 死代码（id 恒为新 uuid） | 中 | 改纯追加（学习任务是事件流） |
| adapter 同通道重复 paramId / min>max 未校验（冲突映射风险） | 中 | `validateAdapterShape` 补查 |
| analyzeTiming 自相关注释与实现不符 | 低 | 注释对齐（最高分峰，防倍频误选） |
| Phase 1 六份架构文档 + Actions JSON 入库规则未入 git | 中 | 补交 `50846b7` |

## 三态分立保证（本分支措施）

1. `validated`：仅 G0–G4 / 版本修订产生；状态机无到 runtime_verified 的转换（动作级不存在该枚举）
2. `runtime_verified`（模型级）：仅 `upsertModel` 可写，且强制 `runtimeEvidence` + `motion_status_log` 留痕
3. `approved`：仅 `review.mjs decide`（人工逐条）；repo 层 UPSERT 已加 CASE 守卫，无法绕过
4. 动作的运行时验证证据落 `execution_history` / `probe_runs`，**不改变** `motion_definitions.status`

## 测试

- `packages/dsh-l2d-db/test/`：6 文件全通过（迁移幂等 / 约束拒绝 / 外键级联 / 乐观并发 / 快照 R6 / fail-closed adapter / 审核闸门不可覆写 / runtime_verified 证据闸门）
- `tools/motion-gif/analyze.test.mjs`：解码/合成/时序单测
- E2E：13/13

## 已知限制与后续任务

1. **runtime_verified 未完成**（Phase 3）：方案 `docs/architecture/RUNTIME-VERIFICATION-PLAN.md`——六模块架构、V1–V7 判据、异常中止路径、**三动作跨参数族测试**（尾巴 Rotation84–87 / 耳族 / 表情 AngryMove×8），防止单案例映射侥幸通过
2. **注入准入 P3-0**：目标注入通道（Rotation84–87 等）min/max 均无注册证据（实测 cdi3/vtube 均无范围字段）；须先用 py-moc3 从 moc3 二进制读范围（source_exact）人工核对注册后，才允许注入
3. 61 条标签待人工复核：`node tools/gallery-schema/review.mjs list` 逐条决策（本 PR 不含任何自动批准）
4. P3 剩余素材（fan_art 15 / photo 28 / screenshot 8 / other 34）未标注——按用户指示暂不开展大规模标注
5. probe_runs 真实探针需渲染运行时，E2E 中如实标注 blocked

## 提交结构（15 笔，语义分组）

```
fb2ae32 docs(p3): runtime verification plan
db0b3a9 feat(p2-audit): human review audit report generator
7536628 fix(gitignore): allow vendored omggif (MIT, sha256-locked)
fc3863c fix(review-gate): independent audit P1 fixes
50846b7 docs: Phase 1 architecture proposals into git tracking
07768c0 feat(p3+p4): human review gate + gif-assisted labels + e2e
14add43 feat(p2): GIF frame-extraction & motion timing pipeline
b0cb185 feat(p1): Model Nodes registry + image-motion bridge
30997d2 fix(db): GLM 验收 WARN 修复
f8d40f0 feat(db): Phase 2 Foundation — Actions Lib Repository, G0-G4
7e2185f feat(motion+gallery): action-knowledge domain v3 + actions JSON spec
8a5c3ec feat(gallery): gallery semantic pipeline (migration v2)
d3b8ef9 docs(airi-guide): upstream verification
33c96ef feat(mcp): MOC3 toolchain in SQLite + l2d_toolchain_status
5f510c4 feat(db): unified SQLite registry (bootstrap + model intelligence)
```
