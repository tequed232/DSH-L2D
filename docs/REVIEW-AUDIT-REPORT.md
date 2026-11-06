# DSH-L2D 标签审核报告（独立验收 P2）

- 生成时间：2026-11-04T06:50:56.288Z
- 生成者：audit-report.mjs（只读，未修改任何标签状态）
- 低置信度阈值：confidence < 0.7
- 标签总量：61

## 总览

| 维度 | 分布 |
| --- | --- |
| 审核状态 | needs_review=61 |
| 证据来源 | inferred=39，source_exact=19，parser_derived=3 |
| 标签字段 | part=21，pose=8，style=3，color=1，expression=13，outfit=7，scene=4，other=1，motion_cue=3 |

## ⚠️ 低置信度标签（重点人工复核）

（无）

## ⚠️ 争议项（同语义跨素材证据不一致）

- **part=whale_tail**：4 条标签（#15@HTMmWmCaYAAilyN.jpg，#1@dafeiyu-mature-character-sheet.png，#35@HUokZsIbgAAKJZJ.jpg，#24@bili_poster-1791382745061.png）；置信度范围 0.80~0.95（极差 0.15）；证据等级 inferred/source_exact
- **part=whale_fin_ears**：3 条标签（#16@HTMmWmCaYAAilyN.jpg，#2@dafeiyu-mature-character-sheet.png，#30@heybox_1792638467783_-1242029457.png）；置信度范围 0.80~0.95（极差 0.15）；证据等级 inferred/source_exact
- **part=maid_headdress**：4 条标签（#17@HTMmWmCaYAAilyN.jpg，#3@dafeiyu-mature-character-sheet.png，#41@HTRat8FXUAAl484.jpg，#47@IMG_20261007_220618_CROP.jpg）；置信度范围 0.80~0.95（极差 0.15）；证据等级 inferred/source_exact
- **part=whale_embroidery**：3 条标签（#18@HTMmWmCaYAAilyN.jpg，#5@dafeiyu-mature-character-sheet.png，#36@HUokZsIbgAAKJZJ.jpg）；置信度范围 0.80~0.90（极差 0.10）；证据等级 inferred/source_exact
- **style=chibi**：2 条标签（#19@HTMmWmCaYAAilyN.jpg，#55@1790571183144.gif）；置信度范围 0.95~0.95（极差 0.00）；证据等级 inferred/source_exact
- **expression=smile_open_mouth**：2 条标签（#11@dafeiyu-mature-character-sheet.png，#26@heybox_1792638467783_-1242029457.png）；置信度范围 0.80~0.90（极差 0.10）；证据等级 source_exact/inferred
- **outfit=navy_maid_dress**：2 条标签（#7@dafeiyu-mature-character-sheet.png，#40@HTRat8FXUAAl484.jpg）；置信度范围 0.80~0.90（极差 0.10）；证据等级 source_exact/inferred
- **part=blue_bow_accessories**：2 条标签（#6@dafeiyu-mature-character-sheet.png，#52@ChatGPT Õø¥ÕâÅ 2026զ¦10µ£ê3µùÑ 15_49_09.png）；置信度范围 0.80~0.90（极差 0.10）；证据等级 source_exact/inferred

## 🖐️ 需人工决策清单（逐条 review.mjs decide）

以下每一条都必须由人显式执行 `node tools/gallery-schema/review.mjs decide <id> approved|rejected [--note "..."]`。
本报告与任何自动化流程均不会代为决策。

### HTMmWmCaYAAilyN.jpg（character_sheet）

- #15 [part] whale_tail — conf=0.95，inferred
- #16 [part] whale_fin_ears — conf=0.95，inferred
- #17 [part] maid_headdress — conf=0.95，inferred
- #18 [part] whale_embroidery — conf=0.9，inferred
- #14 [pose] three_view_chibi_standing — conf=1，source_exact
- #19 [style] chibi — conf=0.95，inferred
### dafeiyu-mature-character-sheet.png（character_sheet）

- #12 [color] navy_white_blue_palette — conf=0.9，inferred
- #11 [expression] smile_open_mouth — conf=0.8，source_exact
- #7 [outfit] navy_maid_dress — conf=0.8，source_exact
- #8 [outfit] white_apron — conf=0.8，source_exact
- #9 [outfit] white_tights_black_shoes — conf=0.8，source_exact
- #1 [part] whale_tail — conf=0.8，source_exact（已关联节点 41）
- #2 [part] whale_fin_ears — conf=0.8，source_exact（已关联节点 29）
- #3 [part] maid_headdress — conf=0.8，source_exact（已关联节点 30）
- #4 [part] long_wavy_hair — conf=0.8，source_exact（已关联节点 11）
- #5 [part] whale_embroidery — conf=0.8，source_exact
- #6 [part] blue_bow_accessories — conf=0.8，source_exact
- #10 [pose] three_view_standing — conf=0.8，source_exact
- #13 [style] anime_soft_shading — conf=0.8，inferred
### ChatGPT Õø¥ÕâÅ 2026զ¦10µ£ê3µùÑ 15_49_09.png（fan_art）

- #48 [expression] gentle_smile — conf=0.9，inferred
- #49 [expression] blush — conf=0.85，inferred
- #51 [outfit] navy_maid_dress_detached_sleeves — conf=0.85，inferred
- #52 [part] blue_bow_accessories — conf=0.9，inferred
- #50 [pose] hand_to_cheek — conf=0.9，inferred
### HTRat8FXUAAl484.jpg（fan_art）

- #39 [expression] surprised_tearful — conf=0.85，inferred
- #40 [outfit] navy_maid_dress — conf=0.9，inferred
- #41 [part] maid_headdress — conf=0.9，inferred
- #42 [pose] hugging — conf=0.9，inferred
- #38 [scene] group_shot_deepseek_cast — conf=0.95，inferred
### HUokZsIbgAAKJZJ.jpg（fan_art）

- #32 [expression] sleepy_half_lidded_smile — conf=0.9，inferred
- #33 [expression] blush — conf=0.85，inferred
- #37 [other] speech_bubble_text — conf=1，source_exact
- #35 [part] whale_tail — conf=0.85，inferred
- #36 [part] whale_embroidery — conf=0.9，inferred
- #34 [pose] both_palms_raised — conf=0.9，inferred
### 1790571183144.gif（gif_reference）

- #53 [motion_cue] chibi_dog_tail_grass_wave — conf=0.85，parser_derived
- #54 [part] chibi_dog_tail_grass_prop — conf=0.9，source_exact
- #56 [scene] night_sky — conf=0.8，source_exact
- #55 [style] chibi — conf=0.95，source_exact
### 27260cb26da951ab70f83962775ec1579bd0e52d8885184725abc160ec3bd31b.gif（gif_reference）

- #57 [expression] dazed_thinking — conf=0.9，source_exact
- #58 [motion_cue] loading_spinner_single_shot — conf=0.7，parser_derived
- #59 [scene] speech_bubble_text — conf=0.85，source_exact
### 1791949382162.gif（photo）

- #60 [motion_cue] head_pat_interaction_plush — conf=0.75，parser_derived
- #61 [part] chibi_plush_doll — conf=0.9，source_exact
### IMG_20261007_220618_CROP.jpg（photo）

- #43 [expression] content_smile_closed_mouth — conf=0.9，inferred
- #44 [expression] blush — conf=0.85，inferred
- #46 [part] flower_iris_highlight — conf=0.9，inferred
- #47 [part] maid_headdress — conf=0.9，inferred
- #45 [pose] hand_near_cheek — conf=0.9，inferred
### bili_poster-1791382745061.png（poster）

- #20 [expression] sleepy_half_lidded — conf=0.85，inferred
- #21 [expression] finger_on_lips — conf=0.8，inferred
- #23 [outfit] navy_maid_dress_short_with_thighhighs — conf=0.85，inferred
- #24 [part] whale_tail — conf=0.9，inferred
- #22 [pose] lying_on_bed — conf=0.9，inferred
- #25 [scene] bedroom — conf=0.9，inferred
### heybox_1792638467783_-1242029457.png（screenshot）

- #26 [expression] smile_open_mouth — conf=0.9，inferred
- #27 [expression] blush — conf=0.8，inferred
- #29 [outfit] dark_maid_variant_grey_apron — conf=0.8，inferred
- #30 [part] whale_fin_ears — conf=0.85，inferred
- #31 [part] blue_crystal_brooch — conf=0.85，inferred
- #28 [pose] hand_raised_pinch — conf=0.85，inferred

## 🔒 已裁决标签（不可覆写，仅存档展示）

（当前无已裁决标签）

## 明细（按素材分组）

### HTMmWmCaYAAilyN.jpg（character_sheet）

| # | 字段 | 值 | 置信度 | 证据来源 | 状态 | 关联节点 |
| --- | --- | --- | --- | --- | --- | --- |
| #15 | part | whale_tail | 0.95 | inferred | needs_review | - |
| #16 | part | whale_fin_ears | 0.95 | inferred | needs_review | - |
| #17 | part | maid_headdress | 0.95 | inferred | needs_review | - |
| #18 | part | whale_embroidery | 0.9 | inferred | needs_review | - |
| #14 | pose | three_view_chibi_standing | 1 | source_exact | needs_review | - |
| #19 | style | chibi | 0.95 | inferred | needs_review | - |
### dafeiyu-mature-character-sheet.png（character_sheet）

| # | 字段 | 值 | 置信度 | 证据来源 | 状态 | 关联节点 |
| --- | --- | --- | --- | --- | --- | --- |
| #12 | color | navy_white_blue_palette | 0.9 | inferred | needs_review | - |
| #11 | expression | smile_open_mouth | 0.8 | source_exact | needs_review | - |
| #7 | outfit | navy_maid_dress | 0.8 | source_exact | needs_review | - |
| #8 | outfit | white_apron | 0.8 | source_exact | needs_review | - |
| #9 | outfit | white_tights_black_shoes | 0.8 | source_exact | needs_review | - |
| #1 | part | whale_tail | 0.8 | source_exact | needs_review | 41 |
| #2 | part | whale_fin_ears | 0.8 | source_exact | needs_review | 29 |
| #3 | part | maid_headdress | 0.8 | source_exact | needs_review | 30 |
| #4 | part | long_wavy_hair | 0.8 | source_exact | needs_review | 11 |
| #5 | part | whale_embroidery | 0.8 | source_exact | needs_review | - |
| #6 | part | blue_bow_accessories | 0.8 | source_exact | needs_review | - |
| #10 | pose | three_view_standing | 0.8 | source_exact | needs_review | - |
| #13 | style | anime_soft_shading | 0.8 | inferred | needs_review | - |
### ChatGPT Õø¥ÕâÅ 2026զ¦10µ£ê3µùÑ 15_49_09.png（fan_art）

| # | 字段 | 值 | 置信度 | 证据来源 | 状态 | 关联节点 |
| --- | --- | --- | --- | --- | --- | --- |
| #48 | expression | gentle_smile | 0.9 | inferred | needs_review | - |
| #49 | expression | blush | 0.85 | inferred | needs_review | - |
| #51 | outfit | navy_maid_dress_detached_sleeves | 0.85 | inferred | needs_review | - |
| #52 | part | blue_bow_accessories | 0.9 | inferred | needs_review | - |
| #50 | pose | hand_to_cheek | 0.9 | inferred | needs_review | - |
### HTRat8FXUAAl484.jpg（fan_art）

| # | 字段 | 值 | 置信度 | 证据来源 | 状态 | 关联节点 |
| --- | --- | --- | --- | --- | --- | --- |
| #39 | expression | surprised_tearful | 0.85 | inferred | needs_review | - |
| #40 | outfit | navy_maid_dress | 0.9 | inferred | needs_review | - |
| #41 | part | maid_headdress | 0.9 | inferred | needs_review | - |
| #42 | pose | hugging | 0.9 | inferred | needs_review | - |
| #38 | scene | group_shot_deepseek_cast | 0.95 | inferred | needs_review | - |
### HUokZsIbgAAKJZJ.jpg（fan_art）

| # | 字段 | 值 | 置信度 | 证据来源 | 状态 | 关联节点 |
| --- | --- | --- | --- | --- | --- | --- |
| #32 | expression | sleepy_half_lidded_smile | 0.9 | inferred | needs_review | - |
| #33 | expression | blush | 0.85 | inferred | needs_review | - |
| #37 | other | speech_bubble_text | 1 | source_exact | needs_review | - |
| #35 | part | whale_tail | 0.85 | inferred | needs_review | - |
| #36 | part | whale_embroidery | 0.9 | inferred | needs_review | - |
| #34 | pose | both_palms_raised | 0.9 | inferred | needs_review | - |
### 1790571183144.gif（gif_reference）

| # | 字段 | 值 | 置信度 | 证据来源 | 状态 | 关联节点 |
| --- | --- | --- | --- | --- | --- | --- |
| #53 | motion_cue | chibi_dog_tail_grass_wave | 0.85 | parser_derived | needs_review | - |
| #54 | part | chibi_dog_tail_grass_prop | 0.9 | source_exact | needs_review | - |
| #56 | scene | night_sky | 0.8 | source_exact | needs_review | - |
| #55 | style | chibi | 0.95 | source_exact | needs_review | - |
### 27260cb26da951ab70f83962775ec1579bd0e52d8885184725abc160ec3bd31b.gif（gif_reference）

| # | 字段 | 值 | 置信度 | 证据来源 | 状态 | 关联节点 |
| --- | --- | --- | --- | --- | --- | --- |
| #57 | expression | dazed_thinking | 0.9 | source_exact | needs_review | - |
| #58 | motion_cue | loading_spinner_single_shot | 0.7 | parser_derived | needs_review | - |
| #59 | scene | speech_bubble_text | 0.85 | source_exact | needs_review | - |
### 1791949382162.gif（photo）

| # | 字段 | 值 | 置信度 | 证据来源 | 状态 | 关联节点 |
| --- | --- | --- | --- | --- | --- | --- |
| #60 | motion_cue | head_pat_interaction_plush | 0.75 | parser_derived | needs_review | - |
| #61 | part | chibi_plush_doll | 0.9 | source_exact | needs_review | - |
### IMG_20261007_220618_CROP.jpg（photo）

| # | 字段 | 值 | 置信度 | 证据来源 | 状态 | 关联节点 |
| --- | --- | --- | --- | --- | --- | --- |
| #43 | expression | content_smile_closed_mouth | 0.9 | inferred | needs_review | - |
| #44 | expression | blush | 0.85 | inferred | needs_review | - |
| #46 | part | flower_iris_highlight | 0.9 | inferred | needs_review | - |
| #47 | part | maid_headdress | 0.9 | inferred | needs_review | - |
| #45 | pose | hand_near_cheek | 0.9 | inferred | needs_review | - |
### bili_poster-1791382745061.png（poster）

| # | 字段 | 值 | 置信度 | 证据来源 | 状态 | 关联节点 |
| --- | --- | --- | --- | --- | --- | --- |
| #20 | expression | sleepy_half_lidded | 0.85 | inferred | needs_review | - |
| #21 | expression | finger_on_lips | 0.8 | inferred | needs_review | - |
| #23 | outfit | navy_maid_dress_short_with_thighhighs | 0.85 | inferred | needs_review | - |
| #24 | part | whale_tail | 0.9 | inferred | needs_review | - |
| #22 | pose | lying_on_bed | 0.9 | inferred | needs_review | - |
| #25 | scene | bedroom | 0.9 | inferred | needs_review | - |
### heybox_1792638467783_-1242029457.png（screenshot）

| # | 字段 | 值 | 置信度 | 证据来源 | 状态 | 关联节点 |
| --- | --- | --- | --- | --- | --- | --- |
| #26 | expression | smile_open_mouth | 0.9 | inferred | needs_review | - |
| #27 | expression | blush | 0.8 | inferred | needs_review | - |
| #29 | outfit | dark_maid_variant_grey_apron | 0.8 | inferred | needs_review | - |
| #30 | part | whale_fin_ears | 0.85 | inferred | needs_review | - |
| #31 | part | blue_crystal_brooch | 0.85 | inferred | needs_review | - |
| #28 | pose | hand_raised_pinch | 0.85 | inferred | needs_review | - |
