# GALLERY-BRIDGE 裁决书

- 生效：2026-11-05 22:04，主理人齐汇川依据用户 2026-11-05 22:00 口述方案落盘
- 目标：情绪动作判断后，Bridge 向 Agent 回传参考图片（默认自动附 1 张，Agent 可主动请求，全局上限 3 张），Agent 基于图片向 model 下发具体动作指令。「回传哪三张」由图库打分决定；打分器由独立 Agent 执行，分数存 SQLite。

## §1 数据现状（已核实）

- 库：`data/bootstrap-state.sqlite`
  - `gallery_items` 105 条（file_name / source_class / real_format / sha256 / review_state）
  - `gallery_labels` 61 条，仅覆盖 11 个 item；字段分布：part 21 / expression 13 / outfit 7 / pose 8 / scene 4 / motion_cue 3 / style 3 / color 1 / other 1
  - source_class 分布：other 35 / photo 30 / fan_art 18 / gif_reference 10 / screenshot 9 / character_sheet 2 / poster 1
- 图源目录：`D:/Temp/l2d-gallery-extract/`（scan.mjs 登记时的外部目录；配置项 `GALLERY_DIR`，默认此路径，env 可覆盖）
- Bridge 现有工具：`l2d_action_enqueue` / `l2d_action_status` / `l2d_action_cancel`（mcp-tools.mjs）

## §2 图库打分器

分数 ∈ [0,100]，规则引擎（基于已入库标注 + source_class 先验）与视觉补充（打分 Agent）两层合成：

| 维度 | 规则 | 上限 |
|------|------|------|
| expression | 每条 expression 标签 +12 | 36 |
| body | pose +8/条，motion_cue +15/条 | 35 |
| clarity | motion_cue/pose 且 evidence_level=source_exact +14；confidence<0.5 减半 | 14 |
| text_penalty | character_sheet −20，poster −10；evidence 含大段文字抄录 −5 | −35 |
| prior | gif_reference +15 / fan_art +10 / screenshot +5 / photo、other +0 | 15 |

- **视觉补充打分范围**：fan_art(18) + gif_reference(10) + screenshot(9) = 37 张高价值图，由打分 Agent 逐张视觉评估（表情丰富度 / 肢体动作度 / 动作清晰度，各 0-100）。其余 68 张（photo/other/character_sheet/poster）按规则引擎基础分入库。
- **落库路径（防冲突）**：打分 Agent 只产中间文件 `data/gallery-scores-draft.json`；主库写入统一由后端席 v10 导入脚本执行。打分 Agent 禁直写主库。
- 合成规则：有视觉分的 item，score = 规则分 × 0.4 + 视觉综合分 × 0.6；无视觉分 item 直接用规则分。breakdown_json 保留两层明细。

## §3 gallery_scores 表（v10 迁移，后端席实施）

```sql
CREATE TABLE IF NOT EXISTS gallery_scores (
  item_id INTEGER PRIMARY KEY REFERENCES gallery_items(id),
  score REAL NOT NULL CHECK (score >= 0 AND score <= 100),
  breakdown_json TEXT NOT NULL,
  scorer TEXT NOT NULL,            -- 'rule-engine-v1' | 'vision-agent-v1' | 'blend-v1'
  scored_at TEXT NOT NULL
);
```

- 串行门禁：v10 在 v9（observer_dispatch_log，P12 产出）commit 之后追加，同文件 schema.mjs 不得并行。
- 导入幂等：按 item_id upsert；重复导入时 vision/blend 优先于 rule-engine。
- 顺带 seed `prompt_templates` 新模板 `motion-director-v1`（正文见 §6）。

## §4 Bridge 附图机制（后端席实施）

1. **新工具 `l2d_gallery_top`**：args `{ emotion?, limit? }`；`limit` 服务端 clamp 至 3（宽松 clamp，不报错）；响应 = MCP image content（base64）× N + 文本清单（item_id / score / source_class / 情绪摘要）。
2. **matcher 自动附图**（2026-11-05 22:30 裁定修订）：action-matcher 匹配命中动作链时，自动附该情绪 score 排序 top-1 图，附图底线 score ≥ 30（防纯文字/低质图混入）。~~原条款 score>60 绝对阈值~~ 废止——打分实测分布 [0,51.4]（标注稀疏导致结构性偏低），绝对阈值永不触发；top-N 相对排序自适应分布漂移。打分公式 v2 校准待 61 条标注人工审计后进行。
3. **图片读取**：`GALLERY_DIR` 下按 `gallery_items.file_name` 定位；文件缺失跳过并在文本区注明，不 500。
4. **上下文护栏（用户最高优先级）**：单图 base64 后 > 2MB 跳过；一次响应图片总数硬上限 3；无 score 数据时工具返回空集 + 提示「打分未完成」，不退化为全量随机。

## §5 打分 Agent 授权

- 席位：临时打分专席（gallery-scorer），向 team-lead 汇报。
- 产出：`tools/gallery-schema/score.mjs`（规则引擎，node:stdlib 零依赖）+ `data/gallery-scores-draft.json`（105 条全量）+ 结构化报告（限 40 行）。
- 边界：只读 DB（readOnly:true）；禁写主库；禁碰 packages/**、tools/dev-server、docs/**。

## §6 motion-director-v1 模板正文（主理人定稿）

```
你是 DSH Live2D 动作指挥。你将收到 1-3 张角色参考图（附 item_id 与分数）。
流程：
1. 读图：列出图中可见的表情（smile/angry/blush 等）与肢体姿态（举手/歪头/裙摆扬起等），禁止想象图中不存在的动作。
2. 映射：优先映射到动作库 semantic_key（如 ear_twitch_independent / angry_flash_single）；无匹配链时用参数级指令（keyframes + ParamId）表达，参数仅限 capability scan 报告的安全参数族与 adapter 绑定参数。
3. 下发：经 l2d_action_enqueue 提交，一次一条链，附 60 字内动作意图说明。
4. 约束：不重复提交相同链；l2d_action_status 显示排队中时等待再提交；需要更多参考时经 l2d_gallery_top 请求，单次不超过 3 张。
```

## §7 文件所有权与串行门禁

| 成员 | 可改 |
|------|------|
| 陆溯源（后端） | packages/dsh-l2d-db/src/schema.mjs（v10）、src/gallery-repo.mjs（新）、packages/mcp-bridge/{mcp-tools,action-matcher,index}.mjs、v10 导入脚本、prompt_templates seed |
| gallery-scorer | tools/gallery-schema/score.mjs（新）、data/gallery-scores-draft.json（新） |

- schema.mjs 为串行资源：v9（P12）→ v10（本裁决）严格按序 commit。
- action-matcher.mjs 为 P12 在途文件：本裁决附图改动在其 commit 之后进行，避免混改。
