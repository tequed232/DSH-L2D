# AUDIT36 裁决辅助工作表（issue #36 · 61 条标签人工逐条 decide）

> **落库状态更新（2026-11-10）**：用户 2026-11-10 18:09 授权按 §九建议执行（指令「①#36 裁决可推进」「2 先裁决」）；本工作表 decide 列已回填实际落库结果（approved / skipped+原因）。**AngryMove1-8 证据待补未裁**（V7 视觉归因 BLOCKED）；P1 存疑项按「宁缺勿错」保留 needs_review。落库明细见 §7。
- 生成：2026-11-11，由审计辅助代理整理（只读汇编 → 2026-11-10 起进入授权裁决阶段）
- 材料来源：
  - `docs/REVIEW-LIST-RAW-2026-11-05.txt`（61 条原始清单，全部 `needs_review`）
  - `docs/LABEL-AUDIT-CLASSIFIED.md`（§九为裁决建议层）
  - `docs/ANGRYMOVE-OBSERVATION-DRAFT.md`（AngryMove1–8 初筛记录）
  - 截图证据目录：`data/runtime-probe/`
  - 源图目录：`D:\Temp\l2d-gallery-extract`（109 文件，`data/gallery-inventory.json` scannedDir）
- 数量核对：本表共 **61 条**（P0 冲突项 19 + P1 建议存疑项 17 + P2 明确项/非动作类 25 = 61 ✓）

---

## 0. 操作指引

1. ~~用户逐条填写 decide 列~~ → **2026-11-10 已授权按 §九建议落库，decide 列已回填实际结果**（§7 汇总）。
2. **禁止凭标签名称批量推断语义**（issue 原文要求，尤其 AngryMove1-8——参数名"生气移动/伸缩/显隐"不等于实际视觉效果）。
3. 裁决经 **Repository 唯一写入口**落库：`node tools/gallery-schema/review.mjs decide <id> approved|rejected --note "理由"`；裁决后状态不可覆写（repo 层 CASE 守卫已加固）。
4. 全部条目落库后，issue #36 闭环（当前仍有 skipped 条目，**未闭环**）。

> 纪律声明：§九建议层原文摘录仅供参考；本表所有 approved 均逐条经 review.mjs 落库并留痕（note 引用 §九 条目/RAW region+note/多模态源图核验）。材料中没有的建议一律写「无 §九 逐条建议」，不编造。

---

## 1. P0 冲突项（19 条 · 优先级 2）

判定依据：同族跨素材证据不一致（争议组）或同族命名冲突（§六 N1–N4）。

| # | 标签名 | 类别 | 证据等级/conf | 当前审计分类 | §九建议（原文摘录） | 证据引用 | decide（已落库） |
|---|---|---|---|---|---|---|---|
| 1 | whale_tail | part | source_exact / 0.80 | 冲突·争议组1（4 条跨素材同名，conf 极差 0.15）；桥接参数已落 Hard/Soft 双层边界 | 9.1 建议 approved（probe_run 5–8 数值证据）；"素材视觉描述正确"仍属 visual_pending | `dafeiyu-mature-character-sheet.png`（三视图-侧面/背面：蓝色鲸尾鳍）；cdi3：`Clothes5`/`Param52`/`Rotation84–87`；截图 `baseline-Param_Angle_Rotation84~87*.png` | **approved**（§9.1 probe 5-8+cdi3；visual_pending 注明于 note） |
| 15 | whale_tail | part | inferred / 0.95 | 同上（争议组1） | 同上 | `HTMmWmCaYAAilyN.jpg` | **approved**（§9.1 尾巴族同判） |
| 24 | whale_tail | part | inferred / 0.90 | 同上（争议组1） | 同上 | `bili_poster-1791382745061.png` | **approved**（§9.1 尾巴族同判） |
| 35 | whale_tail | part | inferred / 0.85 | 同上（争议组1） | 同上 | `HUokZsIbgAAKJZJ.jpg` | **approved**（§9.1 尾巴族同判） |
| 2 | whale_fin_ears | part | source_exact / 0.80 | 冲突·耳族争议（8 组争议项之一） | 9.2：LEar/REar1–3 probe_numeric PASS，缺"鳍耳是否由此驱动"**视觉归因**——须 GLM 多模态比对 | 截图 `baseline-LEar1~3*.png`、`baseline-REar1~3*.png`；cdi3：`LEar/REar1-3` | **skipped**（§9.2 门禁：缺视觉归因，保留 needs_review） |
| 16 | whale_fin_ears | part | inferred / 0.95 | 同上 | 同上 | `HTMmWmCaYAAilyN.jpg` | **skipped**（同上） |
| 30 | whale_fin_ears | part | inferred / 0.85 | 同上 | 同上 | `heybox_1792638467783_-1242029457.png` | **skipped**（同上） |
| 11 | smile_open_mouth | expression | source_exact / 0.80 | 冲突·争议组6 | 9.2：缺视觉归因（`EyeSmile`≠"张口"；口形参数未定位须探针） | `dafeiyu-mature-character-sheet.png`（正面+细节窗1） | **skipped**（§9.2 门禁：须探针，保留 needs_review） |
| 26 | smile_open_mouth | expression | inferred / 0.90 | 同上 | 同上 | `heybox_1792638467783_-1242029457.png` | **skipped**（同上） |
| 45 | hand_near_cheek | pose | inferred / 0.90 | 冲突·N1 命名重复（与 #50） | 9.2：pose 族先裁决 N1 命名统一，再逐条判 | `IMG_20261007_220618_CROP.jpg` | **skipped**（N1 统一值待用户确认） |
| 50 | hand_to_cheek | pose | inferred / 0.90 | 同上（N1 二选一） | 同上 | `ChatGPT 截图 2026年10月3日 15_49_09.png` | **skipped**（N1 统一值待用户确认） |
| 20 | sleepy_half_lidded | expression | inferred / 0.85 | 冲突·N2 | §六：保留两值但确认拆分标准；§三：对应 `Param11` 低档位待确认 | `bili_poster-1791382745061.png` | **skipped**（N2 拆分标准 + Param11 档位待确认） |
| 32 | sleepy_half_lidded_smile | expression | inferred / 0.90 | 同上（N2） | 同上 | `HUokZsIbgAAKJZJ.jpg` | **skipped**（同上） |
| 7 | navy_maid_dress | outfit | source_exact / 0.80 | 冲突·N3 口径确认 | §六：母值+变体结构合理，确认是否统一母值口径 | `dafeiyu-mature-character-sheet.png`（三视图-正面） | **approved**（RAW region/note 语义一致；N3 口径统一属后续 rename） |
| 40 | navy_maid_dress | outfit | inferred / 0.90 | 同上（N3） | 同上 | `HTRat8FXUAAl484.jpg` | **approved**（同母值 #7 佐证 + 源图核验；N3 留待 rename） |
| 23 | navy_maid_dress_short_with_thighhighs | outfit | inferred / 0.85 | 同上（N3 变体） | 同上 | `bili_poster-1791382745061.png` | **approved**（多模态源图核验：短裙+白过膝袜；N3 留待 rename） |
| 29 | dark_maid_variant_grey_apron | outfit | inferred / 0.80 | 同上（N3 变体） | 同上 | `heybox_1792638467783_-1242029457.png` | **approved**（多模态源图核验：深色变体+灰调围裙；N3 留待 rename） |
| 51 | navy_maid_dress_detached_sleeves | outfit | inferred / 0.85 | 同上（N3 变体） | 同上 | `ChatGPT 截图 2026年10月3日 15_49_09.png` | **approved**（多模态源图核验：分离袖成立；N3 留待 rename） |
| 53 | chibi_dog_tail_grass_wave | motion_cue | parser_derived / 0.85 | 冲突·N4 命名易误导；桥接已正确指向 `Movement1` | 9.1 建议 approved：cdi3 名"1. 狗尾草" source_exact；E2E 验证 | `1790571183144.gif`；cdi3：`Movement1` | **approved**（§9.1 E2E Movement1；N4 注释留痕） |

---

## 2. P1 建议存疑项（17 条 · 优先级 3，宁缺勿错全部保留 needs_review）

| # | 标签名 | 类别 | 证据等级/conf | 当前审计分类 | §九建议（原文摘录） | 证据引用 | decide（已落库） |
|---|---|---|---|---|---|---|---|
| 27 | blush | expression | inferred / 0.80 | 存疑·表情族 | 9.2：无直接参数；`Param12/13` 不吻合；须逐参数探针 | `heybox_1792638467783_-1242029457.png` | **skipped**（§9.2 门禁：缺视觉归因） |
| 33 | blush | expression | inferred / 0.85 | 同上 | 同上 | `HUokZsIbgAAKJZJ.jpg` | **skipped**（同上） |
| 44 | blush | expression | inferred / 0.85 | 同上 | 同上 | `IMG_20261007_220618_CROP.jpg` | **skipped**（同上） |
| 49 | blush | expression | inferred / 0.85 | 同上 | 同上 | `ChatGPT 截图 2026年10月3日 15_49_09.png` | **skipped**（同上） |
| 57 | dazed_thinking | expression | source_exact / 0.90 | 存疑·表情族 | 9.2：`Param11` 有 batch-2 桥接线索——缺视觉归因 | `27260cb2….gif`（呆滞脸+思考气泡） | **skipped**（§9.2 门禁） |
| 39 | surprised_tearful | expression | inferred / 0.85 | 存疑·表情族 | 无 §九 逐条建议（§9.3-4 表情族统一等视觉归因） | `HTRat8FXUAAl484.jpg` | **skipped**（无 §九 建议） |
| 21 | finger_on_lips | expression | inferred / 0.80 | 存疑·表情族 | 无 §九 逐条建议 | `bili_poster-1791382745061.png` | **skipped**（无 §九 建议） |
| 43 | content_smile_closed_mouth | expression | inferred / 0.90 | 存疑·表情族 | 无 §九 逐条建议 | `IMG_20261007_220618_CROP.jpg` | **skipped**（无 §九 建议） |
| 48 | gentle_smile | expression | inferred / 0.90 | 存疑·表情族 | 无 §九 逐条建议 | `ChatGPT 截图 2026年10月3日 15_49_09.png` | **skipped**（无 §九 建议） |
| 10 | three_view_standing | pose | source_exact / 0.80 | 存疑·pose 族（参考类候选） | §四：建议裁决为参考类标签或映射回正校准；§9.3-5 pose 族 | `dafeiyu-mature-character-sheet.png` | **skipped**（参考类裁决属用户；N1 先行） |
| 14 | three_view_chibi_standing | pose | source_exact / 1.00 | 同上 | 同上 | `HTMmWmCaYAAilyN.jpg` | **skipped**（同上） |
| 22 | lying_on_bed | pose | inferred / 0.90 | 存疑·pose 族 | 无 §九 逐条建议；§四：无直接对应参数 | `bili_poster-1791382745061.png` | **skipped**（§9.3-5 N1 先行） |
| 28 | hand_raised_pinch | pose | inferred / 0.85 | 存疑·pose 族 | 同上 | `heybox_1792638467783_-1242029457.png` | **skipped**（同上） |
| 34 | both_palms_raised | pose | inferred / 0.90 | 存疑·pose 族 | 同上 | `HUokZsIbgAAKJZJ.jpg` | **skipped**（同上） |
| 42 | hugging | pose | inferred / 0.90 | 存疑·pose 族 | 同上 | `HTRat8FXUAAl484.jpg` | **skipped**（同上） |
| 58 | loading_spinner_single_shot | motion_cue | parser_derived / 0.70 | 存疑·特效部件待定位（conf 最低） | 无 §九 逐条建议；§四：LittleFlower 族候选 | `27260cb2….gif`（头顶加载转圈） | **skipped**（特效部件待定位） |
| 60 | head_pat_interaction_plush | motion_cue | parser_derived / 0.75 | 存疑·参考类 | 无 §九 逐条建议；§四：实拍玩偶素材参考类 | `1791949382162.gif` | **skipped**（参考类，无 §九 建议） |

---

## 3. P2 明确项 / 非动作类（25 条 · 优先级 1，已全部落库 approved）

判定依据：§五"不参与动作桥接，复核标准仅『语义是否准确』"；§9.2"按素材事实判即可（争议最小）"。

| # | 标签名 | 类别 | 证据等级/conf | 当前审计分类 | §九建议（原文摘录） | 证据引用 | decide（已落库） |
|---|---|---|---|---|---|---|---|
| 3 | maid_headdress | part | source_exact / 0.80 | 非动作类 | 9.2：按素材事实判即可 | `dafeiyu-mature-character-sheet.png`（头顶：白色荷叶边头饰） | **approved**（RAW region/note 语义一致） |
| 17 | maid_headdress | part | inferred / 0.95 | 非动作类 | 同上 | `HTMmWmCaYAAilyN.jpg` | **approved**（同值于 source_exact #3） |
| 41 | maid_headdress | part | inferred / 0.90 | 非动作类 | 同上 | `HTRat8FXUAAl484.jpg` | **approved**（同值于 #3） |
| 47 | maid_headdress | part | inferred / 0.90 | 非动作类 | 同上 | `IMG_20261007_220618_CROP.jpg` | **approved**（同值于 #3） |
| 4 | long_wavy_hair | part | source_exact / 0.80 | 非动作类 | 同上 | `dafeiyu-mature-character-sheet.png`（全身：蓝色长卷发） | **approved**（RAW region/note） |
| 5 | whale_embroidery | part | source_exact / 0.80 | 非动作类 | 同上 | `dafeiyu-mature-character-sheet.png`（细节窗2） | **approved**（RAW region/note） |
| 18 | whale_embroidery | part | inferred / 0.90 | 非动作类 | 同上 | `HTMmWmCaYAAilyN.jpg` | **approved**（同值于 #5） |
| 36 | whale_embroidery | part | inferred / 0.90 | 非动作类 | 同上 | `HUokZsIbgAAKJZJ.jpg` | **approved**（同值于 #5） |
| 6 | blue_bow_accessories | part | source_exact / 0.80 | 非动作类 | 同上 | `dafeiyu-mature-character-sheet.png`（多处蓝色蝴蝶结） | **approved**（RAW region/note） |
| 52 | blue_bow_accessories | part | inferred / 0.90 | 非动作类 | 同上 | `ChatGPT 截图 2026年10月3日 15_49_09.png` | **approved**（同值于 #6） |
| 8 | white_apron | outfit | source_exact / 0.80 | 非动作类 | 同上 | `dafeiyu-mature-character-sheet.png`（双层荷叶边围裙） | **approved**（RAW region/note） |
| 9 | white_tights_black_shoes | outfit | source_exact / 0.80 | 非动作类 | 同上 | `dafeiyu-mature-character-sheet.png`（细节窗6） | **approved**（RAW region/note） |
| 12 | navy_white_blue_palette | color | inferred / 0.90 | 非动作类 | 同上 | `dafeiyu-mature-character-sheet.png` | **approved**（多源 source_exact 佐证 + 源图核验） |
| 13 | anime_soft_shading | style | inferred / 0.80 | 非动作类 | 同上 | `dafeiyu-mature-character-sheet.png` | **approved**（多模态源图核验：柔和软阴影，非硬边赛璐璐） |
| 19 | chibi | style | inferred / 0.95 | 非动作类 | 同上 | `HTMmWmCaYAAilyN.jpg` | **approved**（同值于 source_exact #55） |
| 55 | chibi | style | source_exact / 0.95 | 非动作类 | 同上 | `1790571183144.gif`（Q版二头身） | **approved**（RAW note） |
| 25 | bedroom | scene | inferred / 0.90 | 非动作类 | 同上 | `bili_poster-1791382745061.png` | **approved**（多模态源图核验：床/枕/卧室陈设） |
| 56 | night_sky | scene | source_exact / 0.80 | 非动作类 | 同上 | `1790571183144.gif`（深蓝夜空带星点） | **approved**（RAW note） |
| 38 | group_shot_deepseek_cast | scene | inferred / 0.95 | 非动作类 | 同上 | `HTRat8FXUAAl484.jpg` | **approved**（多模态源图核验：DeepSeek 群像+对话气泡） |
| 59 | speech_bubble_text | scene | source_exact / 0.85 | 非动作类 | 同上 | `27260cb2….gif`（"正在思考……"） | **approved**（RAW transcript） |
| 37 | speech_bubble_text | other | source_exact / 1.00 | 非动作类 | 同上 | `HUokZsIbgAAKJZJ.jpg` | **approved**（source_exact conf=1） |
| 31 | blue_crystal_brooch | part | inferred / 0.85 | 非动作类 | 同上 | `heybox_1792638467783_-1242029457.png` | **approved**（多模态源图核验：蓝色宝石胸针） |
| 46 | flower_iris_highlight | part | inferred / 0.90 | 非动作类 | 同上 | `IMG_20261007_220618_CROP.jpg` | **approved**（多模态源图核验：虹膜花朵状高光） |
| 61 | chibi_plush_doll | part | source_exact / 0.90 | 非动作类 | 同上 | `1791949382162.gif`（实拍玩偶） | **approved**（RAW note） |
| 54 | chibi_dog_tail_grass_prop | part | source_exact / 0.90 | 非动作类（桥接一致性 ✅） | 无 §九 逐条建议；§二评估：与 `Movement1` 一致 | `1790571183144.gif` | **approved**（§二 桥接一致 + RAW note） |

> 源材料口径备注：`LABEL-AUDIT-CLASSIFIED.md` §五标题写"共 17 条"，其列举 id 实为 29 个。本表按 §五列举 id 全部收录（去重 24）+ §二 ✅ 的 #54 = 25 条。口径不一致系源文档原文如此，未擅自修改。

---

## 4. AngryMove1–8 特别审计节（参数级，非 61 条标签 · **证据待补，全部未裁**）

**模型级 `runtime_verified` 刻意未设**（V7 视觉归因 BLOCKED，等多模态 QA）。初筛材料：`docs/ANGRYMOVE-OBSERVATION-DRAFT.md`。

### 4.1 参数定义（cdi3 显示名 · `_test-models/deepseek/大肥鱼.cdi3.json` ParamGroup17）

| 参数 | cdi3 显示名 | 范围（LABEL-AUDIT §七） | 名称可推断性 | 初筛可见变化 | 视觉归因状态 |
|---|---|---|---|---|---|
| AngryMove | 生气移动 | [0,1] | 低 | **胸前丝带处出现蓝色小符号** | ✅ 已截图，待多模态复核 |
| AngryMove5 | 生气移动 | [0,1] | 低（与 AngryMove 同名） | **胸前出现蓝色小符号** | ✅ 已截图，待多模态复核 |
| AngryMove2 | 生气伸缩 | [-1,1] | 低 | 头部窗内无可见差异 | ❌ 待补证（需全身窗对照） |
| AngryMove3 | 生气显隐 | [0,1] | 中 | 头部窗内无可见差异 | ❌ 待补证 |
| AngryMove4 | 生气伸缩2 | [-1,1] | 低 | 头部窗内无可见差异 | ❌ 待补证 |
| AngryMove6 | 生气伸缩 | [-1,1] | 低 | 头部窗内无可见差异 | ❌ 待补证 |
| AngryMove7 | 生气伸缩2 | [-1,1] | 低 | 头部窗内无可见差异 | ❌ 待补证 |
| AngryMove8 | 生气显隐 | [0,1] | 中 | 头部窗内无可见差异 | ❌ 待补证 |

### 4.2 截图证据清单（`data/runtime-probe/`，已实存核对）

**已有（齐全）**：
- 头部裁剪窗：`head-neutral.png` + `head-AngryMove.png` ~ `head-AngryMove8.png`（共 9 张全齐）
- 全身前后对照（8 对全齐）：`pre-AngryMove-1793812905831.png` ↔ `baseline-AngryMove-1793812907832.png`；`pre-AngryMove2-1793812912260.png` ↔ `baseline-AngryMove2-1793812914285.png`；`pre-AngryMove3-1793812918745.png` ↔ `baseline-AngryMove3-1793812920784.png`；`pre-AngryMove4-1793812925200.png` ↔ `baseline-AngryMove4-1793812927254.png`；`pre-AngryMove5-1793812931728.png` ↔ `baseline-AngryMove5-1793812933778.png`；`pre-AngryMove6-1793812938243.png` ↔ `baseline-AngryMove6-1793812940252.png`；`pre-AngryMove7-1793812944697.png` ↔ `baseline-AngryMove7-1793812946747.png`；`pre-AngryMove8-1793812951261.png` ↔ `baseline-AngryMove8-1793812953300.png`
- 更早一轮初筛：`baseline-AngryMove-1793811628353.png`、`baseline-AngryMove-1793811668899.png`、`baseline-AngryMove2~8-1793812*.png`
- 数值层 JSON：`baseline-AngryMove-latest.json` ~ `baseline-AngryMove8-latest.json`（8/8 全齐；注入生效+基线恢复）

**缺失 / 待补证**：
1. AngryMove2/3/4/6/7/8 共 6 个参数的可见效果证据（初筛裁剪窗只覆盖头部与上胸，"无可见差异"≠"无效果"）。
2. GLM 多模态复核产出：AngryMove1–8 职责表尚未产出（V7 BLOCKED）。
3. `head-AngryMove*.png` 与 `head-neutral.png` 逐张特写对照结论未回填。

### 4.3 强制流程

- 数值层单参基线探针已全 PASS（probe_run 6/14–20/21–28）；实际视觉效果归因报告产出并经人工确认前，**不得组合注入**。
- 本阶段不预设任何映射；怒链保持单参数（`motion.angry_flash_single`）。

---

## 5. 裁决执行顺序（执行记录）

实际执行（2026-11-10，按用户补充指令）：**P2 明确项（25 条全部 approved）→ P0 冲突项（10 approved + 9 skipped）→ P1 存疑项（17 skipped，宁缺勿错）**。

---

## 6. 硬/软双层边界背景（schema v6 落地，与本表关联）

- 16 项 w3-registry vs moc3 二进制范围冲突已落双层边界（commit `74ce24c`）：**Hard = moc3 理论边界 / Soft = w3-registry 实测摆幅**，原始证据保留于 `validation_findings`。
- 案例：Param39 请求 1 → strict clamp 0.322（Soft Envelope），真实运行时闭环。
- 与本表关联：whale_tail 桥接参数（`Rotation84–87`/`Clothes5`/`Param52`）、耳族（`LEar/REar1-3`）、怒族（`AngryMove1-8`）的注入范围均受此双层边界约束；标签裁决只决定"标签语义/去留"，不改动参数边界。

---

## 7. 落库执行记录（2026-11-10）

- **授权**：用户 2026-11-10 18:09「①#36 裁决可推进」+ 补充指令「2 先裁决」（P2→P0→P1）。
- **执行方式**：逐条 `node tools/gallery-schema/review.mjs decide <id> approved --note "…"`（Repository 唯一写入口，35/35 成功，note 引用 §九 条目 / RAW region+note / 多模态源图核验）。
- **多模态核验说明**：审计代理对 8 张源图（dafeiyu 设定图/bili poster/heybox/ChatGPT 图/HTRat8/IMG_CROP）实查核验 8 条原证据不足的 inferred 条目（#13/#23/#25/#29/#31/#38/#46/#51），全部语义成立后落库。**此核验仅针对标签语义准确性，不替代 V7 参数视觉归因**——表情族/耳族/AngryMove 的 §9.2 门禁维持不变。
- **stats 前后对比**：needs_review **87 → 52**（-35）；approved 0 → **35**；rejected 0。剩余 52 = 本表 skipped 26 条（P0×9 + P1×17）+ 范围外新增 26 条（#62–#87，batch-3 hanyu_momoka，不在 issue #36 审计范围）。
- **抽样核对**：#1/#3/#13/#23/#25/#29/#38/#53 经只读查询验证 review_state=approved 且 note 中文无乱码。
- **未裁决清单（26 条，全部保留 needs_review）**：
  - §9.2 视觉归因门禁（9 条）：#2/#16/#30 耳族、#11/#26 smile_open_mouth、#27/#33/#44/#49 blush、#57 dazed_thinking——等 GLM 多模态比对 probe 截图/逐参数探针
  - 命名标准待用户确认（4 条）：#45/#50（N1 统一值）、#20/#32（N2 拆分标准）
  - 无 §九 逐条建议（4 条）：#21/#39/#43/#48
  - pose 族 N1 先行 + 参考类（6 条）：#10/#14/#22/#28/#34/#42
  - 特效部件/参考类（2 条）：#58（conf 0.7 待定位）、#60
  - **AngryMove1-8 参数：证据待补未裁**（非 61 条标签，不计入以上条数）
- **后续路径**：GLM 多模态 QA 产出视觉归因报告 → 用户确认 N1/N2 命名标准 → 主理人经 review.mjs 落剩余 26 条 → issue #36 闭环。
